import { Component, useEffect, type ReactNode } from 'react';
import type { SettingsHostToPanel, SettingsTab } from '../../shared/settingsProtocol';
import { handleHostMessage, selectTab, useStore } from '../store';
import { hostLog, post } from '../vscode';
import { Icon } from './Icon';
import { Nav, TAB_INFO, panelId, tabId } from './Nav';
import { Toasts } from './Toasts';
import { AboutTab } from './tabs/About';
import { AgentsTab } from './tabs/Agents';
import { GeneralTab } from './tabs/General';
import { IndexingTab } from './tabs/Indexing';
import { ModelsTab } from './tabs/Models';
import { RulesTab } from './tabs/Rules';
import { TabCompletionsTab } from './tabs/TabCompletions';

class ErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: { componentStack?: string }) {
    hostLog('error', `settings render error: ${error.message}\n${info.componentStack ?? ''}`);
  }
  render() {
    if (this.state.error) {
      return (
        <div className="fatal">
          <Icon name="error" />
          <div>
            <div>The settings panel hit an error.</div>
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

function TabContent({ tab }: { tab: SettingsTab }) {
  switch (tab) {
    case 'general':
      return <GeneralTab />;
    case 'agents':
      return <AgentsTab />;
    case 'tab':
      return <TabCompletionsTab />;
    case 'models':
      return <ModelsTab />;
    case 'rules':
      return <RulesTab />;
    case 'indexing':
      return <IndexingTab />;
    case 'about':
      return <AboutTab />;
    default:
      return null;
  }
}

export function App() {
  const ready = useStore((s) => s.state !== null);
  const tab = useStore((s) => s.tab);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data as SettingsHostToPanel | undefined;
      if (!data || typeof data !== 'object' || typeof (data as { type?: unknown }).type !== 'string') return;
      try {
        handleHostMessage(data);
      } catch (err) {
        hostLog('error', `failed to handle ${data.type}: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      }
    };
    window.addEventListener('message', onMessage);
    post({ type: 'ready' });
    return () => window.removeEventListener('message', onMessage);
  }, []);

  // Scroll the content pane to the top when switching sections.
  useEffect(() => {
    document.getElementById('content')?.scrollTo({ top: 0 });
  }, [tab]);

  if (!ready) {
    return (
      <div className="app connecting">
        <Icon name="loading" spin />
        <span>Loading Kursor settings…</span>
      </div>
    );
  }

  const info = TAB_INFO[tab];
  return (
    <div className="app">
      <Nav active={tab} onSelect={selectTab} />
      <main id="content" className="content" role="tabpanel" aria-labelledby={tabId(tab)} tabIndex={-1}>
        <div className="content-inner" id={panelId(tab)}>
          <header className="page-header">
            <h1 className="page-title">
              <Icon name={info.icon} /> {info.label}
            </h1>
            <p className="page-hint muted">{info.hint}</p>
          </header>
          <ErrorBoundary key={tab}>
            <TabContent tab={tab} />
          </ErrorBoundary>
        </div>
      </main>
      <Toasts />
    </div>
  );
}
