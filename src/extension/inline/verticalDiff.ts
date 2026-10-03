/**
 * Vertical diff engine (port of Continue's VerticalDiffHandler/VerticalDiffManager, instant-apply
 * variant): one `VerticalDiffHandler` per document holds the block list (single source of truth);
 * decorations and CodeLenses are derived from it, and every document edit is one atomic
 * `editor.edit` call with the undo-stop discipline:
 *   apply         → { undoStopBefore: true,  undoStopAfter: false }
 *   block actions → { undoStopBefore: false, undoStopAfter: <last block> }
 *   accept/reject all → { undoStopBefore: false, undoStopAfter: true }
 * so an accepted inline edit is ONE undo unit and a rejected one leaves the document as it was.
 */
import * as vscode from 'vscode';
import type { Logger } from '../util/log';
import {
  blockLength,
  computeVerticalDiff,
  findBlockNearLine,
  lineDeltaOfChange,
  removeBlock,
  shiftBlocksForEdit,
  type DiffBlock,
} from './diffBlocks';
import { DiffDecorations } from './decorations';

export const DIFF_VISIBLE_KEY = 'kursor.inlineDiffVisible';
export const DIFF_RESOURCE_KEY = 'kursor.inlineDiffResource';

/** What produced the diff — kept so Ctrl+K on a visible diff can refine it against the original text. */
export interface DiffOrigin {
  /** 0-based first line of the original region (shifted when the user edits above it). */
  rangeStart: number;
  /** Original text of the region (before the diff was applied). */
  oldLines: string[];
  instruction?: string;
  /** Cleaned model output that produced this diff. */
  output?: string[];
  insertMode: boolean;
  wholeFile: boolean;
}

interface LineOp {
  /** 0-based first line to replace. */
  start: number;
  /** Number of whole lines replaced (0 = pure insertion above `start`). */
  count: number;
  newLines: readonly string[];
}

interface UndoOptions {
  undoStopBefore: boolean;
  undoStopAfter: boolean;
}

function eolOf(doc: vscode.TextDocument): string {
  return doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
}

/**
 * Range + text that replaces `count` whole lines starting at `start` with `newLines`, handling the
 * end-of-document case so no stray trailing newline is left behind.
 */
export function lineReplacement(
  doc: vscode.TextDocument,
  start: number,
  count: number,
  newLines: readonly string[],
): { range: vscode.Range; text: string } {
  const eol = eolOf(doc);
  const lineCount = doc.lineCount;
  const endExclusive = Math.min(start + count, lineCount);
  if (endExclusive < lineCount) {
    return {
      range: new vscode.Range(start, 0, endExclusive, 0),
      text: newLines.length > 0 ? newLines.join(eol) + eol : '',
    };
  }
  const lastLine = doc.lineAt(lineCount - 1);
  if (start > 0 && start <= lineCount) {
    const prev = doc.lineAt(start - 1);
    return {
      range: new vscode.Range(start - 1, prev.text.length, lastLine.lineNumber, lastLine.text.length),
      text: newLines.length > 0 ? eol + newLines.join(eol) : '',
    };
  }
  return {
    range: new vscode.Range(0, 0, lastLine.lineNumber, lastLine.text.length),
    text: newLines.join(eol),
  };
}

export class VerticalDiffHandler {
  blocks: DiffBlock[] = [];
  origin: DiffOrigin | undefined;
  /** > 0 while the handler itself is editing the document (change events are then ignored). */
  private selfEdits = 0;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(
    readonly document: vscode.TextDocument,
    private readonly decorations: DiffDecorations,
    private readonly log: Logger,
  ) {}

  get key(): string {
    return this.document.uri.toString();
  }

  get isEmpty(): boolean {
    return this.blocks.length === 0;
  }

  /** Inclusive 0-based line range currently covered by the diff, or undefined. */
  get span(): { start: number; end: number } | undefined {
    if (this.blocks.length === 0) return undefined;
    const first = this.blocks[0];
    const last = this.blocks[this.blocks.length - 1];
    return { start: first.start, end: last.start + blockLength(last) - 1 };
  }

  /**
   * Replace `oldLines.length` lines at `startLine` with the diff of oldLines → newLines.
   * Returns the number of blocks shown (0 = no changes; the document is left untouched).
   */
  async apply(startLine: number, oldLines: readonly string[], newLines: readonly string[], origin: DiffOrigin): Promise<number> {
    if (!this.isEmpty) throw new Error('VerticalDiffHandler.apply: a diff is already visible in this document');
    const plan = computeVerticalDiff(oldLines, newLines);
    if (plan.blocks.length === 0) return 0;
    const ok = await this.editLines([{ start: startLine, count: oldLines.length, newLines: plan.lines }], {
      undoStopBefore: true,
      undoStopAfter: false,
    });
    if (!ok) throw new Error('The editor rejected the edit (was the document changed concurrently?)');
    this.blocks = plan.blocks.map((b) => ({ ...b, start: b.start + startLine }));
    this.origin = origin;
    this.render();
    this.reveal(this.blocks[0]);
    this.changeEmitter.fire();
    return this.blocks.length;
  }

