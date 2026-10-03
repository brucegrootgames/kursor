/**
 * MCP `Transport` over a single server-side `ws` WebSocket: one JSON-RPC message per text frame.
 * Mirrors what the `claude` CLI expects from an IDE (`ws-ide` transport, subprotocol "mcp").
 */
import { WebSocket, type RawData } from 'ws';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { JSONRPCMessageSchema, type JSONRPCMessage, type MessageExtraInfo } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '../util/log';

function rawDataToString(data: RawData, isBinary: boolean): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  // Buffer (text frames arrive as Buffer too); binary frames are tolerated as UTF-8 JSON.
  void isBinary;
  return data.toString('utf8');
}

function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export class WebSocketServerTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(message: T, extra?: MessageExtraInfo) => void;
  sessionId?: string;

  private started = false;
  private closed = false;
  /** Frames that arrive before `start()`; flushed once the protocol layer is listening. */
  private readonly pending: JSONRPCMessage[] = [];

  constructor(
    private readonly ws: WebSocket,
    private readonly log: Logger,
  ) {
    ws.on('message', this.handleMessage);
    ws.on('error', this.handleError);
    ws.on('close', this.handleClose);
  }

  get isOpen(): boolean {
    return this.ws.readyState === WebSocket.OPEN;
  }

  async start(): Promise<void> {
    if (this.started) throw new Error('WebSocketServerTransport.start() may only be called once');
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error('WebSocket is not open');
    this.started = true;
    const queued = this.pending.splice(0);
    for (const message of queued) this.dispatch(message);
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this.ws.readyState !== WebSocket.OPEN) throw new Error('WebSocket is not open; cannot send message');
    const text = JSON.stringify(message);
    await new Promise<void>((resolve, reject) => {
      this.ws.send(text, (err) => (err ? reject(err) : resolve()));
    });
  }

  async close(): Promise<void> {
    this.closeWith(1000, 'IDE bridge closed the connection');
  }

  /** Close with a specific status code (1000 normal, 1001 going away, 1011 server error…). */
  closeWith(code: number, reason: string): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      try {
        this.ws.close(code, reason);
      } catch (err) {
        this.log.debug('ws close failed', err);
      }
    }
    this.handleClose();
  }

  private dispatch(message: JSONRPCMessage): void {
    try {
      this.onmessage?.(message);
    } catch (err) {
      this.log.error('unhandled error in MCP message handler', err);
      this.onerror?.(toError(err));
    }
  }

  private readonly handleMessage = (data: RawData, isBinary: boolean): void => {
    let parsed: JSONRPCMessage;
    try {
      parsed = JSONRPCMessageSchema.parse(JSON.parse(rawDataToString(data, isBinary)));
    } catch (err) {
      this.log.warn('dropping malformed JSON-RPC frame', err);
      this.onerror?.(toError(err));
      return;
    }
    if (!this.started) {
      this.pending.push(parsed);
      return;
    }
    this.dispatch(parsed);
  };

  private readonly handleError = (err: Error): void => {
    this.onerror?.(err);
  };

  private readonly handleClose = (): void => {
    if (this.closed) return;
    this.closed = true;
    this.ws.off('message', this.handleMessage);
    this.ws.off('error', this.handleError);
    this.ws.off('close', this.handleClose);
    try {
      this.onclose?.();
    } catch (err) {
      this.log.error('error in transport onclose handler', err);
    }
  };
}
