/**
 * `openDiff` flow for the IDE bridge: shows `vscode.diff(left, right, tab_name)` with both sides
 * served by in-memory FileSystemProviders (`kursor-ide-left` read-only, `kursor-ide-right`
 * editable) and resolves when the user decides:
 *   - accept (editor/title button `kursor.ide.acceptDiff`, or saving the right side while
 *     `files.autoSave` is off)             → { kind: 'saved', contents }   (CLI gets FILE_SAVED)
 *   - reject (`kursor.ide.rejectDiff`, closing the tab, client disconnect, request cancelled)
 *                                          → { kind: 'rejected', tabName } (CLI gets DIFF_REJECTED)
 * Accepted edits are also recorded in the EditTracker so Keep/Undo/Review work like chat edits.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { EditTracker } from '../services';
import type { Logger } from '../util/log';
import { MemoryFileSystemProvider } from './memoryFs';

export const LEFT_SCHEME = 'kursor-ide-left';
export const RIGHT_SCHEME = 'kursor-ide-right';
export const VIEWING_DIFF_CONTEXT = 'kursor.ide.viewingDiff';
/** Synthetic chat id used when recording accepted diffs in the EditTracker. */
export const IDE_EDIT_CHAT_ID = 'ide';

export interface OpenDiffArgs {
  oldFilePath: string;
  newFilePath: string;
  newFileContents: string;
  tabName: string;
}

export type DiffOutcome = { kind: 'saved'; contents: string } | { kind: 'rejected'; tabName: string };

interface DiffSession {
  id: number;
  tabName: string;
  leftUri: vscode.Uri;
  rightUri: vscode.Uri;
  /** Absolute path of the file the CLI will write on accept. */
  newFilePath: string;
  /** On-disk contents of `newFilePath` when the diff was opened (null = file did not exist). */
  beforeOnDisk: string | null;
  /** Save on the right side counts as accept only while VS Code auto-save is off. */
  saveMeansAccept: boolean;
  latest: string;
  previous: string;
  /** Guard against VS Code "revert on close": many changes right before a save → use the pre-storm text. */
  undoStorm?: { time: number; contents: string };
  settled: boolean;
  resolve: (outcome: DiffOutcome) => void;
  disposables: vscode.Disposable[];
}

const TAB_APPEAR_TIMEOUT_MS = 1500;
const TAB_POLL_MS = 50;
const UNDO_STORM_WINDOW_MS = 500;
const TYPE_GUARD_MS = 1000;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolveWorkspacePath(p: string): string {
  if (path.isAbsolute(p)) return p;
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return root ? path.join(root, p) : path.resolve(p);
}

function isOurDiffTab(tab: vscode.Tab): tab is vscode.Tab & { input: vscode.TabInputTextDiff } {
  return tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.scheme === RIGHT_SCHEME;
}

function allTabs(): vscode.Tab[] {
  return vscode.window.tabGroups.all.flatMap((group) => group.tabs);
}

