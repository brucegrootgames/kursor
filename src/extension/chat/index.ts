/**
 * Chat host entry point: wires the ChatManager, the side-bar view, the editor
 * panel, the @-mention search, terminal capture and all `kursor.chat.*`
 * commands, and returns the ChatController used by other modules.
 */
import * as vscode from 'vscode';
import type { ChatController, ChatDeps } from '../services';
import { createMentionSearch } from '../context/mentions';
import { createTerminalCapture } from '../context/terminalCapture';
import { registerChatCommands } from './commands';
import { createChatController } from './controller';
import { ChatManager } from './manager';
import { handleWebviewMessage } from './messages';
import { ChatPanelController, ChatViewProvider, VIEW_ID, type WebviewHost } from './views';
import type { WebviewToHost } from '../../shared/protocol';

export function registerChat(context: vscode.ExtensionContext, deps: ChatDeps): ChatController {
  const { log } = deps;
  const terminals = createTerminalCapture(context, log.child('terminal'));
  const mentions = createMentionSearch(context, { log: log.child('mentions'), rules: deps.rules, terminals });
  const manager = new ChatManager(context, deps, terminals);
  context.subscriptions.push(manager);

  const onMessage = (msg: WebviewToHost, host: WebviewHost): Promise<void> => handleWebviewMessage({ manager, mentions, log: log.child('webview') }, msg, host);
  const view = new ChatViewProvider(context.extensionUri, manager, onMessage, log.child('view'));
  const panel = new ChatPanelController(context, manager, onMessage, log.child('panel'));
  context.subscriptions.push(view, panel, vscode.window.registerWebviewViewProvider(VIEW_ID, view, { webviewOptions: { retainContextWhenHidden: true } }));

  manager.reveal = async (focus) => {
    if (panel.visible && !view.visible) return; // the editor panel is what the user is looking at
    await view.reveal(focus);
  };

  let pendingAttention = 0;
  manager.onPermissionAttention = (chat, request) => {
    if (manager.anyHostVisible()) return;
    pendingAttention += 1;
    view.setBadge(pendingAttention, `${pendingAttention} action${pendingAttention === 1 ? '' : 's'} waiting for your approval`);
    if (vscode.workspace.getConfiguration('kursor').get<boolean>('agent.notifyOnPermission', true)) {
      const what = request.kind === 'question' ? 'has a question for you' : request.kind === 'plan' ? 'has a plan ready for review' : `wants to run ${request.title ?? request.toolName}`;
      void vscode.window.showInformationMessage(`Kursor ${what} (${chat.title}).`, 'Open').then((pick) => {
        if (pick === 'Open') {
          manager.switchChat(chat.id);
          void view.reveal(true);
        }
      });
    }
  };
  // Reset the badge counter whenever the view becomes visible (the view clears the badge itself).
  context.subscriptions.push(
    vscode.window.onDidChangeVisibleTextEditors(() => {
      if (view.visible) pendingAttention = 0;
    }),
  );

  registerChatCommands(context, { manager, view, panel, terminals, log: log.child('commands') });
  mentions.prime();
  return createChatController(manager);
}
