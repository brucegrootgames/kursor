/**
 * InlineCompletionItemProvider backed by `bridge.oneShot`.
 *
 * Latency reality: a fresh CLI round trip is >= 2.4 s and each call burns the
 * user's subscription window, so:
 *   - automatic triggers wait `debounceMs` and bail out as soon as VS Code
 *     cancels the token (every keystroke cancels the previous call);
 *   - one request per (uri, version, position) — concurrent calls for the same
 *     key share the in-flight promise; a call for a *different* key aborts it;
 *   - the AbortController fires only when every waiter's token is cancelled;
 *   - results are cached so typing along the ghost text needs no new request;
 *   - after a failure we back off 30 s (60 s when the CLI is not signed in).
 */
import * as vscode from 'vscode';
import * as os from 'node:os';
import type { BridgeDeps } from '../services';
import type { TabState } from './state';
import { CompletionCache } from './cache';
import { FIM_SYSTEM_PROMPT, buildFimContext, buildFimPrompt } from './prompt';
import { SanitizedCompletion, sanitizeCompletion } from './sanitize';

export const TAB_ACCEPTED_COMMAND = 'kursor.tab.accepted';

const ERROR_BACKOFF_MS = 30_000;
const UNAVAILABLE_BACKOFF_MS = 60_000;

export interface TabStats {
  requests: number;
  shown: number;
  accepted: number;
  errors: number;
  lastError?: string;
}

interface Inflight {
  key: string;
  controller: AbortController;
  promise: Promise<SanitizedCompletion | undefined>;
  waiters: number;
  done: boolean;
}

export class TabCompletionProvider implements vscode.InlineCompletionItemProvider, vscode.Disposable {
  readonly stats: TabStats = { requests: 0, shown: 0, accepted: 0, errors: 0 };
  private readonly _onDidChangeBusy = new vscode.EventEmitter<boolean>();
  readonly onDidChangeBusy = this._onDidChangeBusy.event;

  private inflight: Inflight | undefined;
  private backoffUntil = 0;
  private disposed = false;

  constructor(
    private readonly deps: BridgeDeps,
    private readonly state: TabState,
    private readonly cache: CompletionCache,
  ) {}

  get busy(): boolean {
    return this.inflight !== undefined && !this.inflight.done;
  }

  async provideInlineCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionList | undefined> {
    try {
      return await this.provide(document, position, context, token);
    } catch (e) {
      // Never let a rejection reach VS Code: it would surface as a noisy notification.
      if (!isAbortError(e)) this.deps.log.error('inline completion failed', e);
      return undefined;
    }
  }

  /** Forget cached/in-flight work (settings changed, toggled off…). */
  reset(): void {
    this.cache.clear();
    this.backoffUntil = 0;
    this.inflight?.controller.abort();
  }

  noteAccepted(): void {
    this.stats.accepted++;
  }

  private async provide(
    document: vscode.TextDocument,
    position: vscode.Position,
    context: vscode.InlineCompletionContext,
    token: vscode.CancellationToken,
  ): Promise<vscode.InlineCompletionList | undefined> {
    if (this.disposed) return undefined;
    if (!this.state.availabilityFor(document.languageId).active) return undefined;
    // The suggest widget is open: our text would have to extend the selected item — not our game.
    if (context.selectedCompletionInfo) return undefined;
    if (position.line >= document.lineCount) return undefined;

    const uri = document.uri.toString();
    const lineText = document.lineAt(position.line).text;
    const linePrefix = lineText.slice(0, position.character);

    const cached = this.cache.lookup(uri, document.version, position.line, position.character, linePrefix);
    if (cached) {
      this.deps.log.debug(`cache hit ${document.fileName}:${position.line + 1}`);
      return this.toList(document, position, cached);
    }

    if (Date.now() < this.backoffUntil) return undefined;

    const automatic = context.triggerKind === vscode.InlineCompletionTriggerKind.Automatic;
    if (automatic) {
      const completed = await delay(this.state.config.debounceMs, token);
      if (!completed) return undefined;
    }
    if (token.isCancellationRequested || this.disposed) return undefined;
    if (!this.state.availabilityFor(document.languageId).active) return undefined;

    const key = `${uri}@${document.version}:${position.line}:${position.character}`;
    let inflight = this.inflight;
    if (!inflight || inflight.key !== key || inflight.done || inflight.controller.signal.aborted) {
      // A newer position supersedes whatever is still running.
      if (inflight && !inflight.done) inflight.controller.abort();
      inflight = this.start(key, document, position);
    }

    const result = await this.attach(inflight, token);
    if (!result || token.isCancellationRequested) return undefined;
    return this.toList(document, position, result);
  }

