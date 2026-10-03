// Minimal stand-in for the `vscode` module, enough to exercise server.ts/tools.ts outside the extension host.
export class EventEmitter {
  constructor() { this.listeners = new Set(); this.event = (listener) => { this.listeners.add(listener); return new Disposable(() => this.listeners.delete(listener)); }; }
  fire(value) { for (const l of [...this.listeners]) l(value); }
  dispose() { this.listeners.clear(); }
}
export class Disposable { constructor(fn) { this.fn = fn; } dispose() { this.fn?.(); this.fn = undefined; } }
export class MarkdownString { constructor(value) { this.value = value; } }
export class Position { constructor(line, character) { this.line = line; this.character = character; } }
export class Range { constructor(start, end) { this.start = start; this.end = end; } }
export class Selection extends Range { constructor(anchor, active) { super(anchor, active); this.anchor = anchor; this.active = active; this.isEmpty = anchor.line === active.line && anchor.character === active.character; this.isReversed = false; } }
export const DiagnosticSeverity = { 0: 'Error', 1: 'Warning', 2: 'Information', 3: 'Hint', Error: 0, Warning: 1, Information: 2, Hint: 3 };
export const TextEditorRevealType = { InCenter: 2 };
export const FileType = { File: 1, Directory: 2 };
export const FileChangeType = { Changed: 1, Created: 2, Deleted: 3 };
export const TextDocumentChangeReason = { Undo: 1, Redo: 2 };
export class TabInputText { constructor(uri) { this.uri = uri; } }
export class TabInputTextDiff { constructor(original, modified) { this.original = original; this.modified = modified; } }
export class FileSystemError extends Error { static FileNotFound(u) { return new FileSystemError(`not found ${u}`); } static FileExists(u) { return new FileSystemError(`exists ${u}`); } static NoPermissions(u) { return new FileSystemError(`no permissions ${u}`); } }

export class Uri {
  constructor(scheme, path, query = '', fragment = '') { this.scheme = scheme; this.path = path; this.query = query; this.fragment = fragment; }
  get fsPath() { return this.path; }
  static file(p) { return new Uri('file', p); }
  static parse(s) { const m = /^([a-z][a-z0-9+.-]*):(?:\/\/)?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/i.exec(s); return m ? new Uri(m[1], decodeURIComponent(m[2]), m[3] ?? '', m[4] ?? '') : Uri.file(s); }
  with(change) { return new Uri(change.scheme ?? this.scheme, change.path ?? this.path, change.query ?? this.query, change.fragment ?? this.fragment); }
  toString() { return `${this.scheme}://${this.path}${this.query ? `?${this.query}` : ''}${this.fragment ? `#${this.fragment}` : ''}`; }
}

const foldersEmitter = new EventEmitter();
const configEmitter = new EventEmitter();
export const state = {
  workspaceFolders: [{ name: 'proj', uri: Uri.file('/tmp/proj'), index: 0 }],
  textDocuments: [],
  activeTextEditor: undefined,
  tabGroups: [],
  diagnostics: [],
  contextKeys: {},
  commands: new Map(),
};
export const workspace = {
  get workspaceFolders() { return state.workspaceFolders; },
  get textDocuments() { return state.textDocuments; },
  workspaceFile: undefined,
  onDidChangeWorkspaceFolders: foldersEmitter.event,
  onDidChangeConfiguration: configEmitter.event,
  onDidChangeTextDocument: () => new Disposable(),
  onWillSaveTextDocument: () => new Disposable(),
  registerFileSystemProvider: () => new Disposable(),
  getConfiguration: () => ({ get: (_k, d) => d }),
  fs: { stat: async () => ({}) },
  openTextDocument: async () => { throw new Error('not mocked'); },
  fireFoldersChanged: () => foldersEmitter.fire({ added: [], removed: [] }),
};
export const window = {
  get activeTextEditor() { return state.activeTextEditor; },
  get visibleTextEditors() { return state.activeTextEditor ? [state.activeTextEditor] : []; },
  tabGroups: { get all() { return state.tabGroups; }, get activeTabGroup() { return state.tabGroups[0] ?? { tabs: [] }; }, onDidChangeTabs: () => new Disposable(), close: async () => true },
  onDidChangeVisibleTextEditors: () => new Disposable(),
  onDidChangeTextEditorSelection: () => new Disposable(),
  onDidChangeActiveTextEditor: () => new Disposable(),
  showInformationMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  showTextDocument: async () => state.activeTextEditor,
};
export const languages = { getDiagnostics: (uri) => (uri ? state.diagnostics.find(([u]) => u.toString() === uri.toString())?.[1] ?? [] : state.diagnostics) };
export const commands = {
  registerCommand: (id, fn) => { state.commands.set(id, fn); return new Disposable(() => state.commands.delete(id)); },
  executeCommand: async (id, ...args) => { if (id === 'setContext') { state.contextKeys[args[0]] = args[1]; return; } const fn = state.commands.get(id); return fn ? fn(...args) : undefined; },
};
export const env = { appName: 'Kursor (mock)' };
export class EnvCollection {
  constructor() { this.map = new Map(); this.persistent = true; this.description = undefined; }
  replace(k, v) { this.map.set(k, v); }
  get(k) { const v = this.map.get(k); return v === undefined ? undefined : { value: v }; }
  delete(k) { this.map.delete(k); }
}
