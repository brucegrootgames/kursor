import { useStore } from '../../store';
import { post } from '../../vscode';
import { ClaudeStatusCard } from '../ClaudeStatusCard';
import { Button, Section, SettingRow, ToggleSetting } from '../controls';

export function GeneralTab() {
  const about = useStore((s) => s.state!.about);
  return (
    <>
      <Section title="Account" description="Every AI feature in Kursor is powered by the Claude Code CLI installed on your machine.">
        <ClaudeStatusCard />
      </Section>

      <Section title="Editor">
        <SettingRow
          label="Editor settings"
          description={`Everything else — fonts, themes, keybindings — lives in the regular ${about.appName} settings. Kursor's settings are listed under the "Kursor" section too.`}
          control={
            <div className="row-buttons">
              <Button icon="settings-gear" onClick={() => post({ type: 'openEditorSettings' })}>
                Open editor settings
              </Button>
              <Button ghost icon="json" onClick={() => post({ type: 'runCommand', command: 'workbench.action.openSettingsJson' })} title="Open settings.json">
                JSON
              </Button>
            </div>
          }
        />
        <SettingRow
          label="Keyboard shortcuts"
          description={
            <>
              <kbd>Ctrl</kbd>+<kbd>I</kbd> chat · <kbd>Ctrl</kbd>+<kbd>K</kbd> inline edit · <kbd>Ctrl</kbd>+<kbd>L</kbd> add selection · <kbd>Tab</kbd> accept completion · <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>J</kbd> this panel
            </>
          }
          control={
            <Button icon="keyboard" onClick={() => post({ type: 'runCommand', command: 'workbench.action.openGlobalKeybindings', args: ['kursor'] })}>
              Open shortcuts
            </Button>
          }
        />
        <SettingRow
          label="Color theme"
          description="Kursor ships a “Kursor Dark” theme; pick any other theme if you prefer."
          control={
            <Button icon="color-mode" onClick={() => post({ type: 'runCommand', command: 'workbench.action.selectTheme' })}>
              Choose theme
            </Button>
          }
        />
      </Section>

      <Section title="Integrated terminal" description="A `claude` session started in the integrated terminal can talk to this window.">
        <ToggleSetting setting="ide.enableServer" label="IDE bridge for the terminal" description="Lets a claude started in Kursor's terminal see your selection and diagnostics, and open its proposed diffs in the editor (lock file in ~/.claude/ide)." />
      </Section>

      <Section title="Diagnostics">
        <SettingRow
          label="Logs"
          description="Everything Kursor does — CLI calls, tool events, errors — is written to the Kursor output channel."
          control={
            <Button icon="output" onClick={() => post({ type: 'runCommand', command: 'kursor.showLogs' })}>
              Show logs
            </Button>
          }
        />
      </Section>
    </>
  );
}
