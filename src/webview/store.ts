/**
 * Single external store for the webview (React 18 `useSyncExternalStore`).
 *
 * - `app`/`chats` mirror the host (`appState` / `chatState` messages). Incoming `ChatState`
 *   snapshots are reconciled against the previous one so unchanged messages and blocks keep
 *   their object identity — that is what makes `memo()`-ed message components skip work.
 * - `composer` holds per-chat input drafts + attachment pills (survives history view / chat switches).
 * - Streaming text lives in `deltaStore.ts`, not here.
 */
import { useSyncExternalStore } from 'react';
import type {
  AppState,
  Attachment,
  ChatMessage,
  ChatState,
  HistoryEntry,
  HostToWebview,
  WebviewToHost,
  Block,
} from '../shared/protocol';
import { appendDelta, dropBlocks, syncBlock } from './deltaStore';
import { deliverMentionResults } from './mentions';
import { deepEqual } from './util';
import { getUiState, post, setUiState } from './vscode';

export interface Toast {
  id: number;
  level: 'info' | 'warning' | 'error';
  text: string;
}

export interface ComposerState {
  text: string;
  attachments: Attachment[];
}

export interface StoreState {
  app: AppState | null;
  chats: Record<string, ChatState>;
  history: HistoryEntry[] | null;
  historyLoading: boolean;
  showHistory: boolean;
  toasts: Toast[];
  composer: Record<string, ComposerState>;
  /** Persisted preference: thinking blocks collapsed by default. */
  collapsedThinking: boolean;
}

const EMPTY_COMPOSER: ComposerState = { text: '', attachments: [] };
export const NO_CHAT_KEY = '__none__';

const initialUi = getUiState();

let state: StoreState = {
  app: null,
  chats: {},
  history: null,
  historyLoading: false,
  showHistory: false,
  toasts: [],
  composer: {},
  collapsedThinking: initialUi.collapsedThinking ?? true,
};

const listeners = new Set<() => void>();

function emit(): void {
  for (const l of listeners) l();
}

function setState(patch: Partial<StoreState> | ((s: StoreState) => Partial<StoreState>)): void {
  const p = typeof patch === 'function' ? patch(state) : patch;
  state = { ...state, ...p };
  emit();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

export function getState(): StoreState {
  return state;
}

export function useStore<T>(selector: (s: StoreState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state));
}

export function useComposer(chatKey: string): ComposerState {
  return useStore((s) => s.composer[chatKey] ?? EMPTY_COMPOSER);
}

export function activeChatKey(s: StoreState = state): string {
  return s.app?.activeChatId ?? NO_CHAT_KEY;
}

// ---------------------------------------------------------------------------
// Event bus for imperative UI requests (focus / insert) that target mounted components.

type UiEvent = { type: 'focusInput' } | { type: 'insertText'; text: string } | { type: 'scrollToBottom' };
const uiListeners = new Set<(e: UiEvent) => void>();
export function onUiEvent(cb: (e: UiEvent) => void): () => void {
  uiListeners.add(cb);
  return () => uiListeners.delete(cb);
}
function emitUi(e: UiEvent): void {
  for (const l of uiListeners) l(e);
}

// ---------------------------------------------------------------------------
// Reconciliation

function reconcileBlocks(prev: Block[], next: Block[]): Block[] {
  const byId = new Map<string, Block>();
  for (const b of prev) byId.set(b.id, b);
  let changed = prev.length !== next.length;
  const out = next.map((b, i) => {
    const p = byId.get(b.id);
    if (p && deepEqual(p, b)) {
      if (prev[i] !== p) changed = true;
      return p;
    }
    changed = true;
    return b;
  });
  return changed ? out : prev;
}

function reconcileMessages(prev: ChatMessage[], next: ChatMessage[]): ChatMessage[] {
  const byId = new Map<string, ChatMessage>();
  for (const m of prev) byId.set(m.id, m);
  let changed = prev.length !== next.length;
  const out = next.map((m, i) => {
    const p = byId.get(m.id);
    if (!p) {
      changed = true;
      return m;
    }
    if (deepEqual(p, m)) {
      if (prev[i] !== p) changed = true;
      return p;
    }
    changed = true;
    if (p.kind === 'assistant' && m.kind === 'assistant') {
      return { ...m, blocks: reconcileBlocks(p.blocks, m.blocks) };
    }
    return m;
  });
  return changed ? out : prev;
}

