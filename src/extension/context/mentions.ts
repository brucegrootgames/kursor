/**
 * @-mention search for the chat input.
 *
 * - Empty query → categories (Files & Folders, Code, Problems, Terminal, Git, Web,
 *   Docs, Rules) followed by the open editors.
 * - `/…` → slash commands (from `AppState.commands`, injected by the chat host).
 * - Otherwise fuzzy file/folder search over a ripgrep-built index (cached per
 *   workspace folder, refreshed at most every 5 s on file events), plus matching
 *   categories and workspace symbols (kind 'code', `value` = "L<start>-<end>").
 * - Drilling into a category (`kind` set) restricts results to that kind.
 */
import * as vscode from 'vscode';
import * as path from 'node:path';
import type { MentionKind, MentionResult, SlashCommandOption } from '../../shared/protocol';
import type { RulesService } from '../services';
import type { Logger } from '../util/log';
import { rankFuzzy } from './fuzzy';
import { listFiles } from './ripgrep';
import { problemsSummary, relPathOf } from './providers';
import type { TerminalCapture } from './terminalCapture';
import { getRepository } from './git';

const RESULT_LIMIT = 30;
const REFRESH_THROTTLE_MS = 5000;

interface FolderIndex {
  root: string;
  files: string[]; // relative, '/' separated
  folders: string[];
  builtAt: number;
  building?: Promise<void>;
  dirty: boolean;
}

export interface MentionSearch extends vscode.Disposable {
  search(query: string, kind: MentionKind | undefined, commands: SlashCommandOption[]): Promise<MentionResult[]>;
  /** Warm the file index (e.g. on activation). */
  prime(): void;
}

const CATEGORIES: { kind: MentionKind; label: string; detail: string; icon: string; keywords: string[] }[] = [
  { kind: 'file', label: 'Files & Folders', detail: 'Attach a file or folder', icon: 'files', keywords: ['files', 'folders', 'file', 'folder'] },
  { kind: 'code', label: 'Code', detail: 'Current selection or a symbol', icon: 'symbol-method', keywords: ['code', 'symbol', 'selection'] },
  { kind: 'problems', label: 'Problems', detail: 'Errors and warnings', icon: 'warning', keywords: ['problems', 'errors', 'warnings', 'diagnostics', 'lint'] },
  { kind: 'terminal', label: 'Terminal', detail: 'Last terminal command output', icon: 'terminal', keywords: ['terminal', 'shell', 'output'] },
  { kind: 'git', label: 'Git', detail: 'Uncommitted changes (diff of working state)', icon: 'git-commit', keywords: ['git', 'diff', 'changes', 'commit'] },
  { kind: 'web', label: 'Web', detail: 'Attach a URL for the agent to fetch', icon: 'globe', keywords: ['web', 'url', 'link', 'http'] },
  { kind: 'docs', label: 'Docs', detail: 'Documentation URL', icon: 'book', keywords: ['docs', 'documentation'] },
  { kind: 'rule', label: 'Rules', detail: 'Apply a project rule', icon: 'law', keywords: ['rules', 'rule', 'cursorrules'] },
];

function isUrl(q: string): boolean {
  return /^https?:\/\/\S+/i.test(q.trim());
}

function fileIcon(rel: string): string {
  const ext = path.extname(rel).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp'].includes(ext)) return 'file-media';
  if (['.md', '.mdx', '.txt', '.rst'].includes(ext)) return 'markdown';
  if (['.json', '.yaml', '.yml', '.toml', '.ini'].includes(ext)) return 'json';
  if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h', '.cs', '.rb', '.php', '.lua', '.sh'].includes(ext)) return 'file-code';
  return 'file';
}

