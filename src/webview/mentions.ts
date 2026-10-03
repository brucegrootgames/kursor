/**
 * @-mention / slash-command detection in the textarea, plus the request registry for the
 * host's async `searchMentions` (requestId → callback; stale replies are dropped by the caller).
 */
import type { Attachment, MentionKind, MentionResult } from '../shared/protocol';
import { post } from './vscode';
import { uid } from './util';

export interface MentionTrigger {
  /** index of the '@' character */
  start: number;
  /** text between '@' and the caret */
  query: string;
}

/** Find an `@query` immediately before the caret (the '@' must start the text or follow whitespace). */
export function findMentionTrigger(text: string, caret: number): MentionTrigger | null {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === '@') {
      if (i === 0 || /\s/.test(text[i - 1] ?? '')) return { start: i, query: text.slice(i + 1, caret) };
      return null;
    }
    if (/\s/.test(ch ?? '')) return null;
  }
  return null;
}

export interface SlashTrigger {
  /** always 0: slash commands must start the message */
  start: number;
  query: string;
}

export function findSlashTrigger(text: string, caret: number): SlashTrigger | null {
  if (!text.startsWith('/')) return null;
  const firstWs = text.search(/\s/);
  const wordEnd = firstWs === -1 ? text.length : firstWs;
  if (caret > wordEnd) return null;
  return { start: 0, query: text.slice(1, caret) };
}

const pending = new Map<string, (results: MentionResult[]) => void>();

/** Ask the host to search. Resolves with the results when the host answers (never rejects). */
export function requestMentionSearch(query: string, kind: MentionKind | undefined, cb: (results: MentionResult[]) => void): string {
  const requestId = uid('m');
  pending.set(requestId, cb);
  post({ type: 'searchMentions', requestId, query, kind });
  // Guard against a host that never answers: drop the callback after 10 s.
  setTimeout(() => pending.delete(requestId), 10_000);
  return requestId;
}

export function deliverMentionResults(requestId: string, results: MentionResult[]): void {
  const cb = pending.get(requestId);
  if (!cb) return;
  pending.delete(requestId);
  cb(results);
}

export function looksLikeUrl(s: string): boolean {
  return /^https?:\/\/\S+$/i.test(s.trim());
}

/** Translate a picked mention result into an attachment pill (undefined = not attachable, e.g. a category). */
export function resultToAttachment(r: MentionResult): Attachment | undefined {
  switch (r.kind) {
    case 'file':
      return { id: uid('a'), kind: 'file', label: r.label, path: r.path, relPath: r.relPath };
    case 'folder':
      return { id: uid('a'), kind: 'folder', label: r.label, path: r.path, relPath: r.relPath };
    case 'code': {
      const range = parseRange(r.detail ?? '') ?? parseRange(r.label);
      if (range) return { id: uid('a'), kind: 'selection', label: r.label, path: r.path, relPath: r.relPath, range };
      return { id: uid('a'), kind: 'file', label: r.label, path: r.path, relPath: r.relPath };
    }
    case 'rule':
      return { id: uid('a'), kind: 'rule', label: r.label, path: r.path, relPath: r.relPath };
    case 'problems':
      return { id: uid('a'), kind: 'problems', label: r.label || 'Problems', path: r.path, relPath: r.relPath };
    case 'terminal':
      return { id: uid('a'), kind: 'terminal', label: r.label || 'Terminal', path: r.value };
    case 'git':
      return { id: uid('a'), kind: 'git', label: r.label || 'Git changes', path: r.value };
    case 'web':
    case 'docs': {
      const url = r.value && looksLikeUrl(r.value) ? r.value.trim() : r.path && looksLikeUrl(r.path) ? r.path.trim() : undefined;
      if (!url) return undefined;
      return { id: uid('a'), kind: 'url', label: r.label || hostnameOf(url), url };
    }
    default:
      return undefined;
  }
}

export function urlAttachment(url: string): Attachment {
  return { id: uid('a'), kind: 'url', label: hostnameOf(url), url: url.trim() };
}

function hostnameOf(url: string): string {
  try {
    const u = new URL(url);
    const path = u.pathname.length > 1 ? u.pathname : '';
    return (u.hostname + path).slice(0, 48);
  } catch {
    return url.slice(0, 48);
  }
}

function parseRange(s: string): { startLine: number; endLine: number } | undefined {
  const m = /:(\d+)(?:-(\d+))?\b/.exec(s) ?? /\bL(\d+)(?:-L?(\d+))?\b/.exec(s);
  if (!m) return undefined;
  const a = Number(m[1]);
  const b = m[2] ? Number(m[2]) : a;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return undefined;
  return { startLine: a, endLine: Math.max(a, b) };
}

/** Category rows shown for an empty @ query when the host returns nothing. */
export const DEFAULT_CATEGORIES: MentionResult[] = [
  { kind: 'category', label: 'Files & Folders', value: 'file', icon: 'files' },
  { kind: 'category', label: 'Code', value: 'code', icon: 'symbol-method' },
  { kind: 'problems', label: 'Problems', icon: 'warning', detail: 'Current diagnostics' },
  { kind: 'terminal', label: 'Terminal', icon: 'terminal', detail: 'Last terminal output' },
  { kind: 'git', label: 'Git', value: 'diff', icon: 'git-commit', detail: 'Working-tree diff' },
  { kind: 'category', label: 'Web', value: 'web', icon: 'globe', detail: 'Fetch a URL' },
  { kind: 'category', label: 'Docs', value: 'docs', icon: 'book' },
  { kind: 'category', label: 'Rules', value: 'rule', icon: 'law' },
];

export const CATEGORY_TITLES: Record<string, string> = {
  file: 'Files & Folders',
  folder: 'Files & Folders',
  code: 'Code',
  problems: 'Problems',
  terminal: 'Terminal',
  git: 'Git',
  web: 'Web',
  docs: 'Docs',
  rule: 'Rules',
  command: 'Commands',
  category: '',
};
