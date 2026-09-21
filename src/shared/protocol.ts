/**
 * Kursor — shared contract between the extension host and the chat webview.
 * This file is imported by BOTH bundles. Keep it free of `vscode` and Node imports.
 *
 * Ownership: the extension host is the source of truth for all chat state.
 * The webview renders `ChatState` and sends intents back. Text streaming is
 * delivered incrementally with `textDelta`; every structural change is a full
 * `chatState` replace (simple, robust, no ordering bugs).
 */

export type ChatMode = 'agent' | 'ask' | 'plan';
export type PermissionMode = 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan' | 'dontAsk' | 'auto';
/** waiting = blocked on the user (permission card, question card, plan approval). */
export type ChatStatus = 'idle' | 'starting' | 'running' | 'waiting' | 'error';
export type EffortLevel = '' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

export interface ModelOption {
  /** value passed to Claude Code, e.g. "sonnet", "opus[1m]", "claude-fable-5-1[1m]", "" for default */
  value: string;
  label: string;
  description?: string;
  resolvedModel?: string;
  supportsEffort?: boolean;
  effortLevels?: string[];
}

export interface SlashCommandOption {
  name: string;
  description: string;
  argumentHint?: string;
}

export type MentionKind = 'file' | 'folder' | 'code' | 'problems' | 'terminal' | 'git' | 'web' | 'docs' | 'rule' | 'command' | 'category';

/** A context item attached to a user message (rendered as a pill). */
export interface Attachment {
  id: string;
  kind: 'file' | 'folder' | 'selection' | 'image' | 'problems' | 'terminal' | 'git' | 'url' | 'rule' | 'diagnostic';
  /** Short label shown in the pill, e.g. "auth.ts", "auth.ts:10-42", "Problems", "diagram.png" */
  label: string;
  /** Absolute path for file/folder/selection/rule/diagnostic. */
  path?: string;
  /** Workspace-relative path when inside a workspace folder. */
  relPath?: string;
  /** 1-based inclusive line range for selections/diagnostics. */
  range?: { startLine: number; endLine: number };
  /** Inline text payload (selection text, terminal output, diff, diagnostics list…). */
  text?: string;
  url?: string;
  image?: { mediaType: string; dataBase64: string; name: string };
}

export interface MentionResult {
  kind: MentionKind;
  label: string;
  detail?: string;
  path?: string;
  relPath?: string;
  /** codicon id without the "codicon-" prefix, e.g. "file", "folder", "warning" */
  icon?: string;
  /** For kind === 'command': the slash command name. For 'category': the kind to drill into. */
  value?: string;
}

export interface EditSummary {
  path: string;
  relPath: string;
  additions: number;
  deletions: number;
  isNew: boolean;
  isDeleted: boolean;
  status: 'pending' | 'kept' | 'undone';
  /** Number of pending hunks still shown in the editor (when inline diffs are on). */
  hunks?: number;
}

export interface PermissionSuggestion {
  /** Human label, e.g. "Always allow `npm test` in this project" */
  label: string;
  /** Opaque index into the bridge's PermissionUpdate[] for this request. */
  index: number;
}

export interface QuestionSpec {
  question: string;
  header: string;
  options: { label: string; description: string }[];
  multiSelect: boolean;
}

export type Block =
  | { type: 'text'; id: string; text: string }
  | { type: 'thinking'; id: string; text: string; done: boolean; startedAt: number; endedAt?: number }
  | {
      type: 'tool';
      /** tool_use_id */
      id: string;
      name: string;
      input: unknown;
      /** true while the tool input JSON is still streaming */
      inputStreaming?: boolean;
      status: 'running' | 'done' | 'error' | 'denied';
      output?: string;
      outputTruncated?: boolean;
      startedAt: number;
      endedAt?: number;
      /** Populated for Edit/Write/NotebookEdit once the file change is known. */
      edit?: EditSummary;
      /** Set when this tool call was made by a subagent (Task tool). */
      parentToolUseId?: string | null;
      subagent?: { type?: string; description?: string; status?: string; summary?: string };
    }
  | {
      type: 'permission';
      /** requestId from the bridge */
      id: string;
      toolUseId: string;
      toolName: string;
      input: unknown;
      title?: string;
      description?: string;
      suggestions: PermissionSuggestion[];
      blockedPath?: string;
      decisionReason?: string;
      decision?: 'allow' | 'deny' | 'always';
    }
  | { type: 'question'; id: string; questions: QuestionSpec[]; answers?: Record<string, string> }
  | { type: 'plan'; id: string; plan: string; decision?: 'build' | 'reject' }
  | { type: 'todo'; id: string; items: { content: string; status: 'pending' | 'in_progress' | 'completed' }[] };

export interface UserMessage {
  kind: 'user';
  id: string;
  /** Claude Code's uuid for this user turn (enables "Restore checkpoint"). */
  uuid?: string;
  text: string;
  attachments: Attachment[];
  timestamp: number;
  /** true when a file checkpoint can be restored to the state before this message */
  canRestore: boolean;
  /** true while queued behind a running turn */
  queued?: boolean;
}

