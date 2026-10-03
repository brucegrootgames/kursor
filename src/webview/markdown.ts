/**
 * Markdown pipeline: `marked` (GFM) tokenizes, a custom renderer emits HTML with raw HTML
 * escaped (no sanitizer library needed: text is escaped by marked, and the only raw-HTML
 * path — `html` tokens — is rendered as literal text), and `highlight.js` colours fences.
 *
 * Components render top-level tokens one by one (see components/Markdown.tsx) so that a
 * streaming message only re-renders its last block.
 */
import { Marked, type Token, type Tokens } from 'marked';
import hljs from 'highlight.js/lib/common';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const SAFE_PROTOCOLS = /^(https?:|mailto:|vscode:|vscode-insiders:|file:|command:)/i;

export function safeUrl(href: string | null | undefined): string {
  if (!href) return '#';
  const trimmed = href.trim();
  if (trimmed.startsWith('#')) return trimmed;
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
    return SAFE_PROTOCOLS.test(trimmed) ? trimmed : '#';
  }
  // relative / bare paths are allowed (opened as files by the click handler)
  return trimmed;
}

function safeImageUrl(href: string | null | undefined): string | undefined {
  if (!href) return undefined;
  const t = href.trim();
  if (/^https?:\/\//i.test(t)) return t;
  if (/^data:image\/(png|jpe?g|gif|webp|svg\+xml);base64,/i.test(t)) return t;
  return undefined;
}

export interface FenceInfo {
  /** normalized highlight.js language id ('' = plain) */
  language: string;
  /** what the author wrote, e.g. "ts" */
  label: string;
  path?: string;
  range?: { start: number; end: number };
}

const ALIASES: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsonc: 'json',
  json5: 'json',
  yml: 'yaml',
  sh: 'bash',
  zsh: 'bash',
  fish: 'bash',
  shellsession: 'shell',
  console: 'shell',
  html: 'xml',
  vue: 'xml',
  svelte: 'xml',
  svg: 'xml',
  py: 'python',
  rb: 'ruby',
  rs: 'rust',
  kt: 'kotlin',
  cs: 'csharp',
  'c++': 'cpp',
  h: 'c',
  hpp: 'cpp',
  md: 'markdown',
  text: 'plaintext',
  txt: 'plaintext',
  plain: 'plaintext',
  toml: 'ini',
  dockerfile: 'bash',
  golang: 'go',
  ps1: 'powershell',
};

export function normalizeLanguage(lang: string): string {
  const l = lang.toLowerCase();
  const mapped = ALIASES[l] ?? l;
  return hljs.getLanguage(mapped) ? mapped : '';
}

const PATHISH = /^(?:[\w.@~-]+\/)*[\w.@-]+\.[A-Za-z0-9]{1,8}$|^(?:[\w.@~-]+\/)+[\w.@-]+$/;

/** Parse a fence info string such as ``ts src/app.ts``, ``ts:src/app.ts``, ``ts title="a.ts"``, ``ts src/a.ts (10-20)``. */
export function parseFenceInfo(info: string | undefined): FenceInfo {
  if (!info) return { language: '', label: '' };
  const tokens = info.trim().split(/\s+/);
  let first = tokens.shift() ?? '';
  let path: string | undefined;
  let range: FenceInfo['range'];
  const colon = first.indexOf(':');
  if (colon > 0 && colon < first.length - 1 && PATHISH.test(first.slice(colon + 1))) {
    path = first.slice(colon + 1);
    first = first.slice(0, colon);
  }
  for (const t of tokens) {
    const kv = /^(?:title|filename|file|path)=["']?([^"']+)["']?$/i.exec(t);
    if (kv) {
      path = kv[1];
      continue;
    }
    const rg = /^\(?(\d+)-(\d+)\)?$/.exec(t);
    if (rg) {
      range = { start: Number(rg[1]), end: Number(rg[2]) };
      continue;
    }
    if (!path && (t.includes('/') || PATHISH.test(t)) && !t.startsWith('{')) {
      path = t;
      continue;
    }
    const lr = /^L?(\d+)-L?(\d+)$/.exec(t);
    if (lr) range = { start: Number(lr[1]), end: Number(lr[2]) };
  }
  let label = first.toLowerCase();
  // A bare path in the language slot (```src/a.ts) — infer language from the extension.
  if (!path && first.includes('/') && PATHISH.test(first)) {
    path = first;
    label = '';
  }
  if (!label && path) {
    const ext = path.split('.').pop() ?? '';
    label = ext.toLowerCase();
  }
  return { language: normalizeLanguage(label), label, path, range };
}

export function highlight(code: string, language: string): string {
  if (!language) return escapeHtml(code);
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return escapeHtml(code);
  }
}

const md = new Marked({
  gfm: true,
  breaks: false,
  async: false,
  pedantic: false,
  renderer: {
    html({ text }: Tokens.HTML | Tokens.Tag): string {
      // Raw HTML is shown literally — never injected.
      return escapeHtml(text);
    },
    link(this: unknown, token: Tokens.Link): string {
      const self = this as { parser: { parseInline(tokens: Token[]): string } };
      const href = safeUrl(token.href);
      const inner = self.parser.parseInline(token.tokens);
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      return `<a href="${escapeHtml(href)}"${title}>${inner}</a>`;
    },
    image({ href, title, text }: Tokens.Image): string {
      const src = safeImageUrl(href);
      if (!src) return escapeHtml(`![${text}](${href ?? ''})`);
      const t = title ? ` title="${escapeHtml(title)}"` : '';
      return `<img src="${escapeHtml(src)}" alt="${escapeHtml(text)}"${t} loading="lazy">`;
    },
    code({ text, lang }: Tokens.Code): string {
      // Only reached for fences nested inside lists/blockquotes (top-level fences become <CodeFence/>).
      const info = parseFenceInfo(lang);
      const cls = info.language ? ` language-${escapeHtml(info.language)}` : '';
      return `<pre class="md-pre"><code class="hljs${cls}">${highlight(text, info.language)}</code></pre>\n`;
    },
    checkbox({ checked }: Tokens.Checkbox): string {
      return `<input type="checkbox" disabled${checked ? ' checked' : ''}> `;
    },
  },
});

export function lexMarkdown(src: string): Token[] {
  try {
    return md.lexer(src);
  } catch {
    return [{ type: 'paragraph', raw: src, text: src, tokens: [{ type: 'text', raw: src, text: src }] } as Token];
  }
}

export function renderTokens(tokens: Token[]): string {
  try {
    return md.parser(tokens);
  } catch {
    return `<p>${escapeHtml(tokens.map((t) => t.raw).join(''))}</p>`;
  }
}

/** Render a whole markdown string to sanitized HTML (used for small snippets like plan cards). */
export function renderMarkdown(src: string): string {
  return renderTokens(lexMarkdown(src));
}

/** Append a streaming caret inside the last block element of an HTML fragment. */
export function withCaret(html: string): string {
  const caret = '<span class="stream-caret" aria-hidden="true"></span>';
  const m = /<\/(p|li|h[1-6]|td|th|blockquote|code|pre)>\s*$/i.exec(html);
  if (m && m.index !== undefined) {
    return html.slice(0, m.index) + caret + html.slice(m.index);
  }
  return html + caret;
}
