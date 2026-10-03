import { useMemo, useState } from 'react';
import type { HistoryEntry } from '../../shared/protocol';
import { closeHistory, removeHistoryEntry, requestHistory, useStore } from '../store';
import { cx, relPath, timeAgo } from '../util';
import { post } from '../vscode';
import { Icon } from './Icon';

function Row({ h, workspaceFolder }: { h: HistoryEntry; workspaceFolder?: string }) {
  const [confirm, setConfirm] = useState(false);
  const open = () => {
    if (h.chatId) post({ type: 'switchChat', chatId: h.chatId });
    else post({ type: 'resumeSession', sessionId: h.sessionId });
    closeHistory();
  };
  const del = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!confirm) {
      setConfirm(true);
      setTimeout(() => setConfirm(false), 3000);
      return;
    }
    post({ type: 'deleteSession', sessionId: h.sessionId });
    removeHistoryEntry(h.sessionId);
  };
  return (
    <div className={cx('history-row', h.chatId && 'open')} onClick={open} role="button" title={h.sessionId}>
      <Icon name={h.chatId ? 'comment-discussion' : 'history'} />
      <div className="history-body">
        <div className="history-title">{h.title || 'Untitled chat'}</div>
        <div className="history-meta muted">
          {timeAgo(h.updatedAt)}
          {h.messageCount !== undefined && ` · ${h.messageCount} message${h.messageCount === 1 ? '' : 's'}`}
          {h.cwd && ` · ${relPath(h.cwd, workspaceFolder)}`}
          {h.chatId && ' · open'}
        </div>
      </div>
      <button type="button" className={cx('icon-btn', confirm && 'danger')} onClick={del} title={confirm ? 'Click again to delete' : 'Delete'}>
        <Icon name={confirm ? 'warning' : 'trash'} />
        {confirm && <span>Delete?</span>}
      </button>
    </div>
  );
}

export function HistoryView({ workspaceFolder }: { workspaceFolder?: string }) {
  const history = useStore((s) => s.history);
  const loading = useStore((s) => s.historyLoading);
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const all = history ?? [];
    const needle = q.trim().toLowerCase();
    const filtered = needle ? all.filter((h) => (h.title || '').toLowerCase().includes(needle) || (h.cwd ?? '').toLowerCase().includes(needle)) : all;
    return [...filtered].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [history, q]);
  return (
    <div className="history">
      <div className="history-search">
        <Icon name="search" />
        <input className="input" autoFocus placeholder="Search chats" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && closeHistory()} />
        <button type="button" className="icon-btn" onClick={() => requestHistory(true)} title="Refresh">
          <Icon name="refresh" spin={loading} />
        </button>
      </div>
      <div className="history-list">
        {list.map((h) => (
          <Row key={h.sessionId} h={h} workspaceFolder={workspaceFolder} />
        ))}
        {list.length === 0 && <div className="history-empty muted">{loading ? 'Loading…' : q ? 'No matching chats' : 'No previous chats in this workspace'}</div>}
      </div>
    </div>
  );
}
