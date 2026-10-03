/**
 * SDK-facing core of the bridge: one long-lived streaming-input session per chat,
 * plus `runOneShot` for Tab / Ctrl+K / terminal / commit.
 *
 * This file depends only on the Agent SDK and Node (no `vscode`), so it can be
 * exercised from scripts/probe-bridge.mjs against the real CLI.
 *
 * Session design:
 *  - `prompt` is an async generator fed by `InputQueue`; the generator stays open
 *    until `close()`, so the `claude` process lives across turns (research B.5b).
 *  - Every SDKMessage is translated into SessionEvents by `MessageTranslator`.
 *  - `canUseTool` becomes a `permissionRequest` event; the promise is parked in
 *    `pending` until `respondPermission()` (or the CLI's abort signal / close).
 *  - PreToolUse/PostToolUse hooks on Edit|Write|NotebookEdit snapshot the file
 *    before/after and emit `fileChanged`. Hooks never block — except in Ask mode,
 *    where the PreToolUse hook denies edits (hooks run before every other
 *    permission check, so this works whatever the permission mode is).
 */
import { randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import type { ChatMode, EffortLevel, PermissionMode, QuestionSpec } from '../../shared/protocol';
import type { Logger } from '../util/log';
import type { OneShotRequest, PermissionDecision, PermissionRequest, SessionEvent, UserTurn } from './types';
import { BridgeAbortError, errorMessage, isAbortError, loadSdk } from './sdk';
import type {
  CanUseTool,
  HookCallback,
  HookJSONOutput,
  PermissionResult,
  PermissionUpdate,
  SdkOptions,
  SdkQuery,
  SDKControlInterruptResponse,
  SDKMessage,
  SDKUserMessage,
} from './sdk';
import { MessageTranslator } from './translate';
import { defaultPermissionTitle, labelForSuggestion } from './labels';

export const EDIT_TOOLS: readonly string[] = ['Edit', 'Write', 'NotebookEdit'];
const EDIT_TOOL_MATCHER = 'Edit|Write|NotebookEdit';
const ASK_MODE_MESSAGE = 'Kursor is in Ask mode: file edits are disabled. Explain the change instead, or ask the user to switch to Agent mode.';
/** Files above this size are not snapshotted (no fileChanged event; a warning is logged). */
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_SNAPSHOTS = 256;

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

// ---------------------------------------------------------------------------
// Public shapes

export interface SdkSessionSpawnOptions {
  claudePath: string;
  env: Record<string, string | undefined>;
  cwd: string;
  mode: ChatMode;
  permissionMode: PermissionMode;
  model?: string;
  effort?: EffortLevel;
  resume?: string;
  appendSystemPrompt?: string;
  additionalDirectories?: string[];
  /** `--replay-user-messages`: echo user turns with their uuid (checkpoints). Default true. */
  replayUserMessages?: boolean;
}

export interface SdkExitInfo {
  code: number | null;
  signal?: string;
  /** Error text when the read loop ended with an exception (other than an abort). */
  error?: string;
  /** true when we aborted the process ourselves (close()). */
  aborted: boolean;
}

export interface SdkSessionCallbacks {
  onEvent(event: SessionEvent): void;
  /** Called exactly once, when the read loop has ended (process exit or abort). */
  onExit(info: SdkExitInfo): void;
  log: Logger;
}

export interface SdkSession {
  readonly query: SdkQuery;
  /** Claude Code session id, known after the first `init`. */
  readonly sessionId: string | undefined;
  /** The chat mode the process was spawned with (Ask mode spawns without edit tools). */
  readonly spawnedMode: ChatMode;
  readonly closed: boolean;
  readonly pendingPermissionIds: string[];
  send(turn: UserTurn): void;
  interrupt(): Promise<SDKControlInterruptResponse | undefined>;
  /** Returns false when the request is unknown (already answered or from a previous process). */
  respondPermission(requestId: string, decision: PermissionDecision): boolean;
  setAskMode(on: boolean): void;
  /** End the input stream and abort the process. Pending permissions are denied. Idempotent. */
  close(): void;
  /** Resolves when the read loop has ended. */
  readonly done: Promise<void>;
}

// ---------------------------------------------------------------------------
// Input queue → async iterable consumed by the SDK

class InputQueue implements AsyncIterable<SDKUserMessage> {
  private readonly items: SDKUserMessage[] = [];
  private wake: (() => void) | undefined;
  private closed = false;

  push(message: SDKUserMessage): boolean {
    if (this.closed) return false;
    this.items.push(message);
    this.wake?.();
    return true;
  }

  close(): void {
    this.closed = true;
    this.wake?.();
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<SDKUserMessage, void, undefined> {
    for (;;) {
      const next = this.items.shift();
      if (next) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.wake = () => {
          this.wake = undefined;
          resolve();
        };
      });
    }
  }
}

