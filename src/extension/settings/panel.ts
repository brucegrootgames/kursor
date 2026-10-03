/**
 * SettingsPanelController — the singleton "Kursor Settings" WebviewPanel (viewType `kursor.settings`).
 *
 * The host owns the state: it reads `kursor.*` (config.ts), the Claude status (bridge), the project
 * rules (RulesService) and the workspace info, pushes snapshots to the panel and applies the panel's
 * intents. Everything the panel can trigger goes through `handleMessage`, which never throws:
 * failures are logged and surfaced as a toast inside the panel.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import type { ClaudeStatus } from '../claude/types';
import type { SettingsDeps } from '../services';
import type { Logger } from '../util/log';
import {
  isSettingKey,
  isSettingsTab,
  type AboutInfo,
  type ClaudeStatusInfo,
  type RuleListItem,
  type SettingsHostToPanel,
  type SettingsPanelToHost,
  type SettingsState,
  type SettingsTab,
} from '../../shared/settingsProtocol';
import { SettingValueError, coerceValue, readSnapshot, writeValue } from './config';
import { settingsHtml } from './html';
import { createNewRuleInteractive } from './rulesActions';
import { defaultCwd, isWorkspaceFolderPath, openGitignore, openOrCreateCursorignore, openPathFromPanel, readWorkspaceInfo } from './workspace';

export const SETTINGS_VIEW_TYPE = 'kursor.settings';
const SETTINGS_POST_THROTTLE_MS = 50;
const HOME = process.env.HOME ?? '';

const ABOUT_LINKS: AboutInfo['links'] = [
  { label: 'Claude Code documentation', url: 'https://docs.claude.com/en/docs/claude-code/overview', icon: 'book' },
  { label: 'Claude Code settings reference', url: 'https://docs.claude.com/en/docs/claude-code/settings', icon: 'settings' },
  { label: 'Claude Code CLI reference', url: 'https://docs.claude.com/en/docs/claude-code/cli-reference', icon: 'terminal' },
  { label: 'Cursor rules format (.mdc)', url: 'https://docs.cursor.com/context/rules', icon: 'law' },
  { label: 'Claude usage & plans', url: 'https://claude.ai/settings/usage', icon: 'graph' },
];

const ALLOWED_COMMANDS = new Set<string>([
  'kursor.claude.login',
  'kursor.claude.status',
  'kursor.showLogs',
  'kursor.rules.new',
  'kursor.tab.toggle',
  'kursor.tab.snooze',
  'kursor.tab.statusMenu',
  'kursor.chat.open',
  'kursor.chat.newChat',
  'workbench.action.openSettings',
  'workbench.action.openSettingsJson',
  'workbench.action.openWorkspaceSettings',
  'workbench.action.openGlobalKeybindings',
  'workbench.action.openGlobalKeybindingsFile',
  'workbench.action.selectTheme',
  'workbench.action.reloadWindow',
  'workbench.extensions.action.showExtensionsWithIds',
]);

export class SettingsPanelController implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private panelSubs: vscode.Disposable[] = [];
  private readonly subs: vscode.Disposable[] = [];
  private ready = false;
  private pendingTab: SettingsTab | undefined;
  private cwd: string | undefined;
  private claude: ClaudeStatusInfo = { ok: false, checking: false };
  private rules: { items: RuleListItem[]; loading: boolean; error?: string } = { items: [], loading: false };
  private rulesGeneration = 0;
  private settingsTimer: NodeJS.Timeout | undefined;
  private disposed = false;
  private readonly log: Logger;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly deps: SettingsDeps,
  ) {
    this.log = deps.log;
    this.cwd = defaultCwd();
    this.subs.push(
      vscode.window.registerWebviewPanelSerializer(SETTINGS_VIEW_TYPE, {
        deserializeWebviewPanel: async (panel, state: unknown) => {
          const tab = (state as { tab?: unknown } | undefined)?.tab;
          if (isSettingsTab(tab)) this.pendingTab = tab;
          this.attach(panel);
        },
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (!e.affectsConfiguration('kursor')) return;
        this.scheduleSettingsPost();
      }),
      deps.bridge.onDidChangeStatus((status) => {
        this.claude = this.toStatusInfo(status, false);
        this.post({ type: 'claudeStatus', status: this.claude });
      }),
      deps.rules.onDidChange(() => {
        if (this.panel) void this.refreshRules();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        if (!this.cwd || !isWorkspaceFolderPath(this.cwd)) this.cwd = defaultCwd();
        void this.postWorkspace();
        void this.refreshRules();
      }),
    );
  }

  // ---------------------------------------------------------------- panel lifecycle

  open(tab?: SettingsTab): void {
    if (tab) this.pendingTab = tab;
    if (this.panel) {
      this.panel.reveal(undefined, false);
      if (tab && this.ready) {
        this.post({ type: 'selectTab', tab });
        this.pendingTab = undefined;
      }
      return;
    }
    const roots = [vscode.Uri.joinPath(this.context.extensionUri, 'dist'), vscode.Uri.joinPath(this.context.extensionUri, 'media')];
    const panel = vscode.window.createWebviewPanel(
      SETTINGS_VIEW_TYPE,
      'Kursor Settings',
      { viewColumn: vscode.ViewColumn.Active, preserveFocus: false },
      { enableScripts: true, retainContextWhenHidden: true, enableFindWidget: true, localResourceRoots: roots },
    );
    this.attach(panel);
  }

  private attach(panel: vscode.WebviewPanel): void {
    if (this.panel && this.panel !== panel) this.panel.dispose();
    this.detachPanel();
    this.panel = panel;
    this.ready = false;
    const roots = [vscode.Uri.joinPath(this.context.extensionUri, 'dist'), vscode.Uri.joinPath(this.context.extensionUri, 'media')];
    panel.title = 'Kursor Settings';
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'kursor-activity.svg');
    panel.webview.options = { enableScripts: true, localResourceRoots: roots };
    panel.webview.html = settingsHtml(panel.webview, this.context.extensionUri);
    this.panelSubs.push(
      panel.webview.onDidReceiveMessage((raw: unknown) => {
        void this.handleMessage(raw);
      }),
      panel.onDidDispose(() => {
        if (this.panel === panel) {
          this.detachPanel();
          this.panel = undefined;
          this.ready = false;
        }
      }),
    );
    // Warm the status cache so the General tab shows real data immediately.
    void this.deps.bridge.status().then(
      (s) => {
        this.claude = this.toStatusInfo(s, false);
        this.post({ type: 'claudeStatus', status: this.claude });
      },
      (err: unknown) => this.log.debug('status() failed while opening settings', err),
    );
  }

  private detachPanel(): void {
    for (const d of this.panelSubs.splice(0)) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (this.settingsTimer) clearTimeout(this.settingsTimer);
    this.detachPanel();
    for (const d of this.subs.splice(0)) {
      try {
        d.dispose();
      } catch {
        /* ignore */
      }
    }
    this.panel?.dispose();
    this.panel = undefined;
  }

  // ---------------------------------------------------------------- outgoing

  private post(msg: SettingsHostToPanel): void {
    if (!this.panel || !this.ready) return;
    void this.panel.webview.postMessage(msg).then(
      (ok) => {
        if (!ok) this.log.debug(`postMessage(${msg.type}) not delivered`);
      },
      (err: unknown) => this.log.debug(`postMessage(${msg.type}) failed`, err),
    );
  }

  private toast(level: 'info' | 'warning' | 'error', text: string): void {
    this.post({ type: 'toast', level, text });
  }

  private scheduleSettingsPost(): void {
    if (this.settingsTimer) return;
    this.settingsTimer = setTimeout(() => {
      this.settingsTimer = undefined;
      if (this.disposed) return;
      try {
        this.post({ type: 'settings', settings: readSnapshot(this.context.extension.packageJSON) });
      } catch (err) {
        this.log.error('reading settings failed', err);
      }
    }, SETTINGS_POST_THROTTLE_MS);
  }

  private toStatusInfo(s: ClaudeStatus, checking: boolean): ClaudeStatusInfo {
    return {
      ok: s.ok,
      path: s.path,
      version: s.version,
      loggedIn: s.loggedIn,
      email: s.email,
      subscriptionType: s.subscriptionType,
      error: s.error,
      checking,
      checkedAt: Date.now(),
    };
  }

  private aboutInfo(): AboutInfo {
    const pkg = this.context.extension.packageJSON as { version?: string } | undefined;
    return {
      extensionVersion: pkg?.version ?? '0.0.0',
      extensionPath: this.context.extensionUri.fsPath,
      appName: vscode.env.appName,
      appVersion: vscode.version,
      platform: process.platform,
      uiKind: vscode.env.uiKind === vscode.UIKind.Web ? 'web' : 'desktop',
      links: ABOUT_LINKS,
    };
  }

  private async buildState(): Promise<SettingsState> {
    const workspace = await readWorkspaceInfo(this.cwd);
    this.cwd = workspace.cwd;
    return {
      settings: readSnapshot(this.context.extension.packageJSON),
      claude: this.claude,
      rules: this.rules,
      workspace,
      about: this.aboutInfo(),
      initialTab: this.pendingTab,
    };
  }

  private async postWorkspace(): Promise<void> {
    try {
      const workspace = await readWorkspaceInfo(this.cwd);
      this.cwd = workspace.cwd;
      this.post({ type: 'workspace', workspace });
    } catch (err) {
      this.log.error('reading workspace info failed', err);
    }
  }

  private async refreshRules(): Promise<void> {
    const generation = ++this.rulesGeneration;
    const cwd = this.cwd;
    if (!cwd) {
      this.rules = { items: [], loading: false };
      this.post({ type: 'rules', ...this.rules });
      return;
    }
    this.rules = { ...this.rules, loading: true, error: undefined };
    this.post({ type: 'rules', ...this.rules });
    try {
      const rules = await this.deps.rules.listProjectRules(cwd);
      if (generation !== this.rulesGeneration) return; // superseded
      const items: RuleListItem[] = rules
        .map((r) => ({
          name: r.name,
          path: r.path,
          relPath: path.isAbsolute(r.path) ? path.relative(cwd, r.path) || path.basename(r.path) : r.path,
          kind: r.kind,
          description: r.description,
          globs: r.globs,
        }))
        .sort((a, b) => kindOrder(a.kind) - kindOrder(b.kind) || a.relPath.localeCompare(b.relPath));
      this.rules = { items, loading: false };
    } catch (err) {
      if (generation !== this.rulesGeneration) return;
      this.log.error('listing project rules failed', err);
      this.rules = { items: [], loading: false, error: err instanceof Error ? err.message : String(err) };
    }
    this.post({ type: 'rules', ...this.rules });
  }

  // ---------------------------------------------------------------- incoming

  private async handleMessage(raw: unknown): Promise<void> {
    const msg = raw as SettingsPanelToHost;
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    try {
      await this.dispatch(msg);
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      if (err instanceof SettingValueError) {
        this.log.warn(`rejected setting write: ${text}`);
      } else {
        this.log.error(`settings message ${msg.type} failed`, err);
      }
      this.toast('error', text);
      // Whatever failed, make sure the panel shows the real values again.
      if (msg.type === 'setSetting' || msg.type === 'resetSetting') this.scheduleSettingsPost();
    }
  }

  private async dispatch(msg: SettingsPanelToHost): Promise<void> {
    switch (msg.type) {
      case 'ready': {
        this.ready = true;
        const state = await this.buildState();
        this.pendingTab = undefined;
        this.post({ type: 'state', state });
        void this.refreshRules();
        return;
      }
      case 'setSetting': {
        if (!isSettingKey(msg.key)) throw new Error(`Unknown setting ${String(msg.key)}`);
        const value = coerceValue(msg.key, msg.value);
        const { shadowed } = await writeValue(msg.key, value);
        this.log.debug(`set kursor.${msg.key} = ${JSON.stringify(value)}`);
        if (shadowed) this.toast('warning', `Saved to your user settings, but kursor.${msg.key} is overridden in this workspace.`);
        this.scheduleSettingsPost();
        return;
      }
      case 'resetSetting': {
        if (!isSettingKey(msg.key)) throw new Error(`Unknown setting ${String(msg.key)}`);
        await writeValue(msg.key, undefined);
        this.log.debug(`reset kursor.${msg.key}`);
        this.scheduleSettingsPost();
        return;
      }
      case 'refreshStatus': {
        if (this.claude.checking) return;
        this.claude = { ...this.claude, checking: true };
        this.post({ type: 'claudeStatus', status: this.claude });
        try {
          const s = await this.deps.bridge.refreshStatus();
          this.claude = this.toStatusInfo(s, false);
        } catch (err) {
          this.claude = { ...this.claude, ok: false, checking: false, error: err instanceof Error ? err.message : String(err), checkedAt: Date.now() };
        }
        this.post({ type: 'claudeStatus', status: this.claude });
        return;
      }
      case 'refreshRules':
        await this.postWorkspace();
        await this.refreshRules();
        return;
      case 'selectFolder': {
        if (typeof msg.path !== 'string' || !isWorkspaceFolderPath(msg.path)) throw new Error('Not a workspace folder');
        this.cwd = msg.path;
        await this.postWorkspace();
        await this.refreshRules();
        return;
      }
      case 'newRule': {
        const created = await createNewRuleInteractive(this.log, this.cwd);
        if (created) {
          this.toast('info', `Created ${path.basename(created)}`);
          await this.refreshRules();
        }
        return;
      }
      case 'openRule':
      case 'openFile': {
        if (typeof msg.path !== 'string') throw new Error('Missing path');
        await openPathFromPanel(msg.path);
        return;
      }
      case 'openCursorignore': {
        if (!this.cwd) throw new Error('Open a folder first — .cursorignore lives at the workspace root.');
        const created = await openOrCreateCursorignore(this.cwd);
        if (created) this.toast('info', 'Created .cursorignore');
        await this.postWorkspace();
        return;
      }
      case 'openGitignore': {
        if (!this.cwd) throw new Error('Open a folder first.');
        await openGitignore(this.cwd);
        await this.postWorkspace();
        return;
      }
      case 'openUrl': {
        if (typeof msg.url !== 'string' || !/^https?:\/\//i.test(msg.url)) throw new Error('Only http(s) links can be opened');
        await vscode.env.openExternal(vscode.Uri.parse(msg.url));
        return;
      }
      case 'openEditorSettings': {
        const query = typeof msg.query === 'string' && msg.query.trim() ? msg.query.trim() : '@ext:kursor.kursor';
        const command = msg.scope === 'workspace' ? 'workbench.action.openWorkspaceSettings' : 'workbench.action.openSettings';
        await vscode.commands.executeCommand(command, query);
        return;
      }
      case 'runCommand': {
        if (typeof msg.command !== 'string' || !ALLOWED_COMMANDS.has(msg.command)) throw new Error(`Command ${String(msg.command)} is not available from the settings panel`);
        await vscode.commands.executeCommand(msg.command, ...(Array.isArray(msg.args) ? msg.args : []));
        return;
      }
      case 'tabChanged':
        return; // persisted by the webview itself (setState); nothing to do host-side
      case 'log': {
        const text = typeof msg.text === 'string' ? msg.text : String(msg.text);
        if (msg.level === 'error') this.log.error(`[panel] ${text}`);
        else if (msg.level === 'warn') this.log.warn(`[panel] ${text}`);
        else this.log.info(`[panel] ${text}`);
        return;
      }
      default: {
        const unknown = msg as { type: string };
        this.log.debug(`ignoring unknown panel message ${unknown.type}`);
      }
    }
  }
}

function kindOrder(kind: RuleListItem['kind']): number {
  switch (kind) {
    case 'always':
      return 0;
    case 'auto':
      return 1;
    case 'agent':
      return 2;
    case 'manual':
      return 3;
    case 'legacy':
      return 4;
    default:
      return 5;
  }
}

/** Render a path with `~` for the home directory (for logs / toasts). */
export function tildify(p: string): string {
  if (HOME && (p === HOME || p.startsWith(HOME + path.sep))) return '~' + p.slice(HOME.length);
  return p;
}
