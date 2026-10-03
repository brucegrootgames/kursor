/**
 * Turns raw model output into something safe to show as ghost text.
 * Pure function — unit-testable without VS Code.
 *
 *  1. normalise newlines, drop the <CURSOR> marker if echoed
 *  2. strip leading prose ("Here is the completion:") and markdown fences
 *  3. drop an echoed copy of the text already before the caret
 *  4. reconcile with the text after the caret on the same line:
 *       - suffix empty                      → multi-line insertion
 *       - completion ends with the suffix   → replace to end of line (ghost text
 *         renders as a pure insertion, the closing bracket moves down)
 *       - suffix is only closers ")]};," and the completion starts on a new
 *         line (caret between `{` and `}`) → multi-line insertion
 *       - anything else                     → single line, overlap with suffix removed
 *  5. drop trailing lines that merely echo the following document lines
 *     (unless they close brackets the completion itself opened)
 *  6. cap at `maxLines`, trim trailing blank lines, reject empty results
 */
import { CURSOR_MARKER, MAX_COMPLETION_LINES } from './constants';

export interface SanitizeInput {
  raw: string;
  /** Text on the cursor line before the caret. */
  linePrefix: string;
  /** Text on the cursor line after the caret (untrimmed). */
  lineSuffix: string;
  /** Document lines after the cursor line. */
  followingLines: string[];
  maxLines?: number;
}

export interface SanitizedCompletion {
  text: string;
  /** When true the item's range must span from the caret to the end of the line. */
  replaceToLineEnd: boolean;
}

const PROSE_LINE = /^\s*(here('s| is| are)\b|sure\b|certainly\b|okay\b|ok\b|the (code|completion|text)\b|this (code|completion)\b|i (would|will|'d|'ll)\b|based on\b|to (complete|continue)\b|completion\s*:)/i;
const CLOSERS_ONLY = /^[\]\)\}>;,\s]+$/;

export function sanitizeCompletion(input: SanitizeInput): SanitizedCompletion | undefined {
  const maxLines = input.maxLines ?? MAX_COMPLETION_LINES;
  let text = input.raw.replace(/\r\n?/g, '\n');
  if (!text.trim()) return undefined;

  text = text.split(CURSOR_MARKER).join('');
  text = stripLeadingProse(text);
  text = stripFences(text);
  text = stripLeadingProse(text);
  text = stripEchoedPrefix(text, input.linePrefix);
  if (!text.trim()) return undefined;

  let lines = text.split('\n');
  const suffixTrim = input.lineSuffix.trim();
  let replaceToLineEnd = false;

  if (suffixTrim.length > 0) {
    const tail = text.trimEnd();
    if (lines.length > 1 && tail.endsWith(suffixTrim) && bracketBalance(input.linePrefix + lines[0]) > 0) {
      // Model reproduced the closing text for something still open after its first line
      // (`foo(|)` → `a => {…})`, `{|}` → `\n  body\n}`): keep it and replace the rest of the line.
      // When the first line already closed the opener (`call(|);` → `a, b)\n foo();`) the match
      // is coincidental and we fall through to single-line mode.
      text = tail.slice(0, tail.length - suffixTrim.length) + input.lineSuffix;
      lines = text.split('\n');
      replaceToLineEnd = true;
    } else if (lines.length > 1 && CLOSERS_ONLY.test(suffixTrim) && lines[0].trim() === '') {
      // Caret between `{` and an auto-closed `}`: a multi-line body is fine; drop echoed closers.
      lines = dropSuffixOverlapLines(lines, [input.lineSuffix, ...input.followingLines], input.linePrefix);
    } else {
      // Caret is mid-line with real code after it: only the rest of this line makes sense.
      lines = [stripSameLineOverlap(lines[0], input.lineSuffix)];
    }
  } else {
    lines = dropSuffixOverlapLines(lines, input.followingLines, input.linePrefix);
  }

  if (!replaceToLineEnd) {
    if (lines.length > maxLines) lines = lines.slice(0, maxLines);
    // Trailing blank lines add nothing.
    while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
    // A completion that *starts* with blank lines only makes sense when the caret
    // sits at the end of a non-empty line (then "\n..." means "next line").
    if (input.linePrefix.trim() === '') {
      while (lines.length && lines[0].trim() === '') lines.shift();
    } else {
      // At most one leading blank line, otherwise we insert empty space.
      while (lines.length > 1 && lines[0].trim() === '' && lines[1].trim() === '') lines.shift();
    }
  } else if (lines.length > maxLines + 1) {
    return undefined;
  }

  const result = lines.join('\n');
  if (result.trim() === '') return undefined;
  if (replaceToLineEnd && !result.endsWith(input.lineSuffix)) return undefined;
  return { text: result, replaceToLineEnd };
}

