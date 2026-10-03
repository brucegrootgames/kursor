/**
 * Kursor Settings webview entry (bundled by esbuild to dist/settings.js + dist/settings.css).
 * Keep this file small: UI lives under ./components, state in ./store.ts.
 */
import { createRoot } from 'react-dom/client';
import { App } from './components/App';
import { hostLog } from './vscode';
import './styles.css';

window.addEventListener('error', (e) => hostLog('error', `settings webview error: ${e.message} (${e.filename}:${e.lineno})`));
window.addEventListener('unhandledrejection', (e) => {
  const r = (e as PromiseRejectionEvent).reason;
  hostLog('error', `settings webview unhandled rejection: ${r instanceof Error ? r.stack ?? r.message : String(r)}`);
});

// The bundle's CSS is emitted next to it as settings.css. The host links it; this is a fallback for
// hosts that only load the script (derive the URL from our own <script src>, keep the nonce).
(function ensureStylesheet() {
  try {
    if (document.querySelector('link[href*="settings.css"]')) return;
    const script = document.currentScript as HTMLScriptElement | null;
    const src = script?.src;
    if (!src || !/settings\.js(\?.*)?$/.test(src)) return;
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = src.replace(/settings\.js(\?.*)?$/, 'settings.css');
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
