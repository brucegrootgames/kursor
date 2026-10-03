/**
 * ChatRunner — binds one ClaudeSession to one ChatState and translates
 * SessionEvents into state mutations:
 *   - text/thinking deltas → `textDelta` posts (via `onDelta`),
 *   - everything structural → `notify()` (the store throttles chatState posts),
 *   - tool_use blocks are created on blockStart (input streaming), finalized on
 *     assistantBlock, get their output on toolResult and an `edit` summary on
 *     fileChanged (through the EditTracker),
 *   - permission / question / plan requests become blocks and put the chat in
 *     'waiting'; answers go back through `respondPermission`,
 *   - TodoWrite calls become a single live-updating `todo` block per turn.
 * The ClaudeSession is created lazily on the first send and re-created (with
 * `resume`) when the rules appendix changes or after a fatal error.
 */
import * as vscode from 'vscode';
import type { AssistantMessage, Block, ChatMode, ChatState, EditSummary, EffortLevel, PermissionMode, UserMessage } from '../../shared/protocol';
import type { ClaudeBridge, ClaudeSession, PermissionDecision, PermissionRequest, SessionEvent, UserTurn } from '../claude/types';
import type { EditTracker, RulesService } from '../services';
import type { Logger } from '../util/log';
import { relPathOf } from '../context/providers';
import { lineStats } from '../edits/model';
import { KURSOR_SYSTEM_NOTE } from './prompt';
import { capOutput, findToolBlock, hasQueuedMessages, lastAssistant, newId, systemNote } from './state';

type ToolBlock = Extract<Block, { type: 'tool' }>;
type TextBlock = Extract<Block, { type: 'text' }>;
type ThinkingBlock = Extract<Block, { type: 'thinking' }>;
type TodoBlock = Extract<Block, { type: 'todo' }>;

export interface RunnerDeps {
  log: Logger;
  bridge: ClaudeBridge;
  edits: EditTracker;
  rules: RulesService;
  /** Structural change → schedule a chatState post. */
  notify: () => void;
  onDelta: (messageId: string, blockId: string, delta: string) => void;
  onPermissionRequest: (request: PermissionRequest) => void;
  onInit: (session: ClaudeSession) => void;
  onTurnEnd: () => void;
  additionalDirectories: () => string[];
}

export function effectivePermissionMode(chat: Pick<ChatState, 'mode' | 'permissionMode'>): PermissionMode {
  if (chat.mode === 'plan') return 'plan';
  if (chat.mode === 'ask') return 'default';
  return chat.permissionMode;
}

/** Best-effort preview of a streaming tool input (partial JSON). */
export function previewInput(partial: string): unknown {
  try {
    return JSON.parse(partial);
  } catch {
    /* fall through */
  }
  const out: Record<string, unknown> = { _partial: true };
  const re = /"(file_path|path|command|pattern|description|prompt|query|url|notebook_path|subagent_type|glob)"\s*:\s*"((?:[^"\\]|\\.)*)"?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(partial))) {
    try {
      out[m[1]] = JSON.parse(`"${m[2]}"`);
    } catch {
      out[m[1]] = m[2];
    }
  }
  const content = /"(content|new_string|old_string)"\s*:\s*"((?:[^"\\]|\\.){0,400})/.exec(partial);
  if (content) out[content[1]] = `${content[2]}…`;
  return out;
}

function todoItems(input: unknown): TodoBlock['items'] {
  const todos = (input as { todos?: unknown })?.todos;
  if (!Array.isArray(todos)) return [];
  return todos
    .map((t) => {
      const o = t as { content?: unknown; status?: unknown };
      const status = o.status === 'in_progress' || o.status === 'completed' ? o.status : 'pending';
      return { content: typeof o.content === 'string' ? o.content : String(o.content ?? ''), status: status as TodoBlock['items'][number]['status'] };
    })
    .filter((t) => t.content);
}