export class IdeDiffManager implements vscode.Disposable {
  private readonly left = new MemoryFileSystemProvider(LEFT_SCHEME);
  private readonly right = new MemoryFileSystemProvider(RIGHT_SCHEME);
  /** Pending sessions keyed by `rightUri.toString()`. */
  private readonly sessions = new Map<string, DiffSession>();
  private readonly disposables: vscode.Disposable[] = [];
  private seq = 0;
  private lastContextValue: boolean | undefined;
  private typeGuard: vscode.Disposable | undefined;
  private typeGuardTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly log: Logger,
    private readonly edits: EditTracker | undefined,
  ) {
    this.disposables.push(
      this.left,
      this.right,
      vscode.workspace.registerFileSystemProvider(LEFT_SCHEME, this.left, { isCaseSensitive: true, isReadonly: true }),
      vscode.workspace.registerFileSystemProvider(RIGHT_SCHEME, this.right, { isCaseSensitive: true }),
      vscode.window.onDidChangeVisibleTextEditors(() => this.updateContext()),
      vscode.window.tabGroups.onDidChangeTabs((e) => this.onTabsChanged(e)),
      vscode.workspace.onDidChangeTextDocument((e) => this.onDocumentChanged(e)),
      vscode.workspace.onWillSaveTextDocument((e) => this.onWillSave(e)),
    );
    this.updateContext();
  }

  get pendingCount(): number {
    return this.sessions.size;
  }

  // ---- tool entry points --------------------------------------------------------------------

  async openDiff(args: OpenDiffArgs, signal?: AbortSignal): Promise<DiffOutcome> {
    const oldFilePath = resolveWorkspacePath(args.oldFilePath);
    const newFilePath = resolveWorkspacePath(args.newFilePath);
    const id = ++this.seq;
    this.log.info(`openDiff #${id}: ${oldFilePath} → ${newFilePath} as "${args.tabName}"`);

    const original = await readFileOrNull(oldFilePath);
    const beforeOnDisk = oldFilePath === newFilePath ? original : await readFileOrNull(newFilePath);
    const leftUri = this.left.uriFor(oldFilePath, id);
    const rightUri = this.right.uriFor(newFilePath, id);
    this.left.createFile(leftUri, original ?? '');
    this.right.createFile(rightUri, args.newFileContents);

    // A previous proposal for the same file is superseded (its request resolves DIFF_REJECTED).
    const closedPrevious = await this.closeTabsWhere((tab) => isOurDiffTab(tab) && tab.input.modified.fsPath === newFilePath);
    if (closedPrevious > 0) await delay(200);

    const session: DiffSession = {
      id,
      tabName: args.tabName,
      leftUri,
      rightUri,
      newFilePath,
      beforeOnDisk,
      saveMeansAccept: vscode.workspace.getConfiguration('files').get<string>('autoSave', 'off') === 'off',
      latest: args.newFileContents,
      previous: args.newFileContents,
      settled: false,
      resolve: () => undefined,
      disposables: [],
    };
    const outcome = new Promise<DiffOutcome>((resolve) => {
      session.resolve = (o) => {
        if (session.settled) return;
        session.settled = true;
        this.log.info(`openDiff #${id}: ${o.kind}`);
        resolve(o);
      };
    });
    const key = rightUri.toString();
    this.sessions.set(key, session);

    if (signal) {
      const onAbort = (): void => session.resolve({ kind: 'rejected', tabName: session.tabName });
      if (signal.aborted) onAbort();
      else {
        signal.addEventListener('abort', onAbort, { once: true });
        session.disposables.push(new vscode.Disposable(() => signal.removeEventListener('abort', onAbort)));
      }
    }

    try {
      await vscode.workspace.openTextDocument(rightUri);
      this.installTypeGuard(rightUri);
      await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, args.tabName, { preview: false } satisfies vscode.TextDocumentShowOptions);
      const tab = await this.waitForTab(rightUri, TAB_APPEAR_TIMEOUT_MS);
      if (!tab) throw new Error(`Failed to open the diff tab "${args.tabName}"`);
    } catch (err) {
      this.sessions.delete(key);
      this.cleanupFiles(session);
      this.updateContext();
      throw err;
    }
    this.updateContext();

    const result = await outcome;
    await this.finishSession(session);
    if (result.kind === 'saved') this.recordAcceptedEdit(session, result.contents);
    return result;
  }

  /** `close_tab`: closes the first tab whose label equals `tabName` (any editor kind). */
  async closeTab(tabName: string): Promise<boolean> {
    for (const tab of allTabs()) {
      if (tab.label === tabName) {
        await this.closeOne(tab);
        return true;
      }
    }
    this.log.debug(`close_tab: no tab labelled "${tabName}"`);
    return false;
  }

  /** `closeAllDiffTabs`: closes every diff tab served by the IDE bridge. Returns the count. */
  async closeAllDiffTabs(): Promise<number> {
    return this.closeTabsWhere(isOurDiffTab);
  }

  // ---- commands -----------------------------------------------------------------------------

  async accept(arg?: unknown): Promise<void> {
    const session = this.pickSession(arg);
    if (!session) {
      void vscode.window.showInformationMessage('Kursor: no proposed changes are open.');
      return;
    }
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === session.rightUri.toString());
    const contents = doc ? doc.getText() : (this.right.readText(session.rightUri) ?? session.latest);
    session.resolve({ kind: 'saved', contents });
  }

  async reject(arg?: unknown): Promise<void> {
    const session = this.pickSession(arg);
    if (!session) {
      void vscode.window.showInformationMessage('Kursor: no proposed changes are open.');
      return;
    }
    session.resolve({ kind: 'rejected', tabName: session.tabName });
  }

  /** Rejects every pending diff (client disconnected, server stopped). */
  async rejectAll(reason: string): Promise<void> {
    const pending = [...this.sessions.values()].filter((s) => !s.settled);
    if (pending.length === 0) return;
    this.log.info(`rejecting ${pending.length} pending diff(s): ${reason}`);
    for (const session of pending) session.resolve({ kind: 'rejected', tabName: session.tabName });
  }

  // ---- internals ----------------------------------------------------------------------------

  private pickSession(arg: unknown): DiffSession | undefined {
    if (arg instanceof vscode.Uri) {
      const byUri = this.sessions.get(arg.toString());
      if (byUri) return byUri;
    }
    const active = vscode.window.tabGroups.activeTabGroup.activeTab;
    if (active && isOurDiffTab(active)) {
      const byTab = this.sessions.get(active.input.modified.toString());
      if (byTab) return byTab;
    }
    const activeDoc = vscode.window.activeTextEditor?.document.uri;
    if (activeDoc && activeDoc.scheme === RIGHT_SCHEME) {
      const byEditor = this.sessions.get(activeDoc.toString());
      if (byEditor) return byEditor;
    }
    const pending = [...this.sessions.values()].filter((s) => !s.settled);
    return pending.length === 1 ? pending[0] : undefined;
  }

  private findTab(rightUri: vscode.Uri): vscode.Tab | undefined {
    const key = rightUri.toString();
    return allTabs().find((tab) => isOurDiffTab(tab) && tab.input.modified.toString() === key);
  }

  private async waitForTab(rightUri: vscode.Uri, timeoutMs: number): Promise<vscode.Tab | undefined> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const tab = this.findTab(rightUri);
      if (tab) return tab;
      if (Date.now() >= deadline) return undefined;
      await delay(TAB_POLL_MS);
    }
  }

  private async closeTabsWhere(predicate: (tab: vscode.Tab) => boolean): Promise<number> {
    let closed = 0;
    for (const tab of allTabs()) {
      if (!predicate(tab)) continue;
      await this.closeOne(tab);
      closed++;
    }
    return closed;
  }

  /** Resolves a pending session as rejected, saves the in-memory right side (avoids the "Save?" prompt) and closes the tab. */
  private async closeOne(tab: vscode.Tab): Promise<void> {
    if (isOurDiffTab(tab)) {
      const session = this.sessions.get(tab.input.modified.toString());
      if (session && !session.settled) session.resolve({ kind: 'rejected', tabName: session.tabName });
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === tab.input.modified.toString());
      if (doc?.isDirty) {
        try {
          await doc.save();
        } catch (err) {
          this.log.warn('could not save the proposed-changes document before closing', err);
        }
      }
    }
    try {
      await vscode.window.tabGroups.close(tab, true);
    } catch (err) {
      // Usually the tab was already closed by a concurrent path (user, closeAllDiffTabs, finishSession).
      this.log.debug(`could not close tab "${tab.label}"`, err);
    }
  }

  private async finishSession(session: DiffSession): Promise<void> {
    for (const d of session.disposables.splice(0)) d.dispose();
    const tab = this.findTab(session.rightUri);
    if (tab) await this.closeOne(tab);
    this.sessions.delete(session.rightUri.toString());
    this.cleanupFiles(session);
    this.updateContext();
  }

  private cleanupFiles(session: DiffSession): void {
    this.left.deleteFile(session.leftUri);
    this.right.deleteFile(session.rightUri);
  }

  private recordAcceptedEdit(session: DiffSession, contents: string): void {
    if (!this.edits) return;
    if (session.beforeOnDisk === contents) return;
    try {
      this.edits.recordChange(IDE_EDIT_CHAT_ID, {
        path: session.newFilePath,
        before: session.beforeOnDisk,
        after: contents,
        toolUseId: `ide-diff-${session.id}`,
      });
    } catch (err) {
      this.log.warn('EditTracker.recordChange failed for an accepted IDE diff', err);
    }
  }

  private onTabsChanged(e: vscode.TabChangeEvent): void {
    for (const tab of e.closed) {
      if (!isOurDiffTab(tab)) continue;
      const session = this.sessions.get(tab.input.modified.toString());
      if (session && !session.settled) session.resolve({ kind: 'rejected', tabName: session.tabName });
    }
    this.updateContext();
  }

  private onDocumentChanged(e: vscode.TextDocumentChangeEvent): void {
    if (e.document.uri.scheme !== RIGHT_SCHEME) return;
    const session = this.sessions.get(e.document.uri.toString());
    if (!session || session.settled) return;
    session.previous = session.latest;
    session.latest = e.document.getText();
    const isUndoRedo = e.reason === vscode.TextDocumentChangeReason.Undo || e.reason === vscode.TextDocumentChangeReason.Redo;
    if (e.contentChanges.length > 3 && !isUndoRedo) {
      session.undoStorm = { time: Date.now(), contents: session.previous };
    }
  }

  private onWillSave(e: vscode.TextDocumentWillSaveEvent): void {
    if (e.document.uri.scheme !== RIGHT_SCHEME) return;
    const session = this.sessions.get(e.document.uri.toString());
    if (!session || session.settled || !session.saveMeansAccept) return;
    let contents = e.document.getText();
    if (session.undoStorm && Date.now() - session.undoStorm.time < UNDO_STORM_WINDOW_MS) contents = session.undoStorm.contents;
    session.resolve({ kind: 'saved', contents });
  }

  /**
   * For one second after a diff opens, swallow `type` keystrokes aimed at the proposed-changes
   * document: the user was most likely still typing in the terminal when focus moved.
   */
  private installTypeGuard(rightUri: vscode.Uri): void {
    this.typeGuard?.dispose();
    this.typeGuard = undefined;
    if (this.typeGuardTimer) clearTimeout(this.typeGuardTimer);
    this.typeGuardTimer = undefined;
    let active = true;
    let registration: vscode.Disposable | undefined;
    try {
      registration = vscode.commands.registerCommand('type', (args: unknown) => {
        if (active && vscode.window.activeTextEditor?.document.uri.toString() === rightUri.toString()) return undefined;
        return vscode.commands.executeCommand('default:type', args);
      });
    } catch (err) {
      this.log.debug('type-command guard unavailable (another extension owns "type")', err);
      return;
    }
    const reg = registration;
    this.typeGuard = reg;
    this.typeGuardTimer = setTimeout(() => {
      active = false;
      reg.dispose();
      if (this.typeGuard === reg) this.typeGuard = undefined;
      this.typeGuardTimer = undefined;
    }, TYPE_GUARD_MS);
  }

  private updateContext(): void {
    const viewing = allTabs().some(isOurDiffTab) || vscode.window.visibleTextEditors.some((e) => e.document.uri.scheme === RIGHT_SCHEME);
    if (viewing === this.lastContextValue) return;
    this.lastContextValue = viewing;
    void vscode.commands.executeCommand('setContext', VIEWING_DIFF_CONTEXT, viewing);
  }

  dispose(): void {
    for (const session of this.sessions.values()) {
      session.resolve({ kind: 'rejected', tabName: session.tabName });
      for (const d of session.disposables.splice(0)) d.dispose();
    }
    this.sessions.clear();
    this.typeGuard?.dispose();
    this.typeGuard = undefined;
    if (this.typeGuardTimer) clearTimeout(this.typeGuardTimer);
    this.typeGuardTimer = undefined;
    for (const d of this.disposables.splice(0)) d.dispose();
    void vscode.commands.executeCommand('setContext', VIEWING_DIFF_CONTEXT, false);
  }
}

async function readFileOrNull(file: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT' || (err as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw err;
  }
}
