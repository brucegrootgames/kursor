/**
 * ClaudeBridge — the single place that talks to the Claude Code CLI.
 * See README.md in this directory for the design; the SDK-facing logic lives in
 * sdkClient.ts (vscode-free), this file is the vscode glue: executable
 * resolution + status cache, session registry, one-shots, history.
 */
import * as vscode from 'vscode';
import type { HistoryEntry } from '../../shared/protocol';
import type { Logger } from '../util/log';
import type { ClaudeBridge, ClaudeSession, ClaudeStatus, OneShotRequest, SessionStartOptions } from './types';
import { buildChildEnv } from './env';
import { clearLoginShellCache, resolveClaudeExecutable, type ResolvedClaude } from './resolvePath';
import { probeClaudeStatus, statusEquals } from './status';
import { runOneShot } from './sdkClient';
import { ClaudeSessionImpl } from './session';
import * as history from './history';
import { errorMessage } from './sdk';

const STATUS_TTL_MS = 60_000;
const NOT_FOUND_MESSAGE =
  'The `claude` command-line tool was not found. Install Claude Code (https://code.claude.com/docs/en/setup) or set `kursor.claude.path` to its location.';

interface Executable {
  claudePath: string;
  env: Record<string, string | undefined>;
  resolved: ResolvedClaude;
}

export function createClaudeBridge(context: vscode.ExtensionContext, log: Logger): ClaudeBridge {
  const statusEmitter = new vscode.EventEmitter<ClaudeStatus>();
  const sessions = new Set<ClaudeSessionImpl>();
  let disposed = false;

  let executable: { key: string; promise: Promise<Executable | undefined> } | undefined;
  let statusCache: { status: ClaudeStatus; at: number } | undefined;
  let statusInflight: Promise<ClaudeStatus> | undefined;

  const configuredPath = (): string => vscode.workspace.getConfiguration('kursor').get<string>('claude.path', '') ?? '';

  /** Resolve (and cache) the executable + child env for the current `kursor.claude.path`. */
  function resolveExecutable(force = false): Promise<Executable | undefined> {
    const key = configuredPath();
    if (!force && executable && executable.key === key) return executable.promise;
    if (force) clearLoginShellCache();
    const promise = resolveClaudeExecutable({ configuredPath: key, log })
      .then((resolved) => {
        if (!resolved) {
          log.warn('claude executable not found');
          return undefined;
        }
        log.info(`claude executable: ${resolved.path} (${resolved.source})`);
        return { claudePath: resolved.path, env: buildChildEnv({ loginPath: resolved.loginPath }), resolved };
      })
      .catch((err: unknown) => {
        log.error('resolving the claude executable failed', err);
        return undefined;
      });
    const entry = { key, promise };
    executable = entry;
    // Do not cache a miss for long: the user may be installing right now.
    void promise.then((r) => {
      if (r) return;
      const timer = setTimeout(() => {
        if (executable === entry) executable = undefined;
      }, 10_000);
      timer.unref();
    });
    return promise;
  }

  async function requireExecutable(): Promise<{ claudePath: string; env: Record<string, string | undefined> }> {
    const exe = await resolveExecutable();
    if (!exe) throw new Error(NOT_FOUND_MESSAGE);
    return { claudePath: exe.claudePath, env: exe.env };
  }

  function publishStatus(status: ClaudeStatus): ClaudeStatus {
    const changed = !statusEquals(statusCache?.status, status);
    statusCache = { status, at: Date.now() };
    if (changed && !disposed) statusEmitter.fire(status);
    return status;
  }

  async function refreshStatus(force: boolean): Promise<ClaudeStatus> {
    if (statusInflight) return statusInflight;
    statusInflight = (async () => {
      try {
        const exe = await resolveExecutable(force);
        if (!exe) return publishStatus({ ok: false, error: NOT_FOUND_MESSAGE });
        const status = await probeClaudeStatus(exe.claudePath, exe.env);
        return publishStatus(status);
      } catch (err) {
        return publishStatus({ ok: false, error: `Could not check Claude Code: ${errorMessage(err)}` });
      } finally {
        statusInflight = undefined;
      }
    })();
    return statusInflight;
  }

  const bridge: ClaudeBridge = {
    onDidChangeStatus: statusEmitter.event,

    async resolveClaudePath() {
      return (await resolveExecutable())?.claudePath;
    },

    status() {
      if (statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) return Promise.resolve(statusCache.status);
      return refreshStatus(false);
    },

    refreshStatus() {
      return refreshStatus(true);
    },

    createSession(options: SessionStartOptions): ClaudeSession {
      const session = new ClaudeSessionImpl(
        { resolveSpawn: requireExecutable, onDispose: (s) => sessions.delete(s) },
        options,
        log.child('session'),
      );
      sessions.add(session);
      return session;
    },

    async oneShot(request: OneShotRequest): Promise<string> {
      const exe = await requireExecutable();
      return runOneShot(request, { claudePath: exe.claudePath, env: exe.env, log });
    },

    listSessions(cwd: string): Promise<HistoryEntry[]> {
      return history.listSessions(cwd, log);
    },

    getSessionTranscript(sessionId: string, cwd: string) {
      return history.getSessionTranscript(sessionId, cwd, log);
    },

    deleteSession(sessionId: string, cwd: string) {
      return history.deleteSession(sessionId, cwd, log);
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      for (const s of [...sessions]) {
        try {
          s.dispose();
        } catch (err) {
          log.debug(`session dispose failed: ${errorMessage(err)}`);
        }
      }
      sessions.clear();
      statusEmitter.dispose();
    },
  };

  context.subscriptions.push(
    bridge,
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('kursor.claude.path')) {
        executable = undefined;
        void refreshStatus(true).catch((err: unknown) => log.error('status refresh failed', err));
      }
    }),
  );

  return bridge;
}
