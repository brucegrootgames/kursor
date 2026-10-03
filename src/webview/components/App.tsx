import { Component, useEffect, type ReactNode } from 'react';
import { handleHostMessage, useStore } from '../store';
import { hostLog, post } from '../vscode';
import { EmptyState } from './EmptyState';
import { Header } from './Header';
import { HistoryView } from './HistoryView';
import { InputBox } from './InputBox';
import { MessageList } from './MessageList';
import { ReviewBar } from './ReviewBar';
import { Toasts } from './Toasts';
import type { HostToWebview } from '../../shared/protocol';
import { Icon } from './Icon';

class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: { componentStack?: string }) {
    hostLog('error', `webview render error: ${error.message}\n${info.componentStack ?? ''}`);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="fatal">
          <Icon name="error" />
          <div>
            <div>The chat view hit an error.</div>
            <code>{this.state.error.message}</code>
          </div>
          <button type="button" className="btn" onClick={() => this.setState({ error: undefined })}>
            Retry
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

function ChatView() {
  const app = useStore((s) => s.app)!;
  const chat = useStore((s) => (s.app?.activeChatId ? s.chats[s.app.activeChatId] : undefined));
  const hasMessages = !!chat && chat.messages.length > 0;
  return (
    <>
      {hasMessages ? <MessageList chat={chat} app={app} /> : <EmptyState app={app} />}
      {chat && <ReviewBar edits={chat.pendingEdits} />}
      <InputBox chat={chat} app={app} />
    </>
  );
}

export function App() {
  const app = useStore((s) => s.app);
  const showHistory = useStore((s) => s.showHistory);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as HostToWebview | undefined;
      if (!data || typeof data !== 'object' || typeof (data as { type?: unknown }).type !== 'string') return;
      try {
        handleHostMessage(data);
      } catch (err) {
        hostLog('error', `failed to handle ${data.type}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      }
    };
    // Tell the host whether keyboard focus is inside the chat (Ctrl+I toggles only when it is).
    const onFocus = () => post({ type: 'focusChanged', focused: true });
    const onBlur = () => post({ type: 'focusChanged', focused: false });
    window.addEventListener('message', onMessage);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    post({ type: 'ready' });
    if (document.hasFocus()) post({ type: 'focusChanged', focused: true });
    return () => {
      window.removeEventListener('message', onMessage);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
    };
  }, []);

  if (!app) {
    return (
      <div className="app connecting">
        <Icon name="loading" spin />
        <span>Connecting to Kursor…</span>
      </div>
    );
  }
  return (
    <ErrorBoundary>
      <div className="app">
        <Header app={app} />
        {showHistory ? <HistoryView workspaceFolder={app.workspaceFolder} /> : <ChatView />}
        <Toasts />
      </div>
    </ErrorBoundary>
  );
}
