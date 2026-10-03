/**
 * Diff collection, prompt and output cleanup for commit message generation.
 * Pure w.r.t. VS Code UI (only reads files for untracked content).
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import type { Repository } from './git';

export const MAX_DIFF_CHARS = 60_000;
const MAX_UNTRACKED_FILES = 12;
const MAX_UNTRACKED_FILE_BYTES = 16_000;
const RECENT_COMMITS = 10;

export interface DiffContext {
  kind: 'staged' | 'working';
  diff: string;
  truncated: boolean;
  files: string[];
  branch?: string;
  recentCommits: string[];
}

export async function collectDiff(repo: Repository): Promise<DiffContext | undefined> {
  const branch = repo.state.HEAD?.name;
  const recentCommits = await recentSubjects(repo);

  const staged = await repo.diff(true);
  if (staged.trim()) {
    const { text, truncated, files } = truncateDiff(staged);
    return { kind: 'staged', diff: text, truncated, files, branch, recentCommits };
  }

  let working = await repo.diff();
  const untracked = await untrackedAsDiff(repo);
  if (untracked) working = working ? `${working}\n${untracked}` : untracked;
  if (!working.trim()) return undefined;
  const { text, truncated, files } = truncateDiff(working);
  return { kind: 'working', diff: text, truncated, files, branch, recentCommits };
}

async function recentSubjects(repo: Repository): Promise<string[]> {
  try {
    const commits = await repo.log({ maxEntries: RECENT_COMMITS });
    return commits.map((c) => c.message.split('\n')[0].trim()).filter((s) => s.length > 0);
  } catch {
    return []; // empty repository or git error — style hints are optional
  }
}

/** Render untracked files as `new file` hunks so brand-new work can be described too. */
async function untrackedAsDiff(repo: Repository): Promise<string> {
  const changes = repo.state.untrackedChanges.slice(0, MAX_UNTRACKED_FILES);
  const parts: string[] = [];
  for (const change of changes) {
    const rel = path.relative(repo.rootUri.fsPath, change.uri.fsPath).split(path.sep).join('/');
    try {
      const stat = await vscode.workspace.fs.stat(change.uri);
      if (stat.type !== vscode.FileType.File) continue;
      if (stat.size > MAX_UNTRACKED_FILE_BYTES) {
        parts.push(`diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n(binary or large file, ${stat.size} bytes omitted)`);
        continue;
      }
      const bytes = await vscode.workspace.fs.readFile(change.uri);
      if (bytes.includes(0)) {
        parts.push(`diff --git a/${rel} b/${rel}\nnew file mode 100644\nBinary file (${stat.size} bytes)`);
        continue;
      }
      const content = Buffer.from(bytes).toString('utf8').replace(/\r\n?/g, '\n');
      const lines = content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
      parts.push(
        `diff --git a/${rel} b/${rel}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}`,
      );
    } catch {
      // unreadable file — skip silently
    }
  }
  return parts.join('\n');
}

/**
 * Keep whole per-file chunks while under the budget; list the rest by name only.
 */
export function truncateDiff(diff: string, max: number = MAX_DIFF_CHARS): { text: string; truncated: boolean; files: string[] } {
  const chunks = splitByFile(diff);
  const files = chunks.map((c) => c.file).filter((f): f is string => !!f);
  if (diff.length <= max) return { text: diff, truncated: false, files };

  const kept: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const chunk of chunks) {
    if (used + chunk.text.length <= max) {
      kept.push(chunk.text);
      used += chunk.text.length;
    } else if (kept.length === 0) {
      kept.push(`${chunk.text.slice(0, max)}\n... (truncated)`);
      used = max;
    } else {
      omitted.push(`${chunk.file ?? '(unknown file)'} (${chunk.text.split('\n').length} lines)`);
    }
  }
  const text = omitted.length ? `${kept.join('\n')}\n\n# Omitted from the diff for size:\n${omitted.map((o) => `# - ${o}`).join('\n')}` : kept.join('\n');
  return { text, truncated: true, files };
}

function splitByFile(diff: string): { file: string | undefined; text: string }[] {
  const out: { file: string | undefined; text: string }[] = [];
  const re = /^diff --git a\/(.+?) b\/(.+)$/gm;
  let last = 0;
  let lastFile: string | undefined;
  let m: RegExpExecArray | null;
  while ((m = re.exec(diff))) {
    if (m.index > last || out.length) out.push({ file: lastFile, text: diff.slice(last, m.index).replace(/\n$/, '') });
    last = m.index;
    lastFile = m[2];
  }
  out.push({ file: lastFile, text: diff.slice(last).replace(/\n$/, '') });
  return out.filter((c) => c.text.trim().length > 0);
}

export const COMMIT_SYSTEM_PROMPT = [
  'You write git commit messages for a developer. You receive the diff of the changes to be committed, the branch name and the subjects of recent commits in the repository.',
  '',
  'Output ONLY the commit message text: no markdown, no code fences, no quotes, no preamble such as "Commit message:".',
  '',
  'Format:',
  '- First line: a concise summary of at most 72 characters in the imperative mood ("Add", "Fix", "Refactor"), no trailing period.',
  '- If the recent commits follow Conventional Commits (e.g. "feat(scope): …", "fix: …"), follow that convention; otherwise write a plain summary.',
  '- For non-trivial changes add a blank line and a short body: 2-6 bullet points starting with "- ", wrapped at 72 characters, explaining WHAT changed and WHY. Skip the body for trivial changes.',
  '- Describe the change at the level a reviewer cares about; do not list every file or restate the diff mechanically.',
  '- Do not invent motivation or details that are not visible in the diff.',
].join('\n');

export function buildCommitPrompt(ctx: DiffContext): string {
  const lines: string[] = [];
  if (ctx.branch) lines.push(`Branch: ${ctx.branch}`);
  if (ctx.recentCommits.length) {
    lines.push('Recent commit subjects (for style only):');
    for (const s of ctx.recentCommits) lines.push(`- ${s}`);
  } else {
    lines.push('Recent commits: none (new repository).');
  }
  lines.push(`Changes: ${ctx.kind === 'staged' ? 'staged (index)' : 'working tree (nothing staged)'}${ctx.files.length ? `, ${ctx.files.length} file(s): ${ctx.files.slice(0, 20).join(', ')}${ctx.files.length > 20 ? ', …' : ''}` : ''}`);
  if (ctx.truncated) lines.push('Note: the diff was truncated for size.');
  lines.push('', 'Diff:', ctx.diff);
  return lines.join('\n');
}

export function sanitizeCommitMessage(raw: string): string {
  let text = raw.replace(/\r\n?/g, '\n').trim();
  const fenced = /^```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text);
  if (fenced) text = fenced[1].trim();
  text = text.replace(/^\s*```.*$/gm, '').trim();
  // Leading labels / prose.
  text = text.replace(/^(commit message|here('s| is)( the| a)?( suggested| proposed)? commit message)\s*:?\s*\n+/i, '');
  text = text.replace(/^commit message\s*:\s*/i, '');
  // Whole message wrapped in quotes.
  const quoted = /^(["'`])([\s\S]*)\1$/.exec(text);
  if (quoted) text = quoted[2].trim();
  // Collapse runs of blank lines and trailing whitespace.
  text = text
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  // Keep the summary on its own line.
  const nl = text.indexOf('\n');
  if (nl > 0 && text[nl + 1] !== '\n') text = `${text.slice(0, nl)}\n\n${text.slice(nl + 1)}`;
  return text;
}
