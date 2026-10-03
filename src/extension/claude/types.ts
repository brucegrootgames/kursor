/**
 * ClaudeBridge — the single place that talks to the Claude Code CLI.
 * Implemented in src/extension/claude/bridge.ts using @anthropic-ai/claude-agent-sdk
 * with `pathToClaudeCodeExecutable` pointed at the user's own `claude` binary.
 * Everything else in the extension programs against these interfaces.
 */
import type * as vscode from 'vscode';
import type { ChatMode, EffortLevel, HistoryEntry, ModelOption, PermissionMode, QuestionSpec, SlashCommandOption } from '../../shared/protocol';

export interface SessionStartOptions {
  cwd: string;
  mode: ChatMode;
  permissionMode: PermissionMode;
  /** '' or undefined = Claude Code default */
  model?: string;
  effort?: EffortLevel;
  /** Claude Code session id to resume. */
  resume?: string;
  /** Extra system prompt text (rules, IDE context). Appended to Claude Code's default prompt. */
  appendSystemPrompt?: string;
  /** Additional directories the agent may access (multi-root workspaces). */
  additionalDirectories?: string[];
}

export interface UserTurn {
  text: string;
  images?: { mediaType: string; dataBase64: string }[];
}

export interface PermissionRequest {
  requestId: string;
  toolUseId: string;
  toolName: string;
  input: Record<string, unknown>;
  /** 'question' for AskUserQuestion, 'plan' for ExitPlanMode, otherwise 'tool'. */
  kind: 'tool' | 'question' | 'plan';
  title?: string;
  description?: string;
  /** Human-readable "always allow" style suggestions, index-aligned with the SDK's PermissionUpdate[]. */
  suggestions: { label: string; index: number }[];
  blockedPath?: string;
  decisionReason?: string;
  /** Parsed for kind === 'question'. */
  questions?: QuestionSpec[];
  /** Markdown plan for kind === 'plan'. */
  plan?: string;
}

export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown>; /** apply one of request.suggestions (remember) */ suggestionIndex?: number }
  | { behavior: 'deny'; message?: string; interrupt?: boolean };

export type SessionEvent =
  | { type: 'init'; sessionId: string; model: string; tools: string[]; permissionMode: PermissionMode; claudeVersion?: string }
  | { type: 'status'; status: 'requesting' | 'compacting' | 'idle'; /** e.g. "Retrying (2/10) after HTTP 529 in 3 s" for system/api_retry */ detail?: string }
  /** Echo of a user turn with the uuid Claude Code assigned (for checkpoints / rewind). */
  | { type: 'userReplay'; uuid: string; text: string }
  | { type: 'streamStart'; messageId: string; parentToolUseId: string | null }
  | { type: 'blockStart'; messageId: string; index: number; blockType: 'text' | 'thinking' | 'tool_use'; toolUseId?: string; toolName?: string }
  | { type: 'blockDelta'; messageId: string; index: number; kind: 'text' | 'thinking' | 'input_json'; delta: string }
  | { type: 'blockStop'; messageId: string; index: number }
  /** Complete, authoritative content block (always emitted, also when partial streaming is off). */
  | {
      type: 'assistantBlock';
      messageId: string;
      userMessageUuid?: string;
      parentToolUseId: string | null;
      block:
        | { type: 'text'; text: string }
        | { type: 'thinking'; thinking: string }
        | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> };
      error?: string;
    }
  | { type: 'toolResult'; toolUseId: string; content: string; isError: boolean; raw?: unknown; parentToolUseId: string | null }
  | { type: 'permissionRequest'; request: PermissionRequest }
  | { type: 'permissionResolved'; requestId: string; behavior: 'allow' | 'deny' }
  | { type: 'permissionDenied'; toolUseId: string; toolName: string; message: string }
  /** From PreToolUse/PostToolUse hooks on Edit/Write/NotebookEdit. before === null → file did not exist. after === null → deleted. */
  | { type: 'fileChanged'; path: string; before: string | null; after: string | null; toolUseId: string; toolName: string }
  | { type: 'task'; taskId: string; toolUseId?: string; description: string; subagentType?: string; phase: 'started' | 'progress' | 'done'; summary?: string; lastTool?: string }
  | { type: 'thinkingProgress'; estimatedTokens: number }
  | { type: 'compacted'; preTokens: number; postTokens?: number }
  | {
      type: 'result';
      subtype: string;
      isError: boolean;
      result?: string;
      errors?: string[];
      costUsd: number;
      durationMs: number;
      numTurns: number;
      permissionDenials: { toolName: string; toolUseId: string }[];
      terminalReason?: string;
      /** Turns still queued behind this one (Claude Code `queued_turn_count`); `running` stays true while > 0. */
      queuedTurnCount?: number;
    }
  | { type: 'rateLimit'; status: string; fiveHour?: number; sevenDay?: number; resetsAt?: number }
  | { type: 'error'; message: string; fatal: boolean }
  | { type: 'exit'; code: number | null };

