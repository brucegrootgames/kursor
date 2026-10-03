/**
 * Inline permission card (Cursor's terminal-command card): shows the command / tool input,
 * Run (Ctrl+Enter) · Skip · Always allow ▾ (from the bridge's suggestions). Once decided it
 * collapses to a one-line status.
 */
import { memo, useMemo, useRef, useState } from 'react';
import type { PermissionBlock } from '../types';
import { cx, firstLine, isRecord, relPath, safeJson, str, truncate } from '../util';
import { post } from '../vscode';
import { Icon } from './Icon';
import { Menu, type MenuItem } from './Menu';
import { CodeFence } from './CodeFence';

export const PermissionCard = memo(function PermissionCard({ block, chatId, workspaceFolder }: { block: PermissionBlock; chatId: string; workspaceFolder?: string }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [showInput, setShowInput] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const input = isRecord(block.input) ? block.input : {};
  const tool = block.toolName;
  const isBash = tool === 'Bash';
  const isEdit = tool === 'Edit' || tool === 'MultiEdit' || tool === 'NotebookEdit';
  const isWrite = tool === 'Write';
  const filePath = str(input.file_path) ?? str(input.notebook_path) ?? str(input.path);
  const command = str(input.command);
  const decided = block.decision !== undefined;

  const title = useMemo(() => {
    if (block.title) return block.title;
    if (isBash) return 'Run command';
    if (isEdit) return `Edit ${relPath(filePath, workspaceFolder) || 'file'}`;
    if (isWrite) return `Write ${relPath(filePath, workspaceFolder) || 'file'}`;
    if (tool.startsWith('mcp__')) {
      const parts = tool.split('__');
      return `${parts[1] ?? 'MCP'} › ${parts.slice(2).join('__') || tool}`;
    }
    return `Use ${tool}`;
  }, [block.title, isBash, isEdit, isWrite, filePath, tool, workspaceFolder]);

  const decide = (decision: 'allow' | 'deny' | 'always', suggestionIndex?: number) => {
    post({ type: 'permission', chatId, requestId: block.id, decision, suggestionIndex });
    setMenuOpen(false);
  };

  const menuItems: MenuItem[] = block.suggestions.map((s) => ({ id: String(s.index), label: s.label, icon: 'shield' }));

  if (decided) {
    const icon = block.decision === 'deny' ? 'circle-slash' : block.decision === 'always' ? 'shield' : 'check';
    const verb = block.decision === 'deny' ? (isBash ? 'Skipped' : 'Denied') : block.decision === 'always' ? 'Always allowed' : isBash ? 'Ran' : 'Allowed';
    return (
      <div className={cx('perm perm-decided', `perm-${block.decision}`)}>
        <Icon name={icon} />
        <span className="perm-verb">{verb}</span>
        <code className="perm-inline">{truncate(firstLine(command ?? filePath ?? title), 100)}</code>
      </div>
    );
  }

  return (
    <div className="card perm-card">
      <div className="card-title">
        <Icon name={isBash ? 'terminal' : isEdit || isWrite ? 'edit' : 'shield'} />
        <span>{title}</span>
        <span className="spacer" />
        <span className="badge warn">Needs approval</span>
      </div>
      {isBash && command && (
        <pre className="perm-command">
          <code>{command}</code>
        </pre>
      )}
      {(block.description || str(input.description)) && <div className="perm-desc">{block.description ?? str(input.description)}</div>}
      {isEdit && (str(input.old_string) !== undefined || str(input.new_string) !== undefined) && (
        <EditPreview oldText={str(input.old_string) ?? ''} newText={str(input.new_string) ?? ''} />
      )}
      {isWrite && str(input.content) !== undefined && (
        <CodeFence code={truncate(str(input.content) ?? '', 6000)} info={extOf(filePath)} readOnly collapsible />
      )}
      {!isBash && !isEdit && !isWrite && (
        <div className="perm-input">
          <button type="button" className="link-btn" onClick={() => setShowInput((v) => !v)}>
            <Icon name={showInput ? 'chevron-down' : 'chevron-right'} /> Arguments
          </button>
          {showInput && <pre className="json">{safeJson(block.input)}</pre>}
        </div>
      )}
      {block.blockedPath && (
        <div className="perm-note">
          <Icon name="lock" /> Outside the allowed directories: <code>{relPath(block.blockedPath, workspaceFolder)}</code>
        </div>
      )}
      {block.decisionReason && (
        <div className="perm-note muted">
          <Icon name="info" /> {block.decisionReason}
        </div>
      )}
      <div className="card-actions">
        <button type="button" className="btn primary" onClick={() => decide('allow')} title="Ctrl+Enter">
          <Icon name={isBash ? 'play' : 'check'} /> {isBash ? 'Run' : 'Allow'}
          <kbd>Ctrl+⏎</kbd>
        </button>
        <button type="button" className="btn" onClick={() => decide('deny')} title="Deny this tool call and let the agent continue">
          {isBash ? 'Skip' : 'Deny'}
        </button>
        {menuItems.length > 0 && (
          <span className="menu-anchor">
            <button ref={anchor} type="button" className="btn ghost" onClick={() => setMenuOpen((v) => !v)} title="Remember this decision">
              Always allow <Icon name="chevron-down" />
            </button>
            {menuOpen && (
              <Menu
                items={menuItems}
                anchorRef={anchor}
                direction="up"
                width={260}
                onClose={() => setMenuOpen(false)}
                onPick={(it) => decide('always', Number(it.id))}
              />
            )}
          </span>
        )}
      </div>
    </div>
  );
});

export function EditPreview({ oldText, newText }: { oldText: string; newText: string }) {
  return (
    <div className="edit-preview">
      {oldText && (
        <pre className="edit-old">
          <code>{truncate(oldText, 3000)}</code>
        </pre>
      )}
      {newText && (
        <pre className="edit-new">
          <code>{truncate(newText, 3000)}</code>
        </pre>
      )}
    </div>
  );
}

export function extOf(path: string | undefined): string {
  if (!path) return '';
  const base = path.split('/').pop() ?? '';
  const i = base.lastIndexOf('.');
  return i === -1 ? '' : base.slice(i + 1);
}
