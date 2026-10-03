/**
 * "New Rule" (command `kursor.rules.new`): asks for a name and a rule type, writes
 * `.cursor/rules/<slug>.mdc` with Cursor's front-matter template and opens it.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import type { Logger } from '../util/log';
import { workspaceFolders } from './workspace';

export type RuleType = 'always' | 'auto' | 'agent' | 'manual';

export interface NewRuleSpec {
  name: string;
  type: RuleType;
  description?: string;
  globs?: string[];
}

/** Lower-case, dash-separated file name stem; never empty. */
export function slugify(name: string): string {
  const slug = name
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/g, '');
  return slug || 'rule';
}

export function parseGlobsInput(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((g) => g.trim())
    .filter((g) => g.length > 0);
}

/** Front matter + body, matching the `.mdc` format `rules/parse.ts` reads. */
export function renderRuleFile(spec: NewRuleSpec): string {
  const title = spec.name.trim() || 'New rule';
  const description = (spec.description ?? '').replace(/\r?\n/g, ' ').trim();
  const globs = (spec.globs ?? []).join(', ');
  const alwaysApply = spec.type === 'always';
  const lines = ['---', `description: ${description}`.trimEnd(), `globs: ${globs}`.trimEnd(), `alwaysApply: ${alwaysApply}`, '---', '', `# ${title}`, ''];
  switch (spec.type) {
    case 'always':
      lines.push('<!-- This rule is attached to every chat and Ctrl+K request in this project. -->');
      break;
    case 'auto':
      lines.push(`<!-- Attached automatically when files matching ${globs || 'the globs above'} are in context. -->`);
      break;
    case 'agent':
      lines.push('<!-- The agent reads this rule when the description above looks relevant to the task. -->');
      break;
    default:
      lines.push(`<!-- Manual rule: attach it with @${slugify(title)} in chat. -->`);
  }
  lines.push('', '- Describe the convention, pattern or constraint here.', '- Keep rules short and concrete; link to files with `@path/to/file` when useful.', '');
  return lines.join('\n');
}

async function uniqueRulePath(dir: string, slug: string): Promise<string> {
  let candidate = path.join(dir, `${slug}.mdc`);
  for (let i = 2; i < 100; i++) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(candidate));
      candidate = path.join(dir, `${slug}-${i}.mdc`);
    } catch {
      return candidate;
    }
  }
  return path.join(dir, `${slug}-${Date.now().toString(36)}.mdc`);
}

async function pickFolder(preferred?: string): Promise<string | undefined> {
  const folders = workspaceFolders();
  if (folders.length === 0) {
    void vscode.window.showErrorMessage('Open a folder first — project rules live in <folder>/.cursor/rules.');
    return undefined;
  }
  if (preferred && folders.some((f) => f.path === preferred)) return preferred;
  if (folders.length === 1) return folders[0].path;
  const pick = await vscode.window.showQuickPick(
    folders.map((f) => ({ label: f.name, description: f.path, path: f.path })),
    { title: 'New Kursor Rule — which folder?', placeHolder: 'Workspace folder' },
  );
  return pick?.path;
}

interface RuleTypeItem extends vscode.QuickPickItem {
  type: RuleType;
}

const RULE_TYPES: RuleTypeItem[] = [
  { type: 'always', label: '$(pinned) Always', description: 'Always included in the model context' },
  { type: 'auto', label: '$(files) Auto Attached', description: 'Included when files matching a glob pattern are referenced' },
  { type: 'agent', label: '$(hubot) Agent Requested', description: 'Available to the agent, which decides whether to include it (needs a description)' },
  { type: 'manual', label: '$(mention) Manual', description: 'Only included when explicitly mentioned with @ruleName' },
];

/**
 * Interactive flow: name → type → (description | globs) → write + open.
 * Returns the created file path, or undefined when the user cancelled.
 */
export async function createNewRuleInteractive(log: Logger, preferredCwd?: string): Promise<string | undefined> {
  const cwd = await pickFolder(preferredCwd);
  if (!cwd) return undefined;

  const name = await vscode.window.showInputBox({
    title: 'New Kursor Rule',
    prompt: 'Rule name (becomes .cursor/rules/<name>.mdc)',
    placeHolder: 'e.g. React components',
    validateInput: (v) => (v.trim().length === 0 ? 'Enter a name' : v.length > 120 ? 'Keep it under 120 characters' : undefined),
    ignoreFocusOut: true,
  });
  if (name === undefined || !name.trim()) return undefined;

  const typePick = await vscode.window.showQuickPick(RULE_TYPES, { title: `New Kursor Rule — "${name.trim()}"`, placeHolder: 'Rule type', ignoreFocusOut: true });
  if (!typePick) return undefined;

  let description: string | undefined;
  let globs: string[] | undefined;
  if (typePick.type === 'auto') {
    const globsText = await vscode.window.showInputBox({
      title: 'New Kursor Rule — file patterns',
      prompt: 'Comma-separated globs that attach this rule automatically',
      placeHolder: 'src/components/**/*.tsx, *.css',
      validateInput: (v) => (parseGlobsInput(v).length === 0 ? 'Enter at least one glob' : undefined),
      ignoreFocusOut: true,
    });
    if (globsText === undefined) return undefined;
    globs = parseGlobsInput(globsText);
  }
  if (typePick.type === 'agent' || typePick.type === 'auto') {
    const desc = await vscode.window.showInputBox({
      title: 'New Kursor Rule — description',
      prompt: typePick.type === 'agent' ? 'One line the agent uses to decide when this rule is relevant' : 'Optional one-line description',
      placeHolder: typePick.type === 'agent' ? 'Conventions for writing React components' : '',
      validateInput: (v) => (typePick.type === 'agent' && v.trim().length === 0 ? 'Agent-requested rules need a description' : undefined),
      ignoreFocusOut: true,
    });
    if (desc === undefined) return undefined;
    description = desc.trim() || undefined;
  }
  // Always-rules carry their name as description; manual rules must stay description-less (that is what makes them manual).
  if (description === undefined && typePick.type === 'always') description = name.trim();

  const dir = path.join(cwd, '.cursor', 'rules');
  await vscode.workspace.fs.createDirectory(vscode.Uri.file(dir));
  const target = await uniqueRulePath(dir, slugify(name));
  const content = renderRuleFile({ name: name.trim(), type: typePick.type, description, globs });
  await vscode.workspace.fs.writeFile(vscode.Uri.file(target), Buffer.from(content, 'utf8'));
  log.info(`created rule ${target}`);

  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  // Put the cursor on the first bullet so the user can start typing straight away.
  const firstBullet = doc.getText().indexOf('- Describe');
  if (firstBullet >= 0) {
    const pos = doc.positionAt(firstBullet);
    const end = doc.lineAt(pos.line).range.end;
    editor.selection = new vscode.Selection(pos.translate(0, 2), end);
    editor.revealRange(new vscode.Range(pos, end));
  }
  return target;
}
