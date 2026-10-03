/** Sticky bar above the input while agent edits are pending: "N files · Review · Undo All · Keep All". */
import { useState } from 'react';
import type { EditSummary } from '../../shared/protocol';
import { cx } from '../util';
import { post } from '../vscode';
import { Icon } from './Icon';
import { EditActions, EditStats, PathLabel } from './ToolRow';

export function ReviewBar({ edits }: { edits: EditSummary[] }) {
  const [open, setOpen] = useState(false);
  const pending = edits.filter((e) => e.status === 'pending');
  if (pending.length === 0) return null;
  const add = pending.reduce((n, e) => n + e.additions, 0);
  const del = pending.reduce((n, e) => n + e.deletions, 0);
  return (
    <div className={cx('review-bar', open && 'open')}>
      <div className="review-head">
        <button type="button" className="review-toggle" onClick={() => setOpen((v) => !v)} title={open ? 'Hide files' : 'Show files'}>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} />
          <Icon name="diff-multiple" />
          <span>
            {pending.length} file{pending.length === 1 ? '' : 's'}
          </span>
          <span className="edit-stats">
            {add > 0 && <span className="add">+{add}</span>}
            {del > 0 && <span className="del">−{del}</span>}
          </span>
        </button>
        <span className="spacer" />
        <button type="button" className="btn small" onClick={() => post({ type: 'edits', action: 'review' })} title="Open a multi-file diff">
          Review
        </button>
        <button type="button" className="btn small" onClick={() => post({ type: 'edits', action: 'undo' })} title="Revert all agent edits (Ctrl+Shift+Backspace)">
          Undo<span className="wide-only"> All</span>
        </button>
        <button type="button" className="btn small primary" onClick={() => post({ type: 'edits', action: 'keep' })} title="Accept all agent edits (Ctrl+Enter)">
          Keep<span className="wide-only"> All</span>
        </button>
      </div>
      {open && (
        <div className="review-files">
          {pending.map((e) => (
            <div key={e.path} className="review-file">
              <Icon name={e.isDeleted ? 'trash' : e.isNew ? 'new-file' : 'edit'} />
              <button type="button" className="review-path" onClick={() => post({ type: 'openFile', path: e.path })} title={e.path}>
                <PathLabel path={e.relPath || e.path} />
              </button>
              <EditStats edit={e} />
              {e.hunks !== undefined && e.hunks > 0 && <span className="muted">{e.hunks} hunk{e.hunks === 1 ? '' : 's'}</span>}
              <span className="spacer" />
              <EditActions edit={e} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
