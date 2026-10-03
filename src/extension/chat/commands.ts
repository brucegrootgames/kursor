/** All `kursor.chat.*` commands. */
import * as vscode from 'vscode';
import type { Attachment } from '../../shared/protocol';
import { diagnosticAttachment, fileAttachment, selectionAttachment, terminalAttachment } from '../context/providers';
import type { TerminalCapture } from '../context/terminalCapture';
import type { Logger } from '../util/log';
import type { ChatManager } from './manager';
import type { ChatPanelController, ChatViewProvider } from './views';

export interface CommandDeps {
  manager: ChatManager;
  view: ChatViewProvider;
  panel: ChatPanelController;
  terminals: TerminalCapture;
  log: Logger;
}

/** Copy via a terminal command and read the clipboard, restoring the previous clipboard content. */
async function copyFromTerminal(command: string): Promise<string> {
  const previous = await vscode.env.clipboard.readText();
  try {
    await vscode.env.clipboard.writeText('');
    await vscode.commands.executeCommand(command);
    // The copy command is asynchronous in the renderer; poll briefly.
    for (let i = 0; i < 10; i++) {
      const text = await vscode.env.clipboard.readText();
      if (text) return text;
      await new Promise((r) => setTimeout(r, 60));
    }
    return '';
  } finally {
    await vscode.env.clipboard.writeText(previous);
  }
}

