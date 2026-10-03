/**
 * Post-processing of the model output for Ctrl+K (pure; unit-tested).
 * The model is asked for "replacement code only", but we defensively handle fences, echoed
 * <region> tags, lost base indentation and tab/space mismatches.
 */
import { splitLines } from './diffBlocks';

export interface CleanOptions {
  /** Lines of the original region (used to restore indentation and trailing blank lines). */
  originalLines: readonly string[];
  /** Editor `insertSpaces` for the document. */
  insertSpaces: boolean;
  tabSize: number;
  /** In insert mode there is no original indentation to preserve except the current line's. */
  insertMode?: boolean;
}

const FENCE_OPEN = /^\s*(`{3,}|~{3,})\s*[\w+#.-]*\s*$/;
const FENCE_CLOSE = /^\s*(`{3,}|~{3,})\s*$/;

function trimBlankEdges(lines: string[]): string[] {
  const out = [...lines];
  while (out.length > 0 && out[0].trim() === '') out.shift();
  while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
  return out;
}

function looksLikeProse(lines: readonly string[]): boolean {
  const nonBlank = lines.filter((l) => l.trim() !== '');
  if (nonBlank.length === 0) return true;
  if (nonBlank.length > 2) return false;
  const text = nonBlank.join(' ');
  if (text.length > 240) return false;
  // A prose line ends with ':' or '.' or is a short "Here is…" style sentence; a code line usually is not.
  return /[:.!]\s*$/.test(text) || /^(here|this|the|i |sure|below|updated|replacement)/i.test(text.trim());
}

/** Unwrap a ```lang … ``` block when the output is a fenced block (optionally with a short prose line around it). */
export function unwrapFences(text: string): string {
  const lines = trimBlankEdges(splitLines(text));
  const open = lines.findIndex((l) => FENCE_OPEN.test(l));
  if (open === -1) return lines.join('\n');
  let close = -1;
  for (let i = lines.length - 1; i > open; i--) {
    if (FENCE_CLOSE.test(lines[i])) {
      close = i;
      break;
    }
  }
  const before = lines.slice(0, open);
  const after = close === -1 ? [] : lines.slice(close + 1);
  if (looksLikeProse(before) && looksLikeProse(after)) {
    return lines.slice(open + 1, close === -1 ? lines.length : close).join('\n');
  }
  return lines.join('\n');
}

/** Remove echoed <region>/<replacement> wrapper tags. */
export function stripWrapperTags(text: string): string {
  const lines = splitLines(text);
  const isTag = (l: string): boolean => /^\s*<\/?(region|replacement|code|output)>\s*$/i.test(l);
  if (lines.length >= 2 && isTag(lines[0]) && isTag(lines[lines.length - 1])) {
    return lines.slice(1, -1).join('\n');
  }
  return text;
}

function leadingWhitespace(line: string): string {
  return /^[ \t]*/.exec(line)?.[0] ?? '';
}

/** Shortest leading whitespace among non-blank lines ('' when any non-blank line is flush left). */
export function minIndent(lines: readonly string[]): string {
  let best: string | undefined;
  for (const l of lines) {
    if (l.trim() === '') continue;
    const ws = leadingWhitespace(l);
    if (best === undefined || ws.length < best.length) best = ws;
    if (best === '') break;
  }
  return best ?? '';
}

/** Re-add the original base indentation if the model flushed the code left. */
export function restoreIndentation(lines: string[], originalLines: readonly string[]): string[] {
  const orig = minIndent(originalLines);
  if (orig === '') return lines;
  const out = minIndent(lines);
  if (out !== '') return lines;
  return lines.map((l) => (l.trim() === '' ? l : orig + l));
}

/** Convert leading indentation to the document's tab/space convention. */
export function normalizeIndentStyle(lines: string[], insertSpaces: boolean, tabSize: number): string[] {
  const size = Math.max(1, Math.floor(tabSize) || 4);
  const usesTabs = lines.some((l) => /^\t/.test(l));
  const usesSpaces = lines.some((l) => /^ {2,}/.test(l));
  if (insertSpaces && usesTabs) {
    return lines.map((l) => l.replace(/^[ \t]+/, (ws) => ws.replace(/\t/g, ' '.repeat(size))));
  }
  if (!insertSpaces && usesSpaces && !usesTabs) {
    const spaces = ' '.repeat(size);
    return lines.map((l) =>
      l.replace(/^ +/, (ws) => {
        const tabs = Math.floor(ws.length / size);
        return '\t'.repeat(tabs) + ws.slice(tabs * size);
      }),
    );
  }
  return lines;
}

function trailingBlankCount(lines: readonly string[]): number {
  let n = 0;
  for (let i = lines.length - 1; i >= 0 && lines[i].trim() === ''; i--) n++;
  return n;
}

/**
 * Full pipeline: fences → wrapper tags → blank edges → indentation → trailing blank lines.
 * Returns the replacement lines; an empty array means the model produced nothing usable.
 */
export function cleanModelOutput(raw: string, options: CleanOptions): string[] {
  let text = raw.replace(/\r\n?/g, '\n');
  text = unwrapFences(text);
  text = stripWrapperTags(text);
  let lines = trimBlankEdges(splitLines(text));
  if (lines.length === 0) return [];
  lines = lines.map((l) => l.replace(/[ \t]+$/, (ws) => (l.trim() === '' ? '' : ws)));
  if (!options.insertMode) lines = restoreIndentation(lines, options.originalLines);
  lines = normalizeIndentStyle(lines, options.insertSpaces, options.tabSize);
  if (!options.insertMode) {
    // Keep the region's trailing blank lines (e.g. a separator after a function) unchanged.
    const keep = trailingBlankCount(options.originalLines);
    for (let i = 0; i < keep; i++) lines.push('');
  }
  return lines;
}

/**
 * Heuristic used by "Apply" from chat: does the snippet look like a partial file (with
 * "... existing code ..." placeholders or much shorter than the file) rather than a full file?
 */
export function looksLikeFragment(codeLines: readonly string[], fileLines: readonly string[]): boolean {
  // "// ... existing code ..." (comment marker + dots) or a bare "..." / "... rest of the file" line;
  // NOT JavaScript spread lines such as "...rest,".
  const commented = /^[ \t]*(?:\/\/|#|--|\/\*|<!--|\*|;|%|")[ \t]*(?:\.\.\.|…)/;
  const bare = /^[ \t]*(?:\.\.\.|…)(?:[ \t]*$|[ \t]+(?:existing|rest|remaining|unchanged|other|the|previous|same|code)\b|[ \t]*[([][ \t]*(?:existing|rest|remaining|unchanged|other|the|previous|same|code)\b)/i;
  if (codeLines.some((l) => l.trim().length < 80 && (commented.test(l) || bare.test(l)))) return true;
  const fileNonBlank = fileLines.filter((l) => l.trim() !== '');
  const codeNonBlank = codeLines.filter((l) => l.trim() !== '');
  if (fileNonBlank.length === 0) return false;
  const ratio = codeNonBlank.length / fileNonBlank.length;
  if (ratio >= 0.6) return false;
  const first = (ls: readonly string[]): string => ls[0]?.trim() ?? '';
  const last = (ls: readonly string[]): string => ls[ls.length - 1]?.trim() ?? '';
  const sameEdges = first(codeNonBlank) === first(fileNonBlank) && last(codeNonBlank) === last(fileNonBlank);
  return !sameEdges;
}
