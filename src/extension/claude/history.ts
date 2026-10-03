/**
 * Past sessions for the History view.
 *
 * Primary path: the SDK's `listSessions` / `getSessionMessages` / `deleteSession`
 * (they read the local transcript store; no process is spawned).
 * Fallback: read `~/.claude/projects/<key>/<id>.jsonl` directly, where `<key>` is
 * derived exactly like the CLI / SDK do it (verified in sdk.mjs 0.3.278):
 * `realpath(resolve(cwd))`, NFC-normalised on macOS, every non-alphanumeric
 * character → '-', capped at 200 characters plus a base-36 hash of the full path.
 * Works for Windows paths too (`C:\Users\x\proj` → `C--Users-x-proj`).
 * Honours `CLAUDE_CONFIG_DIR`. vscode-free.
 */
import { promises as fs, realpathSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expandHome, type Platform } from '../util/platform';
import type { HistoryEntry } from '../../shared/protocol';
import type { Logger } from '../util/log';
import { errorMessage, loadSdk } from './sdk';
import { userMessageText } from './translate';

export interface TranscriptMessage {
  role: 'user' | 'assistant';
  text: string;
  timestamp?: number;
}

type Dict = Record<string, unknown>;
const isDict = (v: unknown): v is Dict => typeof v === 'object' && v !== null && !Array.isArray(v);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_TITLE = 120;

const MAX_PROJECT_KEY = 200;

export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const override = env.CLAUDE_CONFIG_DIR?.trim();
  if (override) return path.resolve(expandHome(override, home));
  return path.join(home, '.claude');
}

/** Same string hash as the CLI (`(h << 5) - h + charCode | 0`), rendered in base 36. */
export function projectKeyHash(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
}

/** Directory name under `<config>/projects` for an already canonical cwd. */
export function projectKey(cwd: string): string {
  const key = cwd.replace(/[^a-zA-Z0-9]/g, '-');
  if (key.length <= MAX_PROJECT_KEY) return key;
  return `${key.slice(0, MAX_PROJECT_KEY)}-${projectKeyHash(cwd)}`;
}

/** What the CLI keys sessions by: absolute, symlinks resolved, NFC on macOS. */
export function canonicalCwd(cwd: string, platform: Platform = process.platform): string {
  let p = path.resolve(cwd);
  try {
    p = realpathSync(p);
  } catch {
    /* keep the resolved path */
  }
  return platform === 'darwin' ? p.normalize('NFC') : p;
}

export function projectDir(cwd: string): string {
  return path.join(claudeConfigDir(), 'projects', projectKey(canonicalCwd(cwd)));
}

function cleanTitle(text: string): string {
  const t = text
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return t.length > MAX_TITLE ? `${t.slice(0, MAX_TITLE - 1)}…` : t;
}

/** Text that Claude Code injects rather than the user typing it. */
function isInjectedUserText(text: string): boolean {
  const t = text.trimStart();
  return (
    t.startsWith('<system-reminder>') ||
    t.startsWith('<local-command') ||
    t.startsWith('<command-name>') ||
    t.startsWith('<command-message>') ||
    t.startsWith('[Request interrupted') ||
    t.startsWith('<bash-input>') ||
    t.startsWith('<bash-stdout>')
  );
}

function assistantText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (!isDict(block)) continue;
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
    else if (block.type === 'tool_use' && typeof block.name === 'string') parts.push(`[${block.name}]`);
  }
  return parts.join('\n');
}

function parseTimestamp(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const t = Date.parse(v);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Fallback: raw transcript files

interface RawSummary {
  title?: string;
  firstPrompt?: string;
  cwd?: string;
  messageCount: number;
  lastTimestamp?: number;
}

async function summarizeTranscript(file: string): Promise<RawSummary> {
  const summary: RawSummary = { messageCount: 0 };
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch {
    return summary;
  }
  let customTitle: string | undefined;
  let aiTitle: string | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isDict(entry)) continue;
    switch (entry.type) {
      case 'custom-title':
        if (typeof entry.customTitle === 'string') customTitle = entry.customTitle;
        break;
      case 'ai-title':
        if (typeof entry.aiTitle === 'string') aiTitle = entry.aiTitle;
        break;
      case 'user': {
        if (entry.isMeta === true || entry.isSidechain === true) break;
        const message = isDict(entry.message) ? entry.message : {};
        const t = userMessageText(message.content);
        if (!t || isInjectedUserText(t)) break;
        summary.messageCount++;
        if (!summary.firstPrompt) summary.firstPrompt = cleanTitle(t);
        if (!summary.cwd && typeof entry.cwd === 'string') summary.cwd = entry.cwd;
        summary.lastTimestamp = parseTimestamp(entry.timestamp) ?? summary.lastTimestamp;
        break;
      }
      case 'assistant':
        if (entry.isSidechain === true) break;
        summary.messageCount++;
        summary.lastTimestamp = parseTimestamp(entry.timestamp) ?? summary.lastTimestamp;
        break;
      default:
        break;
    }
  }
  summary.title = customTitle ?? aiTitle ?? summary.firstPrompt;
  return summary;
}

