/** Pure helpers for the settings panel. */
import type { SettingMeta, SettingKey, SettingsSnapshot } from '../shared/settingsProtocol';

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(' ');
}

export function tildify(p: string | undefined): string {
  if (!p) return '';
  const m = /^\/home\/[^/]+/.exec(p);
  return m ? '~' + p.slice(m[0].length) : p;
}

export function basename(p: string): string {
  const s = p.replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return i === -1 ? s : s.slice(i + 1);
}

export function metaFor(snapshot: SettingsSnapshot, key: SettingKey): SettingMeta | undefined {
  return snapshot.meta.find((m) => m.key === key);
}

export function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

export function timeAgo(ts: number | undefined, now = Date.now()): string {
  if (!ts) return '';
  const s = Math.max(0, Math.floor((now - ts) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return new Date(ts).toLocaleString();
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/** Model presets shared by the Models and Tab tabs. */
export interface ModelPreset {
  value: string;
  label: string;
  description: string;
}

export const MODEL_PRESETS: ModelPreset[] = [
  { value: 'opus', label: 'Opus', description: 'Most capable; slowest and most expensive' },
  { value: 'sonnet', label: 'Sonnet', description: 'Balanced speed and quality' },
  { value: 'haiku', label: 'Haiku', description: 'Fastest; best for completions and short tasks' },
  { value: 'fable', label: 'Fable', description: 'Fable family model' },
];

export const CUSTOM_MODEL = '__custom__';

/** Common VS Code language ids offered as suggestions for the disabled-languages editor. */
export const COMMON_LANGUAGE_IDS = [
  'plaintext', 'markdown', 'log', 'scminput', 'json', 'jsonc', 'yaml', 'toml', 'xml', 'html', 'css', 'scss', 'less',
  'javascript', 'javascriptreact', 'typescript', 'typescriptreact', 'python', 'go', 'rust', 'java', 'kotlin', 'c', 'cpp',
  'csharp', 'ruby', 'php', 'swift', 'shellscript', 'powershell', 'dockerfile', 'sql', 'lua', 'r', 'dart', 'elixir',
  'erlang', 'haskell', 'ocaml', 'scala', 'zig', 'nix', 'latex', 'bibtex', 'git-commit', 'git-rebase', 'diff', 'ini',
  'makefile', 'cmake', 'graphql', 'vue', 'svelte', 'astro', 'prisma', 'proto', 'terraform', 'hcl', 'csv', 'env',
];
