import * as vscode from 'vscode';
import { createLogger } from './util/log';
import { createClaudeBridge } from './claude/bridge';
import { createRulesService } from './rules/rules';
import { createEditTracker } from './edits/editTracker';
import { registerChat } from './chat';
import { registerInlineEdit } from './inline';
import { registerTab } from './tab';
import { registerTerminal } from './terminal';
import { registerScm } from './scm';
import { registerCodeActions } from './actions';
import { registerSettings } from './settings';
import { registerIdeServer } from './ide';
import { terminalLaunchSpec } from './claude/launch';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const log = createLogger(context);
  const version = (context.extension.packageJSON as { version?: string }).version ?? '?';
  log.info(`Kursor ${version} activating (${vscode.env.appName} ${vscode.version})`);

  const bridge = createClaudeBridge(context, log.child('claude'));
  const rules = createRulesService(context, log.child('rules'));
  const edits = createEditTracker(context, { log: log.child('edits') });
  const chat = registerChat(context, { log: log.child('chat'), bridge, rules, edits });
  registerInlineEdit(context, { log: log.child('inline'), bridge, rules, chat });
  registerTab(context, { log: log.child('tab'), bridge });
  registerTerminal(context, { log: log.child('terminal'), bridge, chat });
  registerScm(context, { log: log.child('scm'), bridge });
  registerCodeActions(context, { log: log.child('actions'), chat });
  registerSettings(context, { log: log.child('settings'), bridge, rules });
  registerIdeServer(context, { log: log.child('ide'), edits });

  context.subscriptions.push(
    vscode.commands.registerCommand('kursor.showLogs', () => log.show()),
    vscode.commands.registerCommand('kursor.claude.status', async () => {
      const s = await bridge.refreshStatus();
      if (s.ok) {
        void vscode.window.showInformationMessage(
          `Claude Code ${s.version ?? ''} at ${s.path ?? '?'} — ${s.loggedIn ? `signed in as ${s.email ?? 'unknown'}${s.subscriptionType ? ` (${s.subscriptionType})` : ''}` : 'not signed in'}`,
        );
      } else {
        const pick = await vscode.window.showErrorMessage(`Claude Code is not available: ${s.error ?? 'unknown error'}`, 'Open Settings', 'Show Logs');
        if (pick === 'Open Settings') void vscode.commands.executeCommand('workbench.action.openSettings', 'kursor.claude.path');
        if (pick === 'Show Logs') log.show();
      }
    }),
    vscode.commands.registerCommand('kursor.claude.login', async () => {
      const claudePath = await bridge.resolveClaudePath();
      let term: vscode.Terminal;
      if (claudePath) {
        // Run the binary as the terminal process: no shell-specific quoting (bash / zsh / PowerShell / cmd).
        const spec = terminalLaunchSpec(claudePath, ['auth', 'login']);
        term = vscode.window.createTerminal({ name: 'Claude Code login', shellPath: spec.shellPath, shellArgs: spec.shellArgs });
      } else {
        term = vscode.window.createTerminal({ name: 'Claude Code login' });
        term.sendText('claude auth login', true);
      }
      term.show();
      const sub = vscode.window.onDidCloseTerminal((t) => {
        if (t === term) {
          sub.dispose();
          void bridge.refreshStatus();
        }
      });
      context.subscriptions.push(sub);
    }),
  );

  // Kick off a status probe so the chat can show sign-in guidance immediately.
  void bridge.refreshStatus().then((s) => {
    if (!s.ok) log.warn(`Claude Code not ready: ${s.error ?? 'unknown'}`);
    else log.info(`Claude Code ${s.version} ready (${s.loggedIn ? 'signed in' : 'not signed in'})`);
  });
}

export function deactivate(): void {
  // Disposables registered on the extension context are cleaned up by VS Code.
}
