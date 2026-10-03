/** Prompt history for the Ctrl+K prompt (workspaceState, most recent first). */
import type * as vscode from 'vscode';

const KEY = 'kursor.inlineEdit.history';
const MAX = 30;

export class PromptHistory {
  constructor(private readonly state: vscode.Memento) {}

  list(): string[] {
    const raw = this.state.get<unknown>(KEY);
    if (!Array.isArray(raw)) return [];
    return raw.filter((x): x is string => typeof x === 'string' && x.trim() !== '');
  }

  add(prompt: string): void {
    const text = prompt.trim();
    if (!text) return;
    const next = [text, ...this.list().filter((p) => p !== text)].slice(0, MAX);
    void this.state.update(KEY, next);
  }

  clear(): void {
    void this.state.update(KEY, []);
  }
}