export function createMentionSearch(
  context: vscode.ExtensionContext,
  deps: { log: Logger; rules: RulesService; terminals: TerminalCapture },
): MentionSearch {
  const { log } = deps;
  const indexes = new Map<string, FolderIndex>();
  const disposables: vscode.Disposable[] = [];
  let refreshTimer: NodeJS.Timeout | undefined;

  const folderRoots = (): string[] => (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);

  const build = (root: string): Promise<void> => {
    const existing = indexes.get(root);
    if (existing?.building) return existing.building;
    const idx: FolderIndex = existing ?? { root, files: [], folders: [], builtAt: 0, dirty: true };
    indexes.set(root, idx);
    idx.building = (async () => {
      try {
        const { files, truncated } = await listFiles(root, log);
        files.sort();
        const folders = new Set<string>();
        for (const f of files) {
          let dir = path.posix.dirname(f);
          while (dir && dir !== '.' && !folders.has(dir)) {
            folders.add(dir);
            dir = path.posix.dirname(dir);
          }
        }
        idx.files = files;
        idx.folders = [...folders].sort();
        idx.builtAt = Date.now();
        idx.dirty = false;
        log.debug(`indexed ${files.length} files in ${root}${truncated ? ' (truncated)' : ''}`);
      } catch (err) {
        log.error(`indexing ${root} failed`, err);
      } finally {
        idx.building = undefined;
      }
    })();
    return idx.building;
  };

  const markDirty = (): void => {
    for (const idx of indexes.values()) idx.dirty = true;
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = undefined;
      for (const idx of indexes.values()) if (idx.dirty) void build(idx.root);
    }, REFRESH_THROTTLE_MS);
  };

  const watcher = vscode.workspace.createFileSystemWatcher('**/*', false, true, false);
  disposables.push(
    watcher,
    watcher.onDidCreate(markDirty),
    watcher.onDidDelete(markDirty),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      for (const root of [...indexes.keys()]) if (!folderRoots().includes(root)) indexes.delete(root);
      for (const root of folderRoots()) void build(root);
    }),
  );

  const ensureIndexes = async (): Promise<FolderIndex[]> => {
    const roots = folderRoots();
    const out: FolderIndex[] = [];
    for (const root of roots) {
      const idx = indexes.get(root);
      if (!idx || (idx.builtAt === 0 && idx.building)) {
        // First build: wait for it (bounded) so the very first popover is not empty.
        const p = build(root);
        await Promise.race([p, new Promise((r) => setTimeout(r, 4000))]);
      } else if (idx.dirty && !idx.building) {
        void build(root);
      }
      const ready = indexes.get(root);
      if (ready) out.push(ready);
    }
    return out;
  };

  const openFiles = (): MentionResult[] => {
    const out: MentionResult[] = [];
    const seen = new Set<string>();
    const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
    for (const tab of tabs) {
      const input = tab.input;
      const uri = input instanceof vscode.TabInputText ? input.uri : input instanceof vscode.TabInputTextDiff ? input.modified : undefined;
      if (!uri || uri.scheme !== 'file' || seen.has(uri.fsPath)) continue;
      seen.add(uri.fsPath);
      const rel = relPathOf(uri.fsPath);
      out.push({ kind: 'file', label: path.basename(uri.fsPath), detail: rel, path: uri.fsPath, relPath: rel, icon: fileIcon(rel) });
    }
    const active = vscode.window.activeTextEditor?.document.uri;
    if (active) out.sort((a, b) => (a.path === active.fsPath ? -1 : b.path === active.fsPath ? 1 : 0));
    return out.slice(0, 12);
  };

  const fileResults = async (query: string, only?: 'file' | 'folder'): Promise<MentionResult[]> => {
    const idxs = await ensureIndexes();
    const multi = idxs.length > 1;
    type Item = { rel: string; root: string; folder: boolean };
    const items: Item[] = [];
    for (const idx of idxs) {
      if (only !== 'folder') for (const f of idx.files) items.push({ rel: f, root: idx.root, folder: false });
      if (only !== 'file') for (const f of idx.folders) items.push({ rel: f, root: idx.root, folder: true });
    }
    const q = query.replace(/^@/, '').replace(/^\//, '');
    const ranked = rankFuzzy(q, items, (i) => i.rel, RESULT_LIMIT);
    return ranked.map(({ item }) => {
      const abs = path.join(item.root, ...item.rel.split('/'));
      const rel = multi ? `${path.basename(item.root)}/${item.rel}` : item.rel;
      return {
        kind: item.folder ? 'folder' : 'file',
        label: path.basename(item.rel),
        detail: rel,
        path: abs,
        relPath: item.rel,
        icon: item.folder ? 'folder' : fileIcon(item.rel),
      } satisfies MentionResult;
    });
  };

  const symbolResults = async (query: string): Promise<MentionResult[]> => {
    if (query.length < 2) return [];
    try {
      const symbols = (await vscode.commands.executeCommand<vscode.SymbolInformation[]>('vscode.executeWorkspaceSymbolProvider', query)) ?? [];
      return symbols
        .filter((s) => s.location.uri.scheme === 'file')
        .slice(0, RESULT_LIMIT)
        .map((s) => {
          const rel = relPathOf(s.location.uri.fsPath);
          const r = s.location.range;
          return {
            kind: 'code' as const,
            label: s.name,
            detail: `${vscode.SymbolKind[s.kind]} · ${rel}:${r.start.line + 1}`,
            path: s.location.uri.fsPath,
            relPath: rel,
            icon: `symbol-${vscode.SymbolKind[s.kind].toLowerCase()}`,
            value: `L${r.start.line + 1}-${r.end.line + 1}`,
          };
        });
    } catch (err) {
      log.debug('workspace symbol search failed', err);
      return [];
    }
  };

  const codeResults = async (query: string): Promise<MentionResult[]> => {
    const out: MentionResult[] = [];
    const editor = vscode.window.activeTextEditor;
    if (editor && !editor.selection.isEmpty && editor.document.uri.scheme === 'file') {
      const rel = relPathOf(editor.document.uri.fsPath);
      const s = editor.selection;
      out.push({
        kind: 'code',
        label: `${path.basename(rel)}:${s.start.line + 1}-${s.end.line + 1}`,
        detail: 'Current selection',
        path: editor.document.uri.fsPath,
        relPath: rel,
        icon: 'selection',
        value: `L${s.start.line + 1}-${s.end.line + 1}`,
      });
    }
    out.push(...(await symbolResults(query)));
    return out;
  };

  const problemsResults = (query: string): MentionResult[] => {
    const all = problemsSummary();
    const out: MentionResult[] = [
      { kind: 'problems', label: 'All problems', detail: `${all.errors} errors, ${all.warnings} warnings in ${all.files} files`, icon: 'warning' },
    ];
    const perFile: { rel: string; fsPath: string; errors: number; warnings: number }[] = [];
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      if (uri.scheme !== 'file') continue;
      const errors = diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Error).length;
      const warnings = diags.filter((d) => d.severity === vscode.DiagnosticSeverity.Warning).length;
      if (errors + warnings === 0) continue;
      perFile.push({ rel: relPathOf(uri.fsPath), fsPath: uri.fsPath, errors, warnings });
    }
    const ranked = rankFuzzy(query, perFile, (f) => f.rel, RESULT_LIMIT - 1);
    for (const { item } of ranked) {
      out.push({ kind: 'problems', label: path.basename(item.rel), detail: `${item.rel} · ${item.errors} errors, ${item.warnings} warnings`, path: item.fsPath, relPath: item.rel, icon: item.errors ? 'error' : 'warning' });
    }
    return out;
  };

  const terminalResults = (): MentionResult[] => {
    const list = deps.terminals.terminalsWithOutput();
    if (!list.length) {
      const active = vscode.window.activeTerminal;
      return [{ kind: 'terminal', label: active ? active.name : 'Terminal', detail: 'Last command output (needs shell integration)', icon: 'terminal' }];
    }
    return list.map(({ terminal, lastCommand }) => ({
      kind: 'terminal' as const,
      label: terminal.name,
      detail: lastCommand ? `$ ${lastCommand.slice(0, 60)}` : 'Captured output',
      icon: 'terminal',
      value: terminal.name,
    }));
  };

  const gitResults = async (): Promise<MentionResult[]> => {
    const repo = await getRepository(vscode.window.activeTextEditor?.document.uri.fsPath ?? folderRoots()[0]);
    if (!repo) return [{ kind: 'git', label: 'Working changes', detail: 'No git repository found', icon: 'git-commit' }];
    const n = repo.state.workingTreeChanges.length + repo.state.indexChanges.length + repo.state.untrackedChanges.length;
    return [
      { kind: 'git', label: 'Working changes', detail: `${n} changed file${n === 1 ? '' : 's'}${repo.state.HEAD?.name ? ` on ${repo.state.HEAD.name}` : ''}`, icon: 'git-commit', value: 'working' },
    ];
  };

  const ruleResults = async (query: string): Promise<MentionResult[]> => {
    const out: MentionResult[] = [];
    for (const root of folderRoots()) {
      try {
        const rules = await deps.rules.listProjectRules(root);
        for (const r of rules) out.push({ kind: 'rule', label: r.name, detail: r.description ?? relPathOf(r.path), path: r.path, relPath: relPathOf(r.path), icon: 'law' });
      } catch (err) {
        log.debug('listProjectRules failed', err);
      }
    }
    return rankFuzzy(query, out, (r) => r.label, RESULT_LIMIT).map((r) => r.item);
  };

  const webResults = (query: string, kind: 'web' | 'docs'): MentionResult[] => {
    const q = query.trim();
    if (isUrl(q)) return [{ kind, label: q, detail: kind === 'docs' ? 'Attach documentation URL' : 'Attach URL', icon: kind === 'docs' ? 'book' : 'globe', value: q }];
    return [{ kind: 'category', label: kind === 'docs' ? 'Paste a documentation URL' : 'Paste a URL (https://…)', detail: 'The agent fetches it when relevant', icon: 'link', value: kind }];
  };

  const commandResults = (query: string, commands: SlashCommandOption[]): MentionResult[] => {
    const q = query.replace(/^\//, '');
    const ranked = rankFuzzy(q, commands, (c) => c.name, RESULT_LIMIT);
    return ranked.map(({ item }) => ({
      kind: 'command' as const,
      label: `/${item.name}`,
      detail: [item.description, item.argumentHint].filter(Boolean).join(' '),
      icon: 'terminal-cmd' as string,
      value: item.name,
    }));
  };

  const categoryResults = (query: string): MentionResult[] => {
    const q = query.trim().toLowerCase();
    return CATEGORIES.filter((c) => !q || c.keywords.some((k) => k.startsWith(q)) || c.label.toLowerCase().startsWith(q)).map((c) => ({
      kind: 'category' as const,
      label: c.label,
      detail: c.detail,
      icon: c.icon,
      value: c.kind,
    }));
  };

  const search = async (query: string, kind: MentionKind | undefined, commands: SlashCommandOption[]): Promise<MentionResult[]> => {
    const q = query.trim();
    if (q.startsWith('/') && !kind) return commandResults(q, commands);
    switch (kind) {
      case 'file':
      case 'folder':
        return q ? fileResults(q, undefined) : [...openFiles(), ...(await fileResults('', 'folder')).slice(0, 10)];
      case 'code':
        return codeResults(q);
      case 'problems':
        return problemsResults(q);
      case 'terminal':
        return terminalResults();
      case 'git':
        return gitResults();
      case 'web':
      case 'docs':
        return webResults(q, kind);
      case 'rule':
        return ruleResults(q);
      case 'command':
        return commandResults(q, commands);
      default:
        break;
    }
    if (!q) return [...categoryResults(''), ...openFiles()];
    if (isUrl(q)) return webResults(q, 'web');
    const [files, symbols] = await Promise.all([fileResults(q), q.length >= 3 ? symbolResults(q) : Promise.resolve([])]);
    const cats = categoryResults(q);
    const out: MentionResult[] = [...cats, ...files];
    for (const s of symbols.slice(0, 5)) out.push(s);
    return out.slice(0, RESULT_LIMIT + cats.length);
  };

  const api: MentionSearch = {
    search,
    prime() {
      for (const root of folderRoots()) void build(root);
    },
    dispose() {
      if (refreshTimer) clearTimeout(refreshTimer);
      for (const d of disposables) d.dispose();
      indexes.clear();
    },
  };
  context.subscriptions.push(api);
  return api;
}
