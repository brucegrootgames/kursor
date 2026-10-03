/**
 * External store for the settings panel (React 18 `useSyncExternalStore`).
 *
 * `state` mirrors the host's `SettingsState`. Setting writes are optimistic: the local value is
 * updated immediately and posted; the host answers with a fresh `settings` snapshot after
 * `onDidChangeConfiguration` (or re-sends the old one when the write was rejected).
 */
import { useSyncExternalStore } from 'react';
import {
  isSettingsTab,
  type SettingKey,
  type SettingsHostToPanel,
  type SettingsState,
  type SettingsTab,
  type SettingsValues,
} from '../shared/settingsProtocol';
import { getUiState, post, setUiState } from './vscode';

export interface Toast {
  id: number;
  level: 'info' | 'warning' | 'error';
  text: string;
}

export interface StoreState {
  state: SettingsState | null;
  tab: SettingsTab;
  toasts: Toast[];
}

const initialUi = getUiState();

let state: StoreState = {
  state: null,
  tab: isSettingsTab(initialUi.tab) ? initialUi.tab : 'general',
  toasts: [],
};

const listeners = new Set<() => void>();
let toastSeq = 0;
const toastTimers = new Map<number, ReturnType<typeof setTimeout>>();

function emit(): void {
  for (const l of listeners) l();
}

function update(patch: Partial<StoreState>): void {
  state = { ...state, ...patch };
  emit();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStore<T>(selector: (s: StoreState) => T): T {
  return useSyncExternalStore(subscribe, () => selector(state), () => selector(state));
}

export function getState(): StoreState {
  return state;
}

// ---------------------------------------------------------------- actions

export function selectTab(tab: SettingsTab): void {
  if (state.tab === tab) return;
  update({ tab });
  setUiState({ tab });
  post({ type: 'tabChanged', tab });
}

export function setSetting<K extends SettingKey>(key: K, value: SettingsValues[K]): void {
  if (state.state) {
    const values = { ...state.state.settings.values, [key]: value };
    update({ state: { ...state.state, settings: { ...state.state.settings, values } } });
  }
  post({ type: 'setSetting', key, value });
}

export function resetSetting(key: SettingKey): void {
  if (state.state) {
    const meta = state.state.settings.meta.find((m) => m.key === key);
    if (meta) {
      const values = { ...state.state.settings.values, [key]: meta.defaultValue };
      update({ state: { ...state.state, settings: { ...state.state.settings, values } } });
    }
  }
  post({ type: 'resetSetting', key });
}

export function pushToast(level: Toast['level'], text: string, ttlMs = level === 'error' ? 8000 : 4000): void {
  const id = ++toastSeq;
  update({ toasts: [...state.toasts, { id, level, text }].slice(-4) });
  const timer = setTimeout(() => dismissToast(id), ttlMs);
  toastTimers.set(id, timer);
}

export function dismissToast(id: number): void {
  const timer = toastTimers.get(id);
  if (timer) clearTimeout(timer);
  toastTimers.delete(id);
  if (!state.toasts.some((t) => t.id === id)) return;
  update({ toasts: state.toasts.filter((t) => t.id !== id) });
}

// ---------------------------------------------------------------- host messages

export function handleHostMessage(msg: SettingsHostToPanel): void {
  switch (msg.type) {
    case 'state': {
      const tab = msg.state.initialTab ?? state.tab;
      const changed = tab !== state.tab;
      update({ state: msg.state, tab });
      if (changed) setUiState({ tab });
      return;
    }
    case 'settings':
      if (state.state) update({ state: { ...state.state, settings: msg.settings } });
      return;
    case 'claudeStatus':
      if (state.state) update({ state: { ...state.state, claude: msg.status } });
      return;
    case 'rules':
      if (state.state) update({ state: { ...state.state, rules: { items: msg.items, loading: msg.loading, error: msg.error } } });
      return;
    case 'workspace':
      if (state.state) update({ state: { ...state.state, workspace: msg.workspace } });
      return;
    case 'selectTab':
      selectTab(msg.tab);
      return;
    case 'toast':
      pushToast(msg.level, msg.text);
      return;
    default: {
      const unknown = msg as { type: string };
      // eslint-disable-next-line no-console
      console.warn('unknown host message', unknown.type);
    }
  }
}
