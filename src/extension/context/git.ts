/**
 * Minimal typings for the built-in `vscode.git` extension API (git.d.ts, API v1)
 * plus helpers to obtain the repository for a path and its working-tree diff.
 */
import * as vscode from 'vscode';

export interface GitChange {
  readonly uri: vscode.Uri;
  readonly originalUri: vscode.Uri;
  readonly renameUri: vscode.Uri | undefined;
  readonly status: number;
}
export interface GitBranch {
  readonly name?: string;
  readonly commit?: string;
  readonly upstream?: { readonly remote: string; readonly name: string };
  readonly ahead?: number;
  readonly behind?: number;
}
export interface GitRepositoryState {
  readonly HEAD: GitBranch | undefined;
  readonly workingTreeChanges: GitChange[];
  readonly indexChanges: GitChange[];
  readonly mergeChanges: GitChange[];
  readonly untrackedChanges: GitChange[];
  readonly onDidChange: vscode.Event<void>;
}
export interface GitRepository {
  readonly rootUri: vscode.Uri;
  readonly inputBox: { value: string };
  readonly state: GitRepositoryState;
  diff(cached?: boolean): Promise<string>;
  diffWithHEAD(): Promise<GitChange[]>;
  diffWithHEAD(path: string): Promise<string>;
  show(ref: string, path: string): Promise<string>;
  log(options?: { maxEntries?: number }): Promise<{ hash: string; message: string; authorDate?: Date }[]>;
}
export interface GitApi {
  readonly state: 'uninitialized' | 'initialized';
  readonly onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
  readonly repositories: GitRepository[];
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
  getRepository(uri: vscode.Uri): GitRepository | null;
}
export interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: vscode.Event<boolean>;
  getAPI(version: 1): GitApi;
}

export async function getGitApi(): Promise<GitApi | undefined> {
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) return undefined;
  try {
    const exports = ext.isActive ? ext.exports : await ext.activate();
    if (!exports?.enabled) return undefined;
    const api = exports.getAPI(1);
    if (api.state !== 'initialized') {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          sub.dispose();
          resolve();
        }, 3000);
        const sub = api.onDidChangeState((s) => {
          if (s === 'initialized') {
            clearTimeout(timer);
            sub.dispose();
            resolve();
          }
        });
      });
    }
    return api;
  } catch {
    return undefined;
  }
}

/** Repository containing `fsPath`, or the first repository when `fsPath` is not inside one. */
export async function getRepository(fsPath?: string): Promise<GitRepository | undefined> {
  const api = await getGitApi();
  if (!api) return undefined;
  if (fsPath) {
    const repo = api.getRepository(vscode.Uri.file(fsPath));
    if (repo) return repo;
  }
  return api.repositories[0];
}

export interface WorkingChanges {
  /** Unified diff of staged + unstaged changes and previews of untracked files. */
  diff: string;
  untracked: string[];
  changedFiles: string[];
  branch?: string;
  truncated: boolean;
}

const MAX_DIFF_CHARS = 60_000;

/** Working-tree changes of the repository containing `fsPath` (or the first repo). */
export async function workingChanges(fsPath?: string): Promise<WorkingChanges | undefined> {
  const repo = await getRepository(fsPath);
  if (!repo) return undefined;
  const [staged, unstaged] = await Promise.all([repo.diff(true).catch(() => ''), repo.diff(false).catch(() => '')]);
  const rel = (u: vscode.Uri): string => vscode.workspace.asRelativePath(u, false);
  const untracked = repo.state.untrackedChanges.map((c) => rel(c.uri));
  const changed = new Set<string>();
  for (const c of [...repo.state.indexChanges, ...repo.state.workingTreeChanges, ...repo.state.mergeChanges]) changed.add(rel(c.uri));
  // Untracked files are not part of `git diff`; include short previews so the model sees them.
  let untrackedPreview = '';
  for (const c of repo.state.untrackedChanges.slice(0, 20)) {
    try {
      const stat = await vscode.workspace.fs.stat(c.uri);
      if (stat.type !== vscode.FileType.File || stat.size > 40_000) continue;
      const bytes = await vscode.workspace.fs.readFile(c.uri);
      if (bytes.includes(0)) continue; // binary
      const text = Buffer.from(bytes).toString('utf8');
      const lines = text.replace(/\n$/, '').split('\n');
      untrackedPreview += `diff --git a/${rel(c.uri)} b/${rel(c.uri)}\nnew file mode 100644\n--- /dev/null\n+++ b/${rel(c.uri)}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}\n`;
    } catch {
      /* ignore unreadable */
    }
  }
  let diff = '';
  if (staged.trim()) diff += `# Staged changes\n${staged.trim()}\n\n`;
  if (unstaged.trim()) diff += `# Unstaged changes\n${unstaged.trim()}\n\n`;
  if (untrackedPreview) diff += `# Untracked files\n${untrackedPreview}`;
  let truncated = false;
  if (diff.length > MAX_DIFF_CHARS) {
    diff = `${diff.slice(0, MAX_DIFF_CHARS)}\n… (diff truncated)`;
    truncated = true;
  }
  return { diff: diff.trim(), untracked, changedFiles: [...changed], branch: repo.state.HEAD?.name, truncated };
}
