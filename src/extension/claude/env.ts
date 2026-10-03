/**
 * Environment for the spawned `claude` process.
 *
 * The SDK's `env` option REPLACES the child environment, so we start from
 * `process.env`. `CLAUDECODE` / `CLAUDE_CODE_CHILD_SESSION` are removed so a
 * `claude` that happens to be running the extension host (e.g. Kursor launched
 * from a Claude Code terminal) does not make the child think it is nested.
 * `NODE_OPTIONS` is never set (the SDK deletes it anyway).
 *
 * Windows: environment variable names are case-insensitive (`Path` vs `PATH`), so
 * we always write through the key that already exists; the login-shell PATH merge
 * never applies there (there is no login shell).
 */
import { getEnv, isWindows, mergePathList, setEnv, type Platform } from '../util/platform';

export interface ChildEnvOptions {
  /** PATH captured from the user's login shell; merged in front of the current PATH (POSIX only). */
  loginPath?: string;
  /** Extra variables (highest precedence). */
  extra?: Record<string, string | undefined>;
  /** Overrides for tests. */
  platform?: Platform;
  base?: NodeJS.ProcessEnv;
}

export function buildChildEnv(options: ChildEnvOptions = {}): Record<string, string | undefined> {
  const platform = options.platform ?? process.platform;
  const env: Record<string, string | undefined> = { ...(options.base ?? process.env) };
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_CHILD_SESSION;
  // Trace context from a parent Claude session must not leak into ours.
  delete env.TRACEPARENT;
  delete env.TRACESTATE;
  // The extension host runs with ELECTRON_RUN_AS_NODE=1; harmless for a native
  // binary but confusing for anything the CLI spawns via `node`.
  delete env.ELECTRON_RUN_AS_NODE;
  if (options.loginPath && !isWindows(platform)) {
    setEnv(env, 'PATH', mergePathList(options.loginPath, getEnv(env, 'PATH', platform), platform), platform);
  }
  if (!env.CLAUDE_CODE_ENTRYPOINT) env.CLAUDE_CODE_ENTRYPOINT = 'sdk-ts';
  for (const [k, v] of Object.entries(options.extra ?? {})) {
    if (v === undefined) delete env[k];
    else env[k] = v;
  }
  return env;
}

/** Login-shell PATH first, then any entries of the current PATH that are missing. */
export function mergePath(primary: string, secondary: string | undefined, platform: Platform = process.platform): string {
  return mergePathList(primary, secondary, platform);
}