export class ChatRunner implements vscode.Disposable {
  private session: ClaudeSession | undefined;
  private sessionSub: vscode.Disposable | undefined;
  private assistant: AssistantMessage | undefined;
  private readonly streamBlocks = new Map<string, Block>();
  private readonly partialInputs = new Map<string, string>();
  private readonly confirmed = new Map<string, number>();
  private readonly subagentMessages = new Set<string>();
  private readonly pendingRequests = new Map<string, PermissionRequest>();
  /** User messages sent through this runner that have not received their Claude Code uuid yet (FIFO). */
  private readonly awaitingUuid: UserMessage[] = [];
  private sessionMode: ChatMode | undefined;
  private restartOnIdle = false;
  private interrupted = false;
  private disposed = false;
  private resolvedModel: string | undefined;

  constructor(
    readonly chat: ChatState,
    private readonly deps: RunnerDeps,
  ) {}

  get running(): boolean {
    return this.chat.status === 'running' || this.chat.status === 'starting' || this.chat.status === 'waiting';
  }

  get hasSession(): boolean {
    return !!this.session;
  }

  get pendingRequestIds(): string[] {
    return [...this.pendingRequests.keys()];
  }

  // ---- session lifecycle -------------------------------------------------------

  private async buildAppendix(contextPaths: string[]): Promise<string> {
    let rules = '';
    try {
      rules = await this.deps.rules.buildAppendix(this.chat.cwd ?? process.cwd(), contextPaths);
    } catch (err) {
      this.deps.log.warn('rules appendix failed', err);
    }
    return [KURSOR_SYSTEM_NOTE, rules.trim()].filter(Boolean).join('\n\n');
  }

  async ensureSession(contextPaths: string[] = []): Promise<ClaudeSession> {
    if (this.session && !this.restartOnIdle) return this.session;
    if (this.session) this.disposeSession();
    const cwd = this.chat.cwd ?? process.cwd();
    const appendSystemPrompt = await this.buildAppendix(contextPaths);
    const session = this.deps.bridge.createSession({
      cwd,
      mode: this.chat.mode,
      permissionMode: this.chat.permissionMode,
      model: this.chat.model || undefined,
      effort: this.chat.effort || undefined,
      resume: this.chat.sessionId,
      appendSystemPrompt,
      additionalDirectories: this.deps.additionalDirectories().filter((d) => d !== cwd),
    });
    this.session = session;
    this.sessionMode = this.chat.mode;
    this.restartOnIdle = false;
    this.sessionSub = session.onEvent((e) => {
      try {
        this.handle(e);
      } catch (err) {
        this.deps.log.error('event handling failed', err);
      }
    });
    this.deps.log.info(`session created for chat ${this.chat.id} (cwd ${cwd}, mode ${this.chat.mode}${this.chat.sessionId ? `, resume ${this.chat.sessionId}` : ''})`);
    return session;
  }

  private disposeSession(): void {
    this.sessionSub?.dispose();
    this.sessionSub = undefined;
    const s = this.session;
    this.session = undefined;
    for (const id of this.pendingRequests.keys()) this.resolveRequestBlock(id, 'deny');
    this.pendingRequests.clear();
    this.awaitingUuid.length = 0;
    try {
      s?.dispose();
    } catch (err) {
      this.deps.log.warn('session dispose failed', err);
    }
  }

  /** Recreate the process (with resume) before the next turn — e.g. rules changed. */
  invalidateSession(): void {
    if (!this.session) return;
    if (this.running) this.restartOnIdle = true;
    else this.disposeSession();
  }

  // ---- user actions -------------------------------------------------------------

  async send(turn: UserTurn, user: UserMessage, contextPaths: string[], sendNow: boolean): Promise<void> {
    const wasRunning = this.running;
    if (wasRunning && sendNow) {
      await this.interrupt();
    }
    const session = await this.ensureSession(contextPaths);
    if (wasRunning && !sendNow) {
      user.queued = true;
    } else {
      this.assistant = undefined;
      this.chat.status = this.chat.sessionId ? 'running' : 'starting';
      this.chat.error = undefined;
    }
    this.awaitingUuid.push(user);
    this.chat.updatedAt = Date.now();
    this.deps.notify();
    session.send(turn);
  }

