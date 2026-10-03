/**
 * Workspace file listing through ripgrep (`rg --files`), which honours
 * .gitignore / .ignore by default; we add `.cursorignore` as an extra ignore file.
 * Falls back to `vscode.workspace.findFiles` when no `rg` binary is available.
 */
import * as vscode from 'vscode';
import * as cp from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Logger } from '../util/log';

export const MAX_FILES = 25_000;

const EXCLUDE_GLOBS = [
  '!**/node_modules/**',
  '!**/.git/**',
  '!**/dist/**',
  '!**/out/**',
  '!**/build/**',
  '!**/.venv/**',
  '!**/venv/**',
  '!**/__pycache__/**',
  '!**/.cache/**',
  '!**/.next/**',
  '!**/target/**',
];

let cachedRg: string | null | undefined;

export function resolveRipgrep(): string | null {
  if (cachedRg !== undefined) return cachedRg;
  const candidates = [
    path.join(vscode.env.appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg'),
    path.join(vscode.env.appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', 'rg'),
    '/usr/bin/rg',
    '/usr/local/bin/rg',
    path.join(process.env.HOME ?? '', '.local', 'bin', 'rg'),
  ];
  for (const c of candidates) {
    try {
      fs.accessSync(c, fs.constants.X_OK);
      cachedRg = c;
      return c;
    } catch {
      /* next */
    }
  }
  cachedRg = null;
  return null;
}

/** List files under `root` (relative paths, '/' separated). */
export async function listFiles(root: string, log: Logger, signal?: AbortSignal): Promise<{ files: string[]; truncated: boolean }> {
  const rg = resolveRipgrep();
  if (!rg) {
    log.warn('ripgrep not found; falling back to workspace.findFiles');
    const uris = await vscode.workspace.findFiles(new vscode.RelativePattern(root, '**/*'), '**/{node_modules,.git,dist,out}/**', MAX_FILES);
    return { files: uris.map((u) => path.relative(root, u.fsPath).split(path.sep).join('/')), truncated: uris.length >= MAX_FILES };
  }
  const args = ['--files', '--follow', '--hidden', '--no-messages'];
  for (const g of EXCLUDE_GLOBS) args.push('-g', g);
  const cursorignore = path.join(root, '.cursorignore');
  if (fs.existsSync(cursorignore)) args.push('--ignore-file', cursorignore);
  return new Promise((resolve) => {
    const files: string[] = [];
    let truncated = false;
    let rest = '';
    let done = false;
    const child = cp.spawn(rg, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    const finish = (): void => {
      if (done) return;
      done = true;
      if (rest && files.length < MAX_FILES) files.push(rest);
      resolve({ files, truncated });
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (done) return;
      const text = rest + chunk;
      const lines = text.split('\n');
      rest = lines.pop() ?? '';
      for (const line of lines) {
        if (!line) continue;
        if (files.length >= MAX_FILES) {
          truncated = true;
          child.kill();
          finish();
          return;
        }
        files.push(line.startsWith('./') ? line.slice(2) : line);
      }
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d: string) => {
      stderr += d;
    });
    child.on('error', (err) => {
      log.error('ripgrep failed', err);
      finish();
    });
    child.on('close', (code) => {
      if (code && code !== 0 && code !== 1 && stderr) log.warn(`ripgrep exited ${code}: ${stderr.slice(0, 500)}`);
      finish();
    });
    signal?.addEventListener('abort', () => {
      child.kill();
      finish();
    });
  });
}
