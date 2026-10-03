/**
 * ChatStore — the collection of open chats + the active chat, persisted in
 * `workspaceState` (debounced; messages capped to 200, tool output to 20 kB,
 * image payloads stripped). Sessions are NOT stored here; `sessionId` is, so a
 * chat can be resumed after a window reload.
 */
import * as vscode from 'vscode';
import type { ChatState, ChatSummary } from '../../shared/protocol';
import type { Logger } from '../util/log';
import { DEFAULT_TITLE, trimForPersistence } from './state';

const STORAGE_KEY = 'kursor.chats.v1';
export const MAX_OPEN_CHATS = 20;

interface Persisted {
  activeChatId: string | null;
  chats: ChatState[];
}

export class ChatStore implements vscode.Disposable {
  private readonly list: ChatState[] = [];
  private activeIdValue: string | null = null;
  private persistTimer: NodeJS.Timeout | undefined;
  private readonly changed = new vscode.EventEmitter<void>();
  /** Fires when the set of chats or the active chat changes (not on message updates). */
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly log: Logger,
  ) {
    this.restore();
  }

  get activeId(): string | null {
    return this.activeIdValue;
  }

  all(): readonly ChatState[] {
    return this.list;
  }

  get(id: string): ChatState | undefined {
    return this.list.find((c) => c.id === id);
  }

  bySessionId(sessionId: string): ChatState | undefined {
    return this.list.find((c) => c.sessionId === sessionId);
  }

  active(): ChatState | undefined {
    return this.activeIdValue ? this.get(this.activeIdValue) : undefined;
  }

  summaries(): ChatSummary[] {
    return this.list.map((c) => ({ id: c.id, title: c.title, status: c.status, unread: c.unread, updatedAt: c.updatedAt }));
  }

  /** Add a chat and make it active. Evicts the oldest idle chat beyond MAX_OPEN_CHATS. */
  add(chat: ChatState): ChatState {
    this.list.push(chat);
    while (this.list.length > MAX_OPEN_CHATS) {
      const victim = this.list.find((c) => c.status === 'idle' && c.id !== chat.id);
      if (!victim) break;
      this.list.splice(this.list.indexOf(victim), 1);
      this.log.info(`evicted chat ${victim.id} (${victim.title})`);
    }
    this.activeIdValue = chat.id;
    this.fire();
    return chat;
  }

  /** Reuse an empty "New Chat" instead of piling up blank tabs. */
  emptyChat(): ChatState | undefined {
    return this.list.find((c) => c.messages.length === 0 && c.title === DEFAULT_TITLE && c.status === 'idle');
  }

  setActive(id: string): boolean {
    const chat = this.get(id);
    if (!chat) return false;
    this.activeIdValue = id;
    chat.unread = false;
    this.fire();
    return true;
  }

  remove(id: string): ChatState | undefined {
    const i = this.list.findIndex((c) => c.id === id);
    if (i < 0) return undefined;
    const [removed] = this.list.splice(i, 1);
    if (this.activeIdValue === id) {
      const next = this.list[Math.min(i, this.list.length - 1)];
      this.activeIdValue = next ? next.id : null;
    }
    this.fire();
    return removed;
  }

  rename(id: string, title: string): void {
    const chat = this.get(id);
    if (!chat) return;
    chat.title = title.trim() || DEFAULT_TITLE;
    chat.updatedAt = Date.now();
    this.fire();
  }

  /** Mark the collection dirty (call after message-level updates) — persists lazily. */
  touch(): void {
    this.schedulePersist();
  }

  private fire(): void {
    this.changed.fire();
    this.schedulePersist();
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      this.persistNow();
    }, 750);
  }

  persistNow(): void {
    const data: Persisted = { activeChatId: this.activeIdValue, chats: this.list.map(trimForPersistence) };
    void this.context.workspaceState.update(STORAGE_KEY, data).then(undefined, (err: unknown) => this.log.warn('persist chats failed', err));
  }

  private restore(): void {
    const data = this.context.workspaceState.get<Persisted>(STORAGE_KEY);
    if (!data || !Array.isArray(data.chats)) return;
    for (const c of data.chats) {
      if (!c || typeof c.id !== 'string' || !Array.isArray(c.messages)) continue;
      this.list.push({ ...c, status: 'idle', pendingEdits: [], unread: false, error: undefined });
    }
    this.activeIdValue = data.activeChatId && this.get(data.activeChatId) ? data.activeChatId : (this.list[this.list.length - 1]?.id ?? null);
    if (this.list.length) this.log.info(`restored ${this.list.length} chat(s)`);
  }

  dispose(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      this.persistNow();
    }
    this.changed.dispose();
  }
}
