/**
 * Thin wrapper around `acquireVsCodeApi()` — the only place the webview talks to the host.
 * Every outgoing message is typed as `WebviewToHost`; UI-only state is persisted via
 * `getState`/`setState` as `WebviewUiState` (never chat content).
 */
import type { WebviewToHost, WebviewUiState } from '../shared/protocol';

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
export function post(message: WebviewToHost): void {
  try {
    api?.postMessage(message);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('postMessage failed', err);
  }
}

export function getUiState(): WebviewUiState {
  try {
    const s = api?.getState();
    return s && typeof s === 'object' ? (s as WebviewUiState) : {};
  } catch {
    return {};
  }
}

export function setUiState(patch: Partial<WebviewUiState>): void {
  try {
    api?.setState({ ...getUiState(), ...patch });
  } catch {
    /* ignore */
  }
}

/** Forward a diagnostic line to the host logger (shows up in the Kursor output channel). */
export function hostLog(level: 'info' | 'warn' | 'error', text: string): void {
  post({ type: 'log', level, text });
}
