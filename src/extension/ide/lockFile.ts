/**
 * Lock-file contract between Kursor and the `claude` CLI.
 *
 * The CLI lists `<claude config dir>/ide/*.lock`, parses each JSON payload and, when the
 * port matches `CLAUDE_CODE_SSE_PORT` (or the cwd is inside one of `workspaceFolders`),
 * connects to `ws://127.0.0.1:<port>` presenting `authToken` in the
 * `X-Claude-Code-Ide-Authorization` header.
 *
 * Pure Node module (no `vscode` import) so it can be unit-tested outside the extension host.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface LockFilePayload {
  /** PID the CLI checks for liveness: the parent of the extension host = the editor's main process. */
  pid: number;
  /** Absolute workspace folder paths. */
  workspaceFolders: string[];
  /** `vscode.env.appName` ("Kursor" in the rebranded build). */
  ideName: string;
  transport: 'ws';
  runningInWindows: boolean;
  /** Random UUID the client must echo in `X-Claude-Code-Ide-Authorization`. */
  authToken: string;
}

export const LOCK_FILE_SUFFIX = '.lock';

function expandHome(p: string, home: string): string {
  if (p === '~') return home;
  if (p.startsWith('~/')) return path.join(home, p.slice(2));
  return p;
}

/** `$CLAUDE_CONFIG_DIR` when set, otherwise `~/.claude` (same rule as the CLI). */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim();
  if (override) return path.resolve(expandHome(override, home));
  return path.join(home, '.claude');
}

/** `<config dir>/ide` — where lock files live. */
export function ideLockDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  return path.join(claudeConfigDir(env, home), 'ide');
}

/** Creates the lock directory with mode 0700 (and tightens an existing one on POSIX). */
export function ensureIdeLockDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    try {
      const mode = fs.statSync(dir).mode & 0o777;
      if (mode !== 0o700) fs.chmodSync(dir, 0o700);
    } catch {
      // best effort: the directory exists, permissions are the user's responsibility
    }
  }
}

export function lockFilePath(dir: string, port: number): string {
  return path.join(dir, `${port}${LOCK_FILE_SUFFIX}`);
}

export function portFromLockFile(file: string): number | undefined {
  const base = path.basename(file);
  if (!base.endsWith(LOCK_FILE_SUFFIX)) return undefined;
  const port = Number.parseInt(base.slice(0, -LOCK_FILE_SUFFIX.length), 10);
  return Number.isInteger(port) && port > 0 && port <= 65535 ? port : undefined;
}

export interface LockPayloadInput {
  workspaceFolders: readonly string[];
  ideName: string;
  authToken: string;
  /** Defaults to `process.ppid`. */
  pid?: number;
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
}

export function buildLockPayload(input: LockPayloadInput): LockFilePayload {
  return {
    pid: input.pid ?? process.ppid,
    workspaceFolders: [...input.workspaceFolders],
    ideName: input.ideName,
    transport: 'ws',
    runningInWindows: (input.platform ?? process.platform) === 'win32',
    authToken: input.authToken,
  };
}

export function isLockFilePayload(value: unknown): value is LockFilePayload {
  if (typeof value !== 'object' || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.pid === 'number' &&
    Array.isArray(v.workspaceFolders) &&
    v.workspaceFolders.every((f) => typeof f === 'string') &&
    typeof v.ideName === 'string' &&
    v.transport === 'ws' &&
    typeof v.runningInWindows === 'boolean' &&
    typeof v.authToken === 'string'
  );
}

/**
 * Writes `<dir>/<port>.lock` atomically (temp file + rename) with mode 0600.
 * The temp file name does not end in `.lock`, so the CLI never sees a half-written file.
 */
export function writeLockFile(dir: string, port: number, payload: LockFilePayload): string {
  ensureIdeLockDir(dir);
  const target = lockFilePath(dir, port);
  const tmp = path.join(dir, `.${port}.${process.pid}.${Date.now()}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
  try {
    if (process.platform !== 'win32') fs.chmodSync(tmp, 0o600);
    fs.renameSync(tmp, target);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignore
    }
    throw err;
  }
  return target;
}

/** Removes the lock file; a missing file is not an error. */
export function deleteLockFile(dir: string, port: number): void {
  try {
    fs.unlinkSync(lockFilePath(dir, port));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
}

/** Reads and validates a lock file; `undefined` when missing or malformed. */
export function readLockFile(file: string): LockFilePayload | undefined {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    return isLockFilePayload(raw) ? raw : undefined;
  } catch {
    return undefined;
  }
}
