/**
 * Tracks the latest text selection for `getLatestSelection` and emits debounced
 * `selection_changed` payloads; builds `at_mentioned` payloads for `kursor.ide.insertAtMention`.
 */
import * as vscode from 'vscode';
import type { Logger } from '../util/log';

/** Shape of the `selection_changed` notification params (what the CLI parses). */
export interface SelectionInfo {
  text: string;
  filePath: string;
  fileUrl: string;
  selection: {
    start: { line: number; character: number };
    end: { line: number; character: number };
    isEmpty: boolean;
  };
}

/** `at_mentioned` params: 0-based lines (the CLI adds 1 when it renders `@file#L…`). */
export interface AtMentionInfo {
  filePath: string;
  lineStart?: number;
  lineEnd?: number;
}

const IGNORED_SCHEMES = new Set(['comment', 'output', 'debug', 'vscode', 'vscode-terminal', 'search-editor', 'walkThrough', 'vscode-settings', 'vscode-scm']);

export function isTrackableScheme(scheme: string): boolean {
  return !IGNORED_SCHEMES.has(scheme) && !scheme.startsWith('kursor-');
}

export function selectionInfoOf(editor: vscode.TextEditor): SelectionInfo {
  const { selection, document } = editor;
  return {
    text: document.getText(selection),
    filePath: document.uri.fsPath,
    fileUrl: document.uri.toString(),
    selection: {
      start: { line: selection.start.line, character: selection.start.character },
      end: { line: selection.end.line, character: selection.end.character },
      isEmpty: selection.isEmpty,
    },
  };
}

export function atMentionOf(editor: vscode.TextEditor): AtMentionInfo {
  const info: AtMentionInfo = { filePath: editor.document.uri.fsPath };
  if (!editor.selection.isEmpty) {
    info.lineStart = editor.selection.start.line;
    info.lineEnd = editor.selection.end.line;
  }
  return info;
}

function sameSelection(a: SelectionInfo, b: SelectionInfo): boolean {
  return (
    a.text === b.text &&
    a.filePath === b.filePath &&
    a.selection.start.line === b.selection.start.line &&
    a.selection.start.character === b.selection.start.character &&
    a.selection.end.line === b.selection.end.line &&
    a.selection.end.character === b.selection.end.character
  );
}

export class SelectionTracker implements vscode.Disposable {
  private latest: SelectionInfo | undefined;
  private timer: NodeJS.Timeout | undefined;
  private readonly emitter = new vscode.EventEmitter<SelectionInfo>();
  private readonly disposables: vscode.Disposable[] = [];
  /** Fires at most once per `debounceMs` with the newest selection. */
  readonly onDidChangeSelection = this.emitter.event;

  constructor(
    private readonly log: Logger,
    private readonly debounceMs: number = 100,
  ) {
    this.disposables.push(
      this.emitter,
      vscode.window.onDidChangeTextEditorSelection((e) => this.capture(e.textEditor)),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) this.capture(editor);
      }),
    );
    const active = vscode.window.activeTextEditor;
    if (active && isTrackableScheme(active.document.uri.scheme)) this.latest = selectionInfoOf(active);
  }

  latestSelection(): SelectionInfo | undefined {
    return this.latest;
  }

  /** `at_mentioned` payload for the active editor, or undefined when there is none. */
  activeAtMention(): AtMentionInfo | undefined {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !isTrackableScheme(editor.document.uri.scheme)) return undefined;
    return atMentionOf(editor);
  }

  private capture(editor: vscode.TextEditor): void {
    if (!isTrackableScheme(editor.document.uri.scheme)) return;
    const info = selectionInfoOf(editor);
    const changed = !this.latest || !sameSelection(this.latest, info);
    this.latest = info;
    if (changed) this.schedule(info);
  }

  private schedule(info: SelectionInfo): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      try {
        this.emitter.fire(info);
      } catch (err) {
        this.log.error('selection listener failed', err);
      }
    }, this.debounceMs);
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    for (const d of this.disposables.splice(0)) d.dispose();
  }
}
