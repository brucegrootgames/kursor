/**
 * ChatState helpers: construction, ids, titles, block lookup and trimming for
 * persistence. Pure functions (no VS Code dependency).
 */
import { randomUUID } from 'node:crypto';
import type { AssistantMessage, Block, ChatMessage, ChatMode, ChatState, EffortLevel, PermissionMode, SystemNote, UserMessage } from '../../shared/protocol';

export const MAX_PERSISTED_MESSAGES = 200;
export const MAX_TOOL_OUTPUT = 20 * 1024;
export const DEFAULT_TITLE = 'New Chat';

export function newId(prefix = ''): string {
  return prefix ? `${prefix}-${randomUUID()}` : randomUUID();
}

export interface NewChatOptions {
  mode: ChatMode;
  permissionMode: PermissionMode;
  model: string;
  effort: EffortLevel;
  cwd?: string;
  title?: string;
  sessionId?: string;
}

export function createChatState(opts: NewChatOptions): ChatState {
  const now = Date.now();
  return {
    id: newId('chat'),
    title: opts.title ?? DEFAULT_TITLE,
    sessionId: opts.sessionId,
    cwd: opts.cwd,
    mode: opts.mode,
    permissionMode: opts.permissionMode,
    model: opts.model,
    effort: opts.effort,
    status: 'idle',
    messages: [],
    pendingEdits: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** First non-empty line of the first user message, trimmed to 40 chars. */
export function titleFromText(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0 && !l.startsWith('## Attached') && !l.startsWith('@'));
  if (!line) return DEFAULT_TITLE;
  const clean = line.replace(/^[#>*\-\s]+/, '').replace(/\s+/g, ' ');
  return clean.length > 40 ? `${clean.slice(0, 39).trimEnd()}…` : clean;
}

export function capOutput(text: string): { output: string; truncated: boolean } {
  if (text.length <= MAX_TOOL_OUTPUT) return { output: text, truncated: false };
  return { output: `${text.slice(0, MAX_TOOL_OUTPUT)}\n… (${text.length - MAX_TOOL_OUTPUT} more characters truncated)`, truncated: true };
}

export function systemNote(text: string, level: SystemNote['level'] = 'info', action?: SystemNote['action']): SystemNote {
  return { kind: 'system', id: newId('sys'), text, level, timestamp: Date.now(), action };
}

export function lastAssistant(chat: ChatState): AssistantMessage | undefined {
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i];
    if (m.kind === 'assistant') return m;
  }
  return undefined;
}

export function findToolBlock(chat: ChatState, toolUseId: string): { message: AssistantMessage; block: Extract<Block, { type: 'tool' }> } | undefined {
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i];
    if (m.kind !== 'assistant') continue;
    for (const b of m.blocks) if (b.type === 'tool' && b.id === toolUseId) return { message: m, block: b };
  }
  return undefined;
}

export function findBlockById(chat: ChatState, id: string): { message: AssistantMessage; block: Block } | undefined {
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i];
    if (m.kind !== 'assistant') continue;
    for (const b of m.blocks) if (b.id === id) return { message: m, block: b };
  }
  return undefined;
}

export function findUserMessage(chat: ChatState, id: string): UserMessage | undefined {
  const m = chat.messages.find((x) => x.kind === 'user' && x.id === id);
  return m && m.kind === 'user' ? m : undefined;
}

/** Oldest user message that has no Claude Code uuid yet (the next replay/echo belongs to it). */
export function nextUserWithoutUuid(chat: ChatState): UserMessage | undefined {
  for (const m of chat.messages) if (m.kind === 'user' && !m.uuid) return m;
  return undefined;
}

/** Tool rows whose `edit` is still 'pending' but no longer tracked (e.g. after a reload) are marked kept. */
export function reconcileEditStatuses(chat: ChatState, pending: { path: string }[]): void {
  const live = new Set(pending.map((p) => p.path));
  for (const m of chat.messages) {
    if (m.kind !== 'assistant') continue;
    for (const b of m.blocks) {
      if (b.type === 'tool' && b.edit?.status === 'pending' && !live.has(b.edit.path)) b.edit = { ...b.edit, status: 'kept', hunks: 0 };
    }
  }
}

export function hasQueuedMessages(chat: ChatState): boolean {
  return chat.messages.some((m) => m.kind === 'user' && m.queued);
}

/** Copy suitable for workspaceState: bounded size, no runtime-only flags, no image payloads. */
export function trimForPersistence(chat: ChatState): ChatState {
  const messages: ChatMessage[] = chat.messages.slice(-MAX_PERSISTED_MESSAGES).map((m) => {
    if (m.kind === 'user') {
      return {
        ...m,
        queued: false,
        attachments: m.attachments.map((a) => (a.image ? { ...a, image: { ...a.image, dataBase64: '' } } : a)),
      };
    }
    if (m.kind === 'assistant') {
      return {
        ...m,
        streaming: false,
        blocks: m.blocks.map((b) => {
          if (b.type === 'tool') {
            const out = b.output !== undefined ? capOutput(b.output) : undefined;
            return { ...b, inputStreaming: false, status: b.status === 'running' ? 'error' : b.status, output: out?.output, outputTruncated: b.outputTruncated || out?.truncated };
          }
          if (b.type === 'permission' && !b.decision) return { ...b, decision: 'deny' as const };
          if (b.type === 'question' && !b.answers) return { ...b, answers: {} };
          if (b.type === 'plan' && !b.decision) return { ...b, decision: 'reject' as const };
          if (b.type === 'thinking') return { ...b, done: true };
          return b;
        }),
      };
    }
    return m;
  });
  return { ...chat, messages, status: 'idle', error: undefined, pendingEdits: [], unread: false };
}