  /** Attach Claude Code's uuid for a user turn to the oldest message still waiting for one. */
  private assignUuid(uuid: string): UserMessage | undefined {
    const u = this.awaitingUuid.shift();
    if (!u) return undefined;
    u.uuid = uuid;
    u.canRestore = true;
    return u;
  }

  async interrupt(): Promise<void> {
    if (!this.session) return;
    const wasRunning = this.running;
    if (!wasRunning && !this.session.running) return; // nothing to stop
    this.interrupted = true;
    try {
      await this.session.interrupt();
    } catch (err) {
      this.deps.log.warn('interrupt failed', err);
    }
    for (const id of [...this.pendingRequests.keys()]) {
      this.session.respondPermission(id, { behavior: 'deny', message: 'Stopped by the user.', interrupt: true });
      this.resolveRequestBlock(id, 'deny');
    }
    this.pendingRequests.clear();
    // Queued follow-ups are dropped by the CLI on interrupt.
    for (const m of this.chat.messages) if (m.kind === 'user' && m.queued) m.queued = false;
    this.awaitingUuid.length = 0;
    if (wasRunning) {
      const a = this.assistant ?? lastAssistant(this.chat);
      for (const b of a?.blocks ?? []) {
        if (b.type === 'tool' && b.status === 'running') {
          b.status = 'error';
          b.output = b.output || 'Interrupted';
        }
      }
      this.finishTurn({ isError: false });
    }
  }

  respond(requestId: string, decision: PermissionDecision, uiDecision?: 'allow' | 'deny' | 'always'): void {
    const request = this.pendingRequests.get(requestId);
    if (!request || !this.session) {
      this.deps.log.warn(`no pending request ${requestId}`);
      this.resolveRequestBlock(requestId, decision.behavior, uiDecision);
      return;
    }
    this.session.respondPermission(requestId, decision);
    this.pendingRequests.delete(requestId);
    this.resolveRequestBlock(requestId, decision.behavior, uiDecision);
    if (!this.pendingRequests.size && this.chat.status === 'waiting') this.chat.status = 'running';
    this.deps.notify();
  }

  pendingRequest(requestId: string): PermissionRequest | undefined {
    return this.pendingRequests.get(requestId);
  }

  async setMode(mode: ChatMode): Promise<void> {
    this.chat.mode = mode;
    await this.syncSessionMode();
  }

  /** Push `chat.mode` to the live session (no-op without a session or when it already matches). */
  async syncSessionMode(): Promise<void> {
    const mode = this.chat.mode;
    const prev = this.sessionMode;
    if (!this.session || prev === mode) return;
    if (this.session.setMode) {
      try {
        await this.session.setMode(mode);
        this.sessionMode = mode;
        return;
      } catch (err) {
        this.deps.log.warn('setMode failed, falling back to restart', err);
      }
    }
    if (prev === 'ask' || mode === 'ask') {
      // disallowedTools can only change at spawn time.
      this.invalidateSession();
      return;
    }
    try {
      await this.session.setPermissionMode(effectivePermissionMode(this.chat));
      this.sessionMode = mode;
    } catch (err) {
      this.deps.log.warn('setPermissionMode failed', err);
      this.invalidateSession();
    }
  }

