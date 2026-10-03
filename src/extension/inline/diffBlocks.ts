/**
 * Pure logic for the Ctrl+K vertical diff engine (no `vscode` imports — unit-tested in
 * `__tests__/diffBlocks.test.mjs`).
 *
 * Model (ported from Continue's VerticalDiffHandler):
 *   - a diffed region is rewritten in the document as: unchanged lines, one EMPTY placeholder
 *     line per removed line (rendered red with the old text as ghost text) and the new lines
 *     (rendered green) — red placeholders always sit directly ABOVE the green lines of a block;
 *   - a `DiffBlock` records where each red/green group lives (`start` = first red line, or the
 *     first green line when nothing was removed);
 *   - accepting a block deletes its red placeholder lines; rejecting deletes the green lines and
 *     puts the old text back. Both shift every later block by the number of lines removed.
 */
import { diffLines } from 'diff';

export type DiffLineType = 'same' | 'old' | 'new';

export interface DiffLine {
  type: DiffLineType;
  line: string;
}

export interface DiffBlock {
  /** 0-based line index of the first line of the block (first red placeholder, or first green line when numRed === 0). */
  start: number;
  numRed: number;
  numGreen: number;
  /** Original text of the red lines (ghost text; restored on reject). `oldLines.length === numRed`. */
  oldLines: string[];
}

export interface VerticalDiffPlan {
  /** Lines to write in place of the old region: unchanged lines, '' placeholders for removed lines, new lines. */
  lines: string[];
  /** Blocks with `start` relative to the first line of the region. */
  blocks: DiffBlock[];
  numOld: number;
  numNew: number;
}

/** Split text into lines the way VS Code's TextDocument does ("a\nb\n" → ['a','b','']). */
export function splitLines(text: string): string[] {
  return text.replace(/\r\n?/g, '\n').split('\n');
}

/** jsdiff `diffLines` → flat list of same/old/new lines (removed lines are emitted before added ones). */
export function toDiffLines(oldLines: readonly string[], newLines: readonly string[]): DiffLine[] {
  if (oldLines.length === 0 && newLines.length === 0) return [];
  if (oldLines.length === 0) return newLines.map((line) => ({ type: 'new', line }));
  if (newLines.length === 0) return oldLines.map((line) => ({ type: 'old', line }));
  // Give every line a trailing "\n" so each jsdiff token is exactly one full line.
  const changes = diffLines(oldLines.join('\n') + '\n', newLines.join('\n') + '\n');
  const out: DiffLine[] = [];
  for (const change of changes) {
    const type: DiffLineType = change.added ? 'new' : change.removed ? 'old' : 'same';
    const parts = change.value.split('\n');
    if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop();
    for (const line of parts) out.push({ type, line });
  }
  return out;
}

/** Turn a DiffLine stream into document lines + blocks (Continue's `insertDeletionBuffer` layout). */
export function buildPlan(diff: readonly DiffLine[]): VerticalDiffPlan {
  const lines: string[] = [];
  const blocks: DiffBlock[] = [];
  let red: string[] = [];
  let green: string[] = [];
  let numOld = 0;
  let numNew = 0;
  const flush = (): void => {
    if (red.length === 0 && green.length === 0) return;
    blocks.push({ start: lines.length, numRed: red.length, numGreen: green.length, oldLines: red });
    for (let i = 0; i < red.length; i++) lines.push('');
    for (const g of green) lines.push(g);
    red = [];
    green = [];
  };
  for (const d of diff) {
    if (d.type === 'same') {
      flush();
      lines.push(d.line);
    } else if (d.type === 'old') {
      red.push(d.line);
      numOld++;
    } else {
      green.push(d.line);
      numNew++;
    }
  }
  flush();
  return { lines, blocks, numOld, numNew };
}

export function computeVerticalDiff(oldLines: readonly string[], newLines: readonly string[]): VerticalDiffPlan {
  return buildPlan(toDiffLines(oldLines, newLines));
}

export function blockLength(block: DiffBlock): number {
  return block.numRed + block.numGreen;
}

