/**
 * Renders markdown as a list of top-level marked tokens. Each token is memoized on its
 * `raw` text, so during streaming only the last block re-renders. Code fences become
 * <CodeFence/> (with the toolbar); everything else is sanitized HTML.
 * Link clicks are delegated to the host (`openUrl` / `openFile`).
 */
import { memo, useCallback, useMemo, type MouseEvent } from 'react';
import type { Token } from 'marked';
import { lexMarkdown, renderTokens, withCaret } from '../markdown';
import { post } from '../vscode';
import { CodeFence } from './CodeFence';
import { cx } from '../util';

export interface MarkdownProps {
  text: string;
  streaming?: boolean;
  className?: string;
  /** Hide Apply/Insert/Run on fences. */
  readOnlyFences?: boolean;
}

export function handleMarkdownClick(e: MouseEvent<HTMLElement>): void {
  const target = e.target as HTMLElement | null;
  const a = target?.closest('a') as HTMLAnchorElement | null;
  if (!a) return;
  const href = a.getAttribute('href') ?? '';
  if (!href || href === '#') {
    e.preventDefault();
    return;
  }
  e.preventDefault();
  if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href) || /^vscode(-insiders)?:/i.test(href)) {
    post({ type: 'openUrl', url: href });
    return;
  }
  if (href.startsWith('file://')) {
    try {
      const u = new URL(href);
      post({ type: 'openFile', path: decodeURIComponent(u.pathname) });
    } catch {
      /* ignore */
    }
    return;
  }
  if (href.startsWith('#')) return;
  // Relative or absolute path, optionally with :line
  const m = /^(.*?)(?::(\d+)(?:[-:](\d+))?)?$/.exec(href);
  if (m) post({ type: 'openFile', path: m[1] ?? href, line: m[2] ? Number(m[2]) : undefined, endLine: m[3] ? Number(m[3]) : undefined });
}

const HtmlToken = memo(
  function HtmlToken({ token, caret }: { token: Token; caret: boolean }) {
    const html = useMemo(() => {
      const h = renderTokens([token]);
      return caret ? withCaret(h) : h;
    }, [token, caret]);
    if (!html) return null;
    return <div className="md-block" dangerouslySetInnerHTML={{ __html: html }} />;
  },
  (a, b) => a.caret === b.caret && a.token.type === b.token.type && a.token.raw === b.token.raw,
);

export const Markdown = memo(function Markdown({ text, streaming, className, readOnlyFences }: MarkdownProps) {
  const tokens = useMemo(() => lexMarkdown(text), [text]);
  const onClick = useCallback(handleMarkdownClick, []);
  const last = tokens.length - 1;
  return (
    <div className={cx('md', className)} onClick={onClick}>
      {tokens.map((t, i) => {
        const isLast = i === last;
        if (t.type === 'code') {
          const c = t as { text: string; lang?: string };
          return <CodeFence key={i} code={c.text} info={c.lang} streaming={!!streaming && isLast} readOnly={readOnlyFences} />;
        }
        if (t.type === 'space') return null;
        return <HtmlToken key={i} token={t} caret={!!streaming && isLast} />;
      })}
      {streaming && (tokens.length === 0 || tokens[last]?.type === 'space') && <span className="stream-caret" aria-hidden="true" />}
    </div>
  );
});
