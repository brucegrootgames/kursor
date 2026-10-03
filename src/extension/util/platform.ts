/**
 * Platform helpers shared by the extension host (vscode-free, unit-tested).
 *
 * Every function takes the platform / env / home directory as parameters (defaulting to the
 * live process) so the Windows and macOS branches can be exercised from tests on Linux.
 */
import * as os from 'node:os';
import * as path from 'node:path';

export type Platform = NodeJS.Platform;

export function isWindows(platform: Platform = process.platform): boolean {
  return platform === 'win32';
}

/** `path.win32` / `path.posix` for the given platform. */
export function pathFor(platform: Platform = process.platform): path.PlatformPath {
  return isWindows(platform) ? path.win32 : path.posix;
}

/** PATH separator: `;` on Windows, `:` elsewhere. */
export function pathDelimiter(platform: Platform = process.platform): string {
  return isWindows(platform) ? ';' : ':';
}

/** `claude` → `claude.exe` on Windows. */
export function exeName(base: string, platform: Platform = process.platform): string {
  return isWindows(platform) ? `${base}.exe` : base;
}

/** Windows environment variables are case-insensitive; find the key as it is spelled in `env`. */
export function envKey(env: NodeJS.ProcessEnv, name: string, platform: Platform = process.platform): string {
  if (name in env) return name;
  if (!isWindows(platform)) return name;
  const upper = name.toUpperCase();
  for (const key of Object.keys(env)) if (key.toUpperCase() === upper) return key;
  return name;
}

export function getEnv(env: NodeJS.ProcessEnv, name: string, platform: Platform = process.platform): string | undefined {
  return env[envKey(env, name, platform)];
}

export function setEnv(env: NodeJS.ProcessEnv, name: string, value: string, platform: Platform = process.platform): void {
  env[envKey(env, name, platform)] = value;
}

/** Entries of the PATH variable (empty entries dropped). */
export function pathEntries(env: NodeJS.ProcessEnv, platform: Platform = process.platform): string[] {
  return (getEnv(env, 'PATH', platform) ?? '').split(pathDelimiter(platform)).filter((p) => p.length > 0);
}

/** `primary` first, then entries of `secondary` not already present (case-insensitive on Windows). */
export function mergePathList(primary: string, secondary: string | undefined, platform: Platform = process.platform): string {
  const delimiter = pathDelimiter(platform);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of [...primary.split(delimiter), ...(secondary ?? '').split(delimiter)]) {
    if (!part) continue;
    const key = isWindows(platform) ? part.toLowerCase() : part;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(part);
  }
  return out.join(delimiter);
}

/** `PATHEXT` (Windows) as a lowercase list; `['']` elsewhere so callers can always append. */
export function executableExtensions(env: NodeJS.ProcessEnv, platform: Platform = process.platform): string[] {
  if (!isWindows(platform)) return [''];
  const raw = getEnv(env, 'PATHEXT', platform) || '.COM;.EXE;.BAT;.CMD';
  const exts = raw
    .split(';')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.startsWith('.'));
  return exts.length ? exts : ['.com', '.exe', '.bat', '.cmd'];
}

/** `.cmd` / `.bat` files cannot be spawned directly (Node refuses since CVE-2024-27980); they need cmd.exe. */
export function isWindowsScript(p: string): boolean {
  const ext = path.win32.extname(p).toLowerCase();
  return ext === '.cmd' || ext === '.bat';
}

/**
 * Quote one argument for `cmd.exe /d /s /c "<command line>"`. Arguments are double-quoted when
 * needed and embedded quotes are doubled; cmd metacharacters are caret-escaped outside quotes.
 */
export function quoteForCmd(arg: string): string {
  if (arg === '') return '""';
  if (!/[\s"&|<>^()%!]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/** Spawn description for a `.cmd`/`.bat` file: `cmd.exe /d /s /c "<quoted command line>"`. */
export function cmdExeInvocation(script: string, args: readonly string[], env: NodeJS.ProcessEnv = process.env): { command: string; args: string[] } {
  const comspec = getEnv(env, 'ComSpec', 'win32') || 'cmd.exe';
  const line = [script, ...args].map(quoteForCmd).join(' ');
  return { command: comspec, args: ['/d', '/s', '/c', `"${line}"`] };
}

/** `~`, `~/x` and (on Windows) `~\x` → home. */
export function expandHome(p: string, home: string = os.homedir(), platform: Platform = process.platform): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return pathFor(platform).join(home, p.slice(2));
  if (isWindows(platform) && p.startsWith('~\\')) return path.win32.join(home, p.slice(2));
  return p;
}

/** Display form: replace a leading home directory with `~`. */
export function tildify(p: string, home: string = os.homedir(), platform: Platform = process.platform): string {
  if (!home) return p;
  const pp = pathFor(platform);
  const sep = pp.sep;
  const base = home.endsWith(sep) ? home.slice(0, -sep.length) : home;
  const same = (a: string, b: string): boolean => (isWindows(platform) ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (same(p, base)) return '~';
  if (p.length > base.length && same(p.slice(0, base.length), base) && (p[base.length] === sep || (isWindows(platform) && p[base.length] === '/'))) {
    return `~${sep}${p.slice(base.length + 1)}`;
  }
  return p;
}

/**
 * Comparison key for file system paths: normalised, trailing separators removed, and lowercase on
 * Windows (case-insensitive file system, drive letters reported in either case). Not for display.
 */
export function comparablePath(p: string, platform: Platform = process.platform): string {
  const pp = pathFor(platform);
  let n = pp.normalize(p);
  if (n.length > 1 && n.endsWith(pp.sep) && !/^[a-zA-Z]:\\$/.test(n)) n = n.slice(0, -1);
  if (isWindows(platform)) n = n.toLowerCase();
  return n;
}

export function samePath(a: string, b: string, platform: Platform = process.platform): boolean {
  return comparablePath(a, platform) === comparablePath(b, platform);
}

/** True when `child` equals `parent` or lies inside it. */
export function isInside(child: string, parent: string, platform: Platform = process.platform): boolean {
  const c = comparablePath(child, platform);
  const p = comparablePath(parent, platform);
  if (c === p) return true;
  const sep = pathFor(platform).sep;
  return c.startsWith(p.endsWith(sep) ? p : p + sep);
}

/** Workspace-relative path with forward slashes (what we show the model and the user). */
export function toPosixRelative(rel: string, platform: Platform = process.platform): string {
  return isWindows(platform) ? rel.replace(/\\/g, '/') : rel;
}

/** Normalise Windows path output (`a\b\c`) to the '/'-separated form used in our indexes. */
export function toSlashes(p: string, platform: Platform = process.platform): string {
  return isWindows(platform) ? p.replace(/\\/g, '/') : p;
}
