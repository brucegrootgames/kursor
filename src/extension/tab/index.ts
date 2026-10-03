/**
 * [D2] Kursor Tab — ghost-text completions via the user's Claude Code CLI.
 *
 * Wiring only; see README.md in this folder for the design.
 *   config.ts     live `kursor.tab.*` settings
 *   state.ts      enabled / snoozed / per-language / unavailable
 *   prompt.ts     FIM system prompt + context window
 *   sanitize.ts   model output → safe ghost text
 *   cache.ts      last result + "typed-through" reuse
 *   provider.ts   InlineCompletionItemProvider (debounce, abort, backoff)
 *   statusBar.ts  status bar item
 */
import * as vscode from 'vscode';
import type { BridgeDeps } from '../services';
import { TAB_SECTION } from './config';
import { DEFAULT_SNOOZE_MINUTES, TabState } from './state';
import { CompletionCache } from './cache';
import { TAB_ACCEPTED_COMMAND, TabCompletionProvider } from './provider';
import { TabStatusBar, formatRemaining } from './statusBar';

interface MenuItem extends vscode.QuickPickItem {
  run: () => Promise<void> | void;
}

export function registerTab(context: vscode.ExtensionContext, deps: BridgeDeps): void {
  const log = deps.log;
  const state = new TabState(context.globalState, log);
  const cache = new CompletionCache();
  const provider = new TabCompletionProvider(deps, state, cache);
  const statusBar = new TabStatusBar(state, () => provider.stats);

  const command = (id: string, handler: (...args: unknown[]) => Promise<void> | void): vscode.Disposable =>
    vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      try {
        await handler(...args);
      } catch (e) {
        log.error(`${id} failed`, e);
        void vscode.window.showErrorMessage(`Kursor: ${e instanceof Error ? e.message : String(e)}`);
      }
    });

  context.subscriptions.push(
    state,
    provider,
    statusBar,
    vscode.languages.registerInlineCompletionItemProvider([{ scheme: 'file' }, { scheme: 'untitled' }], provider),
    provider.onDidChangeBusy((busy) => statusBar.setBusy(busy)),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!e.affectsConfiguration(TAB_SECTION)) return;
      state.reloadConfig();
      provider.reset();
      log.info(`settings reloaded: enabled=${state.config.enabled} model=${state.config.model} debounce=${state.config.debounceMs}ms`);
    }),
    vscode.workspace.onDidCloseTextDocument((doc) => cache.invalidate(doc.uri.toString())),
    state.onDidChange(() => {
      const editor = vscode.window.activeTextEditor;
      if (editor && !state.availabilityFor(editor.document.languageId).active) {
        void vscode.commands.executeCommand('editor.action.inlineSuggest.hide');
      }
    }),

    command(TAB_ACCEPTED_COMMAND, () => {
      provider.noteAccepted();
      statusBar.refresh();
    }),

    command('kursor.tab.toggle', async () => {
      const next = !state.enabled;
      await state.setEnabled(next);
      vscode.window.setStatusBarMessage(`Kursor Tab ${next ? 'enabled' : 'disabled'}`, 2500);
    }),

    command('kursor.tab.snooze', async () => {
      await state.snooze(DEFAULT_SNOOZE_MINUTES);
      vscode.window.setStatusBarMessage(`Kursor Tab snoozed for ${DEFAULT_SNOOZE_MINUTES} minutes`, 2500);
    }),

    command('kursor.tab.trigger', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const availability = state.availabilityFor(editor.document.languageId);
      if (!availability.active) {
        const label =
          availability.reason === 'disabled'
            ? 'Enable'
            : availability.reason === 'snoozed'
              ? 'End snooze'
              : availability.reason === 'language'
                ? `Enable for ${editor.document.languageId}`
                : 'Check Claude Code status';
        const pick = await vscode.window.showInformationMessage(`Kursor Tab is ${describeInactive(availability, state)}.`, label);
        if (pick !== label) return;
        if (availability.reason === 'disabled') await state.setEnabled(true);
        else if (availability.reason === 'snoozed') await state.endSnooze();
        else if (availability.reason === 'language') await state.setLanguageDisabled(editor.document.languageId, false);
        else {
          await vscode.commands.executeCommand('kursor.claude.status');
          return;
        }
      }
      await vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
    }),

    command('kursor.tab.statusMenu', async () => {
      const editor = vscode.window.activeTextEditor;
      const language = editor?.document.languageId;
      const availability = state.availabilityFor(language);
      const items: MenuItem[] = [];

      items.push(
        state.enabled
          ? { label: '$(circle-slash) Disable Kursor Tab', description: 'Turn off ghost-text completions everywhere', run: () => state.setEnabled(false) }
          : { label: '$(check) Enable Kursor Tab', description: 'Turn ghost-text completions back on', run: () => state.setEnabled(true) },
      );
      if (state.snoozed) {
        items.push({
          label: '$(debug-continue) End snooze',
          description: `${formatRemaining(state.snoozeRemainingMs)} left`,
          run: () => state.endSnooze(),
        });
      } else {
        items.push({
          label: `$(clock) Snooze for ${DEFAULT_SNOOZE_MINUTES} minutes`,
          description: 'Pause completions temporarily',
          run: () => state.snooze(DEFAULT_SNOOZE_MINUTES),
        });
      }
      if (language && language !== 'scminput') {
        items.push(
          state.isLanguageDisabled(language)
            ? { label: `$(check) Enable for ${language}`, description: 'Remove from kursor.tab.disabledLanguages', run: () => state.setLanguageDisabled(language, false) }
            : { label: `$(circle-slash) Disable for ${language}`, description: 'Add to kursor.tab.disabledLanguages', run: () => state.setLanguageDisabled(language, true) },
        );
      }
      if (availability.active === false && availability.reason === 'unavailable') {
        items.push({
          label: '$(account) Check Claude Code status',
          description: availability.detail,
          run: async () => {
            await vscode.commands.executeCommand('kursor.claude.status');
          },
        });
      }
      items.push(
        {
          label: '$(zap) Trigger a completion now',
          description: 'Alt+\\',
          run: async () => {
            await vscode.commands.executeCommand('kursor.tab.trigger');
          },
        },
        {
          label: '$(settings-gear) Tab settings',
          description: 'kursor.tab.*',
          run: async () => {
            await vscode.commands.executeCommand('workbench.action.openSettings', TAB_SECTION);
          },
        },
        { label: '$(output) Show Kursor logs', run: () => log.show() },
      );

      const picked = await vscode.window.showQuickPick(items, {
        title: 'Kursor Tab',
        placeHolder: availability.active ? `Active${language ? ` for ${language}` : ''} · model ${state.config.model}` : `Off: ${describeInactive(availability, state)}`,
      });
      if (picked) await picked.run();
    }),
  );

  log.info(`Tab registered (enabled=${state.enabled}, model=${state.config.model}, debounce=${state.config.debounceMs}ms${state.snoozed ? ', snoozed' : ''})`);
}

function describeInactive(a: ReturnType<TabState['availabilityFor']>, state: TabState): string {
  if (a.active) return 'active';
  switch (a.reason) {
    case 'disabled':
      return 'disabled';
    case 'snoozed':
      return `snoozed (${formatRemaining(state.snoozeRemainingMs)} left)`;
    case 'language':
      return `disabled for ${a.detail ?? 'this language'}`;
    case 'unavailable':
      return `unavailable — ${a.detail ?? 'Claude Code CLI not ready'}`;
  }
}