  private start(key: string, document: vscode.TextDocument, position: vscode.Position): Inflight {
    const controller = new AbortController();
    const entry: Inflight = { key, controller, promise: Promise.resolve(undefined), waiters: 0, done: false };
    entry.promise = this.request(document, position, controller.signal).finally(() => {
      entry.done = true;
      if (this.inflight === entry) this.inflight = undefined;
      this._onDidChangeBusy.fire(false);
    });
    this.inflight = entry;
    this._onDidChangeBusy.fire(true);
    return entry;
  }

  private async attach(inflight: Inflight, token: vscode.CancellationToken): Promise<SanitizedCompletion | undefined> {
    inflight.waiters++;
    const sub = token.onCancellationRequested(() => {
      if (!inflight.done && --inflight.waiters <= 0) inflight.controller.abort();
    });
    try {
      return await inflight.promise;
    } finally {
      sub.dispose();
    }
  }

  private async request(
    document: vscode.TextDocument,
    position: vscode.Position,
    signal: AbortSignal,
  ): Promise<SanitizedCompletion | undefined> {
    const { bridge, log } = this.deps;

    let status;
    try {
      status = await bridge.status();
    } catch (e) {
      status = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (signal.aborted) return undefined;
    if (!status.ok || status.loggedIn === false) {
      const reason = !status.ok ? (status.error ?? 'Claude Code CLI not found') : 'not signed in (run Kursor: Sign in)';
      this.state.setUnavailable(reason);
      this.backoffUntil = Date.now() + UNAVAILABLE_BACKOFF_MS;
      log.warn(`Tab unavailable: ${reason}`);
      return undefined;
    }
    this.state.setUnavailable(undefined);

    const ctx = buildFimContext(document, position, this.state.config.contextLines);
    const cwd = vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
    const started = Date.now();
    this.stats.requests++;

    let raw: string;
    try {
      raw = await bridge.oneShot({
        systemPrompt: FIM_SYSTEM_PROMPT,
        prompt: buildFimPrompt(ctx),
        model: this.state.config.model,
        cwd,
        signal,
        maxTurns: 1,
      });
    } catch (e) {
      if (signal.aborted || isAbortError(e)) {
        log.debug(`completion aborted after ${Date.now() - started} ms`);
        return undefined;
      }
      const msg = e instanceof Error ? e.message : String(e);
      this.stats.errors++;
      this.stats.lastError = msg;
      this.backoffUntil = Date.now() + ERROR_BACKOFF_MS;
      log.warn(`completion request failed (backing off ${ERROR_BACKOFF_MS / 1000}s): ${msg}`);
      return undefined;
    }
    if (signal.aborted) return undefined;

    const sanitized = sanitizeCompletion({
      raw,
      linePrefix: ctx.linePrefix,
      lineSuffix: ctx.lineSuffix,
      followingLines: ctx.followingLines,
    });
    log.debug(
      `completion ${document.fileName}:${position.line + 1} in ${Date.now() - started} ms → ${sanitized ? `${sanitized.text.split('\n').length} line(s)` : 'nothing usable'}`,
    );
    if (!sanitized) return undefined;

    this.cache.set({
      ...sanitized,
      uri: document.uri.toString(),
      version: document.version,
      line: position.line,
      character: position.character,
      linePrefix: ctx.linePrefix,
      createdAt: Date.now(),
    });
    return sanitized;
  }

  private toList(document: vscode.TextDocument, position: vscode.Position, c: SanitizedCompletion): vscode.InlineCompletionList {
    const range = c.replaceToLineEnd
      ? new vscode.Range(position, document.lineAt(position.line).range.end)
      : new vscode.Range(position, position);
    const item = new vscode.InlineCompletionItem(c.text, range, { command: TAB_ACCEPTED_COMMAND, title: 'Kursor Tab: accepted' });
    this.stats.shown++;
    return new vscode.InlineCompletionList([item]);
  }

  dispose(): void {
    this.disposed = true;
    this.inflight?.controller.abort();
    this._onDidChangeBusy.dispose();
  }
}

/** Resolves true after `ms`, or false as soon as the token is cancelled. */
function delay(ms: number, token: vscode.CancellationToken): Promise<boolean> {
  if (token.isCancellationRequested) return Promise.resolve(false);
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      sub.dispose();
      resolve(true);
    }, ms);
    const sub = token.onCancellationRequested(() => {
      clearTimeout(timer);
      sub.dispose();
      resolve(false);
    });
  });
}

export function isAbortError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const name = (e as { name?: unknown }).name;
  const message = (e as { message?: unknown }).message;
  return name === 'AbortError' || (typeof message === 'string' && /\baborted\b/i.test(message));
}
