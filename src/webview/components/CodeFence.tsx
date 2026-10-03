/**
 * Fenced code block with Cursor-style toolbar: language, file path chip (from fence meta),
 * Copy · Apply · Insert · Run (shell). Highlighting via highlight.js; caret while streaming.
 */
import { memo, useMemo, useState } from 'react';
import { highlight, parseFenceInfo } from '../markdown';
import { copyText, cx, isShellLanguage, stripShellPrompts } from '../util';
import { post } from '../vscode';
import { Icon } from './Icon';

export interface CodeFenceProps {
  code: string;
  info?: string;
  streaming?: boolean;
  /** hide Apply/Insert/Run (e.g. inside tool rows) */
  readOnly?: boolean;
  /** collapse long blocks by default */
  collapsible?: boolean;
}

const COLLAPSE_LINES = 40;

export const CodeFence = memo(function CodeFence({ code, info, streaming, readOnly, collapsible }: CodeFenceProps) {
  const fence = useMemo(() => parseFenceInfo(info), [info]);
  const body = code.replace(/\n$/, '');
  const html = useMemo(() => highlight(body, fence.language), [body, fence.language]);
  const [copied, setCopied] = useState(false);
  const lineCount = useMemo(() => (body ? body.split('\n').length : 0), [body]);
  const [expanded, setExpanded] = useState(!collapsible);
  const collapsed = collapsible && !expanded && lineCount > COLLAPSE_LINES;
  const shell = isShellLanguage(fence.label) || fence.language === 'bash' || fence.language === 'shell';

  const onCopy = async () => {
    const ok = await copyText(body);
    if (!ok) post({ type: 'codeAction', action: 'copy', code: body, language: fence.label });
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const onApply = () => post({ type: 'codeAction', action: 'apply', code: body, language: fence.label, path: fence.path });
  const onInsert = () => post({ type: 'codeAction', action: 'insert', code: body, language: fence.label });
  const onRun = () => post({ type: 'codeAction', action: 'run', code: stripShellPrompts(body), language: fence.label });
  const onNewFile = () => post({ type: 'codeAction', action: 'newFile', code: body, language: fence.label, path: fence.path });
  const openPath = () => {
    if (fence.path) post({ type: 'openFile', path: fence.path, line: fence.range?.start, endLine: fence.range?.end });
  };

  return (
    <div className={cx('fence', streaming && 'streaming')}>
      <div className="fence-bar">
        <span className="fence-lang">{fence.label || 'text'}</span>
        {fence.path && (
          <button type="button" className="fence-path" onClick={openPath} title={`Open ${fence.path}`}>
            <Icon name="go-to-file" />
            <span>{fence.path}</span>
            {fence.range && (
              <span className="fence-range">
                :{fence.range.start}-{fence.range.end}
              </span>
            )}
          </button>
        )}
        <span className="spacer" />
        <div className="fence-actions">
          <button type="button" className="icon-btn" onClick={onCopy} title="Copy">
            <Icon name={copied ? 'check' : 'copy'} />
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
          {!readOnly && (
            <>
              {shell ? (
                <button type="button" className="icon-btn" onClick={onRun} title="Run in terminal">
                  <Icon name="play" />
                  <span>Run</span>
                </button>
              ) : (
                <button type="button" className="icon-btn" onClick={onApply} title={fence.path ? `Apply to ${fence.path}` : 'Apply to the active editor'}>
                  <Icon name="git-pull-request-go-to-changes" />
                  <span>Apply</span>
                </button>
              )}
              <button type="button" className="icon-btn" onClick={onInsert} title="Insert at cursor">
                <Icon name="insert" />
              </button>
              {fence.path && !shell && (
                <button type="button" className="icon-btn" onClick={onNewFile} title={`Create ${fence.path} with this content`}>
                  <Icon name="new-file" />
                </button>
              )}
            </>
          )}
        </div>
      </div>
      <pre className={cx('fence-pre', collapsed && 'collapsed')}>
        <code className={cx('hljs', fence.language && `language-${fence.language}`)} dangerouslySetInnerHTML={{ __html: html + (streaming ? '<span class="stream-caret" aria-hidden="true"></span>' : '') }} />
      </pre>
      {collapsible && lineCount > COLLAPSE_LINES && (
        <button type="button" className="fence-expand" onClick={() => setExpanded((v) => !v)}>
          <Icon name={expanded ? 'chevron-up' : 'chevron-down'} />
          {expanded ? 'Show less' : `Show all ${lineCount} lines`}
        </button>
      )}
    </div>
  );
});
