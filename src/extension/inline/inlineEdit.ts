/**
 * Ctrl+K controller: target range → prompt (QuickPick) → generation (bridge.oneShot with spinner
 * + Esc cancel) → post-processing → vertical diff. Also the follow-up flow (Ctrl+K while a diff is
 * visible rejects the diff and re-runs against the original text with the previous attempt as
 * context), Quick question and Send to chat.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { InlineDeps } from '../services';
import type { Attachment } from '../../shared/protocol';
import { lineDeltaOfChange, splitLines } from './diffBlocks';
import { cleanModelOutput } from './postprocess';
import { buildEditPrompt } from './prompts';
import { PromptHistory } from './history';
import { PromptUi, type PromptAction, type PromptResult } from './promptUi';
import { InlineSpinner, isAbortError } from './spinner';
import type { VerticalDiffHandler, VerticalDiffManager } from './verticalDiff';

/** Maximum region size we send to the model (whole-file edits on bigger files are refused). */
const MAX_REGION_LINES = 3000;

export interface EditTarget {
  /** 0-based inclusive line range. */
  startLine: number;
  endLine: number;
  /** The range is a single blank line: generate code to insert there. */
  insertMode: boolean;
  wholeFile: boolean;
}

/** Lines to edit: the selection (whole lines) or the current line when nothing is selected. */
export function computeTarget(editor: vscode.TextEditor, wholeFile = false): EditTarget {
  const doc = editor.document;
  if (wholeFile) return { startLine: 0, endLine: doc.lineCount - 1, insertMode: false, wholeFile: true };
  const sel = editor.selection;
  if (sel.isEmpty) {
    const line = sel.active.line;
    return { startLine: line, endLine: line, insertMode: doc.lineAt(line).isEmptyOrWhitespace, wholeFile: false };
  }
  let end = sel.end.line;
  if (sel.end.character === 0 && end > sel.start.line) end--;
  return { startLine: sel.start.line, endLine: end, insertMode: false, wholeFile: false };
}

export function targetTitle(doc: vscode.TextDocument, t: EditTarget, verb = 'Edit'): string {
  const base = path.basename(doc.uri.fsPath);
  if (t.wholeFile) return `${verb} ${base} (whole file)`;
  if (t.insertMode) return `Insert at ${base}:${t.startLine + 1}`;
  if (t.startLine === t.endLine) return `${verb} ${base}:${t.startLine + 1}`;
  return `${verb} ${base}:${t.startLine + 1}-${t.endLine + 1}`;
}

export function workspaceCwd(doc: vscode.TextDocument): string {
  return (
    vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath ??
    vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ??
    (doc.uri.scheme === 'file' ? path.dirname(doc.uri.fsPath) : process.cwd())
  );
}

export function displayPath(doc: vscode.TextDocument): string {
  if (doc.uri.scheme !== 'file') return doc.uri.toString();
  return vscode.workspace.asRelativePath(doc.uri, false);
}

export function selectionAttachment(doc: vscode.TextDocument, startLine: number, endLine: number, text?: string): Attachment {
  const base = path.basename(doc.uri.fsPath);
  const range = { startLine: startLine + 1, endLine: endLine + 1 };
  return {
    id: randomUUID(),
    kind: 'selection',
    label: range.startLine === range.endLine ? `${base}:${range.startLine}` : `${base}:${range.startLine}-${range.endLine}`,
    path: doc.uri.fsPath,
    relPath: displayPath(doc),
    range,
    text: text ?? doc.getText(new vscode.Range(startLine, 0, endLine, doc.lineAt(endLine).text.length)),
  };
}

/** Follows the target range while the model is generating; flags edits that touch the region. */
class RangeTracker implements vscode.Disposable {
  start: number;
  end: number;
  invalidated = false;
  private readonly sub: vscode.Disposable;

  constructor(doc: vscode.TextDocument, target: EditTarget) {
    this.start = target.startLine;
    this.end = target.endLine;
    this.sub = vscode.workspace.onDidChangeTextDocument((e) => {
      if (e.document !== doc) return;
      for (const c of e.contentChanges) {
        const delta = lineDeltaOfChange(c.range.start.line, c.range.end.line, c.text);
        if (c.range.end.line < this.start) {
          this.start += delta;
          this.end += delta;
        } else if (c.range.end.line === this.start && c.range.end.character === 0 && c.range.start.line < this.start) {
          this.start += delta;
          this.end += delta;
        } else if (c.range.end.line === this.start && c.range.end.character === 0 && c.range.isEmpty && /\n$/.test(c.text)) {
          this.start += delta;
          this.end += delta;
        } else if (c.range.start.line > this.end) {
          // below the region: nothing to do
        } else {
          this.invalidated = true;
        }
      }
    });
  }

