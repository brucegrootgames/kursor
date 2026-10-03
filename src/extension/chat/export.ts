/** Markdown transcript export of a chat. */
import type { ChatState } from '../../shared/protocol';

function fenced(text: string, lang = ''): string {
  let ticks = '```';
  while (text.includes(ticks)) ticks += '`';
  return `${ticks}${lang}\n${text.replace(/\n$/, '')}\n${ticks}`;
}

function describeTool(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const s = (k: string): string | undefined => (typeof i[k] === 'string' ? (i[k] as string) : undefined);
  switch (name) {
    case 'Read':
      return `Read \`${s('file_path') ?? ''}\``;
    case 'Edit':
    case 'Write':
    case 'NotebookEdit':
      return `${name === 'Write' ? 'Wrote' : 'Edited'} \`${s('file_path') ?? s('notebook_path') ?? ''}\``;
    case 'Bash':
      return `Ran \`${(s('command') ?? '').split('\n')[0]}\``;
    case 'Glob':
    case 'Grep':
      return `Searched for \`${s('pattern') ?? ''}\``;
    case 'Task':
      return `Subagent: ${s('description') ?? ''}`;
    case 'WebSearch':
      return `Searched the web: ${s('query') ?? ''}`;
    case 'WebFetch':
      return `Fetched ${s('url') ?? ''}`;
    default:
      return `${name} ${JSON.stringify(input ?? {}).slice(0, 200)}`;
  }
}

export function chatToMarkdown(chat: ChatState): string {
  const out: string[] = [];
  out.push(`# ${chat.title}`, '');
  out.push(`_Kursor chat · ${new Date(chat.createdAt).toLocaleString()} · mode: ${chat.mode}${chat.model ? ` · model: ${chat.model}` : ''}${chat.cwd ? ` · ${chat.cwd}` : ''}_`, '');
  for (const m of chat.messages) {
    if (m.kind === 'user') {
      out.push('## User', '');
      out.push(m.text.trim() || '_(empty)_', '');
      if (m.attachments.length) {
        out.push(`> Attached: ${m.attachments.map((a) => `\`${a.label}\``).join(', ')}`, '');
      }
    } else if (m.kind === 'assistant') {
      out.push('## Assistant', '');
      for (const b of m.blocks) {
        switch (b.type) {
          case 'text':
            out.push(b.text.trim(), '');
            break;
          case 'thinking':
            if (b.text.trim()) out.push('<details><summary>Thinking</summary>', '', b.text.trim(), '', '</details>', '');
            break;
          case 'tool': {
            const edit = b.edit ? ` (+${b.edit.additions} −${b.edit.deletions}${b.edit.status !== 'pending' ? `, ${b.edit.status}` : ''})` : '';
            const status = b.status === 'error' ? ' — error' : b.status === 'denied' ? ' — denied' : '';
            out.push(`- ${describeTool(b.name, b.input)}${edit}${status}`);
            if (b.output && (b.name === 'Bash' || b.status === 'error')) {
              out.push('', fenced(b.output.slice(0, 4000)), '');
            }
            break;
          }
          case 'permission':
            out.push(`- Permission: ${b.toolName}${b.title ? ` — ${b.title}` : ''} → ${b.decision ?? 'unanswered'}`);
            break;
          case 'question':
            for (const q of b.questions) out.push(`- Question: ${q.question} → ${b.answers?.[q.question] ?? b.answers?.[q.header] ?? '_unanswered_'}`);
            break;
          case 'plan':
            out.push('### Plan', '', b.plan.trim(), '', `_Decision: ${b.decision ?? 'pending'}_`, '');
            break;
          case 'todo':
            out.push(...b.items.map((t) => `- [${t.status === 'completed' ? 'x' : ' '}] ${t.content}${t.status === 'in_progress' ? ' _(in progress)_' : ''}`), '');
            break;
          default:
            break;
        }
      }
      if (m.result?.isError && m.result.errorText) out.push(`> Error: ${m.result.errorText}`, '');
      out.push('');
    } else {
      out.push(`> **${m.level}**: ${m.text}`, '');
    }
  }
  if (chat.totalCostUsd) out.push(`_Total cost: $${chat.totalCostUsd.toFixed(4)}_`, '');
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}