export function registerChatCommands(context: vscode.ExtensionContext, deps: CommandDeps): void {
  const { manager, view, panel, terminals, log } = deps;

  const wrap = (name: string, fn: (...args: unknown[]) => Promise<void> | void): vscode.Disposable =>
    vscode.commands.registerCommand(name, async (...args: unknown[]) => {
      try {
        await fn(...args);
      } catch (err) {
        log.error(`${name} failed`, err);
        void vscode.window.showErrorMessage(`Kursor: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  // Toggle (Ctrl+I): close the secondary side bar when the chat is visible AND focused; otherwise reveal + focus.
  const openChat = async (): Promise<void> => {
    if (view.focused) {
      await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    } else {
      await view.reveal(true);
      manager.postToPrimary({ type: 'focusInput' });
    }
  };

  const terminalText = async (command: string): Promise<{ text: string; name: string } | undefined> => {
    let text = '';
    try {
      text = await copyFromTerminal(command);
    } catch (err) {
      log.warn(`${command} failed`, err);
    }
    if (text.trim()) return { text, name: vscode.window.activeTerminal?.name ?? 'Terminal' };
    const captured = terminals.lastOutput();
    return captured ? { text: captured.text, name: captured.terminalName } : undefined;
  };

  context.subscriptions.push(
    wrap('kursor.chat.open', openChat),
    wrap('kursor.chat.newChat', async () => {
      manager.newChat();
      await view.reveal(true);
      manager.postToPrimary({ type: 'focusInput' });
    }),
    wrap('kursor.chat.history', async () => {
      await view.reveal(true);
      const sessions = await manager.history();
      manager.postToPrimary({ type: 'history', sessions });
      manager.postToPrimary({ type: 'showHistory' });
    }),
    wrap('kursor.chat.openInEditor', () => {
      manager.activeOrNew();
      panel.open();
    }),
    wrap('kursor.chat.addSelectionToNewChat', async () => {
      const sel = selectionAttachment();
      if (!sel) {
        await openChat();
        return;
      }
      await manager.addAttachment(sel, { newChat: true, focus: true });
    }),
    wrap('kursor.chat.addSelectionToChat', async () => {
      const sel = selectionAttachment();
      if (!sel) {
        void vscode.window.showInformationMessage('Select some code first.');
        return;
      }
      await manager.addAttachment(sel, { focus: true });
    }),
    wrap('kursor.chat.addFileToChat', async (arg, multi) => {
      const uris: vscode.Uri[] = Array.isArray(multi) && multi.every((u) => u instanceof vscode.Uri) ? (multi as vscode.Uri[]) : arg instanceof vscode.Uri ? [arg] : [];
      if (!uris.length) {
        const ed = vscode.window.activeTextEditor;
        if (ed?.document.uri.scheme === 'file') uris.push(ed.document.uri);
      }
      if (!uris.length) {
        void vscode.window.showInformationMessage('No file to add.');
        return;
      }
      for (let i = 0; i < uris.length; i++) {
        const uri = uris[i];
        let kind: 'file' | 'folder' = 'file';
        try {
          kind = (await vscode.workspace.fs.stat(uri)).type === vscode.FileType.Directory ? 'folder' : 'file';
        } catch {
          /* default to file */
        }
        await manager.addAttachment(fileAttachment(uri, kind), { focus: i === uris.length - 1 });
      }
    }),
    wrap('kursor.chat.explainSelection', async () => {
      const sel = selectionAttachment(undefined, { allowEmpty: true });
      if (!sel) {
        void vscode.window.showInformationMessage('Open a file and select the code to explain.');
        return;
      }
      await view.reveal(true);
      await manager.send(undefined, 'Explain this code: what it does, how it fits into the codebase, and anything surprising.', [sel], { mode: 'ask' });
    }),
    wrap('kursor.chat.fixDiagnostic', async (uriArg, diagArg) => {
      let uri = uriArg instanceof vscode.Uri ? uriArg : vscode.window.activeTextEditor?.document.uri;
      let diagnostic = diagArg as vscode.Diagnostic | undefined;
      if (!uri) throw new Error('No file for the diagnostic.');
      if (typeof uriArg === 'string') uri = vscode.Uri.parse(uriArg);
      if (!diagnostic || typeof diagnostic !== 'object' || !('message' in diagnostic)) {
        const ed = vscode.window.activeTextEditor;
        const all = vscode.languages.getDiagnostics(uri);
        diagnostic = (ed && all.find((d) => d.range.contains(ed.selection.active))) ?? all.find((d) => d.severity === vscode.DiagnosticSeverity.Error) ?? all[0];
      }
      if (!diagnostic) {
        void vscode.window.showInformationMessage('No problem found at the cursor.');
        return;
      }
      const attachments: Attachment[] = [diagnosticAttachment(uri, diagnostic)];
      const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri?.toString());
      if (editor) {
        const doc = editor.document;
        const start = Math.max(0, diagnostic.range.start.line - 5);
        const end = Math.min(doc.lineCount - 1, diagnostic.range.end.line + 5);
        const range = new vscode.Range(start, 0, end, doc.lineAt(end).range.end.character);
        attachments.push({
          id: `ctx-${Date.now()}`,
          kind: 'selection',
          label: `${vscode.workspace.asRelativePath(uri, false)}:${start + 1}-${end + 1}`,
          path: uri.fsPath,
          relPath: vscode.workspace.asRelativePath(uri, false),
          range: { startLine: start + 1, endLine: end + 1 },
          text: doc.getText(range),
        });
      }
      await view.reveal(true);
      await manager.send(undefined, `Fix this problem: ${diagnostic.message}`, attachments);
    }),
    wrap('kursor.chat.addTerminalSelection', async () => {
      const t = await terminalText('workbench.action.terminal.copySelection');
      if (!t) {
        void vscode.window.showInformationMessage('Select text in the terminal first (or run a command with shell integration enabled).');
        return;
      }
      await manager.addAttachment(terminalAttachment(t.text, t.name), { focus: true });
    }),
    wrap('kursor.chat.debugTerminal', async () => {
      const t = await terminalText('workbench.action.terminal.copyLastCommandAndLastCommandOutput');
      if (!t) {
        void vscode.window.showInformationMessage('No terminal output found. Run a command first (shell integration required).');
        return;
      }
      await view.reveal(true);
      await manager.send(undefined, 'Debug this terminal output: explain what went wrong and fix it.', [terminalAttachment(t.text, t.name)]);
    }),
    wrap('kursor.chat.exportChat', () => manager.exportChat()),
    wrap('kursor.chat.stop', () => manager.stop()),
    wrap('kursor.chat.focusInput', () => manager.focusInput()),
  );
}
