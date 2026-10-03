#!/usr/bin/env node
/**
 * Kursor smoke test: load dist/extension.js OUTSIDE VS Code with a stubbed `vscode` module,
 * call activate(), list the registered `kursor.*` commands and compare them with package.json
 * (commands, keybindings, menus), resolve the chat webview + settings panel once, then
 * deactivate/dispose everything and exit.
 *
 *   node esbuild.mjs && node scripts/smoke-load.mjs [--verbose] [--json]
 *
 * Exit code 0 = no real problems found. Stub limitations are reported separately
 * ("stub fallbacks") and are NOT failures.
 *
 * The stub sets `kursor.ide.enableServer=false` so no WebSocket server / lock file is created.
 * The Claude bridge still probes the user's `claude` binary (`--version`, `auth status`) — that
 * costs no quota. Override any setting with KURSOR_SMOKE_CONFIG='{"kursor.claude.path":"/x"}'.
 */
import Module from 'node:module';
import { createRequire } from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const VERBOSE = process.argv.includes('--verbose');
const JSON_OUT = process.argv.includes('--json');
const ACTIVATE_TIMEOUT_MS = 20_000;
const HARD_EXIT_MS = 60_000;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const distEntry = path.join(root, 'dist', 'extension.js');
if (!fs.existsSync(distEntry)) {
  console.error('smoke-load: dist/extension.js is missing — run `node esbuild.mjs` first');
  process.exit(2);
}

// ---------------------------------------------------------------------------------------------
// Bookkeeping
// ---------------------------------------------------------------------------------------------
const problems = [];
const warnings = [];
const fallbacks = new Set();
const logLines = { info: 0, warn: 0, error: 0, debug: 0 };
const logErrors = [];
const logWarnings = [];
const registeredCommands = new Map();
const contextKeys = new Map();
const executedCommands = [];
const disposeErrors = [];

const problem = (msg) => problems.push(msg);
const warn = (msg) => warnings.push(msg);
const vlog = (...a) => {
  if (VERBOSE) console.log('[smoke]', ...a);
};

process.on('unhandledRejection', (err) => problem(`unhandled rejection: ${err instanceof Error ? err.stack ?? err.message : String(err)}`));
process.on('uncaughtException', (err) => problem(`uncaught exception: ${err instanceof Error ? err.stack ?? err.message : String(err)}`));

// Never let a hung child process keep us alive forever.
setTimeout(() => {
  problem(`process did not exit within ${HARD_EXIT_MS} ms (hung timer or child process)`);
  finish(true);
}, HARD_EXIT_MS).unref();

// ---------------------------------------------------------------------------------------------
// Generic "anything goes" proxy for API surface we did not model explicitly.
// Calls return another proxy, `dispose()` is a no-op, `then` is undefined (never thenable).
// ---------------------------------------------------------------------------------------------
function anyProxy(name) {
  const target = function stub() {};
  return new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') return undefined;
      if (typeof prop === 'string' && prop !== 'dispose') fallbacks.add(`${name}.${prop}`);
      if (prop === 'dispose') return () => undefined;
      if (prop === Symbol.toPrimitive) return () => `[stub ${name}]`;
      if (prop === Symbol.iterator) return function* () {};
      if (prop === Symbol.toStringTag) return `stub ${name}`;
      if (prop === 'toString' || prop === 'toJSON') return () => `[stub ${name}]`;
      if (prop === 'length') return 0;
      return anyProxy(`${name}.${String(prop)}`);
    },
    apply() {
      fallbacks.add(`${name}()`);
      return anyProxy(`${name}()`);
    },
    construct() {
      fallbacks.add(`new ${name}`);
      return anyProxy(`new ${name}`);
    },
    has() {
      return true;
    },
  });
}

