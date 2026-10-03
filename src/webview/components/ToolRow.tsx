/**
 * One collapsible row per tool call. The header is tailored per tool (Read / Grep / Bash /
 * Edit / Task / Web…), the body shows input details and output. Edited-file rows carry
 * +N −M and Review · Undo · Keep while the edit is pending.
 */
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { EditSummary } from '../../shared/protocol';
import type { Density, ToolBlock } from '../types';
import { basename, countLines, cx, firstLine, isRecord, num, relPath, safeJson, str, truncate } from '../util';
import { post } from '../vscode';
import { CodeFence } from './CodeFence';
import { Icon, StatusIcon } from './Icon';
import { EditPreview, extOf } from './PermissionCard';
import { TodoCard, parseTodos } from './TodoCard';

interface Descriptor {
  icon: string;
  verb: string;
  /** monospace subject after the verb */
  subject?: string;
  /** clickable path for the subject */
  path?: string;
  line?: number;
  url?: string;
  /** muted trailing info */
  meta?: string;
  kind: 'read' | 'search' | 'bash' | 'edit' | 'task' | 'web' | 'todo' | 'question' | 'plan' | 'mcp' | 'other';
}

function describe(block: ToolBlock, ws?: string): Descriptor {
  const input = isRecord(block.input) ? block.input : {};
  const name = block.name;
  const fp = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  switch (name) {
    case 'Read':
    case 'NotebookRead': {
      const offset = num(input.offset);
      const limit = num(input.limit);
      const meta = offset !== undefined || limit !== undefined ? `L${offset ?? 1}${limit ? `-${(offset ?? 1) + limit - 1}` : '+'}` : undefined;
      return { icon: 'file', verb: 'Read', subject: relPath(fp, ws), path: fp, line: offset, meta, kind: 'read' };
    }
    case 'LS':
      return { icon: 'folder', verb: 'Listed', subject: relPath(fp, ws) || '.', path: fp, kind: 'read' };
    case 'Glob':
    case 'Grep': {
      const pattern = str(input.pattern) ?? '';
      const count = block.status === 'done' ? countLines(block.output) : undefined;
      const scope = str(input.path) ? relPath(str(input.path), ws) : undefined;
      return {
        icon: 'search',
        verb: 'Searched for',
        subject: pattern,
        meta: [scope ? `in ${scope}` : undefined, count !== undefined ? `${count} result${count === 1 ? '' : 's'}` : undefined].filter(Boolean).join(' · ') || undefined,
        kind: 'search',
      };
    }
    case 'Bash': {
      const cmd = str(input.command) ?? '';
      return { icon: 'terminal', verb: block.status === 'running' ? 'Running' : 'Ran', subject: truncate(firstLine(cmd), 160), meta: str(input.description), kind: 'bash' };
    }
    case 'BashOutput':
      return { icon: 'terminal', verb: 'Read shell output', kind: 'bash' };
    case 'KillShell':
      return { icon: 'terminal', verb: 'Stopped shell', kind: 'bash' };
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const created = block.edit ? block.edit.isNew : name === 'Write';
      const deleted = block.edit?.isDeleted;
      const p = block.edit?.path ?? fp;
      return {
        icon: deleted ? 'trash' : created ? 'new-file' : 'edit',
        verb: deleted ? 'Deleted' : created ? 'Created' : 'Edited',
        subject: block.edit?.relPath ?? relPath(p, ws),
        path: p,
        kind: 'edit',
      };
    }
    case 'Task': {
      const desc = str(input.description) ?? block.subagent?.description ?? '';
      return { icon: 'hubot', verb: 'Subagent', subject: desc, meta: block.subagent?.type ?? str(input.subagent_type), kind: 'task' };
    }
    case 'WebSearch':
      return { icon: 'globe', verb: 'Searched the web for', subject: str(input.query) ?? '', kind: 'web' };
    case 'WebFetch':
      return { icon: 'cloud-download', verb: 'Fetched', subject: str(input.url) ?? '', url: str(input.url), kind: 'web' };
    case 'TodoWrite':
      return { icon: 'checklist', verb: 'Updated to-dos', kind: 'todo' };
    case 'AskUserQuestion':
      return { icon: 'question', verb: 'Asked a question', kind: 'question' };
    case 'ExitPlanMode':
      return { icon: 'checklist', verb: 'Proposed a plan', kind: 'plan' };
    case 'EnterPlanMode':
      return { icon: 'checklist', verb: 'Entered plan mode', kind: 'plan' };
    case 'Skill':
      return { icon: 'sparkle', verb: 'Used skill', subject: str(input.skill) ?? str(input.name) ?? '', kind: 'other' };
    case 'ToolSearch':
      return { icon: 'tools', verb: 'Searched tools for', subject: str(input.query) ?? '', kind: 'other' };
    default: {
      if (name.startsWith('mcp__')) {
        const parts = name.split('__');
        return { icon: 'plug', verb: `${parts[1] ?? 'MCP'} ›`, subject: parts.slice(2).join('__') || name, kind: 'mcp' };
      }
      return { icon: 'tools', verb: name, kind: 'other' };
    }
  }
}

