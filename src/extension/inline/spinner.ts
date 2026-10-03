/**
 * Status-bar spinner + cancellation for one inline generation at a time.
 * Sets the `kursor.inlineEditRunning` context key so Esc (keybinding → kursor.inlineEdit.cancel)
 * and the status-bar click abort the request through an AbortController.
 */
import * as vscode from 'vscode';
import type { Logger } from '../util/log';

export const RUNNING_CONTEXT_KEY = 'kursor.inlineEditRunning';

export class InlineSpinner implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private current: { abort: AbortController; label: string } | undefined;

  constructor(private readonly log: Logger) {
    this.item = vscode.window.createStatusBarItem('kursor.inlineEdit.status', vscode.StatusBarAlignment.Left, 100);
    this.item.name = 'Kursor inline edit';
    this.item.command = 'kursor.inlineEdit.cancel';
    this.item.tooltip = 'Kursor is generating… click or press Esc to cancel';
  }

  get running(): boolean {
    return this.current !== undefined;
  }

  /** Run `task` with a spinner. A task already running is cancelled first. */
  async run<T>(label: string, task: (signal: AbortSignal, report: (detail: string) => void) => Promise<T>): Promise<T> {
    this.cancel();
    const abort = new AbortController();
    this.current = { abort, label };
    this.item.text = `$(loading~spin) Kursor: ${label}`;
    this.item.show();
    await this.setRunning(true);
    try {
      return await task(abort.signal, (detail) => {
        if (this.current?.abort === abort) this.item.text = `$(loading~spin) Kursor: ${label}${detail ? ` (${detail})` : ''}`;
      });
    } finally {
      if (this.current?.abort === abort) {
        this.current = undefined;
        this.item.hide();
        await this.setRunning(false);
      }
    }
  }

  cancel(): void {
    if (!this.current) return;
    this.log.info(`cancelled: ${this.current.label}`);
    this.current.abort.abort();
    this.current = undefined;
    this.item.hide();
    void this.setRunning(false);
  }

  private async setRunning(value: boolean): Promise<void> {
    try {
      await vscode.commands.executeCommand('setContext', RUNNING_CONTEXT_KEY, value);
    } catch (e) {
      this.log.warn('setContext failed', e);
    }
  }

  dispose(): void {
    this.cancel();
    this.item.dispose();
  }
}

export function isAbortError(e: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) return true;
  if (!e || typeof e !== 'object') return false;
  const err = e as { name?: unknown; code?: unknown };
  return err.name === 'AbortError' || err.code === 'ABORT_ERR';
}
