/**
 * Workspace helpers for the settings panel: which folder the Rules / Indexing tabs look at,
 * and the `.cursorignore` / `.gitignore` open-or-create actions.
 */
import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import type { WorkspaceInfo } from '../../shared/settingsProtocol';
import { isInside, samePath } from '../util/platform';

export const CURSORIGNORE_TEMPLATE = `# .cursorignore — files and folders Kursor should leave out of @-mention search and context.
# Same syntax as .gitignore. Kursor also honours .gitignore automatically.
#
# Examples:
# dist/
# coverage/
# *.min.js
# secrets/
`;

export function workspaceFolders(): { name: string; path: string }[] {
  return (vscode.workspace.workspaceFolders ?? []).filter((f) => f.uri.scheme === 'file').map((f) => ({ name: f.name, path: f.uri.fsPath }));
}

/** Folder of the active file when it is inside the workspace, else the first folder. */
export function defaultCwd(): string | undefined {
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && active.scheme === 'file') {
    const folder = vscode.workspace.getWorkspaceFolder(active);
    if (folder && folder.uri.scheme === 'file') return folder.uri.fsPath;
  }
  return workspaceFolders()[0]?.path;
}

export function isWorkspaceFolderPath(p: string): boolean {
  return workspaceFolders().some((f) => samePath(f.path, p));
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const stat = await vscode.workspace.fs.stat(vscode.Uri.file(p));
    return (stat.type & vscode.FileType.File) !== 0;
  } catch {
    return false;
  }
}

export async function readWorkspaceInfo(cwd: string | undefined): Promise<WorkspaceInfo> {
  const folders = workspaceFolders();
  const effectiveCwd = cwd && folders.some((f) => samePath(f.path, cwd)) ? cwd : defaultCwd();
  if (!effectiveCwd) return { folders, cwd: undefined, cursorignore: null, gitignore: null };
  const cursorignorePath = path.join(effectiveCwd, '.cursorignore');
  const gitignorePath = path.join(effectiveCwd, '.gitignore');
  const [cursorignoreExists, gitignoreExists] = await Promise.all([fileExists(cursorignorePath), fileExists(gitignorePath)]);
  return {
    folders,
    cwd: effectiveCwd,
    cursorignore: { path: cursorignorePath, exists: cursorignoreExists },
    gitignore: { path: gitignorePath, exists: gitignoreExists },
  };
}

/** Open `<cwd>/.cursorignore`, creating it from the template when missing. Returns true when it was created. */
export async function openOrCreateCursorignore(cwd: string): Promise<boolean> {
  const target = vscode.Uri.file(path.join(cwd, '.cursorignore'));
  let created = false;
  if (!(await fileExists(target.fsPath))) {
    await vscode.workspace.fs.writeFile(target, Buffer.from(CURSORIGNORE_TEMPLATE, 'utf8'));
    created = true;
  }
  const doc = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(doc, { preview: false });
  return created;
}

export async function openGitignore(cwd: string): Promise<void> {
  const target = vscode.Uri.file(path.join(cwd, '.gitignore'));
  if (!(await fileExists(target.fsPath))) {
    const pick = await vscode.window.showInformationMessage('This folder has no .gitignore yet. Create one?', { modal: false }, 'Create');
    if (pick !== 'Create') return;
    await vscode.workspace.fs.writeFile(target, Buffer.from('# Files git (and Kursor) should ignore\n', 'utf8'));
  }
  const doc = await vscode.workspace.openTextDocument(target);
  await vscode.window.showTextDocument(doc, { preview: false });
}

/** Open any file path from the panel; only paths inside a workspace folder or the home directory are honoured. */
export async function openPathFromPanel(p: string): Promise<void> {
  if (!path.isAbsolute(p)) throw new Error(`Refusing to open a relative path: ${p}`);
  const resolved = path.resolve(p);
  const allowedRoots = [...workspaceFolders().map((f) => f.path), os.homedir()].filter(Boolean);
  const inside = allowedRoots.some((root) => isInside(resolved, root));
  if (!inside) throw new Error(`Refusing to open a path outside the workspace: ${p}`);
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(resolved));
  await vscode.window.showTextDocument(doc, { preview: false });
}
