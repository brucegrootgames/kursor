/**
 * Prompt composition for a user turn.
 *
 *   <user text>
 *
 *   ## Attached context
 *   @src/file.ts                       ← files/folders/rules: Claude Code reads them itself
 *   ### Selection from `src/file.ts` (lines 10-42)
 *   ```ts … ```                        ← selection/diagnostic/problems/terminal/git inline
 *   ### URL
 *   https://…                          ← fetched by the agent when relevant
 *
 *   Active file: `src/file.ts` (cursor at L12, selection L10-L20)
 *
 * Images become content blocks (`UserTurn.images`). Slash commands typed by the
 * user (`/review …`) are passed through verbatim — Claude Code expands them.
 */
import * as path from 'node:path';
import type { Attachment } from '../../shared/protocol';
import type { UserTurn } from '../claude/types';

export interface ActiveFileInfo {
  fsPath: string;
  cursorLine: number;
  selection?: { startLine: number; endLine: number };
}

export interface ComposeOptions {
  cwd: string;
  activeFile?: ActiveFileInfo;
}

export interface ComposedTurn {
  turn: UserTurn;
  /** Absolute paths referenced by the turn (for rules glob matching). */
  contextPaths: string[];
}

const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.jsx': 'jsx', '.mjs': 'js', '.cjs': 'js', '.json': 'json', '.py': 'python', '.rs': 'rust', '.go': 'go',
  '.java': 'java', '.kt': 'kotlin', '.c': 'c', '.h': 'c', '.cpp': 'cpp', '.hpp': 'cpp', '.cs': 'csharp', '.rb': 'ruby', '.php': 'php', '.sh': 'bash',
  '.bash': 'bash', '.zsh': 'zsh', '.fish': 'fish', '.lua': 'lua', '.md': 'markdown', '.mdc': 'markdown', '.yml': 'yaml', '.yaml': 'yaml', '.toml': 'toml',
  '.html': 'html', '.css': 'css', '.scss': 'scss', '.sql': 'sql', '.xml': 'xml', '.swift': 'swift', '.dart': 'dart', '.vue': 'vue', '.svelte': 'svelte',
};

export function languageFor(fsPath?: string): string {
  if (!fsPath) return '';
  return LANG_BY_EXT[path.extname(fsPath).toLowerCase()] ?? '';
}

export function fence(text: string, lang = ''): string {
  let ticks = '```';
  while (text.includes(ticks)) ticks += '`';
  return `${ticks}${lang}\n${text.replace(/\n$/, '')}\n${ticks}`;
}

/** Path for the prompt: relative to cwd when inside it, else absolute. */
export function promptPath(fsPath: string | undefined, cwd: string): string {
  if (!fsPath) return '';
  if (!path.isAbsolute(fsPath)) return fsPath.split(path.sep).join('/');
  const rel = path.relative(cwd, fsPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return fsPath;
  return rel.split(path.sep).join('/');
}

export function composeTurn(text: string, attachments: Attachment[], opts: ComposeOptions): ComposedTurn {
  const images: NonNullable<UserTurn['images']> = [];
  const refLines: string[] = [];
  const sections: string[] = [];
  const contextPaths: string[] = [];

  for (const a of attachments) {
    if (a.path && path.isAbsolute(a.path)) contextPaths.push(a.path);
    switch (a.kind) {
      case 'file':
        refLines.push(`@${promptPath(a.path ?? a.relPath, opts.cwd)}`);
        break;
      case 'folder': {
        const p = promptPath(a.path ?? a.relPath, opts.cwd);
        refLines.push(`@${p.endsWith('/') ? p : `${p}/`}`);
        break;
      }
      case 'rule':
        refLines.push(`@${promptPath(a.path ?? a.relPath, opts.cwd)} (apply this rule)`);
        break;
      case 'selection': {
        const p = promptPath(a.path ?? a.relPath, opts.cwd);
        const where = a.range ? ` (lines ${a.range.startLine}${a.range.endLine !== a.range.startLine ? `-${a.range.endLine}` : ''})` : '';
        sections.push(`### Selection from \`${p || a.label}\`${where}\n${fence(a.text ?? '', languageFor(a.path))}`);
        break;
      }
      case 'diagnostic': {
        const p = promptPath(a.path ?? a.relPath, opts.cwd);
        sections.push(`### Diagnostic in \`${p || a.label}\`${a.range ? ` (line ${a.range.startLine})` : ''}\n${fence(a.text ?? '')}`);
        break;
      }
      case 'problems':
        sections.push(`### Problems${a.relPath ? ` in \`${a.relPath}\`` : ' (workspace diagnostics)'}\n${fence(a.text ?? '')}`);
        break;
      case 'terminal':
        sections.push(`### Terminal output${a.label && a.label !== 'Terminal' ? ` (${a.label})` : ''}\n${fence(a.text ?? '')}`);
        break;
      case 'git':
        sections.push(`### Git working changes${a.label ? ` — ${a.label}` : ''}\n${fence(a.text ?? '', 'diff')}`);
        break;
      case 'url':
        sections.push(`### URL\n${a.url ?? a.label}\n(Fetch it with WebFetch when relevant.)`);
        break;
      case 'image':
        if (a.image?.dataBase64) images.push({ mediaType: a.image.mediaType, dataBase64: a.image.dataBase64 });
        break;
      default:
        break;
    }
  }

  const parts: string[] = [];
  const body = text.trim();
  if (body) parts.push(body);
  if (refLines.length || sections.length) {
    const ctx: string[] = ['## Attached context'];
    if (refLines.length) ctx.push(refLines.join('\n'));
    ctx.push(...sections);
    parts.push(ctx.join('\n\n'));
  }
  if (opts.activeFile) {
    const p = promptPath(opts.activeFile.fsPath, opts.cwd);
    const sel = opts.activeFile.selection;
    const selText = sel && sel.endLine !== sel.startLine ? `, selection L${sel.startLine}-${sel.endLine}` : sel ? `, selection L${sel.startLine}` : '';
    parts.push(`Active file: \`${p}\` (cursor at L${opts.activeFile.cursorLine}${selText})`);
    contextPaths.push(opts.activeFile.fsPath);
  }
  let prompt = parts.join('\n\n');
  if (!prompt && images.length) prompt = 'See the attached image(s).';
  return { turn: { text: prompt, images: images.length ? images : undefined }, contextPaths: [...new Set(contextPaths)] };
}

export const KURSOR_SYSTEM_NOTE = [
  'You are running inside the Kursor editor (a VS Code based IDE) as its chat/agent assistant.',
  'Your replies are rendered as markdown in a chat panel; file edits you make are applied on disk and shown to the user as reviewable diffs (Keep/Undo).',
  'Attached files are referenced with @path lines — read them with your tools when relevant. "Active file" tells you what the user is looking at.',
  'When you show code meant to replace part of a file, use a fenced block with the language and the path after it (e.g. ```ts src/app.ts) so the user can apply it.',
  'Be concise; prefer doing the work over describing it.',
].join(' ');