async function fallbackList(cwd: string, log: Logger): Promise<HistoryEntry[]> {
  const dir = projectDir(cwd);
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.debug(`history: cannot read ${dir}: ${errorMessage(err)}`);
    return [];
  }
  const entries: HistoryEntry[] = [];
  for (const name of names) {
    if (!name.endsWith('.jsonl')) continue;
    const sessionId = name.slice(0, -'.jsonl'.length);
    if (!UUID_RE.test(sessionId)) continue;
    const file = path.join(dir, name);
    try {
      const st = await fs.stat(file);
      const summary = await summarizeTranscript(file);
      if (summary.messageCount === 0) continue;
      entries.push({
        sessionId,
        title: summary.title || 'Untitled session',
        cwd: summary.cwd ?? cwd,
        updatedAt: st.mtimeMs,
        messageCount: summary.messageCount,
      });
    } catch (err) {
      log.debug(`history: skipping ${file}: ${errorMessage(err)}`);
    }
  }
  entries.sort((a, b) => b.updatedAt - a.updatedAt);
  return entries;
}

async function fallbackTranscript(sessionId: string, cwd: string): Promise<TranscriptMessage[]> {
  if (!UUID_RE.test(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);
  const file = path.join(projectDir(cwd), `${sessionId}.jsonl`);
  const text = await fs.readFile(file, 'utf8');
  const out: TranscriptMessage[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isDict(entry) || entry.isSidechain === true || entry.isMeta === true) continue;
    const message = isDict(entry.message) ? entry.message : undefined;
    if (!message) continue;
    if (entry.type === 'user') {
      const t = userMessageText(message.content);
      if (!t || isInjectedUserText(t)) continue;
      out.push({ role: 'user', text: t, timestamp: parseTimestamp(entry.timestamp) });
    } else if (entry.type === 'assistant') {
      const t = assistantText(message.content);
      if (!t) continue;
      out.push({ role: 'assistant', text: t, timestamp: parseTimestamp(entry.timestamp) });
    }
  }
  return out;
}

async function fallbackDelete(sessionId: string, cwd: string): Promise<void> {
  if (!UUID_RE.test(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);
  const dir = projectDir(cwd);
  await fs.rm(path.join(dir, `${sessionId}.jsonl`), { force: true });
  await fs.rm(path.join(dir, sessionId), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// Public API (SDK first, fallback second)

export async function listSessions(cwd: string, log: Logger): Promise<HistoryEntry[]> {
  try {
    const sdk = await loadSdk();
    const infos = await sdk.listSessions({ dir: cwd, limit: 200, includeProgrammatic: true });
    const entries = infos
      .filter((s) => UUID_RE.test(s.sessionId))
      .map<HistoryEntry>((s) => ({
        sessionId: s.sessionId,
        title: cleanTitle(s.customTitle || s.summary || s.firstPrompt || '') || 'Untitled session',
        cwd: s.cwd ?? cwd,
        updatedAt: s.lastModified,
      }));
    entries.sort((a, b) => b.updatedAt - a.updatedAt);
    return entries;
  } catch (err) {
    log.warn(`SDK listSessions failed, reading transcripts directly: ${errorMessage(err)}`);
    return fallbackList(cwd, log);
  }
}

export async function getSessionTranscript(sessionId: string, cwd: string, log: Logger): Promise<TranscriptMessage[]> {
  if (!UUID_RE.test(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);
  try {
    const sdk = await loadSdk();
    const messages = await sdk.getSessionMessages(sessionId, { dir: cwd });
    const out: TranscriptMessage[] = [];
    for (const m of messages) {
      if (m.parent_tool_use_id || m.parent_agent_id) continue;
      const message = isDict(m.message) ? m.message : undefined;
      if (!message) continue;
      const raw = m as unknown as Dict;
      const ts = parseTimestamp(raw.timestamp);
      if (m.type === 'user') {
        const t = userMessageText(message.content);
        if (!t || isInjectedUserText(t)) continue;
        out.push({ role: 'user', text: t, timestamp: ts });
      } else if (m.type === 'assistant') {
        const t = assistantText(message.content);
        if (!t) continue;
        out.push({ role: 'assistant', text: t, timestamp: ts });
      }
    }
    if (out.length > 0) return out;
    // The SDK may not know this project dir (e.g. an older layout); try the file.
    return await fallbackTranscript(sessionId, cwd).catch(() => out);
  } catch (err) {
    log.warn(`SDK getSessionMessages failed, reading the transcript directly: ${errorMessage(err)}`);
    return fallbackTranscript(sessionId, cwd);
  }
}

export async function deleteSession(sessionId: string, cwd: string, log: Logger): Promise<void> {
  if (!UUID_RE.test(sessionId)) throw new Error(`Invalid session id: ${sessionId}`);
  try {
    const sdk = await loadSdk();
    await sdk.deleteSession(sessionId, { dir: cwd });
  } catch (err) {
    log.warn(`SDK deleteSession failed, removing the transcript directly: ${errorMessage(err)}`);
    await fallbackDelete(sessionId, cwd);
    return;
  }
  // Belt and braces: make sure the file is gone even if the SDK only marked it.
  await fallbackDelete(sessionId, cwd).catch(() => undefined);
}
