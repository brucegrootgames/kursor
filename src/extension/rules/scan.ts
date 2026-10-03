/**
 * Discover project rules on disk:
 *   - <cwd>/.cursor/rules/**​/*.mdc (and .md)          → parsed front matter
 *   - <sub>/.cursor/rules/**​/*.mdc (nested, bounded)  → scoped to that subtree
 *   - <cwd>/.cursorrules                              → legacy, always applied
 *   - <cwd>/AGENTS.md                                 → always applied
 * vscode-free.
 */
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import type { RuleInfo } from '../services';
import type { Logger } from '../util/log';
import { parseRuleFile } from './parse';

export interface LoadedRule extends RuleInfo {
  body: string;
  /** Workspace-relative path with forward slashes (for display and the index). */
  relPath: string;
}

const MAX_RULE_BYTES = 256 * 1024;
const NESTED_MAX_DEPTH = 4;
const NESTED_MAX_DIRS = 1500;
const SKIP_DIRS = new Set(['node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out', 'target', '.venv', 'venv', 'vendor', '.next', '.nuxt', '.cache', '__pycache__', '.idea', '.vscode-test', 'coverage']);

async function readText(file: string, log?: Logger): Promise<string | undefined> {
  try {
    const st = await fs.stat(file);
    if (!st.isFile()) return undefined;
    if (st.size > MAX_RULE_BYTES) {
      log?.warn(`rule file ${file} is ${st.size} bytes; only the first ${MAX_RULE_BYTES} are used`);
      const handle = await fs.open(file, 'r');
      try {
        const buf = Buffer.alloc(MAX_RULE_BYTES);
        const { bytesRead } = await handle.read(buf, 0, MAX_RULE_BYTES, 0);
        return buf.subarray(0, bytesRead).toString('utf8');
      } finally {
        await handle.close();
      }
    }
    return await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

function rel(cwd: string, file: string): string {
  return path.relative(cwd, file).split(path.sep).join('/');
}

async function walkRuleFiles(dir: string, depth = 0): Promise<string[]> {
  if (depth > 6) return [];
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files: string[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) files.push(...(await walkRuleFiles(full, depth + 1)));
    else if (e.isFile() && (e.name.endsWith('.mdc') || e.name.endsWith('.md'))) files.push(full);
  }
  return files;
}

/** Find `.cursor/rules` directories below `cwd` (excluding the root one), bounded. */
async function findNestedRuleDirs(cwd: string): Promise<string[]> {
  const found: string[] = [];
  let visited = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > NESTED_MAX_DEPTH || visited > NESTED_MAX_DIRS) return;
    let entries: import('node:fs').Dirent[];
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    visited++;
    for (const e of entries) {
      if (!e.isDirectory() || e.isSymbolicLink()) continue;
      if (e.name === '.cursor') {
        if (depth > 0) {
          const rulesDir = path.join(dir, '.cursor', 'rules');
          try {
            if ((await fs.stat(rulesDir)).isDirectory()) found.push(rulesDir);
          } catch {
            /* no rules dir */
          }
        }
        continue;
      }
      if (SKIP_DIRS.has(e.name) || (e.name.startsWith('.') && e.name !== '.cursor')) continue;
      await walk(path.join(dir, e.name), depth + 1);
    }
  };
  await walk(cwd, 0);
  return found;
}

function kindOf(parsed: { alwaysApply: boolean; globs: string[]; description?: string }): RuleInfo['kind'] {
  if (parsed.alwaysApply) return 'always';
  if (parsed.globs.length > 0) return 'auto';
  if (parsed.description) return 'agent';
  return 'manual';
}

async function loadMdcRules(cwd: string, rulesDir: string, scopeRel: string | undefined, log?: Logger): Promise<LoadedRule[]> {
  const files = await walkRuleFiles(rulesDir);
  const out: LoadedRule[] = [];
  for (const file of files) {
    const text = await readText(file, log);
    if (text === undefined) continue;
    const parsed = parseRuleFile(text);
    let globs = parsed.globs;
    let kind = kindOf(parsed);
    if (scopeRel) {
      // Nested rules apply to their own subtree: scope the globs, or attach to the whole subtree.
      globs = globs.length ? globs.map((g) => (g.startsWith('/') ? `${scopeRel}${g}` : `${scopeRel}/${g.replace(/^\.\//, '')}`)) : [`${scopeRel}/**`];
      if (!parsed.alwaysApply) kind = 'auto';
    }
    out.push({
      name: path.basename(file).replace(/\.(mdc|md)$/, ''),
      path: file,
      relPath: rel(cwd, file),
      kind,
      description: parsed.description,
      globs: globs.length ? globs : undefined,
      body: parsed.body,
    });
  }
  return out;
}

export async function scanProjectRules(cwd: string, log?: Logger): Promise<LoadedRule[]> {
  const rules: LoadedRule[] = [];

  const agentsMd = path.join(cwd, 'AGENTS.md');
  const agentsText = await readText(agentsMd, log);
  if (agentsText !== undefined && agentsText.trim()) {
    rules.push({ name: 'AGENTS.md', path: agentsMd, relPath: 'AGENTS.md', kind: 'agents-md', body: agentsText.trim() });
  }

  const cursorrules = path.join(cwd, '.cursorrules');
  const legacyText = await readText(cursorrules, log);
  if (legacyText !== undefined && legacyText.trim()) {
    rules.push({ name: '.cursorrules', path: cursorrules, relPath: '.cursorrules', kind: 'legacy', body: legacyText.trim() });
  }

  rules.push(...(await loadMdcRules(cwd, path.join(cwd, '.cursor', 'rules'), undefined, log)));

  try {
    for (const nested of await findNestedRuleDirs(cwd)) {
      const scopeRel = rel(cwd, path.dirname(path.dirname(nested)));
      rules.push(...(await loadMdcRules(cwd, nested, scopeRel, log)));
    }
  } catch (err) {
    log?.debug(`nested rule scan failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return rules;
}
