/**
 * Thin wrapper around `acquireVsCodeApi()` — the only place the settings panel talks to the host.
 * Outgoing messages are typed as `SettingsPanelToHost`; the selected tab is persisted with
 * `getState`/`setState` (`SettingsUiState`) so a restored panel reopens where it was.
 */
import type { SettingsPanelToHost, SettingsUiState } from '../shared/settingsProtocol';

interface VsCodeApi {
  postMessage(message: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

let api: VsCodeApi | undefined;
try {
  api = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
} catch {
  api = undefined;
}

/** Send an intent to the extension host. Never throws. */
export function post(message: SettingsPanelToHost): void {
  try {
    api?.postMessage(message);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('postMessage failed', err);
  }
}

export function getUiState(): SettingsUiState {
  try {
    const s = api?.getState();
    return s && typeof s === 'object' ? (s as SettingsUiState) : {};
  } catch {
    return {};
  }
}

export function setUiState(patch: Partial<SettingsUiState>): void {
  try {
    api?.setState({ ...getUiState(), ...patch });
  } catch {
    /* ignore */
  }
}

/** Forward a diagnostic line to the host logger (Kursor output channel). */
export function hostLog(level: 'info' | 'warn' | 'error', text: string): void {
  post({ type: 'log', level, text });
}
