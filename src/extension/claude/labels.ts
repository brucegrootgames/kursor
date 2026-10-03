/**
 * Human labels for the SDK's `PermissionUpdate` suggestions ("Always allow…" menu)
 * and for tool names. vscode-free.
 */
import type { PermissionUpdate } from './sdk';

const MODE_LABELS: Record<string, string> = {
  acceptEdits: 'Always apply file edits',
  bypassPermissions: 'Run everything without asking',
  auto: 'Let the auto-mode classifier approve routine actions',
  plan: 'Switch to plan mode',
  default: 'Ask before every action',
  dontAsk: 'Deny anything that would ask',
};

function destinationSuffix(destination: string): string {
  switch (destination) {
    case 'session':
      return ' this session';
    case 'localSettings':
      return ' in this project (local settings)';
    case 'projectSettings':
      return ' in this project';
    case 'userSettings':
      return ' for all projects';
    default:
      return '';
  }
}

function shortenCommand(cmd: string): string {
  const t = cmd.trim();
  return t.length > 48 ? `${t.slice(0, 45)}…` : t;
}

/** "Bash" + "npm test *" → "`npm test …`", "Edit" + "/abs/path" → "editing `path`" */
export function describeRule(toolName: string, ruleContent: string | undefined): string {
  const content = ruleContent?.trim();
  const mcp = /^mcp__([^_]+(?:_[^_]+)*)__(.+)$/.exec(toolName);
  if (mcp) return `the \`${mcp[2]}\` tool from ${mcp[1]}`;
  if (!content) {
    switch (toolName) {
      case 'Bash':
        return 'running terminal commands';
      case 'Edit':
      case 'Write':
      case 'NotebookEdit':
        return 'editing files';
      case 'Read':
        return 'reading files';
      case 'WebFetch':
        return 'fetching web pages';
      case 'WebSearch':
        return 'searching the web';
      default:
        return `\`${toolName}\``;
    }
  }
  switch (toolName) {
    case 'Bash': {
      const shown = content.replace(/\s*\*+$/, ' …').replace(/:\*$/, ' …');
      return `\`${shortenCommand(shown)}\``;
    }
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return `editing \`${content}\``;
    case 'Read':
      return `reading \`${content}\``;
    case 'WebFetch': {
      const m = /^domain:(.+)$/.exec(content);
      return m ? `fetching from ${m[1]}` : `fetching \`${content}\``;
    }
    default:
      return `\`${toolName}(${shortenCommand(content)})\``;
  }
}

export function labelForSuggestion(s: PermissionUpdate): string {
  switch (s.type) {
    case 'setMode':
      return `${MODE_LABELS[s.mode] ?? `Switch to ${s.mode} mode`}${destinationSuffix(s.destination)}`;
    case 'addRules':
    case 'replaceRules': {
      const verb = s.behavior === 'allow' ? 'Always allow' : s.behavior === 'deny' ? 'Always deny' : 'Always ask before';
      const parts = s.rules.slice(0, 2).map((r) => describeRule(r.toolName, r.ruleContent));
      const more = s.rules.length > 2 ? ` and ${s.rules.length - 2} more` : '';
      return `${verb} ${parts.join(' and ')}${more}${destinationSuffix(s.destination)}`;
    }
    case 'removeRules': {
      const parts = s.rules.slice(0, 2).map((r) => describeRule(r.toolName, r.ruleContent));
      return `Remove the ${s.behavior} rule for ${parts.join(' and ')}${destinationSuffix(s.destination)}`;
    }
    case 'addDirectories': {
      const dirs = s.directories.slice(0, 2).map((d) => `\`${d}\``).join(', ');
      const more = s.directories.length > 2 ? ` (+${s.directories.length - 2})` : '';
      return `Allow access to ${dirs}${more}${destinationSuffix(s.destination)}`;
    }
    case 'removeDirectories': {
      const dirs = s.directories.slice(0, 2).map((d) => `\`${d}\``).join(', ');
      return `Remove access to ${dirs}${destinationSuffix(s.destination)}`;
    }
    default:
      return 'Remember this decision';
  }
}

/** Title shown on a permission card when the CLI did not send one. */
export function defaultPermissionTitle(toolName: string, input: Record<string, unknown>): string {
  switch (toolName) {
    case 'Bash':
      return typeof input.command === 'string' ? `Run \`${shortenCommand(input.command)}\`` : 'Run a terminal command';
    case 'Edit':
      return typeof input.file_path === 'string' ? `Edit ${input.file_path}` : 'Edit a file';
    case 'Write':
      return typeof input.file_path === 'string' ? `Write ${input.file_path}` : 'Write a file';
    case 'NotebookEdit':
      return typeof input.notebook_path === 'string' ? `Edit notebook ${input.notebook_path}` : 'Edit a notebook';
    case 'Read':
      return typeof input.file_path === 'string' ? `Read ${input.file_path}` : 'Read a file';
    case 'WebFetch':
      return typeof input.url === 'string' ? `Fetch ${input.url}` : 'Fetch a web page';
    case 'WebSearch':
      return typeof input.query === 'string' ? `Search the web for "${input.query}"` : 'Search the web';
    case 'AskUserQuestion':
      return 'Question';
    case 'ExitPlanMode':
      return 'Plan ready';
    default: {
      const mcp = /^mcp__(.+?)__(.+)$/.exec(toolName);
      return mcp ? `Use ${mcp[2]} (${mcp[1]})` : `Use ${toolName}`;
    }
  }
}