export function toUserMessage(turn: UserTurn): SDKUserMessage {
  type Content = Exclude<SDKUserMessage['message']['content'], string>;
  const content: unknown[] = [];
  if (turn.text.length > 0) content.push({ type: 'text', text: turn.text });
  for (const img of turn.images ?? []) {
    content.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType, data: img.dataBase64 } });
  }
  if (content.length === 0) content.push({ type: 'text', text: '(empty message)' });
  return { type: 'user', message: { role: 'user', content: content as Content }, parent_tool_use_id: null };
}

// ---------------------------------------------------------------------------
// Helpers

export function parseQuestions(input: Dict): QuestionSpec[] | undefined {
  const questions = input.questions;
  if (!Array.isArray(questions)) return undefined;
  return questions.filter(isDict).map((q) => ({
    question: str(q.question) ?? '',
    header: str(q.header) ?? '',
    multiSelect: q.multiSelect === true,
    options: Array.isArray(q.options)
      ? q.options.filter(isDict).map((o) => ({ label: str(o.label) ?? '', description: str(o.description) ?? '' }))
      : [],
  }));
}

function editedPath(toolInput: unknown): string | undefined {
  if (!isDict(toolInput)) return undefined;
  return str(toolInput.file_path) ?? str(toolInput.notebook_path) ?? str(toolInput.path);
}

