/**
 * EditTracker — records the files Claude Code edits (via the bridge's
 * PreToolUse/PostToolUse snapshots), and offers Cursor-style review:
 *   Keep (accept) · Undo (restore base) · Review (diff editor), per file / all,
 *   plus per-hunk Keep/Undo through CodeLens when `kursor.agent.inlineDiffs` is on.
 *
 * Also owns: all `kursor.edits.*` commands, the `kursor.hasPendingEdits`
 * context key, the "$(diff-multiple) N files · Review" status bar item and
 * persistence of pending snapshots in workspaceState (so a reload keeps the
 * review state).
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import type { EditSummary } from '../../shared/protocol';
import type { BaseDeps, EditResolution, EditTracker, FileChange } from '../services';
import { EditDecorations } from './decorations';
import { applyHunkForward, computeHunks, endsWithNewline, lineStats, minimalReplacement, revertHunk, type TrackedFile } from './model';
import { ORIG_SCHEME, OrigContentProvider } from './origProvider';

const STORAGE_KEY = 'kursor.edits.v1';
const MAX_PERSIST_FILE = 512 * 1024;
const MAX_PERSIST_TOTAL = 4 * 1024 * 1024;

function relPath(fsPath: string): string {
  return vscode.workspace.asRelativePath(fsPath, false).split(path.sep).join('/');
}

/**
 * Canonical key for a file: the form `vscode.Uri.fsPath` produces (normalised separators,
 * lower-case drive letter on Windows). Paths reported by the Claude Code hooks may differ from
 * the editor's (`C:\Users\…` vs `c:\Users\…`), and the editor-title buttons compare
 * `resourcePath` against `kursor.pendingEditPaths` as exact strings.
 */
function canonical(fsPath: string): string {
  try {
    return vscode.Uri.file(path.normalize(fsPath)).fsPath;
  } catch {
    return path.normalize(fsPath);
  }
}

