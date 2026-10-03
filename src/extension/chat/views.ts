/**
 * Webview hosts: the `kursor.chat` side-bar view (WebviewViewProvider, retained
 * when hidden) and the "Open Chat in Editor" WebviewPanel (`kursor.chatPanel`).
 * Both load the same HTML and share the ChatManager/ChatStore. Messages posted
 * before a webview reports `ready` are queued (bounded) and flushed on ready.
 */
import * as vscode from 'vscode';
import type { HostToWebview, WebviewToHost } from '../../shared/protocol';
import type { Logger } from '../util/log';
import { chatHtml } from './html';
import type { ChatManager, WebviewHostLike } from './manager';

export const VIEW_ID = 'kursor.chat';
export const PANEL_VIEW_TYPE = 'kursor.chatPanel';
const READY_QUEUE_LIMIT = 30;

export type MessageHandler = (msg: WebviewToHost, host: WebviewHost) => Promise<void> | void;

export class WebviewHost implements WebviewHostLike, vscode.Disposable {
  ready = false;
  private readonly queue: HostToWebview[] = [];
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    readonly kind: 'view' | 'panel',
    private readonly webview: vscode.Webview,
    private readonly isVisible: () => boolean,
    private readonly manager: ChatManager,
    private readonly onMessage: MessageHandler,
    private readonly log: Logger,
  ) {
    this.disposables.push(
      webview.onDidReceiveMessage((raw: unknown) => {
        const msg = raw as WebviewToHost;
        if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
        if (msg.type === 'ready') {
          this.ready = true;
          manager.syncHost(this);
          for (const m of this.queue.splice(0)) this.post(m);
          return;
        }
        void Promise.resolve(onMessage(msg, this)).catch((err: unknown) => {
          log.error(`webview message ${msg.type} failed`, err);
          const text = err instanceof Error ? err.message : String(err);
          this.post({ type: 'toast', level: 'error', text });
        });
      }),
      manager.registerHost(this),
    );
  }

  get visible(): boolean {
    return this.isVisible();
  }

  post(msg: HostToWebview): void {
    if (!this.ready) {
      if (msg.type === 'appState' || msg.type === 'chatState' || msg.type === 'textDelta') return; // synced on ready
      this.queue.push(msg);
      if (this.queue.length > READY_QUEUE_LIMIT) this.queue.shift();
      return;
    }
    void this.webview.postMessage(msg).then(
      (ok) => {
        if (!ok) this.log.debug(`postMessage(${msg.type}) not delivered`);
      },
      (err: unknown) => this.log.debug(`postMessage(${msg.type}) failed`, err),
    );
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.queue.length = 0;
  }
}

export class ChatViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private host: WebviewHost | undefined;
  private badgeCount = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: ChatManager,
    private readonly onMessage: MessageHandler,
    private readonly log: Logger,
  ) {}

  get visible(): boolean {
    return this.view?.visible ?? false;
  }

  get resolved(): boolean {
    return !!this.view;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')] };
    webviewView.webview.html = chatHtml(webviewView.webview, this.extensionUri);
    webviewView.title = 'Chat';
    this.host?.dispose();
    this.host = new WebviewHost('view', webviewView.webview, () => webviewView.visible, this.manager, this.onMessage, this.log);
    const subs: vscode.Disposable[] = [
      webviewView.onDidChangeVisibility(() => {
        if (webviewView.visible) {
          this.clearBadge();
          const active = this.manager.store.active();
          if (active?.unread) {
            active.unread = false;
            this.manager.postAppState();
          }
        }
      }),
    ];
    webviewView.onDidDispose(() => {
      for (const s of subs) s.dispose();
      this.host?.dispose();
      this.host = undefined;
      this.view = undefined;
    });
  }

  async reveal(focus = true): Promise<void> {
    if (this.view) {
      this.view.show(!focus);
      if (focus) await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    } else {
      await vscode.commands.executeCommand(`${VIEW_ID}.focus`);
    }
  }

  setBadge(count: number, tooltip: string): void {
    this.badgeCount = count;
    if (!this.view) return;
    this.view.badge = count > 0 ? { value: count, tooltip } : undefined;
  }

  clearBadge(): void {
    if (this.badgeCount) this.setBadge(0, '');
  }

  dispose(): void {
    this.host?.dispose();
  }
}

export class ChatPanelController implements vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private host: WebviewHost | undefined;

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly manager: ChatManager,
    private readonly onMessage: MessageHandler,
    private readonly log: Logger,
  ) {
    context.subscriptions.push(
      vscode.window.registerWebviewPanelSerializer(PANEL_VIEW_TYPE, {
        deserializeWebviewPanel: async (panel) => {
          this.attach(panel);
        },
      }),
    );
  }

  get visible(): boolean {
    return this.panel?.visible ?? false;
  }

  open(): void {
    if (this.panel) {
      this.panel.reveal(undefined, false);
      return;
    }
    const panel = vscode.window.createWebviewPanel(PANEL_VIEW_TYPE, 'Kursor Chat', { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, {
      enableScripts: true,
      retainContextWhenHidden: true,
      enableFindWidget: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist'), vscode.Uri.joinPath(this.context.extensionUri, 'media')],
    });
    this.attach(panel);
  }

  private attach(panel: vscode.WebviewPanel): void {
    this.panel?.dispose();
    this.panel = panel;
    panel.iconPath = vscode.Uri.joinPath(this.context.extensionUri, 'media', 'kursor-activity.svg');
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist'), vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    panel.webview.html = chatHtml(panel.webview, this.context.extensionUri);
    this.host?.dispose();
    this.host = new WebviewHost('panel', panel.webview, () => panel.visible, this.manager, this.onMessage, this.log);
    panel.onDidDispose(() => {
      this.host?.dispose();
      this.host = undefined;
      if (this.panel === panel) this.panel = undefined;
    });
  }

  dispose(): void {
    this.host?.dispose();
    this.panel?.dispose();
  }
}
