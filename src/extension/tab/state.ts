/**
 * TabState — the single source of truth for "is Tab active right now?".
 * Combines the settings (enabled / disabledLanguages), an in-memory+persisted
 * snooze, and a transient "unavailable" flag set when the CLI is not ready.
 */
import * as vscode from 'vscode';
import type { Logger } from '../util/log';
import { TAB_SECTION, TabConfig, effectiveTarget, readTabConfig } from './config';

export const SNOOZE_KEY = 'kursor.tab.snoozedUntil';
export const DEFAULT_SNOOZE_MINUTES = 30;

export type TabAvailability =
  | { active: true }
  | { active: false; reason: 'disabled' | 'snoozed' | 'language' | 'unavailable'; detail?: string };

export class TabState implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private _config: TabConfig;
  private _snoozedUntil: number;
  private snoozeTimer: NodeJS.Timeout | undefined;
  private _unavailable: string | undefined;

  constructor(
    private readonly memento: vscode.Memento,
    private readonly log: Logger,
  ) {
    this._config = readTabConfig();
    const stored = Number(memento.get<number>(SNOOZE_KEY, 0));
    this._snoozedUntil = Number.isFinite(stored) && stored > Date.now() ? stored : 0;
    if (this._snoozedUntil) this.armSnoozeTimer();
  }

  get config(): TabConfig {
    return this._config;
  }

  get enabled(): boolean {
    return this._config.enabled;
  }

  get snoozed(): boolean {
    return this._snoozedUntil > Date.now();
  }

  get snoozeRemainingMs(): number {
    return this.snoozed ? this._snoozedUntil - Date.now() : 0;
  }

  get unavailableReason(): string | undefined {
    return this._unavailable;
  }

  /** Called from onDidChangeConfiguration. */
  reloadConfig(): void {
    this._config = readTabConfig();
    this._onDidChange.fire();
  }

  isLanguageDisabled(languageId: string | undefined): boolean {
    if (!languageId) return false;
    return this._config.disabledLanguages.includes(languageId.toLowerCase());
  }

  availabilityFor(languageId: string | undefined): TabAvailability {
    if (!this._config.enabled) return { active: false, reason: 'disabled' };
    if (this.snoozed) return { active: false, reason: 'snoozed' };
    if (this.isLanguageDisabled(languageId)) return { active: false, reason: 'language', detail: languageId };
    if (this._unavailable) return { active: false, reason: 'unavailable', detail: this._unavailable };
    return { active: true };
  }

  async setEnabled(enabled: boolean): Promise<void> {
    if (enabled) {
      // Turning Tab on also ends a snooze — otherwise the toggle would look broken.
      await this.endSnooze();
    }
    this._config = { ...this._config, enabled };
    this._onDidChange.fire();
    try {
      await vscode.workspace.getConfiguration(TAB_SECTION).update('enabled', enabled, effectiveTarget('enabled'));
    } catch (e) {
      this.log.error('failed to write kursor.tab.enabled', e);
      throw e;
    }
  }

  async snooze(minutes: number = DEFAULT_SNOOZE_MINUTES): Promise<void> {
    const ms = Math.max(1, minutes) * 60_000;
    this._snoozedUntil = Date.now() + ms;
    await this.memento.update(SNOOZE_KEY, this._snoozedUntil);
    this.armSnoozeTimer();
    this.log.info(`Tab snoozed for ${minutes} min`);
    this._onDidChange.fire();
  }

  async endSnooze(): Promise<void> {
    if (!this._snoozedUntil) return;
    this._snoozedUntil = 0;
    this.clearSnoozeTimer();
    await this.memento.update(SNOOZE_KEY, undefined);
    this.log.info('Tab snooze ended');
    this._onDidChange.fire();
  }

  async setLanguageDisabled(languageId: string, disabled: boolean): Promise<void> {
    const id = languageId.toLowerCase();
    const current = this._config.disabledLanguages;
    const next = disabled ? (current.includes(id) ? current : [...current, id]) : current.filter((l) => l !== id);
    this._config = { ...this._config, disabledLanguages: next };
    this._onDidChange.fire();
    try {
      await vscode.workspace
        .getConfiguration(TAB_SECTION)
        .update('disabledLanguages', next, effectiveTarget('disabledLanguages'));
    } catch (e) {
      this.log.error('failed to write kursor.tab.disabledLanguages', e);
      throw e;
    }
  }

  /** Set (or clear with undefined) the reason the CLI cannot serve completions. */
  setUnavailable(reason: string | undefined): void {
    if (reason === this._unavailable) return;
    this._unavailable = reason;
    this._onDidChange.fire();
  }

  private armSnoozeTimer(): void {
    this.clearSnoozeTimer();
    const remaining = this.snoozeRemainingMs;
    if (remaining <= 0) return;
    // Node timers overflow above ~24.8 days; snoozes are minutes, but be safe.
    this.snoozeTimer = setTimeout(() => {
      this.snoozeTimer = undefined;
      this._snoozedUntil = 0;
      void this.memento.update(SNOOZE_KEY, undefined);
      this.log.info('Tab snooze expired');
      this._onDidChange.fire();
    }, Math.min(remaining, 2_000_000_000));
  }

  private clearSnoozeTimer(): void {
    if (this.snoozeTimer) {
      clearTimeout(this.snoozeTimer);
      this.snoozeTimer = undefined;
    }
  }

  dispose(): void {
    this.clearSnoozeTimer();
    this._onDidChange.dispose();
  }
}
