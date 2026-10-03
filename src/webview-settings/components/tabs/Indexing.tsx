import { useStore } from '../../store';
import { tildify } from '../../util';
import { post } from '../../vscode';
import { Badge, Button, Section, SettingRow } from '../controls';

export function IndexingTab() {
  const workspace = useStore((s) => s.state!.workspace);
  const hasFolder = !!workspace.cwd;
  const ci = workspace.cursorignore;
  const gi = workspace.gitignore;

  return (
    <>
      <Section title="Codebase access" description="Kursor does not build a separate embeddings index. The agent searches your workspace live with Claude Code's own tools, so what it sees is always current.">
        <ul className="bullets">
          <li>
            <strong>Agent searches</strong> (Grep, Glob, Read) run against the files on disk and skip paths ignored by <code>.gitignore</code>. A file you reference explicitly can always be read.
          </li>
          <li>
            <strong>@-mention file search</strong> in chat uses ripgrep and honours <code>.gitignore</code>, <code>.ignore</code> and <code>.cursorignore</code>; <code>node_modules</code> and <code>.git</code> are always excluded.
          </li>
          <li>
            <strong>Claude Code's own memory</strong> (<code>CLAUDE.md</code>, <code>~/.claude/settings.json</code> permissions and <code>.claude/</code> project settings) applies as usual.
          </li>
        </ul>
      </Section>

      <Section title="Ignore files" description={hasFolder ? <>Folder: <code title={workspace.cwd}>{tildify(workspace.cwd)}</code></> : 'Open a folder to manage its ignore files.'}>
        <SettingRow
          label={
            <>
              <code>.cursorignore</code> {ci?.exists ? <Badge kind="ok">present</Badge> : <Badge kind="muted">not created</Badge>}
            </>
          }
          description="Same syntax as .gitignore. Use it for files that are tracked by git but should stay out of @-mention results and context — fixtures, generated code, secrets."
          control={
            <Button icon={ci?.exists ? 'go-to-file' : 'new-file'} disabled={!hasFolder} onClick={() => post({ type: 'openCursorignore' })} title={ci?.path}>
              {ci?.exists ? 'Open .cursorignore' : 'Create .cursorignore'}
            </Button>
          }
        />
        <SettingRow
          label={
            <>
              <code>.gitignore</code> {gi?.exists ? <Badge kind="ok">present</Badge> : <Badge kind="muted">none</Badge>}
            </>
          }
          description="Respected by both the agent's searches and the @-mention search."
          control={
            <Button ghost icon="go-to-file" disabled={!hasFolder} onClick={() => post({ type: 'openGitignore' })} title={gi?.path}>
              {gi?.exists ? 'Open .gitignore' : 'Create .gitignore'}
            </Button>
          }
        />
        {workspace.folders.length > 1 && (
          <SettingRow label="Other folders" description="Ignore files are per folder. Switch the folder on the Rules page to manage another one." />
        )}
      </Section>

      <Section title="Privacy">
        <ul className="bullets">
          <li>Code leaves this machine only when the Claude Code CLI sends it to Anthropic's API as part of a request you started (chat, Ctrl+K, Tab, commit message).</li>
          <li>Tab completions send a window of the current file around the cursor (see the Tab page for the size).</li>
          <li>Kursor stores chat transcripts in this editor's workspace storage; Claude Code keeps its own session logs under <code>~/.claude/projects</code>.</li>
        </ul>
      </Section>
    </>
  );
}
