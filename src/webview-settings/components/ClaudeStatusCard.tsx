/** Claude Code CLI status: executable, version, sign-in, and the Sign in / Re-check / Change path actions. */
import { useEffect, useState } from 'react';
import type { ClaudeStatusInfo } from '../../shared/settingsProtocol';
import { pushToast, useStore } from '../store';
import { copyText, tildify, timeAgo } from '../util';
import { post } from '../vscode';
import { Button, LinkButton, Badge } from './controls';
import { Icon } from './Icon';

function planLabel(plan: string | undefined): string | undefined {
  if (!plan) return undefined;
  const map: Record<string, string> = { max: 'Max', pro: 'Pro', team: 'Team', enterprise: 'Enterprise', free: 'Free' };
  return map[plan.toLowerCase()] ?? plan;
}

function statusLine(s: ClaudeStatusInfo): { icon: string; tone: 'ok' | 'warn' | 'error' | 'muted'; title: string; detail?: string } {
  if (!s.checkedAt) return { icon: 'loading', tone: 'muted', title: 'Checking the Claude Code CLI…' };
  if (!s.ok) return { icon: 'error', tone: 'error', title: 'Claude Code CLI not available', detail: s.error ?? 'The claude executable could not be run.' };
  if (s.loggedIn === false) return { icon: 'warning', tone: 'warn', title: 'Not signed in', detail: 'Run Sign in to authenticate the CLI with your Claude account.' };
  if (s.loggedIn === undefined) return { icon: 'question', tone: 'warn', title: 'Sign-in status unknown', detail: s.error ?? 'Could not read `claude auth status`.' };
  return { icon: 'pass-filled', tone: 'ok', title: s.email ? `Signed in as ${s.email}` : 'Signed in', detail: planLabel(s.subscriptionType) ? `${planLabel(s.subscriptionType)} plan` : undefined };
}

export function ClaudeStatusCard() {
  const status = useStore((s) => s.state!.claude);
  const configuredPath = useStore((s) => s.state!.settings.values['claude.path']);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const line = statusLine(status);
  const probed = !!status.checkedAt;
  const showSignIn = probed && (!status.ok || status.loggedIn !== true);

  return (
    <div className={`card status-card tone-${line.tone}`} aria-busy={status.checking || undefined}>
      <div className="status-head">
        <Icon name={status.checking ? 'loading' : line.icon} spin={status.checking} className="status-icon" />
        <div className="status-text">
          <div className="status-title">{line.title}</div>
          {line.detail && <div className="status-detail">{line.detail}</div>}
        </div>
        <div className="status-badges">
          {status.version && <Badge kind="muted">v{status.version}</Badge>}
          {status.loggedIn && planLabel(status.subscriptionType) && <Badge kind="ok">{planLabel(status.subscriptionType)}</Badge>}
        </div>
      </div>

      <dl className="status-grid">
        <dt>Executable</dt>
        <dd>
          {status.path ? (
            <>
              <code title={status.path}>{tildify(status.path)}</code>
              <LinkButton icon="copy" title="Copy path" onClick={() => void copyText(status.path!).then((ok) => pushToast(ok ? 'info' : 'error', ok ? 'Path copied' : 'Could not copy'))}>
                Copy
              </LinkButton>
            </>
          ) : (
            <span className="muted">not found</span>
          )}
          {configuredPath ? <span className="muted"> · from kursor.claude.path</span> : <span className="muted"> · auto-detected from your login shell</span>}
        </dd>
        <dt>Version</dt>
        <dd>{status.version ? <code>{status.version}</code> : <span className="muted">—</span>}</dd>
        <dt>Account</dt>
        <dd>
          {status.loggedIn ? (
            <>
              {status.email ?? 'signed in'}
              {planLabel(status.subscriptionType) && <span className="muted"> · {planLabel(status.subscriptionType)}</span>}
            </>
          ) : status.loggedIn === false ? (
            <span className="muted">not signed in</span>
          ) : (
            <span className="muted">unknown</span>
          )}
        </dd>
        <dt>Last checked</dt>
        <dd className="muted">{status.checking || !probed ? 'checking…' : timeAgo(status.checkedAt) || '—'}</dd>
      </dl>

      <div className="status-actions">
        {showSignIn && (
          <Button primary icon="sign-in" onClick={() => post({ type: 'runCommand', command: 'kursor.claude.login' })} title={status.ok ? 'Runs `claude auth login` in a terminal' : 'Runs `claude auth login` in a terminal (needs a working claude executable)'}>
            Sign in
          </Button>
        )}
        <Button icon={status.checking || !probed ? 'loading' : 'refresh'} disabled={status.checking} onClick={() => post({ type: 'refreshStatus' })} title="Re-run `claude --version` and `claude auth status`">
          Re-check
        </Button>
        <Button icon="folder-opened" onClick={() => post({ type: 'openEditorSettings', query: 'kursor.claude.path' })} title="Edit kursor.claude.path in the settings editor">
          Change path
        </Button>
        <Button ghost icon="output" onClick={() => post({ type: 'runCommand', command: 'kursor.showLogs' })}>
          Logs
        </Button>
      </div>

      <p className="status-note muted">
        Kursor runs the unmodified <code>claude</code> binary installed on this machine with its own login. No credentials are read, stored or forwarded by the extension.
      </p>
    </div>
  );
}
