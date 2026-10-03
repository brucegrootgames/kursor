/**
 * MCP tools exposed to the `claude` CLI (same names and result shapes as the reference IDE
 * integration, so the CLI's `/ide`, diagnostics and diff-approval flows work unchanged).
 */
import * as vscode from 'vscode';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Logger } from '../util/log';
import type { DiffOutcome, OpenDiffArgs } from './diff';
import { resolveWorkspacePath } from './diff';
import type { SelectionInfo } from './selection';

export interface IdeToolHost {
  openDiff(args: OpenDiffArgs, signal?: AbortSignal): Promise<DiffOutcome>;
  closeTab(tabName: string): Promise<boolean>;
  closeAllDiffTabs(): Promise<number>;
  latestSelection(): SelectionInfo | undefined;
}

function textResult(text: string, isError = false): CallToolResult {
  return isError ? { content: [{ type: 'text', text }], isError: true } : { content: [{ type: 'text', text }] };
}

function jsonResult(value: unknown): CallToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function summarizeArgs(args: unknown): string {
  try {
    const json = JSON.stringify(args, (_k, v: unknown) => (typeof v === 'string' && v.length > 200 ? `${v.slice(0, 200)}… (${v.length} chars)` : v));
    return json.length > 600 ? `${json.slice(0, 600)}…` : json;
  } catch {
    return '[unserializable]';
  }
}

function uriFromInput(input: string): vscode.Uri {
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(input)) return vscode.Uri.parse(input);
  return vscode.Uri.file(resolveWorkspacePath(input));
}

function fileUri(filePath: string): vscode.Uri {
  return vscode.Uri.file(resolveWorkspacePath(filePath));
}

function openDocument(uri: vscode.Uri): vscode.TextDocument | undefined {
  const key = uri.toString();
  return vscode.workspace.textDocuments.find((d) => d.uri.toString() === key);
}

function diagnosticCode(code: vscode.Diagnostic['code']): string | undefined {
  if (code === undefined || code === null) return undefined;
  if (typeof code === 'object') return String(code.value);
  return String(code);
}

export function formatDiagnostics(entries: [vscode.Uri, readonly vscode.Diagnostic[]][]): unknown[] {
  return entries.map(([uri, diagnostics]) => ({
    uri: uri.toString(true),
    linesInFile: openDocument(uri)?.lineCount,
    diagnostics: diagnostics.map((d) => ({
      message: d.message,
      severity: vscode.DiagnosticSeverity[d.severity],
      range: {
        start: { line: d.range.start.line, character: d.range.start.character },
        end: { line: d.range.end.line, character: d.range.end.character },
      },
      source: d.source,
      code: diagnosticCode(d.code),
    })),
  }));
}