  dispose(): void {
    this.sub.dispose();
  }
}

export class InlineEditController implements vscode.Disposable {
  private readonly highlight: vscode.TextEditorDecorationType;

  constructor(
    private readonly deps: InlineDeps,
    private readonly manager: VerticalDiffManager,
    private readonly prompt: PromptUi,
    private readonly history: PromptHistory,
    private readonly spinner: InlineSpinner,
  ) {
    this.highlight = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor('editor.selectionHighlightBackground'),
      rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
    });
  }

  /** kursor.inlineEdit.open — also the follow-up entry point while a diff is visible. */
  async open(preferred?: PromptAction): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showInformationMessage('Kursor: open a file to use inline edit (Ctrl+K).');
      return;
    }
    if (this.spinner.running) this.spinner.cancel();
    const pending = this.manager.get(editor.document.uri);
    if (pending) {
      await this.openFollowUp(editor, pending, preferred);
      return;
    }
    const target = computeTarget(editor);
    this.setHighlight(editor, target);
    let result: PromptResult | undefined;
    try {
      result = await this.prompt.show({
        title: targetTitle(editor.document, target),
        preferred,
        history: this.history.list(),
      });
    } finally {
      this.setHighlight(editor, undefined);
    }
    if (!result) return;
    switch (result.action) {
      case 'edit':
        await this.runEdit(editor, target, result.text);
        break;
      case 'wholeFile':
        await this.runEdit(editor, computeTarget(editor, true), result.text);
        break;
      case 'question':
        await this.quickQuestion(editor, target, result.text);
        break;
      case 'sendToChat':
        await this.sendToChat(editor, target, result.text);
        break;
      case 'acceptAll':
      case 'rejectAll':
        break;
    }
  }

  /** kursor.inlineEdit.quickQuestion */
  async quickQuestionCommand(): Promise<void> {
    if (this.prompt.submit('question')) return;
    await this.open('question');
  }

  /** kursor.inlineEdit.submit {action} — from the prompt keybindings; opens the prompt when it is closed. */
  async submit(action: PromptAction): Promise<void> {
    if (this.prompt.submit(action)) return;
    await this.open(action);
  }

  cancel(): void {
    this.spinner.cancel();
    this.prompt.close();
  }

  private async openFollowUp(editor: vscode.TextEditor, handler: VerticalDiffHandler, preferred?: PromptAction): Promise<void> {
    const origin = handler.origin;
    const span = handler.span;
    if (!origin || !span) return;
    const doc = editor.document;
    const originalTarget: EditTarget = {
      startLine: origin.rangeStart,
      endLine: origin.rangeStart + Math.max(1, origin.oldLines.length) - 1,
      insertMode: origin.insertMode,
      wholeFile: origin.wholeFile,
    };
    const result = await this.prompt.show({
      title: targetTitle(doc, originalTarget, 'Refine'),
      placeholder: 'Follow-up instructions… (Enter to refine · Ctrl+Enter accept · Ctrl+Backspace reject)',
      followUp: true,
      preferred,
      history: this.history.list(),
    });
    if (!result) return;
    const proposed = origin.output?.join('\n');
    switch (result.action) {
      case 'acceptAll':
        await handler.acceptAll();
        break;
      case 'rejectAll':
        await handler.rejectAll();
        break;
      case 'edit':
      case 'wholeFile': {
        const previous = origin.instruction && proposed !== undefined ? { instruction: origin.instruction, output: proposed } : undefined;
        await handler.rejectAll();
        await this.runEdit(editor, originalTarget, result.text, previous);
        break;
      }
      case 'question':
        await this.quickQuestion(editor, originalTarget, result.text, proposed);
        break;
      case 'sendToChat':
        await this.sendToChat(editor, originalTarget, result.text, proposed);
        break;
    }
  }

  /** Generate a replacement for `target` and show it as a vertical diff. */
  async runEdit(
    editor: vscode.TextEditor,
    target: EditTarget,
    instruction: string,
    previous?: { instruction: string; output: string },
  ): Promise<void> {
    const doc = editor.document;
    const log = this.deps.log;
    const regionLines = target.endLine - target.startLine + 1;
    if (regionLines > MAX_REGION_LINES) {
      void vscode.window.showWarningMessage(`Kursor: the selected region is too large for inline edit (${regionLines} lines, max ${MAX_REGION_LINES}). Select a smaller range or use the chat.`);
      return;
    }
    const documentLines = splitLines(doc.getText());
    const oldLines = documentLines.slice(target.startLine, target.endLine + 1);
    const cwd = workspaceCwd(doc);
    const tracker = new RangeTracker(doc, target);
    this.setHighlight(editor, target);
    log.info(`edit ${displayPath(doc)} L${target.startLine + 1}-${target.endLine + 1}: ${instruction}`);
    try {
      const raw = await this.spinner.run('editing…', async (signal, report) => {
        const rulesAppendix = await this.safeAppendix(cwd, doc);
        if (signal.aborted) throw abortError();
        const built = buildEditPrompt({
          displayPath: displayPath(doc),
          languageId: doc.languageId,
          documentLines,
          startLine: target.startLine,
          endLine: target.endLine,
          instruction,
          insertMode: target.insertMode,
          wholeFile: target.wholeFile,
          previous,
          rulesAppendix,
        });
        let received = 0;
        return this.deps.bridge.oneShot({
          systemPrompt: built.systemPrompt,
          prompt: built.prompt,
          model: inlineModel(),
          cwd,
          signal,
          thinking: false,
          onDelta: (text) => {
            received += (text.match(/\n/g) ?? []).length;
            if (received > 0) report(`${received} line${received === 1 ? '' : 's'}`);
          },
        });
      });
      this.history.add(instruction);
      if (tracker.invalidated || !regionUnchanged(doc, tracker.start, oldLines)) {
        void vscode.window.showWarningMessage('Kursor: the code changed while the edit was being generated, so the result was discarded.');
        return;
      }
      const cleaned = cleanModelOutput(raw, {
        originalLines: oldLines,
        insertSpaces: editor.options.insertSpaces !== false,
        tabSize: typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 4,
        insertMode: target.insertMode,
      });
      if (cleaned.length === 0) {
        void vscode.window.showWarningMessage('Kursor: the model returned no code for this instruction.');
        return;
      }
      const newLines = target.insertMode ? [...indentInserted(cleaned, oldLines[0] ?? ''), oldLines[0] ?? ''] : cleaned;
      const blocks = await this.manager.showDiff(doc, tracker.start, oldLines, newLines, {
        instruction,
        output: cleaned,
        insertMode: target.insertMode,
        wholeFile: target.wholeFile,
      });
      if (blocks === 0) {
        void vscode.window.setStatusBarMessage('$(info) Kursor: no changes suggested', 4000);
      }
    } catch (e) {
      if (isAbortError(e)) {
        log.info('inline edit cancelled');
        return;
      }
      throw e;
    } finally {
      tracker.dispose();
      this.setHighlight(editor, undefined);
    }
  }

  private async quickQuestion(editor: vscode.TextEditor, target: EditTarget, question: string, text?: string): Promise<void> {
    const attachment = selectionAttachment(editor.document, target.startLine, target.endLine, text);
    await this.deps.chat.sendPrompt(question, [attachment], { mode: 'ask' });
  }

  private async sendToChat(editor: vscode.TextEditor, target: EditTarget, text: string, proposed?: string): Promise<void> {
    const attachment = selectionAttachment(editor.document, target.startLine, target.endLine, proposed);
    await this.deps.chat.addAttachment(attachment, { focus: true });
    if (text) await this.deps.chat.insertText(text);
  }

  private async safeAppendix(cwd: string, doc: vscode.TextDocument): Promise<string> {
    try {
      const paths = doc.uri.scheme === 'file' ? [doc.uri.fsPath] : [];
      return await this.deps.rules.buildAppendix(cwd, paths);
    } catch (e) {
      this.deps.log.warn('rules appendix unavailable', e);
      return '';
    }
  }

  private setHighlight(editor: vscode.TextEditor, target: EditTarget | undefined): void {
    try {
      editor.setDecorations(this.highlight, target ? [new vscode.Range(target.startLine, 0, target.endLine, 0)] : []);
    } catch {
      // editor may have been disposed
    }
  }

  dispose(): void {
    this.highlight.dispose();
  }
}

function inlineModel(): string | undefined {
  const model = vscode.workspace.getConfiguration('kursor').get<string>('inlineEdit.model', 'sonnet').trim();
  return model || undefined;
}

function regionUnchanged(doc: vscode.TextDocument, start: number, oldLines: readonly string[]): boolean {
  if (start < 0 || start + oldLines.length > doc.lineCount) return false;
  for (let i = 0; i < oldLines.length; i++) if (doc.lineAt(start + i).text !== oldLines[i]) return false;
  return true;
}

/** In insert mode the blank target line may carry indentation: use it as the base indent for the new code. */
function indentInserted(lines: string[], blankLine: string): string[] {
  const indent = /^[ \t]*/.exec(blankLine)?.[0] ?? '';
  if (!indent) return lines;
  const hasIndent = lines.some((l) => l.trim() !== '' && /^[ \t]/.test(l));
  if (hasIndent) return lines;
  return lines.map((l) => (l.trim() === '' ? l : indent + l));
}

function abortError(): Error {
  const err = new Error('The operation was aborted');
  err.name = 'AbortError';
  return err;
}
