/**
 * Kursor — shared contract between the extension host and the "Kursor Settings" webview panel.
 * Imported by BOTH bundles (src/extension/settings and src/webview-settings). Keep it free of
 * `vscode` and Node imports.
 *
 * Ownership: the host is the source of truth. It reads `kursor.*` from the VS Code configuration
 * and pushes full `SettingsValues` snapshots; the panel renders them and posts `setSetting`
 * intents, which the host writes to `ConfigurationTarget.Global`. Every change made elsewhere
 * (settings editor, settings.json, another window) comes back through `onDidChangeConfiguration`
 * as a fresh snapshot, so the panel never has to guess.
 */
import type { ChatMode, EffortLevel } from './protocol';

export type SettingsTab = 'general' | 'agents' | 'tab' | 'models' | 'rules' | 'indexing' | 'about';
export const SETTINGS_TABS: readonly SettingsTab[] = ['general', 'agents', 'tab', 'models', 'rules', 'indexing', 'about'];

export type AgentPermissionMode = 'acceptEdits' | 'default' | 'auto' | 'bypassPermissions';
export type ToolCallDensity = 'compact' | 'balanced' | 'detailed';

/** Every `kursor.*` setting declared in package.json, keyed without the `kursor.` prefix. */
export interface SettingsValues {
  'claude.path': string;
  'claude.model': string;
  'claude.effort': EffortLevel;
  'agent.defaultMode': ChatMode;
  'agent.permissionMode': AgentPermissionMode;
  'agent.inlineDiffs': boolean;
  'agent.autoSave': boolean;
  'agent.attachOpenFile': boolean;
  'agent.notifyOnPermission': boolean;
  'tab.enabled': boolean;
  'tab.debounceMs': number;
  'tab.model': string;
  'tab.disabledLanguages': string[];
  'tab.contextLines': number;
  'inlineEdit.model': string;
  'terminal.model': string;
  'commit.model': string;
  'rules.user': string;
  'rules.useProjectRules': boolean;
  'ide.enableServer': boolean;
  'chat.showThinking': boolean;
  'chat.toolCallDensity': ToolCallDensity;
}

export type SettingKey = keyof SettingsValues;

export const SETTING_KEYS: readonly SettingKey[] = [
  'claude.path',
  'claude.model',
  'claude.effort',
  'agent.defaultMode',
  'agent.permissionMode',
  'agent.inlineDiffs',
  'agent.autoSave',
  'agent.attachOpenFile',
  'agent.notifyOnPermission',
  'tab.enabled',
  'tab.debounceMs',
  'tab.model',
  'tab.disabledLanguages',
  'tab.contextLines',
  'inlineEdit.model',
  'terminal.model',
  'commit.model',
  'rules.user',
  'rules.useProjectRules',
  'ide.enableServer',
  'chat.showThinking',
  'chat.toolCallDensity',
];

/**
 * Where a setting's effective value comes from. The panel always writes the user (global) value;
 * when a workspace or folder override exists the write is shadowed, so the panel shows a hint.
 */
export type SettingScope = 'default' | 'global' | 'workspace' | 'workspaceFolder';

export interface SettingMeta {
  key: SettingKey;
  /** Default from package.json. */
  defaultValue: SettingsValues[SettingKey];
  /** Scope that currently provides the effective value. */
  scope: SettingScope;
  /** Plain-text description from package.json (markdown stripped). */
  description?: string;
  enumValues?: string[];
  enumDescriptions?: string[];
  minimum?: number;
}

export interface ClaudeStatusInfo {
  ok: boolean;
  path?: string;
  version?: string;
  loggedIn?: boolean;
  email?: string;
  subscriptionType?: string;
  error?: string;
  /** true while `refreshStatus()` is in flight. */
  checking: boolean;
  /** Epoch ms of the last completed probe. */
  checkedAt?: number;
}

export type RuleKind = 'always' | 'auto' | 'agent' | 'manual' | 'legacy' | 'agents-md';

export interface RuleListItem {
  name: string;
  path: string;
  /** Path relative to the selected workspace folder. */
  relPath: string;
  kind: RuleKind;
  description?: string;
  globs?: string[];
}

export interface WorkspaceFolderInfo {
  name: string;
  path: string;
}

export interface WorkspaceInfo {
  folders: WorkspaceFolderInfo[];
  /** Folder whose rules / ignore files the panel shows (undefined when no folder is open). */
  cwd?: string;
  cursorignore: { path: string; exists: boolean } | null;
  gitignore: { path: string; exists: boolean } | null;
}

export interface AboutInfo {
  extensionVersion: string;
  extensionPath: string;
  appName: string;
  appVersion: string;
  /** e.g. "linux" */
  platform: string;
  uiKind: 'desktop' | 'web';
  links: { label: string; url: string; icon?: string }[];
}

export interface SettingsSnapshot {
  values: SettingsValues;
  meta: SettingMeta[];
}

export interface SettingsState {
  settings: SettingsSnapshot;
  claude: ClaudeStatusInfo;
  rules: { items: RuleListItem[]; loading: boolean; error?: string };
  workspace: WorkspaceInfo;
  about: AboutInfo;
  /** Tab the host wants the panel to show (e.g. `kursor.settings.open` with an argument). */
  initialTab?: SettingsTab;
}

export type SettingsHostToPanel =
  | { type: 'state'; state: SettingsState }
  | { type: 'settings'; settings: SettingsSnapshot }
  | { type: 'claudeStatus'; status: ClaudeStatusInfo }
  | { type: 'rules'; items: RuleListItem[]; loading: boolean; error?: string }
  | { type: 'workspace'; workspace: WorkspaceInfo }
  | { type: 'selectTab'; tab: SettingsTab }
  | { type: 'toast'; level: 'info' | 'warning' | 'error'; text: string };

export type SettingsPanelToHost =
  | { type: 'ready' }
  | { type: 'setSetting'; key: SettingKey; value: SettingsValues[SettingKey] }
  | { type: 'resetSetting'; key: SettingKey }
  | { type: 'refreshStatus' }
  | { type: 'refreshRules' }
  | { type: 'selectFolder'; path: string }
  | { type: 'newRule' }
  | { type: 'openRule'; path: string }
  | { type: 'openCursorignore' }
  | { type: 'openGitignore' }
  | { type: 'openFile'; path: string }
  | { type: 'openUrl'; url: string }
  | { type: 'openEditorSettings'; query?: string; scope?: 'user' | 'workspace' }
  | { type: 'runCommand'; command: string; args?: unknown[] }
  | { type: 'tabChanged'; tab: SettingsTab }
  | { type: 'log'; level: 'info' | 'warn' | 'error'; text: string };

/** Persisted panel UI state (vscode.getState/setState). */
export interface SettingsUiState {
  tab?: SettingsTab;
}

export function isSettingsTab(v: unknown): v is SettingsTab {
  return typeof v === 'string' && (SETTINGS_TABS as readonly string[]).includes(v);
}

export function isSettingKey(v: unknown): v is SettingKey {
  return typeof v === 'string' && (SETTING_KEYS as readonly string[]).includes(v);
}
