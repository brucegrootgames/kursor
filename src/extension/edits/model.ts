/**
 * Pure data model for agent edits: tracked files, hunks, stats and hunk
 * application helpers (jsdiff based; no VS Code dependency so it can be
 * unit-tested with plain node).
 */
import { diffLines, structuredPatch } from 'diff';

export interface TrackedFile {
  path: string;
  /** Content before the first agent change; null when the file did not exist. */
  base: string | null;
  /** Latest known content; null when the file was deleted by the agent. */
  current: string | null;
  chatId: string;
  toolUseIds: string[];
  /** Bumped whenever `base` changes so the `kursor-orig` URI query changes. */
  version: number;
  updatedAt: number;
}

export interface Hunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  /** Lines with '+', '-' or ' ' prefix (no "\ No newline" markers). */
  lines: string[];
}

export function splitLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

export function endsWithNewline(text: string): boolean {
  return text.length > 0 && text.endsWith('\n');
}

/** Hunks (context 0) transforming `base` into `current`. */
export function computeHunks(base: string, current: string): Hunk[] {
  if (base === current) return [];
  const patch = structuredPatch('a', 'b', base, current, '', '', { context: 0 });
  return patch.hunks.map((h) => ({
    oldStart: h.oldStart,
    oldLines: h.oldLines,
    newStart: h.newStart,
    newLines: h.newLines,
    lines: h.lines.filter((l) => !l.startsWith('\\')),
  }));
}

export function hunkOldLines(h: Hunk): string[] {
  return h.lines.filter((l) => l[0] === '-' || l[0] === ' ').map((l) => l.slice(1));
}
export function hunkNewLines(h: Hunk): string[] {
  return h.lines.filter((l) => l[0] === '+' || l[0] === ' ').map((l) => l.slice(1));
}

export interface LineStats {
  additions: number;
  deletions: number;
}

export function lineStats(base: string | null, current: string | null): LineStats {
  const a = base ?? '';
  const b = current ?? '';
  if (a === b) return { additions: 0, deletions: 0 };
  let additions = 0;
  let deletions = 0;
  for (const part of diffLines(a, b)) {
    const n = part.count ?? splitLines(part.value).length;
    if (part.added) additions += n;
    else if (part.removed) deletions += n;
  }
  return { additions, deletions };
}

/**
 * Apply hunk `h` (computed from base→current) to `base`, i.e. accept it:
 * the returned text differs from `base` only by this hunk.
 */
export function applyHunkForward(base: string, h: Hunk, currentTrailingNewline: boolean): string {
  const lines = splitLines(base);
  const total = lines.length;
  const start = Math.max(0, h.oldStart - 1);
  lines.splice(start, h.oldLines, ...hunkNewLines(h));
  if (!lines.length) return '';
  const atEnd = start + h.oldLines >= total;
  const trailing = atEnd ? currentTrailingNewline : endsWithNewline(base);
  return lines.join('\n') + (trailing ? '\n' : '');
}

/**
 * Revert hunk `h` (computed from base→current) in `current`: the returned
 * text equals `current` with this hunk's new lines replaced by its old lines.
 */
export function revertHunk(current: string, h: Hunk, baseTrailingNewline: boolean): string {
  const lines = splitLines(current);
  const total = lines.length;
  const start = Math.max(0, h.newStart - 1);
  lines.splice(start, h.newLines, ...hunkOldLines(h));
  if (!lines.length) return '';
  const atEnd = start + h.newLines >= total;
  const trailing = atEnd ? baseTrailingNewline : endsWithNewline(current);
  return lines.join('\n') + (trailing ? '\n' : '');
}

/** Common-prefix/suffix minimal replacement between two strings (character offsets). */
export function minimalReplacement(oldText: string, newText: string): { start: number; end: number; text: string } | undefined {
  if (oldText === newText) return undefined;
  let prefix = 0;
  const max = Math.min(oldText.length, newText.length);
  while (prefix < max && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (suffix < max - prefix && oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)) suffix++;
  return { start: prefix, end: oldText.length - suffix, text: newText.slice(prefix, newText.length - suffix) };
}
