/**
 * "Apply" / "Insert at cursor" from chat code blocks:
 *   kursor.inlineEdit.applyCode { code, path?, language? } → whole-file vertical diff (with a
 *   "fast apply" merge through the model when the snippet is a fragment), or a diff at the
 *   active editor's selection / cursor when no path resolves;
 *   kursor.inlineEdit.insertAtCursor { code } → plain insertion.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import type { InlineDeps } from '../services';
import { splitLines } from './diffBlocks';
import { cleanModelOutput, looksLikeFragment } from './postprocess';
import { buildMergePrompt } from './prompts';
import type { InlineSpinner } from './spinner';
import type { VerticalDiffManager } from './verticalDiff';
import { displayPath, workspaceCwd } from './inlineEdit';

export interface ApplyCodeArgs {
  code: string;
  path?: string;
  language?: string;
}

export interface InsertAtCursorArgs {
  code: string;
}

/** Files above this size are not sent through the fast-apply merge. */
const MAX_FAST_APPLY_BYTES = 200_000;

function parseArgs(raw: unknown, name: string): { code: string; path?: string; language?: string } {
  const args = (raw ?? {}) as Partial<ApplyCodeArgs>;
  const code = typeof args.code === 'string' ? args.code.replace(/\r\n?/g, '\n').replace(/\n+$/, '') : '';
  if (!code.trim()) throw new Error(`${name}: no code was provided`);
  return {
    code,
    path: typeof args.path === 'string' && args.path.trim() ? args.path.trim() : undefined,
    language: typeof args.language === 'string' ? args.language : undefined,
  };
}

function trimBlankEdges(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && out[0].trim() === '') out.shift();
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  return out;
}

function editorIndent(editor: vscode.TextEditor): { insertSpaces: boolean; tabSize: number } {
  return {
    insertSpaces: editor.options.insertSpaces !== false,
    tabSize: typeof editor.options.tabSize === 'number' ? editor.options.tabSize : 4,
  };
}

export class ApplyCodeService {
  constructor(
    private readonly deps: InlineDeps,
    private readonly manager: VerticalDiffManager,
    private readonly spinner: InlineSpinner,
  ) {}

