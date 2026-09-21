import * as vscode from 'vscode';

export interface Logger {
  info(msg: string, ...args: unknown[]): void;
  warn(msg: string, ...args: unknown[]): void;
  error(msg: string, ...args: unknown[]): void;
  debug(msg: string, ...args: unknown[]): void;
  show(): void;
  child(prefix: string): Logger;
}

function fmt(args: unknown[]): string {
  return args
    .map((a) => {
      if (a instanceof Error) return `${a.message}${a.stack ? `\n${a.stack}` : ''}`;
      if (typeof a === 'string') return a;
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    })
    .join(' ');
}

export function createLogger(context: vscode.ExtensionContext): Logger {
  const channel = vscode.window.createOutputChannel('Kursor', { log: true });
  context.subscriptions.push(channel);
  const make = (prefix: string): Logger => ({
    info: (m, ...a) => channel.info(`${prefix}${m}${a.length ? ' ' + fmt(a) : ''}`),
    warn: (m, ...a) => channel.warn(`${prefix}${m}${a.length ? ' ' + fmt(a) : ''}`),
    error: (m, ...a) => channel.error(`${prefix}${m}${a.length ? ' ' + fmt(a) : ''}`),
    debug: (m, ...a) => channel.debug(`${prefix}${m}${a.length ? ' ' + fmt(a) : ''}`),
    show: () => channel.show(true),
    child: (p) => make(`${prefix}[${p}] `),
  });
  return make('');
}
