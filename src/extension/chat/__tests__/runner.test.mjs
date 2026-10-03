/**
 * Drives ChatRunner through realistic SessionEvent sequences (as emitted by the bridge on
 * Claude Code 2.1.x) with a fake session/bridge/edit-tracker and checks the resulting ChatState.
 *
 *   node src/extension/chat/__tests__/runner.test.mjs
 */
import { build } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const root = new URL('../../../..', import.meta.url).pathname;
const dir = mkdtempSync(join(process.env.SCRATCHPAD ?? tmpdir(), 'kursor-runner-test-'));
const entry = join(dir, 'entry.ts');
writeFileSync(
  entry,
  `export * from '${join(root, 'src/extension/chat/runner.ts')}';
export * as state from '${join(root, 'src/extension/chat/state.ts')}';
export * as prompt from '${join(root, 'src/extension/chat/prompt.ts')}';
export { EventEmitter } from 'vscode';`,
);
const outfile = join(dir, 'bundle.mjs');
const stub = new URL('./vscode-stub.mjs', import.meta.url).pathname;
await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  outfile,
  logLevel: 'silent',
  plugins: [{ name: 'vscode-stub', setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: stub })); } }],
});
const { ChatRunner, previewInput, effectivePermissionMode, state, prompt, EventEmitter } = await import(pathToFileURL(outfile).href);

