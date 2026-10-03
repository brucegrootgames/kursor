/**
 * ChatManager — the chat host's brain. Owns the ChatStore, one ChatRunner per
 * chat (lazy), the set of connected webview hosts (side bar view + editor
 * panels), the AppState (models, slash commands, Claude status, settings) and
 * every user action (send/stop/permissions/mode/model/checkpoints/history/
 * export/attachments). Posts `chatState` with a 50 ms throttle per chat and
 * `textDelta` immediately.
 */
import * as vscode from 'vscode';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AppState, Attachment, ChatMode, ChatState, EffortLevel, HistoryEntry, HostToWebview, ModelOption, PermissionMode, SlashCommandOption, UserMessage } from '../../shared/protocol';
import type { ClaudeSession, PermissionRequest } from '../claude/types';
import type { ChatDeps } from '../services';
import { resolveAttachment, relPathOf } from '../context/providers';
import type { TerminalCapture } from '../context/terminalCapture';
import { chatToMarkdown } from './export';
import { composeTurn, type ActiveFileInfo } from './prompt';
import { ChatRunner } from './runner';
import { createChatState, DEFAULT_TITLE, findUserMessage, newId, reconcileEditStatuses, systemNote, titleFromText } from './state';
import { ChatStore } from './store';

export interface WebviewHostLike {
  readonly kind: 'view' | 'panel';
  readonly visible: boolean;
  post(msg: HostToWebview): void;
}

