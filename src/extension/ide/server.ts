/**
 * WebSocket + MCP server the `claude` CLI connects to from Kursor's integrated terminal.
 *
 *   http.Server (127.0.0.1:<random 10000-65535>) ─ upgrade ─▶ ws (subprotocol "mcp")
 *     ├─ auth: header `x-claude-code-ide-authorization` must equal the lock file's authToken
 *     ├─ one client at a time (a newer `claude` replaces the previous connection)
 *     └─ per connection: McpServer + WebSocketServerTransport (tools from tools.ts)
 *   ~/.claude/ide/<port>.lock (0600, dir 0700, rewritten on workspace-folder changes)
 *   environmentVariableCollection: CLAUDE_CODE_SSE_PORT=<port>, CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL=true
 */
import * as http from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { Duplex } from 'node:stream';
import * as vscode from 'vscode';
import { WebSocketServer, type WebSocket } from 'ws';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '../util/log';
import { buildLockPayload, deleteLockFile, ideLockDir, writeLockFile } from './lockFile';
import { findFreePort, isLoopbackAddress, LOOPBACK_HOST } from './port';
import { registerIdeTools, type IdeToolHost } from './tools';
import { WebSocketServerTransport } from './wsTransport';

export const AUTH_HEADER = 'x-claude-code-ide-authorization';
export const SSE_PORT_ENV = 'CLAUDE_CODE_SSE_PORT';
/** Stops the CLI from trying to install the reference extension into Kursor when it sees TERM_PROGRAM=vscode. */
export const SKIP_AUTO_INSTALL_ENV = 'CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL';
const LISTEN_ATTEMPTS = 5;

export interface IdeServerOptions {
  /** `vscode.env.appName` — written to the lock file as `ideName`. */
  ideName: string;
  /** Extension version, reported as the MCP server version. */
  version: string;
  workspaceFolders: () => string[];
  env: vscode.GlobalEnvironmentVariableCollection;
  /** Override for tests; defaults to `<claude config dir>/ide`. */
  lockDir?: string;
}

export interface IdeClient {
  readonly remotePid: number | undefined;
  readonly clientName: string | undefined;
  notify(method: string, params: Record<string, unknown>): Promise<void>;
}

class ClientConnection implements IdeClient {
  readonly mcp: McpServer;
  readonly transport: WebSocketServerTransport;
  remotePid: number | undefined;
  private readonly closeEmitter = new vscode.EventEmitter<void>();
  readonly onDidClose = this.closeEmitter.event;
  private closed = false;

  constructor(
    ws: WebSocket,
    readonly remote: string,
    private readonly log: Logger,
    host: IdeToolHost,
    info: { name: string; version: string },
  ) {
    this.mcp = new McpServer({ name: info.name, version: info.version }, { capabilities: { tools: {} } });
    registerIdeTools(this.mcp, host, log);
    this.mcp.server.oninitialized = () => {
      const client = this.mcp.server.getClientVersion();
      log.info(`client initialized: ${client?.name ?? 'unknown'} ${client?.version ?? ''}`.trim());
    };
    this.mcp.server.fallbackNotificationHandler = async (notification) => {
      if (notification.method === 'ide_connected') {
        const pid = (notification.params as { pid?: unknown } | undefined)?.pid;
        this.remotePid = typeof pid === 'number' ? pid : undefined;
        log.info(`claude connected (pid ${this.remotePid ?? '?'})`);
        return;
      }
      log.debug(`notification from client: ${notification.method}`);
    };
    this.mcp.server.onerror = (err) => log.warn('MCP protocol error', err);
    this.transport = new WebSocketServerTransport(ws, log);
    this.transport.onclose = () => this.markClosed();
  }

  get clientName(): string | undefined {
    return this.mcp.server.getClientVersion()?.name;
  }