/** Wrap a concrete namespace so unknown members fall back to anyProxy (and are recorded). */
function withFallback(obj, name) {
  return new Proxy(obj, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'then') return undefined;
      fallbacks.add(`${name}.${String(prop)}`);
      return anyProxy(`${name}.${String(prop)}`);
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Core value types
// ---------------------------------------------------------------------------------------------
class Disposable {
  constructor(fn) {
    this._fn = fn;
  }
  dispose() {
    const fn = this._fn;
    this._fn = undefined;
    fn?.();
  }
  static from(...items) {
    return new Disposable(() => {
      for (const d of items) d?.dispose?.();
    });
  }
}

class EventEmitter {
  constructor() {
    this._listeners = new Set();
    this.event = (listener, thisArgs, disposables) => {
      const bound = thisArgs ? listener.bind(thisArgs) : listener;
      this._listeners.add(bound);
      const d = new Disposable(() => this._listeners.delete(bound));
      if (Array.isArray(disposables)) disposables.push(d);
      return d;
    };
  }
  fire(value) {
    for (const l of [...this._listeners]) {
      try {
        l(value);
      } catch (err) {
        problem(`event listener threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      }
    }
  }
  dispose() {
    this._listeners.clear();
  }
}

class CancellationTokenSource {
  constructor() {
    this._emitter = new EventEmitter();
    const self = this;
    this.token = {
      get isCancellationRequested() {
        return self._cancelled === true;
      },
      onCancellationRequested: this._emitter.event,
    };
  }
  cancel() {
    if (this._cancelled) return;
    this._cancelled = true;
    this._emitter.fire(undefined);
  }
  dispose() {
    this._emitter.dispose();
  }
}
class CancellationError extends Error {
  constructor() {
    super('Canceled');
    this.name = 'Canceled';
  }
}

class Uri {
  constructor(scheme, authority, p, query, fragment) {
    this.scheme = scheme;
    this.authority = authority ?? '';
    this.path = p ?? '';
    this.query = query ?? '';
    this.fragment = fragment ?? '';
  }
  get fsPath() {
    return this.path;
  }
  static file(p) {
    return new Uri('file', '', path.resolve(p), '', '');
  }
  static parse(value) {
    const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):(?:\/\/([^/?#]*))?([^?#]*)(?:\?([^#]*))?(?:#(.*))?$/.exec(value);
    if (!m) return Uri.file(value);
    return new Uri(m[1], m[2] ?? '', decodeURIComponent(m[3] ?? ''), m[4] ?? '', m[5] ?? '');
  }
  static from(c) {
    return new Uri(c.scheme, c.authority, c.path, c.query, c.fragment);
  }
  static joinPath(base, ...segments) {
    return base.with({ path: path.posix.join(base.path, ...segments) });
  }
  with(change) {
    return new Uri(
      change.scheme ?? this.scheme,
      change.authority ?? this.authority,
      change.path ?? this.path,
      change.query ?? this.query,
      change.fragment ?? this.fragment,
    );
  }
  toString() {
    const auth = this.authority || this.scheme !== 'file' ? `//${this.authority}` : '//';
    return `${this.scheme}:${auth}${encodeURI(this.path)}${this.query ? `?${this.query}` : ''}${this.fragment ? `#${this.fragment}` : ''}`;
  }
  toJSON() {
    return { scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment, fsPath: this.fsPath };
  }
}

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
  isBefore(o) {
    return this.line < o.line || (this.line === o.line && this.character < o.character);
  }
  isBeforeOrEqual(o) {
    return this.isBefore(o) || this.isEqual(o);
  }
  isAfter(o) {
    return o.isBefore(this);
  }
  isAfterOrEqual(o) {
    return !this.isBefore(o);
  }
  isEqual(o) {
    return this.line === o.line && this.character === o.character;
  }
  compareTo(o) {
    return this.isBefore(o) ? -1 : this.isEqual(o) ? 0 : 1;
  }
  translate(a, b) {
    if (typeof a === 'object' && a) return new Position(this.line + (a.lineDelta ?? 0), this.character + (a.characterDelta ?? 0));
    return new Position(this.line + (a ?? 0), this.character + (b ?? 0));
  }
  with(a, b) {
    if (typeof a === 'object' && a) return new Position(a.line ?? this.line, a.character ?? this.character);
    return new Position(a ?? this.line, b ?? this.character);
  }
}

class Range {
  constructor(a, b, c, d) {
    let start;
    let end;
    if (typeof a === 'number') {
      start = new Position(a, b);
      end = new Position(c, d);
    } else {
      start = a;
      end = b;
    }
    if (start.isAfter(end)) [start, end] = [end, start];
    this.start = start;
    this.end = end;
  }
  get isEmpty() {
    return this.start.isEqual(this.end);
  }
  get isSingleLine() {
    return this.start.line === this.end.line;
  }
  contains(x) {
    if (x instanceof Range) return this.contains(x.start) && this.contains(x.end);
    return this.start.isBeforeOrEqual(x) && this.end.isAfterOrEqual(x);
  }
  isEqual(o) {
    return this.start.isEqual(o.start) && this.end.isEqual(o.end);
  }
  intersection(o) {
    const s = this.start.isAfter(o.start) ? this.start : o.start;
    const e = this.end.isBefore(o.end) ? this.end : o.end;
    return s.isAfter(e) ? undefined : new Range(s, e);
  }
  union(o) {
    return new Range(this.start.isBefore(o.start) ? this.start : o.start, this.end.isAfter(o.end) ? this.end : o.end);
  }
  with(a, b) {
    if (a && typeof a === 'object' && !(a instanceof Position)) return new Range(a.start ?? this.start, a.end ?? this.end);
    return new Range(a ?? this.start, b ?? this.end);
  }
}

class Selection extends Range {
  constructor(a, b, c, d) {
    super(a, b, c, d);
    const anchor = typeof a === 'number' ? new Position(a, b) : a;
    const active = typeof a === 'number' ? new Position(c, d) : b;
    this.anchor = anchor;
    this.active = active;
    this.isReversed = anchor.isAfter(active);
  }
}

class Location {
  constructor(uri, rangeOrPosition) {
    this.uri = uri;
    this.range = rangeOrPosition instanceof Position ? new Range(rangeOrPosition, rangeOrPosition) : rangeOrPosition;
  }
}

class TextEdit {
  constructor(range, newText) {
    this.range = range;
    this.newText = newText;
  }
  static replace(range, newText) {
    return new TextEdit(range, newText);
  }
  static insert(pos, newText) {
    return new TextEdit(new Range(pos, pos), newText);
  }
  static delete(range) {
    return new TextEdit(range, '');
  }
}

class WorkspaceEdit {
  constructor() {
    this._edits = new Map();
    this._files = [];
  }
  _push(uri, edit) {
    const key = uri.toString();
    if (!this._edits.has(key)) this._edits.set(key, { uri, edits: [] });
    this._edits.get(key).edits.push(edit);
  }
  replace(uri, range, text) {
    this._push(uri, TextEdit.replace(range, text));
  }
  insert(uri, pos, text) {
    this._push(uri, TextEdit.insert(pos, text));
  }
  delete(uri, range) {
    this._push(uri, TextEdit.delete(range));
  }
  set(uri, edits) {
    this._edits.set(uri.toString(), { uri, edits: [...edits] });
  }
  get(uri) {
    return this._edits.get(uri.toString())?.edits ?? [];
  }
  has(uri) {
    return this._edits.has(uri.toString());
  }
  createFile(uri, options) {
    this._files.push({ op: 'create', uri, options });
  }
  deleteFile(uri, options) {
    this._files.push({ op: 'delete', uri, options });
  }
  renameFile(a, b, options) {
    this._files.push({ op: 'rename', a, b, options });
  }
  get size() {
    return this._edits.size + this._files.length;
  }
  entries() {
    return [...this._edits.values()].map((e) => [e.uri, e.edits]);
  }
}

class SnippetString {
  constructor(value = '') {
    this.value = value;
  }
  appendText(s) {
    this.value += s;
    return this;
  }
  appendTabstop() {
    return this;
  }
  appendPlaceholder(v) {
    this.value += typeof v === 'string' ? v : '';
    return this;
  }
}

class MarkdownString {
  constructor(value = '', supportThemeIcons = false) {
    this.value = value;
    this.supportThemeIcons = supportThemeIcons;
    this.isTrusted = false;
    this.supportHtml = false;
  }
  appendText(s) {
    this.value += s;
    return this;
  }
  appendMarkdown(s) {
    this.value += s;
    return this;
  }
  appendCodeblock(code, lang = '') {
    this.value += `\n\`\`\`${lang}\n${code}\n\`\`\`\n`;
    return this;
  }
}

class ThemeColor {
  constructor(id) {
    this.id = id;
  }
}
class ThemeIcon {
  constructor(id, color) {
    this.id = id;
    this.color = color;
  }
}
ThemeIcon.File = new ThemeIcon('file');
ThemeIcon.Folder = new ThemeIcon('folder');

class CodeLens {
  constructor(range, command) {
    this.range = range;
    this.command = command;
  }
  get isResolved() {
    return !!this.command;
  }
}

class CodeActionKind {
  constructor(value) {
    this.value = value;
  }
  append(part) {
    return new CodeActionKind(this.value ? `${this.value}.${part}` : part);
  }
  intersects(other) {
    return this.contains(other) || other.contains(this);
  }
  contains(other) {
    return this.value === other.value || other.value.startsWith(`${this.value}.`);
  }
}
CodeActionKind.Empty = new CodeActionKind('');
CodeActionKind.QuickFix = new CodeActionKind('quickfix');
CodeActionKind.Refactor = new CodeActionKind('refactor');
CodeActionKind.RefactorExtract = new CodeActionKind('refactor.extract');
CodeActionKind.RefactorInline = new CodeActionKind('refactor.inline');
CodeActionKind.RefactorMove = new CodeActionKind('refactor.move');
CodeActionKind.RefactorRewrite = new CodeActionKind('refactor.rewrite');
CodeActionKind.Source = new CodeActionKind('source');
CodeActionKind.SourceOrganizeImports = new CodeActionKind('source.organizeImports');
CodeActionKind.SourceFixAll = new CodeActionKind('source.fixAll');
CodeActionKind.Notebook = new CodeActionKind('notebook');

class CodeAction {
  constructor(title, kind) {
    this.title = title;
    this.kind = kind;
  }
}
class InlineCompletionItem {
  constructor(insertText, range, command) {
    this.insertText = insertText;
    this.range = range;
    this.command = command;
  }
}
class InlineCompletionList {
  constructor(items) {
    this.items = items;
  }
}
class CompletionItem {
  constructor(label, kind) {
    this.label = label;
    this.kind = kind;
  }
}
class Diagnostic {
  constructor(range, message, severity = 0) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}
class DiagnosticRelatedInformation {
  constructor(location, message) {
    this.location = location;
    this.message = message;
  }
}
class TreeItem {
  constructor(label, collapsibleState = 0) {
    this.label = label;
    this.collapsibleState = collapsibleState;
  }
}
class RelativePattern {
  constructor(base, pattern) {
    this.base = typeof base === 'string' ? base : (base.uri ?? base).fsPath;
    this.baseUri = typeof base === 'string' ? Uri.file(base) : (base.uri ?? base);
    this.pattern = pattern;
  }
}
class FileSystemError extends Error {
  constructor(messageOrUri, code = 'Unknown') {
    super(typeof messageOrUri === 'string' ? messageOrUri : String(messageOrUri ?? ''));
    this.code = code;
    this.name = 'FileSystemError';
  }
  static FileNotFound(u) {
    return new FileSystemError(`file not found: ${u ?? ''}`, 'FileNotFound');
  }
  static FileExists(u) {
    return new FileSystemError(`file exists: ${u ?? ''}`, 'FileExists');
  }
  static FileNotADirectory(u) {
    return new FileSystemError(`not a directory: ${u ?? ''}`, 'FileNotADirectory');
  }
  static FileIsADirectory(u) {
    return new FileSystemError(`is a directory: ${u ?? ''}`, 'FileIsADirectory');
  }
  static NoPermissions(u) {
    return new FileSystemError(`no permissions: ${u ?? ''}`, 'NoPermissions');
  }
  static Unavailable(u) {
    return new FileSystemError(`unavailable: ${u ?? ''}`, 'Unavailable');
  }
}
class TabInputText {
  constructor(uri) {
    this.uri = uri;
  }
}
class TabInputTextDiff {
  constructor(original, modified) {
    this.original = original;
    this.modified = modified;
  }
}
class TabInputWebview {
  constructor(viewType) {
    this.viewType = viewType;
  }
}
class TabInputCustom {
  constructor(uri, viewType) {
    this.uri = uri;
    this.viewType = viewType;
  }
}
class TabInputNotebook {
  constructor(uri, notebookType) {
    this.uri = uri;
    this.notebookType = notebookType;
  }
}
class TabInputTerminal {}
class TerminalProfile {
  constructor(options) {
    this.options = options;
  }
}
class LanguageModelError extends Error {}

const enumOf = (names, start = 0) => {
  const e = {};
  names.forEach((n, i) => {
    e[n] = start + i;
    e[start + i] = n;
  });
  return e;
};
const enums = {
  StatusBarAlignment: { Left: 1, Right: 2, 1: 'Left', 2: 'Right' },
  ViewColumn: { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3, Four: 4, Five: 5, Six: 6, Seven: 7, Eight: 8, Nine: 9 },
  ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
  FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
  FileChangeType: { Changed: 1, Created: 2, Deleted: 3 },
  FilePermission: { Readonly: 1 },
  DecorationRangeBehavior: enumOf(['OpenOpen', 'ClosedClosed', 'OpenClosed', 'ClosedOpen']),
  OverviewRulerLane: { Left: 1, Center: 2, Right: 4, Full: 7 },
  TextEditorRevealType: enumOf(['Default', 'InCenter', 'InCenterIfOutsideViewport', 'AtTop']),
  TextEditorSelectionChangeKind: { Keyboard: 1, Mouse: 2, Command: 3 },
  TextEditorLineNumbersStyle: enumOf(['Off', 'On', 'Relative', 'Interval']),
  ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
  QuickPickItemKind: { Separator: -1, Default: 0 },
  InlineCompletionTriggerKind: { Invoke: 0, Automatic: 1 },
  EndOfLine: { LF: 1, CRLF: 2 },
  TextDocumentChangeReason: { Undo: 1, Redo: 2 },
  TextDocumentSaveReason: { Manual: 1, AfterDelay: 2, FocusOut: 3 },
  UIKind: { Desktop: 1, Web: 2 },
  ExtensionKind: { UI: 1, Workspace: 2 },
  ExtensionMode: { Production: 1, Development: 2, Test: 3 },
  DiagnosticSeverity: enumOf(['Error', 'Warning', 'Information', 'Hint']),
  DiagnosticTag: { Unnecessary: 1, Deprecated: 2 },
  CompletionItemKind: enumOf(['Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter', 'User', 'Issue']),
  SymbolKind: enumOf(['File', 'Module', 'Namespace', 'Package', 'Class', 'Method', 'Property', 'Field', 'Constructor', 'Enum', 'Interface', 'Function', 'Variable', 'Constant', 'String', 'Number', 'Boolean', 'Array', 'Object', 'Key', 'Null', 'EnumMember', 'Struct', 'Event', 'Operator', 'TypeParameter']),
  TreeItemCollapsibleState: enumOf(['None', 'Collapsed', 'Expanded']),
  TreeItemCheckboxState: enumOf(['Unchecked', 'Checked']),
  ColorThemeKind: { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 },
  LogLevel: enumOf(['Off', 'Trace', 'Debug', 'Info', 'Warning', 'Error']),
  TerminalLocation: { Panel: 1, Editor: 2 },
  TerminalExitReason: enumOf(['Unknown', 'Shutdown', 'Process', 'User', 'Extension']),
  TerminalShellExecutionCommandLineConfidence: enumOf(['Low', 'Medium', 'High']),
  TerminalShellType: enumOf(['Sh', 'Bash', 'Fish', 'Csh', 'Ksh', 'Zsh', 'CommandPrompt', 'GitBash', 'PowerShell', 'Python', 'Julia', 'NuShell', 'Node'], 1),
  EnvironmentVariableMutatorType: { Replace: 1, Append: 2, Prepend: 3 },
  CommentMode: { Editing: 0, Preview: 1 },
  CommentThreadState: { Unresolved: 0, Resolved: 1 },
  CommentThreadCollapsibleState: { Collapsed: 0, Expanded: 1 },
  NotebookCellKind: { Markup: 1, Code: 2 },
  NotebookEditorRevealType: enumOf(['Default', 'InCenter', 'InCenterIfOutsideViewport', 'AtTop']),
  InputBoxValidationSeverity: { Info: 1, Warning: 2, Error: 3 },
  SourceControlInputBoxValidationType: { Error: 0, Warning: 1, Information: 2 },
  LanguageModelChatMessageRole: { User: 1, Assistant: 2 },
  TabGroupChangeKind: undefined,
  DebugConsoleMode: { Separate: 0, MergeWithParent: 1 },
  ShellExecution: undefined,
  TaskScope: { Global: 1, Workspace: 2 },
  TaskRevealKind: { Always: 1, Silent: 2, Never: 3 },
  TaskPanelKind: { Shared: 1, Dedicated: 2, New: 3 },
  SignatureHelpTriggerKind: { Invoke: 1, TriggerCharacter: 2, ContentChange: 3 },
  CompletionTriggerKind: { Invoke: 0, TriggerCharacter: 1, TriggerForIncompleteCompletions: 2 },
  CodeActionTriggerKind: { Invoke: 1, Automatic: 2 },
  FoldingRangeKind: { Comment: 1, Imports: 2, Region: 3 },
  IndentAction: enumOf(['None', 'Indent', 'IndentOutdent', 'Outdent']),
  OverviewRulerLaneEnum: undefined,
  WebviewPanelTargetArea: undefined,
  DebugConfigurationProviderTriggerKind: { Initial: 1, Dynamic: 2 },
  ChatResultFeedbackKind: { Unhelpful: 0, Helpful: 1 },
  PortAutoForwardAction: enumOf(['Notify', 'OpenBrowser', 'OpenPreview', 'Silent', 'Ignore', 'OpenBrowserOnce'], 1),
  TestRunProfileKind: { Run: 1, Debug: 2, Coverage: 3 },
  TextEditorCursorStyle: enumOf(['Line', 'Block', 'Underline', 'LineThin', 'BlockOutline', 'UnderlineThin'], 1),
  InlayHintKind: { Type: 1, Parameter: 2 },
  SemanticTokensLegend: undefined,
  DocumentHighlightKind: enumOf(['Text', 'Read', 'Write']),
  SymbolTag: { Deprecated: 1 },
  SyntaxTokenType: enumOf(['Other', 'Comment', 'String', 'RegEx']),
  EvaluatableExpression: undefined,
  ProtocolTypeHierarchyItem: undefined,
  ExternalUriOpenerPriority: enumOf(['None', 'Option', 'Default', 'Preferred']),
  NotebookControllerAffinity: { Default: 1, Preferred: 2 },
  NotebookCellStatusBarAlignment: { Left: 1, Right: 2 },
  NotebookCellExecutionState: enumOf(['Idle', 'Pending', 'Executing'], 1),
  CommentThreadApplicability: { Current: 0, Outdated: 1 },
  TerminalOutputAnchor: { Top: 0, Bottom: 1 },
  TerminalQuickFixType: { TerminalCommand: 0, Opener: 1, Command: 3 },
  ChatLocation: { Panel: 1, Terminal: 2, Notebook: 3, Editor: 4 },
  ChatResponseReferencePartStatusKind: { Complete: 1, Partial: 2, Omitted: 3 },
};
for (const k of Object.keys(enums)) if (enums[k] === undefined) delete enums[k];

// ---------------------------------------------------------------------------------------------
// Workspace fixture
// ---------------------------------------------------------------------------------------------
const scratchBase = process.env.KURSOR_SMOKE_TMP || process.env.SCRATCHPAD || os.tmpdir();
const wsRoot = fs.mkdtempSync(path.join(scratchBase, 'kursor-smoke-ws-'));
fs.mkdirSync(path.join(wsRoot, '.cursor', 'rules'), { recursive: true });
fs.writeFileSync(path.join(wsRoot, '.cursor', 'rules', 'style.mdc'), '---\ndescription: Style guide\nglobs: "**/*.ts"\nalwaysApply: false\n---\n- Prefer const.\n');
fs.writeFileSync(path.join(wsRoot, 'AGENTS.md'), '# Agents\nBe concise.\n');
fs.writeFileSync(path.join(wsRoot, 'hello.ts'), 'export const hello = "world";\n');
const storageRoot = fs.mkdtempSync(path.join(scratchBase, 'kursor-smoke-storage-'));
const workspaceFolder = { uri: Uri.file(wsRoot), name: path.basename(wsRoot), index: 0 };

// ---------------------------------------------------------------------------------------------
// Configuration: manifest defaults + overrides
// ---------------------------------------------------------------------------------------------
const manifestProps = pkg.contributes?.configuration?.properties ?? {};
const configDefaults = Object.fromEntries(Object.entries(manifestProps).map(([k, v]) => [k, v.default]));
const configOverrides = { 'kursor.ide.enableServer': false, 'files.autoSave': 'off' };
if (process.env.KURSOR_SMOKE_CONFIG) {
  try {
    Object.assign(configOverrides, JSON.parse(process.env.KURSOR_SMOKE_CONFIG));
  } catch (err) {
    console.error('smoke-load: KURSOR_SMOKE_CONFIG is not valid JSON:', err.message);
    process.exit(2);
  }
}
const configValues = new Map();
const configChanged = new EventEmitter();

function configLookup(full) {
  if (configValues.has(full)) return { value: configValues.get(full), source: 'written' };
  if (Object.prototype.hasOwnProperty.call(configOverrides, full)) return { value: configOverrides[full], source: 'override' };
  if (Object.prototype.hasOwnProperty.call(configDefaults, full)) return { value: configDefaults[full], source: 'default' };
  return undefined;
}

function getConfiguration(section, _scope) {
  const prefix = section ? `${section}.` : '';
  const full = (k) => `${prefix}${k}`;
  const cfg = {
    get(k, d) {
      const hit = configLookup(full(k));
      if (!hit) return d;
      return hit.value === undefined ? d : hit.value;
    },
    has(k) {
      return configLookup(full(k)) !== undefined;
    },
    inspect(k) {
      const key = full(k);
      const def = configDefaults[key];
      const written = configValues.has(key) ? configValues.get(key) : undefined;
      return { key, defaultValue: def, globalValue: written, workspaceValue: undefined, workspaceFolderValue: undefined };
    },
    async update(k, v, _target) {
      const key = full(k);
      configValues.set(key, v);
      executedCommands.push(`config.update ${key}=${JSON.stringify(v)}`);
      configChanged.fire({ affectsConfiguration: (s) => key === s || key.startsWith(`${s}.`) });
    },
  };
  // Allow `cfg['kursor.x']` style reads too.
  return new Proxy(cfg, {
    get(t, prop) {
      if (prop in t) return t[prop];
      if (typeof prop !== 'string') return undefined;
      const hit = configLookup(full(prop));
      return hit?.value;
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Logger (OutputChannel)
// ---------------------------------------------------------------------------------------------
function createOutputChannel(name, options) {
  const isLog = typeof options === 'object' && options?.log;
  const emit = (level, msg) => {
    logLines[level] += 1;
    if (level === 'error') logErrors.push(msg);
    if (level === 'warn') logWarnings.push(msg);
    if (VERBOSE || level === 'error') console.log(`[${name}:${level}] ${msg}`);
  };
  const channel = {
    name,
    logLevel: 1,
    onDidChangeLogLevel: new EventEmitter().event,
    append: (s) => emit('info', s),
    appendLine: (s) => emit('info', s),
    replace: () => undefined,
    clear: () => undefined,
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
    trace: (m) => emit('debug', m),
    debug: (m) => emit('debug', m),
    info: (m) => emit('info', m),
    warn: (m) => emit('warn', m),
    error: (m) => emit('error', m instanceof Error ? (m.stack ?? m.message) : m),
  };
  void isLog;
  return channel;
}

// ---------------------------------------------------------------------------------------------
// Documents / editors (minimal)
// ---------------------------------------------------------------------------------------------
function makeDocument(uri, text, languageId) {
  const lines = text.split(/\r?\n/);
  const doc = {
    uri,
    fileName: uri.fsPath,
    isUntitled: uri.scheme === 'untitled',
    languageId: languageId ?? (uri.fsPath.endsWith('.ts') ? 'typescript' : 'plaintext'),
    version: 1,
    isDirty: false,
    isClosed: false,
    eol: 1,
    encoding: 'utf8',
    get lineCount() {
      return lines.length;
    },
    getText(range) {
      if (!range) return text;
      const startOff = doc.offsetAt(range.start);
      const endOff = doc.offsetAt(range.end);
      return text.slice(startOff, endOff);
    },
    lineAt(i) {
      const n = typeof i === 'number' ? i : i.line;
      const t = lines[n] ?? '';
      const range = new Range(n, 0, n, t.length);
      return {
        lineNumber: n,
        text: t,
        range,
        rangeIncludingLineBreak: n < lines.length - 1 ? new Range(n, 0, n + 1, 0) : range,
        firstNonWhitespaceCharacterIndex: t.search(/\S|$/),
        isEmptyOrWhitespace: t.trim().length === 0,
      };
    },
    offsetAt(pos) {
      let off = 0;
      for (let l = 0; l < pos.line && l < lines.length; l++) off += lines[l].length + 1;
      return off + Math.min(pos.character, lines[pos.line]?.length ?? 0);
    },
    positionAt(offset) {
      let rem = offset;
      for (let l = 0; l < lines.length; l++) {
        if (rem <= lines[l].length) return new Position(l, rem);
        rem -= lines[l].length + 1;
      }
      return new Position(lines.length - 1, lines[lines.length - 1].length);
    },
    validateRange: (r) => r,
    validatePosition: (p) => p,
    getWordRangeAtPosition: () => undefined,
    save: async () => true,
  };
  return doc;
}

// ---------------------------------------------------------------------------------------------
// window
// ---------------------------------------------------------------------------------------------
const ev = () => new EventEmitter();
const windowEvents = {
  onDidChangeActiveTextEditor: ev(),
  onDidChangeVisibleTextEditors: ev(),
  onDidChangeTextEditorSelection: ev(),
  onDidChangeTextEditorVisibleRanges: ev(),
  onDidChangeTextEditorOptions: ev(),
  onDidChangeTextEditorViewColumn: ev(),
  onDidChangeWindowState: ev(),
  onDidChangeActiveTerminal: ev(),
  onDidOpenTerminal: ev(),
  onDidCloseTerminal: ev(),
  onDidChangeTerminalState: ev(),
  onDidChangeTerminalShellIntegration: ev(),
  onDidStartTerminalShellExecution: ev(),
  onDidEndTerminalShellExecution: ev(),
  onDidChangeActiveColorTheme: ev(),
  onDidChangeActiveNotebookEditor: ev(),
  onDidChangeVisibleNotebookEditors: ev(),
  onDidChangeNotebookEditorSelection: ev(),
  onDidChangeNotebookEditorVisibleRanges: ev(),
};
const tabGroupEvents = { onDidChangeTabs: ev(), onDidChangeTabGroups: ev() };

const webviewViewProviders = new Map();
const webviewPanelSerializers = new Map();
const createdPanels = [];
const statusBarItems = [];
const decorationTypes = [];
const terminals = [];
const messagesShown = [];
let clipboardText = '';

function makeWebview(options) {
  const received = new EventEmitter();
  const posted = [];
  const webview = {
    options: options ?? {},
    html: '',
    cspSource: 'vscode-webview://smoke',
    onDidReceiveMessage: received.event,
    _received: received,
    _posted: posted,
    async postMessage(msg) {
      posted.push(msg);
      return true;
    },
    asWebviewUri(uri) {
      return uri.with({ scheme: 'https', authority: 'file+.vscode-resource.vscode-cdn.net' });
    },
  };
  return webview;
}

function makeWebviewPanel(viewType, title, showOptions, options) {
  const disposed = new EventEmitter();
  const viewState = new EventEmitter();
  const panel = {
    viewType,
    title,
    iconPath: undefined,
    webview: makeWebview(options),
    options: options ?? {},
    viewColumn: typeof showOptions === 'number' ? showOptions : (showOptions?.viewColumn ?? 1),
    active: true,
    visible: true,
    onDidDispose: disposed.event,
    onDidChangeViewState: viewState.event,
    reveal(column, preserveFocus) {
      panel.visible = true;
      panel.active = !preserveFocus;
      viewState.fire({ webviewPanel: panel });
    },
    dispose() {
      if (panel._disposed) return;
      panel._disposed = true;
      panel.visible = false;
      panel.active = false;
      disposed.fire(undefined);
    },
  };
  createdPanels.push(panel);
  return panel;
}

function makeStatusBarItem(idOrAlignment, alignmentOrPriority, priority) {
  const item = {
    id: typeof idOrAlignment === 'string' ? idOrAlignment : 'smoke.status',
    alignment: typeof idOrAlignment === 'string' ? alignmentOrPriority : idOrAlignment,
    priority: typeof idOrAlignment === 'string' ? priority : alignmentOrPriority,
    name: undefined,
    text: '',
    tooltip: undefined,
    color: undefined,
    backgroundColor: undefined,
    command: undefined,
    accessibilityInformation: undefined,
    _visible: false,
    show() {
      item._visible = true;
    },
    hide() {
      item._visible = false;
    },
    dispose() {
      item._disposed = true;
    },
  };
  statusBarItems.push(item);
  return item;
}

function makeTerminal(options) {
  const name = typeof options === 'string' ? options : (options?.name ?? 'Terminal');
  const sent = [];
  const term = {
    name,
    processId: Promise.resolve(4242),
    creationOptions: typeof options === 'object' ? options : { name },
    exitStatus: undefined,
    state: { isInteractedWith: false, shell: undefined },
    shellIntegration: undefined,
    _sent: sent,
    sendText(text, addNewLine = true) {
      sent.push({ text, addNewLine });
      vlog(`terminal "${name}" <- ${JSON.stringify(text)}`);
    },
    show() {},
    hide() {},
    dispose() {
      const i = terminals.indexOf(term);
      if (i >= 0) terminals.splice(i, 1);
      windowEvents.onDidCloseTerminal.fire(term);
    },
  };
  terminals.push(term);
  windowEvents.onDidOpenTerminal.fire(term);
  return term;
}

function makeQuickPick() {
  const emitters = {
    onDidChangeValue: ev(),
    onDidAccept: ev(),
    onDidHide: ev(),
    onDidChangeActive: ev(),
    onDidChangeSelection: ev(),
    onDidTriggerButton: ev(),
    onDidTriggerItemButton: ev(),
  };
  const qp = {
    value: '',
    placeholder: undefined,
    title: undefined,
    items: [],
    activeItems: [],
    selectedItems: [],
    buttons: [],
    busy: false,
    enabled: true,
    step: undefined,
    totalSteps: undefined,
    canSelectMany: false,
    matchOnDescription: false,
    matchOnDetail: false,
    keepScrollPosition: false,
    ignoreFocusOut: false,
    show() {
      qp._visible = true;
    },
    hide() {
      qp._visible = false;
      emitters.onDidHide.fire(undefined);
    },
    dispose() {
      qp._visible = false;
    },
  };
  for (const [k, e] of Object.entries(emitters)) qp[k] = e.event;
  return qp;
}

const showMessage = (level) => async (message, ...rest) => {
  const items = rest.filter((r) => typeof r === 'string' || (r && typeof r === 'object' && 'title' in r));
  messagesShown.push({ level, message, items: items.map((i) => (typeof i === 'string' ? i : i.title)) });
  if (level === 'error') warn(`showErrorMessage: ${message}`);
  vlog(`showMessage(${level}): ${message}`);
  return undefined;
};

const windowImpl = {
  ...Object.fromEntries(Object.entries(windowEvents).map(([k, e]) => [k, e.event])),
  activeTextEditor: undefined,
  visibleTextEditors: [],
  activeTerminal: undefined,
  terminals,
  activeNotebookEditor: undefined,
  visibleNotebookEditors: [],
  state: { focused: true, active: true },
  activeColorTheme: { kind: 2 },
  tabGroups: {
    all: [],
    activeTabGroup: { isActive: true, viewColumn: 1, activeTab: undefined, tabs: [] },
    onDidChangeTabs: tabGroupEvents.onDidChangeTabs.event,
    onDidChangeTabGroups: tabGroupEvents.onDidChangeTabGroups.event,
    close: async () => true,
  },
  showInformationMessage: showMessage('info'),
  showWarningMessage: showMessage('warning'),
  showErrorMessage: showMessage('error'),
  showQuickPick: async () => undefined,
  showInputBox: async () => undefined,
  showOpenDialog: async () => undefined,
  showSaveDialog: async () => undefined,
  showWorkspaceFolderPick: async () => workspaceFolder,
  showTextDocument: async (docOrUri) => {
    const uri = docOrUri?.uri ?? docOrUri;
    warn(`showTextDocument called for ${uri?.toString?.() ?? '?'} (no editor in smoke)`);
    return undefined;
  },
  showNotebookDocument: async () => undefined,
  createOutputChannel,
  createStatusBarItem: makeStatusBarItem,
  createTextEditorDecorationType(options) {
    const t = { key: `deco-${decorationTypes.length}`, options, dispose() {} };
    decorationTypes.push(t);
    return t;
  },
  createTerminal: makeTerminal,
  createQuickPick: makeQuickPick,
  createInputBox: makeQuickPick,
  createWebviewPanel: makeWebviewPanel,
  createTreeView: () => ({ onDidChangeSelection: ev().event, onDidChangeVisibility: ev().event, onDidExpandElement: ev().event, onDidCollapseElement: ev().event, selection: [], visible: false, reveal: async () => undefined, dispose() {} }),
  createInputBoxValidation: undefined,
  registerWebviewViewProvider(viewId, provider, options) {
    webviewViewProviders.set(viewId, { provider, options });
    return new Disposable(() => webviewViewProviders.delete(viewId));
  },
  registerWebviewPanelSerializer(viewType, serializer) {
    webviewPanelSerializers.set(viewType, serializer);
    return new Disposable(() => webviewPanelSerializers.delete(viewType));
  },
  registerTreeDataProvider: () => new Disposable(),
  registerUriHandler: () => new Disposable(),
  registerTerminalLinkProvider: () => new Disposable(),
  registerTerminalProfileProvider: () => new Disposable(),
  registerFileDecorationProvider: () => new Disposable(),
  registerCustomEditorProvider: () => new Disposable(),
  setStatusBarMessage: () => new Disposable(),
  async withProgress(_options, task) {
    const cts = new CancellationTokenSource();
    try {
      return await task({ report() {} }, cts.token);
    } finally {
      cts.dispose();
    }
  },
};

// ---------------------------------------------------------------------------------------------
// workspace
// ---------------------------------------------------------------------------------------------
const workspaceEvents = {
  onDidChangeWorkspaceFolders: ev(),
  onDidOpenTextDocument: ev(),
  onDidCloseTextDocument: ev(),
  onDidChangeTextDocument: ev(),
  onWillSaveTextDocument: ev(),
  onDidSaveTextDocument: ev(),
  onDidCreateFiles: ev(),
  onDidDeleteFiles: ev(),
  onDidRenameFiles: ev(),
  onWillCreateFiles: ev(),
  onWillDeleteFiles: ev(),
  onWillRenameFiles: ev(),
  onDidOpenNotebookDocument: ev(),
  onDidCloseNotebookDocument: ev(),
  onDidChangeNotebookDocument: ev(),
  onDidSaveNotebookDocument: ev(),
  onDidGrantWorkspaceTrust: ev(),
  onDidChangeTextEditorSelection: ev(),
};
const watchers = [];

const fsApi = {
  async stat(uri) {
    const s = await fs.promises.stat(uri.fsPath);
    return { type: s.isDirectory() ? 2 : s.isSymbolicLink() ? 64 : 1, ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size };
  },
  async readDirectory(uri) {
    const entries = await fs.promises.readdir(uri.fsPath, { withFileTypes: true });
    return entries.map((e) => [e.name, e.isDirectory() ? 2 : e.isSymbolicLink() ? 64 : 1]);
  },
  async createDirectory(uri) {
    await fs.promises.mkdir(uri.fsPath, { recursive: true });
  },
  async readFile(uri) {
    try {
      return new Uint8Array(await fs.promises.readFile(uri.fsPath));
    } catch (err) {
      if (err && err.code === 'ENOENT') throw FileSystemError.FileNotFound(uri);
      throw err;
    }
  },
  async writeFile(uri, content) {
    await fs.promises.mkdir(path.dirname(uri.fsPath), { recursive: true });
    await fs.promises.writeFile(uri.fsPath, content);
  },
  async delete(uri, options) {
    await fs.promises.rm(uri.fsPath, { recursive: !!options?.recursive, force: true });
  },
  async rename(a, b) {
    await fs.promises.rename(a.fsPath, b.fsPath);
  },
  async copy(a, b) {
    await fs.promises.cp(a.fsPath, b.fsPath, { recursive: true });
  },
  isWritableFileSystem: () => true,
};

const workspaceImpl = {
  ...Object.fromEntries(Object.entries(workspaceEvents).map(([k, e]) => [k, e.event])),
  onDidChangeConfiguration: configChanged.event,
  workspaceFolders: [workspaceFolder],
  workspaceFile: undefined,
  name: workspaceFolder.name,
  isTrusted: true,
  textDocuments: [],
  notebookDocuments: [],
  fs: fsApi,
  getConfiguration,
  asRelativePath(pathOrUri, includeWorkspaceFolder) {
    const p = typeof pathOrUri === 'string' ? pathOrUri : pathOrUri.fsPath;
    if (p.startsWith(wsRoot + path.sep)) {
      const rel = p.slice(wsRoot.length + 1);
      return includeWorkspaceFolder ? `${workspaceFolder.name}/${rel}` : rel;
    }
    return p;
  },
  getWorkspaceFolder(uri) {
    const p = uri.fsPath;
    return p === wsRoot || p.startsWith(wsRoot + path.sep) ? workspaceFolder : undefined;
  },
  async openTextDocument(arg) {
    if (arg && typeof arg === 'object' && !(arg instanceof Uri) && ('content' in arg || 'language' in arg)) {
      return makeDocument(Uri.parse(`untitled:Untitled-${Date.now()}`), arg.content ?? '', arg.language);
    }
    const uri = typeof arg === 'string' ? Uri.file(arg) : arg;
    let text = '';
    if (uri.scheme === 'file') text = await fs.promises.readFile(uri.fsPath, 'utf8');
    return makeDocument(uri, text);
  },
  createFileSystemWatcher() {
    const w = { onDidCreate: ev().event, onDidChange: ev().event, onDidDelete: ev().event, ignoreCreateEvents: false, ignoreChangeEvents: false, ignoreDeleteEvents: false, dispose() {} };
    watchers.push(w);
    return w;
  },
  findFiles: async () => [],
  saveAll: async () => true,
  applyEdit: async () => true,
  registerTextDocumentContentProvider: () => new Disposable(),
  registerFileSystemProvider: () => new Disposable(),
  registerTaskProvider: () => new Disposable(),
  registerNotebookSerializer: () => new Disposable(),
  registerFileSearchProvider: () => new Disposable(),
  updateWorkspaceFolders: () => true,
  openNotebookDocument: async () => undefined,
};

// ---------------------------------------------------------------------------------------------
// commands / languages / env / extensions
// ---------------------------------------------------------------------------------------------
const commandsImpl = {
  registerCommand(id, fn, thisArg) {
    if (registeredCommands.has(id)) problem(`command registered twice: ${id}`);
    registeredCommands.set(id, thisArg ? fn.bind(thisArg) : fn);
    return new Disposable(() => registeredCommands.delete(id));
  },
  registerTextEditorCommand(id, fn, thisArg) {
    return commandsImpl.registerCommand(id, (...args) => fn.call(thisArg, windowImpl.activeTextEditor, { edit() {} }, ...args));
  },
  async executeCommand(id, ...args) {
    executedCommands.push(id);
    if (id === 'setContext') {
      contextKeys.set(args[0], args[1]);
      return undefined;
    }
    const fn = registeredCommands.get(id);
    if (fn) return fn(...args);
    vlog(`executeCommand(${id}) — not registered in smoke, ignored`);
    return undefined;
  },
  async getCommands() {
    return [...registeredCommands.keys()];
  },
};

const languagesImpl = {
  registerCodeLensProvider: () => new Disposable(),
  registerCodeActionsProvider: () => new Disposable(),
  registerInlineCompletionItemProvider: () => new Disposable(),
  registerCompletionItemProvider: () => new Disposable(),
  registerHoverProvider: () => new Disposable(),
  registerDocumentSymbolProvider: () => new Disposable(),
  registerDefinitionProvider: () => new Disposable(),
  registerDocumentFormattingEditProvider: () => new Disposable(),
  registerInlayHintsProvider: () => new Disposable(),
  registerDocumentLinkProvider: () => new Disposable(),
  createDiagnosticCollection: (name) => ({ name, set() {}, delete() {}, clear() {}, dispose() {}, get: () => undefined, has: () => false, forEach() {} }),
  createLanguageStatusItem: () => ({ dispose() {} }),
  getDiagnostics: (uri) => (uri ? [] : []),
  onDidChangeDiagnostics: ev().event,
  getLanguages: async () => ['typescript', 'javascript', 'plaintext', 'markdown'],
  setTextDocumentLanguage: async (doc) => doc,
  match: () => 0,
};

const envImpl = {
  appName: 'Kursor (smoke)',
  appRoot: path.join(storageRoot, 'appRoot'),
  appHost: 'desktop',
  uriScheme: 'kursor',
  language: 'en',
  machineId: 'smoke-machine',
  sessionId: 'smoke-session',
  shell: process.env.SHELL ?? '/bin/bash',
  uiKind: 1,
  remoteName: undefined,
  isNewAppInstall: false,
  isTelemetryEnabled: false,
  logLevel: 1,
  onDidChangeTelemetryEnabled: ev().event,
  onDidChangeLogLevel: ev().event,
  onDidChangeShell: ev().event,
  clipboard: {
    readText: async () => clipboardText,
    writeText: async (t) => {
      clipboardText = t;
    },
  },
  openExternal: async () => true,
  asExternalUri: async (u) => u,
  createTelemetryLogger: () => ({ logUsage() {}, logError() {}, dispose() {}, onDidChangeEnableStates: ev().event, isUsageEnabled: false, isErrorsEnabled: false }),
};

const extensionsImpl = {
  all: [],
  getExtension: () => undefined,
  onDidChange: ev().event,
};

// ---------------------------------------------------------------------------------------------
// Assemble the module
// ---------------------------------------------------------------------------------------------
const vscodeCore = {
  __esModule: true,
  version: (pkg.engines?.vscode ?? '^1.106.0').replace(/^\^/, ''),
  Disposable,
  EventEmitter,
  CancellationTokenSource,
  CancellationError,
  Uri,
  Position,
  Range,
  Selection,
  Location,
  TextEdit,
  WorkspaceEdit,
  SnippetString,
  MarkdownString,
  ThemeColor,
  ThemeIcon,
  CodeLens,
  CodeAction,
  CodeActionKind,
  InlineCompletionItem,
  InlineCompletionList,
  CompletionItem,
  Diagnostic,
  DiagnosticRelatedInformation,
  TreeItem,
  RelativePattern,
  FileSystemError,
  TabInputText,
  TabInputTextDiff,
  TabInputWebview,
  TabInputCustom,
  TabInputNotebook,
  TabInputTerminal,
  TerminalProfile,
  LanguageModelError,
  ...enums,
  l10n: { t: (msg, ...args) => (typeof msg === 'string' ? msg.replace(/\{(\d+)\}/g, (_, i) => String(args[Number(i)] ?? `{${i}}`)) : String(msg?.message ?? '')), bundle: undefined, uri: undefined },
  window: withFallback(windowImpl, 'window'),
  workspace: withFallback(workspaceImpl, 'workspace'),
  commands: withFallback(commandsImpl, 'commands'),
  languages: withFallback(languagesImpl, 'languages'),
  env: withFallback(envImpl, 'env'),
  extensions: withFallback(extensionsImpl, 'extensions'),
  tasks: anyProxy('tasks'),
  debug: anyProxy('debug'),
  scm: anyProxy('scm'),
  comments: anyProxy('comments'),
  notebooks: anyProxy('notebooks'),
  authentication: anyProxy('authentication'),
  chat: anyProxy('chat'),
  lm: anyProxy('lm'),
  tests: anyProxy('tests'),
};
const vscodeStub = withFallback(vscodeCore, 'vscode');

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return vscodeStub;
  return originalLoad.call(this, request, parent, isMain);
};

// ---------------------------------------------------------------------------------------------
// Extension context
// ---------------------------------------------------------------------------------------------
function makeMemento() {
  const store = new Map();
  return {
    get: (k, d) => (store.has(k) ? store.get(k) : d),
    update: async (k, v) => {
      if (v === undefined) store.delete(k);
      else store.set(k, v);
    },
    keys: () => [...store.keys()],
    setKeysForSync() {},
    _store: store,
  };
}
const envVarCollection = {
  persistent: true,
  description: undefined,
  _vars: new Map(),
  replace(k, v) {
    this._vars.set(k, { type: 'replace', value: v });
  },
  append(k, v) {
    this._vars.set(k, { type: 'append', value: v });
  },
  prepend(k, v) {
    this._vars.set(k, { type: 'prepend', value: v });
  },
  get(k) {
    return this._vars.get(k);
  },
  forEach(cb) {
    for (const [k, v] of this._vars) cb(k, v, this);
  },
  delete(k) {
    this._vars.delete(k);
  },
  clear() {
    this._vars.clear();
  },
  getScoped() {
    return this;
  },
  [Symbol.iterator]() {
    return this._vars[Symbol.iterator]();
  },
};
const extensionUri = Uri.file(root);
const context = {
  subscriptions: [],
  extensionUri,
  extensionPath: root,
  extensionMode: 2,
  extension: { id: `${pkg.publisher}.${pkg.name}`, extensionUri, extensionPath: root, packageJSON: pkg, isActive: true, exports: undefined, extensionKind: 2, activate: async () => undefined },
  globalState: makeMemento(),
  workspaceState: makeMemento(),
  secrets: { get: async () => undefined, store: async () => undefined, delete: async () => undefined, keys: async () => [], onDidChange: ev().event },
  environmentVariableCollection: envVarCollection,
  storageUri: Uri.file(path.join(storageRoot, 'workspaceStorage')),
  globalStorageUri: Uri.file(path.join(storageRoot, 'globalStorage')),
  logUri: Uri.file(path.join(storageRoot, 'logs')),
  storagePath: path.join(storageRoot, 'workspaceStorage'),
  globalStoragePath: path.join(storageRoot, 'globalStorage'),
  logPath: path.join(storageRoot, 'logs'),
  asAbsolutePath: (p) => path.join(root, p),
  languageModelAccessInformation: { onDidChange: ev().event, canSendRequest: () => undefined },
};

// ---------------------------------------------------------------------------------------------
// Manifest cross-check helpers
// ---------------------------------------------------------------------------------------------
const declaredCommands = new Set((pkg.contributes?.commands ?? []).map((c) => c.command));
const paletteHidden = new Set((pkg.contributes?.menus?.commandPalette ?? []).filter((m) => m.when === 'false').map((m) => m.command));
const keybindingCommands = new Set((pkg.contributes?.keybindings ?? []).map((k) => k.command).filter((c) => c.startsWith('kursor.')));
const menuCommands = new Set();
for (const [menuId, entries] of Object.entries(pkg.contributes?.menus ?? {})) {
  for (const e of entries) if (e.command?.startsWith('kursor.')) menuCommands.add(`${menuId}:${e.command}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, step = 25) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (pred()) return true;
    await sleep(step);
  }
  return pred();
}

// ---------------------------------------------------------------------------------------------
// Run
// ---------------------------------------------------------------------------------------------
let finished = false;
let ext;
async function main() {
  const t0 = Date.now();
  ext = require(distEntry);
  if (typeof ext.activate !== 'function') {
    problem('dist/extension.js does not export activate()');
    return;
  }
  let timedOut = false;
  await Promise.race([
    ext.activate(context).catch((err) => problem(`activate() rejected: ${err instanceof Error ? err.stack ?? err.message : String(err)}`)),
    sleep(ACTIVATE_TIMEOUT_MS).then(() => {
      timedOut = true;
    }),
  ]);
  if (timedOut) problem(`activate() did not resolve within ${ACTIVATE_TIMEOUT_MS} ms`);
  const activateMs = Date.now() - t0;

  // --- commands vs manifest -----------------------------------------------------------------
  const registered = [...registeredCommands.keys()].filter((id) => id.startsWith('kursor.')).sort();
  const missing = [...declaredCommands].filter((id) => !registeredCommands.has(id)).sort();
  const extra = registered.filter((id) => !declaredCommands.has(id));
  const danglingKeybindings = [...keybindingCommands].filter((id) => !declaredCommands.has(id));
  const danglingMenus = [...menuCommands].filter((ref) => !declaredCommands.has(ref.split(':')[1]));
  for (const id of missing) problem(`declared in package.json but never registered: ${id}`);
  for (const id of extra) problem(`registered but not declared in package.json: ${id}${paletteHidden.has(id) ? '' : ' (declare it; hide with commandPalette when:"false" if internal)'}`);
  for (const id of danglingKeybindings) problem(`keybinding references undeclared command: ${id}`);
  for (const ref of danglingMenus) problem(`menu entry references undeclared command: ${ref}`);

  // --- exercise the chat view provider ------------------------------------------------------
  const chatEntry = webviewViewProviders.get('kursor.chat');
  let chatHtmlOk = false;
  let chatAppState = false;
  if (!chatEntry) {
    problem('no WebviewViewProvider registered for kursor.chat');
  } else {
    const webview = makeWebview({});
    const visibility = new EventEmitter();
    const disposed = new EventEmitter();
    const view = {
      viewType: 'kursor.chat',
      webview,
      title: 'Chat',
      description: undefined,
      badge: undefined,
      visible: true,
      onDidChangeVisibility: visibility.event,
      onDidDispose: disposed.event,
      show() {},
    };
    try {
      await chatEntry.provider.resolveWebviewView(view, { state: undefined }, new CancellationTokenSource().token);
      const html = webview.html ?? '';
      chatHtmlOk = /webview\.js/.test(html) && /Content-Security-Policy/.test(html) && /nonce-/.test(html) && /codicon\.css/.test(html);
      if (!chatHtmlOk) problem(`chat webview HTML is missing webview.js / CSP nonce / codicon.css (length ${html.length})`);
      webview._received.fire({ type: 'ready' });
      chatAppState = await waitFor(() => webview._posted.some((m) => m?.type === 'appState'), 3000);
      if (!chatAppState) problem('chat webview did not receive an appState message within 3 s of `ready`');
      else vlog(`chat posted ${webview._posted.length} messages after ready: ${[...new Set(webview._posted.map((m) => m.type))].join(', ')}`);
      // Also exercise a benign intent round-trip: mention search for the empty query.
      webview._received.fire({ type: 'searchMentions', requestId: 'smoke-1', query: '' });
      const gotMentions = await waitFor(() => webview._posted.some((m) => m?.type === 'mentionResults' && m.requestId === 'smoke-1'), 3000);
      if (!gotMentions) problem('chat webview did not answer a searchMentions request within 3 s');
      webview._received.fire({ type: 'focusChanged', focused: false });
      disposed.fire(undefined);
    } catch (err) {
      problem(`resolveWebviewView(kursor.chat) threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
  }

  // --- exercise the settings panel ----------------------------------------------------------
  let settingsOk = false;
  if (registeredCommands.has('kursor.settings.open')) {
    try {
      await registeredCommands.get('kursor.settings.open')();
      const panel = createdPanels.find((p) => p.viewType === 'kursor.settings');
      if (!panel) problem('kursor.settings.open did not create a kursor.settings WebviewPanel');
      else {
        const html = panel.webview.html ?? '';
        if (!/settings\.js/.test(html) || !/nonce-/.test(html)) problem(`settings panel HTML is missing settings.js / nonce (length ${html.length})`);
        panel.webview._received.fire({ type: 'ready' });
        settingsOk = await waitFor(() => panel.webview._posted.some((m) => m?.type === 'state'), 3000);
        if (!settingsOk) problem('settings panel did not receive a `state` snapshot within 3 s of `ready`');
        panel.dispose();
      }
    } catch (err) {
      problem(`kursor.settings.open threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    }
  }

  // --- a few commands that must be safe without an editor -----------------------------------
  for (const id of ['kursor.showLogs', 'kursor.inlineEdit.acceptAll', 'kursor.inlineEdit.rejectAll', 'kursor.edits.keepAll', 'kursor.edits.reviewAll', 'kursor.chat.stop', 'kursor.ide.insertAtMention']) {
    const fn = registeredCommands.get(id);
    if (!fn) continue;
    try {
      await Promise.race([fn(), sleep(2000)]);
    } catch (err) {
      problem(`${id} threw without an editor: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // --- deactivate + dispose -----------------------------------------------------------------
  try {
    await ext.deactivate?.();
  } catch (err) {
    problem(`deactivate() threw: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  }
  for (const d of [...context.subscriptions].reverse()) {
    try {
      const r = d?.dispose?.();
      if (r && typeof r.then === 'function') await Promise.race([r.catch((e) => disposeErrors.push(String(e))), sleep(1000)]);
    } catch (err) {
      disposeErrors.push(err instanceof Error ? err.stack ?? err.message : String(err));
    }
  }
  for (const e of disposeErrors) problem(`dispose() threw: ${e}`);
  const envLeft = [...envVarCollection._vars.keys()];
  if (envLeft.length) warn(`environmentVariableCollection still has ${envLeft.join(', ')} after dispose`);

  const summary = {
    activateMs,
    registered,
    declared: [...declaredCommands].sort(),
    missing,
    extra,
    danglingKeybindings,
    danglingMenus,
    contextKeys: Object.fromEntries(contextKeys),
    subscriptions: context.subscriptions.length,
    statusBarItems: statusBarItems.length,
    panelsCreated: createdPanels.map((p) => p.viewType),
    chatHtmlOk,
    chatAppState,
    settingsOk,
    log: { ...logLines },
    logErrors,
    logWarnings,
    messagesShown,
    fallbacks: [...fallbacks].sort(),
    warnings,
    problems,
  };
  if (JSON_OUT) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.log(`activate(): ${activateMs} ms, ${context.subscriptions.length} subscriptions, ${registered.length} kursor.* commands registered, ${declaredCommands.size} declared`);
    console.log(`registered: ${registered.join(' ')}`);
    console.log(`context keys: ${JSON.stringify(summary.contextKeys)}`);
    console.log(`chat view: html=${chatHtmlOk ? 'ok' : 'BAD'} appState=${chatAppState ? 'ok' : 'MISSING'}; settings panel: ${settingsOk ? 'ok' : 'BAD'}`);
    console.log(`log lines: ${JSON.stringify(logLines)}`);
    if (logWarnings.length) console.log(`log warnings:\n  - ${logWarnings.join('\n  - ')}`);
    if (logErrors.length) console.log(`log errors:\n  - ${logErrors.join('\n  - ')}`);
    if (messagesShown.length) console.log(`messages shown: ${messagesShown.map((m) => `[${m.level}] ${m.message}`).join(' | ')}`);
    if (missing.length) console.log(`MISSING (declared, not registered): ${missing.join(' ')}`);
    if (extra.length) console.log(`EXTRA (registered, not declared): ${extra.join(' ')}`);
    if (danglingKeybindings.length) console.log(`keybindings → undeclared: ${danglingKeybindings.join(' ')}`);
    if (danglingMenus.length) console.log(`menus → undeclared: ${danglingMenus.join(' ')}`);
    console.log(`stub fallbacks used (not failures): ${summary.fallbacks.length ? summary.fallbacks.join(' ') : 'none'}`);
    if (warnings.length) console.log(`warnings:\n  - ${warnings.join('\n  - ')}`);
    if (problems.length) console.log(`PROBLEMS:\n  - ${problems.join('\n  - ')}`);
    console.log(problems.length ? 'SMOKE: FAIL' : 'SMOKE: OK');
  }
}

function finish(force = false) {
  if (finished) return;
  finished = true;
  try {
    fs.rmSync(wsRoot, { recursive: true, force: true });
    fs.rmSync(storageRoot, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  const code = problems.length ? 1 : 0;
  if (force) process.exit(code);
  // Give any in-flight child processes (claude --version probes) a moment, then leave.
  setTimeout(() => process.exit(code), 250).unref();
  process.exitCode = code;
}

main()
  .catch((err) => problem(`smoke script failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`))
  .finally(() => finish(false));