export function registerIdeTools(mcp: McpServer, host: IdeToolHost, log: Logger): void {
  /** Wraps a handler with debug logging and error → `isError` result conversion. */
  const guard =
    <A>(name: string, fn: (args: A, signal: AbortSignal) => Promise<CallToolResult> | CallToolResult) =>
    async (args: A, extra: { signal: AbortSignal }): Promise<CallToolResult> => {
      const started = Date.now();
      log.debug(`tool ${name} ${summarizeArgs(args)}`);
      try {
        const result = await fn(args, extra.signal);
        log.debug(`tool ${name} done in ${Date.now() - started} ms${result.isError ? ' (error)' : ''}`);
        return result;
      } catch (err) {
        log.error(`tool ${name} failed`, err);
        return textResult(`Error: ${errorMessage(err)}`, true);
      }
    };

  mcp.registerTool(
    'openDiff',
    {
      description: 'Open a git diff for the file',
      inputSchema: {
        old_file_path: z.string().describe('Path to the file to show diff for. If not provided, uses active editor.'),
        new_file_path: z.string().describe('Path to the file to show diff for. If not provided, uses active editor.'),
        new_file_contents: z.string().describe('Contents of the new file. If not provided then the current file contents of new_file_path will be used.'),
        tab_name: z.string().describe('Path to the file to show diff for. If not provided, uses active editor.'),
      },
    },
    guard('openDiff', async (args, signal) => {
      const outcome = await host.openDiff(
        { oldFilePath: args.old_file_path, newFilePath: args.new_file_path, newFileContents: args.new_file_contents, tabName: args.tab_name },
        signal,
      );
      if (outcome.kind === 'saved') {
        return { content: [{ type: 'text', text: 'FILE_SAVED' }, { type: 'text', text: outcome.contents }] };
      }
      return { content: [{ type: 'text', text: 'DIFF_REJECTED' }, { type: 'text', text: outcome.tabName }] };
    }),
  );

  mcp.registerTool(
    'getDiagnostics',
    {
      description: 'Get language diagnostics from the editor',
      inputSchema: {
        uri: z.string().optional().describe('Optional file URI to get diagnostics for. If not provided, gets diagnostics for all files.'),
      },
      annotations: { readOnlyHint: true },
    },
    guard('getDiagnostics', ({ uri }) => {
      const target = uri ? uriFromInput(uri) : undefined;
      const entries: [vscode.Uri, readonly vscode.Diagnostic[]][] = target ? [[target, vscode.languages.getDiagnostics(target)]] : vscode.languages.getDiagnostics();
      return jsonResult(formatDiagnostics(entries));
    }),
  );

  mcp.registerTool(
    'close_tab',
    {
      description: 'Close an editor tab by its title',
      inputSchema: { tab_name: z.string().describe('Title of the tab to close') },
    },
    guard('close_tab', async ({ tab_name }) => {
      await host.closeTab(tab_name);
      return textResult('TAB_CLOSED');
    }),
  );

  mcp.registerTool(
    'closeAllDiffTabs',
    { description: 'Close all diff tabs in the editor', inputSchema: {} },
    guard('closeAllDiffTabs', async () => {
      const closed = await host.closeAllDiffTabs();
      return textResult(`CLOSED_${closed}_DIFF_TABS`);
    }),
  );

  mcp.registerTool(
    'openFile',
    {
      description: 'Open a file in the editor and optionally select a range of text',
      inputSchema: {
        filePath: z.string().describe('Path to the file to open'),
        preview: z.boolean().describe('Whether to open the file in preview mode').default(false),
        startText: z.string().optional().describe('Text pattern to find the start of the selection range. Selects from the beginning of this match.'),
        endText: z
          .string()
          .optional()
          .describe('Text pattern to find the end of the selection range. Selects up to the end of this match. If not provided, only the startText match will be selected.'),
        selectToEndOfLine: z.boolean().describe('If true, selection will extend to the end of the line containing the endText match.').default(false),
        makeFrontmost: z
          .boolean()
          .describe('Whether to make the file the active editor tab. If false, the file will be opened in the background without changing focus.')
          .default(true),
      },
      annotations: { readOnlyHint: true },
    },
    guard('openFile', async ({ filePath, preview, startText, endText, selectToEndOfLine, makeFrontmost }) => {
      if (!filePath) throw new Error('File path is required');
      const uri = fileUri(filePath);
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        throw new Error(`File not found: ${uri.fsPath}`);
      }
      const doc = await vscode.workspace.openTextDocument(uri);
      const alreadyVisible = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
      const editor = makeFrontmost || !alreadyVisible ? await vscode.window.showTextDocument(doc, { preview, preserveFocus: !makeFrontmost }) : alreadyVisible;

      if (startText && editor) {
        const text = doc.getText();
        let message = `Opened file: ${uri.fsPath}`;
        const startIdx = text.indexOf(startText);
        if (startIdx === -1) {
          message = `Opened file, but text "${startText}" not found`;
        } else {
          const start = doc.positionAt(startIdx);
          let end: vscode.Position;
          if (endText) {
            const endIdx = text.substring(startIdx + startText.length).indexOf(endText);
            if (endIdx === -1) {
              end = start;
              message = `Opened file and positioned at "${startText}" (end text "${endText}" not found)`;
            } else {
              end = doc.positionAt(startIdx + startText.length + endIdx + endText.length);
              if (selectToEndOfLine) end = doc.lineAt(end.line).range.end;
              message = `Opened file and selected text from "${startText}" to "${endText}"`;
            }
          } else {
            end = doc.positionAt(startIdx + startText.length);
            message = `Opened file and selected text "${startText}"`;
          }
          editor.selection = new vscode.Selection(start, end);
          editor.revealRange(new vscode.Range(start, end), vscode.TextEditorRevealType.InCenter);
        }
        return textResult(message);
      }

      const info: Record<string, unknown> = { success: true, filePath: uri.fsPath, fileUrl: doc.uri.toString(), message: `Opened file: ${uri.fsPath}` };
      if (!makeFrontmost) {
        Object.assign(info, { languageId: doc.languageId, lineCount: doc.lineCount, isDirty: doc.isDirty, isUntitled: doc.isUntitled, isClosed: doc.isClosed });
        return jsonResult(info);
      }
      return textResult(String(info.message));
    }),
  );

  mcp.registerTool(
    'getOpenEditors',
    { description: 'Get information about currently open editors', inputSchema: {}, annotations: { readOnlyHint: true } },
    guard('getOpenEditors', () => {
      const active = vscode.window.activeTextEditor;
      const tabs: Record<string, unknown>[] = [];
      for (const group of vscode.window.tabGroups.all) {
        for (const tab of group.tabs) {
          if (!(tab.input instanceof vscode.TabInputText)) continue;
          const uri = tab.input.uri;
          const entry: Record<string, unknown> = {
            uri: uri.toString(),
            isActive: tab.isActive,
            isPinned: tab.isPinned,
            isPreview: tab.isPreview,
            isDirty: tab.isDirty,
            label: tab.label,
            groupIndex: group.viewColumn ? group.viewColumn - 1 : 0,
            viewColumn: group.viewColumn,
            isGroupActive: group.isActive,
          };
          const doc = openDocument(uri);
          if (doc) {
            entry.fileName = doc.fileName;
            entry.languageId = doc.languageId;
            entry.lineCount = doc.lineCount;
            entry.isUntitled = doc.isUntitled;
            if (active && active.document.uri.toString() === uri.toString()) {
              entry.selection = {
                start: { line: active.selection.start.line, character: active.selection.start.character },
                end: { line: active.selection.end.line, character: active.selection.end.character },
                isReversed: active.selection.isReversed,
              };
            }
          }
          tabs.push(entry);
        }
      }
      return jsonResult({ tabs });
    }),
  );

  mcp.registerTool(
    'getWorkspaceFolders',
    { description: 'Get all workspace folders currently open in the IDE', inputSchema: {}, annotations: { readOnlyHint: true } },
    guard('getWorkspaceFolders', () => {
      const folders = (vscode.workspace.workspaceFolders ?? []).map((f) => ({ name: f.name, uri: f.uri.toString(), path: f.uri.fsPath, index: f.index }));
      return jsonResult({
        success: true,
        folders,
        rootPath: folders[0]?.path ?? null,
        workspaceFile: vscode.workspace.workspaceFile?.toString() ?? null,
      });
    }),
  );

  mcp.registerTool(
    'getCurrentSelection',
    { description: 'Get the current text selection in the active editor', inputSchema: {}, annotations: { readOnlyHint: true } },
    guard('getCurrentSelection', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return jsonResult({ success: false, message: 'No active editor found' });
      const { selection, document } = editor;
      return jsonResult({
        success: true,
        text: document.getText(selection),
        filePath: document.uri.fsPath,
        fileUrl: document.uri.toString(),
        selection: {
          start: { line: selection.start.line, character: selection.start.character },
          end: { line: selection.end.line, character: selection.end.character },
          isEmpty: selection.isEmpty,
        },
      });
    }),
  );

  mcp.registerTool(
    'getLatestSelection',
    { description: 'Get the most recent text selection (even if not in the active editor)', inputSchema: {}, annotations: { readOnlyHint: true } },
    guard('getLatestSelection', () => {
      const latest = host.latestSelection();
      return jsonResult(latest ? { success: true, ...latest } : { success: false, message: 'No selection available' });
    }),
  );

  mcp.registerTool(
    'checkDocumentDirty',
    {
      description: 'Check if a document has unsaved changes (is dirty)',
      inputSchema: { filePath: z.string().describe('Path to the file to check') },
      annotations: { readOnlyHint: true },
    },
    guard('checkDocumentDirty', ({ filePath }) => {
      if (!filePath) throw new Error('File path is required');
      const uri = fileUri(filePath);
      const doc = openDocument(uri);
      if (!doc) return jsonResult({ success: false, message: `Document not open: ${uri.fsPath}` });
      return jsonResult({ success: true, filePath: uri.fsPath, isDirty: doc.isDirty, isUntitled: doc.isUntitled });
    }),
  );

  mcp.registerTool(
    'saveDocument',
    {
      description: 'Save a document with unsaved changes',
      inputSchema: { filePath: z.string().describe('Path to the file to save') },
    },
    guard('saveDocument', async ({ filePath }) => {
      if (!filePath) throw new Error('File path is required');
      const uri = fileUri(filePath);
      const doc = openDocument(uri);
      if (!doc) return jsonResult({ success: false, message: `Document not open: ${uri.fsPath}` });
      const saved = await doc.save();
      return jsonResult({ success: true, filePath: uri.fsPath, saved, message: saved ? 'Document saved successfully' : 'Document was not dirty or save failed' });
    }),
  );

}
