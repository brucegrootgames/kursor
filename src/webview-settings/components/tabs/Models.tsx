import { Section, SelectSetting } from '../controls';
import { ModelSetting } from '../ModelPicker';

export function ModelsTab() {
  return (
    <>
      <Section title="Chat & agent" description="Models are passed to the Claude Code CLI by alias (opus, sonnet, haiku, fable) or full id. Each chat can override these from its model dropdown (Ctrl+/).">
        <ModelSetting setting="claude.model" label="Default model" description="Used for new chats. “Default” means whatever your CLI is configured to use (claude config / ANTHROPIC_MODEL)." allowDefault />
        <SelectSetting
          setting="claude.effort"
          label="Effort"
          description="How hard the model thinks on models that support effort levels. Higher is slower and uses more of your window."
          options={[
            { value: '', label: 'Default' },
            { value: 'low', label: 'Low' },
            { value: 'medium', label: 'Medium' },
            { value: 'high', label: 'High' },
            { value: 'xhigh', label: 'Extra high' },
            { value: 'max', label: 'Max' },
          ]}
        />
      </Section>

      <Section title="Per-feature models" description="Small, fast features use their own model so the agent model can stay heavyweight.">
        <ModelSetting setting="inlineEdit.model" label="Inline edit (Ctrl+K)" description="Rewrites the selected code in place. Sonnet is a good balance." />
        <ModelSetting setting="terminal.model" label="Terminal command (Ctrl+K in terminal)" description="Turns a description into a shell command." />
        <ModelSetting setting="commit.model" label="Commit message" description="Summarizes the staged diff into a conventional commit message." />
        <ModelSetting setting="tab.model" label="Tab completions" description="Also on the Tab page. Fast models recommended." />
      </Section>
    </>
  );
}