/** Exclusive end line of a block. */
export function blockEnd(block: DiffBlock): number {
  return block.start + blockLength(block);
}

/** Index of the block containing `line`, or -1. */
export function findBlockAtLine(blocks: readonly DiffBlock[], line: number): number {
  return blocks.findIndex((b) => line >= b.start && line < blockEnd(b));
}

/** Index of the block containing `line`, else the nearest block below it, else the last block; -1 when there are none. */
export function findBlockNearLine(blocks: readonly DiffBlock[], line: number): number {
  if (blocks.length === 0) return -1;
  const at = findBlockAtLine(blocks, line);
  if (at !== -1) return at;
  const below = blocks.findIndex((b) => b.start > line);
  return below !== -1 ? below : blocks.length - 1;
}

/**
 * Bookkeeping after a block was accepted (its red placeholders deleted: delta = -numRed) or
 * rejected (its green lines deleted, old text re-inserted: delta = -numGreen).
 */
export function removeBlock(blocks: readonly DiffBlock[], index: number, accept: boolean): DiffBlock[] {
  const target = blocks[index];
  if (!target) return [...blocks];
  const delta = -(accept ? target.numRed : target.numGreen);
  return blocks
    .filter((_, i) => i !== index)
    .map((b) => (b.start > target.start ? { ...b, start: b.start + delta } : { ...b }));
}

/**
 * Bookkeeping for a document change the engine did not make itself: `line` is the first line of
 * the changed range and `delta` = lines added − lines deleted. Blocks below the change move; a
 * change inside the green part of a block grows/shrinks that part; a change inside the red part
 * (hidden placeholders) is treated as a shift of everything below the block.
 */
export function shiftBlocksForEdit(blocks: readonly DiffBlock[], line: number, delta: number): DiffBlock[] {
  if (delta === 0) return blocks.map((b) => ({ ...b }));
  return blocks.map((b) => {
    if (line < b.start) return { ...b, start: b.start + delta };
    const greenStart = b.start + b.numRed;
    if (line >= greenStart && line < blockEnd(b)) {
      return { ...b, numGreen: Math.max(0, b.numGreen + delta) };
    }
    return { ...b };
  });
}

/** Lines added − lines deleted for a content change described by its range and inserted text. */
export function lineDeltaOfChange(startLine: number, endLine: number, insertedText: string): number {
  const added = splitLines(insertedText).length - 1;
  const deleted = endLine - startLine;
  return added - deleted;
}

/** Simulate "accept all" on a line array (drops every red placeholder line). */
export function acceptAllLines(lines: readonly string[], blocks: readonly DiffBlock[]): string[] {
  const drop = new Set<number>();
  for (const b of blocks) for (let i = 0; i < b.numRed; i++) drop.add(b.start + i);
  return lines.filter((_, i) => !drop.has(i));
}

/** Simulate "reject all" on a line array (restores old text, drops green lines). */
export function rejectAllLines(lines: readonly string[], blocks: readonly DiffBlock[]): string[] {
  const out: string[] = [];
  const sorted = [...blocks].sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const b of sorted) {
    for (let i = cursor; i < b.start; i++) out.push(lines[i] ?? '');
    out.push(...b.oldLines);
    cursor = blockEnd(b);
  }
  for (let i = cursor; i < lines.length; i++) out.push(lines[i] ?? '');
  return out;
}

/** Simulate accepting/rejecting a single block on a line array; returns the new lines and blocks. */
export function applyBlockDecision(
  lines: readonly string[],
  blocks: readonly DiffBlock[],
  index: number,
  accept: boolean,
): { lines: string[]; blocks: DiffBlock[] } {
  const b = blocks[index];
  if (!b) return { lines: [...lines], blocks: [...blocks] };
  const next = [...lines];
  if (accept) next.splice(b.start, b.numRed);
  else next.splice(b.start, blockLength(b), ...b.oldLines);
  return { lines: next, blocks: removeBlock(blocks, index, accept) };
}