// ---- fakes ---------------------------------------------------------------------------
class FakeSession {
  constructor(opts) {
    this.opts = opts;
    this.em = new EventEmitter();
    this.onEvent = this.em.event;
    this.sent = [];
    this.responses = [];
    this.pending = 0;
    this.interrupts = 0;
    this.disposed = false;
    this.sessionId = opts.resume;
    this.mode = opts.mode;
    this.permissionMode = opts.permissionMode;
  }
  get running() {
    return this.pending > 0;
  }
  send(t) {
    this.sent.push(t);
    this.pending++;
  }
  async interrupt() {
    this.interrupts++;
    this.pending = Math.min(this.pending, 1);
  }
  respondPermission(id, d) {
    this.responses.push([id, d]);
  }
  async setModel(m) { this.model = m; }
  async setEffort(e) { this.effort = e; }
  async setPermissionMode(m) { this.permissionMode = m; }
  async setMode(m) { this.mode = m; }
  async rewindFiles() { return { canRewind: true, filesChanged: ['/w/a.ts'] }; }
  async contextUsage() { return { usedTokens: 1000, maxTokens: 200000 }; }
  async supportedModels() { return []; }
  async supportedCommands() { return []; }
  dispose() { this.disposed = true; }
  /** Emit like the bridge: bookkeeping first, then listeners. */
  emit(e) {
    if (e.type === 'init') this.sessionId = e.sessionId;
    if (e.type === 'result') this.pending = e.queuedTurnCount ?? Math.max(0, this.pending - 1);
    this.em.fire(e);
  }
}
class FakeEdits {
  constructor() { this.files = new Map(); this.changes = []; this.em = new EventEmitter(); this.onDidChange = this.em.event; }
  recordChange(chatId, c) {
    this.changes.push({ chatId, ...c });
    this.files.set(c.path, { path: c.path, relPath: c.path.replace(/^\/w\//, ''), additions: 1, deletions: 0, isNew: c.before === null, isDeleted: c.after === null, status: 'pending', hunks: 1 });
  }
  pending() { return [...this.files.values()]; }
  async keep() {} async undo() {} async review() {} clear() { this.files.clear(); } dispose() {}
}
const log = { info() {}, warn() {}, error(...a) { errors.push(a); }, debug() {} };
let errors = [];

function harness(chatOverrides = {}) {
  const chat = { ...state.createChatState({ mode: 'agent', permissionMode: 'acceptEdits', model: '', effort: '', cwd: '/w' }), ...chatOverrides };
  const sessions = [];
  const bridge = { createSession(opts) { const s = new FakeSession(opts); sessions.push(s); return s; } };
  const edits = new FakeEdits();
  const calls = { notify: 0, deltas: [], permissions: [], inits: 0, turnEnds: 0 };
  const runner = new ChatRunner(chat, {
    log,
    bridge,
    edits,
    rules: { buildAppendix: async () => '# User rules\nbe nice', listProjectRules: async () => [], userRules: () => '', onDidChange: () => ({ dispose() {} }), dispose() {} },
    notify: () => calls.notify++,
    onDelta: (m, b, d) => calls.deltas.push([m, b, d]),
    onPermissionRequest: (r) => calls.permissions.push(r),
    onInit: () => calls.inits++,
    onTurnEnd: () => calls.turnEnds++,
    additionalDirectories: () => ['/w', '/other'],
  });
  const user = (text) => ({ kind: 'user', id: state.newId('u'), text, attachments: [], timestamp: Date.now(), canRestore: false });
  return { chat, runner, sessions, edits, calls, user, session: () => sessions[sessions.length - 1] };
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  errors = [];
  try {
    await fn();
    // `log.error` is expected for session errors; only internal failures fail the test.
    const internal = errors.filter((e) => /event handling failed|recordChange failed/.test(String(e[0])));
    if (internal.length) throw new Error(`log.error called: ${internal.map((e) => String(e[0])).join('; ')}`);
    passed++;
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}\n  ${err.stack ?? err.message}`);
  }
}
const lastAssistant = (chat) => [...chat.messages].reverse().find((m) => m.kind === 'assistant');

// ---- tests -----------------------------------------------------------------------
await test('plain text turn: streaming, uuid, result, idle', async () => {
  const h = harness();
  const u = h.user('hello');
  h.chat.messages.push(u);
  await h.runner.send({ text: 'hello' }, u, [], false);
  const s = h.session();
  assert.equal(s.opts.cwd, '/w');
  assert.deepEqual(s.opts.additionalDirectories, ['/other']);
  assert.ok(s.opts.appendSystemPrompt.startsWith(prompt.KURSOR_SYSTEM_NOTE));
  assert.ok(s.opts.appendSystemPrompt.includes('# User rules'));
  assert.equal(h.chat.status, 'starting');
  s.emit({ type: 'init', sessionId: 'sess-1', model: 'claude-x', tools: [], permissionMode: 'acceptEdits' });
  assert.equal(h.chat.sessionId, 'sess-1');
  assert.equal(h.chat.status, 'running');
  assert.equal(h.calls.inits, 1);
  s.emit({ type: 'status', status: 'requesting' });
  s.emit({ type: 'userReplay', uuid: 'uu-1', text: 'hello' });
  assert.equal(u.uuid, 'uu-1');
  assert.equal(u.canRestore, true);
  s.emit({ type: 'streamStart', messageId: 'm1', parentToolUseId: null });
  s.emit({ type: 'blockStart', messageId: 'm1', index: 0, blockType: 'text' });
  s.emit({ type: 'blockDelta', messageId: 'm1', index: 0, kind: 'text', delta: 'Hi ' });
  s.emit({ type: 'blockDelta', messageId: 'm1', index: 0, kind: 'text', delta: 'there' });
  const a = lastAssistant(h.chat);
  assert.equal(a.model, 'claude-x');
  assert.equal(a.streaming, true);
  assert.equal(a.blocks[0].type, 'text');
  assert.equal(a.blocks[0].text, 'Hi there');
  assert.equal(h.calls.deltas.length, 2);
  assert.equal(h.calls.deltas[0][0], a.id);
  assert.equal(h.calls.deltas[0][1], a.blocks[0].id);
  s.emit({ type: 'assistantBlock', messageId: 'm1', parentToolUseId: null, block: { type: 'text', text: 'Hi there!' } });
  s.emit({ type: 'blockStop', messageId: 'm1', index: 0 });
  assert.equal(a.blocks[0].text, 'Hi there!');
  s.emit({ type: 'result', subtype: 'success', isError: false, costUsd: 0.01, durationMs: 1200, numTurns: 1, permissionDenials: [], queuedTurnCount: 0 });
  assert.equal(h.chat.status, 'idle');
  assert.equal(a.streaming, false);
  assert.deepEqual(a.result, { costUsd: 0.01, durationMs: 1200, numTurns: 1, isError: false, errorText: undefined });
  assert.equal(h.chat.totalCostUsd, 0.01);
  assert.equal(h.calls.turnEnds, 1);
  assert.equal(h.runner.running, false);
});

await test('thinking block: streams, finalizes on assistantBlock', async () => {
  const h = harness();
  const u = h.user('think');
  h.chat.messages.push(u);
  await h.runner.send({ text: 'think' }, u, [], false);
  const s = h.session();
  s.emit({ type: 'init', sessionId: 's', model: 'm', tools: [], permissionMode: 'acceptEdits' });
  s.emit({ type: 'streamStart', messageId: 'm1', parentToolUseId: null });
  s.emit({ type: 'blockStart', messageId: 'm1', index: 0, blockType: 'thinking' });
  s.emit({ type: 'blockDelta', messageId: 'm1', index: 0, kind: 'thinking', delta: 'hmm' });
  const a = lastAssistant(h.chat);
  assert.equal(a.blocks[0].type, 'thinking');
  assert.equal(a.blocks[0].done, false);
  s.emit({ type: 'assistantBlock', messageId: 'm1', parentToolUseId: null, block: { type: 'thinking', thinking: 'hmm…' } });
  assert.equal(a.blocks[0].done, true);
  assert.equal(a.blocks[0].text, 'hmm…');
  s.emit({ type: 'blockStart', messageId: 'm1', index: 1, blockType: 'text' });
  s.emit({ type: 'blockDelta', messageId: 'm1', index: 1, kind: 'text', delta: 'ok' });
  s.emit({ type: 'assistantBlock', messageId: 'm1', parentToolUseId: null, block: { type: 'text', text: 'ok' } });
  assert.equal(a.blocks.length, 2);
  assert.equal(a.blocks[1].text, 'ok');
});

await test('tool block lifecycle: blockStart → input_json → assistantBlock → fileChanged → toolResult', async () => {
  const h = harness();
  const u = h.user('edit a.ts');
  h.chat.messages.push(u);
  await h.runner.send({ text: 'edit' }, u, [], false);
  const s = h.session();
  s.emit({ type: 'init', sessionId: 's', model: 'm', tools: [], permissionMode: 'acceptEdits' });
  s.emit({ type: 'streamStart', messageId: 'm1', parentToolUseId: null });
  s.emit({ type: 'blockStart', messageId: 'm1', index: 0, blockType: 'tool_use', toolUseId: 'tu1', toolName: 'Edit' });
  s.emit({ type: 'blockDelta', messageId: 'm1', index: 0, kind: 'input_json', delta: '{"file_path":"/w/a.ts","old_str' });
  const a = lastAssistant(h.chat);
  const tool = a.blocks[0];
  assert.equal(tool.type, 'tool');
  assert.equal(tool.id, 'tu1');
  assert.equal(tool.name, 'Edit');
  assert.equal(tool.inputStreaming, true);
  assert.equal(tool.input.file_path, '/w/a.ts');
  assert.equal(tool.input._partial, true);
  s.emit({ type: 'assistantBlock', messageId: 'm1', parentToolUseId: null, block: { type: 'tool_use', id: 'tu1', name: 'Edit', input: { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' } } });
  assert.equal(tool.inputStreaming, false);
  assert.deepEqual(tool.input, { file_path: '/w/a.ts', old_string: 'a', new_string: 'b' });
  assert.equal(a.blocks.length, 1, 'no duplicate tool block');
  s.emit({ type: 'fileChanged', path: '/w/a.ts', before: 'a\n', after: 'b\n', toolUseId: 'tu1', toolName: 'Edit' });
  assert.equal(h.edits.changes.length, 1);
  assert.equal(h.edits.changes[0].chatId, h.chat.id);
  assert.equal(tool.edit.status, 'pending');
  assert.equal(tool.edit.relPath, 'a.ts');
  assert.equal(h.chat.pendingEdits.length, 1);
  s.emit({ type: 'toolResult', toolUseId: 'tu1', content: 'The file /w/a.ts has been updated.', isError: false, parentToolUseId: null });
  assert.equal(tool.status, 'done');
  assert.equal(tool.output, 'The file /w/a.ts has been updated.');
  assert.ok(tool.endedAt);
  // A large output is capped and marked truncated.
  s.emit({ type: 'blockStart', messageId: 'm1', index: 1, blockType: 'tool_use', toolUseId: 'tu2', toolName: 'Bash' });
  s.emit({ type: 'assistantBlock', messageId: 'm1', parentToolUseId: null, block: { type: 'tool_use', id: 'tu2', name: 'Bash', input: { command: 'ls' } } });
  s.emit({ type: 'toolResult', toolUseId: 'tu2', content: 'x'.repeat(30000), isError: true, parentToolUseId: null });
  assert.equal(a.blocks[1].status, 'error');
  assert.equal(a.blocks[1].outputTruncated, true);
  assert.ok(a.blocks[1].output.length < 21000);
  // keep via tracker → block marked
  h.runner.markEdits(['/w/a.ts'], 'kept');
  assert.equal(tool.edit.status, 'kept');
});

await test('TodoWrite becomes a todo block; Task gets subagent status', async () => {
  const h = harness();
  const u = h.user('plan');
  h.chat.messages.push(u);
  await h.runner.send({ text: 'plan' }, u, [], false);
  const s = h.session();
  s.emit({ type: 'init', sessionId: 's', model: 'm', tools: [], permissionMode: 'acceptEdits' });
  s.emit({ type: 'streamStart', messageId: 'm1', parentToolUseId: null });
  s.emit({ type: 'assistantBlock', messageId: 'm1', parentToolUseId: null, block: { type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] } } });
  const a = lastAssistant(h.chat);
  assert.equal(a.blocks[0].type, 'todo');
  assert.equal(a.blocks[0].items.length, 2);
  s.emit({ type: 'assistantBlock', messageId: 'm1', parentToolUseId: null, block: { type: 'tool_use', id: 't2', name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'completed' }] } } });
  assert.equal(a.blocks.filter((b) => b.type === 'todo').length, 1, 'single live todo block');
  assert.equal(a.blocks[0].items[1].status, 'completed');
  s.emit({ type: 'assistantBlock', messageId: 'm1', parentToolUseId: null, block: { type: 'tool_use', id: 't3', name: 'Task', input: { description: 'explore', subagent_type: 'Explore', prompt: 'look' } } });
  const task = a.blocks.find((b) => b.type === 'tool' && b.name === 'Task');
  assert.equal(task.subagent.description, 'explore');
  s.emit({ type: 'task', taskId: 'x', toolUseId: 't3', description: 'explore', phase: 'progress', lastTool: 'Grep' });
  assert.equal(task.subagent.status, 'running: Grep');
  // subagent's own text is not rendered; its tool calls are, nested
  s.emit({ type: 'streamStart', messageId: 'sub1', parentToolUseId: 't3' });
  s.emit({ type: 'blockStart', messageId: 'sub1', index: 0, blockType: 'text' });
  s.emit({ type: 'blockDelta', messageId: 'sub1', index: 0, kind: 'text', delta: 'internal' });
  assert.ok(!a.blocks.some((b) => b.type === 'text' && b.text === 'internal'));
  s.emit({ type: 'assistantBlock', messageId: 'sub1', parentToolUseId: 't3', block: { type: 'tool_use', id: 'st1', name: 'Grep', input: { pattern: 'foo' } } });
  const nested = a.blocks.find((b) => b.id === 'st1');
  assert.equal(nested.parentToolUseId, 't3');
  s.emit({ type: 'task', taskId: 'x', toolUseId: 't3', description: 'explore', phase: 'done', summary: 'found it' });
  assert.equal(task.subagent.status, 'done');
  assert.equal(task.subagent.summary, 'found it');
});

await test('permission flow: waiting → respond → running; denied tool marked; question/plan blocks', async () => {
  const h = harness();
  const u = h.user('run tests');
  h.chat.messages.push(u);
  await h.runner.send({ text: 'run' }, u, [], false);
  const s = h.session();
  s.emit({ type: 'init', sessionId: 's', model: 'm', tools: [], permissionMode: 'default' });
  s.emit({ type: 'streamStart', messageId: 'm1', parentToolUseId: null });
  s.emit({ type: 'assistantBlock', messageId: 'm1', parentToolUseId: null, block: { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'npm test' } } });
  s.emit({ type: 'permissionRequest', request: { requestId: 'r1', toolUseId: 'b1', toolName: 'Bash', input: { command: 'npm test' }, kind: 'tool', title: 'Run npm test', suggestions: [{ label: 'Always allow npm test', index: 0 }] } });
  assert.equal(h.chat.status, 'waiting');
  assert.equal(h.calls.permissions.length, 1);
  const a = lastAssistant(h.chat);
  const perm = a.blocks.find((b) => b.type === 'permission');
  assert.equal(perm.id, 'r1');
  assert.equal(perm.suggestions.length, 1);
  assert.equal(h.runner.pendingRequest('r1').toolName, 'Bash');
  h.runner.respond('r1', { behavior: 'allow', updatedInput: { command: 'npm test' }, suggestionIndex: 0 }, 'always');
  assert.equal(h.chat.status, 'running');
  assert.equal(perm.decision, 'always');
  assert.deepEqual(s.responses[0][1], { behavior: 'allow', updatedInput: { command: 'npm test' }, suggestionIndex: 0 });
  s.emit({ type: 'permissionResolved', requestId: 'r1', behavior: 'allow' });
  s.emit({ type: 'toolResult', toolUseId: 'b1', content: 'ok', isError: false, parentToolUseId: null });
  // denied by the CLI (e.g. Ask mode hook)
  s.emit({ type: 'assistantBlock', messageId: 'm1', parentToolUseId: null, block: { type: 'tool_use', id: 'e1', name: 'Edit', input: { file_path: '/w/x' } } });
  s.emit({ type: 'permissionDenied', toolUseId: 'e1', toolName: 'Edit', message: 'Edits are disabled in Ask mode' });
  assert.equal(a.blocks.find((b) => b.id === 'e1').status, 'denied');
  // question + plan
  s.emit({ type: 'permissionRequest', request: { requestId: 'q1', toolUseId: 'aq', toolName: 'AskUserQuestion', input: { questions: [] }, kind: 'question', suggestions: [], questions: [{ question: 'Which?', header: 'Pick', options: [{ label: 'A', description: '' }], multiSelect: false }] } });
  assert.equal(a.blocks.find((b) => b.id === 'q1').type, 'question');
  h.runner.respond('q1', { behavior: 'allow', updatedInput: { answers: { 'Which?': 'A' } } }, 'allow');
  s.emit({ type: 'permissionRequest', request: { requestId: 'p1', toolUseId: 'ep', toolName: 'ExitPlanMode', input: {}, kind: 'plan', suggestions: [], plan: '# Plan\n1. do' } });
  const plan = a.blocks.find((b) => b.id === 'p1');
  assert.equal(plan.type, 'plan');
  assert.equal(h.chat.status, 'waiting');
  h.runner.respond('p1', { behavior: 'allow' }, 'allow');
  assert.equal(plan.decision, 'build');
  h.chat.mode = 'agent';
  await h.runner.syncSessionMode();
  assert.equal(s.mode, 'agent');
  // a pending request when the session dies is marked denied
  s.emit({ type: 'permissionRequest', request: { requestId: 'r2', toolUseId: 'b2', toolName: 'Bash', input: { command: 'rm' }, kind: 'tool', suggestions: [] } });
  h.runner.dispose();
  assert.equal(a.blocks.find((b) => b.id === 'r2').decision, 'deny');
  assert.equal(s.disposed, true);
});

await test('queue: second send while running is queued; replay clears it; result keeps running', async () => {
  const h = harness();
  const u1 = h.user('first');
  h.chat.messages.push(u1);
  await h.runner.send({ text: 'first' }, u1, [], false);
  const s = h.session();
  s.emit({ type: 'init', sessionId: 's', model: 'm', tools: [], permissionMode: 'acceptEdits' });
  s.emit({ type: 'userReplay', uuid: 'u-1', text: 'first' });
  s.emit({ type: 'streamStart', messageId: 'm1', parentToolUseId: null });
  s.emit({ type: 'blockStart', messageId: 'm1', index: 0, blockType: 'text' });
  s.emit({ type: 'blockDelta', messageId: 'm1', index: 0, kind: 'text', delta: 'working' });
  const u2 = h.user('second');
  h.chat.messages.push(u2);
  await h.runner.send({ text: 'second' }, u2, [], false);
  assert.equal(u2.queued, true);
  assert.equal(h.chat.status, 'running');
  assert.equal(s.sent.length, 2);
  const a1 = lastAssistant(h.chat);
  s.emit({ type: 'assistantBlock', messageId: 'm1', parentToolUseId: null, block: { type: 'text', text: 'working' } });
  s.emit({ type: 'result', subtype: 'success', isError: false, costUsd: 0, durationMs: 1, numTurns: 1, permissionDenials: [], queuedTurnCount: 1 });
  assert.equal(h.chat.status, 'running', 'stays running while a turn is queued');
  assert.equal(a1.streaming, false);
  s.emit({ type: 'userReplay', uuid: 'u-2', text: 'second' });
  assert.equal(u2.queued, false);
  assert.equal(u2.uuid, 'u-2');
  assert.equal(u1.uuid, 'u-1');
  s.emit({ type: 'streamStart', messageId: 'm2', parentToolUseId: null });
  s.emit({ type: 'blockStart', messageId: 'm2', index: 0, blockType: 'text' });
  s.emit({ type: 'blockDelta', messageId: 'm2', index: 0, kind: 'text', delta: 'second answer' });
  const a2 = lastAssistant(h.chat);
  assert.notEqual(a1, a2, 'queued turn gets its own assistant message');
  assert.equal(a2.blocks[0].text, 'second answer');
  s.emit({ type: 'assistantBlock', messageId: 'm2', parentToolUseId: null, block: { type: 'text', text: 'second answer' } });
  s.emit({ type: 'result', subtype: 'success', isError: false, costUsd: 0, durationMs: 1, numTurns: 1, permissionDenials: [], queuedTurnCount: 0 });
  assert.equal(h.chat.status, 'idle');
  assert.equal(h.calls.turnEnds, 2);
});

await test('replay uuid is not stolen by restored messages without uuid', async () => {
  const h = harness();
  // messages restored from a transcript (no uuid)
  h.chat.messages.push({ kind: 'user', id: 'old-u', text: 'older', attachments: [], timestamp: 1, canRestore: false });
  h.chat.messages.push({ kind: 'assistant', id: 'old-a', blocks: [{ type: 'text', id: 't', text: 'old answer' }], streaming: false, timestamp: 2 });
  h.chat.sessionId = 'resume-me';
  const u = h.user('new');
  h.chat.messages.push(u);
  await h.runner.send({ text: 'new' }, u, [], false);
  const s = h.session();
  assert.equal(s.opts.resume, 'resume-me');
  assert.equal(h.chat.status, 'running', 'resumed sessions skip "starting"');
  s.emit({ type: 'init', sessionId: 'resume-me', model: 'm', tools: [], permissionMode: 'acceptEdits' });
  s.emit({ type: 'userReplay', uuid: 'uu-new', text: 'new' });
  assert.equal(h.chat.messages[0].uuid, undefined);
  assert.equal(h.chat.messages[0].canRestore, false);
  assert.equal(u.uuid, 'uu-new');
  assert.equal(u.canRestore, true);
});

await test('interrupt: pending permission denied, running tools marked, late result ignored, send-now works', async () => {
  const h = harness();
  const u = h.user('go');
  h.chat.messages.push(u);
  await h.runner.send({ text: 'go' }, u, [], false);
  const s = h.session();
  s.emit({ type: 'init', sessionId: 's', model: 'm', tools: [], permissionMode: 'default' });
  s.emit({ type: 'streamStart', messageId: 'm1', parentToolUseId: null });
  s.emit({ type: 'assistantBlock', messageId: 'm1', parentToolUseId: null, block: { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'sleep 100' } } });
  s.emit({ type: 'permissionRequest', request: { requestId: 'r1', toolUseId: 'b1', toolName: 'Bash', input: { command: 'sleep 100' }, kind: 'tool', suggestions: [] } });
  await h.runner.interrupt();
  assert.equal(s.interrupts, 1);
  assert.equal(s.responses[0][1].behavior, 'deny');
  assert.equal(s.responses[0][1].interrupt, true);
  assert.equal(h.chat.status, 'idle');
  const a = lastAssistant(h.chat);
  assert.equal(a.streaming, false);
  assert.equal(a.blocks[0].status, 'error');
  assert.equal(a.blocks[0].output, 'Interrupted');
  assert.equal(a.blocks[1].decision, 'deny');
  const notes = h.chat.messages.filter((m) => m.kind === 'system').length;
  // late result of the interrupted turn → no error note, cost kept, state untouched
  s.emit({ type: 'result', subtype: 'error_during_execution', isError: true, errors: ['interrupted'], costUsd: 0.02, durationMs: 5, numTurns: 1, permissionDenials: [], queuedTurnCount: 0 });
  assert.equal(h.chat.status, 'idle');
  assert.equal(h.chat.messages.filter((m) => m.kind === 'system').length, notes);
  assert.equal(h.chat.totalCostUsd, 0.02);
  assert.equal(h.chat.error, undefined);
  // interrupt when idle is a no-op for the state
  const ends = h.calls.turnEnds;
  await h.runner.interrupt();
  assert.equal(h.calls.turnEnds, ends);
  // send-now while running: interrupt, then a fresh turn; the stale result does not end the new turn
  const u2 = h.user('again');
  h.chat.messages.push(u2);
  await h.runner.send({ text: 'again' }, u2, [], false);
  s.emit({ type: 'streamStart', messageId: 'm2', parentToolUseId: null });
  s.emit({ type: 'blockStart', messageId: 'm2', index: 0, blockType: 'text' });
  s.emit({ type: 'blockDelta', messageId: 'm2', index: 0, kind: 'text', delta: 'slow' });
  const u3 = h.user('now!');
  h.chat.messages.push(u3);
  await h.runner.send({ text: 'now!' }, u3, [], true);
  assert.equal(s.interrupts, 2);
  assert.equal(u3.queued, undefined);
  assert.equal(h.chat.status, 'running');
  s.emit({ type: 'result', subtype: 'success', isError: false, costUsd: 0, durationMs: 1, numTurns: 1, permissionDenials: [], queuedTurnCount: 1 });
  assert.equal(h.chat.status, 'running', 'stale result with a pending turn keeps running');
  s.emit({ type: 'userReplay', uuid: 'uu-3', text: 'now!' });
  assert.equal(u3.uuid, 'uu-3');
  s.emit({ type: 'streamStart', messageId: 'm3', parentToolUseId: null });
  s.emit({ type: 'blockStart', messageId: 'm3', index: 0, blockType: 'text' });
  s.emit({ type: 'blockDelta', messageId: 'm3', index: 0, kind: 'text', delta: 'fast' });
  s.emit({ type: 'assistantBlock', messageId: 'm3', parentToolUseId: null, block: { type: 'text', text: 'fast' } });
  s.emit({ type: 'result', subtype: 'success', isError: false, costUsd: 0, durationMs: 1, numTurns: 1, permissionDenials: [], queuedTurnCount: 0 });
  assert.equal(h.chat.status, 'idle');
  assert.equal(lastAssistant(h.chat).blocks[0].text, 'fast');
  assert.equal(lastAssistant(h.chat).result.isError, false);
});

await test('fatal error + exit: status error, note with action, next send resumes with a new process', async () => {
  const h = harness();
  const u = h.user('x');
  h.chat.messages.push(u);
  await h.runner.send({ text: 'x' }, u, [], false);
  const s1 = h.session();
  s1.emit({ type: 'init', sessionId: 'sess-9', model: 'm', tools: [], permissionMode: 'acceptEdits' });
  s1.emit({ type: 'streamStart', messageId: 'm1', parentToolUseId: null });
  s1.emit({ type: 'error', message: 'Claude Code exited with code 1. The conversation will be resumed.', fatal: true });
  s1.emit({ type: 'exit', code: 1 });
  assert.equal(h.chat.status, 'error');
  assert.ok(h.chat.error);
  assert.equal(lastAssistant(h.chat).result.isError, true);
  assert.equal(h.chat.messages.filter((m) => m.kind === 'system' && m.level === 'error').length, 1, 'one error note, not two');
  // control calls on the dead session do not throw
  await h.runner.setModel('opus');
  assert.equal(h.chat.model, 'opus');
  const u2 = h.user('retry');
  h.chat.messages.push(u2);
  await h.runner.send({ text: 'retry' }, u2, [], false);
  assert.equal(h.sessions.length, 2);
  assert.equal(s1.disposed, true);
  const s2 = h.session();
  assert.equal(s2.opts.resume, 'sess-9');
  assert.equal(s2.opts.model, 'opus');
  assert.equal(h.chat.status, 'running');
  assert.equal(h.chat.error, undefined);
  // non-fatal error → warning note, still running
  s2.emit({ type: 'error', message: 'transient', fatal: false });
  assert.equal(h.chat.status, 'running');
  // rate limit + compaction notes
  s2.emit({ type: 'rateLimit', status: 'allowed_warning', fiveHour: 94 });
  assert.equal(h.chat.rateLimit.fiveHour, 94);
  s2.emit({ type: 'compacted', preTokens: 150000, postTokens: 20000 });
  assert.ok(h.chat.messages.some((m) => m.kind === 'system' && /compacted/i.test(m.text)));
  s2.emit({ type: 'thinkingProgress', estimatedTokens: 12 });
  s2.emit({ type: 'result', subtype: 'error_max_turns', isError: true, costUsd: 0, durationMs: 1, numTurns: 1, permissionDenials: [], queuedTurnCount: 0 });
  assert.equal(h.chat.status, 'idle');
  assert.equal(h.chat.error, 'Turn ended with error_max_turns');
});

await test('mode changes: live setMode, ask fallback restarts, rules change invalidates on idle', async () => {
  const h = harness();
  const u = h.user('x');
  h.chat.messages.push(u);
  await h.runner.send({ text: 'x' }, u, [], false);
  const s1 = h.session();
  s1.emit({ type: 'init', sessionId: 'a', model: 'm', tools: [], permissionMode: 'acceptEdits' });
  await h.runner.setMode('plan');
  assert.equal(s1.mode, 'plan');
  assert.equal(h.chat.mode, 'plan');
  // without session.setMode the fallback uses setPermissionMode / restart
  s1.setMode = undefined;
  await h.runner.setMode('agent');
  assert.equal(s1.permissionMode, 'acceptEdits');
  await h.runner.setMode('ask');
  assert.equal(h.chat.mode, 'ask');
  s1.emit({ type: 'result', subtype: 'success', isError: false, costUsd: 0, durationMs: 1, numTurns: 1, permissionDenials: [], queuedTurnCount: 0 });
  assert.equal(s1.disposed, true, 'ask needs a respawn once idle');
  const u2 = h.user('y');
  h.chat.messages.push(u2);
  await h.runner.send({ text: 'y' }, u2, [], false);
  assert.equal(h.sessions.length, 2);
  assert.equal(h.session().opts.mode, 'ask');
  assert.equal(h.session().opts.resume, 'a');
  h.runner.invalidateSession();
  assert.equal(h.session().disposed, false, 'running: restart deferred');
  h.session().emit({ type: 'result', subtype: 'success', isError: false, costUsd: 0, durationMs: 1, numTurns: 1, permissionDenials: [], queuedTurnCount: 0 });
  assert.equal(h.session().disposed, true);
  assert.equal(effectivePermissionMode({ mode: 'ask', permissionMode: 'bypassPermissions' }), 'default');
  assert.equal(effectivePermissionMode({ mode: 'plan', permissionMode: 'acceptEdits' }), 'plan');
});

await test('persistence trimming and helpers', () => {
  const chat = state.createChatState({ mode: 'agent', permissionMode: 'acceptEdits', model: '', effort: '' });
  for (let i = 0; i < 250; i++) chat.messages.push({ kind: 'user', id: `u${i}`, text: `m${i}`, attachments: [{ id: 'a', kind: 'image', label: 'i.png', image: { mediaType: 'image/png', dataBase64: 'AAAA', name: 'i.png' } }], timestamp: i, canRestore: false, queued: true });
  chat.messages.push({ kind: 'assistant', id: 'a', streaming: true, timestamp: 1, blocks: [
    { type: 'tool', id: 't', name: 'Bash', input: {}, status: 'running', startedAt: 1, output: 'y'.repeat(30000) },
    { type: 'permission', id: 'p', toolUseId: 't', toolName: 'Bash', input: {}, suggestions: [] },
    { type: 'thinking', id: 'th', text: '', done: false, startedAt: 1 },
  ] });
  chat.status = 'running';
  const t = state.trimForPersistence(chat);
  assert.equal(t.messages.length, 200);
  assert.equal(t.status, 'idle');
  const firstUser = t.messages.find((m) => m.kind === 'user');
  assert.equal(firstUser.queued, false);
  assert.equal(firstUser.attachments[0].image.dataBase64, '');
  const a = t.messages[t.messages.length - 1];
  assert.equal(a.streaming, false);
  assert.equal(a.blocks[0].status, 'error');
  assert.equal(a.blocks[0].outputTruncated, true);
  assert.ok(a.blocks[0].output.length <= 20 * 1024 + 100);
  assert.equal(a.blocks[1].decision, 'deny');
  assert.equal(a.blocks[2].done, true);
  assert.equal(state.titleFromText('## Attached\n\n  # Fix the **login** bug please, it is really quite long indeed ok'), 'Fix the **login** bug please, it is rea…');
  assert.deepEqual(previewInput('{"command":"ls -la","desc'), { _partial: true, command: 'ls -la' });
  assert.deepEqual(previewInput('{"a":1}'), { a: 1 });
  const turn = prompt.composeTurn('do it', [
    { id: '1', kind: 'file', label: 'a.ts', path: '/w/src/a.ts' },
    { id: '2', kind: 'selection', label: 'b.ts:1-2', path: '/w/b.ts', range: { startLine: 1, endLine: 2 }, text: 'x\n```\ny' },
    { id: '3', kind: 'image', label: 'i.png', image: { mediaType: 'image/png', dataBase64: 'Zm9v', name: 'i.png' } },
  ], { cwd: '/w', activeFile: { fsPath: '/w/c.ts', cursorLine: 3, selection: { startLine: 3, endLine: 5 } } });
  assert.ok(turn.turn.text.startsWith('do it\n\n## Attached context\n\n@src/a.ts'));
  assert.ok(turn.turn.text.includes('### Selection from `b.ts` (lines 1-2)\n````ts\nx\n```\ny\n````'));
  assert.ok(turn.turn.text.endsWith('Active file: `c.ts` (cursor at L3, selection L3-5)'));
  assert.deepEqual(turn.turn.images, [{ mediaType: 'image/png', dataBase64: 'Zm9v' }]);
  assert.deepEqual(turn.contextPaths, ['/w/src/a.ts', '/w/b.ts', '/w/c.ts']);
});

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
