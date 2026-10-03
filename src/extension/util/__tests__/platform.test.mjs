// Unit tests for util/platform.ts (platform injected; runs on Linux).
// Run: node --test src/extension/util/__tests__/platform.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(process.env.KURSOR_TEST_TMP || os.tmpdir(), 'kursor-platform-test-'));
let p;

before(async () => {
  await build({ entryPoints: [path.join(here, '..', 'platform.ts')], outdir: tmp, bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'silent' });
  p = await import(pathToFileURL(path.join(tmp, 'platform.js')).href);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('exeName / pathDelimiter per platform', () => {
  assert.equal(p.exeName('claude', 'win32'), 'claude.exe');
  assert.equal(p.exeName('claude', 'darwin'), 'claude');
  assert.equal(p.exeName('rg', 'linux'), 'rg');
  assert.equal(p.pathDelimiter('win32'), ';');
  assert.equal(p.pathDelimiter('linux'), ':');
});

test('envKey is case-insensitive on Windows only', () => {
  const env = { Path: 'C:\\a;C:\\b', Home: 'x' };
  assert.equal(p.envKey(env, 'PATH', 'win32'), 'Path');
  assert.equal(p.getEnv(env, 'PATH', 'win32'), 'C:\\a;C:\\b');
  assert.equal(p.envKey(env, 'PATH', 'linux'), 'PATH');
  assert.equal(p.getEnv(env, 'PATH', 'linux'), undefined);
  p.setEnv(env, 'PATH', 'C:\\z', 'win32');
  assert.deepEqual(Object.keys(env), ['Path', 'Home']);
  assert.equal(env.Path, 'C:\\z');
  assert.deepEqual(p.pathEntries({ Path: 'C:\\a;;C:\\b' }, 'win32'), ['C:\\a', 'C:\\b']);
  assert.deepEqual(p.pathEntries({ PATH: '/usr/bin::/bin' }, 'linux'), ['/usr/bin', '/bin']);
});

test('mergePathList dedupes (case-insensitively on Windows) and keeps order', () => {
  assert.equal(p.mergePathList('/a:/b', '/b:/c', 'linux'), '/a:/b:/c');
  assert.equal(p.mergePathList('/a:/A', '/a', 'linux'), '/a:/A');
  assert.equal(p.mergePathList('C:\\x;C:\\y', 'c:\\X;D:\\z', 'win32'), 'C:\\x;C:\\y;D:\\z');
});

test('executableExtensions from PATHEXT', () => {
  assert.deepEqual(p.executableExtensions({ PATHEXT: '.COM;.EXE;.BAT;.CMD;.PS1' }, 'win32'), ['.com', '.exe', '.bat', '.cmd', '.ps1']);
  assert.deepEqual(p.executableExtensions({}, 'win32'), ['.com', '.exe', '.bat', '.cmd']);
  assert.deepEqual(p.executableExtensions({}, 'linux'), ['']);
});

test('isWindowsScript and cmd.exe invocation quoting', () => {
  assert.equal(p.isWindowsScript('C:\\Users\\me\\AppData\\Roaming\\npm\\claude.CMD'), true);
  assert.equal(p.isWindowsScript('C:\\x\\claude.exe'), false);
  assert.equal(p.isWindowsScript('/usr/bin/claude'), false);
  const inv = p.cmdExeInvocation('C:\\Program Files\\x\\claude.cmd', ['auth', 'status', '--json'], { ComSpec: 'C:\\Windows\\System32\\cmd.exe' });
  assert.equal(inv.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(inv.args, ['/d', '/s', '/c', '""C:\\Program Files\\x\\claude.cmd" auth status --json"']);
  assert.equal(p.cmdExeInvocation('c.cmd', [], {}).command, 'cmd.exe');
  assert.equal(p.quoteForCmd('say "hi"'), '"say ""hi"""');
  assert.equal(p.quoteForCmd('plain'), 'plain');
  assert.equal(p.quoteForCmd(''), '""');
});

test('expandHome handles ~, ~/ and ~\\ (Windows)', () => {
  assert.equal(p.expandHome('~', '/home/u', 'linux'), '/home/u');
  assert.equal(p.expandHome('~/bin/claude', '/home/u', 'linux'), '/home/u/bin/claude');
  assert.equal(p.expandHome('~\\bin\\claude.exe', 'C:\\Users\\u', 'win32'), 'C:\\Users\\u\\bin\\claude.exe');
  assert.equal(p.expandHome('~/bin', 'C:\\Users\\u', 'win32'), 'C:\\Users\\u\\bin');
  assert.equal(p.expandHome('~\\x', '/home/u', 'linux'), '~\\x');
  assert.equal(p.expandHome('/abs', '/home/u', 'linux'), '/abs');
});

test('tildify', () => {
  assert.equal(p.tildify('/home/u/proj', '/home/u', 'linux'), '~/proj');
  assert.equal(p.tildify('/home/u', '/home/u', 'linux'), '~');
  assert.equal(p.tildify('/home/user2/proj', '/home/u', 'linux'), '/home/user2/proj');
  assert.equal(p.tildify('c:\\users\\U\\proj', 'C:\\Users\\u', 'win32'), '~\\proj');
  assert.equal(p.tildify('/Users/u/proj', '/Users/u/', 'darwin'), '~/proj');
  assert.equal(p.tildify('/x', '', 'linux'), '/x');
});

test('comparablePath / samePath / isInside', () => {
  assert.equal(p.samePath('C:\\Users\\u\\a.ts', 'c:/users/U/a.ts', 'win32'), true);
  assert.equal(p.samePath('/a/b', '/a/B', 'linux'), false);
  assert.equal(p.samePath('/a/b/', '/a/b', 'linux'), true);
  assert.equal(p.samePath('/a/./b/../c', '/a/c', 'linux'), true);
  assert.equal(p.isInside('C:\\Proj\\src\\x.ts', 'c:\\proj', 'win32'), true);
  assert.equal(p.isInside('C:\\Projects\\x.ts', 'C:\\Proj', 'win32'), false);
  assert.equal(p.isInside('/home/u/proj/a', '/home/u/proj', 'linux'), true);
  assert.equal(p.isInside('/home/u/proj', '/home/u/proj', 'linux'), true);
  assert.equal(p.isInside('/home/u/project', '/home/u/proj', 'linux'), false);
  assert.equal(p.comparablePath('C:\\', 'win32'), 'c:\\');
});

test('toPosixRelative / toSlashes only touch Windows paths', () => {
  assert.equal(p.toPosixRelative('src\\a\\b.ts', 'win32'), 'src/a/b.ts');
  assert.equal(p.toPosixRelative('src\\a', 'linux'), 'src\\a');
  assert.equal(p.toSlashes('.\\x\\y', 'win32'), './x/y');
});