  async connect(): Promise<void> {
    const onclose = this.transport.onclose;
    await this.mcp.connect(this.transport);
    // McpServer.connect() takes over the transport callbacks; chain our close bookkeeping after its own.
    const sdkOnClose = this.transport.onclose;
    this.transport.onclose = () => {
      sdkOnClose?.();
      onclose?.();
    };
  }

  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    if (!this.transport.isOpen) return;
    const message: JSONRPCMessage = { jsonrpc: '2.0', method, params };
    await this.transport.send(message);
  }

  close(code: number, reason: string): void {
    this.transport.closeWith(code, reason);
    this.markClosed();
  }

  private markClosed(): void {
    if (this.closed) return;
    this.closed = true;
    this.closeEmitter.fire();
    this.closeEmitter.dispose();
  }
}

export class IdeServer implements vscode.Disposable {
  private httpServer: http.Server | undefined;
  private wss: WebSocketServer | undefined;
  private port: number | undefined;
  private authToken: string | undefined;
  private client: ClientConnection | undefined;
  private readonly lockDir: string;
  private readonly clientEmitter = new vscode.EventEmitter<IdeClient | undefined>();
  private readonly disposables: vscode.Disposable[] = [];
  /** Fires with the client after its MCP handshake completes, and with `undefined` when it goes away. */
  readonly onDidChangeClient = this.clientEmitter.event;

