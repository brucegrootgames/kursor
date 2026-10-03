/**
 * Resolve the user's `claude` executable.
 *
 * Order (ARCHITECTURE §[A], extended per platform):
 *   1. the `kursor.claude.path` setting (expanded `~`)
 *   2. platform lookup
 *      - Linux / macOS: `$SHELL -l -i -c 'command -v claude'` — the login shell sees
 *        mise/asdf/nvm/Homebrew paths the extension host's PATH usually lacks (5 s
 *        timeout, cached). On macOS `/bin/zsh` and `/bin/bash` are tried after `$SHELL`.
 *      - Windows: `where.exe claude` (no login shell exists); `.exe` results win over
 *        `.cmd` shims, and npm `.cmd` shims are unwrapped to their target because the
 *        Agent SDK spawns the path directly (Node refuses to spawn `.cmd` without a shell).
 *   3. well-known install locations (native installer, Homebrew, WinGet, npm, mise)
 *   4. `claude` on the extension host's own PATH (honouring PATHEXT on Windows)
 *
 * We never fall back to the SDK's bundled binary: it is not packaged in the
 * .vsix and the product must run the user's own, unmodified `claude`.
 *
 * vscode-free (also used by scripts/probe-bridge.mjs); every platform-dependent input
 * can be injected for tests.
 */
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Logger } from '../util/log';
import { executableExtensions, expandHome as expandHomeFor, getEnv, isWindows, isWindowsScript, pathEntries, pathFor, type Platform } from '../util/platform';

export interface ResolvedClaude {
  path: string;
  /** Where the path came from (for logs / the status card). */
  source: 'setting' | 'login-shell' | 'where' | 'well-known' | 'local-bin' | 'mise-shim' | 'process-path';
  /** PATH of the login shell, when it was consulted successfully (never on Windows). */
  loginPath?: string;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}
export type Runner = (cmd: string, args: string[], timeout: number, env?: NodeJS.ProcessEnv) => Promise<RunResult>;

export interface ResolveOptions {
  /** Value of `kursor.claude.path` ('' = unset). */
  configuredPath?: string;
  log?: Logger;
  /** Overrides for tests. */
  homeDir?: string;
  shell?: string;
  platform?: Platform;
  env?: NodeJS.ProcessEnv;
  isExecutable?: (p: string) => Promise<boolean>;
  run?: Runner;
  readFile?: (p: string) => Promise<string>;
  realpath?: (p: string) => Promise<string>;
}

const LOGIN_SHELL_TIMEOUT_MS = 5000;
const WHERE_TIMEOUT_MS = 5000;

interface LoginShellResult {
  claude?: string;
  path?: string;
}

let loginShellCache: { key: string; promise: Promise<LoginShellResult> } | undefined;

export function expandHome(p: string, home = os.homedir(), platform: Platform = process.platform): string {
  return expandHomeFor(p, home, platform);
}

async function defaultIsExecutable(p: string): Promise<boolean> {
  try {
    const st = await fs.stat(p);
    if (!st.isFile()) return false;
    await fs.access(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

const defaultRun: Runner = (cmd, args, timeout, env) =>
  new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, encoding: 'utf8', maxBuffer: 1024 * 1024, env, windowsHide: true }, (err, stdout, stderr) => {
        const code = err && typeof (err as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? ((err as { code?: number }).code ?? null) : err ? null : 0;
        resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code });
      });
    } catch (err) {
      // Node throws synchronously for some spawn failures (e.g. EINVAL on .cmd files).
      resolve({ stdout: '', stderr: err instanceof Error ? err.message : String(err), code: null });
    }
  });

/**
 * Ask the login shell where `claude` is and what PATH it uses. Cached per shell
 * (a login shell can take a while on machines with heavy profiles).
 */
