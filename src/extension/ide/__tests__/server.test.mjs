// End-to-end test of IdeServer against a mocked `vscode`: lock file, auth, MCP handshake, tools, notifications.
// Run: node --test src/extension/ide/__tests__/server.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { JSONRPCMessageSchema } from '@modelcontextprotocol/sdk/types.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
// The bundle keeps `ws`/the MCP SDK external, so it must live under the repo for Node to resolve them.
const repoRoot = path.resolve(here, '..', '..', '..', '..');
fs.mkdirSync(path.join(repoRoot, 'node_modules', '.cache'), { recursive: true });
const tmpRoot = fs.mkdtempSync(path.join(repoRoot, 'node_modules', '.cache', 'kursor-ide-server-test-'));
const lockRoot = fs.mkdtempSync(path.join(process.env.KURSOR_TEST_TMP || os.tmpdir(), 'kursor-ide-lock-'));
const mockPath = path.join(here, 'vscode-mock.mjs');

const logLines = [];
const log = {
  info: (m, ...a) => logLines.push(`[info] ${m} ${a.join(' ')}`),
  warn: (m, ...a) => logLines.push(`[warn] ${m} ${a.join(' ')}`),
  error: (m, ...a) => logLines.push(`[error] ${m} ${a.join(' ')}`),
  debug: (m, ...a) => logLines.push(`[debug] ${m} ${a.join(' ')}`),
  show: () => undefined,
  child: () => log,
};

/** Client-side MCP transport over `ws` with custom headers (the CLI's `ws-ide` transport). */
class WsClientTransport {
  constructor(url, headers) { this.url = url; this.headers = headers; this.closed = false; }
  async start() {
    this.ws = new WebSocket(this.url, ['mcp'], { headers: this.headers });
    await new Promise((resolve, reject) => { this.ws.once('open', resolve); this.ws.once('error', reject); this.ws.once('unexpected-response', (_r, res) => reject(new Error(`HTTP ${res.statusCode}`))); });
    this.ws.on('message', (d) => this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(d.toString()))));
    this.ws.on('close', () => { if (!this.closed) { this.closed = true; this.onclose?.(); } });
    this.ws.on('error', (e) => this.onerror?.(e));
  }
  async send(m) { await new Promise((res, rej) => this.ws.send(JSON.stringify(m), (e) => (e ? rej(e) : res()))); }
  async close() { this.ws?.close(); }
}

let vscode; let serverMod; let server; let envCollection; let lockDir;

