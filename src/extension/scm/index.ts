/**
 * [D2] Commit message generation — `kursor.scm.generateCommitMessage`
 * (the $(sparkle) button in the Source Control title bar).
 *
 * Uses the built-in `vscode.git` extension API (typings in git.d.ts):
 * staged diff → else working-tree diff (+ untracked files rendered as new-file
 * hunks) → truncated to 60 kB → oneShot (model `kursor.commit.model`) →
 * `repo.inputBox.value`. Progress is shown in the SCM view.
 */
import * as vscode from 'vscode';
import type { BridgeDeps } from '../services';
import type { API, GitExtension, Repository } from './git';
import { COMMIT_SYSTEM_PROMPT, buildCommitPrompt, collectDiff, sanitizeCommitMessage } from './commitMessage';

const REQUEST_TIMEOUT_MS = 120_000;

export function registerScm(context: vscode.ExtensionContext, deps: BridgeDeps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('kursor.scm.generateCommitMessage', async (arg?: unknown) => {
      try {
        await generateCommitMessage(deps, arg);
      } catch (e) {
        if (isAbortError(e)) return;
        deps.log.error('kursor.scm.generateCommitMessage failed', e);
        const pick = await vscode.window.showErrorMessage(
          `Kursor: could not generate a commit message — ${e instanceof Error ? e.message : String(e)}`,
          'Show Logs',
        );
        if (pick === 'Show Logs') deps.log.show();
      }
    }),
  );
  deps.log.info('commit message generation registered');
}

async function generateCommitMessage(deps: BridgeDeps, arg: unknown): Promise<void> {
  const { bridge, log } = deps;
  const api = await getGitApi();
  const repo = await pickRepository(api, arg);
  if (!repo) {
    void vscode.window.showInformationMessage('Kursor: no git repository is open.');
    return;
  }

  const ctx = await collectDiff(repo);
  if (!ctx) {
    void vscode.window.showInformationMessage('Kursor: no changes to describe. Stage or modify files first.');
    return;
  }
  const model = (vscode.workspace.getConfiguration('kursor.commit').get<string>('model', 'sonnet') || 'sonnet').trim();
  log.info(`commit message: ${ctx.kind} diff, ${ctx.files.length} file(s), ${ctx.diff.length} chars${ctx.truncated ? ' (truncated)' : ''}, model=${model}`);

  const message = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.SourceControl, title: 'Kursor: generating commit message…' },
    async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      try {
        const raw = await bridge.oneShot({
          systemPrompt: COMMIT_SYSTEM_PROMPT,
          prompt: buildCommitPrompt(ctx),
          model,
          cwd: repo.rootUri.fsPath,
          signal: controller.signal,
          maxTurns: 1,
        });
        return sanitizeCommitMessage(raw);
      } catch (e) {
        if (controller.signal.aborted) throw new Error(`timed out after ${REQUEST_TIMEOUT_MS / 1000} s`);
        throw e;
      } finally {
        clearTimeout(timer);
      }
    },
  );

  if (!message) {
    void vscode.window.showWarningMessage('Kursor: the model returned an empty commit message.');
    return;
  }
  repo.inputBox.value = message;
  log.info(`commit message set (${message.split('\n')[0]})`);
  // Bring the SCM view forward so the user sees the result where they can edit it.
  await vscode.commands.executeCommand('workbench.view.scm');
}

async function getGitApi(): Promise<API> {
  const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
  if (!ext) throw new Error('the built-in Git extension is not available');
  const exports = ext.isActive ? ext.exports : await ext.activate();
  if (!exports?.enabled) throw new Error('Git is disabled (`git.enabled`)');
  const api = exports.getAPI(1);
  if (api.state !== 'initialized') {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        sub.dispose();
        resolve();
      }, 5000);
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
}

/** scm/title passes the SourceControl; otherwise use the active file's repo, the only repo, or ask. */
async function pickRepository(api: API, arg: unknown): Promise<Repository | undefined> {
  const repos = api.repositories;
  if (repos.length === 0) return undefined;

  const rootUri = sourceControlRoot(arg);
  if (rootUri) {
    const match = repos.find((r) => r.rootUri.fsPath === rootUri.fsPath);
    if (match) return match;
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active && active.scheme === 'file') {
    const byFile = api.getRepository(active);
    if (byFile) return byFile;
  }
  if (repos.length === 1) return repos[0];

  const picked = await vscode.window.showQuickPick(
    repos.map((r) => ({
      label: vscode.workspace.asRelativePath(r.rootUri, true) || r.rootUri.fsPath,
      description: r.state.HEAD?.name,
      detail: `${r.state.indexChanges.length} staged · ${r.state.workingTreeChanges.length} changed · ${r.state.untrackedChanges.length} untracked`,
      repo: r,
    })),
    { title: 'Kursor: which repository?', placeHolder: 'Generate a commit message for…' },
  );
  return picked?.repo;
}

function sourceControlRoot(arg: unknown): vscode.Uri | undefined {
  if (!arg || typeof arg !== 'object') return undefined;
  const root = (arg as { rootUri?: unknown }).rootUri;
  return root instanceof vscode.Uri ? root : undefined;
}

function isAbortError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  return (e as { name?: unknown }).name === 'AbortError';
}
