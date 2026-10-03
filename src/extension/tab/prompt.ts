/**
 * FIM ("fill in the middle") prompt for Tab completions. Kept deliberately
 * tiny: every request costs the user's subscription window, and the CLI adds
 * its own overhead, so we send only a window of prefix/suffix plus nearby
 * diagnostics.
 */
import * as vscode from 'vscode';
import { CURSOR_MARKER, MAX_COMPLETION_LINES } from './constants';

export { CURSOR_MARKER, MAX_COMPLETION_LINES } from './constants';

/** Hard caps so a pathological `contextLines` cannot blow up the prompt. */
const MAX_PREFIX_CHARS = 16_000;
const MAX_SUFFIX_CHARS = 8_000;
const MAX_DIAGNOSTICS = 3;
const DIAGNOSTIC_RADIUS_LINES = 5;

export const FIM_SYSTEM_PROMPT = [
  'You are a code completion engine embedded in a code editor.',
  `You receive a source file in which the marker ${CURSOR_MARKER} shows where the user's caret is.`,
  `Output ONLY the raw text that should be inserted at ${CURSOR_MARKER} so that the code continues naturally.`,
  '',
  'Rules:',
  '- Output plain text only: no markdown, no code fences, no explanations, no commentary.',
  '- Never repeat text that is already before the cursor, and never repeat text that already follows the cursor.',
  `- Complete the current statement, expression or block. At most ${MAX_COMPLETION_LINES} lines. Prefer short, high-confidence completions over long speculative ones.`,
  "- Match the file's language, indentation, naming and style exactly.",
  '- If the text after the cursor already continues the current line or statement, output only what is needed to reach it (often just the rest of the line) and stop.',
  '- If there is nothing sensible to add, output nothing at all (an empty response).',
].join('\n');

export interface FimContext {
  languageId: string;
  fileName: string;
  prefix: string;
  suffix: string;
  /** Text on the cursor line before the caret. */
  linePrefix: string;
  /** Text on the cursor line after the caret (may be empty). */
  lineSuffix: string;
  /** A few document lines following the cursor line (for overlap removal). */
  followingLines: string[];
  diagnostics: string[];
}

export function buildFimContext(document: vscode.TextDocument, position: vscode.Position, contextLines: number): FimContext {
  const line = document.lineAt(position.line);
  const linePrefix = line.text.slice(0, position.character);
  const lineSuffix = line.text.slice(position.character);

  const firstLine = Math.max(0, position.line - contextLines);
  const lastLine = Math.min(document.lineCount - 1, position.line + contextLines);

  let prefix = document.getText(new vscode.Range(new vscode.Position(firstLine, 0), position));
  let suffix = document.getText(new vscode.Range(position, document.lineAt(lastLine).range.end));
  if (prefix.length > MAX_PREFIX_CHARS) prefix = prefix.slice(prefix.length - MAX_PREFIX_CHARS);
  if (suffix.length > MAX_SUFFIX_CHARS) suffix = suffix.slice(0, MAX_SUFFIX_CHARS);

  const followingLines: string[] = [];
  for (let l = position.line + 1; l <= Math.min(document.lineCount - 1, position.line + MAX_COMPLETION_LINES + 2); l++) {
    followingLines.push(document.lineAt(l).text);
  }

  const diagnostics = nearbyDiagnostics(document, position);
  const fileName = vscode.workspace.asRelativePath(document.uri, false);

  return { languageId: document.languageId, fileName, prefix, suffix, linePrefix, lineSuffix, followingLines, diagnostics };
}

function nearbyDiagnostics(document: vscode.TextDocument, position: vscode.Position): string[] {
  let all: vscode.Diagnostic[];
  try {
    all = vscode.languages.getDiagnostics(document.uri);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const d of all) {
    if (d.severity !== vscode.DiagnosticSeverity.Error && d.severity !== vscode.DiagnosticSeverity.Warning) continue;
    if (Math.abs(d.range.start.line - position.line) > DIAGNOSTIC_RADIUS_LINES) continue;
    const msg = d.message.split('\n')[0].trim().slice(0, 120);
    out.push(`L${d.range.start.line + 1}: ${msg}`);
    if (out.length >= MAX_DIAGNOSTICS) break;
  }
  return out;
}

export function buildFimPrompt(ctx: FimContext): string {
  const parts: string[] = [`Language: ${ctx.languageId}`, `File: ${ctx.fileName}`];
  if (ctx.diagnostics.length) {
    parts.push('Diagnostics near the cursor (fix them if the completion touches that code):');
    for (const d of ctx.diagnostics) parts.push(`- ${d}`);
  }
  parts.push('', '<file>', `${ctx.prefix}${CURSOR_MARKER}${ctx.suffix}`, '</file>');
  return parts.join('\n');
}
