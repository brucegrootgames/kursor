import { RadioSetting, Section, SelectSetting, ToggleSetting } from '../controls';

export function AgentsTab() {
  return (
    <>
      <Section title="Agent modes" description="New chats start in the default mode. Switch per chat with the mode dropdown, Ctrl+. or Shift+Tab.">
        <RadioSetting
          setting="agent.defaultMode"
          label="Default mode"
          options={[
            { value: 'agent', label: 'Agent', description: 'Edits files and runs commands autonomously. Best for multi-step tasks.' },
            { value: 'ask', label: 'Ask', description: 'Read-only: answers questions and explains code, never edits or writes files.' },
            { value: 'plan', label: 'Plan', description: 'Explores the codebase and proposes a plan you approve before anything is built.' },
          ]}
        />
      </Section>

      <Section title="Permissions" description="How tool calls in Agent mode are approved. Terminal commands and other risky actions show an inline card in chat with Run / Skip / Always allow.">
        <RadioSetting
          setting="agent.permissionMode"
          label="Approval"
          options={[
            { value: 'acceptEdits', label: 'Apply edits, ask before commands', description: 'File edits are applied automatically (with Keep / Undo); terminal commands and other tools ask first. Cursor’s default.' },
            { value: 'default', label: 'Ask every time', description: 'Every edit and every command needs your approval.' },
            { value: 'auto', label: 'Auto-run routine actions', description: 'Let Claude Code’s auto-mode classifier approve safe, routine actions and ask about the rest.' },
            { value: 'bypassPermissions', label: 'Run everything', description: 'Nothing asks for approval — edits, commands, network. Only use in a sandbox or a throwaway checkout.', danger: true },
          ]}
        />
        <ToggleSetting setting="agent.notifyOnPermission" label="Notify when approval is needed" description="Show a desktop notification when the agent is waiting on you and the chat is not visible." />
      </Section>

      <Section title="Edits" description="How agent edits land in your files.">
        <ToggleSetting setting="agent.inlineDiffs" label="Inline diffs" description="Highlight lines the agent changed directly in the editor with Keep / Undo actions per change (Cursor “Inline Diffs”). The review bar in chat works either way." />
        <ToggleSetting setting="agent.autoSave" label="Auto-save before edits" description="Save dirty editors before the agent reads or writes a file so it never works from a stale copy." />
      </Section>

      <Section title="Context" description="What gets attached to each message automatically.">
        <ToggleSetting setting="agent.attachOpenFile" label="Include the active file" description="Tell the agent which file is open and what is selected when you send a message. Use @ to add more context explicitly." />
      </Section>

      <Section title="Chat display">
        <ToggleSetting setting="chat.showThinking" label="Show thinking" description="Show collapsible “Thinking…” indicators while the model reasons." />
        <SelectSetting
          setting="chat.toolCallDensity"
          label="Tool call detail"
          description="How much each tool row shows (file reads, searches, commands) before you expand it."
          options={[
            { value: 'compact', label: 'Compact' },
            { value: 'balanced', label: 'Balanced' },
            { value: 'detailed', label: 'Detailed' },
          ]}
        />
      </Section>
    </>
  );
}
