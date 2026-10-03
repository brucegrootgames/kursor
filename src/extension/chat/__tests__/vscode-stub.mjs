/** Minimal `vscode` stand-in for bundling runner.ts/state.ts in plain node. */
export class Disposable {
  constructor(fn) {
    this.fn = fn;
  }
  dispose() {
    this.fn?.();
  }
}
export class EventEmitter {
  constructor() {
    this.listeners = new Set();
    this.event = (l) => {
      this.listeners.add(l);
      return new Disposable(() => this.listeners.delete(l));
    };
  }
  fire(v) {
    for (const l of [...this.listeners]) l(v);
  }
  dispose() {
    this.listeners.clear();
  }
}
export const workspace = { asRelativePath: (p) => String(p).replace(/^\/w\//, ''), getConfiguration: () => ({ get: (_k, d) => d }), workspaceFolders: [] };
export const window = { activeTextEditor: undefined };
export const commands = { executeCommand: async () => undefined };
export class Uri {
  static file(p) {
    return { fsPath: p, scheme: 'file', path: p };
  }
}