/** Remove a balanced ```fence``` wrapper, or dangling fence lines at either edge. */
export function stripFences(text: string): string {
  const balanced = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text);
  if (balanced) return balanced[1];
  let lines = text.split('\n');
  while (lines.length && /^\s*```/.test(lines[0])) lines = lines.slice(1);
  while (lines.length && /^\s*```\s*$/.test(lines[lines.length - 1])) lines = lines.slice(0, -1);
  return lines.join('\n');
}

/** Drop leading "Here is the completion:" style lines (and the blank lines before them). */
function stripLeadingProse(text: string): string {
  const lines = text.split('\n');
  let i = 0;
  while (i < lines.length && lines[i].trim() === '') i++;
  if (i >= lines.length) return text;
  if (!PROSE_LINE.test(lines[i]) || !/[:.]\s*$/.test(lines[i].trim())) return text;
  // Skip the prose line and any blank lines that follow it.
  i++;
  while (i < lines.length && lines[i].trim() === '') i++;
  return i < lines.length ? lines.slice(i).join('\n') : '';
}

function stripEchoedPrefix(text: string, linePrefix: string): string {
  if (linePrefix.trim() === '') return text;
  if (text.startsWith(linePrefix)) return text.slice(linePrefix.length);
  const lead = linePrefix.trimStart();
  if (text.startsWith(lead)) return text.slice(lead.length);
  // Model echoed the whole line with different leading whitespace.
  const firstNl = text.indexOf('\n');
  const first = firstNl === -1 ? text : text.slice(0, firstNl);
  if (first.trimStart().startsWith(lead) && first.trimStart() !== lead) {
    return first.trimStart().slice(lead.length) + (firstNl === -1 ? '' : text.slice(firstNl));
  }
  return text;
}

/** Remove the longest tail of `line` that is a prefix of `suffix` (e.g. "bar)" vs ")"). */
export function stripSameLineOverlap(line: string, suffix: string): string {
  for (const candidate of [suffix, suffix.trimStart(), suffix.trim()]) {
    if (!candidate) continue;
    const max = Math.min(line.length, candidate.length);
    for (let k = max; k >= 1; k--) {
      if (line.endsWith(candidate.slice(0, k))) return line.slice(0, line.length - k);
    }
  }
  return line;
}

/**
 * Drop trailing completion lines that merely repeat the (non-blank) document
 * lines after the caret. A tail made only of closing brackets is kept when the
 * text before it (line prefix + kept completion) has unclosed openers — then the
 * model is closing its own block, not echoing the document's closer.
 */
export function dropSuffixOverlapLines(lines: string[], docAfter: string[], linePrefix: string = ''): string[] {
  const after = docAfter.map((l) => l.trim()).filter((l) => l !== '');
  const nonBlank: number[] = [];
  lines.forEach((l, i) => {
    if (l.trim() !== '') nonBlank.push(i);
  });
  const max = Math.min(nonBlank.length, after.length);
  for (let n = max; n >= 1; n--) {
    const tailIdx = nonBlank.slice(nonBlank.length - n);
    const tail = tailIdx.map((i) => lines[i].trim());
    if (tail.join('\n') !== after.slice(0, n).join('\n')) continue;
    const keptText = `${linePrefix}\n${lines.slice(0, tailIdx[0]).join('\n')}`;
    if (tail.every((l) => CLOSERS_ONLY.test(l)) && bracketBalance(keptText) > 0) continue;
    return lines.slice(0, tailIdx[0]);
  }
  return lines;
}

/** Openers minus closers for (), [], {} — string/comment-unaware on purpose (cheap heuristic). */
export function bracketBalance(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (ch === '(' || ch === '[' || ch === '{') n++;
    else if (ch === ')' || ch === ']' || ch === '}') n--;
  }
  return n;
}