function reconcileChat(prev: ChatState | undefined, next: ChatState): ChatState {
  if (!prev) return next;
  const messages = reconcileMessages(prev.messages, next.messages);
  const pendingEdits = deepEqual(prev.pendingEdits, next.pendingEdits) ? prev.pendingEdits : next.pendingEdits;
  const contextUsage = deepEqual(prev.contextUsage, next.contextUsage) ? prev.contextUsage : next.contextUsage;
  const rateLimit = deepEqual(prev.rateLimit, next.rateLimit) ? prev.rateLimit : next.rateLimit;
  const merged: ChatState = { ...next, messages, pendingEdits, contextUsage, rateLimit };
  return deepEqual(prev, merged) ? prev : merged;
}

/** Keep delta buffers in sync with the snapshot and drop buffers of blocks that finished streaming. */
function syncDeltas(chat: ChatState): void {
  const drop: string[] = [];
  for (const m of chat.messages) {
    if (m.kind !== 'assistant') continue;
    for (const b of m.blocks) {
      const streaming = m.streaming && (b.type === 'text' || (b.type === 'thinking' && !b.done));
      if (streaming) syncBlock(b.id, b.type === 'text' || b.type === 'thinking' ? b.text : '');
      else drop.push(b.id);
    }
  }
  if (drop.length) dropBlocks(drop);
}

// ---------------------------------------------------------------------------
// Host → webview

let toastSeq = 0;
let pendingSend: { text: string; attachments: Attachment[]; sendNow?: boolean } | null = null;
/** Intents queued while no chat exists yet (mode/model picked on the empty state); run once a chat becomes active. */
let pendingChatSetup: Array<(chatId: string) => void> = [];

export function whenChatActive(fn: (chatId: string) => void): void {
  const id = state.app?.activeChatId;
  if (id) {
    fn(id);
    return;
  }
  pendingChatSetup.push(fn);
  post({ type: 'newChat' });
}

export function handleHostMessage(msg: HostToWebview): void {
  switch (msg.type) {
    case 'appState': {
      const prevActive = state.app?.activeChatId ?? null;
      const app = msg.state;
      const known = new Set(app.chats.map((c) => c.id));
      const chats: Record<string, ChatState> = {};
      for (const [id, c] of Object.entries(state.chats)) if (known.has(id)) chats[id] = c;
      setState({ app, chats });
      // Migrate a draft typed before any chat existed onto the chat that now became active.
      if (app.activeChatId && prevActive !== app.activeChatId) {
        const orphan = state.composer[NO_CHAT_KEY];
        if (orphan && (orphan.text || orphan.attachments.length) && !state.composer[app.activeChatId]) {
          const composer = { ...state.composer, [app.activeChatId]: orphan };
          delete composer[NO_CHAT_KEY];
          setState({ composer });
        }
        if (prevActive === null && pendingChatSetup.length) {
          const fns = pendingChatSetup;
          pendingChatSetup = [];
          for (const fn of fns) fn(app.activeChatId);
        }
        if (pendingSend) {
          const p = pendingSend;
          pendingSend = null;
          post({ type: 'send', chatId: app.activeChatId, text: p.text, attachments: p.attachments, sendNow: p.sendNow });
        }
        emitUi({ type: 'scrollToBottom' });
      }
      restoreDraftOnce();
      break;
    }
    case 'chatState': {
      const next = reconcileChat(state.chats[msg.chat.id], msg.chat);
      if (next !== state.chats[msg.chat.id]) {
        setState({ chats: { ...state.chats, [msg.chat.id]: next } });
      }
      syncDeltas(msg.chat);
      break;
    }
    case 'textDelta':
      appendDelta(msg.blockId, msg.delta);
      break;
    case 'mentionResults':
      deliverMentionResults(msg.requestId, msg.results);
      break;
    case 'history':
      setState({ history: msg.sessions, historyLoading: false });
      break;
    case 'showHistory':
      // Idempotent: the host also sends this in reply to our own `openHistory`.
      if (!state.showHistory) setState({ showHistory: true });
      if (state.history === null) requestHistory();
      break;
    case 'focusInput':
      if (state.showHistory) setState({ showHistory: false });
      setTimeout(() => emitUi({ type: 'focusInput' }), 0);
      break;
    case 'insertText':
      if (state.showHistory) setState({ showHistory: false });
      setTimeout(() => emitUi({ type: 'insertText', text: msg.text }), 0);
      break;
    case 'addAttachment':
      addAttachment(activeChatKey(), msg.attachment);
      if (state.showHistory) setState({ showHistory: false });
      setTimeout(() => emitUi({ type: 'focusInput' }), 0);
      break;
    case 'toast':
      pushToast(msg.level, msg.text);
      break;
    default:
      break;
  }
}

