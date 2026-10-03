// Unit tests for the vscode-free parts of the IDE bridge (lock file contract, port probing).
// Run: node --test src/extension/ide/__tests__/pure.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
const tmpRoot = fs.mkdtempSync(path.join(process.env.KURSOR_TEST_TMP || os.tmpdir(), 'kursor-ide-test-'));

let lockFile;
let port;

before(async () => {
  await build({
    entryPoints: [path.join(src, 'lockFile.ts'), path.join(src, 'port.ts')],
    outdir: tmpRoot,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
  });
  lockFile = await import(pathToFileURL(path.join(tmpRoot, 'lockFile.js')).href);
  port = await import(pathToFileURL(path.join(tmpRoot, 'port.js')).href);
});

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

test('claudeConfigDir honours CLAUDE_CONFIG_DIR and ~ expansion', () => {
  assert.equal(lockFile.claudeConfigDir({}, '/home/u'), path.join('/home/u', '.claude'));
  assert.equal(lockFile.claudeConfigDir({ CLAUDE_CONFIG_DIR: '/opt/cfg' }, '/home/u'), '/opt/cfg');
  assert.equal(lockFile.claudeConfigDir({ CLAUDE_CONFIG_DIR: '~/cfg' }, '/home/u'), path.join('/home/u', 'cfg'));
  assert.equal(lockFile.claudeConfigDir({ CLAUDE_CONFIG_DIR: '   ' }, '/home/u'), path.join('/home/u', '.claude'));
  assert.equal(lockFile.ideLockDir({}, '/home/u'), path.join('/home/u', '.claude', 'ide'));
});

test('buildLockPayload has exactly the fields the CLI parses', () => {
  const payload = lockFile.buildLockPayload({ workspaceFolders: ['/w/a', '/w/b'], ideName: 'Kursor', authToken: 'tok', pid: 4242, platform: 'linux' });
  assert.deepEqual(payload, { pid: 4242, workspaceFolders: ['/w/a', '/w/b'], ideName: 'Kursor', transport: 'ws', runningInWindows: false, authToken: 'tok' });
  assert.deepEqual(Object.keys(payload), ['pid', 'workspaceFolders', 'ideName', 'transport', 'runningInWindows', 'authToken']);
  assert.equal(lockFile.buildLockPayload({ workspaceFolders: [], ideName: 'K', authToken: 't', platform: 'win32' }).runningInWindows, true);
  assert.equal(lockFile.buildLockPayload({ workspaceFolders: [], ideName: 'K', authToken: 't' }).pid, process.ppid);
  assert.ok(lockFile.isLockFilePayload(payload));
  assert.ok(!lockFile.isLockFilePayload({ ...payload, transport: 'sse' }));
  assert.ok(!lockFile.isLockFilePayload({ ...payload, workspaceFolders: [1] }));
  assert.ok(!lockFile.isLockFilePayload(null));
});

test('lock file naming round-trips the port', () => {
  assert.equal(lockFile.lockFilePath('/x/ide', 12345), path.join('/x/ide', '12345.lock'));
  assert.equal(lockFile.portFromLockFile('/x/ide/12345.lock'), 12345);
  assert.equal(lockFile.portFromLockFile('/x/ide/12345.lock.tmp'), undefined);
  assert.equal(lockFile.portFromLockFile('/x/ide/abc.lock'), undefined);
});

test('writeLockFile creates a 0700 dir and a 0600 JSON file; delete is idempotent', () => {
  const dir = path.join(tmpRoot, 'cfg', 'ide');
  const payload = lockFile.buildLockPayload({ workspaceFolders: ['/w'], ideName: 'Kursor', authToken: 'secret', pid: 1, platform: 'linux' });
  const file = lockFile.writeLockFile(dir, 23456, payload);
  assert.equal(file, path.join(dir, '23456.lock'));
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), payload);
  assert.deepEqual(lockFile.readLockFile(file), payload);
  assert.deepEqual(fs.readdirSync(dir), ['23456.lock'], 'no temp files left behind');

  // rewrite (workspace folders changed) keeps a single file with new content
  lockFile.writeLockFile(dir, 23456, { ...payload, workspaceFolders: ['/w', '/v'] });
  assert.deepEqual(lockFile.readLockFile(file).workspaceFolders, ['/w', '/v']);
  assert.deepEqual(fs.readdirSync(dir), ['23456.lock']);

  lockFile.deleteLockFile(dir, 23456);
  assert.ok(!fs.existsSync(file));
  lockFile.deleteLockFile(dir, 23456); // no throw on ENOENT
  fs.writeFileSync(file, 'not json');
  assert.equal(lockFile.readLockFile(file), undefined);
});

test('randomPort stays within 10000-65535', () => {
  assert.equal(port.randomPort(() => 0), 10000);
  assert.equal(port.randomPort(() => 0.999999999), 65535);
  assert.equal(port.randomPort(() => 1), 65535);
  for (let i = 0; i < 1000; i++) {
    const p = port.randomPort();
    assert.ok(p >= 10000 && p <= 65535 && Number.isInteger(p), `port ${p}`);
  }
});

test('findFreePort skips busy candidates and gives up after N attempts', async () => {
  const seen = [];
  const values = [0.1, 0.1, 0.2, 0.3];
  let i = 0;
  const chosen = await port.findFreePort({
    random: () => values[i++ % values.length],
    isFree: async (p) => {
      seen.push(p);
      return seen.length >= 3;
    },
  });
  assert.equal(seen.length, 3, 'duplicate candidate is not re-probed');
  assert.equal(chosen, seen[2]);
  await assert.rejects(port.findFreePort({ attempts: 3, isFree: async () => false }), /No free port/);
});

test('isPortFree detects an occupied loopback port', async () => {
  const blocker = net.createServer();
  await new Promise((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const busy = blocker.address().port;
  assert.equal(await port.isPortFree(busy), false);
  await new Promise((resolve) => blocker.close(resolve));
  assert.equal(await port.isPortFree(busy), true);
});

test('isLoopbackAddress', () => {
  assert.ok(port.isLoopbackAddress('127.0.0.1'));
  assert.ok(port.isLoopbackAddress('::1'));
  assert.ok(port.isLoopbackAddress('::ffff:127.0.0.1'));
  assert.ok(!port.isLoopbackAddress('10.0.0.1'));
  assert.ok(!port.isLoopbackAddress(undefined));
});
