/**
 * Bottom-right status bar item: `$(sparkle) Kursor Tab` / `Tab: off` /
 * `Tab: snoozed 28m` / `Tab: off (markdown)` / spinner while a request runs.
 * Clicking opens `kursor.tab.statusMenu`.
 */
import * as vscode from 'vscode';
import type { TabState } from './state';
import type { TabStats } from './provider';

export class TabStatusBar implements vscode.Disposable {
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private busy = false;
  private ticker: NodeJS.Timeout | undefined;

  constructor(
    private readonly state: TabState,
    private readonly stats: () => TabStats,
  ) {
    this.item = vscode.window.createStatusBarItem('kursor.tab', vscode.StatusBarAlignment.Right, 90);
    this.item.name = 'Kursor Tab';
    this.item.command = 'kursor.tab.statusMenu';
    this.disposables.push(
      this.item,
      state.onDidChange(() => this.refresh()),
      vscode.window.onDidChangeActiveTextEditor(() => this.refresh()),
    );
    this.refresh();
    this.item.show();
  }

  setBusy(busy: boolean): void {
    if (this.busy === busy) return;
    this.busy = busy;
    this.refresh();
  }

  refresh(): void {
    const language = vscode.window.activeTextEditor?.document.languageId;
    const availability = this.state.availabilityFor(language);
    const cfg = this.state.config;
    this.item.backgroundColor = undefined;

    if (availability.active) {
      this.item.text = this.busy ? '$(loading~spin) Kursor Tab' : '$(sparkle) Kursor Tab';
    } else {
      switch (availability.reason) {
        case 'disabled':
          this.item.text = '$(sparkle) Tab: off';
          break;
        case 'snoozed':
          this.item.text = `$(sparkle) Tab: snoozed ${formatRemaining(this.state.snoozeRemainingMs)}`;
          break;
        case 'language':
          this.item.text = `$(sparkle) Tab: off (${availability.detail ?? language ?? '?'})`;
          break;
        case 'unavailable':
          this.item.text = '$(sparkle) Tab: unavailable';
          this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
          break;
      }
    }

    const s = this.stats();
    const md = new vscode.MarkdownString('', true);
    md.isTrusted = true;
    md.appendMarkdown(`**Kursor Tab** — ${describe(availability, language)}\n\n`);
    md.appendMarkdown(`Model \`${cfg.model}\` · debounce ${cfg.debounceMs} ms · ${cfg.contextLines} context lines\n\n`);
    md.appendMarkdown(`This session: ${s.requests} requests · ${s.shown} shown · ${s.accepted} accepted${s.errors ? ` · ${s.errors} errors` : ''}\n\n`);
    if (s.lastError) md.appendMarkdown(`Last error: ${s.lastError.replace(/\n/g, ' ').slice(0, 200)}\n\n`);
    md.appendMarkdown('Click for options (enable, snooze, disable for this language). Alt+\\ triggers a completion.');
    this.item.tooltip = md;

    this.arrangeTicker(availability.active === false && availability.reason === 'snoozed');
  }

  private arrangeTicker(snoozed: boolean): void {
    if (snoozed && !this.ticker) {
      this.ticker = setInterval(() => this.refresh(), 30_000);
    } else if (!snoozed && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = undefined;
    }
  }

  dispose(): void {
    if (this.ticker) clearInterval(this.ticker);
    for (const d of this.disposables) d.dispose();
  }
}

export function formatRemaining(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h}h${m}m` : `${h}h`;
}

function describe(a: ReturnType<TabState['availabilityFor']>, language: string | undefined): string {
  if (a.active) return language ? `active for ${language}` : 'active';
  switch (a.reason) {
    case 'disabled':
      return 'disabled (`kursor.tab.enabled`)';
    case 'snoozed':
      return 'snoozed';
    case 'language':
      return `disabled for ${a.detail ?? language ?? 'this language'} (\`kursor.tab.disabledLanguages\`)`;
    case 'unavailable':
      return `unavailable: ${a.detail ?? 'Claude Code CLI not ready'}`;
  }
}