let draftRestored = false;
function restoreDraftOnce(): void {
  if (draftRestored) return;
  draftRestored = true;
  const ui = getUiState();
  const key = activeChatKey();
  if (ui.draft && !(state.composer[key]?.text)) {
    setComposerText(key, ui.draft);
  }
}

// ---------------------------------------------------------------------------
// Actions

export function send(message: WebviewToHost): void {
  post(message);
}

export function pushToast(level: Toast['level'], text: string, ttlMs = 6000): void {
  const id = ++toastSeq;
  setState((s) => ({ toasts: [...s.toasts, { id, level, text }] }));
  setTimeout(() => dismissToast(id), ttlMs);
}

export function dismissToast(id: number): void {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
}

let lastHistoryRequest = 0;
/** Ask the host for the session list (throttled: the host replies with `history` + `showHistory`). */
export function requestHistory(force = false): void {
  const now = Date.now();
  if (!force && now - lastHistoryRequest < 2000) return;
  lastHistoryRequest = now;
  setState({ historyLoading: true });
  post({ type: 'openHistory' });
}

export function openHistory(): void {
  setState({ showHistory: true });
  requestHistory(true);
}

export function closeHistory(): void {
  setState({ showHistory: false });
  setTimeout(() => emitUi({ type: 'focusInput' }), 0);
}

export function removeHistoryEntry(sessionId: string): void {
  setState((s) => ({ history: (s.history ?? []).filter((h) => h.sessionId !== sessionId) }));
}

export function setCollapsedThinking(collapsed: boolean): void {
  setState({ collapsedThinking: collapsed });
  setUiState({ collapsedThinking: collapsed });
}

let draftTimer: ReturnType<typeof setTimeout> | undefined;
export function setComposerText(chatKey: string, text: string): void {
  const cur = state.composer[chatKey] ?? EMPTY_COMPOSER;
  if (cur.text === text) return;
  setState((s) => ({ composer: { ...s.composer, [chatKey]: { ...cur, text } } }));
  if (chatKey === activeChatKey()) {
    if (draftTimer) clearTimeout(draftTimer);
    draftTimer = setTimeout(() => setUiState({ draft: text }), 300);
  }
}

export function addAttachment(chatKey: string, att: Attachment): void {
  const cur = state.composer[chatKey] ?? EMPTY_COMPOSER;
  const dup = cur.attachments.some(
    (a) =>
      a.kind === att.kind &&
      (a.path ?? '') === (att.path ?? '') &&
      (a.url ?? '') === (att.url ?? '') &&
      (a.range?.startLine ?? -1) === (att.range?.startLine ?? -1) &&
      (a.range?.endLine ?? -1) === (att.range?.endLine ?? -1) &&
      (a.kind !== 'image' || a.image?.dataBase64 === att.image?.dataBase64) &&
      (a.text ?? '') === (att.text ?? ''),
  );
  if (dup) return;
  setState((s) => ({ composer: { ...s.composer, [chatKey]: { ...cur, attachments: [...cur.attachments, att] } } }));
}

export function removeAttachment(chatKey: string, id: string): void {
  const cur = state.composer[chatKey] ?? EMPTY_COMPOSER;
  setState((s) => ({ composer: { ...s.composer, [chatKey]: { ...cur, attachments: cur.attachments.filter((a) => a.id !== id) } } }));
}

export function clearComposer(chatKey: string): void {
  setState((s) => ({ composer: { ...s.composer, [chatKey]: { text: '', attachments: [] } } }));
  if (chatKey === activeChatKey()) setUiState({ draft: '' });
}

/** Send the composer contents. Creates a chat first when none is active. */
export function sendComposer(chatKey: string, sendNow?: boolean): boolean {
  const cur = state.composer[chatKey] ?? EMPTY_COMPOSER;
  const text = cur.text.trim();
  if (!text && cur.attachments.length === 0) return false;
  const chatId = state.app?.activeChatId ?? null;
  if (!chatId || chatKey === NO_CHAT_KEY) {
    pendingSend = { text, attachments: cur.attachments, sendNow };
    clearComposer(chatKey);
    post({ type: 'newChat' });
    return true;
  }
  post({ type: 'send', chatId, text, attachments: cur.attachments, sendNow });
  clearComposer(chatKey);
  emitUi({ type: 'scrollToBottom' });
  return true;
}

export function focusInput(): void {
  emitUi({ type: 'focusInput' });
}