/** null = does not exist; undefined = unreadable / too large (skip the event). */
async function readSnapshot(filePath: string, log: Logger): Promise<string | null | undefined> {
  try {
    const st = await fs.stat(filePath);
    if (!st.isFile()) return null;
    if (st.size > MAX_SNAPSHOT_BYTES) {
      log.warn(`not snapshotting ${filePath}: ${st.size} bytes exceeds the ${MAX_SNAPSHOT_BYTES} byte limit`);
      return undefined;
    }
    return await fs.readFile(filePath, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    log.warn(`could not read ${filePath} for snapshot: ${errorMessage(err)}`);
    return undefined;
  }
}

export function classifyExit(err: unknown, aborted: boolean): SdkExitInfo {
  if (aborted || isAbortError(err)) return { code: null, aborted: true };
  const message = errorMessage(err);
  const code = /exited with code (\d+)/i.exec(message);
  const signal = /signal (SIG[A-Z0-9]+)/i.exec(message);
  return {
    code: code ? Number(code[1]) : null,
    signal: signal?.[1],
    error: message,
    aborted: false,
  };
}

function permissionKind(toolName: string): PermissionRequest['kind'] {
  if (toolName === 'AskUserQuestion') return 'question';
  if (toolName === 'ExitPlanMode') return 'plan';
  return 'tool';
}

function defaultDenyMessage(kind: PermissionRequest['kind']): string {
  switch (kind) {
    case 'question':
      return 'The user dismissed the question without answering.';
    case 'plan':
      return 'The user rejected the plan.';
    default:
      return 'The user declined this action.';
  }
}

export function toSdkPermissionMode(mode: ChatMode, permissionMode: PermissionMode): PermissionMode {
  if (mode === 'ask') return 'default';
  if (mode === 'plan') return 'plan';
  return permissionMode;
}

// ---------------------------------------------------------------------------
// Session

interface PendingPermission {
  toolName: string;
  toolUseId: string;
  kind: PermissionRequest['kind'];
  input: Dict;
  suggestions: PermissionUpdate[];
  resolve(result: PermissionResult): void;
}

export async function createSdkSession(opts: SdkSessionSpawnOptions, callbacks: SdkSessionCallbacks): Promise<SdkSession> {
  const sdk = await loadSdk();
  const log = callbacks.log;
  const abort = new AbortController();
  const queue = new InputQueue();
  const translator = new MessageTranslator();
  const pending = new Map<string, PendingPermission>();
  const snapshots = new Map<string, { path: string; before: string | null }>();
  let askMode = opts.mode === 'ask';
  let closed = false;
  /** Set by close(): a subsequent process exit is expected, not an error. */
  let closeRequested = false;

  const emit = (event: SessionEvent): void => {
    try {
      callbacks.onEvent(event);
    } catch (err) {
      log.error(`session event handler threw on ${event.type}`, err);
    }
  };

  const denyAll = (message: string): void => {
    for (const [requestId, p] of [...pending]) {
      pending.delete(requestId);
      p.resolve({ behavior: 'deny', message, toolUseID: p.toolUseId, decisionClassification: 'user_reject' });
      emit({ type: 'permissionResolved', requestId, behavior: 'deny' });
    }
  };

  // --- canUseTool → permissionRequest -------------------------------------
  const canUseTool: CanUseTool = (toolName, input, options) =>
    new Promise<PermissionResult>((resolve) => {
      const toolUseId = options.toolUseID;
      if (askMode && EDIT_TOOLS.includes(toolName)) {
        emit({ type: 'permissionDenied', toolUseId, toolName, message: ASK_MODE_MESSAGE });
        resolve({ behavior: 'deny', message: ASK_MODE_MESSAGE, toolUseID: toolUseId, decisionClassification: 'user_reject' });
        return;
      }
      if (closed) {
        resolve({ behavior: 'deny', message: 'The session was closed.', toolUseID: toolUseId, decisionClassification: 'user_reject' });
        return;
      }
      const requestId = options.requestId || randomUUID();
      const suggestions = options.suggestions ?? [];
      const kind = permissionKind(toolName);
      const request: PermissionRequest = {
        requestId,
        toolUseId,
        toolName,
        input,
        kind,
        title: options.title ?? defaultPermissionTitle(toolName, input),
        description: options.description,
        suggestions: suggestions.map((s, index) => ({ label: labelForSuggestion(s), index })),
        blockedPath: options.blockedPath,
        decisionReason: options.decisionReason,
        questions: kind === 'question' ? parseQuestions(input) : undefined,
        plan: kind === 'plan' ? str(input.plan) : undefined,
      };
      const entry: PendingPermission = {
        toolName,
        toolUseId,
        kind,
        input,
        suggestions,
        resolve: (result) => {
          pending.delete(requestId);
          resolve(result);
        },
      };
      pending.set(requestId, entry);
      const onAbort = (): void => {
        if (!pending.has(requestId)) return;
        entry.resolve({ behavior: 'deny', message: 'The request was cancelled.', toolUseID: toolUseId, decisionClassification: 'user_reject' });
        emit({ type: 'permissionResolved', requestId, behavior: 'deny' });
      };
      if (options.signal.aborted) onAbort();
      else options.signal.addEventListener('abort', onAbort, { once: true });
      emit({ type: 'permissionRequest', request });
    });

  // --- hooks: file snapshots ---------------------------------------------
  const pruneSnapshots = (): void => {
    while (snapshots.size > MAX_SNAPSHOTS) {
      const oldest = snapshots.keys().next().value;
      if (oldest === undefined) break;
      snapshots.delete(oldest);
    }
  };

  const preToolUse: HookCallback = async (input, toolUseId): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    if (askMode && EDIT_TOOLS.includes(input.tool_name)) {
      emit({ type: 'permissionDenied', toolUseId: toolUseId ?? input.tool_use_id, toolName: input.tool_name, message: ASK_MODE_MESSAGE });
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: ASK_MODE_MESSAGE } };
    }
    const id = toolUseId ?? input.tool_use_id;
    const filePath = editedPath(input.tool_input);
    if (!id || !filePath) return {};
    try {
      const before = await readSnapshot(filePath, log);
      if (before !== undefined) {
        snapshots.set(id, { path: filePath, before });
        pruneSnapshots();
      }
    } catch (err) {
      log.warn(`PreToolUse snapshot failed for ${filePath}: ${errorMessage(err)}`);
    }
    return {};
  };

  const postToolUse: HookCallback = async (input, toolUseId): Promise<HookJSONOutput> => {
    if (input.hook_event_name !== 'PostToolUse') return {};
    const id = toolUseId ?? input.tool_use_id;
    const snap = id ? snapshots.get(id) : undefined;
    if (id) snapshots.delete(id);
    const filePath = snap?.path ?? editedPath(input.tool_input);
    if (!id || !filePath) return {};
    if (!snap) {
      log.warn(`PostToolUse for ${filePath} without a PreToolUse snapshot; not reporting the change`);
      return {};
    }
    try {
      const after = await readSnapshot(filePath, log);
      if (after !== undefined) {
        emit({ type: 'fileChanged', path: filePath, before: snap.before, after, toolUseId: id, toolName: input.tool_name });
      }
    } catch (err) {
      log.warn(`PostToolUse snapshot failed for ${filePath}: ${errorMessage(err)}`);
    }
    return {};
  };

  const postToolUseFailure: HookCallback = async (input, toolUseId): Promise<HookJSONOutput> => {
    if (input.hook_event_name === 'PostToolUseFailure') {
      const id = toolUseId ?? input.tool_use_id;
      if (id) snapshots.delete(id);
    }
    return {};
  };

  // --- options ------------------------------------------------------------
  const bypass = opts.mode === 'agent' && opts.permissionMode === 'bypassPermissions';
  const options: SdkOptions = {
    pathToClaudeCodeExecutable: opts.claudePath,
    cwd: opts.cwd,
    env: opts.env,
    abortController: abort,
    permissionMode: toSdkPermissionMode(opts.mode, opts.permissionMode),
    // Enables bypassPermissions as an *option* (also for a later setPermissionMode); the mode itself decides.
    allowDangerouslySkipPermissions: true,
    ...(opts.mode === 'ask' ? { disallowedTools: [...EDIT_TOOLS] } : {}),
    model: opts.model || undefined,
    effort: opts.effort || undefined,
    resume: opts.resume || undefined,
    includePartialMessages: true,
    enableFileCheckpointing: true,
    settingSources: ['user', 'project', 'local'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: opts.appendSystemPrompt || undefined },
    additionalDirectories: opts.additionalDirectories?.length ? opts.additionalDirectories : undefined,
    stderr: (data: string) => {
      const line = data.trimEnd();
      if (line) log.debug(`[claude stderr] ${line}`);
    },
    canUseTool,
    hooks: {
      PreToolUse: [{ matcher: EDIT_TOOL_MATCHER, hooks: [preToolUse] }],
      PostToolUse: [{ matcher: EDIT_TOOL_MATCHER, hooks: [postToolUse] }],
      PostToolUseFailure: [{ matcher: EDIT_TOOL_MATCHER, hooks: [postToolUseFailure] }],
    },
    extraArgs: opts.replayUserMessages === false ? undefined : { 'replay-user-messages': null },
  };
  if (bypass) log.warn('agent session started with permissionMode=bypassPermissions');

  const query = sdk.query({ prompt: queue, options });

  // --- read loop ----------------------------------------------------------
  const done = (async (): Promise<void> => {
    let exit: SdkExitInfo = { code: 0, aborted: false };
    try {
      for await (const message of query as AsyncIterable<SDKMessage>) {
        for (const event of translator.translate(message)) emit(event);
      }
      if (closeRequested) exit = { code: 0, aborted: true };
    } catch (err) {
      exit = classifyExit(err, abort.signal.aborted || closeRequested);
      if (!exit.aborted) log.error(`session read loop ended: ${exit.error ?? 'unknown error'}`);
    } finally {
      closed = true;
      queue.close();
      denyAll('Claude Code exited before this request was answered.');
      try {
        callbacks.onExit(exit);
      } catch (err) {
        log.error('onExit handler threw', err);
      }
    }
  })();

  const session: SdkSession = {
    query,
    get sessionId() {
      return translator.sessionId;
    },
    spawnedMode: opts.mode,
    get closed() {
      return closed;
    },
    get pendingPermissionIds() {
      return [...pending.keys()];
    },
    send(turn) {
      if (closed) throw new Error('The session is closed');
      queue.push(toUserMessage(turn));
    },
    async interrupt() {
      if (closed) return undefined;
      try {
        return await query.interrupt();
      } catch (err) {
        log.debug(`interrupt failed: ${errorMessage(err)}`);
        return undefined;
      }
    },
    respondPermission(requestId, decision) {
      const p = pending.get(requestId);
      if (!p) return false;
      let result: PermissionResult;
      if (decision.behavior === 'allow') {
        const updatedInput = decision.updatedInput ? { ...p.input, ...decision.updatedInput } : p.input;
        const suggestion = decision.suggestionIndex !== undefined ? p.suggestions[decision.suggestionIndex] : undefined;
        result = {
          behavior: 'allow',
          updatedInput,
          updatedPermissions: suggestion ? [suggestion] : undefined,
          toolUseID: p.toolUseId,
          decisionClassification: suggestion ? 'user_permanent' : 'user_temporary',
        };
      } else {
        result = {
          behavior: 'deny',
          message: decision.message?.trim() || defaultDenyMessage(p.kind),
          interrupt: decision.interrupt,
          toolUseID: p.toolUseId,
          decisionClassification: 'user_reject',
        };
      }
      p.resolve(result);
      emit({ type: 'permissionResolved', requestId, behavior: result.behavior });
      return true;
    },
    setAskMode(on) {
      askMode = on;
    },
    close() {
      if (closed) return;
      closed = true;
      closeRequested = true;
      queue.close();
      denyAll('The session was closed.');
      abort.abort();
      try {
        query.close();
      } catch {
        /* already closed */
      }
    },
    done,
  };
  return session;
}