function Console({ text, running, truncated }: { text: string; running: boolean; truncated?: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && running) el.scrollTop = el.scrollHeight;
  }, [text, running]);
  return (
    <pre ref={ref} className="console">
      {text || (running ? <span className="muted">running…</span> : <span className="muted">(no output)</span>)}
      {truncated && <div className="muted">… output truncated</div>}
    </pre>
  );
}

export function EditStats({ edit }: { edit: EditSummary }) {
  return (
    <span className="edit-stats">
      {edit.additions > 0 && <span className="add">+{edit.additions}</span>}
      {edit.deletions > 0 && <span className="del">−{edit.deletions}</span>}
      {edit.additions === 0 && edit.deletions === 0 && <span className="muted">±0</span>}
    </span>
  );
}

export function EditActions({ edit }: { edit: EditSummary }) {
  if (edit.status === 'kept') return <span className="edit-status muted">Kept</span>;
  if (edit.status === 'undone') return <span className="edit-status muted">Undone</span>;
  const act = (action: 'keep' | 'undo' | 'review') => (e: React.MouseEvent) => {
    e.stopPropagation();
    post({ type: 'edits', action, path: edit.path });
  };
  return (
    <span className="edit-actions" onClick={(e) => e.stopPropagation()}>
      <button type="button" className="link-btn" onClick={act('review')} title="Open a diff of this change">
        Review
      </button>
      <button type="button" className="link-btn" onClick={act('undo')} title="Revert this file">
        Undo
      </button>
      <button type="button" className="link-btn accent" onClick={act('keep')} title="Accept this change">
        Keep
      </button>
    </span>
  );
}