export interface RewindResult {
  canRewind: boolean;
  filesChanged?: string[];
  error?: string;
}

export interface ClaudeSession extends vscode.Disposable {
  readonly id: string;
  /** Claude Code session id, known after the 'init' event. */
  readonly sessionId: string | undefined;
  readonly onEvent: vscode.Event<SessionEvent>;
  /** true while a turn is being processed (between send and result). */
  readonly running: boolean;
  /** Queue a user turn. If a turn is running, Claude Code queues it (Cursor "queued message"). */
  send(turn: UserTurn): void;
  /** Stop the current turn (keeps the process alive). */
  interrupt(): Promise<void>;
  respondPermission(requestId: string, decision: PermissionDecision): void;
  setModel(model: string): Promise<void>;
  setEffort(effort: EffortLevel): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  /**
   * Switch the chat mode of a live session: 'ask' denies Edit/Write/NotebookEdit (hook + canUseTool) and uses
   * permission mode `default`; 'plan' uses permission mode `plan`; 'agent' restores the configured permission mode.
   * A session spawned in 'ask' mode is transparently re-spawned (with resume) on the next send after leaving 'ask'.
   */
  setMode?(mode: ChatMode): Promise<void>;
  /** Restore files to their state before the given user message (Claude Code file checkpointing). */
  rewindFiles(userMessageUuid: string, dryRun?: boolean): Promise<RewindResult>;
  contextUsage(): Promise<{ usedTokens: number; maxTokens: number; breakdown?: { label: string; tokens: number }[] } | undefined>;
  supportedModels(): Promise<ModelOption[]>;
  supportedCommands(): Promise<SlashCommandOption[]>;
}

export interface OneShotRequest {
  /** Replaces Claude Code's default system prompt (keeps requests small and fast). */
  systemPrompt: string;
  prompt: string;
  model?: string;
  cwd?: string;
  signal?: AbortSignal;
  onDelta?: (text: string) => void;
  /** default 1 */
  maxTurns?: number;
  effort?: EffortLevel;
  /** Tool names to allow; default none (pure text generation). */
  allowTools?: string[];
  /** Keep the model's extended thinking on. Default false (`--thinking disabled`: faster, cheaper for completions/edits). */
  thinking?: boolean;
}

export interface ClaudeStatus {
  ok: boolean;
  path?: string;
  version?: string;
  loggedIn?: boolean;
  email?: string;
  subscriptionType?: string;
  error?: string;
}

export interface ClaudeBridge extends vscode.Disposable {
  /** Resolve the `claude` executable: setting → login-shell PATH → ~/.local/bin/claude → mise shims. */
  resolveClaudePath(): Promise<string | undefined>;
  /** Runs `claude --version` and `claude auth status --json`. Cached; refresh() re-checks. */
  status(): Promise<ClaudeStatus>;
  refreshStatus(): Promise<ClaudeStatus>;
  readonly onDidChangeStatus: vscode.Event<ClaudeStatus>;
  createSession(options: SessionStartOptions): ClaudeSession;
  /** Single request without tools (Tab, Ctrl+K, terminal, commit). Rejects with AbortError on cancellation. */
  oneShot(request: OneShotRequest): Promise<string>;
  /** Past Claude Code sessions for this workspace (for History). */
  listSessions(cwd: string): Promise<HistoryEntry[]>;
  /** Transcript of a past session, normalized for display. */
  getSessionTranscript(sessionId: string, cwd: string): Promise<{ role: 'user' | 'assistant'; text: string; timestamp?: number }[]>;
  deleteSession(sessionId: string, cwd: string): Promise<void>;
}