  constructor(
    private readonly log: Logger,
    private readonly options: IdeServerOptions,
    private readonly host: IdeToolHost,
  ) {
    this.lockDir = options.lockDir ?? ideLockDir();
    this.disposables.push(
      this.clientEmitter,
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refreshLockFile()),
    );
  }

  get isRunning(): boolean {
    return this.httpServer !== undefined;
  }

  get listeningPort(): number | undefined {
    return this.port;
  }

  get isConnected(): boolean {
    return this.client !== undefined && this.client.transport.isOpen;
  }

  get currentClient(): IdeClient | undefined {
    return this.isConnected ? this.client : undefined;
  }

  async start(): Promise<number> {
    if (this.httpServer && this.port !== undefined) return this.port;
    this.authToken = randomUUID();
    const port = await this.listen();
    this.port = port;
    try {
      const lockPath = this.refreshLockFile();
      this.options.env.persistent = false;
      this.options.env.description = new vscode.MarkdownString('Kursor IDE bridge: lets a `claude` CLI started in this terminal connect to the editor.');
      this.options.env.replace(SSE_PORT_ENV, String(port));
      this.options.env.replace(SKIP_AUTO_INSTALL_ENV, 'true');
      this.log.info(`IDE bridge listening on ws://${LOOPBACK_HOST}:${port} (lock file ${lockPath ?? 'not written'})`);
    } catch (err) {
      await this.stop('start failed');
      throw err;
    }
    return port;
  }

  async stop(reason: string): Promise<void> {
    const port = this.port;
    const httpServer = this.httpServer;
    const wss = this.wss;
    const client = this.client;
    this.httpServer = undefined;
    this.wss = undefined;
    this.port = undefined;
    this.client = undefined;
    this.authToken = undefined;

    // Synchronous cleanup first so it also runs during extension deactivation.
    if (port !== undefined) {
      try {
        deleteLockFile(this.lockDir, port);
      } catch (err) {
        this.log.warn('could not delete lock file', err);
      }
    }
    try {
      this.options.env.delete(SSE_PORT_ENV);
      this.options.env.delete(SKIP_AUTO_INSTALL_ENV);
    } catch (err) {
      this.log.warn('could not clear terminal environment', err);
    }
    if (client) {
      client.close(1001, `IDE bridge stopping (${reason})`);
      this.clientEmitter.fire(undefined);
    }
    if (wss) {
      for (const socket of wss.clients) {
        try {
          socket.terminate();
        } catch {
          // ignore
        }
      }
      wss.close();
    }
    if (httpServer) {
      httpServer.closeAllConnections();
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    }
    if (port !== undefined) this.log.info(`IDE bridge stopped (${reason})`);
  }

  /** Sends a JSON-RPC notification to the connected client; no-op when nobody is connected. */
  async notify(method: string, params: Record<string, unknown>): Promise<void> {
    const client = this.client;
    if (!client || !client.transport.isOpen) return;
    try {
      await client.notify(method, params);
    } catch (err) {
      this.log.warn(`failed to send ${method}`, err);
    }
  }

  dispose(): void {
    void this.stop('extension deactivated').catch((err) => this.log.warn('stop failed', err));
    for (const d of this.disposables.splice(0)) d.dispose();
  }

  // ---- internals ----------------------------------------------------------------------------

  private refreshLockFile(): string | undefined {
    if (this.port === undefined || !this.authToken) return undefined;
    try {
      const payload = buildLockPayload({ workspaceFolders: this.options.workspaceFolders(), ideName: this.options.ideName, authToken: this.authToken });
      const file = writeLockFile(this.lockDir, this.port, payload);
      this.log.debug(`lock file written: ${file} (${payload.workspaceFolders.length} folder(s))`);
      return file;
    } catch (err) {
      this.log.error('could not write the IDE lock file', err);
      throw err;
    }
  }

  private async listen(): Promise<number> {
    let lastError: unknown;
    for (let attempt = 0; attempt < LISTEN_ATTEMPTS; attempt++) {
      const port = await findFreePort();
      const server = http.createServer((_req, res) => {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/plain');
        res.end('Kursor IDE bridge: WebSocket only');
      });
      const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
      server.on('upgrade', (req, socket, head) => this.handleUpgrade(wss, req, socket, head));
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (err: Error): void => reject(err);
          server.once('error', onError);
          server.listen(port, LOOPBACK_HOST, () => {
            server.off('error', onError);
            resolve();
          });
        });
      } catch (err) {
        lastError = err;
        wss.close();
        if ((err as NodeJS.ErrnoException).code === 'EADDRINUSE') {
          this.log.debug(`port ${port} taken between probe and listen; retrying`);
          continue;
        }
        throw err;
      }
      server.on('error', (err) => this.log.error('IDE bridge http server error', err));
      wss.on('error', (err) => this.log.error('IDE bridge websocket server error', err));
      this.httpServer = server;
      this.wss = wss;
      return port;
    }
    throw lastError instanceof Error ? lastError : new Error('could not bind the IDE bridge port');
  }

  private handleUpgrade(wss: WebSocketServer, req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const remote = `${req.socket.remoteAddress ?? '?'}:${req.socket.remotePort ?? '?'}`;
    const header = req.headers[AUTH_HEADER];
    const token = Array.isArray(header) ? header[0] : header;
    if (!isLoopbackAddress(req.socket.remoteAddress) || !this.authToken || !token || !safeEqual(token, this.authToken)) {
      this.log.warn(`rejected unauthorized IDE connection from ${remote}`);
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => this.onConnection(ws, remote));
  }

  private onConnection(ws: WebSocket, remote: string): void {
    this.log.info(`IDE client connected from ${remote}`);
    const previous = this.client;
    if (previous) {
      this.log.info('replacing the previous IDE client (one client at a time)');
      this.client = undefined;
      previous.close(1000, 'Replaced by a newer client');
      this.clientEmitter.fire(undefined);
    }
    const conn = new ClientConnection(ws, remote, this.log, this.host, { name: 'Kursor IDE', version: this.options.version });
    this.client = conn;
    conn.onDidClose(() => {
      if (this.client !== conn) return;
      this.client = undefined;
      this.log.info(`IDE client disconnected (${remote})`);
      this.clientEmitter.fire(undefined);
    });
    conn
      .connect()
      .then(() => {
        if (this.client !== conn) return;
        this.log.debug('MCP server attached to the websocket transport');
        this.clientEmitter.fire(conn);
      })
      .catch((err: unknown) => {
        this.log.error('MCP connect failed', err);
        conn.close(1011, 'MCP connect failed');
      });
  }
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
