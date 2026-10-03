/**
 * Prompt + output cleanup for terminal command generation.
 */
import type { TerminalContext } from './context';
import { shellGuidance } from './shell';

export const TERMINAL_SYSTEM_PROMPT = [
  'You generate shell commands for a developer working in an integrated terminal.',
  'Given the shell, operating system, working directory and a natural-language request, output EXACTLY ONE command line that fulfils the request.',
  '',
  'Rules:',
  '- Output only the command line: no markdown, no code fences, no prompt symbol, no explanation before or after.',
  '- Use syntax valid for the given shell (PowerShell, cmd.exe or a POSIX shell — the prompt names it) and tools available on the given OS.',
  '- If several steps are required, chain them on one line with && (or a pipeline).',
  '- Prefer safe, non-destructive commands; never add --force/-rf/sudo unless the request explicitly asks for it.',
  '- Quote paths and arguments that contain spaces or special characters.',
  '- If the request is ambiguous, choose the most common interpretation rather than asking.',
].join('\n');

export interface TerminalPromptInput {
  request: string;
  context: TerminalContext;
  /** Set when the user is refining a previous attempt. */
  previous?: { request: string; command: string };
}

export function buildTerminalPrompt(input: TerminalPromptInput): string {
  const { context } = input;
  const lines = [
    `Shell: ${context.shell}`,
    `OS: ${context.os}`,
    `Working directory: ${context.cwd}`,
    ...shellGuidance(context.shellFamily ?? 'unknown'),
  ];
  if (input.previous) {
    lines.push(
      '',
      `Previous request: ${input.previous.request}`,
      `Previous command: ${input.previous.command}`,
      'The user revised the request; produce the updated command.',
    );
  }
  lines.push('', `Request: ${input.request}`, '', 'Command:');
  return lines.join('\n');
}

/** First real command line from the model output; '' when nothing usable. */
export function sanitizeCommand(raw: string): string {
  let text = raw.replace(/\r\n?/g, '\n').trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text);
  if (fenced) text = fenced[1];
  const lines = text
    .split('\n')
    .map((l) => l.replace(/^\s*```.*$/, '').trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return '';

  // Skip leading prose ("Here is the command:", "Command:").
  let first = lines.find((l) => !/^(here('s| is)|sure|certainly|command\s*:|the command)/i.test(l) || /^[`$]/.test(l)) ?? lines[0];
  first = first.replace(/^(command\s*:\s*)/i, '');
  // Inline code / prompt markers.
  const inline = /^`([^`]+)`$/.exec(first);
  if (inline) first = inline[1];
  // "$ cmd", "> cmd", "PS> cmd", "PS C:\\Users\\me> cmd", "C:\\proj> cmd"
  first = first.replace(/^(?:\$|>|#|PS>|PS [A-Za-z]:\\[^>]*>|[A-Za-z]:\\[^>]*>)\s+/, '');
  return first.trim();
}