  async applyCode(raw: unknown): Promise<void> {
    const args = parseArgs(raw, 'applyCode');
    const log = this.deps.log;
    if (args.path) {
      const uri = await this.resolveFile(args.path);
      if (uri) {
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc, { preview: false });
        await this.applyToDocument(editor, args.code, args.language);
        return;
      }
      const created = await this.offerCreate(args.path, args.code);
      if (created) return;
      log.info(`applyCode: path not found (${args.path}); applying to the active editor`);
    }
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      throw new Error('Open a file to apply code to (or give the code block a file path).');
    }
    await this.applyAtSelection(editor, args.code);
  }

  async insertAtCursor(raw: unknown): Promise<void> {
    const args = parseArgs(raw, 'insertAtCursor');
    const editor = vscode.window.activeTextEditor;
    if (!editor) throw new Error('Open a file to insert code into.');
    const code = args.code.replace(/\n/g, editor.document.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
    const ok = await editor.edit(
      (eb) => {
        if (editor.selection.isEmpty) eb.insert(editor.selection.active, code);
        else eb.replace(editor.selection, code);
      },
      { undoStopBefore: true, undoStopAfter: true },
    );
    if (!ok) throw new Error('The editor rejected the insertion.');
    editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /** Whole-file diff current → code (fast-apply merge first when the snippet is a fragment). */
  private async applyToDocument(editor: vscode.TextEditor, code: string, language?: string): Promise<void> {
    const doc = editor.document;
    const docText = doc.getText();
    const docLines = splitLines(docText);
    const indent = editorIndent(editor);
    const codeLines = trimBlankEdges(splitLines(code));

    if (docText.trim() === '') {
      const count = await this.manager.showDiff(doc, 0, docLines, [...codeLines, ''], { insertMode: false, wholeFile: true });
      if (count === 0) this.noChanges();
      return;
    }

    let newLines: string[];
    if (looksLikeFragment(codeLines, docLines)) {
      if (Buffer.byteLength(docText, 'utf8') > MAX_FAST_APPLY_BYTES) {
        throw new Error(`${path.basename(doc.uri.fsPath)} is too large for fast apply; paste the code manually or use Ctrl+K on the target region.`);
      }
      this.deps.log.info(`applyCode: fast-apply merge into ${displayPath(doc)}`);
      const merged = await this.spinner.run('applying…', (signal, report) => {
        const built = buildMergePrompt({
          displayPath: displayPath(doc),
          languageId: language ?? doc.languageId,
          fileText: docText,
          snippet: code,
        });
        let received = 0;
        return this.deps.bridge.oneShot({
          systemPrompt: built.systemPrompt,
          prompt: built.prompt,
          model: inlineModel(),
          cwd: workspaceCwd(doc),
          signal,
          thinking: false,
          onDelta: (t) => {
            received += (t.match(/\n/g) ?? []).length;
            if (received > 0) report(`${received}/${docLines.length} lines`);
          },
        });
      });
      newLines = cleanModelOutput(merged, { originalLines: docLines, insertSpaces: indent.insertSpaces, tabSize: indent.tabSize, insertMode: true });
      if (newLines.length === 0) throw new Error('Fast apply returned an empty file; nothing was changed.');
    } else {
      newLines = cleanModelOutput(code, { originalLines: docLines, insertSpaces: indent.insertSpaces, tabSize: indent.tabSize, insertMode: true });
    }
    // Keep the file's trailing-newline convention.
    if (docLines[docLines.length - 1] === '' && newLines[newLines.length - 1] !== '') newLines.push('');
    const count = await this.manager.showDiff(doc, 0, docLines, newLines, { insertMode: false, wholeFile: true });
    if (count === 0) this.noChanges();
  }

  /** Diff at the selection, or insert below/at the cursor line. */
  private async applyAtSelection(editor: vscode.TextEditor, code: string): Promise<void> {
    const doc = editor.document;
    const indent = editorIndent(editor);
    const sel = editor.selection;
    if (!sel.isEmpty) {
      let end = sel.end.line;
      if (sel.end.character === 0 && end > sel.start.line) end--;
      const oldLines = splitLines(doc.getText(new vscode.Range(sel.start.line, 0, end, doc.lineAt(end).text.length)));
      const newLines = cleanModelOutput(code, { originalLines: oldLines, insertSpaces: indent.insertSpaces, tabSize: indent.tabSize });
      if (newLines.length === 0) throw new Error('No code to apply.');
      const count = await this.manager.showDiff(doc, sel.start.line, oldLines, newLines, { insertMode: false, wholeFile: false });
      if (count === 0) this.noChanges();
      return;
    }
    const line = sel.active.line;
    const lineText = doc.lineAt(line).text;
    const codeLines = cleanModelOutput(code, { originalLines: [lineText], insertSpaces: indent.insertSpaces, tabSize: indent.tabSize, insertMode: true });
    if (codeLines.length === 0) throw new Error('No code to apply.');
    const blank = lineText.trim() === '';
    const newLines = blank ? [...codeLines, lineText] : [lineText, ...codeLines];
    const count = await this.manager.showDiff(doc, line, [lineText], newLines, { insertMode: blank, wholeFile: false });
    if (count === 0) this.noChanges();
  }

  private async resolveFile(p: string): Promise<vscode.Uri | undefined> {
    const clean = p.replace(/^["'`]+|["'`]+$/g, '').replace(/:\d+(?:-\d+)?$/, '').replace(/^\.\//, '');
    const candidates: vscode.Uri[] = [];
    if (path.isAbsolute(clean)) candidates.push(vscode.Uri.file(clean));
    else {
      for (const folder of vscode.workspace.workspaceFolders ?? []) candidates.push(vscode.Uri.joinPath(folder.uri, clean));
      const active = vscode.window.activeTextEditor?.document.uri;
      if (active?.scheme === 'file') candidates.push(vscode.Uri.file(path.resolve(path.dirname(active.fsPath), clean)));
    }
    for (const uri of candidates) {
      try {
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.type & vscode.FileType.File) return uri;
      } catch {
        // not there
      }
    }
    return undefined;
  }

  private async offerCreate(p: string, code: string): Promise<boolean> {
    const clean = p.replace(/^["'`]+|["'`]+$/g, '').replace(/:\d+(?:-\d+)?$/, '');
    const base = path.isAbsolute(clean) ? undefined : vscode.workspace.workspaceFolders?.[0]?.uri;
    if (!path.isAbsolute(clean) && !base) return false;
    const uri = path.isAbsolute(clean) ? vscode.Uri.file(clean) : vscode.Uri.joinPath(base!, clean);
    const pick = await vscode.window.showInformationMessage(`Kursor: ${vscode.workspace.asRelativePath(uri, false)} does not exist. Create it with this code?`, 'Create file', 'Apply to active editor');
    if (pick !== 'Create file') return false;
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(`${code}\n`, 'utf8'));
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { preview: false });
    this.deps.log.info(`applyCode: created ${uri.fsPath}`);
    return true;
  }

  private noChanges(): void {
    void vscode.window.setStatusBarMessage('$(info) Kursor: the file already matches this code', 4000);
  }
}

function inlineModel(): string | undefined {
  const model = vscode.workspace.getConfiguration('kursor').get<string>('inlineEdit.model', 'sonnet').trim();
  return model || undefined;
}