  async acceptBlock(index: number): Promise<void> {
    const block = this.blocks[index];
    if (!block) return;
    const last = this.blocks.length === 1;
    if (block.numRed > 0) {
      await this.editLines([{ start: block.start, count: block.numRed, newLines: [] }], { undoStopBefore: false, undoStopAfter: last });
    }
    this.blocks = removeBlock(this.blocks, index, true);
    this.afterChange();
  }

  async rejectBlock(index: number): Promise<void> {
    const block = this.blocks[index];
    if (!block) return;
    const last = this.blocks.length === 1;
    await this.editLines([{ start: block.start, count: blockLength(block), newLines: block.oldLines }], {
      undoStopBefore: false,
      undoStopAfter: last,
    });
    this.blocks = removeBlock(this.blocks, index, false);
    this.afterChange();
  }

  async acceptAll(): Promise<void> {
    if (this.isEmpty) return;
    const ops: LineOp[] = this.blocks.filter((b) => b.numRed > 0).map((b) => ({ start: b.start, count: b.numRed, newLines: [] }));
    if (ops.length > 0) await this.editLines(ops, { undoStopBefore: false, undoStopAfter: true });
    this.blocks = [];
    this.afterChange();
  }

  async rejectAll(): Promise<void> {
    if (this.isEmpty) return;
    const ops: LineOp[] = this.blocks.map((b) => ({ start: b.start, count: blockLength(b), newLines: b.oldLines }));
    await this.editLines(ops, { undoStopBefore: false, undoStopAfter: true });
    this.blocks = [];
    this.afterChange();
  }

  /** Index of the block at/near a line (for the keyboard accept/reject-block commands). */
  blockIndexNear(line: number): number {
    return findBlockNearLine(this.blocks, line);
  }

  /** Called by the manager for document changes the handler did not make itself. */
  onExternalChange(event: vscode.TextDocumentChangeEvent): void {
    if (this.selfEdits > 0 || this.isEmpty) return;
    for (const change of event.contentChanges) {
      const delta = lineDeltaOfChange(change.range.start.line, change.range.end.line, change.text);
      if (delta === 0) continue;
      const line = change.range.start.line;
      this.blocks = shiftBlocksForEdit(this.blocks, line, delta);
      if (this.origin && line < this.origin.rangeStart) this.origin.rangeStart += delta;
    }
    this.blocks = this.blocks.filter((b) => blockLength(b) > 0);
    this.render();
    this.changeEmitter.fire();
  }

  /** (Re-)paint decorations on every visible editor of this document (also after the tab is re-shown). */
  render(): void {
    for (const editor of this.editors()) {
      if (this.isEmpty) this.decorations.clear(editor);
      else this.decorations.render(editor, this.blocks);
    }
  }

  clearDecorations(): void {
    for (const editor of this.editors()) this.decorations.clear(editor);
  }

  private afterChange(): void {
    this.render();
    this.changeEmitter.fire();
  }

  private editors(): vscode.TextEditor[] {
    return vscode.window.visibleTextEditors.filter((e) => e.document === this.document);
  }

  private async getEditor(): Promise<vscode.TextEditor> {
    const visible = this.editors();
    const active = vscode.window.activeTextEditor;
    if (active && active.document === this.document) return active;
    if (visible.length > 0) return visible[0];
    return vscode.window.showTextDocument(this.document, { preview: false, preserveFocus: true });
  }

  private reveal(block: DiffBlock): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document !== this.document) return;
    const line = Math.min(block.start + block.numRed, Math.max(0, this.document.lineCount - 1));
    const pos = new vscode.Position(line, 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(block.start, 0, line, 0), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private async editLines(ops: readonly LineOp[], undo: UndoOptions): Promise<boolean> {
    const editor = await this.getEditor();
    const doc = editor.document;
    const sorted = [...ops].sort((a, b) => a.start - b.start);
    this.selfEdits++;
    try {
      const ok = await editor.edit(
        (eb) => {
          for (const op of sorted) {
            if (op.count === 0 && op.newLines.length === 0) continue;
            const { range, text } = lineReplacement(doc, op.start, op.count, op.newLines);
            eb.replace(range, text);
          }
        },
        { undoStopBefore: undo.undoStopBefore, undoStopAfter: undo.undoStopAfter },
      );
      if (!ok) this.log.warn(`edit rejected for ${doc.uri.fsPath}`);
      return ok;
    } finally {
      this.selfEdits--;
    }
  }

  dispose(): void {
    this.clearDecorations();
    this.blocks = [];
    this.changeEmitter.dispose();
  }
}