// ---------------------------------------------------------------------------
// One-shot (Tab / Ctrl+K / terminal / commit)

export interface OneShotSpawn {
  claudePath: string;
  env: Record<string, string | undefined>;
  log: Logger;
}

export async function runOneShot(request: OneShotRequest, spawn: OneShotSpawn): Promise<string> {
  const sdk = await loadSdk();
  if (request.signal?.aborted) throw new BridgeAbortError();
  const abort = new AbortController();
  const onAbort = (): void => abort.abort();
  request.signal?.addEventListener('abort', onAbort, { once: true });
  const log = spawn.log;

  const options: SdkOptions = {
    pathToClaudeCodeExecutable: spawn.claudePath,
    env: spawn.env,
    cwd: request.cwd,
    abortController: abort,
    systemPrompt: request.systemPrompt,
    tools: request.allowTools?.length ? request.allowTools : [],
    maxTurns: request.maxTurns ?? 1,
    persistSession: false,
    settingSources: [],
    permissionMode: 'default',
    permissionPrompts: 'none',
    model: request.model || undefined,
    effort: request.effort || undefined,
    includePartialMessages: !!request.onDelta,
    thinking: request.thinking ? undefined : { type: 'disabled' },
    stderr: (data: string) => {
      const line = data.trimEnd();
      if (line) log.debug(`[claude stderr] ${line}`);
    },
  };

  let streamed = '';
  let lastMessageId: string | undefined;
  let lastText = '';
  let resultText: string | undefined;
  let isError = false;
  let errors: string[] = [];
  let sawResult = false;

  try {
    const query = sdk.query({ prompt: request.prompt, options });
    for await (const raw of query as AsyncIterable<SDKMessage>) {
      if (abort.signal.aborted) break;
      const m = raw as unknown as Dict;
      switch (m.type) {
        case 'stream_event': {
          if (m.parent_tool_use_id) break;
          const ev = isDict(m.event) ? m.event : {};
          if (ev.type !== 'content_block_delta') break;
          const delta = isDict(ev.delta) ? ev.delta : {};
          if (delta.type === 'text_delta' && typeof delta.text === 'string' && delta.text) {
            streamed += delta.text;
            try {
              request.onDelta?.(delta.text);
            } catch (err) {
              log.warn(`onDelta threw: ${errorMessage(err)}`);
            }
          }
          break;
        }
        case 'assistant': {
          if (m.parent_tool_use_id) break;
          const message = isDict(m.message) ? m.message : {};
          const id = str(message.id);
          if (id !== lastMessageId) {
            lastMessageId = id;
            lastText = '';
          }
          const content = Array.isArray(message.content) ? message.content : [];
          for (const block of content) {
            if (isDict(block) && block.type === 'text' && typeof block.text === 'string') lastText += block.text;
          }
          const apiError = str(m.error);
          if (apiError && content.length === 0) errors.push(apiError);
          break;
        }
        case 'result': {
          sawResult = true;
          isError = m.is_error === true;
          resultText = str(m.result);
          if (Array.isArray(m.errors)) errors = [...errors, ...m.errors.filter((e): e is string => typeof e === 'string')];
          if (typeof m.startup_failure_reason === 'string') errors.push(`startup failure: ${m.startup_failure_reason}`);
          break;
        }
        default:
          break;
      }
    }
  } catch (err) {
    if (abort.signal.aborted || isAbortError(err)) throw new BridgeAbortError();
    throw err instanceof Error ? err : new Error(errorMessage(err));
  } finally {
    request.signal?.removeEventListener('abort', onAbort);
  }

  if (abort.signal.aborted) throw new BridgeAbortError();
  if (isError) {
    const detail = errors.length ? errors.join('; ') : resultText || 'Claude Code returned an error';
    throw new Error(detail);
  }
  if (!sawResult && !lastText && !streamed) throw new Error('Claude Code exited without producing a result');
  return resultText && resultText.length > 0 ? resultText : lastText || streamed;
}
