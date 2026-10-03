/**
 * `.mdc` front matter parser (Cursor rules).
 *
 *   ---
 *   description: Use when touching the API layer
 *   globs: src/api/**, *.controller.ts
 *   alwaysApply: false
 *   ---
 *   <markdown body>
 *
 * `globs` may be comma-separated, a YAML flow list (`["a", "b"]`) or a block
 * list (`- a`). Unknown keys are ignored. vscode-free.
 */
export interface ParsedRule {
  description?: string;
  globs: string[];
  alwaysApply: boolean;
  body: string;
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) return t.slice(1, -1);
  return t;
}

export function parseGlobList(raw: string | string[] | undefined): string[] {
  if (!raw) return [];
  const items: string[] = [];
  const push = (s: string): void => {
    const v = unquote(s);
    if (v) items.push(v);
  };
  if (Array.isArray(raw)) {
    for (const r of raw) push(r);
    return items;
  }
  let text = raw.trim();
  if (text.startsWith('[') && text.endsWith(']')) text = text.slice(1, -1);
  // Split on commas that are not inside braces: `**/*.{ts,tsx}` stays intact.
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '{') depth++;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      push(cur);
      cur = '';
      continue;
    }
    cur += ch;
  }
  push(cur);
  return items;
}

function parseBool(v: string | undefined): boolean {
  if (!v) return false;
  const t = unquote(v).toLowerCase();
  return t === 'true' || t === 'yes' || t === 'on' || t === '1';
}

export function parseRuleFile(text: string): ParsedRule {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/^﻿/, '');
  const lines = normalized.split('\n');
  if (lines[0]?.trim() !== '---') return { globs: [], alwaysApply: false, body: normalized.trim() };
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---' || lines[i].trim() === '...') {
      end = i;
      break;
    }
  }
  if (end < 0) return { globs: [], alwaysApply: false, body: normalized.trim() };

  const fields = new Map<string, string | string[]>();
  let listKey: string | undefined;
  for (let i = 1; i < end; i++) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const listItem = /^\s+-\s*(.*)$/.exec(line);
    if (listItem && listKey) {
      const existing = fields.get(listKey);
      const arr = Array.isArray(existing) ? existing : [];
      arr.push(listItem[1]);
      fields.set(listKey, arr);
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    const value = kv[2].trim();
    if (value === '' || value === '|' || value === '>') {
      listKey = key;
      fields.set(key, fields.get(key) ?? []);
      continue;
    }
    listKey = undefined;
    fields.set(key, value);
  }

  const descriptionRaw = fields.get('description');
  const description = Array.isArray(descriptionRaw) ? descriptionRaw.map(unquote).join(' ') : descriptionRaw ? unquote(descriptionRaw) : undefined;
  const alwaysRaw = fields.get('alwaysApply');
  return {
    description: description || undefined,
    globs: parseGlobList(fields.get('globs')),
    alwaysApply: parseBool(Array.isArray(alwaysRaw) ? alwaysRaw[0] : alwaysRaw),
    body: lines
      .slice(end + 1)
      .join('\n')
      .trim(),
  };
}
