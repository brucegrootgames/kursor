/**
 * [E] IDE bridge — lets a `claude` CLI started in Kursor's integrated terminal see the
 * editor (selection, diagnostics, open files) and show its proposed edits as diff tabs.
 * See README.md in this directory for the design.
 */
import * as vscode from 'vscode';
import type { IdeDeps } from '../services';
import { IdeDiffManager } from './diff';
import { SelectionTracker } from './selection';
import { IdeServer } from './server';
import type { IdeToolHost } from './tools';

const SETTING_SECTION = 'kursor';
const SETTING_ENABLE = 'ide.enableServer';
const SELECTION_DEBOUNCE_MS = 100;
/** Delay before pushing the current selection to a freshly connected client (lets its handshake settle). */
const INITIAL_SELECTION_DELAY_MS = 500;

export function registerIdeServer(context: vscode.ExtensionContext, deps: IdeDeps): void {
  const log = deps.log;
  const diff = new IdeDiffManager(log.child('diff'), deps.edits);
  const selection = new SelectionTracker(log.child('selection'), SELECTION_DEBOUNCE_MS);
  context.subscriptions.push(diff, selection);

  const host: IdeToolHost = {
    openDiff: (args, signal) => diff.openDiff(args, signal),
    closeTab: (name) => diff.closeTab(name),
    closeAllDiffTabs: () => diff.closeAllDiffTabs(),
    latestSelection: () => selection.latestSelection(),
  };
  const version = (context.extension.packageJSON as { version?: string }).version ?? '0.0.0';
  const server = new IdeServer(
    log.child('server'),
    {
      ideName: vscode.env.appName,
      version,
      env: context.environmentVariableCollection,
      workspaceFolders: () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    },
    host,
  );
  context.subscriptions.push(server);

  // Server → client notifications.
  let initialSelectionTimer: NodeJS.Timeout | undefined;
  context.subscriptions.push(
    new vscode.Disposable(() => {
      if (initialSelectionTimer) clearTimeout(initialSelectionTimer);
    }),
    selection.onDidChangeSelection((info) => {
      void server.notify('selection_changed', { ...info });
    }),
    server.onDidChangeClient((client) => {
      if (initialSelectionTimer) clearTimeout(initialSelectionTimer);
      initialSelectionTimer = undefined;
      if (client) {
        initialSelectionTimer = setTimeout(() => {
          initialSelectionTimer = undefined;
          const latest = selection.latestSelection();
          if (latest && server.currentClient === client) void server.notify('selection_changed', { ...latest });
        }, INITIAL_SELECTION_DELAY_MS);
      } else {
        void diff.rejectAll('client disconnected').catch((err) => log.error('rejectAll failed', err));
      }
    }),
  );

  // Commands (always registered so package.json contributions never dangle).
  const command = (id: string, run: (...args: unknown[]) => Promise<void>): vscode.Disposable =>
    vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      try {
        await run(...args);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error(`${id} failed`, err);
        void vscode.window.showErrorMessage(`Kursor: ${message}`);
      }
    });
  context.subscriptions.push(
    command('kursor.ide.acceptDiff', (arg) => diff.accept(arg)),
    command('kursor.ide.rejectDiff', (arg) => diff.reject(arg)),
    command('kursor.ide.insertAtMention', async () => {
      const mention = selection.activeAtMention();
      if (!mention) {
        void vscode.window.showInformationMessage('Kursor: open a file in the editor to reference it in the terminal session.');
        return;
      }
      if (!server.isConnected) {
        const pick = await vscode.window.showInformationMessage(
          'Kursor: no terminal session is connected. Start `claude` in the integrated terminal, then try again.',
          'Open Terminal',
        );
        if (pick === 'Open Terminal') await vscode.commands.executeCommand('workbench.action.terminal.focus');
        return;
      }
      log.debug(`at_mentioned ${mention.filePath}${mention.lineStart !== undefined ? ` L${mention.lineStart + 1}-${(mention.lineEnd ?? mention.lineStart) + 1}` : ''}`);
      await server.notify('at_mentioned', { ...mention });
      vscode.window.activeTerminal?.show();
    }),
  );

  // Gate on the setting; serialize start/stop so rapid toggles cannot interleave.
  let queue: Promise<void> = Promise.resolve();
  const sync = (): void => {
    const enabled = vscode.workspace.getConfiguration(SETTING_SECTION).get<boolean>(SETTING_ENABLE, true);
    queue = queue
      .then(async () => {
        if (enabled && !server.isRunning) {
          try {
            await server.start();
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            log.error('IDE bridge failed to start', err);
            void vscode.window.showErrorMessage(`Kursor: the IDE bridge could not start (${message}). A terminal \`claude\` will not see this editor.`);
          }
        } else if (!enabled && server.isRunning) {
          await server.stop('disabled by kursor.ide.enableServer');
        }
      })
      .catch((err: unknown) => log.error('IDE bridge state change failed', err));
  };
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SETTING_SECTION}.${SETTING_ENABLE}`)) sync();
    }),
  );
  sync();
}
