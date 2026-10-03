/**
 * [F] Kursor Settings — entry point.
 *
 * Registers the singleton settings panel (`kursor.settings.open`, Ctrl+Shift+J) and the
 * "New Kursor Rule" command (`kursor.rules.new`). See README.md in this directory.
 */
import * as vscode from 'vscode';
import type { SettingsDeps } from '../services';
import { isSettingsTab, type SettingsTab } from '../../shared/settingsProtocol';
import { verifySpecsAgainstManifest } from './config';
import { SettingsPanelController } from './panel';
import { createNewRuleInteractive } from './rulesActions';
import { defaultCwd } from './workspace';

export { SETTINGS_VIEW_TYPE } from './panel';

/** Accepts `kursor.settings.open('rules')`, `{ tab: 'rules' }`, or nothing. */
function tabFromArgs(arg: unknown): SettingsTab | undefined {
  if (isSettingsTab(arg)) return arg;
  const tab = (arg as { tab?: unknown } | undefined)?.tab;
  return isSettingsTab(tab) ? tab : undefined;
}

export function registerSettings(context: vscode.ExtensionContext, deps: SettingsDeps): void {
  const { log } = deps;
  verifySpecsAgainstManifest(context.extension.packageJSON, log);

  const controller = new SettingsPanelController(context, deps);
  context.subscriptions.push(controller);

  const report = (what: string, err: unknown): void => {
    log.error(`${what} failed`, err);
    const text = err instanceof Error ? err.message : String(err);
    void vscode.window.showErrorMessage(`Kursor: ${what} failed — ${text}`, 'Show Logs').then((pick) => {
      if (pick === 'Show Logs') log.show();
    });
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('kursor.settings.open', (arg?: unknown) => {
      try {
        controller.open(tabFromArgs(arg));
      } catch (err) {
        report('opening Kursor Settings', err);
      }
    }),
    vscode.commands.registerCommand('kursor.rules.new', async (arg?: unknown) => {
      try {
        const preferred = typeof arg === 'string' ? arg : (arg as { cwd?: unknown } | undefined)?.cwd;
        await createNewRuleInteractive(log, typeof preferred === 'string' ? preferred : defaultCwd());
      } catch (err) {
        report('creating a rule', err);
      }
    }),
  );
  log.debug('settings panel registered');
}