export const ToolRow = memo(function ToolRow({ block, density, workspaceFolder }: { block: ToolBlock; density: Density; workspaceFolder?: string }) {
  const d = useMemo(() => describe(block, workspaceFolder), [block, workspaceFolder]);
  const input = isRecord(block.input) ? block.input : {};
  const running = block.status === 'running';
  const defaultOpen = density === 'detailed' || (density === 'balanced' && d.kind === 'bash');
  const [open, setOpen] = useState(defaultOpen);
  const [showInput, setShowInput] = useState(density === 'detailed');
  const hasBody = d.kind !== 'question' && d.kind !== 'plan';

  if (d.kind === 'todo') {
    const items = parseTodos(block.input);
    if (items.length) return <TodoCard items={items} />;
  }

  const openPath = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (d.path) post({ type: 'openFile', path: d.path, line: d.line });
    else if (d.url) post({ type: 'openUrl', url: d.url });
  };

  let body: ReactNode = null;
  if (open && hasBody) {
    switch (d.kind) {
      case 'bash':
        body = <Console text={block.output ?? ''} running={running} truncated={block.outputTruncated} />;
        break;
      case 'edit': {
        const oldS = str(input.old_string);
        const newS = str(input.new_string);
        const content = str(input.content);
        const edits = Array.isArray(input.edits) ? (input.edits as unknown[]) : undefined;
        body = (
          <div className="tool-body">
            {oldS !== undefined || newS !== undefined ? <EditPreview oldText={oldS ?? ''} newText={newS ?? ''} /> : null}
            {edits?.map((e, i) =>
              isRecord(e) ? <EditPreview key={i} oldText={str(e.old_string) ?? ''} newText={str(e.new_string) ?? ''} /> : null,
            )}
            {content !== undefined && <CodeFence code={truncate(content, 8000)} info={extOf(d.path)} readOnly collapsible />}
            {block.inputStreaming && <div className="muted">writing…</div>}
            {block.status === 'error' && block.output && <Console text={block.output} running={false} />}
          </div>
        );
        break;
      }
      case 'task':
        body = (
          <div className="tool-body">
            {str(input.prompt) && <div className="tool-prompt">{truncate(str(input.prompt) ?? '', 1200)}</div>}
            {block.subagent?.summary && <div className="tool-summary">{block.subagent.summary}</div>}
            {block.output && <Console text={truncate(block.output, 6000)} running={running} truncated={block.outputTruncated} />}
          </div>
        );
        break;
      case 'read':
      case 'search':
      case 'web':
      case 'mcp':
      case 'other':
      default:
        body = (
          <div className="tool-body">
            {(d.kind === 'mcp' || d.kind === 'other' || showInput) && (
              <details open={showInput} onToggle={(e) => setShowInput((e.target as HTMLDetailsElement).open)}>
                <summary>Arguments</summary>
                <pre className="json">{safeJson(block.input)}</pre>
              </details>
            )}
            {block.output !== undefined ? (
              <Console text={truncate(block.output, 12000)} running={running} truncated={block.outputTruncated || (block.output?.length ?? 0) > 12000} />
            ) : running ? (
              <div className="muted">running…</div>
            ) : null}
          </div>
        );
    }
  }

  const status = block.status === 'running' && block.inputStreaming ? 'running' : block.status;
  const subagentStatus = block.subagent?.status;

  return (
    <div className={cx('tool-row', `tool-${d.kind}`, `status-${block.status}`, open && 'open', density)}>
      <div className={cx('tool-head', hasBody && 'clickable')} onClick={() => hasBody && setOpen((v) => !v)} role={hasBody ? 'button' : undefined}>
        <StatusIcon status={status} />
        <Icon name={d.icon} className="tool-icon" />
        <span className="tool-verb">{d.verb}</span>
        {d.subject !== undefined && d.subject !== '' && (
          <code className={cx('tool-subject', (d.path || d.url) && 'clickable')} onClick={d.path || d.url ? openPath : undefined} title={d.path ?? d.url ?? d.subject}>
            {d.kind === 'edit' || d.kind === 'read' ? <PathLabel path={d.subject} /> : d.subject}
          </code>
        )}
        {block.edit && <EditStats edit={block.edit} />}
        {d.meta && <span className="tool-meta">{d.meta}</span>}
        {subagentStatus && d.kind === 'task' && <span className="tool-meta">{subagentStatus}</span>}
        {block.parentToolUseId && <Icon name="indent" className="tool-sub" title="Called by a subagent" />}
        <span className="spacer" />
        {block.edit && density !== 'compact' && <EditActions edit={block.edit} />}
        {block.edit && density === 'compact' && block.edit.status === 'pending' && <EditActions edit={block.edit} />}
        {hasBody && <Icon name={open ? 'chevron-up' : 'chevron-down'} className="tool-chevron" />}
      </div>
      {body}
    </div>
  );
});

/** Path with the basename emphasised and the directory dimmed. */
export function PathLabel({ path }: { path: string }) {
  const base = basename(path);
  const dir = path.slice(0, path.length - base.length);
  return (
    <>
      {dir && <span className="path-dir">{dir}</span>}
      <span className="path-base">{base}</span>
    </>
  );
}