export function queryLoginShell(shell: string = process.env.SHELL || '/bin/sh', log?: Logger, run: Runner = defaultRun, baseEnv: NodeJS.ProcessEnv = process.env): Promise<LoginShellResult> {
  if (loginShellCache && loginShellCache.key === shell) return loginShellCache.promise;
  const marker = '__KURSOR_PATH__';
  const script = `command -v claude 2>/dev/null; printf '\\n${marker}%s\\n' "$PATH"`;
  const env = { ...baseEnv };
  delete env.CLAUDECODE;
  // Separate flags rather than `-lic`: bash, zsh, fish, dash and ksh all accept `-l -i -c`.
  const promise = run(shell, ['-l', '-i', '-c', script], LOGIN_SHELL_TIMEOUT_MS, env)
    .then(({ stdout, stderr, code }) => {
      const result = parseLoginShellOutput(stdout, marker);
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

export function parseLoginShellOutput(stdout: string, marker = '__KURSOR_PATH__'): LoginShellResult {
  const result: LoginShellResult = {};
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith(marker)) {
      const value = line.slice(marker.length).trim();
      if (value) result.path = value;
    } else if (!result.claude && (line.startsWith('/') || line.startsWith('~'))) result.claude = line;
  }
  return result;
}

export function clearLoginShellCache(): void {
  loginShellCache = undefined;
}

/** Shells to ask, in order: `$SHELL`, then the platform's usual login shells. */
export function loginShellCandidates(platform: Platform, env: NodeJS.ProcessEnv, override?: string): string[] {
  const out: string[] = [];
  const add = (s: string | undefined): void => {
    if (s && !out.includes(s)) out.push(s);
  };
  add(override);
  add(env.SHELL);
  if (platform === 'darwin') {
    add('/bin/zsh');
    add('/bin/bash');
  } else {
    add('/bin/sh');
  }
  return out;
}

/**
 * Well-known install locations per platform (checked after the shell / `where` lookup).
 * Sources mirror https://code.claude.com/docs/en/setup: native installer (`~/.local/bin`),
 * Homebrew, WinGet, npm, the legacy `claude migrate-installer` location (`~/.claude/local`)
 * and mise shims.
 */
export function wellKnownCandidates(platform: Platform, home: string, env: NodeJS.ProcessEnv): { path: string; source: ResolvedClaude['source'] }[] {
  const pp = pathFor(platform);
  const out: { path: string; source: ResolvedClaude['source'] }[] = [];
  if (isWindows(platform)) {
    const localAppData = getEnv(env, 'LOCALAPPDATA', platform) || pp.join(home, 'AppData', 'Local');
    const appData = getEnv(env, 'APPDATA', platform) || pp.join(home, 'AppData', 'Roaming');
    out.push({ path: pp.join(home, '.local', 'bin', 'claude.exe'), source: 'local-bin' });
    out.push({ path: pp.join(localAppData, 'Microsoft', 'WinGet', 'Links', 'claude.exe'), source: 'well-known' });
    out.push({ path: pp.join(localAppData, 'Programs', 'claude', 'claude.exe'), source: 'well-known' });
    out.push({ path: pp.join(home, '.claude', 'local', 'claude.exe'), source: 'well-known' });
    out.push({ path: pp.join(appData, 'npm', 'claude.cmd'), source: 'well-known' });
    out.push({ path: pp.join(home, 'scoop', 'shims', 'claude.exe'), source: 'well-known' });
    return out;
  }
  out.push({ path: pp.join(home, '.local', 'bin', 'claude'), source: 'local-bin' });
  if (platform === 'darwin') {
    out.push({ path: '/opt/homebrew/bin/claude', source: 'well-known' });
    out.push({ path: '/usr/local/bin/claude', source: 'well-known' });
  } else {
    out.push({ path: '/usr/local/bin/claude', source: 'well-known' });
    out.push({ path: '/usr/bin/claude', source: 'well-known' });
    out.push({ path: pp.join(home, '.local', 'share', 'claude', 'bin', 'claude'), source: 'well-known' });
  }
  out.push({ path: pp.join(home, '.claude', 'local', 'claude'), source: 'well-known' });
  out.push({ path: pp.join(home, '.local', 'share', 'mise', 'shims', 'claude'), source: 'mise-shim' });
  return out;
}

/** `where.exe` output → absolute paths (one per line, CRLF). */
export function parseWhereOutput(stdout: string): string[] {
  return stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^[a-zA-Z]:\\|^\\\\/.test(l));
}

/**
 * Pick the best `where.exe` hit: a real `.exe` first, then a `.cmd`/`.bat` shim; extensionless
 * entries (npm's POSIX shim) are useless on Windows.
 */
export function pickWindowsHit(paths: readonly string[]): string | undefined {
  const exe = paths.find((p) => /\.(exe|com)$/i.test(p));
  if (exe) return exe;
  return paths.find((p) => isWindowsScript(p));
}

/**
 * Target of an npm-style `.cmd` shim: the first `"%dp0%\…"` / `%~dp0\…` reference, resolved
 * against the shim's directory. Returns undefined when the file is not a recognisable shim.
 */
export function cmdShimTarget(content: string, shimDir: string): string | undefined {
  const re = /"?%(?:~)?dp0%?\\?([^"\s%]+)"?/g;
  let m: RegExpExecArray | null;
  const seen: string[] = [];
  while ((m = re.exec(content))) {
    const rel = m[1].replace(/^\\+/, '');
    if (!rel || /^node(\.exe)?$/i.test(rel)) continue;
    seen.push(rel);
  }
  // Prefer a script/binary reference over e.g. `node.exe` probes.
  const target = seen.find((r) => /\.(js|mjs|cjs|exe)$/i.test(r)) ?? seen[0];
  return target ? path.win32.normalize(path.win32.join(shimDir, target)) : undefined;
}

export interface WindowsLookupDeps {
  env: NodeJS.ProcessEnv;
  run: Runner;
  isExecutable: (p: string) => Promise<boolean>;
  readFile: (p: string) => Promise<string>;
  log?: Logger;
}

