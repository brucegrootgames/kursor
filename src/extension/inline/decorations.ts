/**
 * Red/green whole-line decorations for the vertical diff (Continue's decorations.ts, but rendered
 * from the block list instead of incrementally maintained ranges).
 *
 * Red lines are EMPTY placeholder lines in the document: the type hides their (empty) text with
 * `display:none` and shows the old text as `after.contentText` ghost text (per-instance render
 * options), so typing into a red line is invisible and the ghost text can't be edited.
 */
import * as vscode from 'vscode';
import { type DiffBlock } from './diffBlocks';

export class DiffDecorations implements vscode.Disposable {
  private readonly added: vscode.TextEditorDecorationType;
  private readonly removed: vscode.TextEditorDecorationType;

  constructor() {
    this.added = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('kursor.addedLineBackground'),
      outlineWidth: '1px',
      outlineStyle: 'solid',
      outlineColor: new vscode.ThemeColor('diffEditor.insertedTextBorder'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.addedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
    this.removed = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('kursor.removedLineBackground'),
      outlineWidth: '1px',
      outlineStyle: 'solid',
      outlineColor: new vscode.ThemeColor('diffEditor.removedTextBorder'),
      overviewRulerColor: new vscode.ThemeColor('editorOverviewRuler.deletedForeground'),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
      // Hides whatever is (or gets typed) on the placeholder line; the ghost text is the `after` element.
      textDecoration: 'none; display: none',
    });
  }

  /** Replace all diff decorations of `editor` with the ones derived from `blocks`. */
  render(editor: vscode.TextEditor, blocks: readonly DiffBlock[]): void {
    const tabSize = typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 4;
    const lineCount = editor.document.lineCount;
    const green: vscode.Range[] = [];
    const red: vscode.DecorationOptions[] = [];
    for (const b of blocks) {
      for (let i = 0; i < b.numRed; i++) {
        const line = b.start + i;
        if (line >= lineCount) break;
        red.push({
          range: new vscode.Range(line, 0, line, 0),
          renderOptions: {
            after: {
              contentText: ghostText(b.oldLines[i] ?? '', tabSize),
              color: new vscode.ThemeColor('descriptionForeground'),
              textDecoration: 'none; white-space: pre',
            },
          },
        });
      }
      if (b.numGreen > 0) {
        const first = b.start + b.numRed;
        const last = Math.min(lineCount - 1, first + b.numGreen - 1);
        if (first < lineCount) green.push(new vscode.Range(first, 0, last, 0));
      }
    }
    editor.setDecorations(this.added, green);
    editor.setDecorations(this.removed, red);
  }

  clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.added, []);
    editor.setDecorations(this.removed, []);
  }

  dispose(): void {
    this.added.dispose();
    this.removed.dispose();
  }
}

/** Ghost text for a removed line: expand tabs (CSS `content` ignores tab-size) and keep it single-line. */
function ghostText(line: string, tabSize: number): string {
  const expanded = line.replace(/\t/g, ' '.repeat(tabSize));
  // An empty removed line still needs something to render so the red band is visible.
  return expanded.length === 0 ? ' ' : expanded;
}
