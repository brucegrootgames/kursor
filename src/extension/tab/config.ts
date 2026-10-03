/**
 * Live view of the `kursor.tab.*` settings. Re-read on every
 * `onDidChangeConfiguration` that affects the section (see index.ts).
 */
import * as vscode from 'vscode';

export const TAB_SECTION = 'kursor.tab';

export interface TabConfig {
  enabled: boolean;
  /** Typing pause before a request is sent (ms, >= 150). */
  debounceMs: number;
  /** Model passed to the CLI (default "haiku"). */
  model: string;
  /** Lower-cased language ids where Tab is off. */
  disabledLanguages: string[];
  /** Lines of prefix/suffix context sent with each request. */
  contextLines: number;
}

export function readTabConfig(): TabConfig {
  const c = vscode.workspace.getConfiguration(TAB_SECTION);
  const debounce = Number(c.get<number>('debounceMs', 900));
  const ctx = Number(c.get<number>('contextLines', 120));
  const languages = c.get<unknown>('disabledLanguages', []);
  return {
    enabled: c.get<boolean>('enabled', true) !== false,
    debounceMs: Number.isFinite(debounce) ? Math.max(150, Math.floor(debounce)) : 900,
    model: (c.get<string>('model', 'haiku') || 'haiku').trim() || 'haiku',
    disabledLanguages: Array.isArray(languages)
      ? languages.map((l) => String(l).trim().toLowerCase()).filter((l) => l.length > 0)
      : [],
    contextLines: Number.isFinite(ctx) ? Math.min(2000, Math.max(5, Math.floor(ctx))) : 120,
  };
}

/**
 * Pick the configuration target that currently wins for a key so that a UI
 * toggle is not silently shadowed by a workspace override.
 */
export function effectiveTarget(key: string): vscode.ConfigurationTarget {
  const info = vscode.workspace.getConfiguration(TAB_SECTION).inspect<unknown>(key);
  if (info?.workspaceFolderValue !== undefined) return vscode.ConfigurationTarget.WorkspaceFolder;
  if (info?.workspaceValue !== undefined) return vscode.ConfigurationTarget.Workspace;
  return vscode.ConfigurationTarget.Global;
}
