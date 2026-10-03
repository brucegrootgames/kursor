import type { RuleKind, RuleListItem } from '../../../shared/settingsProtocol';
import { useStore } from '../../store';
import { basename, tildify } from '../../util';
import { post } from '../../vscode';
import { Badge, Button, LinkButton, Section, Select, SettingRow, TextAreaSetting, ToggleSetting, useSettingValue } from '../controls';
import { Icon } from '../Icon';

const KIND_INFO: Record<RuleKind, { label: string; tone: 'default' | 'ok' | 'warn' | 'muted'; title: string }> = {
  always: { label: 'Always', tone: 'ok', title: 'alwaysApply: true — attached to every chat' },
  auto: { label: 'Auto attached', tone: 'default', title: 'Attached when files matching its globs are in context' },
  agent: { label: 'Agent requested', tone: 'default', title: 'Indexed by description; the agent reads it when relevant' },
  manual: { label: 'Manual', tone: 'muted', title: 'Only when you @-mention it' },
  legacy: { label: '.cursorrules', tone: 'warn', title: 'Legacy single-file rules, always attached' },
  'agents-md': { label: 'AGENTS.md', tone: 'ok', title: 'Always attached' },
};

function RuleRow({ rule }: { rule: RuleListItem }) {
  const info = KIND_INFO[rule.kind] ?? KIND_INFO.manual;
  return (
    <li className="rule">
      <Icon name={rule.kind === 'legacy' || rule.kind === 'agents-md' ? 'file' : 'law'} className="rule-icon" />
      <div className="rule-main">
        <div className="rule-title">
          <span className="rule-name">{rule.name || basename(rule.path)}</span>
          <Badge kind={info.tone}>
            <span title={info.title}>{info.label}</span>
          </Badge>
        </div>
        {rule.description && <div className="rule-desc">{rule.description}</div>}
        <div className="rule-meta">
          <code title={rule.path}>{rule.relPath}</code>
          {rule.globs && rule.globs.length > 0 && (
            <span className="rule-globs">
              <Icon name="filter" /> {rule.globs.join(', ')}
            </span>
          )}
        </div>
      </div>
      <Button small icon="go-to-file" onClick={() => post({ type: 'openRule', path: rule.path })} title={rule.path}>
        Open
      </Button>
    </li>
  );
}

export function RulesTab() {
  const rules = useStore((s) => s.state!.rules);
  const workspace = useStore((s) => s.state!.workspace);
  const useProject = useSettingValue('rules.useProjectRules');
  const hasFolder = !!workspace.cwd;

  return (
    <>
      <Section title="User rules" description="Instructions applied to every chat and Ctrl+K request, in every project — tone, languages, conventions you always want.">
        <TextAreaSetting
          setting="rules.user"
          label="Rules for the agent"
          description="Plain text or markdown. Saved automatically."
          placeholder={'e.g.\n- Reply tersely; skip pleasantries.\n- Prefer TypeScript strict mode and explicit return types.\n- Never add dependencies without asking.'}
          rows={6}
        />
      </Section>

      <Section
        title="Project rules"
        description={
          <>
            Rules checked into the repository: <code>.cursor/rules/*.mdc</code> (with <code>description</code>, <code>globs</code>, <code>alwaysApply</code> front matter), the legacy <code>.cursorrules</code> file and <code>AGENTS.md</code>. <code>CLAUDE.md</code> is loaded by Claude Code itself and is not listed here.
          </>
        }
        actions={
          <>
            <Button ghost small icon="refresh" onClick={() => post({ type: 'refreshRules' })} disabled={rules.loading} title="Rescan the folder">
              Refresh
            </Button>
            <Button primary small icon="add" onClick={() => post({ type: 'newRule' })} disabled={!hasFolder} title={hasFolder ? 'Create .cursor/rules/<name>.mdc' : 'Open a folder first'}>
              New Rule
            </Button>
          </>
        }
      >
        <ToggleSetting setting="rules.useProjectRules" label="Use project rules" description="Read rules from the workspace. Turn off to run with user rules only." />

        {workspace.folders.length > 1 && (
          <SettingRow
            label="Folder"
            description="This workspace has several folders; rules are listed per folder."
            control={<Select value={workspace.cwd ?? ''} options={workspace.folders.map((f) => ({ value: f.path, label: f.name, description: f.path }))} ariaLabel="Workspace folder" onChange={(v) => post({ type: 'selectFolder', path: v })} />}
          />
        )}

        <div className={useProject ? undefined : 'dimmed'}>
          {!hasFolder ? (
            <div className="empty">
              <Icon name="folder" />
              <div>Open a folder to see its project rules.</div>
            </div>
          ) : rules.error ? (
            <div className="empty error">
              <Icon name="error" />
              <div>Could not read rules: {rules.error}</div>
            </div>
          ) : rules.items.length === 0 ? (
            <div className="empty">
              {rules.loading ? <Icon name="loading" spin /> : <Icon name="law" />}
              <div>
                {rules.loading ? 'Scanning…' : 'No project rules yet.'}
                {!rules.loading && (
                  <>
                    {' '}
                    <LinkButton onClick={() => post({ type: 'newRule' })}>Create one</LinkButton> to teach the agent this project's conventions.
                  </>
                )}
              </div>
            </div>
          ) : (
            <>
              <div className="list-header">
                <span>
                  {rules.items.length} rule{rules.items.length === 1 ? '' : 's'} in <code title={workspace.cwd}>{tildify(workspace.cwd)}</code>
                </span>
                {rules.loading && <Icon name="loading" spin />}
              </div>
              <ul className="rule-list">
                {rules.items.map((r) => (
                  <RuleRow key={r.path} rule={r} />
                ))}
              </ul>
            </>
          )}
        </div>
      </Section>

      <Section title="How rules reach the model">
        <ul className="bullets">
          <li>User rules and <strong>Always</strong> rules are appended to the system prompt of every session.</li>
          <li><strong>Auto attached</strong> rules join when a file matching their globs is in context (open file, @-mention, Ctrl+K target).</li>
          <li><strong>Agent requested</strong> rules are listed with their description so the agent can read them when relevant; <strong>Manual</strong> rules only when you @-mention them.</li>
          <li>The appendix is capped at 60k characters; long rules get truncated proportionally.</li>
        </ul>
      </Section>
    </>
  );
}
