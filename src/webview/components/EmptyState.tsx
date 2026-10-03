import { KursorMark } from '../../shared/Logo';
import type { AppState } from '../../shared/protocol';
import { post } from '../vscode';
import { Icon } from './Icon';

export function SignInPanel({ claude }: { claude: AppState['claude'] }) {
  const notFound = !claude.path || (claude.error && /not found|no such|enoent|resolve/i.test(claude.error));
  return (
    <div className="signin">
      <div className="signin-title">
        <Icon name="warning" />
        <span>{claude.ready && claude.loggedIn === false ? 'Not signed in' : 'Claude Code CLI not available'}</span>
      </div>
      <div className="signin-text">
        {claude.error ? (
          <span>{claude.error}</span>
        ) : claude.loggedIn === false ? (
          <span>
            Kursor uses the <code>claude</code> command installed on this machine with your own login. Sign in to start chatting.
          </span>
        ) : (
          <span>
            Kursor needs the <code>claude</code> command (Claude Code CLI) installed on this machine.
          </span>
        )}
        {claude.path && (
          <div className="muted small">
            Path: <code>{claude.path}</code>
            {claude.version ? ` · v${claude.version}` : ''}
          </div>
        )}
      </div>
      <div className="signin-actions">
        {!notFound && (
          <button type="button" className="btn primary" onClick={() => post({ type: 'runCommand', command: 'kursor.claude.login' })}>
            <Icon name="sign-in" /> Sign in
          </button>
        )}
        <button type="button" className="btn" onClick={() => post({ type: 'runCommand', command: 'workbench.action.openSettings', args: ['kursor.claude.path'] })}>
          <Icon name="settings" /> Set path
        </button>
        <button type="button" className="btn ghost" onClick={() => post({ type: 'runCommand', command: 'kursor.claude.status' })}>
          <Icon name="refresh" /> Re-check
        </button>
      </div>
    </div>
  );
}

export function EmptyState({ app }: { app: AppState }) {
  const claude = app.claude;
  const needsAttention = !claude.ready || claude.loggedIn === false;
  return (
    <div className="empty">
      <div className="empty-inner">
        <KursorMark className="logo" size={56} />
        <div className="empty-title">Kursor</div>
        {needsAttention ? (
          <SignInPanel claude={claude} />
        ) : (
          <div className="hints">
            <div className="hint-row">
              <kbd>Ctrl</kbd>
              <kbd>K</kbd>
              <span>to edit code</span>
            </div>
            <div className="hint-row">
              <kbd>Tab</kbd>
              <span>to complete</span>
            </div>
            <div className="hint-row">
              <kbd>@</kbd>
              <span>to add context</span>
            </div>
            <div className="hint-row">
              <kbd>Ctrl</kbd>
              <kbd>.</kbd>
              <span>to switch mode</span>
            </div>
          </div>
        )}
        {claude.ready && claude.email && (
          <div className="muted small">
            {claude.email}
            {claude.subscriptionType ? ` · ${claude.subscriptionType}` : ''}
          </div>
        )}
      </div>
    </div>
  );
}
