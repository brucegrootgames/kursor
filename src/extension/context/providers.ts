/**
 * Context providers: build `Attachment`s from the editor (selection, file,
 * diagnostics), the Problems panel, git working changes and terminal output.
 * Also `resolveAttachment`, which fills the inline `text` of attachments the
 * webview created without a payload (e.g. from an @-mention pill) right before
 * the prompt is composed.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import type { Attachment } from '../../shared/protocol';
import { workingChanges } from './git';
import type { TerminalCapture } from './terminalCapture';

export const MAX_ATTACHMENT_TEXT = 60_000;

let counter = 0;
export function newAttachmentId(): string {
  counter += 1;
  return `att-${Date.now().toString(36)}-${counter.toString(36)}`;
}

export function relPathOf(fsPath: string): string {
  const rel = vscode.workspace.asRelativePath(fsPath, false);
  return rel.split(path.sep).join('/');
}

export function truncateText(text: string, max = MAX_ATTACHMENT_TEXT): string {
  return text.length > max ? `${text.slice(0, max)}\n… (truncated, ${text.length - max} more characters)` : text;
}

export function severityLabel(s: vscode.DiagnosticSeverity): string {
  switch (s) {
    case vscode.DiagnosticSeverity.Error:
      return 'error';
    case vscode.DiagnosticSeverity.Warning:
      return 'warning';
    case vscode.DiagnosticSeverity.Information:
      return 'info';
    default:
      return 'hint';
  }
}

export function formatDiagnostic(uri: vscode.Uri, d: vscode.Diagnostic): string {
  const code = typeof d.code === 'object' && d.code ? d.code.value : d.code;
  const src = [d.source, code].filter((x) => x !== undefined && x !== '').join(' ');
  return `${relPathOf(uri.fsPath)}:${d.range.start.line + 1}:${d.range.start.character + 1} ${severityLabel(d.severity)}${src ? ` [${src}]` : ''}: ${d.message.replace(/\s+/g, ' ').trim()}`;
}

/** Selection of the given/active editor; with `allowEmpty` the current line is used when nothing is selected. */
export function selectionAttachment(editor = vscode.window.activeTextEditor, options?: { allowEmpty?: boolean }): Attachment | undefined {
  if (!editor) return undefined;
  const doc = editor.document;
  let sel: vscode.Range = editor.selection;
  if (sel.isEmpty) {
    if (!options?.allowEmpty) return undefined;
    sel = doc.lineAt(editor.selection.active.line).range;
  }
  const startLine = sel.start.line + 1;
  // A selection ending at column 0 of the next line does not include that line.
  const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
  const range = new vscode.Range(sel.start.line, 0, endLine - 1, doc.lineAt(endLine - 1).range.end.character);
  const text = doc.getText(range);
  const isFile = doc.uri.scheme === 'file';
  const fsPath = isFile ? doc.uri.fsPath : doc.uri.toString();
  const rel = isFile ? relPathOf(fsPath) : path.basename(doc.fileName);
  return {
    id: newAttachmentId(),
    kind: 'selection',
    label: `${path.basename(rel)}:${startLine}${endLine !== startLine ? `-${endLine}` : ''}`,
    path: fsPath,
    relPath: rel,
    range: { startLine, endLine },
    text: truncateText(text),
  };
}

export function fileAttachment(uri: vscode.Uri, kind: 'file' | 'folder' = 'file'): Attachment {
  const rel = relPathOf(uri.fsPath);
  return { id: newAttachmentId(), kind, label: path.basename(uri.fsPath) || rel, path: uri.fsPath, relPath: rel };
}

export function diagnosticAttachment(uri: vscode.Uri, d: vscode.Diagnostic): Attachment {
  const rel = relPathOf(uri.fsPath);
  return {
    id: newAttachmentId(),
    kind: 'diagnostic',
    label: `${path.basename(rel)}:${d.range.start.line + 1} ${severityLabel(d.severity)}`,
    path: uri.fsPath,
    relPath: rel,
    range: { startLine: d.range.start.line + 1, endLine: d.range.end.line + 1 },
    text: formatDiagnostic(uri, d),
  };
}

export interface ProblemsSummary {
  errors: number;
  warnings: number;
  files: number;
}

export function problemsSummary(uri?: vscode.Uri): ProblemsSummary {
  let errors = 0;
  let warnings = 0;
  let files = 0;
  for (const [u, diags] of vscode.languages.getDiagnostics()) {
    if (uri && u.toString() !== uri.toString()) continue;
    let any = false;
    for (const d of diags) {
      if (d.severity === vscode.DiagnosticSeverity.Error) {
        errors += 1;
        any = true;
      } else if (d.severity === vscode.DiagnosticSeverity.Warning) {
        warnings += 1;
        any = true;
      }
    }
    if (any) files += 1;
  }
  return { errors, warnings, files };
}