  /** Control calls can fail on a process that just died; the new value is applied on respawn anyway. */
  private async control(what: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      this.deps.log.warn(`${what} failed (applied on the next session start)`, err);
    }
  }

  async setModel(model: string): Promise<void> {
    this.chat.model = model;
    const s = this.session;
    if (s && !this.restartOnIdle) await this.control('setModel', () => s.setModel(model));
  }

  async setEffort(effort: EffortLevel): Promise<void> {
    this.chat.effort = effort;
    const s = this.session;
    if (s && !this.restartOnIdle) await this.control('setEffort', () => s.setEffort(effort));
  }

  async setPermissionMode(mode: PermissionMode): Promise<void> {
    this.chat.permissionMode = mode;
    const s = this.session;
    if (s && !this.restartOnIdle && this.chat.mode === 'agent') await this.control('setPermissionMode', () => s.setPermissionMode(mode));
  }

  async rewindFiles(uuid: string): Promise<{ canRewind: boolean; filesChanged?: string[]; error?: string }> {
    const session = await this.ensureSession();
    return session.rewindFiles(uuid);
  }

  async contextUsage(): Promise<ChatState['contextUsage']> {
    if (!this.session) return undefined;
    try {
      const u = await this.session.contextUsage();
      if (!u || !u.maxTokens) return undefined;
      return { usedTokens: u.usedTokens, maxTokens: u.maxTokens, percent: Math.min(100, Math.round((u.usedTokens / u.maxTokens) * 100)), breakdown: u.breakdown };
    } catch (err) {
      this.deps.log.debug('contextUsage failed', err);
      return undefined;
    }
  }

  /** Refresh `edit` summaries on tool blocks from the tracker (after keep/undo). */
  refreshEditSummaries(pending: EditSummary[], fallbackStatus: 'kept' | 'undone'): void {
    this.chat.pendingEdits = pending;
    for (const m of this.chat.messages) {
      if (m.kind !== 'assistant') continue;
      for (const b of m.blocks) {
        if (b.type !== 'tool' || !b.edit) continue;
        const live = pending.find((p) => p.path === b.edit?.path);
        if (live) b.edit = { ...live };
        else if (b.edit.status === 'pending') b.edit = { ...b.edit, status: fallbackStatus, hunks: 0 };
      }
    }
  }

  markEdits(paths: string[] | undefined, status: 'kept' | 'undone'): void {
    for (const m of this.chat.messages) {
      if (m.kind !== 'assistant') continue;
      for (const b of m.blocks) {
        if (b.type === 'tool' && b.edit && b.edit.status === 'pending' && (!paths || paths.includes(b.edit.path))) b.edit = { ...b.edit, status, hunks: 0 };
      }
    }
  }

  // ---- event translation ----------------------------------------------------------

  private key(messageId: string, index: number): string {
    return `${messageId}:${index}`;
  }

  private ensureAssistant(): AssistantMessage {
    if (this.assistant && this.chat.messages.includes(this.assistant)) return this.assistant;
    const m: AssistantMessage = { kind: 'assistant', id: newId('a'), blocks: [], streaming: true, timestamp: Date.now(), model: this.resolvedModel };
    this.chat.messages.push(m);
    this.assistant = m;
    if (this.chat.status === 'starting' || this.chat.status === 'idle') this.chat.status = 'running';
    return m;
  }

  private handle(e: SessionEvent): void {
    if (this.disposed) return;
    const chat = this.chat;
    switch (e.type) {
      case 'init': {
        chat.sessionId = e.sessionId;
        this.resolvedModel = e.model;
        if (chat.status === 'starting') chat.status = 'running';
        if (this.session) this.deps.onInit(this.session);
        this.deps.notify();
        break;
      }
      case 'status':
        // API retries / compaction progress: informational only (the UI keeps its spinner).
        if (e.detail) this.deps.log.info(`status: ${e.status} ${e.detail}`);
        break;
      case 'userReplay': {
        const u = this.assignUuid(e.uuid);
        if (u) {
          if (u.queued) {
            // The queued turn is now being processed. `finishTurn` of the previous turn (which may
            // arrive before or after this echo) resets the assistant message; do not do it here.
            u.queued = false;
            if (chat.status === 'idle') chat.status = 'running';
          }
          this.deps.notify();
        }
        break;
      }
      case 'streamStart':
        if (e.parentToolUseId) this.subagentMessages.add(e.messageId);
        else this.ensureAssistant();
        break;
      case 'blockStart':
        this.onBlockStart(e);
        break;
      case 'blockDelta':
        this.onBlockDelta(e);
        break;
      case 'blockStop': {
        const b = this.streamBlocks.get(this.key(e.messageId, e.index));
        if (b?.type === 'thinking' && !b.done) {
          b.done = true;
          b.endedAt = Date.now();
          this.deps.notify();
        }
        break;
      }
      case 'assistantBlock':
        this.onAssistantBlock(e);
        break;
      case 'toolResult':
        this.onToolResult(e);
        break;
      case 'permissionRequest':
        this.onPermissionRequest(e.request);
        break;
      case 'permissionResolved':
        if (this.pendingRequests.delete(e.requestId)) this.resolveRequestBlock(e.requestId, e.behavior);
        if (!this.pendingRequests.size && chat.status === 'waiting') chat.status = 'running';
        this.deps.notify();
        break;
      case 'permissionDenied': {
        const found = findToolBlock(chat, e.toolUseId);
        if (found) {
          found.block.status = 'denied';
          found.block.output = e.message;
          found.block.endedAt = Date.now();
          found.block.inputStreaming = false;
          this.deps.notify();
        }
        break;
      }
      case 'fileChanged':
        this.onFileChanged(e);
        break;
      case 'task':
        this.onTask(e);
        break;
      case 'thinkingProgress':
        break;
      case 'compacted':
        chat.messages.push(systemNote(`Context compacted (${e.preTokens.toLocaleString()} → ${(e.postTokens ?? 0).toLocaleString()} tokens).`));
        this.deps.notify();
        break;
      case 'result':
        this.onResult(e);
        break;
      case 'rateLimit':
        chat.rateLimit = { fiveHour: e.fiveHour, sevenDay: e.sevenDay, resetsAt: e.resetsAt, status: e.status };
        if (e.status === 'rejected') {
          chat.messages.push(systemNote('Usage limit reached — Claude Code cannot make more requests right now.', 'warning'));
        }
        this.deps.notify();
        break;
      case 'error':
        this.deps.log.error(`session error (${e.fatal ? 'fatal' : 'recoverable'}): ${e.message}`);
        chat.messages.push(systemNote(e.message, e.fatal ? 'error' : 'warning'));
        if (e.fatal) {
          chat.error = e.message;
          this.finishTurn({ isError: true, errorText: e.message });
          chat.status = 'error';
          this.restartOnIdle = true;
        }
        this.deps.notify();
        break;
      case 'exit':
        if (this.running) {
          const msg = `Claude Code exited unexpectedly${e.code !== null ? ` (code ${e.code})` : ''}.`;
          chat.messages.push(systemNote(msg, 'error', { label: 'Show logs', command: 'kursor.showLogs' }));
          chat.error = msg;
          this.finishTurn({ isError: true, errorText: msg });
          chat.status = 'error';
        }
        this.restartOnIdle = true;
        this.deps.notify();
        break;
      default:
        break;
    }
  }

  private onBlockStart(e: Extract<SessionEvent, { type: 'blockStart' }>): void {
    const key = this.key(e.messageId, e.index);
    const subagent = this.subagentMessages.has(e.messageId);
    if (subagent && e.blockType !== 'tool_use') return;
    const assistant = this.ensureAssistant();
    let block: Block;
    switch (e.blockType) {
      case 'text':
        block = { type: 'text', id: key, text: '' };
        break;
      case 'thinking':
        block = { type: 'thinking', id: key, text: '', done: false, startedAt: Date.now() };
        break;
      default: {
        const tool: ToolBlock = {
          type: 'tool',
          id: e.toolUseId ?? key,
          name: e.toolName ?? 'tool',
          input: {},
          inputStreaming: true,
          status: 'running',
          startedAt: Date.now(),
        };
        if (subagent) tool.parentToolUseId = this.parentFor(e.messageId);
        block = tool;
        this.partialInputs.set(key, '');
      }
    }
    assistant.blocks.push(block);
    this.streamBlocks.set(key, block);
    this.deps.notify();
  }

  private parentFor(_messageId: string): string | null {
    // The parent tool_use id of a subagent message is only known from streamStart/assistantBlock;
    // the last running Task block is the best available guess.
    const a = this.assistant;
    if (!a) return null;
    for (let i = a.blocks.length - 1; i >= 0; i--) {
      const b = a.blocks[i];
      if (b.type === 'tool' && b.name === 'Task' && b.status === 'running' && !b.parentToolUseId) return b.id;
    }
    return null;
  }

  private onBlockDelta(e: Extract<SessionEvent, { type: 'blockDelta' }>): void {
    if (this.subagentMessages.has(e.messageId) && e.kind !== 'input_json') return;
    const key = this.key(e.messageId, e.index);
    let block = this.streamBlocks.get(key);
    if (!block) {
      if (e.kind === 'input_json') return; // tool block without start: wait for assistantBlock
      this.onBlockStart({ type: 'blockStart', messageId: e.messageId, index: e.index, blockType: e.kind === 'thinking' ? 'thinking' : 'text' });
      block = this.streamBlocks.get(key);
      if (!block) return;
    }
    const assistant = this.ensureAssistant();
    if (e.kind === 'text' && block.type === 'text') {
      block.text += e.delta;
      this.deps.onDelta(assistant.id, block.id, e.delta);
    } else if (e.kind === 'thinking' && block.type === 'thinking') {
      block.text += e.delta;
      this.deps.onDelta(assistant.id, block.id, e.delta);
    } else if (e.kind === 'input_json' && block.type === 'tool') {
      const partial = (this.partialInputs.get(key) ?? '') + e.delta;
      this.partialInputs.set(key, partial);
      block.input = previewInput(partial);
      this.deps.notify();
    }
  }

  private takeStreamingBlock(messageId: string, type: Block['type']): Block | undefined {
    const ordinal = this.confirmed.get(messageId) ?? 0;
    const direct = this.streamBlocks.get(this.key(messageId, ordinal));
    if (direct && direct.type === type) return direct;
    for (const [k, b] of this.streamBlocks) {
      if (k.startsWith(`${messageId}:`) && b.type === type) return b;
    }
    return undefined;
  }

  private onAssistantBlock(e: Extract<SessionEvent, { type: 'assistantBlock' }>): void {
    const chat = this.chat;
    if (e.userMessageUuid && this.awaitingUuid.length && this.awaitingUuid[0].uuid === undefined) {
      const u = this.assignUuid(e.userMessageUuid);
      if (u) u.queued = false;
    }
    if (e.error) {
      chat.error = e.error;
      chat.messages.push(systemNote(`Claude Code reported: ${e.error}`, 'error'));
    }
    const ordinal = this.confirmed.get(e.messageId) ?? 0;
    this.confirmed.set(e.messageId, ordinal + 1);
    const isSubagent = e.parentToolUseId !== null || this.subagentMessages.has(e.messageId);
    if (isSubagent && e.block.type !== 'tool_use') return;
    const assistant = this.ensureAssistant();
    const b = e.block;
    if (b.type === 'text') {
      const existing = this.takeStreamingBlock(e.messageId, 'text') as TextBlock | undefined;
      if (existing) {
        existing.text = b.text;
        this.forgetStream(existing);
      } else if (b.text) {
        assistant.blocks.push({ type: 'text', id: newId('t'), text: b.text });
      }
    } else if (b.type === 'thinking') {
      const existing = this.takeStreamingBlock(e.messageId, 'thinking') as ThinkingBlock | undefined;
      if (existing) {
        if (b.thinking) existing.text = b.thinking;
        existing.done = true;
        existing.endedAt = existing.endedAt ?? Date.now();
        this.forgetStream(existing);
      } else if (b.thinking) {
        assistant.blocks.push({ type: 'thinking', id: newId('th'), text: b.thinking, done: true, startedAt: Date.now(), endedAt: Date.now() });
      }
    } else {
      let tool = assistant.blocks.find((x): x is ToolBlock => x.type === 'tool' && x.id === b.id);
      if (!tool) {
        const streaming = this.takeStreamingBlock(e.messageId, 'tool') as ToolBlock | undefined;
        if (streaming && (streaming.id === b.id || streaming.id.startsWith(`${e.messageId}:`))) {
          tool = streaming;
          tool.id = b.id;
        }
      }
      if (!tool) {
        tool = { type: 'tool', id: b.id, name: b.name, input: b.input, status: 'running', startedAt: Date.now() };
        if (isSubagent) tool.parentToolUseId = e.parentToolUseId ?? this.parentFor(e.messageId);
        assistant.blocks.push(tool);
      }
      tool.name = b.name;
      tool.input = b.input;
      tool.inputStreaming = false;
      if (isSubagent && !tool.parentToolUseId) tool.parentToolUseId = e.parentToolUseId;
      if (b.name === 'Task') {
        const input = b.input as { description?: unknown; subagent_type?: unknown };
        tool.subagent = { ...tool.subagent, description: typeof input.description === 'string' ? input.description : undefined, type: typeof input.subagent_type === 'string' ? input.subagent_type : undefined, status: 'running' };
      }
      if (b.name === 'TodoWrite') this.applyTodo(assistant, tool, b.input);
      this.forgetStream(tool);
    }
    this.deps.notify();
  }

  private applyTodo(assistant: AssistantMessage, tool: ToolBlock, input: unknown): void {
    const items = todoItems(input);
    const existing = assistant.blocks.find((x): x is TodoBlock => x.type === 'todo');
    const idx = assistant.blocks.indexOf(tool);
    if (existing) {
      existing.items = items;
      if (idx >= 0) assistant.blocks.splice(idx, 1);
    } else if (idx >= 0) {
      assistant.blocks[idx] = { type: 'todo', id: tool.id, items };
    }
  }

  private forgetStream(block: Block): void {
    for (const [k, b] of this.streamBlocks) {
      if (b === block) {
        this.streamBlocks.delete(k);
        this.partialInputs.delete(k);
      }
    }
  }

  private onToolResult(e: Extract<SessionEvent, { type: 'toolResult' }>): void {
    const found = findToolBlock(this.chat, e.toolUseId);
    if (!found) return; // e.g. a TodoWrite converted to a todo block
    const b = found.block;
    if (b.status !== 'denied') b.status = e.isError ? 'error' : 'done';
    const capped = capOutput(e.content ?? '');
    b.output = capped.output;
    b.outputTruncated = capped.truncated;
    b.endedAt = Date.now();
    b.inputStreaming = false;
    if (b.name === 'Task' && b.subagent) b.subagent = { ...b.subagent, status: e.isError ? 'error' : 'done', summary: b.subagent.summary ?? capped.output.slice(0, 300) };
    this.deps.notify();
  }

  private onPermissionRequest(request: PermissionRequest): void {
    const assistant = this.ensureAssistant();
    this.pendingRequests.set(request.requestId, request);
    let block: Block;
    if (request.kind === 'question') block = { type: 'question', id: request.requestId, questions: request.questions ?? [] };
    else if (request.kind === 'plan') block = { type: 'plan', id: request.requestId, plan: request.plan ?? '' };
    else
      block = {
        type: 'permission',
        id: request.requestId,
        toolUseId: request.toolUseId,
        toolName: request.toolName,
        input: request.input,
        title: request.title,
        description: request.description,
        suggestions: request.suggestions ?? [],
        blockedPath: request.blockedPath,
        decisionReason: request.decisionReason,
      };
    assistant.blocks.push(block);
    this.chat.status = 'waiting';
    this.chat.updatedAt = Date.now();
    this.deps.notify();
    this.deps.onPermissionRequest(request);
  }

  private resolveRequestBlock(requestId: string, behavior: 'allow' | 'deny', uiDecision?: 'allow' | 'deny' | 'always'): void {
    for (const m of this.chat.messages) {
      if (m.kind !== 'assistant') continue;
      for (const b of m.blocks) {
        if (b.id !== requestId) continue;
        if (b.type === 'permission' && !b.decision) b.decision = uiDecision ?? behavior;
        else if (b.type === 'plan' && !b.decision) b.decision = behavior === 'allow' ? 'build' : 'reject';
        else if (b.type === 'question' && !b.answers) b.answers = {};
      }
    }
  }

  private editSummaryFor(e: Extract<SessionEvent, { type: 'fileChanged' }>): EditSummary {
    const live = this.deps.edits.pending(this.chat.id).find((p) => p.path === e.path);
    if (live) return { ...live };
    const stats = lineStats(e.before, e.after);
    return { path: e.path, relPath: relPathOf(e.path), additions: stats.additions, deletions: stats.deletions, isNew: e.before === null, isDeleted: e.after === null, status: 'kept', hunks: 0 };
  }

  private onFileChanged(e: Extract<SessionEvent, { type: 'fileChanged' }>): void {
    try {
      this.deps.edits.recordChange(this.chat.id, { path: e.path, before: e.before, after: e.after, toolUseId: e.toolUseId });
    } catch (err) {
      this.deps.log.error('recordChange failed', err);
    }
    this.chat.pendingEdits = this.deps.edits.pending(this.chat.id);
    const found = findToolBlock(this.chat, e.toolUseId);
    if (found) found.block.edit = this.editSummaryFor(e);
    else {
      // The hook can fire before the assistant block is finalized: create a placeholder tool row.
      const assistant = this.ensureAssistant();
      assistant.blocks.push({ type: 'tool', id: e.toolUseId, name: e.toolName, input: { file_path: e.path }, status: 'running', startedAt: Date.now(), edit: this.editSummaryFor(e) });
    }
    this.deps.notify();
  }

  private onTask(e: Extract<SessionEvent, { type: 'task' }>): void {
    const a = this.assistant;
    if (!a) return;
    let tool: ToolBlock | undefined;
    if (e.toolUseId) tool = findToolBlock(this.chat, e.toolUseId)?.block;
    if (!tool) tool = [...a.blocks].reverse().find((b): b is ToolBlock => b.type === 'tool' && b.name === 'Task' && (b.subagent?.description === e.description || b.status === 'running'));
    if (!tool) return;
    tool.subagent = {
      type: e.subagentType ?? tool.subagent?.type,
      description: e.description || tool.subagent?.description,
      status: e.phase === 'done' ? 'done' : e.lastTool ? `running: ${e.lastTool}` : 'running',
      summary: e.summary ?? tool.subagent?.summary,
    };
    this.deps.notify();
  }

  private finishTurn(result: AssistantMessage['result'] | undefined): void {
    const chat = this.chat;
    const a = this.assistant ?? lastAssistant(chat);
    if (a) {
      a.streaming = false;
      if (result) a.result = result;
      for (const b of a.blocks) {
        if (b.type === 'tool' && b.status === 'running') {
          b.status = result?.isError ? 'error' : 'done';
          b.endedAt = Date.now();
          b.inputStreaming = false;
          if (!b.output && result?.isError) b.output = 'Interrupted';
        }
        if (b.type === 'thinking' && !b.done) {
          b.done = true;
          b.endedAt = Date.now();
        }
      }
    }
    this.assistant = undefined;
    this.streamBlocks.clear();
    this.partialInputs.clear();
    this.confirmed.clear();
    this.subagentMessages.clear();
    chat.status = 'idle';
    chat.updatedAt = Date.now();
    if (this.restartOnIdle) this.disposeSession();
    this.deps.notify();
    this.deps.onTurnEnd();
  }

  private onResult(e: Extract<SessionEvent, { type: 'result' }>): void {
    const chat = this.chat;
    chat.totalCostUsd = (chat.totalCostUsd ?? 0) + (e.costUsd || 0);
    // The bridge updates `session.running` (pending-turn counter, fed by queued_turn_count) before emitting.
    const moreTurns = !!this.session?.running || hasQueuedMessages(chat);
    const interrupted = this.interrupted;
    if (interrupted) {
      this.interrupted = false;
      // Late result of the turn the user stopped (interrupt() already finished it). Keep the cost only —
      // unless the CLI reports nothing pending while we started a new turn, in which case this is the
      // new turn's result (or the UI self-heals on the next streamStart).
      if (!this.running || moreTurns) return;
    }
    const errorText = e.isError && !interrupted ? (e.errors?.join('\n') || e.result || `Turn ended with ${e.subtype}`) : undefined;
    chat.error = errorText;
    if (errorText) chat.messages.push(systemNote(errorText, 'error'));
    this.finishTurn({ costUsd: e.costUsd, durationMs: e.durationMs, numTurns: e.numTurns, isError: !!errorText, errorText });
    if (moreTurns && !this.restartOnIdle) {
      // A queued follow-up is next: stay "running" (its userReplay/streamStart continue the chat).
      chat.status = 'running';
      this.deps.notify();
    }
  }

  dispose(): void {
    this.disposed = true;
    this.disposeSession();
  }
}
