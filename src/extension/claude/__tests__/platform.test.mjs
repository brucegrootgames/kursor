// Platform behaviour of the vscode-free bridge pieces, with platform/env/fs injected so the
// Windows and macOS branches run on Linux. No `claude` process is spawned.
// Run: node --test src/extension/claude/__tests__/platform.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
const tmp = fs.mkdtempSync(path.join(process.env.KURSOR_TEST_TMP || os.tmpdir(), 'kursor-claude-platform-test-'));
let resolvePath, env, status, history, launch;

before(async () => {
  await build({
    entryPoints: [path.join(src, 'resolvePath.ts'), path.join(src, 'env.ts'), path.join(src, 'status.ts'), path.join(src, 'history.ts'), path.join(src, 'launch.ts')],
    outdir: tmp,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
    external: ['@anthropic-ai/claude-agent-sdk'],
  });
  const load = (n) => import(pathToFileURL(path.join(tmp, `${n}.js`)).href);
  [resolvePath, env, status, history, launch] = await Promise.all([load('resolvePath'), load('env'), load('status'), load('history'), load('launch')]);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

const noLog = { debug() {}, info() {}, warn() {}, error() {} };

/** Fake file system + runner for resolveClaudeExecutable. */
function fakeFs({ files = [], runs = {}, contents = {} }) {
  const calls = [];
  const set = new Set(files.map((f) => f.toLowerCase()));
  return {
    calls,
    isExecutable: async (p) => set.has(p.toLowerCase()),
    readFile: async (p) => {
      const c = contents[p] ?? contents[p.toLowerCase()];
      if (c === undefined) throw new Error('ENOENT');
      return c;
    },
    realpath: async (p) => p,
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      const key = (cmd.split(/[\\/]/).pop() ?? cmd).toLowerCase();
      const r = runs[key];
      if (!r) return { stdout: '', stderr: 'not found', code: 1 };
      return typeof r === 'function' ? r(cmd, args) : r;
    },
  };
}

// ---------------------------------------------------------------------------
// resolvePath

test('wellKnownCandidates per platform', () => {
  const win = resolvePath.wellKnownCandidates('win32', 'C:\\Users\\u', { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', APPDATA: 'C:\\Users\\u\\AppData\\Roaming' }).map((c) => c.path);
  assert.equal(win[0], 'C:\\Users\\u\\.local\\bin\\claude.exe');
  assert.ok(win.includes('C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links\\claude.exe'));
  assert.ok(win.includes('C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd'));
  assert.ok(win.every((c) => /\\/.test(c) && !c.includes('/')));
  // LOCALAPPDATA / APPDATA fall back to the usual folders under the profile
  const winNoEnv = resolvePath.wellKnownCandidates('win32', 'C:\\Users\\u', {}).map((c) => c.path);
  assert.ok(winNoEnv.includes('C:\\Users\\u\\AppData\\Local\\Programs\\claude\\claude.exe'));

  const mac = resolvePath.wellKnownCandidates('darwin', '/Users/u', {}).map((c) => c.path);
  assert.deepEqual(mac.slice(0, 3), ['/Users/u/.local/bin/claude', '/opt/homebrew/bin/claude', '/usr/local/bin/claude']);
  assert.ok(mac.includes('/Users/u/.claude/local/claude'));
  assert.ok(mac.includes('/Users/u/.local/share/mise/shims/claude'));

  const linux = resolvePath.wellKnownCandidates('linux', '/home/u', {}).map((c) => c.path);
  assert.equal(linux[0], '/home/u/.local/bin/claude');
  assert.ok(linux.includes('/usr/bin/claude'));
  assert.ok(!linux.includes('/opt/homebrew/bin/claude'));
});

test('loginShellCandidates: $SHELL first, then zsh/bash on macOS', () => {
  assert.deepEqual(resolvePath.loginShellCandidates('darwin', { SHELL: '/opt/homebrew/bin/fish' }), ['/opt/homebrew/bin/fish', '/bin/zsh', '/bin/bash']);
  assert.deepEqual(resolvePath.loginShellCandidates('darwin', {}), ['/bin/zsh', '/bin/bash']);
  assert.deepEqual(resolvePath.loginShellCandidates('linux', { SHELL: '/bin/bash' }), ['/bin/bash', '/bin/sh']);
  assert.deepEqual(resolvePath.loginShellCandidates('linux', { SHELL: '/bin/zsh' }, '/bin/zsh'), ['/bin/zsh', '/bin/sh']);
});

test('parseLoginShellOutput / parseWhereOutput / pickWindowsHit', () => {
  assert.deepEqual(resolvePath.parseLoginShellOutput('warning: profile\n/Users/u/.local/bin/claude\n\n__KURSOR_PATH__/opt/homebrew/bin:/usr/bin\n'), { claude: '/Users/u/.local/bin/claude', path: '/opt/homebrew/bin:/usr/bin' });
  assert.deepEqual(resolvePath.parseLoginShellOutput('\n__KURSOR_PATH__\n'), {});
  const where = 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude\r\nC:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd\r\nC:\\Users\\u\\.local\\bin\\claude.exe\r\n';
  const hits = resolvePath.parseWhereOutput(where);
  assert.equal(hits.length, 3);
  assert.equal(resolvePath.pickWindowsHit(hits), 'C:\\Users\\u\\.local\\bin\\claude.exe');
  assert.equal(resolvePath.pickWindowsHit(hits.slice(0, 2)), 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd');
  assert.equal(resolvePath.pickWindowsHit(hits.slice(0, 1)), undefined);
  assert.deepEqual(resolvePath.parseWhereOutput('INFO: Could not find files for the given pattern(s).\r\n'), []);
});

test('cmdShimTarget unwraps npm cmd shims', () => {
  const shim = [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    ')',
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
  ].join('\r\n');
  assert.equal(resolvePath.cmdShimTarget(shim, 'C:\\Users\\u\\AppData\\Roaming\\npm'), 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js');
  assert.equal(resolvePath.cmdShimTarget('@"%~dp0\\claude.exe" %*', 'D:\\tools'), 'D:\\tools\\claude.exe');
  assert.equal(resolvePath.cmdShimTarget('@echo hello', 'D:\\tools'), undefined);
});

test('pathExeNames honours PATHEXT with .exe first', () => {
  assert.deepEqual(resolvePath.pathExeNames('win32', { PATHEXT: '.COM;.EXE;.BAT;.CMD' }), ['claude.exe', 'claude.com', 'claude.bat', 'claude.cmd']);
  assert.deepEqual(resolvePath.pathExeNames('linux', {}), ['claude']);
});

test('resolve on Windows: where.exe hit, .exe preferred, no login shell spawned', async () => {
  const f = fakeFs({
    files: ['C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd', 'C:\\Users\\u\\.local\\bin\\claude.exe'],
    runs: { 'where.exe': { stdout: 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd\r\nC:\\Users\\u\\.local\\bin\\claude.exe\r\n', stderr: '', code: 0 } },
  });
  const r = await resolvePath.resolveClaudeExecutable({ platform: 'win32', homeDir: 'C:\\Users\\u', env: { SystemRoot: 'C:\\WINDOWS', Path: 'C:\\x' }, log: noLog, ...f });
  assert.deepEqual(r, { path: 'C:\\Users\\u\\.local\\bin\\claude.exe', source: 'where' });
  assert.deepEqual(f.calls, [['C:\\WINDOWS\\System32\\where.exe', 'claude']]);
  assert.equal(r.loginPath, undefined);
});

test('resolve on Windows: only a .cmd shim → unwrapped to its target', async () => {
  const cmd = 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd';
  const target = 'C:\\Users\\u\\AppData\\Roaming\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js';
  const f = fakeFs({ files: [cmd, target], runs: { 'where.exe': { stdout: `${cmd}\r\n`, stderr: '', code: 0 } }, contents: { [cmd]: '"%_prog%" "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*' } });
  const r = await resolvePath.resolveClaudeExecutable({ platform: 'win32', homeDir: 'C:\\Users\\u', env: {}, log: noLog, ...f });
  assert.deepEqual(r, { path: target, source: 'where' });
});

test('resolve on Windows: where fails → well-known native installer path → PATH scan with PATHEXT', async () => {
  const f1 = fakeFs({ files: ['C:\\Users\\u\\.local\\bin\\claude.exe'] });
  const r1 = await resolvePath.resolveClaudeExecutable({ platform: 'win32', homeDir: 'C:\\Users\\u', env: {}, log: noLog, ...f1 });
  assert.deepEqual(r1, { path: 'C:\\Users\\u\\.local\\bin\\claude.exe', source: 'local-bin', loginPath: undefined });

  const f2 = fakeFs({ files: ['D:\\tools\\claude.exe'] });
  const r2 = await resolvePath.resolveClaudeExecutable({ platform: 'win32', homeDir: 'C:\\Users\\u', env: { Path: 'C:\\nothing;D:\\tools', PATHEXT: '.COM;.EXE;.BAT;.CMD' }, log: noLog, ...f2 });
  assert.deepEqual(r2, { path: 'D:\\tools\\claude.exe', source: 'process-path', loginPath: undefined });

  const f3 = fakeFs({ files: [] });
  assert.equal(await resolvePath.resolveClaudeExecutable({ platform: 'win32', homeDir: 'C:\\Users\\u', env: {}, log: noLog, ...f3 }), undefined);
});

test('resolve on macOS: $SHELL zsh answers with -l -i -c, loginPath captured', async () => {
  resolvePath.clearLoginShellCache();
  const f = fakeFs({
    files: ['/bin/zsh', '/opt/homebrew/bin/claude'],
    runs: { zsh: { stdout: '/opt/homebrew/bin/claude\n__KURSOR_PATH__/opt/homebrew/bin:/usr/bin:/bin\n', stderr: '', code: 0 } },
  });
  const r = await resolvePath.resolveClaudeExecutable({ platform: 'darwin', homeDir: '/Users/u', env: { SHELL: '/bin/zsh', PATH: '/usr/bin' }, log: noLog, ...f });
  assert.deepEqual(r, { path: '/opt/homebrew/bin/claude', source: 'login-shell', loginPath: '/opt/homebrew/bin:/usr/bin:/bin' });
  assert.deepEqual(f.calls[0].slice(0, 4), ['/bin/zsh', '-l', '-i', '-c']);
});

test('resolve on macOS: missing $SHELL falls back to /bin/zsh then /bin/bash, then Homebrew path', async () => {
  resolvePath.clearLoginShellCache();
  const f = fakeFs({ files: ['/bin/bash', '/opt/homebrew/bin/claude'], runs: { bash: { stdout: '\n__KURSOR_PATH__/usr/bin\n', stderr: '', code: 0 } } });
  const r = await resolvePath.resolveClaudeExecutable({ platform: 'darwin', homeDir: '/Users/u', env: { SHELL: '/opt/homebrew/bin/fish', PATH: '/usr/bin' }, log: noLog, ...f });
  assert.deepEqual(r, { path: '/opt/homebrew/bin/claude', source: 'well-known', loginPath: '/usr/bin' });
  // fish and zsh do not exist in this fake fs: only bash was asked
  assert.deepEqual(f.calls.map((c) => c[0]), ['/bin/bash']);
});

test('resolve on Linux: setting wins; ~ expanded', async () => {
  const f = fakeFs({ files: ['/home/u/bin/claude'] });
  const r = await resolvePath.resolveClaudeExecutable({ platform: 'linux', homeDir: '/home/u', configuredPath: '~/bin/claude', env: {}, log: noLog, ...f });
  assert.deepEqual(r, { path: '/home/u/bin/claude', source: 'setting' });
  assert.deepEqual(f.calls, []);
});

// ---------------------------------------------------------------------------
// env

test('buildChildEnv: login PATH merged on POSIX with ":" and skipped on Windows', () => {
  const posix = env.buildChildEnv({ platform: 'linux', base: { PATH: '/usr/bin:/bin', CLAUDECODE: '1', ELECTRON_RUN_AS_NODE: '1' }, loginPath: '/home/u/.local/bin:/usr/bin' });
  assert.equal(posix.PATH, '/home/u/.local/bin:/usr/bin:/bin');
  assert.equal(posix.CLAUDECODE, undefined);
  assert.equal(posix.ELECTRON_RUN_AS_NODE, undefined);
  assert.equal(posix.CLAUDE_CODE_ENTRYPOINT, 'sdk-ts');

  const win = env.buildChildEnv({ platform: 'win32', base: { Path: 'C:\\Windows;C:\\x' }, loginPath: '/should/not/apply' });
  assert.equal(win.Path, 'C:\\Windows;C:\\x');
  assert.equal(win.PATH, undefined, 'must not introduce a second PATH key');
  assert.equal(env.mergePath('C:\\a', 'c:\\A;C:\\b', 'win32'), 'C:\\a;C:\\b');
});

// ---------------------------------------------------------------------------
// status

test('spawnSpec: native binary direct, .cmd via cmd.exe, .js via node', () => {
  assert.deepEqual(status.spawnSpec('/home/u/.local/bin/claude', ['--version'], {}, 'linux'), { command: '/home/u/.local/bin/claude', args: ['--version'] });
  assert.deepEqual(status.spawnSpec('C:\\Users\\u\\.local\\bin\\claude.exe', ['--version'], {}, 'win32'), { command: 'C:\\Users\\u\\.local\\bin\\claude.exe', args: ['--version'] });
  const cmd = status.spawnSpec('C:\\npm\\claude.cmd', ['auth', 'status', '--json'], { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }, 'win32');
  assert.equal(cmd.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(cmd.args, ['/d', '/s', '/c', '"C:\\npm\\claude.cmd auth status --json"']);
  assert.deepEqual(status.spawnSpec('C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js', ['--version'], {}, 'win32'), { command: 'node', args: ['C:\\npm\\node_modules\\@anthropic-ai\\claude-code\\cli.js', '--version'] });
  // a .cmd on Linux is just a file name
  assert.equal(status.spawnSpec('/x/claude.cmd', [], {}, 'linux').command, '/x/claude.cmd');
});

test('probeClaudeStatus routes through spawnSpec and parses CRLF output', async () => {
  const calls = [];
  const exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    if (args.join(' ').includes('--version')) return { stdout: '2.1.263 (Claude Code)\r\n', stderr: '', code: 0 };
    return { stdout: '{"loggedIn":true,"email":"a@b.c","subscriptionType":"max"}\r\n', stderr: '', code: 0 };
  };
  const s = await status.probeClaudeStatus('C:\\npm\\claude.cmd', { ComSpec: 'cmd.exe' }, { platform: 'win32', exec });
  assert.deepEqual(s, { ok: true, path: 'C:\\npm\\claude.cmd', version: '2.1.263', loggedIn: true, email: 'a@b.c', subscriptionType: 'Max' });
  assert.equal(calls[0][0], 'cmd.exe');
  assert.equal(calls[0][1], '/d');

  const einval = Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' });
  const bad = await status.probeClaudeStatus('C:\\x\\claude.exe', {}, { platform: 'win32', exec: async () => ({ stdout: '', stderr: '', code: null, error: einval }) });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /cannot be spawned directly/);
});

// ---------------------------------------------------------------------------
// history

test('projectKey matches the CLI: non-alphanumerics → "-", 200-char cap + base36 hash', () => {
  assert.equal(history.projectKey('/home/u/Work/kursor'), '-home-u-Work-kursor');
  assert.equal(history.projectKey('C:\\Users\\u\\proj'), 'C--Users-u-proj');
  assert.equal(history.projectKey('/Users/u/My Project (v2)'), '-Users-u-My-Project--v2-');
  const long = '/' + 'a'.repeat(250);
  const key = history.projectKey(long);
  assert.equal(key.length, 200 + 1 + history.projectKeyHash(long).length);
  assert.ok(key.startsWith('-' + 'a'.repeat(199) + '-'));
  // Same hash function as the CLI: (h << 5) - h + c | 0, abs, base 36
  assert.equal(history.projectKeyHash('abc'), (Math.abs((((0 << 5) - 0 + 97) << 5) - (((0 << 5) - 0 + 97)) + 98) * 31 + 99 | 0).toString(36));
});

test('canonicalCwd: absolute + realpath, NFC only on macOS', () => {
  const decomposed = 'Cafe\u0301';
  assert.equal(history.canonicalCwd('/tmp/' + decomposed, 'darwin'), '/tmp/Caf\u00e9');
  assert.equal(history.canonicalCwd('/tmp/' + decomposed, 'linux'), '/tmp/' + decomposed);
  assert.equal(history.canonicalCwd('.', 'linux'), fs.realpathSync(process.cwd()));
});

test('claudeConfigDir honours CLAUDE_CONFIG_DIR with ~ and falls back to <home>/.claude', () => {
  assert.equal(history.claudeConfigDir({}, '/home/u'), path.join('/home/u', '.claude'));
  assert.equal(history.claudeConfigDir({ CLAUDE_CONFIG_DIR: '~/cfg' }, '/home/u'), path.resolve('/home/u/cfg'));
  assert.equal(history.claudeConfigDir({ CLAUDE_CONFIG_DIR: '/opt/cfg' }, '/home/u'), '/opt/cfg');
});

// ---------------------------------------------------------------------------
// launch (sign-in terminal)

test('terminalLaunchSpec: binary direct, .cmd through ComSpec, .js through node', () => {
  assert.deepEqual(launch.terminalLaunchSpec('/Users/u/.local/bin/claude', ['auth', 'login'], 'darwin', {}), { shellPath: '/Users/u/.local/bin/claude', shellArgs: ['auth', 'login'] });
  assert.deepEqual(launch.terminalLaunchSpec('C:\\Users\\u\\.local\\bin\\claude.exe', ['auth', 'login'], 'win32', {}), { shellPath: 'C:\\Users\\u\\.local\\bin\\claude.exe', shellArgs: ['auth', 'login'] });
  assert.deepEqual(launch.terminalLaunchSpec('C:\\npm\\claude.cmd', ['auth', 'login'], 'win32', { ComSpec: 'C:\\Windows\\System32\\cmd.exe' }), { shellPath: 'C:\\Windows\\System32\\cmd.exe', shellArgs: ['/d', '/c', 'C:\\npm\\claude.cmd', 'auth', 'login'] });
  assert.deepEqual(launch.terminalLaunchSpec('C:\\npm\\cli.js', ['auth', 'login'], 'win32', {}), { shellPath: 'node', shellArgs: ['C:\\npm\\cli.js', 'auth', 'login'] });
});