/** Problems panel content (errors + warnings), optionally limited to one file. */
export function problemsText(uri?: vscode.Uri, maxEntries = 200): string {
  const lines: string[] = [];
  let total = 0;
  const all = vscode.languages.getDiagnostics().filter(([u]) => !uri || u.toString() === uri.toString());
  for (const [u, diags] of all) {
    const relevant = diags.filter((d) => d.severity <= vscode.DiagnosticSeverity.Warning).sort((a, b) => a.severity - b.severity);
    for (const d of relevant) {
      total += 1;
      if (lines.length < maxEntries) lines.push(formatDiagnostic(u, d));
    }
  }
  if (!lines.length) return uri ? `No errors or warnings in ${relPathOf(uri.fsPath)}.` : 'No errors or warnings in the workspace.';
  if (total > lines.length) lines.push(`… and ${total - lines.length} more`);
  return lines.join('\n');
}

export function problemsAttachment(uri?: vscode.Uri): Attachment {
  return {
    id: newAttachmentId(),
    kind: 'problems',
    label: uri ? `Problems: ${path.basename(uri.fsPath)}` : 'Problems',
    path: uri?.fsPath,
    relPath: uri ? relPathOf(uri.fsPath) : undefined,
    text: truncateText(problemsText(uri)),
  };
}

export async function gitAttachment(fsPath?: string): Promise<Attachment> {
  const wc = await workingChanges(fsPath);
  const text = wc ? wc.diff || `No uncommitted changes${wc.branch ? ` on ${wc.branch}` : ''}.` : 'No git repository found for this workspace.';
  return {
    id: newAttachmentId(),
    kind: 'git',
    label: `Git changes${wc?.branch ? ` (${wc.branch})` : ''}`,
    text: truncateText(text),
  };
}

export function terminalAttachment(text: string, name = 'Terminal'): Attachment {
  return { id: newAttachmentId(), kind: 'terminal', label: name, text: truncateText(text) };
}

export function urlAttachment(url: string): Attachment {
  let label = url;
  try {
    const u = new URL(url);
    label = u.host + (u.pathname !== '/' ? u.pathname : '');
  } catch {
    /* keep raw */
  }
  return { id: newAttachmentId(), kind: 'url', label: label.length > 40 ? `${label.slice(0, 39)}…` : label, url };
}

async function readRange(fsPath: string, range?: { startLine: number; endLine: number }): Promise<string | undefined> {
  try {
    const uri = vscode.Uri.file(fsPath);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.fsPath === fsPath);
    const text = open ? open.getText() : Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
    if (!range) return truncateText(text);
    const lines = text.split('\n');
    const start = Math.max(1, range.startLine);
    const end = Math.min(lines.length, Math.max(start, range.endLine));
    return truncateText(lines.slice(start - 1, end).join('\n'));
  } catch {
    return undefined;
  }
}

/**
 * Fill missing payloads. The webview may create attachments from mention
 * results (no text) — make them self-contained before prompt composition.
 */
export async function resolveAttachment(att: Attachment, terminals: TerminalCapture, cwd?: string): Promise<Attachment> {
  if (att.text !== undefined && att.text !== '') return att;
  const a: Attachment = { ...att };
  switch (a.kind) {
    case 'problems': {
      const uri = a.path ? vscode.Uri.file(a.path) : undefined;
      a.text = truncateText(problemsText(uri));
      return a;
    }
    case 'git': {
      const g = await gitAttachment(a.path ?? cwd);
      a.text = g.text;
      if (!a.label) a.label = g.label;
      return a;
    }
    case 'terminal': {
      const t = terminals.lastOutput();
      a.text = t?.text ?? '(no terminal output captured — shell integration may be unavailable)';
      return a;
    }
    case 'selection':
    case 'diagnostic': {
      if (a.path) {
        const text = await readRange(a.path, a.range);
        if (text !== undefined) a.text = text;
        if (!a.relPath) a.relPath = relPathOf(a.path);
      } else {
        const sel = selectionAttachment();
        if (sel) return { ...sel, id: a.id, label: a.label || sel.label };
      }
      return a;
    }
    case 'file':
    case 'folder':
    case 'rule':
      if (a.path && !a.relPath) a.relPath = relPathOf(a.path);
      return a;
    default:
      return a;
  }
}