before(async () => {
  await build({
    entryPoints: [path.join(src, 'server.ts')],
    outfile: path.join(tmpRoot, 'server.mjs'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
    external: ['ws', '@modelcontextprotocol/sdk/*', 'zod'],
    plugins: [{ name: 'vscode-mock', setup(b) { b.onResolve({ filter: /^vscode$/ }, () => ({ path: mockPath, external: true })); } }],
  });
  vscode = await import(pathToFileURL(mockPath).href);
  serverMod = await import(pathToFileURL(path.join(tmpRoot, 'server.mjs')).href);
  lockDir = path.join(lockRoot, 'cfg', 'ide');
  envCollection = new vscode.EnvCollection();
  const host = {
    openDiff: async (args) => ({ kind: 'saved', contents: `${args.newFileContents}!` }),
    closeTab: async () => true,
    closeAllDiffTabs: async () => 2,
    latestSelection: () => ({ text: 'sel', filePath: '/tmp/proj/a.ts', fileUrl: 'file:///tmp/proj/a.ts', selection: { start: { line: 1, character: 0 }, end: { line: 1, character: 3 }, isEmpty: false } }),
  };
  server = new serverMod.IdeServer(log, { ideName: 'Kursor (mock)', version: '0.1.0-test', workspaceFolders: () => vscode.state.workspaceFolders.map((f) => f.uri.fsPath), env: envCollection, lockDir }, host);
});

after(async () => {
  await server?.stop('test end');
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.rmSync(lockRoot, { recursive: true, force: true });
});

let port; let token;

test('start: random loopback port, lock file, terminal env', async () => {
  port = await server.start();
  assert.ok(port >= 10000 && port <= 65535);
  assert.equal(server.isRunning, true);
  assert.equal(envCollection.get('CLAUDE_CODE_SSE_PORT').value, String(port));
  assert.equal(envCollection.get('CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL').value, 'true');
  assert.equal(envCollection.persistent, false);
  const lock = JSON.parse(fs.readFileSync(path.join(lockDir, `${port}.lock`), 'utf8'));
  assert.deepEqual(Object.keys(lock), ['pid', 'workspaceFolders', 'ideName', 'transport', 'runningInWindows', 'authToken']);
  assert.equal(lock.pid, process.ppid);
  assert.deepEqual(lock.workspaceFolders, ['/tmp/proj']);
  assert.equal(lock.ideName, 'Kursor (mock)');
  assert.equal(lock.transport, 'ws');
  assert.match(lock.authToken, /^[0-9a-f-]{36}$/);
  token = lock.authToken;
  assert.equal(await server.start(), port, 'start is idempotent');
});

test('lock file is rewritten when workspace folders change', () => {
  vscode.state.workspaceFolders = [...vscode.state.workspaceFolders, { name: 'other', uri: vscode.Uri.file('/tmp/other'), index: 1 }];
  vscode.workspace.fireFoldersChanged();
  const lock = JSON.parse(fs.readFileSync(path.join(lockDir, `${port}.lock`), 'utf8'));
  assert.deepEqual(lock.workspaceFolders, ['/tmp/proj', '/tmp/other']);
  assert.equal(lock.authToken, token, 'token is stable across rewrites');
});

test('upgrade without/with wrong auth header is refused with 401', async () => {
  for (const headers of [{}, { 'x-claude-code-ide-authorization': 'nope' }]) {
    const t = new WsClientTransport(`ws://127.0.0.1:${port}`, headers);
    await assert.rejects(t.start(), /HTTP 401/);
  }
  assert.equal(server.isConnected, false);
});

test('plain HTTP requests get 404', async () => {
  const res = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(res.status, 404);
});

test('MCP handshake, tools/list, tool calls and notifications', async () => {
  const connected = new Promise((resolve) => { const d = server.onDidChangeClient((c) => { if (c) { d.dispose(); resolve(c); } }); });
  const client = new Client({ name: 'claude-test', version: '9.9.9' });
  const received = [];
  client.fallbackNotificationHandler = async (n) => { received.push(n); };
  const transport = new WsClientTransport(`ws://127.0.0.1:${port}`, { 'x-claude-code-ide-authorization': token });
  await client.connect(transport);
  assert.equal(transport.ws.protocol, 'mcp', 'server echoes the mcp subprotocol');
  const c = await connected;
  assert.equal(server.isConnected, true);
  assert.equal(c.clientName, 'claude-test');
  assert.equal(client.getServerVersion().name, 'Kursor IDE');

  await client.notification({ method: 'ide_connected', params: { pid: 777 } });
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(c.remotePid, 777);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  assert.deepEqual(names, ['checkDocumentDirty', 'closeAllDiffTabs', 'close_tab', 'getCurrentSelection', 'getDiagnostics', 'getLatestSelection', 'getOpenEditors', 'getWorkspaceFolders', 'openDiff', 'openFile', 'saveDocument'].sort());
  const openDiff = tools.find((t) => t.name === 'openDiff');
  assert.deepEqual(openDiff.inputSchema.required.sort(), ['new_file_contents', 'new_file_path', 'old_file_path', 'tab_name']);
  const openFile = tools.find((t) => t.name === 'openFile');
  assert.deepEqual(openFile.inputSchema.required, ['filePath']);
  assert.equal(openFile.annotations.readOnlyHint, true);

  const folders = await client.callTool({ name: 'getWorkspaceFolders', arguments: {} });
  const parsed = JSON.parse(folders.content[0].text);
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.folders.map((f) => f.path), ['/tmp/proj', '/tmp/other']);
  assert.equal(parsed.rootPath, '/tmp/proj');

  const diff = await client.callTool({ name: 'openDiff', arguments: { old_file_path: 'a.ts', new_file_path: 'a.ts', new_file_contents: 'x', tab_name: 'a.ts' } });
  assert.deepEqual(diff.content, [{ type: 'text', text: 'FILE_SAVED' }, { type: 'text', text: 'x!' }]);

  const closed = await client.callTool({ name: 'closeAllDiffTabs', arguments: {} });
  assert.deepEqual(closed.content, [{ type: 'text', text: 'CLOSED_2_DIFF_TABS' }]);
  const tab = await client.callTool({ name: 'close_tab', arguments: { tab_name: 'a.ts' } });
  assert.deepEqual(tab.content, [{ type: 'text', text: 'TAB_CLOSED' }]);

  const latest = JSON.parse((await client.callTool({ name: 'getLatestSelection', arguments: {} })).content[0].text);
  assert.equal(latest.success, true);
  assert.equal(latest.text, 'sel');
  const current = JSON.parse((await client.callTool({ name: 'getCurrentSelection', arguments: {} })).content[0].text);
  assert.deepEqual(current, { success: false, message: 'No active editor found' });

  vscode.state.diagnostics = [[vscode.Uri.file('/tmp/proj/a.ts'), [{ message: 'boom', severity: 0, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }, source: 'ts', code: 1234 }]]];
  const diags = JSON.parse((await client.callTool({ name: 'getDiagnostics', arguments: {} })).content[0].text);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].uri, 'file:///tmp/proj/a.ts');
  assert.deepEqual(diags[0].diagnostics[0], { message: 'boom', severity: 'Error', range: { start: { line: 1, character: 2 }, end: { line: 1, character: 5 } }, source: 'ts', code: '1234' });

  const dirty = JSON.parse((await client.callTool({ name: 'checkDocumentDirty', arguments: { filePath: 'missing.ts' } })).content[0].text);
  assert.deepEqual(dirty, { success: false, message: 'Document not open: /tmp/proj/missing.ts' });

  const bad = await client.callTool({ name: 'openFile', arguments: { filePath: '' } });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /File path is required/);

  await server.notify('selection_changed', { text: 'hello', filePath: '/tmp/proj/a.ts' });
  await server.notify('at_mentioned', { filePath: '/tmp/proj/a.ts', lineStart: 3, lineEnd: 5 });
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(received.map((n) => n.method), ['selection_changed', 'at_mentioned']);
  assert.deepEqual(received[1].params, { filePath: '/tmp/proj/a.ts', lineStart: 3, lineEnd: 5 });

  // A second client replaces the first (one client at a time).
  const lostFirst = new Promise((resolve) => transport.ws.once('close', (code) => resolve(code)));
  const client2 = new Client({ name: 'claude-test-2', version: '1.0.0' });
  const transport2 = new WsClientTransport(`ws://127.0.0.1:${port}`, { 'x-claude-code-ide-authorization': token });
  await client2.connect(transport2);
  assert.equal(await lostFirst, 1000);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(server.currentClient?.clientName, 'claude-test-2');
  const ping = await client2.callTool({ name: 'closeAllDiffTabs', arguments: {} });
  assert.equal(ping.content[0].text, 'CLOSED_2_DIFF_TABS');

  const gone = new Promise((resolve) => { const d = server.onDidChangeClient((c) => { if (!c) { d.dispose(); resolve(); } }); });
  await client2.close();
  await gone;
  assert.equal(server.isConnected, false);
  assert.equal(await server.notify('selection_changed', { text: '' }), undefined, 'notify is a no-op without a client');
});

test('stop: lock file removed, env cleared, port released', async () => {
  await server.stop('test');
  assert.equal(server.isRunning, false);
  assert.ok(!fs.existsSync(path.join(lockDir, `${port}.lock`)));
  assert.equal(envCollection.get('CLAUDE_CODE_SSE_PORT'), undefined);
  assert.equal(envCollection.get('CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL'), undefined);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
  const again = await server.start();
  assert.ok(again >= 10000);
  await server.stop('test');
});
