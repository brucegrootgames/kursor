/** Chat header: a compact tab strip when more than one chat is open, otherwise the title. */
import { useEffect, useRef, useState } from 'react';
import type { AppState, ChatSummary } from '../../shared/protocol';
import { closeHistory, openHistory, useStore } from '../store';
import { cx } from '../util';
import { post } from '../vscode';
import { Icon } from './Icon';

function Tab({ chat, active }: { chat: ChatSummary; active: boolean }) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(chat.title);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);
  const commit = () => {
    setEditing(false);
    const t = title.trim();
    if (t && t !== chat.title) post({ type: 'renameChat', chatId: chat.id, title: t });
  };
  const status = chat.status === 'waiting' ? 'waiting' : chat.status === 'running' || chat.status === 'starting' ? 'running' : chat.status === 'error' ? 'error' : 'idle';
  return (
    <div
      className={cx('tab', active && 'active', `tab-${status}`, chat.unread && 'unread')}
      onClick={() => !active && post({ type: 'switchChat', chatId: chat.id })}
      onDoubleClick={() => {
        setTitle(chat.title);
        setEditing(true);
      }}
      onAuxClick={(e) => {
        if (e.button === 1) post({ type: 'closeChat', chatId: chat.id });
      }}
      title={chat.title}
      role="tab"
      aria-selected={active}
    >
      {status === 'running' ? <Icon name="loading" spin className="tab-status" /> : status === 'waiting' ? <span className="tab-dot waiting" title="Waiting for your input" /> : chat.unread ? <span className="tab-dot unread" /> : null}
      {editing ? (
        <input
          ref={inputRef}
          className="tab-rename"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commit();
            if (e.key === 'Escape') setEditing(false);
          }}
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <span className="tab-title">{chat.title || 'New chat'}</span>
      )}
      <button
        type="button"
        className="tab-close"
        title="Close chat"
        onClick={(e) => {
          e.stopPropagation();
          post({ type: 'closeChat', chatId: chat.id });
        }}
      >
        <Icon name="close" />
      </button>
    </div>
  );
}

export function Header({ app }: { app: AppState }) {
  const showHistory = useStore((s) => s.showHistory);
  const active = app.chats.find((c) => c.id === app.activeChatId);
  const multi = app.chats.length > 1;
  return (
    <div className="header">
      {showHistory ? (
        <div className="header-title">
          <button type="button" className="icon-btn" onClick={closeHistory} title="Back to chat">
            <Icon name="arrow-left" />
          </button>
          <span>Chat history</span>
        </div>
      ) : multi ? (
        <div className="tabs" role="tablist">
          {app.chats.map((c) => (
            <Tab key={c.id} chat={c} active={c.id === app.activeChatId} />
          ))}
        </div>
      ) : (
        <div className="header-title" title={active?.title}>
          <span className="header-name">{active?.title || 'Kursor'}</span>
          {app.workspaceName && <span className="header-ws">{app.workspaceName}</span>}
        </div>
      )}
      <div className="header-actions">
        <button type="button" className="icon-btn" onClick={() => post({ type: 'newChat' })} title="New chat (Ctrl+N)">
          <Icon name="add" />
        </button>
        <button type="button" className={cx('icon-btn', showHistory && 'active')} onClick={() => (showHistory ? closeHistory() : openHistory())} title="Chat history">
          <Icon name="history" />
        </button>
        {active && (
          <button type="button" className="icon-btn" onClick={() => post({ type: 'exportChat', chatId: active.id })} title="Export chat as Markdown">
            <Icon name="export" />
          </button>
        )}
        <button type="button" className="icon-btn" onClick={() => post({ type: 'openSettings' })} title="Kursor settings (Ctrl+Shift+J)">
          <Icon name="settings-gear" />
        </button>
      </div>
    </div>
  );
}
