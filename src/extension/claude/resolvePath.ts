/**
 * Resolve the user's `claude` executable.
 *
 * Order (ARCHITECTURE §[A]):
 *   1. the `kursor.claude.path` setting (expanded `~`)
 *   2. `$SHELL -lic 'command -v claude'` — the login shell sees mise/asdf/nvm
 *      shims that the extension host's PATH usually lacks (5 s timeout, cached)
 *   3. ~/.local/bin/claude
 *   4. ~/.local/share/mise/shims/claude
 *   5. `claude` on the extension host's own PATH
 *
 * We never fall back to the SDK's bundled binary: it is not packaged in the
 * .vsix and the product must run the user's own, unmodified `claude`.
 *
 * vscode-free (also used by scripts/probe-bridge.mjs).
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Logger } from '../util/log';

export interface ResolvedClaude {
  path: string;
  /** Where the path came from (for logs / the status card). */
  source: 'setting' | 'login-shell' | 'local-bin' | 'mise-shim' | 'process-path';
  /** PATH of the login shell, when it was consulted successfully. */
  loginPath?: string;
}

export interface ResolveOptions {
  /** Value of `kursor.claude.path` ('' = unset). */
  configuredPath?: string;
  log?: Logger;
  /** Override for tests. */
  homeDir?: string;
  shell?: string;
}

const LOGIN_SHELL_TIMEOUT_MS = 5000;

interface LoginShellResult {
  claude?: string;
  path?: string;
}

let loginShellCache: { key: string; promise: Promise<LoginShellResult> } | undefined;

export function expandHome(p: string, home = os.homedir()): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

async function isExecutable(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    if (!st.isFile()) return false;
    await fs.access(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function run(cmd: string, args: string[], timeout: number, env?: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, encoding: 'utf8', maxBuffer: 1024 * 1024, env, windowsHide: true }, (err, stdout, stderr) => {
      const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as { code?: number }).code ?? null) : err ? null : 0;
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code });
    });
  });
}

/**
 * Ask the login shell where `claude` is and what PATH it uses. Cached per shell
 * (a login shell can take a while on machines with heavy profiles).
 */
export function queryLoginShell(shell: string = process.env.SHELL || '/bin/sh', log?: Logger): Promise<LoginShellResult> {
  if (loginShellCache && loginShellCache.key === shell) return loginShellCache.promise;
  const marker = '__KURSOR_PATH__';
  const script = `command -v claude 2>/dev/null; printf '\\n${marker}%s\\n' "$PATH"`;
  const env = { ...process.env };
  delete env.CLAUDECODE;
  const promise = run(shell, ['-lic', script], LOGIN_SHELL_TIMEOUT_MS, env)
    .then(({ stdout, stderr, code }) => {
      const result: LoginShellResult = {};
      for (const raw of stdout.split('\n')) {
        const line = raw.trim();
        if (!line) continue;
        if (line.startsWith(marker)) result.path = line.slice(marker.length).trim() || undefined;
        else if (!result.claude && (line.startsWith('/') || line.startsWith('~'))) result.claude = line;
      }
      if (!result.claude && !result.path) log?.debug(`login shell (${shell}) gave no result (exit ${code ?? '?'}): ${stderr.trim().slice(0, 200)}`);
      return result;
    })
    .catch((err: unknown) => {
      log?.debug(`login shell lookup failed: ${err instanceof Error ? err.message : String(err)}`);
      return {} as LoginShellResult;
    });
  loginShellCache = { key: shell, promise };
  return promise;
}

export function clearLoginShellCache(): void {
  loginShellCache = undefined;
}

/**
 * If `p` is a mise shim (symlink to the mise binary), ask mise for the real
 * binary so every spawn does not go through the shim's version resolution.
 */
async function unwrapMiseShim(p: string, log?: Logger): Promise<string> {
  try {
    const real = await fs.realpath(p);
    if (path.basename(real) !== 'mise') return p;
    const { stdout, code } = await run(real, ['which', 'claude'], 3000, process.env);
    const target = stdout.trim().split('\n')[0]?.trim();
    if (code === 0 && target && (await isExecutable(target))) {
      log?.debug(`mise shim ${p} → ${target}`);
      return target;
    }
  } catch {
    /* keep the shim */
  }
  return p;
}

export async function resolveClaudeExecutable(options: ResolveOptions = {}): Promise<ResolvedClaude | undefined> {
  const home = options.homeDir ?? os.homedir();
  const log = options.log;

  const configured = (options.configuredPath ?? '').trim();
  if (configured) {
    const p = expandHome(configured, home);
    if (await isExecutable(p)) return { path: p, source: 'setting' };
    log?.warn(`kursor.claude.path is set to "${configured}" but it is not an executable file; falling back to auto-detection`);
  }

  const shell = options.shell ?? process.env.SHELL ?? '/bin/sh';
  const login = await queryLoginShell(shell, log);
  if (login.claude) {
    const p = await unwrapMiseShim(expandHome(login.claude, home), log);
    if (await isExecutable(p)) return { path: p, source: 'login-shell', loginPath: login.path };
  }

  const localBin = path.join(home, '.local', 'bin', 'claude');
  if (await isExecutable(localBin)) return { path: localBin, source: 'local-bin', loginPath: login.path };

  const miseShim = path.join(home, '.local', 'share', 'mise', 'shims', 'claude');
  if (await isExecutable(miseShim)) {
    return { path: await unwrapMiseShim(miseShim, log), source: 'mise-shim', loginPath: login.path };
  }

  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'claude');
    if (await isExecutable(candidate)) return { path: await unwrapMiseShim(candidate, log), source: 'process-path', loginPath: login.path };
  }

  return undefined;
}
