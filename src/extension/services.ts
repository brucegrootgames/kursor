/**
 * Cross-module service interfaces. Each module exports a `register*`/`create*`
 * function (see extension.ts) and may depend only on these interfaces, never on
 * another module's internals.
 */
import type * as vscode from 'vscode';
import type { Attachment, ChatMode, EditSummary } from '../shared/protocol';
import type { ClaudeBridge } from './claude/types';
import type { Logger } from './util/log';

export interface RuleInfo {
  name: string;
  path: string;
  /** 'always' | 'auto' (globs) | 'agent' (description) | 'manual' | 'legacy' (.cursorrules) | 'agents-md' */
  kind: 'always' | 'auto' | 'agent' | 'manual' | 'legacy' | 'agents-md';
  description?: string;
  globs?: string[];
}

export interface RulesService extends vscode.Disposable {
  /** Markdown appended to Claude Code's system prompt for a session: user rules + always rules + auto rules matching contextPaths + index of agent/manual rules. */
  buildAppendix(cwd: string, contextPaths?: string[]): Promise<string>;
  listProjectRules(cwd: string): Promise<RuleInfo[]>;
  userRules(): string;
  readonly onDidChange: vscode.Event<void>;
}

export interface FileChange {
  path: string;
  /** null when the file did not exist before */
  before: string | null;
  /** null when the file was deleted */
  after: string | null;
  toolUseId: string;
}

export interface EditTracker extends vscode.Disposable {
  /** Record a change made by the agent. Consecutive changes to the same file are coalesced (base stays the first `before`). */
  recordChange(chatId: string, change: FileChange): void;
  pending(chatId?: string): EditSummary[];
  /** Keep (accept) pending edits: all, or a single file. */
  keep(path?: string): Promise<void>;
  /** Undo (revert to base): all, or a single file. */
  undo(path?: string): Promise<void>;
  /** Open a diff editor (base ↔ current) for one file, or a multi-file review for all. */
  review(path?: string): Promise<void>;
  /** Forget pending edits (e.g. after a checkpoint restore). */
  clear(chatId?: string): void;
  readonly onDidChange: vscode.Event<void>;
}

export interface ChatController {
  /** Reveal the chat view. */
  open(options?: { newChat?: boolean; focus?: boolean }): Promise<void>;
  /** Attach context to the active (or a new) chat and focus the input. */
  addAttachment(attachment: Attachment, options?: { newChat?: boolean; focus?: boolean }): Promise<void>;
  /** Send a prompt programmatically (Fix in Chat, Explain, terminal Debug…). */
  sendPrompt(text: string, attachments?: Attachment[], options?: { newChat?: boolean; mode?: ChatMode }): Promise<void>;
  /** Insert text into the chat input without sending. */
  insertText(text: string): Promise<void>;
  /** Focus the chat input. */
  focusInput(): Promise<void>;
}

export interface BaseDeps {
  log: Logger;
}
export interface BridgeDeps extends BaseDeps {
  bridge: ClaudeBridge;
}
export interface ChatDeps extends BridgeDeps {
  rules: RulesService;
  edits: EditTracker;
}
export interface InlineDeps extends BridgeDeps {
  rules: RulesService;
  chat: ChatController;
}
export interface TerminalDeps extends BridgeDeps {
  chat: ChatController;
}
export interface ActionsDeps extends BaseDeps {
  chat: ChatController;
}
export interface SettingsDeps extends BridgeDeps {
  rules: RulesService;
}
export interface IdeDeps extends BaseDeps {
  edits: EditTracker;
}
