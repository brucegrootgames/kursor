import { useId } from '../../hooks';
import { setSetting } from '../../store';
import { COMMON_LANGUAGE_IDS } from '../../util';
import { post } from '../../vscode';
import { Button, NumberSetting, Section, SettingFooter, SettingRow, TagListField, ToggleSetting, useSettingMeta, useSettingValue } from '../controls';
import { ModelSetting } from '../ModelPicker';

function DisabledLanguagesSetting() {
  const value = useSettingValue('tab.disabledLanguages');
  const meta = useSettingMeta('tab.disabledLanguages');
  const id = useId('langs');
  const descId = `${id}-desc`;
  return (
    <SettingRow label="Disabled languages" description="Language ids where Tab stays quiet. Type an id and press Enter; Backspace removes the last one." htmlFor={id} descriptionId={descId} footer={<SettingFooter meta={meta} value={value} />}>
      <TagListField id={id} values={value} suggestions={COMMON_LANGUAGE_IDS} placeholder="e.g. markdown" describedBy={descId} ariaLabel="Disabled languages" onChange={(v) => setSetting('tab.disabledLanguages', v)} />
    </SettingRow>
  );
}

export function TabCompletionsTab() {
  const enabled = useSettingValue('tab.enabled');
  return (
    <>
      <Section
        title="Kursor Tab"
        description="Ghost-text completions while you type. Each suggestion is one request to the CLI on your subscription, so they are debounced and kept small."
        actions={
          <Button ghost icon="sparkle" onClick={() => post({ type: 'runCommand', command: 'kursor.tab.statusMenu' })} title="Same menu as the status bar item">
            Status menu
          </Button>
        }
      >
        <ToggleSetting setting="tab.enabled" label="Enable Tab completions" description="Press Tab to accept a suggestion, Alt+\\ to request one manually. The status bar item can snooze Tab for 30 minutes." />
        <div className={enabled ? undefined : 'dimmed'} aria-disabled={!enabled || undefined}>
          <NumberSetting setting="tab.debounceMs" label="Typing pause" description="How long to wait after your last keystroke before asking for a completion. Lower feels snappier but spends more requests." min={150} max={60_000} step={50} suffix="ms" />
          <ModelSetting setting="tab.model" label="Model" description="Fast models (Haiku) are recommended — a completion round trip is a few seconds at best." />
          <NumberSetting setting="tab.contextLines" label="Context lines" description="Lines of code before and after the cursor sent with each request." min={5} max={2000} step={10} suffix="lines" />
          <DisabledLanguagesSetting />
        </div>
      </Section>
    </>
  );
}
