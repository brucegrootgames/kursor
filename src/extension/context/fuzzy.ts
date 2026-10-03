/**
 * Small fuzzy scorer for @-mention file search (fzf v1 style).
 *
 * Algorithm: forward scan to find the end of the first subsequence match, then a
 * backward scan from that end to find the tightest window. The window is then
 * scored with bonuses for path/word boundaries, camelCase humps, consecutive
 * matches, basename matches and exact-case matches, and penalties for gaps and
 * for long targets (prefer shorter paths). Returns `null` when the query is not
 * a subsequence of the target.
 */

const BONUS_BOUNDARY = 16; // char after '/', '_', '-', '.', ' '
const BONUS_CAMEL = 12; // lower → Upper hump
const BONUS_CONSECUTIVE = 10;
const BONUS_FIRST_CHAR = 8; // match at index 0
const BONUS_BASENAME = 6; // per matched char inside the basename
const BONUS_CASE = 2;
const PENALTY_GAP_START = 3;
const PENALTY_GAP_EXTEND = 1;

function isBoundaryChar(c: number): boolean {
  // '/', '\\', '_', '-', '.', ' ', ':'
  return c === 47 || c === 92 || c === 95 || c === 45 || c === 46 || c === 32 || c === 58;
}
function isLower(c: number): boolean {
  return c >= 97 && c <= 122;
}
function isUpper(c: number): boolean {
  return c >= 65 && c <= 90;
}
function lowerCode(c: number): number {
  return isUpper(c) ? c + 32 : c;
}

export function fuzzyScore(query: string, target: string): number | null {
  if (!query) return 0;
  const qLen = query.length;
  const tLen = target.length;
  if (qLen > tLen) return null;

  // Forward pass: find the earliest end position of a subsequence match.
  let qi = 0;
  let end = -1;
  for (let ti = 0; ti < tLen && qi < qLen; ti++) {
    if (lowerCode(target.charCodeAt(ti)) === lowerCode(query.charCodeAt(qi))) {
      qi++;
      if (qi === qLen) {
        end = ti;
        break;
      }
    }
  }
  if (end < 0) return null;

  // Backward pass from `end`: find the latest start such that the query still matches.
  qi = qLen - 1;
  let start = -1;
  for (let ti = end; ti >= 0 && qi >= 0; ti--) {
    if (lowerCode(target.charCodeAt(ti)) === lowerCode(query.charCodeAt(qi))) {
      qi--;
      if (qi < 0) {
        start = ti;
        break;
      }
    }
  }
  if (start < 0) start = 0;

  // Score the window [start, end] greedily (left to right).
  const baseStart = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\')) + 1;
  let score = 0;
  let prevMatched = false;
  let inGap = false;
  qi = 0;
  for (let ti = start; ti <= end && qi < qLen; ti++) {
    const tc = target.charCodeAt(ti);
    const qc = query.charCodeAt(qi);
    if (lowerCode(tc) === lowerCode(qc)) {
      qi++;
      let bonus = 0;
      if (ti === 0) bonus += BONUS_FIRST_CHAR + BONUS_BOUNDARY;
      else {
        const prev = target.charCodeAt(ti - 1);
        if (isBoundaryChar(prev)) bonus += BONUS_BOUNDARY;
        else if (isLower(prev) && isUpper(tc)) bonus += BONUS_CAMEL;
      }
      if (prevMatched) bonus += BONUS_CONSECUTIVE;
      if (ti >= baseStart) bonus += BONUS_BASENAME;
      if (tc === qc && isUpper(qc)) bonus += BONUS_CASE;
      score += 4 + bonus;
      prevMatched = true;
      inGap = false;
    } else {
      score -= inGap ? PENALTY_GAP_EXTEND : PENALTY_GAP_START;
      inGap = true;
      prevMatched = false;
    }
  }
  // Prefer shorter targets and tighter windows.
  score -= Math.min(20, Math.floor(tLen / 12));
  score -= Math.min(10, end - start + 1 - qLen);
  // Whole-basename exact prefix is a strong signal.
  const base = target.slice(baseStart).toLowerCase();
  if (base.startsWith(query.toLowerCase())) score += 20;
  if (base === query.toLowerCase()) score += 30;
  return score;
}

export interface Ranked<T> {
  item: T;
  score: number;
}

/** Rank `items` by fuzzy score of `selector(item)`; returns the best `limit` matches (stable for ties). */
export function rankFuzzy<T>(query: string, items: readonly T[], selector: (item: T) => string, limit: number): Ranked<T>[] {
  const out: Ranked<T>[] = [];
  const q = query.trim();
  if (!q) {
    for (let i = 0; i < items.length && out.length < limit; i++) out.push({ item: items[i], score: 0 });
    return out;
  }
  for (const item of items) {
    const s = fuzzyScore(q, selector(item));
    if (s !== null) out.push({ item, score: s });
  }
  out.sort((a, b) => b.score - a.score || selector(a.item).length - selector(b.item).length);
  return out.length > limit ? out.slice(0, limit) : out;
}
