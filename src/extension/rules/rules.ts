/**
 * RulesService — Cursor-style rules for Kursor.
 *
 * Sources: `kursor.rules.user` (user rules), `.cursor/rules/**​/*.mdc`
 * (front matter: description / globs / alwaysApply), nested `.cursor/rules`
 * directories, `.cursorrules` (legacy, always) and root `AGENTS.md` (always).
 * `CLAUDE.md` is left to Claude Code itself.
 *
 * Scans are cached per cwd and invalidated by a FileSystemWatcher (debounced),
 * by configuration changes, and by a short TTL for folders outside the
 * workspace (where the watcher cannot see changes).
 */
import * as vscode from 'vscode';
import type { RuleInfo, RulesService } from '../services';
import type { Logger } from '../util/log';
import { buildAppendixText } from './appendix';
import { scanProjectRules, type LoadedRule } from './scan';

const CACHE_TTL_MS = 30_000;
const WATCH_DEBOUNCE_MS = 300;

export function createRulesService(context: vscode.ExtensionContext, log: Logger): RulesService {
  const emitter = new vscode.EventEmitter<void>();
  const cache = new Map<string, { at: number; promise: Promise<LoadedRule[]> }>();
  const disposables: vscode.Disposable[] = [];
  let debounce: NodeJS.Timeout | undefined;
  let disposed = false;

  const config = (): vscode.WorkspaceConfiguration => vscode.workspace.getConfiguration('kursor');
  const useProjectRules = (): boolean => config().get<boolean>('rules.useProjectRules', true) ?? true;

  const invalidate = (reason: string): void => {
    cache.clear();
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      debounce = undefined;
      if (disposed) return;
      log.debug(`rules changed (${reason})`);
      try {
        emitter.fire();
      } catch (err) {
        log.error('onDidChange listener threw', err);
      }
    }, WATCH_DEBOUNCE_MS);
  };

  for (const glob of ['**/.cursor/rules/**', '**/{.cursorrules,AGENTS.md}']) {
    try {
      const watcher = vscode.workspace.createFileSystemWatcher(glob);
      disposables.push(
        watcher,
        watcher.onDidChange((uri) => invalidate(`changed ${uri.fsPath}`)),
        watcher.onDidCreate((uri) => invalidate(`created ${uri.fsPath}`)),
        watcher.onDidDelete((uri) => invalidate(`deleted ${uri.fsPath}`)),
      );
    } catch (err) {
      log.warn(`could not watch ${glob}`, err);
    }
  }
  disposables.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('kursor.rules')) invalidate('configuration');
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => invalidate('workspace folders')),
  );

  function loadRules(cwd: string): Promise<LoadedRule[]> {
    if (!useProjectRules()) return Promise.resolve([]);
    const hit = cache.get(cwd);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
    const promise = scanProjectRules(cwd, log).catch((err: unknown) => {
      log.error(`scanning rules in ${cwd} failed`, err);
      return [] as LoadedRule[];
    });
    cache.set(cwd, { at: Date.now(), promise });
    return promise;
  }

  const service: RulesService = {
    onDidChange: emitter.event,

    userRules() {
      return config().get<string>('rules.user', '') ?? '';
    },

    async listProjectRules(cwd: string): Promise<RuleInfo[]> {
      const rules = await loadRules(cwd);
      return rules.map<RuleInfo>(({ name, path, kind, description, globs }) => ({ name, path, kind, description, globs }));
    },

    async buildAppendix(cwd: string, contextPaths: string[] = []): Promise<string> {
      try {
        const rules = await loadRules(cwd);
        const text = buildAppendixText({ cwd, userRules: service.userRules(), rules, contextPaths });
        if (text) log.debug(`appendix for ${cwd}: ${text.length} chars, ${rules.length} project rules, ${contextPaths.length} context paths`);
        return text;
      } catch (err) {
        log.error('building the rules appendix failed', err);
        return '';
      }
    },

    dispose() {
      if (disposed) return;
      disposed = true;
      if (debounce) clearTimeout(debounce);
      for (const d of disposables) {
        try {
          d.dispose();
        } catch {
          /* ignore */
        }
      }
      emitter.dispose();
      cache.clear();
    },
  };

  context.subscriptions.push(service);
  return service;
}
