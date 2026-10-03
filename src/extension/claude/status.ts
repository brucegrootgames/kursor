/**
 * `claude --version` + `claude auth status --json` → ClaudeStatus.
 * Neither command talks to the API; both finish in well under a second.
 * vscode-free.
 */
import { execFile } from 'node:child_process';
import type { ClaudeStatus } from './types';

const CMD_TIMEOUT_MS = 15_000;

interface AuthStatusJson {
  loggedIn?: boolean;
  email?: string;
  subscriptionType?: string;
  authMethod?: string;
  apiProvider?: string;
  orgName?: string;
}

function exec(cmd: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ stdout: string; stderr: string; code: number | null; error?: Error }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: CMD_TIMEOUT_MS, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, env, windowsHide: true }, (err, stdout, stderr) => {
      const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
      let code: number | null = 0;
      if (e) code = typeof e.code === 'number' ? e.code : null;
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), code, error: e ?? undefined });
    });
  });
}

export function parseVersion(output: string): string | undefined {
  const m = /(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)/.exec(output);
  return m?.[1];
}

export function parseAuthStatus(output: string): AuthStatusJson | undefined {
  const trimmed = output.trim();
  if (!trimmed) return undefined;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed.slice(start, end + 1));
    return parsed && typeof parsed === 'object' ? (parsed as AuthStatusJson) : undefined;
  } catch {
    return undefined;
  }
}

/** Human-friendly plan name: "max" → "Max", "Claude Max" stays. */
export function prettySubscription(s: string | undefined): string | undefined {
  if (!s) return undefined;
  const t = s.trim();
  if (!t) return undefined;
  if (/^[a-z]+$/.test(t)) return t.charAt(0).toUpperCase() + t.slice(1);
  return t;
}

export async function probeClaudeStatus(claudePath: string, env: NodeJS.ProcessEnv): Promise<ClaudeStatus> {
  const version = await exec(claudePath, ['--version'], env);
  if (version.error && version.code === null && !version.stdout) {
    const e = version.error as NodeJS.ErrnoException & { killed?: boolean };
    const why = e.code === 'ENOENT' ? 'file not found' : e.code === 'EACCES' ? 'not executable' : e.killed ? 'timed out' : e.message;
    return { ok: false, path: claudePath, error: `Could not run ${claudePath} (${why}).` };
  }
  const parsedVersion = parseVersion(version.stdout) ?? parseVersion(version.stderr);
  if (!parsedVersion) {
    const detail = (version.stderr || version.stdout).trim().split('\n')[0] ?? '';
    return { ok: false, path: claudePath, error: `${claudePath} did not report a version${detail ? ` (${detail.slice(0, 200)})` : ''}.` };
  }

  const auth = await exec(claudePath, ['auth', 'status', '--json'], env);
  const json = parseAuthStatus(auth.stdout) ?? parseAuthStatus(auth.stderr);
  if (!json) {
    // Old CLI without `auth status`, or a crash: the binary works, but we cannot tell whether it is signed in.
    const detail = (auth.stderr || auth.stdout).trim().split('\n')[0] ?? '';
    return {
      ok: true,
      path: claudePath,
      version: parsedVersion,
      loggedIn: undefined,
      error: `Could not read sign-in status${detail ? `: ${detail.slice(0, 200)}` : ''}`,
    };
  }
  return {
    ok: true,
    path: claudePath,
    version: parsedVersion,
    loggedIn: json.loggedIn === true,
    email: typeof json.email === 'string' ? json.email : undefined,
    subscriptionType: prettySubscription(typeof json.subscriptionType === 'string' ? json.subscriptionType : undefined),
  };
}

export function statusEquals(a: ClaudeStatus | undefined, b: ClaudeStatus | undefined): boolean {
  if (!a || !b) return a === b;
  return (
    a.ok === b.ok &&
    a.path === b.path &&
    a.version === b.version &&
    a.loggedIn === b.loggedIn &&
    a.email === b.email &&
    a.subscriptionType === b.subscriptionType &&
    a.error === b.error
  );
}
