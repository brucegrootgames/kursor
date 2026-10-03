/**
 * Kursor chat webview entry (bundled by esbuild to dist/webview.js).
 * Keep this file small: all UI lives under ./components, state in ./store.ts.
 */
import { createRoot } from 'react-dom/client';
import { App } from './components/App';
import { hostLog } from './vscode';
import './styles.css';

window.addEventListener('error', (e) => hostLog('error', `webview error: ${e.message} (${e.filename}:${e.lineno})`));
window.addEventListener('unhandledrejection', (e) => {
  const r = (e as PromiseRejectionEvent).reason;
  hostLog('error', `webview unhandled rejection: ${r instanceof Error ? r.stack ?? r.message : String(r)}`);
});

// The bundle's CSS is emitted next to it as webview.css. The host links it; this is a fallback for
// hosts that only load the script (derive the URL from our own <script src>, keep the nonce).
(function ensureStylesheet() {
  try {
    if (document.querySelector('link[href*="webview.css"]')) return;
    const script = document.currentScript as HTMLScriptElement | null;
    const src = script?.src;
    if (!src || !/webview\.js(\?.*)?$/.test(src)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = src.replace(/webview\.js(\?.*)?$/, 'webview.css');
    const nonce = script?.nonce || script?.getAttribute('nonce');
    if (nonce) link.setAttribute('nonce', nonce);
    document.head.appendChild(link);
  } catch {
    /* ignore */
  }
})();

let rootEl = document.getElementById('root');
if (!rootEl) {
  rootEl = document.createElement('div');
  rootEl.id = 'root';
  document.body.appendChild(rootEl);
}
createRoot(rootEl).render(<App />);