export interface AssistantMessage {
  kind: 'assistant';
  id: string;
  blocks: Block[];
  streaming: boolean;
  timestamp: number;
  model?: string;
  /** Result of the turn once finished. */
  result?: { costUsd?: number; durationMs?: number; numTurns?: number; isError: boolean; errorText?: string };
}

export interface SystemNote {
  kind: 'system';
  id: string;
  text: string;
  level: 'info' | 'warning' | 'error';
  timestamp: number;
  /** Optional action button, executes a VS Code command. */
  action?: { label: string; command: string; args?: unknown[] };
}

export type ChatMessage = UserMessage | AssistantMessage | SystemNote;

export interface ContextUsage {
  usedTokens: number;
  maxTokens: number;
  /** 0..100 */
  percent: number;
  breakdown?: { label: string; tokens: number }[];
}

export interface ChatState {
  id: string;
  title: string;
  sessionId?: string;
  cwd?: string;
  mode: ChatMode;
  permissionMode: PermissionMode;
  /** '' = Claude Code default */
  model: string;
  effort: EffortLevel;
  status: ChatStatus;
  /** Set when status === 'error' or the last turn failed. */
  error?: string;
  messages: ChatMessage[];
  pendingEdits: EditSummary[];
  contextUsage?: ContextUsage;
  rateLimit?: { fiveHour?: number; sevenDay?: number; resetsAt?: number; status?: string };
  totalCostUsd?: number;
  createdAt: number;
  updatedAt: number;
  unread?: boolean;
}

export interface ChatSummary {
  id: string;
  title: string;
  status: ChatStatus;
  unread?: boolean;
  updatedAt: number;
}

export interface HistoryEntry {
  sessionId: string;
  title: string;
  cwd?: string;
  updatedAt: number;
  messageCount?: number;
  /** Set when this session is currently open as a chat tab. */
  chatId?: string;
}

export interface AppState {
  chats: ChatSummary[];
  activeChatId: string | null;
  models: ModelOption[];
  commands: SlashCommandOption[];
  claude: {
    ready: boolean;
    version?: string;
    path?: string;
    loggedIn?: boolean;
    email?: string;
    subscriptionType?: string;
    error?: string;
  };
  settings: {
    showThinking: boolean;
    toolCallDensity: 'compact' | 'balanced' | 'detailed';
    defaultMode: ChatMode;
    permissionMode: PermissionMode;
    inlineDiffs: boolean;
  };
  workspaceName?: string;
  workspaceFolder?: string;
}

export type HostToWebview =
  | { type: 'appState'; state: AppState }
  | { type: 'chatState'; chat: ChatState }
  | { type: 'textDelta'; chatId: string; messageId: string; blockId: string; delta: string }
  | { type: 'mentionResults'; requestId: string; results: MentionResult[] }
  | { type: 'history'; sessions: HistoryEntry[] }
  | { type: 'showHistory' }
  | { type: 'focusInput' }
  | { type: 'insertText'; text: string }
  | { type: 'addAttachment'; attachment: Attachment }
  | { type: 'toast'; level: 'info' | 'warning' | 'error'; text: string };

export type WebviewToHost =
  | { type: 'ready' }
  | { type: 'send'; chatId: string; text: string; attachments: Attachment[]; sendNow?: boolean }
  | { type: 'stop'; chatId: string }
  | { type: 'newChat' }
  | { type: 'switchChat'; chatId: string }
  | { type: 'closeChat'; chatId: string }
  | { type: 'renameChat'; chatId: string; title: string }
  | { type: 'setMode'; chatId: string; mode: ChatMode }
  | { type: 'setModel'; chatId: string; model: string }
  | { type: 'setEffort'; chatId: string; effort: EffortLevel }
  | { type: 'setPermissionMode'; chatId: string; permissionMode: PermissionMode }
  | { type: 'permission'; chatId: string; requestId: string; decision: 'allow' | 'deny' | 'always'; suggestionIndex?: number; updatedInput?: unknown }
  | { type: 'question'; chatId: string; requestId: string; answers: Record<string, string> }
  | { type: 'plan'; chatId: string; requestId: string; decision: 'build' | 'reject'; feedback?: string }
  | { type: 'searchMentions'; requestId: string; query: string; kind?: MentionKind }
  | { type: 'openFile'; path: string; line?: number; endLine?: number }
  | { type: 'openUrl'; url: string }
  | { type: 'edits'; action: 'keep' | 'undo' | 'review'; path?: string }
  | { type: 'restoreCheckpoint'; chatId: string; messageId: string }
  | { type: 'codeAction'; action: 'apply' | 'insert' | 'copy' | 'run' | 'newFile'; code: string; language?: string; path?: string }
  | { type: 'exportChat'; chatId: string }
  | { type: 'openSettings' }
  | { type: 'openHistory' }
  | { type: 'resumeSession'; sessionId: string }
  | { type: 'deleteSession'; sessionId: string }
  | { type: 'pickImage' }
  | { type: 'runCommand'; command: string; args?: unknown[] }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string };

/** Persisted webview UI state (vscode.getState/setState) — never chat content. */
export interface WebviewUiState {
  draft?: string;
  activeChatId?: string | null;
  collapsedThinking?: boolean;
}