/** `where.exe claude` → best hit (shims unwrapped). */
export async function queryWhere(deps: WindowsLookupDeps): Promise<string | undefined> {
  const systemRoot = getEnv(deps.env, 'SystemRoot', 'win32') || getEnv(deps.env, 'SYSTEMROOT', 'win32') || 'C:\\Windows';
  const where = path.win32.join(systemRoot, 'System32', 'where.exe');
  const { stdout, code } = await deps.run(where, ['claude'], WHERE_TIMEOUT_MS, deps.env);
  if (code !== 0 && !stdout.trim()) return undefined;
  const hits = parseWhereOutput(stdout);
  const existing: string[] = [];
  for (const h of hits) if (await deps.isExecutable(h)) existing.push(h);
  const pick = pickWindowsHit(existing);
  if (!pick) return undefined;
  return unwrapWindowsShim(pick, deps);
}

/** `.cmd` shims cannot be spawned by the SDK; replace them with the `.exe` / `.js` they launch. */
export async function unwrapWindowsShim(p: string, deps: WindowsLookupDeps): Promise<string> {
  if (!isWindowsScript(p)) return p;
  try {
    const content = await deps.readFile(p);
    const target = cmdShimTarget(content, path.win32.dirname(p));
    if (target && (await deps.isExecutable(target))) {
      deps.log?.debug(`cmd shim ${p} → ${target}`);
      return target;
    }
  } catch {
    /* keep the shim */
  }
  deps.log?.warn(`${p} is a .cmd shim that could not be unwrapped; Claude Code sessions may fail to start. Prefer the native installer (claude.exe) or set kursor.claude.path.`);
  return p;
}

/**
 * If `p` is a mise shim (symlink to the mise binary), ask mise for the real
 * binary so every spawn does not go through the shim's version resolution.
 */
async function unwrapMiseShim(p: string, deps: { run: Runner; isExecutable: (p: string) => Promise<boolean>; realpath: (p: string) => Promise<string>; env: NodeJS.ProcessEnv; log?: Logger }): Promise<string> {
  try {
    const real = await deps.realpath(p);
    if (path.basename(real) !== 'mise') return p;
    const { stdout, code } = await deps.run(real, ['which', 'claude'], 3000, deps.env);
    const target = stdout.trim().split(/\r?\n/)[0]?.trim();
    if (code === 0 && target && (await deps.isExecutable(target))) {
      deps.log?.debug(`mise shim ${p} → ${target}`);
      return target;
    }
  } catch {
    /* keep the shim */
  }
  return p;
}

/** Candidate file names for `claude` in one PATH directory (PATHEXT on Windows, `.exe` first). */
export function pathExeNames(platform: Platform, env: NodeJS.ProcessEnv): string[] {
  if (!isWindows(platform)) return ['claude'];
  const exts = executableExtensions(env, platform);
  const ordered = ['.exe', '.com', ...exts.filter((e) => e !== '.exe' && e !== '.com')];
  return ordered.map((e) => `claude${e}`);
}

export async function resolveClaudeExecutable(options: ResolveOptions = {}): Promise<ResolvedClaude | undefined> {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homeDir ?? os.homedir();
  const log = options.log;
  const pp = pathFor(platform);
  const isExecutable = options.isExecutable ?? defaultIsExecutable;
  const run = options.run ?? defaultRun;
  const readFile = options.readFile ?? ((p: string) => fs.readFile(p, 'utf8'));
  const realpath = options.realpath ?? ((p: string) => fs.realpath(p));
  const win = isWindows(platform);
  const shimDeps = { run, isExecutable, realpath, env, log };
  const unwrap = (p: string): Promise<string> => (win ? unwrapWindowsShim(p, { env, run, isExecutable, readFile, log }) : unwrapMiseShim(p, shimDeps));

  const configured = (options.configuredPath ?? '').trim();
  if (configured) {
    const p = expandHome(configured, home, platform);
    if (await isExecutable(p)) return { path: await unwrap(p), source: 'setting' };
    log?.warn(`kursor.claude.path is set to "${configured}" but it is not an executable file; falling back to auto-detection`);
  }

  let loginPath: string | undefined;
  if (win) {
    const hit = await queryWhere({ env, run, isExecutable, readFile, log });
    if (hit) return { path: hit, source: 'where' };
  } else {
    for (const shell of loginShellCandidates(platform, env, options.shell)) {
      if (!(await isExecutable(shell))) continue;
      const login = await queryLoginShell(shell, log, run, env);
      if (login.path && !loginPath) loginPath = login.path;
      if (login.claude) {
        const p = await unwrapMiseShim(expandHome(login.claude, home, platform), shimDeps);
        if (await isExecutable(p)) return { path: p, source: 'login-shell', loginPath: login.path };
      }
      // A shell that answered (even without claude) is authoritative for PATH; stop here.
      if (login.path) break;
    }
  }

  for (const c of wellKnownCandidates(platform, home, env)) {
    if (await isExecutable(c.path)) return { path: await unwrap(c.path), source: c.source, loginPath };
  }

  const names = pathExeNames(platform, env);
  for (const dir of pathEntries(env, platform)) {
    for (const name of names) {
      const candidate = pp.join(dir, name);
      if (await isExecutable(candidate)) return { path: await unwrap(candidate), source: 'process-path', loginPath };
    }
  }

  return undefined;
}
