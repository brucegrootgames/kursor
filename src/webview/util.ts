/** Small pure helpers shared by the webview components. */

let counter = 0;
export function uid(prefix = 'id'): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function basename(p: string): string {
  const s = p.replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i === -1 ? s : s.slice(i + 1);
}

/** Workspace-relative display path. */
export function relPath(p: string | undefined, workspaceFolder?: string): string {
  if (!p) return '';
  if (workspaceFolder) {
    const root = workspaceFolder.replace(/[\\/]+$/, '');
    if (p === root) return basename(root);
    if (p.startsWith(root + '/') || p.startsWith(root + '\\')) return p.slice(root.length + 1);
  }
  const home = '/home/';
  if (p.startsWith(home)) {
    const rest = p.slice(home.length);
    const slash = rest.indexOf('/');
    if (slash !== -1) return '~' + rest.slice(slash);
  }
  return p;
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

export function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return i === -1 ? s : s.slice(0, i);
}

export function timeAgo(ts: number, now = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  const date = new Date(ts);
  return date.toLocaleDateString();
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(s < 10 ? 1 : 0)}s`;
  const m = Math.floor(s / 60);
  const rem = Math.round(s - m * 60);
  return `${m}m ${rem}s`;
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

const SHELL_LANGS = new Set(['bash', 'sh', 'shell', 'zsh', 'fish', 'console', 'shellsession', 'powershell', 'ps1', 'cmd', 'bat']);
export function isShellLanguage(lang: string): boolean {
  return SHELL_LANGS.has(lang.toLowerCase());
}

/** Strip `$ ` prompts from console-style fences before running. */
export function stripShellPrompts(code: string): string {
  return code
    .split('\n')
    .map((l) => l.replace(/^\s*[$>]\s+/, ''))
    .join('\n');
}

export function attachmentIcon(kind: string): string {
  switch (kind) {
    case 'file':
      return 'file';
    case 'folder':
      return 'folder';
    case 'selection':
      return 'code';
    case 'image':
      return 'file-media';
    case 'problems':
      return 'warning';
    case 'terminal':
      return 'terminal';
    case 'git':
      return 'git-commit';
    case 'url':
      return 'link';
    case 'rule':
      return 'law';
    case 'diagnostic':
      return 'error';
    default:
      return 'circle-outline';
  }
}

export function mentionIcon(kind: string, fallback?: string): string {
  if (fallback) return fallback;
  switch (kind) {
    case 'file':
      return 'file';
    case 'folder':
      return 'folder';
    case 'code':
      return 'symbol-method';
    case 'problems':
      return 'warning';
    case 'terminal':
      return 'terminal';
    case 'git':
      return 'git-commit';
    case 'web':
      return 'globe';
    case 'docs':
      return 'book';
    case 'rule':
      return 'law';
    case 'command':
      return 'terminal';
    case 'category':
      return 'chevron-right';
    default:
      return 'circle-outline';
  }
}

/** Structural equality for plain JSON data (used to reuse message objects across chatState snapshots). */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  const bk = Object.keys(bo);
  if (ak.length !== bk.length) return false;
  for (const k of ak) {
    if (!Object.prototype.hasOwnProperty.call(bo, k)) return false;
    if (!deepEqual(ao[k], bo[k])) return false;
  }
  return true;
}

export function safeJson(value: unknown, max = 4000): string {
  try {
    const s = JSON.stringify(value, null, 2) ?? '';
    return s.length > max ? s.slice(0, max) + '\n…' : s;
  } catch {
    return String(value);
  }
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function str(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

export function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/** Count lines of a tool output (used for Grep/Glob result counts). */
export function countLines(s: string | undefined): number {
  if (!s) return 0;
  return s.split('\n').filter((l) => l.trim().length > 0).length;
}

export function isLightTheme(): boolean {
  const cls = document.body.className;
  return cls.includes('vscode-light') || cls.includes('vscode-high-contrast-light');
}
