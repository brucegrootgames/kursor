/**
 * Inline diff presentation for agent edits (Cursor "Inline Diffs"):
 * - whole-line background on added lines (`kursor.addedLineBackground`),
 * - a dashed marker with "− N lines removed" (hover shows the removed text),
 * - CodeLens "Keep · Undo" per hunk (`kursor.edits.keepHunk/undoHunk [fsPath, i]`).
 * Hunks are recomputed from the tracked base against the live document text.
 */
import * as vscode from 'vscode';
import { computeHunks, hunkOldLines, type Hunk, type TrackedFile } from './model';

export class EditDecorations implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly added = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    backgroundColor: new vscode.ThemeColor('kursor.addedLineBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorGutter.addedBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
  });
  private readonly removed = vscode.window.createTextEditorDecorationType({
    isWholeLine: true,
    borderWidth: '1px 0 0 0',
    borderStyle: 'dashed',
    borderColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
    overviewRulerColor: new vscode.ThemeColor('editorGutter.deletedBackground'),
    overviewRulerLane: vscode.OverviewRulerLane.Left,
    after: { color: new vscode.ThemeColor('editorCodeLens.foreground'), fontStyle: 'italic', margin: '0 0 0 1em' },
  });
  private readonly lensEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.lensEmitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pendingRefresh = new Map<string, NodeJS.Timeout>();
  private enabled = true;

  constructor(
    private readonly lookup: (fsPath: string) => TrackedFile | undefined,
    private readonly onDocumentChanged: (doc: vscode.TextDocument) => void,
  ) {
    this.disposables.push(
      vscode.languages.registerCodeLensProvider({ scheme: 'file' }, this),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshAll()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme !== 'file' || !this.lookup(e.document.uri.fsPath)) return;
        const key = e.document.uri.fsPath;
        const t = this.pendingRefresh.get(key);
        if (t) clearTimeout(t);
        this.pendingRefresh.set(
          key,
          setTimeout(() => {
            this.pendingRefresh.delete(key);
            this.onDocumentChanged(e.document);
            this.refreshAll();
          }, 150),
        );
      }),
    );
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.refreshAll();
  }

  /** Hunks of the live document against the tracked base. */
  hunksFor(doc: vscode.TextDocument): Hunk[] {
    const file = this.lookup(doc.uri.fsPath);
    if (!file) return [];
    return computeHunks(file.base ?? '', doc.getText());
  }

  refreshAll(): void {
    for (const editor of vscode.window.visibleTextEditors) this.refresh(editor);
    this.lensEmitter.fire();
  }

  refresh(editor: vscode.TextEditor): void {
    const doc = editor.document;
    if (doc.uri.scheme !== 'file') return;
    const file = this.enabled ? this.lookup(doc.uri.fsPath) : undefined;
    if (!file) {
      editor.setDecorations(this.added, []);
      editor.setDecorations(this.removed, []);
      return;
    }
    const hunks = computeHunks(file.base ?? '', doc.getText());
    const addedRanges: vscode.Range[] = [];
    const removedOpts: vscode.DecorationOptions[] = [];
    const lastLine = Math.max(0, doc.lineCount - 1);
    for (const h of hunks) {
      if (h.newLines > 0) {
        const start = Math.min(lastLine, h.newStart - 1);
        const end = Math.min(lastLine, h.newStart - 1 + h.newLines - 1);
        addedRanges.push(new vscode.Range(start, 0, end, doc.lineAt(end).range.end.character));
      }
      const oldLines = hunkOldLines(h);
      if (oldLines.length && h.newLines === 0) {
        const line = Math.min(lastLine, Math.max(0, h.newStart - 1));
        const md = new vscode.MarkdownString();
        md.appendCodeblock(oldLines.join('\n'), doc.languageId);
        removedOpts.push({
          range: new vscode.Range(line, 0, line, 0),
          hoverMessage: md,
          renderOptions: { after: { contentText: `− ${oldLines.length} line${oldLines.length === 1 ? '' : 's'} removed by Kursor` } },
        });
      }
    }
    editor.setDecorations(this.added, addedRanges);
    editor.setDecorations(this.removed, removedOpts);
  }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.enabled || doc.uri.scheme !== 'file') return [];
    const file = this.lookup(doc.uri.fsPath);
    if (!file) return [];
    const hunks = computeHunks(file.base ?? '', doc.getText());
    const lenses: vscode.CodeLens[] = [];
    const lastLine = Math.max(0, doc.lineCount - 1);
    hunks.forEach((h, i) => {
      const line = Math.min(lastLine, Math.max(0, h.newStart - 1));
      const range = new vscode.Range(line, 0, line, 0);
      lenses.push(
        new vscode.CodeLens(range, { title: '$(check) Keep', tooltip: 'Keep this change', command: 'kursor.edits.keepHunk', arguments: [doc.uri.fsPath, i] }),
        new vscode.CodeLens(range, { title: '$(discard) Undo', tooltip: 'Undo this change', command: 'kursor.edits.undoHunk', arguments: [doc.uri.fsPath, i] }),
      );
      if (i === 0 && hunks.length > 1) {
        lenses.push(
          new vscode.CodeLens(range, { title: `Kursor: ${hunks.length} changes`, command: 'kursor.edits.reviewFile', arguments: [doc.uri] }),
          new vscode.CodeLens(range, { title: 'Keep file', command: 'kursor.edits.keepFile', arguments: [doc.uri] }),
          new vscode.CodeLens(range, { title: 'Undo file', command: 'kursor.edits.undoFile', arguments: [doc.uri] }),
        );
      }
    });
    return lenses;
  }

  dispose(): void {
    for (const t of this.pendingRefresh.values()) clearTimeout(t);
    this.pendingRefresh.clear();
    for (const editor of vscode.window.visibleTextEditors) {
      editor.setDecorations(this.added, []);
      editor.setDecorations(this.removed, []);
    }
    this.added.dispose();
    this.removed.dispose();
    this.lensEmitter.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
