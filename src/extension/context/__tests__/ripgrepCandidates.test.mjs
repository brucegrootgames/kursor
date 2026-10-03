// Run: node --test src/extension/context/__tests__/ripgrepCandidates.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(process.env.KURSOR_TEST_TMP || os.tmpdir(), 'kursor-rg-test-'));
let m;

before(async () => {
  await build({ entryPoints: [path.join(here, '..', 'ripgrepCandidates.ts')], outdir: tmp, bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'silent' });
  m = await import(pathToFileURL(path.join(tmp, 'ripgrepCandidates.js')).href);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('Linux: editor bundle (ripgrep-universal in asar.unpacked) first, then PATH, then system dirs', () => {
  const c = m.ripgrepCandidates({ appRoot: '/opt/kursor/resources/app', platform: 'linux', arch: 'x64', env: { PATH: '/usr/local/bin:/home/u/.cargo/bin' }, home: '/home/u' });
  assert.equal(c[0], '/opt/kursor/resources/app/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/linux-x64/rg');
  assert.equal(c[1], '/opt/kursor/resources/app/node_modules/@vscode/ripgrep-universal/bin/linux-x64/rg');
  assert.equal(c[2], '/opt/kursor/resources/app/node_modules.asar.unpacked/@vscode/ripgrep/bin/rg');
  assert.equal(c[3], '/opt/kursor/resources/app/node_modules/@vscode/ripgrep/bin/rg');
  assert.equal(c[4], '/usr/local/bin/rg');
  assert.ok(c.includes('/usr/bin/rg'));
  assert.ok(c.includes('/home/u/.local/bin/rg'));
  assert.ok(!c.includes('/opt/homebrew/bin/rg'));
  assert.equal(new Set(c).size, c.length, 'no duplicates');
});

test('macOS arm64: darwin-arm64 binary and Homebrew', () => {
  const c = m.ripgrepCandidates({ appRoot: '/Applications/Kursor.app/Contents/Resources/app', platform: 'darwin', arch: 'arm64', env: {}, home: '/Users/u' });
  assert.equal(c[0], '/Applications/Kursor.app/Contents/Resources/app/node_modules.asar.unpacked/@vscode/ripgrep-universal/bin/darwin-arm64/rg');
  assert.ok(c.includes('/opt/homebrew/bin/rg'));
  assert.ok(c.includes('/usr/local/bin/rg'));
});

test('Windows: rg.exe, backslashes, PATH split on ";" (case-insensitive key), scoop/winget/git', () => {
  const c = m.ripgrepCandidates({
    appRoot: 'C:\\Users\\u\\AppData\\Local\\Programs\\Kursor\\resources\\app',
    platform: 'win32',
    arch: 'x64',
    env: { Path: 'C:\\Windows\\System32;C:\\tools', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', ProgramFiles: 'C:\\Program Files' },
    home: 'C:\\Users\\u',
  });
  assert.equal(c[0], 'C:\\Users\\u\\AppData\\Local\\Programs\\Kursor\\resources\\app\\node_modules.asar.unpacked\\@vscode\\ripgrep-universal\\bin\\win32-x64\\rg.exe');
  assert.ok(c.includes('C:\\tools\\rg.exe'));
  assert.ok(c.includes('C:\\Users\\u\\scoop\\shims\\rg.exe'));
  assert.ok(c.includes('C:\\Users\\u\\AppData\\Local\\Microsoft\\WinGet\\Links\\rg.exe'));
  assert.ok(c.includes('C:\\Program Files\\Git\\usr\\bin\\rg.exe'));
  assert.ok(c.every((p) => p.endsWith('rg.exe')));
  assert.ok(c.every((p) => !p.startsWith('/')));
});
