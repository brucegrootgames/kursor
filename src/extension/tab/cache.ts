/**
 * Last-result cache. Keyed per document; a hit is either the exact caret
 * position (same version) or a "typed-through" match: the user kept typing the
 * characters we suggested, so we return the remainder without a new request.
 */
import type { SanitizedCompletion } from './sanitize';

export interface CachedCompletion extends SanitizedCompletion {
  uri: string;
  version: number;
  line: number;
  character: number;
  /** Text before the caret on the line at request time. */
  linePrefix: string;
  createdAt: number;
}

const MAX_ENTRIES = 50;
const TTL_MS = 5 * 60_000;

export class CompletionCache {
  private readonly entries = new Map<string, CachedCompletion>();

  set(entry: CachedCompletion): void {
    this.entries.delete(entry.uri);
    this.entries.set(entry.uri, entry);
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  lookup(uri: string, version: number, line: number, character: number, linePrefix: string): SanitizedCompletion | undefined {
    const e = this.entries.get(uri);
    if (!e) return undefined;
    if (Date.now() - e.createdAt > TTL_MS) {
      this.entries.delete(uri);
      return undefined;
    }
    if (e.line !== line || character < e.character) return undefined;
    if (linePrefix.slice(0, e.character) !== e.linePrefix) return undefined;
    if (e.version === version && character === e.character) return { text: e.text, replaceToLineEnd: e.replaceToLineEnd };
    if (e.replaceToLineEnd) return undefined; // the range semantics no longer line up once the line changed
    const typed = linePrefix.slice(e.character);
    if (!typed || !e.text.startsWith(typed)) return undefined;
    const remainder = e.text.slice(typed.length);
    if (remainder.trim() === '') return undefined;
    return { text: remainder, replaceToLineEnd: false };
  }

  invalidate(uri: string): void {
    this.entries.delete(uri);
  }

  clear(): void {
    this.entries.clear();
  }
}