/** Owns the per-document handlers, the CodeLens refresh, context keys and the listeners. */
export class VerticalDiffManager implements vscode.Disposable {
  private readonly handlers = new Map<string, VerticalDiffHandler>();
  private readonly decorations = new DiffDecorations();
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  /** Fires whenever any block list changes (CodeLens refresh, context keys). */
  readonly onDidChange = this.changeEmitter.event;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor(private readonly log: Logger) {
    this.subscriptions.push(
      vscode.workspace.onDidChangeTextDocument((e) => {
        const h = this.handlers.get(e.document.uri.toString());
        if (h) h.onExternalChange(e);
      }),
      vscode.workspace.onDidCloseTextDocument((doc) => {
        const h = this.handlers.get(doc.uri.toString());
        if (h) {
          this.log.info(`document closed with a pending diff: ${doc.uri.fsPath}`);
          this.drop(h);
        }
      }),
      vscode.window.onDidChangeActiveTextEditor(() => this.updateContext()),
      vscode.window.onDidChangeVisibleTextEditors(() => {
        for (const h of this.handlers.values()) h.render();
      }),
    );
  }

  get(uri: vscode.Uri): VerticalDiffHandler | undefined {
    const h = this.handlers.get(uri.toString());
    return h && !h.isEmpty ? h : undefined;
  }

  /** Handler for the active editor's document (only when a diff is visible there). */
  active(): VerticalDiffHandler | undefined {
    const editor = vscode.window.activeTextEditor;
    return editor ? this.get(editor.document.uri) : undefined;
  }

  /** Resolve a command argument (Uri from editor/title, fsPath string from CodeLens, nothing = active editor). */
  resolve(target?: unknown): VerticalDiffHandler | undefined {
    if (target instanceof vscode.Uri) return this.get(target);
    if (typeof target === 'string') {
      for (const h of this.handlers.values()) if (h.document.uri.fsPath === target && !h.isEmpty) return h;
      return undefined;
    }
    return this.active();
  }

  /** Show a diff for `document` (any pending diff in it is rejected first). Returns the number of blocks. */
  async showDiff(
    document: vscode.TextDocument,
    startLine: number,
    oldLines: readonly string[],
    newLines: readonly string[],
    origin: Omit<DiffOrigin, 'rangeStart' | 'oldLines'>,
  ): Promise<number> {
    const key = document.uri.toString();
    const existing = this.handlers.get(key);
    if (existing) {
      // A new diff replaces the pending one: reject it (restores the original text) and drop the handler.
      if (!existing.isEmpty) await existing.rejectAll();
      if (this.handlers.get(key) === existing) this.drop(existing);
    }
    const handler = new VerticalDiffHandler(document, this.decorations, this.log);
    this.handlers.set(key, handler);
    handler.onDidChange(() => this.onHandlerChanged(handler));
    const count = await handler.apply(startLine, oldLines, newLines, { ...origin, rangeStart: startLine, oldLines: [...oldLines] });
    if (count === 0) this.drop(handler);
    else this.log.info(`diff shown: ${document.uri.fsPath} L${startLine + 1} (${count} block${count === 1 ? '' : 's'})`);
    await this.updateContext();
    return count;
  }

  async acceptAll(handler: VerticalDiffHandler): Promise<void> {
    await handler.acceptAll();
  }

  async rejectAll(handler: VerticalDiffHandler): Promise<void> {
    await handler.rejectAll();
  }

  /** Reject every visible diff (used before closing / on dispose). */
  async rejectEverything(): Promise<void> {
    for (const h of [...this.handlers.values()]) {
      try {
        await h.rejectAll();
      } catch (e) {
        this.log.warn(`rejectAll failed for ${h.document.uri.fsPath}`, e);
      }
    }
  }

  private onHandlerChanged(handler: VerticalDiffHandler): void {
    if (handler.isEmpty) this.drop(handler);
    this.changeEmitter.fire();
    void this.updateContext();
  }

  private drop(handler: VerticalDiffHandler): void {
    handler.dispose();
    this.handlers.delete(handler.key);
    this.changeEmitter.fire();
    void this.updateContext();
  }

  async updateContext(): Promise<void> {
    const active = this.active();
    try {
      await vscode.commands.executeCommand('setContext', DIFF_VISIBLE_KEY, active !== undefined);
      await vscode.commands.executeCommand('setContext', DIFF_RESOURCE_KEY, active ? active.document.uri.fsPath : '');
    } catch (e) {
      this.log.warn('setContext failed', e);
    }
  }

  dispose(): void {
    for (const h of this.handlers.values()) h.dispose();
    this.handlers.clear();
    for (const s of this.subscriptions) s.dispose();
    this.decorations.dispose();
    this.changeEmitter.dispose();
    void vscode.commands.executeCommand('setContext', DIFF_VISIBLE_KEY, false);
    void vscode.commands.executeCommand('setContext', DIFF_RESOURCE_KEY, '');
  }
}