const FALLBACK_MODELS: ModelOption[] = [
  { value: '', label: 'Default', description: 'Claude Code default model', supportsEffort: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'opus', label: 'Opus', supportsEffort: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'sonnet', label: 'Sonnet', supportsEffort: true, effortLevels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  { value: 'haiku', label: 'Haiku' },
];

const CHAT_STATE_THROTTLE_MS = 50;

export class ChatManager implements vscode.Disposable {
  readonly store: ChatStore;
  private readonly runners = new Map<string, ChatRunner>();
  private readonly hosts = new Set<WebviewHostLike>();
  private models: ModelOption[] = FALLBACK_MODELS;
  private commands: SlashCommandOption[] = [];
  private claude: AppState['claude'] = { ready: false };
  private capabilitiesLoaded = false;
  private readonly chatTimers = new Map<string, NodeJS.Timeout>();
  private appTimer: NodeJS.Timeout | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  /** Set by the view layer: a permission arrived for `chat` (badge / notification when hidden). */
  onPermissionAttention: ((chat: ChatState, request: PermissionRequest) => void) | undefined;
  /** Set by the view layer: reveal the chat UI. */
  reveal: ((focus: boolean) => Promise<void>) | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: ChatDeps,
    private readonly terminals: TerminalCapture,
  ) {
    this.store = new ChatStore(context, deps.log.child('store'));
    this.disposables.push(
      this.store,
      this.store.onDidChange(() => this.postAppState()),
      deps.edits.onDidChange(() => this.onEditsChanged()),
      // Keep/Undo from the editor (CodeLens, title buttons, keybindings) must update the chat's tool rows too.
      deps.edits.onDidResolve?.((r) => {
        for (const runner of this.runners.values()) runner.markEdits([r.path], r.status);
      }) ?? new vscode.Disposable(() => undefined),
      deps.rules.onDidChange(() => {
        for (const r of this.runners.values()) r.invalidateSession();
      }),
      deps.bridge.onDidChangeStatus((s) => {
        this.claude = { ready: s.ok && s.loggedIn !== false, version: s.version, path: s.path, loggedIn: s.loggedIn, email: s.email, subscriptionType: s.subscriptionType, error: s.ok ? (s.loggedIn === false ? 'Not signed in to Claude Code.' : undefined) : s.error };
        this.postAppState();
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('kursor')) this.postAppState();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.postAppState()),
    );
    void deps.bridge.status().then(
      (s) => {
        this.claude = { ready: s.ok && s.loggedIn !== false, version: s.version, path: s.path, loggedIn: s.loggedIn, email: s.email, subscriptionType: s.subscriptionType, error: s.ok ? (s.loggedIn === false ? 'Not signed in to Claude Code.' : undefined) : s.error };
        this.postAppState();
      },
      (err: unknown) => deps.log.warn('status failed', err),
    );
    for (const chat of this.store.all()) {
      chat.pendingEdits = deps.edits.pending(chat.id);
      // Tool rows restored with a stale 'pending' edit (the tracker no longer knows the file) are shown as kept.
      reconcileEditStatuses(chat, chat.pendingEdits);
    }
    this.updateRunningContext();
  }

  // ---- settings / environment ------------------------------------------------------

  settings(): AppState['settings'] {
    const cfg = vscode.workspace.getConfiguration('kursor');
    return {
      showThinking: cfg.get<boolean>('chat.showThinking', true),
      toolCallDensity: cfg.get<'compact' | 'balanced' | 'detailed'>('chat.toolCallDensity', 'balanced'),
      defaultMode: cfg.get<ChatMode>('agent.defaultMode', 'agent'),
      permissionMode: cfg.get<PermissionMode>('agent.permissionMode', 'acceptEdits'),
      inlineDiffs: cfg.get<boolean>('agent.inlineDiffs', true),
    };
  }

  defaultCwd(): string {
    const folders = vscode.workspace.workspaceFolders ?? [];
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active) {
      const f = vscode.workspace.getWorkspaceFolder(active);
      if (f) return f.uri.fsPath;
      if (active.scheme === 'file' && !folders.length) return path.dirname(active.fsPath);
    }
    return folders[0]?.uri.fsPath ?? os.homedir();
  }

  appState(): AppState {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return {
      chats: this.store.summaries(),
      activeChatId: this.store.activeId,
      models: this.models,
      commands: this.commands,
      claude: this.claude,
      settings: this.settings(),
      workspaceName: vscode.workspace.name ?? folder?.name,
      workspaceFolder: folder?.uri.fsPath,
    };
  }

  slashCommands(): SlashCommandOption[] {
    return this.commands;
  }

  // ---- hosts / posting ------------------------------------------------------------

  registerHost(host: WebviewHostLike): vscode.Disposable {
    this.hosts.add(host);
    return new vscode.Disposable(() => this.hosts.delete(host));
  }

  /** Full sync for a host that just became ready. */
  syncHost(host: WebviewHostLike): void {
    host.post({ type: 'appState', state: this.appState() });
    const active = this.store.active();
    if (active) host.post({ type: 'chatState', chat: active });
  }

  broadcast(msg: HostToWebview): void {
    for (const h of this.hosts) h.post(msg);
  }

  /** Post to the best host for input-related messages (visible view, else visible panel, else any). */
  postToPrimary(msg: HostToWebview): void {
    const hosts = [...this.hosts];
    const target = hosts.find((h) => h.kind === 'view' && h.visible) ?? hosts.find((h) => h.visible) ?? hosts.find((h) => h.kind === 'view') ?? hosts[0];
    target?.post(msg);
  }

  postAppState(): void {
    if (this.appTimer) return;
    this.appTimer = setTimeout(() => {
      this.appTimer = undefined;
      this.broadcast({ type: 'appState', state: this.appState() });
      this.updateRunningContext();
    }, 30);
  }

  postChatState(chatId: string): void {
    if (this.chatTimers.has(chatId)) return;
    this.chatTimers.set(
      chatId,
      setTimeout(() => {
        this.chatTimers.delete(chatId);
        const chat = this.store.get(chatId);
        if (!chat) return;
        this.broadcast({ type: 'chatState', chat });
        this.store.touch();
        if (chatId === this.store.activeId) this.updateRunningContext();
      }, CHAT_STATE_THROTTLE_MS),
    );
  }

  private updateRunningContext(): void {
    const active = this.store.active();
    const running = !!active && (active.status === 'running' || active.status === 'starting' || active.status === 'waiting');
    void vscode.commands.executeCommand('setContext', 'kursor.chatRunning', running);
  }

  // ---- runners --------------------------------------------------------------------

  private runnerFor(chat: ChatState): ChatRunner {
    let r = this.runners.get(chat.id);
    if (r) return r;
    r = new ChatRunner(chat, {
      log: this.deps.log.child(`chat:${chat.id.slice(5, 13)}`),
      bridge: this.deps.bridge,
      edits: this.deps.edits,
      rules: this.deps.rules,
      notify: () => {
        this.postChatState(chat.id);
        if (chat.status !== 'idle') this.postAppState();
      },
      onDelta: (messageId, blockId, delta) => this.broadcast({ type: 'textDelta', chatId: chat.id, messageId, blockId, delta }),
      onPermissionRequest: (request) => this.onPermissionAttention?.(chat, request),
      onInit: (session) => void this.loadCapabilities(session),
      onTurnEnd: () => this.onTurnEnd(chat),
      additionalDirectories: () => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
    });
    this.runners.set(chat.id, r);
    return r;
  }

  private async loadCapabilities(session: ClaudeSession): Promise<void> {
    if (this.capabilitiesLoaded) return;
    this.capabilitiesLoaded = true;
    try {
      const [models, commands] = await Promise.all([session.supportedModels(), session.supportedCommands()]);
      if (models.length) this.models = models.map((m) => (m.value === 'default' ? { ...m, value: '' } : m));
      if (commands.length) this.commands = commands;
      this.postAppState();
    } catch (err) {
      this.capabilitiesLoaded = false;
      this.deps.log.warn('supportedModels/commands failed', err);
    }
  }

  private onTurnEnd(chat: ChatState): void {
    if (chat.id !== this.store.activeId || !this.anyHostVisible()) chat.unread = true;
    this.postAppState();
    const runner = this.runners.get(chat.id);
    if (runner) {
      void runner.contextUsage().then((u) => {
        if (u) {
          chat.contextUsage = u;
          this.postChatState(chat.id);
        }
      });
    }
  }

  anyHostVisible(): boolean {
    for (const h of this.hosts) if (h.visible) return true;
    return false;
  }

  private onEditsChanged(): void {
    for (const chat of this.store.all()) {
      const pending = this.deps.edits.pending(chat.id);
      const runner = this.runners.get(chat.id);
      const before = JSON.stringify(chat.pendingEdits);
      if (runner) runner.refreshEditSummaries(pending, 'kept');
      else chat.pendingEdits = pending;
      if (before !== JSON.stringify(chat.pendingEdits) || runner) this.postChatState(chat.id);
    }
  }

  // ---- chat collection --------------------------------------------------------------

  newChat(opts?: { mode?: ChatMode; title?: string; sessionId?: string; cwd?: string; reuseEmpty?: boolean }): ChatState {
    if (opts?.reuseEmpty !== false && !opts?.sessionId) {
      const empty = this.store.emptyChat();
      if (empty) {
        if (opts?.mode) empty.mode = opts.mode;
        this.store.setActive(empty.id);
        this.postChatState(empty.id);
        return empty;
      }
    }
    const s = this.settings();
    const cfg = vscode.workspace.getConfiguration('kursor');
    const chat = createChatState({
      mode: opts?.mode ?? s.defaultMode,
      permissionMode: s.permissionMode,
      model: cfg.get<string>('claude.model', ''),
      effort: cfg.get<EffortLevel>('claude.effort', ''),
      cwd: opts?.cwd ?? this.defaultCwd(),
      title: opts?.title,
      sessionId: opts?.sessionId,
    });
    this.store.add(chat);
    this.postChatState(chat.id);
    return chat;
  }

  activeOrNew(): ChatState {
    return this.store.active() ?? this.newChat();
  }

  switchChat(id: string): void {
    if (this.store.setActive(id)) {
      this.postChatState(id);
      this.postAppState();
    }
  }

  async closeChat(id: string): Promise<void> {
    const runner = this.runners.get(id);
    if (runner) {
      if (runner.running) await runner.interrupt();
      runner.dispose();
      this.runners.delete(id);
    }
    this.store.remove(id);
    this.deps.edits.clear(id);
    const next = this.store.active();
    if (next) this.postChatState(next.id);
    this.postAppState();
  }

  renameChat(id: string, title: string): void {
    this.store.rename(id, title);
    this.postChatState(id);
  }

  // ---- sending ----------------------------------------------------------------------

  private activeFileInfo(): ActiveFileInfo | undefined {
    const ed = vscode.window.activeTextEditor;
    if (!ed || ed.document.uri.scheme !== 'file') return undefined;
    const sel = ed.selection;
    return {
      fsPath: ed.document.uri.fsPath,
      cursorLine: sel.active.line + 1,
      selection: sel.isEmpty ? undefined : { startLine: sel.start.line + 1, endLine: sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1 },
    };
  }

  async send(chatId: string | undefined, text: string, attachments: Attachment[], options?: { sendNow?: boolean; mode?: ChatMode }): Promise<ChatState> {
    const chat = (chatId && this.store.get(chatId)) || this.activeOrNew();
    if (!vscode.workspace.isTrusted) {
      // Restricted Mode: the agent reads, edits and runs code in the workspace, so it waits for trust.
      chat.messages.push(
        systemNote('This workspace is in Restricted Mode. Trust it to let Kursor read, edit and run code here.', 'warning', {
          label: 'Manage Workspace Trust',
          command: 'workbench.trust.manage',
        }),
      );
      chat.updatedAt = Date.now();
      this.postChatState(chat.id);
      return chat;
    }
    if (options?.mode && options.mode !== chat.mode) await this.setMode(chat.id, options.mode);
    const cfg = vscode.workspace.getConfiguration('kursor');
    if (cfg.get<boolean>('agent.autoSave', true)) {
      try {
        await vscode.workspace.saveAll(false);
      } catch (err) {
        this.deps.log.warn('saveAll failed', err);
      }
    }
    const cwd = chat.cwd ?? this.defaultCwd();
    chat.cwd = cwd;
    const resolved: Attachment[] = [];
    for (const a of attachments) {
      try {
        resolved.push(await resolveAttachment(a, this.terminals, cwd));
      } catch (err) {
        this.deps.log.warn(`attachment ${a.label} could not be resolved`, err);
        resolved.push(a);
      }
    }
    const activeFile = cfg.get<boolean>('agent.attachOpenFile', true) ? this.activeFileInfo() : undefined;
    const composed = composeTurn(text, resolved, { cwd, activeFile });
    const user: UserMessage = {
      kind: 'user',
      id: newId('u'),
      text,
      attachments: resolved,
      timestamp: Date.now(),
      canRestore: false,
    };
    chat.messages.push(user);
    if (chat.title === DEFAULT_TITLE) chat.title = titleFromText(text || resolved.map((a) => a.label).join(', '));
    chat.updatedAt = Date.now();
    chat.unread = false;
    this.postChatState(chat.id);
    try {
      await this.runnerFor(chat).send(composed.turn, user, composed.contextPaths, !!options?.sendNow);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.deps.log.error('send failed', err);
      chat.status = 'error';
      chat.error = msg;
      chat.messages.push(systemNote(`Could not start Claude Code: ${msg}`, 'error', { label: 'Check status', command: 'kursor.claude.status' }));
    }
    this.postChatState(chat.id);
    this.postAppState();
    return chat;
  }

  async stop(chatId?: string): Promise<void> {
    const chat = chatId ? this.store.get(chatId) : this.store.active();
    if (!chat) return;
    const runner = this.runners.get(chat.id);
    if (runner) await runner.interrupt();
    else chat.status = 'idle';
    for (const m of chat.messages) if (m.kind === 'user' && m.queued) m.queued = false;
    this.postChatState(chat.id);
    this.postAppState();
  }

  // ---- permissions / questions / plans ------------------------------------------------

  respondPermission(chatId: string, requestId: string, decision: 'allow' | 'deny' | 'always', suggestionIndex?: number, updatedInput?: unknown): void {
    const chat = this.store.get(chatId);
    const runner = chat && this.runners.get(chat.id);
    if (!runner) return;
    const request = runner.pendingRequest(requestId);
    const input = (updatedInput && typeof updatedInput === 'object' ? (updatedInput as Record<string, unknown>) : undefined) ?? request?.input;
    if (decision === 'deny') {
      runner.respond(requestId, { behavior: 'deny', message: 'The user skipped this action. Ask before trying an alternative.' }, 'deny');
      return;
    }
    let idx = suggestionIndex;
    if (decision === 'always' && idx === undefined && request?.suggestions.length) idx = request.suggestions[0].index;
    runner.respond(requestId, { behavior: 'allow', updatedInput: input, suggestionIndex: decision === 'always' ? idx : undefined }, decision);
  }

  answerQuestion(chatId: string, requestId: string, answers: Record<string, string>): void {
    const chat = this.store.get(chatId);
    const runner = chat && this.runners.get(chat.id);
    if (!runner || !chat) return;
    const request = runner.pendingRequest(requestId);
    const questions = request?.input?.questions;
    runner.respond(requestId, { behavior: 'allow', updatedInput: { ...(request?.input ?? {}), questions, answers } }, 'allow');
    for (const m of chat.messages) {
      if (m.kind !== 'assistant') continue;
      for (const b of m.blocks) if (b.type === 'question' && b.id === requestId) b.answers = answers;
    }
    this.postChatState(chat.id);
  }

  async respondPlan(chatId: string, requestId: string, decision: 'build' | 'reject', feedback?: string): Promise<void> {
    const chat = this.store.get(chatId);
    const runner = chat && this.runners.get(chat.id);
    if (!runner || !chat) return;
    if (decision === 'build') {
      runner.respond(requestId, { behavior: 'allow' }, 'allow');
      chat.mode = 'agent';
      // Claude Code leaves plan mode itself on approval; align the process (session.setMode → configured
      // agent permission mode) once the approval has been delivered.
      setTimeout(() => void runner.syncSessionMode().catch((err: unknown) => this.deps.log.debug('syncSessionMode after plan failed', err)), 300);
    } else {
      runner.respond(requestId, { behavior: 'deny', message: feedback?.trim() ? `The user rejected the plan with this feedback: ${feedback.trim()}` : 'The user rejected the plan. Ask what should change before planning again.' }, 'deny');
    }
    this.postChatState(chat.id);
    this.postAppState();
  }

  // ---- chat options -----------------------------------------------------------------

  async setMode(chatId: string, mode: ChatMode): Promise<void> {
    const chat = this.store.get(chatId);
    if (!chat) return;
    const runner = this.runners.get(chat.id);
    if (runner) await runner.setMode(mode);
    else chat.mode = mode;
    this.postChatState(chat.id);
  }

  async setModel(chatId: string, model: string): Promise<void> {
    const chat = this.store.get(chatId);
    if (!chat) return;
    const runner = this.runners.get(chat.id);
    if (runner) await runner.setModel(model);
    else chat.model = model;
    this.postChatState(chat.id);
  }

  async setEffort(chatId: string, effort: EffortLevel): Promise<void> {
    const chat = this.store.get(chatId);
    if (!chat) return;
    const runner = this.runners.get(chat.id);
    if (runner) await runner.setEffort(effort);
    else chat.effort = effort;
    this.postChatState(chat.id);
  }

  async setPermissionMode(chatId: string, mode: PermissionMode): Promise<void> {
    const chat = this.store.get(chatId);
    if (!chat) return;
    const runner = this.runners.get(chat.id);
    if (runner) await runner.setPermissionMode(mode);
    else chat.permissionMode = mode;
    this.postChatState(chat.id);
  }

  // ---- checkpoints / edits ------------------------------------------------------------

  async restoreCheckpoint(chatId: string, messageId: string): Promise<void> {
    const chat = this.store.get(chatId);
    if (!chat) return;
    const user = findUserMessage(chat, messageId);
    if (!user?.uuid) {
      void vscode.window.showWarningMessage('No file checkpoint is available for this message.');
      return;
    }
    const pick = await vscode.window.showWarningMessage(
      'Restore files to their state before this message? The conversation is kept; pending agent edits for this chat are forgotten.',
      { modal: true },
      'Restore files',
    );
    if (pick !== 'Restore files') return;
    const runner = this.runnerFor(chat);
    const res = await runner.rewindFiles(user.uuid);
    if (!res.canRewind) {
      const msg = res.error ?? 'Claude Code could not restore this checkpoint.';
      chat.messages.push(systemNote(msg, 'warning'));
      void vscode.window.showWarningMessage(`Kursor: ${msg}`);
    } else {
      this.deps.edits.clear(chat.id);
      const files = res.filesChanged ?? [];
      const list = files.length ? files.map((f) => `\`${relPathOf(f)}\``).join(', ') : 'no files needed changes';
      chat.messages.push(systemNote(`Restored checkpoint from before "${titleFromText(user.text)}" — ${list}.`));
    }
    chat.updatedAt = Date.now();
    this.postChatState(chat.id);
  }

  async editsAction(action: 'keep' | 'undo' | 'review', fsPath?: string): Promise<void> {
    if (action === 'review') {
      await this.deps.edits.review(fsPath);
      return;
    }
    const status = action === 'keep' ? 'kept' : 'undone';
    for (const r of this.runners.values()) r.markEdits(fsPath ? [fsPath] : undefined, status);
    if (action === 'keep') await this.deps.edits.keep(fsPath);
    else await this.deps.edits.undo(fsPath);
    for (const chat of this.store.all()) this.postChatState(chat.id);
  }

  // ---- history ----------------------------------------------------------------------

  async history(): Promise<HistoryEntry[]> {
    const cwds = new Set<string>();
    for (const f of vscode.workspace.workspaceFolders ?? []) cwds.add(f.uri.fsPath);
    const active = this.store.active();
    if (active?.cwd) cwds.add(active.cwd);
    if (!cwds.size) cwds.add(this.defaultCwd());
    const entries: HistoryEntry[] = [];
    for (const cwd of cwds) {
      try {
        entries.push(...(await this.deps.bridge.listSessions(cwd)));
      } catch (err) {
        this.deps.log.warn(`listSessions(${cwd}) failed`, err);
      }
    }
    const seen = new Set<string>();
    const out: HistoryEntry[] = [];
    for (const e of entries.sort((a, b) => b.updatedAt - a.updatedAt)) {
      if (seen.has(e.sessionId)) continue;
      seen.add(e.sessionId);
      const open = this.store.bySessionId(e.sessionId);
      out.push({ ...e, chatId: open?.id, title: open?.title && open.title !== DEFAULT_TITLE ? open.title : e.title });
    }
    return out;
  }

  async resumeSession(sessionId: string): Promise<ChatState> {
    const open = this.store.bySessionId(sessionId);
    if (open) {
      this.switchChat(open.id);
      return open;
    }
    const entries = await this.history();
    const entry = entries.find((e) => e.sessionId === sessionId);
    const cwd = entry?.cwd ?? this.defaultCwd();
    const chat = this.newChat({ sessionId, title: entry?.title ?? 'Resumed chat', cwd, reuseEmpty: false });
    try {
      const transcript = await this.deps.bridge.getSessionTranscript(sessionId, cwd);
      for (const t of transcript) {
        if (t.role === 'user') chat.messages.push({ kind: 'user', id: newId('u'), text: t.text, attachments: [], timestamp: t.timestamp ?? chat.createdAt, canRestore: false });
        else chat.messages.push({ kind: 'assistant', id: newId('a'), blocks: [{ type: 'text', id: newId('t'), text: t.text }], streaming: false, timestamp: t.timestamp ?? chat.createdAt });
      }
      if (chat.title === 'Resumed chat') {
        const firstUser = transcript.find((t) => t.role === 'user');
        if (firstUser) chat.title = titleFromText(firstUser.text);
      }
    } catch (err) {
      this.deps.log.warn('getSessionTranscript failed', err);
      chat.messages.push(systemNote('Previous messages could not be loaded; the conversation continues from Claude Code\'s saved session.', 'warning'));
    }
    chat.messages.push(systemNote('Resumed previous session.'));
    this.postChatState(chat.id);
    this.postAppState();
    return chat;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const open = this.store.bySessionId(sessionId);
    const pick = await vscode.window.showWarningMessage(`Delete this chat session permanently?${open ? ' It is currently open and will be closed.' : ''}`, { modal: true }, 'Delete');
    if (pick !== 'Delete') return;
    if (open) await this.closeChat(open.id);
    const cwd = open?.cwd ?? this.defaultCwd();
    await this.deps.bridge.deleteSession(sessionId, cwd);
  }

  // ---- export -------------------------------------------------------------------------

  async exportChat(chatId?: string): Promise<void> {
    const chat = chatId ? this.store.get(chatId) : this.store.active();
    if (!chat) {
      void vscode.window.showInformationMessage('No chat to export.');
      return;
    }
    const slug = chat.title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'chat';
    const base = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(os.homedir());
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.joinPath(base, `kursor-chat-${slug}.md`),
      filters: { Markdown: ['md'] },
      title: 'Export chat as Markdown',
    });
    if (!target) return;
    await vscode.workspace.fs.writeFile(target, Buffer.from(chatToMarkdown(chat), 'utf8'));
    const pick = await vscode.window.showInformationMessage(`Chat exported to ${vscode.workspace.asRelativePath(target)}`, 'Open');
    if (pick === 'Open') await vscode.window.showTextDocument(target);
  }

  // ---- input helpers (ChatController) ---------------------------------------------------

  async addAttachment(attachment: Attachment, options?: { newChat?: boolean; focus?: boolean }): Promise<void> {
    if (options?.newChat) this.newChat();
    else this.activeOrNew();
    await this.reveal?.(options?.focus !== false);
    this.postToPrimary({ type: 'addAttachment', attachment });
    if (options?.focus !== false) this.postToPrimary({ type: 'focusInput' });
  }

  async insertText(text: string): Promise<void> {
    this.activeOrNew();
    await this.reveal?.(true);
    this.postToPrimary({ type: 'insertText', text });
    this.postToPrimary({ type: 'focusInput' });
  }

  async focusInput(): Promise<void> {
    await this.reveal?.(true);
    this.postToPrimary({ type: 'focusInput' });
  }

  dispose(): void {
    for (const t of this.chatTimers.values()) clearTimeout(t);
    this.chatTimers.clear();
    if (this.appTimer) clearTimeout(this.appTimer);
    for (const r of this.runners.values()) r.dispose();
    this.runners.clear();
    for (const d of this.disposables) d.dispose();
  }
}
