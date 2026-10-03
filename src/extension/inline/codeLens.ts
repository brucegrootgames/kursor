/** "Accept · Reject" CodeLens pair per diff block (Continue's VerticalPerLineCodeLensProvider). */
import * as vscode from 'vscode';
import type { VerticalDiffManager } from './verticalDiff';

export class InlineDiffCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly subscription: vscode.Disposable;

  constructor(private readonly manager: VerticalDiffManager) {
    this.subscription = manager.onDidChange(() => this.emitter.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const handler = this.manager.get(document.uri);
    if (!handler) return [];
    const fsPath = document.uri.fsPath;
    const lenses: vscode.CodeLens[] = [];
    handler.blocks.forEach((block, index) => {
      const line = Math.min(block.start, Math.max(0, document.lineCount - 1));
      const range = new vscode.Range(line, 0, line, 0);
      lenses.push(
        new vscode.CodeLens(range, { title: '✓ Accept', tooltip: 'Accept this change (Ctrl+Alt+Y)', command: 'kursor.inlineEdit.acceptBlock', arguments: [fsPath, index] }),
        new vscode.CodeLens(range, { title: '✗ Reject', tooltip: 'Reject this change (Ctrl+Alt+N)', command: 'kursor.inlineEdit.rejectBlock', arguments: [fsPath, index] }),
      );
      if (index === 0 && handler.blocks.length > 1) {
        lenses.push(
          new vscode.CodeLens(range, { title: 'Accept all (Ctrl+Enter)', command: 'kursor.inlineEdit.acceptAll', arguments: [document.uri] }),
          new vscode.CodeLens(range, { title: 'Reject all (Ctrl+Backspace)', command: 'kursor.inlineEdit.rejectAll', arguments: [document.uri] }),
        );
      }
    });
    return lenses;
  }

  dispose(): void {
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
