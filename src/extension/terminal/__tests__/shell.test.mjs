// Shell classification, OS description and prompt/sanitizer behaviour for Ctrl+K in the terminal.
// Run: node --test src/extension/terminal/__tests__/shell.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, '..');
const tmp = fs.mkdtempSync(path.join(process.env.KURSOR_TEST_TMP || os.tmpdir(), 'kursor-shell-test-'));
let shell, prompt;

before(async () => {
  await build({ entryPoints: [path.join(src, 'shell.ts'), path.join(src, 'prompt.ts')], outdir: tmp, bundle: true, format: 'esm', platform: 'node', target: 'node20', logLevel: 'silent' });
  shell = await import(pathToFileURL(path.join(tmp, 'shell.js')).href);
  prompt = await import(pathToFileURL(path.join(tmp, 'prompt.js')).href);
});
after(() => fs.rmSync(tmp, { recursive: true, force: true }));

test('shellFamily recognises pwsh/powershell/cmd/posix from names and paths', () => {
  assert.equal(shell.shellFamily('pwsh'), 'powershell');
  assert.equal(shell.shellFamily('C:\\Program Files\\PowerShell\\7\\pwsh.exe'), 'powershell');
  assert.equal(shell.shellFamily('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'), 'powershell');
  assert.equal(shell.shellFamily('cmd'), 'cmd');
  assert.equal(shell.shellFamily('C:\\WINDOWS\\system32\\cmd.exe'), 'cmd');
  assert.equal(shell.shellFamily('gitbash'), 'posix');
  assert.equal(shell.shellFamily('/bin/zsh'), 'posix');
  assert.equal(shell.shellFamily('fish'), 'posix');
  assert.equal(shell.shellFamily('wsl'), 'posix');
  assert.equal(shell.shellFamily('nu'), 'unknown');
});

test('describeShell and defaultShellName', () => {
  assert.equal(shell.describeShell('pwsh.exe'), 'pwsh (PowerShell 7)');
  assert.equal(shell.describeShell('gitbash'), 'bash (Git Bash on Windows)');
  assert.equal(shell.describeShell('/usr/bin/zsh'), 'zsh');
  assert.equal(shell.defaultShellName('win32', { SHELL: '/bin/bash' }), 'powershell');
  assert.equal(shell.defaultShellName('darwin', {}), 'zsh');
  assert.equal(shell.defaultShellName('darwin', { SHELL: '/opt/homebrew/bin/fish' }), 'fish');
  assert.equal(shell.defaultShellName('linux', {}), 'bash');
});

test('describeOsFacts per platform', () => {
  assert.equal(shell.describeOsFacts({ platform: 'linux', type: 'Linux', release: '6.12.1-arch1-1', arch: 'x64', prettyName: 'Arch Linux' }), 'Arch Linux (Linux 6.12.1-arch1-1, x64)');
  assert.equal(shell.describeOsFacts({ platform: 'linux', type: 'Linux', release: '6.1', arch: 'arm64' }), 'Linux 6.1 (arm64)');
  assert.equal(shell.describeOsFacts({ platform: 'darwin', type: 'Darwin', release: '24.1.0', arch: 'arm64', macVersion: '15.1' }), 'macOS 15.1 (Darwin 24.1.0, arm64)');
  assert.equal(shell.describeOsFacts({ platform: 'darwin', type: 'Darwin', release: '24.1.0', arch: 'arm64' }), 'macOS (Darwin 24.1.0, arm64)');
  assert.equal(shell.describeOsFacts({ platform: 'win32', type: 'Windows_NT', release: '10.0.26100', arch: 'x64', version: 'Windows 11 Pro' }), 'Windows 11 Pro (10.0.26100, x64)');
  assert.equal(shell.describeOsFacts({ platform: 'win32', type: 'Windows_NT', release: '10.0.19045', arch: 'x64' }), 'Windows (10.0.19045, x64)');
});

test('buildTerminalPrompt states the shell family rules', () => {
  const ps = prompt.buildTerminalPrompt({ request: 'list files', context: { shell: 'pwsh (PowerShell 7)', shellFamily: 'powershell', cwd: 'C:\\proj', os: 'Windows 11 Pro (10.0.26100, x64)', workspace: 'C:\\proj' } });
  assert.match(ps, /^Shell: pwsh \(PowerShell 7\)/);
  assert.match(ps, /PowerShell: use cmdlets/);
  assert.match(ps, /Do not use bash-only syntax/);
  const cmd = prompt.buildTerminalPrompt({ request: 'x', context: { shell: 'cmd', shellFamily: 'cmd', cwd: 'C:\\', os: 'Windows', workspace: undefined } });
  assert.match(cmd, /Command Prompt \(cmd\.exe\)/);
  const posix = prompt.buildTerminalPrompt({ request: 'x', context: { shell: 'zsh', shellFamily: 'posix', cwd: '/Users/u', os: 'macOS 15.1 (Darwin 24.1.0, arm64)', workspace: undefined } });
  assert.match(posix, /BSD variants on macOS/);
  // Old-style context without shellFamily still works
  const legacy = prompt.buildTerminalPrompt({ request: 'x', context: { shell: 'bash', cwd: '/', os: 'Linux', workspace: undefined } });
  assert.match(legacy, /Shell: bash\nOS: Linux\nWorking directory: \/\n\nRequest: x/);
});

test('sanitizeCommand strips PowerShell / cmd prompts and CRLF', () => {
  assert.equal(prompt.sanitizeCommand('PS C:\\Users\\me> Get-ChildItem -Recurse\r\n'), 'Get-ChildItem -Recurse');
  assert.equal(prompt.sanitizeCommand('PS> Get-Process'), 'Get-Process');
  assert.equal(prompt.sanitizeCommand('C:\\proj> dir /b'), 'dir /b');
  assert.equal(prompt.sanitizeCommand('$ ls -la'), 'ls -la');
  assert.equal(prompt.sanitizeCommand('```powershell\r\nRemove-Item -Recurse .\\dist\r\n```'), 'Remove-Item -Recurse .\\dist');
  assert.equal(prompt.sanitizeCommand('Here is the command:\n`git status`'), 'git status');
});