export function createEditTracker(context: vscode.ExtensionContext, deps: BaseDeps): EditTracker {
  const { log } = deps;
  const files = new Map<string, TrackedFile>();
  const changeEmitter = new vscode.EventEmitter<void>();
  const resolveEmitter = new vscode.EventEmitter<EditResolution>();
  const disposables: vscode.Disposable[] = [resolveEmitter];
  const lookup = (fsPath: string): TrackedFile | undefined => files.get(canonical(fsPath));

  const orig = new OrigContentProvider(lookup);
  disposables.push(orig, vscode.workspace.registerTextDocumentContentProvider(ORIG_SCHEME, orig));

  const status = vscode.window.createStatusBarItem('kursor.edits', vscode.StatusBarAlignment.Left, 40);
  status.name = 'Kursor edits';
  status.command = 'kursor.edits.reviewAll';
  disposables.push(status);

  const decorations = new EditDecorations(lookup, (doc) => syncFromDocument(doc));
  disposables.push(decorations);
  const readInlineDiffs = (): boolean => vscode.workspace.getConfiguration('kursor').get<boolean>('agent.inlineDiffs', true);
  decorations.setEnabled(readInlineDiffs());
  disposables.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('kursor.agent.inlineDiffs')) decorations.setEnabled(readInlineDiffs());
    }),
  );

  // ---- persistence -------------------------------------------------------
  let persistTimer: NodeJS.Timeout | undefined;
  const persist = (): void => {
    if (persistTimer) clearTimeout(persistTimer);
    persistTimer = setTimeout(() => {
      persistTimer = undefined;
      let total = 0;
      const out: TrackedFile[] = [];
      for (const f of files.values()) {
        const size = (f.base?.length ?? 0) + (f.current?.length ?? 0);
        if (size > MAX_PERSIST_FILE || total + size > MAX_PERSIST_TOTAL) continue;
        total += size;
        out.push(f);
      }
      void context.workspaceState.update(STORAGE_KEY, out.length ? out : undefined).then(undefined, (err: unknown) => log.warn('persist failed', err));
    }, 500);
  };
  const restore = (): void => {
    const saved = context.workspaceState.get<TrackedFile[]>(STORAGE_KEY);
    if (!Array.isArray(saved)) return;
    for (const f of saved) {
      if (f && typeof f.path === 'string' && typeof f.chatId === 'string') {
        const key = canonical(f.path);
        files.set(key, { ...f, path: key, toolUseIds: Array.isArray(f.toolUseIds) ? f.toolUseIds : [] });
      }
    }
    if (files.size) log.info(`restored ${files.size} pending agent edit(s)`);
  };

  // ---- state helpers -------------------------------------------------------
  const fire = (): void => {
    const n = files.size;
    void vscode.commands.executeCommand('setContext', 'kursor.hasPendingEdits', n > 0);
    // Editor-title Keep/Undo/Review buttons use `resourcePath in kursor.pendingEditPaths`.
    void vscode.commands.executeCommand('setContext', 'kursor.pendingEditPaths', [...files.keys()]);
    if (n > 0) {
      status.text = `$(diff-multiple) ${n} file${n === 1 ? '' : 's'} · Review`;
      status.tooltip = `Kursor edited ${n} file${n === 1 ? '' : 's'} — click to review (Keep All: Ctrl+Enter in chat)`;
      status.show();
    } else status.hide();
    decorations.refreshAll();
    persist();
    changeEmitter.fire();
  };

  /** Stop tracking a file and tell listeners (chat tool rows) how it was resolved. */
  const forget = (rawPath: string, status: EditResolution['status']): void => {
    const fsPath = canonical(rawPath);
    if (!files.delete(fsPath)) return;
    void closeReviewTabs(fsPath);
    resolveEmitter.fire({ path: fsPath, status });
  };

  const summaryOf = (f: TrackedFile): EditSummary => {
    const stats = lineStats(f.base, f.current);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === f.path);
    return {
      path: f.path,
      relPath: relPath(f.path),
      additions: stats.additions,
      deletions: stats.deletions,
      isNew: f.base === null,
      isDeleted: f.current === null,
      status: 'pending',
      hunks: open ? computeHunks(f.base ?? '', open.getText()).length : computeHunks(f.base ?? '', f.current ?? '').length,
    };
  };

  /** The user (or the agent again) changed a tracked document: update `current`; drop when back at base. */
  function syncFromDocument(doc: vscode.TextDocument): void {
    const f = files.get(doc.uri.fsPath);
    if (!f) return;
    const text = doc.getText();
    if (text === f.current) return;
    f.current = text;
    f.updatedAt = Date.now();
    if (f.base !== null && text === f.base) forget(f.path, 'undone');
    fire();
  }

  async function closeReviewTabs(fsPath?: string): Promise<void> {
    const toClose: vscode.Tab[] = [];
    for (const group of vscode.window.tabGroups.all) {
      for (const tab of group.tabs) {
        const input = tab.input;
        if (input instanceof vscode.TabInputTextDiff && input.original.scheme === ORIG_SCHEME && (!fsPath || input.modified.fsPath === fsPath || input.original.path === fsPath)) toClose.push(tab);
      }
    }
    if (toClose.length) await vscode.window.tabGroups.close(toClose, true).then(undefined, () => undefined);
  }

  async function writeFile(fsPath: string, content: string): Promise<void> {
    const uri = vscode.Uri.file(fsPath);
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === fsPath);
    if (doc) {
      const full = new vscode.Range(0, 0, doc.lineCount, 0);
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, doc.validateRange(full), content);
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) throw new Error(`Could not edit ${relPath(fsPath)}`);
      await doc.save();
    } else {
      await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(fsPath)));
      await vscode.workspace.fs.writeFile(uri, Buffer.from(content, 'utf8'));
    }
  }

  async function undoFile(f: TrackedFile): Promise<void> {
    if (f.base === null) {
      // New file: delete it.
      await closeReviewTabs(f.path);
      try {
        await vscode.workspace.fs.delete(vscode.Uri.file(f.path), { useTrash: false });
      } catch (err) {
        if (!(err instanceof vscode.FileSystemError && err.code === 'FileNotFound')) throw err;
      }
    } else {
      await writeFile(f.path, f.base);
    }
    forget(f.path, 'undone');
  }

  // ---- public API ---------------------------------------------------------------
  const tracker: EditTracker = {
    recordChange(chatId: string, change: FileChange): void {
      if (change.before === change.after) return;
      const key = canonical(change.path);
      const existing = files.get(key);
      if (existing) {
        existing.current = change.after;
        existing.updatedAt = Date.now();
        if (!existing.toolUseIds.includes(change.toolUseId)) existing.toolUseIds.push(change.toolUseId);
        existing.chatId = chatId;
        if (existing.base !== null && existing.current === existing.base) forget(key, 'undone');
      } else {
        files.set(key, {
          path: key,
          base: change.before,
          current: change.after,
          chatId,
          toolUseIds: [change.toolUseId],
          version: 1,
          updatedAt: Date.now(),
        });
      }
      fire();
    },

    pending(chatId?: string): EditSummary[] {
      const out: EditSummary[] = [];
      for (const f of files.values()) if (!chatId || f.chatId === chatId) out.push(summaryOf(f));
      return out.sort((a, b) => a.relPath.localeCompare(b.relPath));
    },

    async keep(fsPath?: string): Promise<void> {
      if (fsPath) forget(canonical(fsPath), 'kept');
      else for (const p of [...files.keys()]) forget(p, 'kept');
      fire();
    },

    async undo(fsPath?: string): Promise<void> {
      const targets = fsPath ? [files.get(canonical(fsPath))].filter((f): f is TrackedFile => !!f) : [...files.values()];
      const errors: string[] = [];
      for (const f of targets) {
        try {
          await undoFile(f);
        } catch (err) {
          errors.push(`${relPath(f.path)}: ${err instanceof Error ? err.message : String(err)}`);
          log.error(`undo failed for ${f.path}`, err);
        }
      }
      fire();
      if (errors.length) throw new Error(`Could not undo ${errors.length} file(s):\n${errors.join('\n')}`);
    },

    async review(fsPath?: string): Promise<void> {
      if (fsPath) {
        const f = files.get(canonical(fsPath));
        if (!f) {
          void vscode.window.showInformationMessage(`No pending Kursor edits in ${relPath(fsPath)}.`);
          return;
        }
        const left = OrigContentProvider.uriFor(f);
        const right = f.current === null ? OrigContentProvider.emptyUriFor(f.path) : vscode.Uri.file(f.path);
        const name = path.basename(f.path);
        const title = f.base === null ? `${name} (New file by Kursor)` : f.current === null ? `${name} (Deleted by Kursor)` : `${name} (Original ↔ Kursor)`;
        await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true, preserveFocus: false });
        return;
      }
      if (!files.size) {
        void vscode.window.showInformationMessage('No pending Kursor edits.');
        return;
      }
      const list: [vscode.Uri, vscode.Uri | undefined, vscode.Uri | undefined][] = [];
      for (const f of [...files.values()].sort((a, b) => a.path.localeCompare(b.path))) {
        const fileUri = vscode.Uri.file(f.path);
        list.push([fileUri, f.base === null ? undefined : OrigContentProvider.uriFor(f), f.current === null ? undefined : fileUri]);
      }
      try {
        await vscode.commands.executeCommand('vscode.changes', 'Kursor edits', list);
      } catch (err) {
        log.warn('vscode.changes failed, falling back to per-file diff', err);
        const first = [...files.keys()][0];
        if (first) await tracker.review(first);
      }
    },

    clear(chatId?: string): void {
      // Used after a checkpoint restore (files are back at base) and when a chat closes.
      for (const f of [...files.values()]) if (!chatId || f.chatId === chatId) forget(f.path, 'undone');
      fire();
    },

    onDidChange: changeEmitter.event,
    onDidResolve: resolveEmitter.event,

    dispose(): void {
      if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = undefined;
      }
      status.dispose();
      changeEmitter.dispose();
      for (const d of disposables) d.dispose();
    },
  };

  // ---- per-hunk commands ---------------------------------------------------------
  async function keepHunk(rawPath: string, index: number): Promise<void> {
    const fsPath = canonical(rawPath);
    const f = files.get(fsPath);
    if (!f) return;
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === fsPath);
    const current = doc ? doc.getText() : (f.current ?? '');
    const hunks = computeHunks(f.base ?? '', current);
    const h = hunks[index];
    if (!h) return;
    const newBase = applyHunkForward(f.base ?? '', h, endsWithNewline(current));
    f.base = newBase;
    f.current = current;
    f.version += 1;
    f.updatedAt = Date.now();
    orig.refresh(f);
    if (newBase === current) forget(fsPath, 'kept');
    fire();
  }

  async function undoHunk(rawPath: string, index: number): Promise<void> {
    const fsPath = canonical(rawPath);
    const f = files.get(fsPath);
    if (!f) return;
    const uri = vscode.Uri.file(fsPath);
    const doc = await vscode.workspace.openTextDocument(uri);
    const current = doc.getText();
    const hunks = computeHunks(f.base ?? '', current);
    const h = hunks[index];
    if (!h) return;
    const reverted = revertHunk(current, h, f.base === null ? false : endsWithNewline(f.base));
    const rep = minimalReplacement(current, reverted);
    if (rep) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(doc.positionAt(rep.start), doc.positionAt(rep.end)), rep.text);
      const ok = await vscode.workspace.applyEdit(edit);
      if (!ok) throw new Error('Could not apply the undo edit');
      await doc.save();
    }
    f.current = doc.getText();
    f.updatedAt = Date.now();
    if (f.base !== null && f.current === f.base) forget(fsPath, 'undone');
    fire();
  }

  const uriArg = (arg: unknown): string | undefined => {
    if (arg instanceof vscode.Uri) return arg.scheme === 'file' ? arg.fsPath : undefined;
    if (typeof arg === 'string') return canonical(arg);
    const ed = vscode.window.activeTextEditor;
    return ed && ed.document.uri.scheme === 'file' ? ed.document.uri.fsPath : undefined;
  };

  const wrap = (name: string, fn: (...args: unknown[]) => Promise<void> | void) =>
    vscode.commands.registerCommand(name, async (...args: unknown[]) => {
      try {
        await fn(...args);
      } catch (err) {
        log.error(`${name} failed`, err);
        void vscode.window.showErrorMessage(`Kursor: ${err instanceof Error ? err.message : String(err)}`);
      }
    });

  disposables.push(
    wrap('kursor.edits.keepAll', async () => {
      const n = files.size;
      await tracker.keep();
      if (n) vscode.window.setStatusBarMessage(`Kursor: kept edits in ${n} file${n === 1 ? '' : 's'}`, 3000);
    }),
    wrap('kursor.edits.undoAll', async () => {
      const n = files.size;
      if (!n) return;
      await tracker.undo();
      vscode.window.setStatusBarMessage(`Kursor: reverted ${n} file${n === 1 ? '' : 's'}`, 3000);
    }),
    wrap('kursor.edits.reviewAll', () => tracker.review()),
    wrap('kursor.edits.keepFile', async (arg) => {
      const p = uriArg(arg);
      if (p) await tracker.keep(p);
    }),
    wrap('kursor.edits.undoFile', async (arg) => {
      const p = uriArg(arg);
      if (p) await tracker.undo(p);
    }),
    wrap('kursor.edits.reviewFile', async (arg) => {
      const p = uriArg(arg);
      if (p) await tracker.review(p);
    }),
    wrap('kursor.edits.keepHunk', async (fsPath, index) => {
      if (typeof fsPath === 'string' && typeof index === 'number') await keepHunk(fsPath, index);
    }),
    wrap('kursor.edits.undoHunk', async (fsPath, index) => {
      if (typeof fsPath === 'string' && typeof index === 'number') await undoHunk(fsPath, index);
    }),
    // Files deleted outside our control stop being reviewable.
    vscode.workspace.onDidDeleteFiles((e) => {
      let changed = false;
      for (const uri of e.files) {
        const deleted = canonical(uri.fsPath);
        for (const p of [...files.keys()]) {
          if (p === deleted || p.startsWith(deleted.endsWith(path.sep) ? deleted : deleted + path.sep)) {
            const f = files.get(p);
            if (f && f.base === null) {
              forget(p, 'undone');
              changed = true;
            } else if (f) {
              f.current = null;
              changed = true;
            }
          }
        }
      }
      if (changed) fire();
    }),
  );

  restore();
  context.subscriptions.push(tracker);
  fire();
  return tracker;
}
