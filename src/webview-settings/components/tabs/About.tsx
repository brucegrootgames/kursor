import { pushToast, useStore } from '../../store';
import { copyText, tildify } from '../../util';
import { post } from '../../vscode';
import { Button, LinkButton, Section, SettingRow } from '../controls';
import { Icon } from '../Icon';

export function AboutTab() {
  const about = useStore((s) => s.state!.about);
  const claude = useStore((s) => s.state!.claude);

  const diagnostics = [
    `Kursor ${about.extensionVersion}`,
    `${about.appName} ${about.appVersion} (${about.platform}, ${about.uiKind})`,
    `Claude Code CLI ${claude.version ?? 'unavailable'}${claude.path ? ` at ${claude.path}` : ''}`,
    `Signed in: ${claude.loggedIn === undefined ? 'unknown' : claude.loggedIn ? `yes${claude.subscriptionType ? ` (${claude.subscriptionType})` : ''}` : 'no'}`,
    `Extension path: ${about.extensionPath}`,
  ].join('\n');

  return (
    <>
      <Section title="About Kursor">
        <div className="card about-card">
          <div className="about-logo" aria-hidden="true">
            <Icon name="sparkle-filled" />
          </div>
          <div className="about-text">
            <div className="about-title">
              Kursor <span className="muted">v{about.extensionVersion}</span>
            </div>
            <div className="about-sub">Cursor-style AI coding for {about.appName}: agent chat, Ctrl+K inline edits, Tab completions, terminal and commit helpers.</div>
            <div className="about-sub muted">Powered by the Claude Code CLI installed on your machine — your own binary, your own login.</div>
          </div>
        </div>

        <dl className="status-grid about-grid">
          <dt>Editor</dt>
          <dd>
            {about.appName} {about.appVersion}
          </dd>
          <dt>Platform</dt>
          <dd>
            {about.platform} · {about.uiKind}
          </dd>
          <dt>Claude Code CLI</dt>
          <dd>{claude.version ? <code>{claude.version}</code> : <span className="muted">not available</span>}</dd>
          <dt>Extension path</dt>
          <dd>
            <code title={about.extensionPath}>{tildify(about.extensionPath)}</code>
          </dd>
        </dl>
        <div className="row-buttons">
          <Button icon="copy" onClick={() => void copyText(diagnostics).then((ok) => pushToast(ok ? 'info' : 'error', ok ? 'Diagnostics copied' : 'Could not copy'))}>
            Copy diagnostics
          </Button>
          <Button ghost icon="output" onClick={() => post({ type: 'runCommand', command: 'kursor.showLogs' })}>
            Show logs
          </Button>
        </div>
      </Section>

      <Section title="Links">
        <ul className="links">
          {about.links.map((l) => (
            <li key={l.url}>
              <LinkButton icon={l.icon ?? 'link-external'} onClick={() => post({ type: 'openUrl', url: l.url })} title={l.url}>
                {l.label}
              </LinkButton>
              <span className="muted link-url">{l.url.replace(/^https?:\/\//, '')}</span>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Shortcuts">
        <table className="shortcuts">
          <tbody>
            {[
              ['Toggle chat', ['Ctrl', 'I']],
              ['Add selection to a new chat', ['Ctrl', 'L']],
              ['Add selection to the current chat', ['Ctrl', 'Shift', 'L']],
              ['Inline edit / terminal command', ['Ctrl', 'K']],
              ['Accept inline edit · Keep all agent edits', ['Ctrl', 'Enter']],
              ['Reject inline edit', ['Ctrl', 'Backspace']],
              ['Trigger a Tab completion', ['Alt', '\\']],
              ['Kursor Settings', ['Ctrl', 'Shift', 'J']],
            ].map(([label, keys]) => (
              <tr key={label as string}>
                <td>{label as string}</td>
                <td>
                  {(keys as string[]).map((k, i) => (
                    <span key={k + i}>
                      {i > 0 && '+'}
                      <kbd>{k}</kbd>
                    </span>
                  ))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <SettingRow
          label="Change shortcuts"
          control={
            <Button ghost icon="keyboard" onClick={() => post({ type: 'runCommand', command: 'workbench.action.openGlobalKeybindings', args: ['kursor'] })}>
              Keyboard shortcuts
            </Button>
          }
        />
      </Section>

      <Section title="Notice">
        <p className="muted">
          Kursor is an independent project and is not affiliated with Anysphere (Cursor) or Anthropic. It spawns the unmodified <code>claude</code> executable from your PATH; the extension never reads, stores or transmits your credentials. Usage counts against your own Claude subscription.
        </p>
      </Section>
    </>
  );
}
