/**
 * Minimal glob matcher for rule `globs` (no dependency): `**`, `*`, `?`,
 * `[abc]`, `{a,b}`. Paths are matched with forward slashes.
 *
 * Cursor semantics are lenient: a pattern without a `/` (e.g. `*.ts`) matches
 * the file name anywhere in the tree; a pattern with a `/` matches the
 * workspace-relative path, and is also tried with an implicit `**​/` prefix.
 * vscode-free.
 */
const cache = new Map<string, RegExp>();

export function globToRegExp(glob: string): RegExp {
  const cached = cache.get(glob);
  if (cached) return cached;
  let re = '';
  let i = 0;
  let braceDepth = 0;
  while (i < glob.length) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**/` → any number of directories (including none); trailing `**` → anything
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?';
          i += 3;
        } else {
          re += '.*';
          i += 2;
        }
        continue;
      }
      re += '[^/]*';
      i++;
      continue;
    }
    if (c === '?') {
      re += '[^/]';
      i++;
      continue;
    }
    if (c === '[') {
      const close = glob.indexOf(']', i + 1);
      if (close > i) {
        let body = glob.slice(i + 1, close);
        if (body.startsWith('!')) body = `^${body.slice(1)}`;
        re += `[${body.replace(/\\/g, '\\\\')}]`;
        i = close + 1;
        continue;
      }
    }
    if (c === '{') {
      braceDepth++;
      re += '(?:';
      i++;
      continue;
    }
    if (c === '}' && braceDepth > 0) {
      braceDepth--;
      re += ')';
      i++;
      continue;
    }
    if (c === ',' && braceDepth > 0) {
      re += '|';
      i++;
      continue;
    }
    re += c.replace(/[.+^$()|\\/]/g, '\\$&');
    i++;
  }
  const compiled = new RegExp(`^${re}$`);
  if (cache.size > 500) cache.clear();
  cache.set(glob, compiled);
  return compiled;
}

export function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\/+/, '');
}

export function globMatches(glob: string, relPath: string): boolean {
  let pattern = normalizePath(glob.trim());
  if (!pattern) return false;
  const file = normalizePath(relPath);
  if (!pattern.includes('/')) {
    const base = file.slice(file.lastIndexOf('/') + 1);
    return globToRegExp(pattern).test(base) || globToRegExp(pattern).test(file);
  }
  if (pattern.endsWith('/')) pattern += '**';
  if (globToRegExp(pattern).test(file)) return true;
  if (!pattern.startsWith('**/') && globToRegExp(`**/${pattern}`).test(file)) return true;
  return false;
}

export function anyGlobMatches(globs: readonly string[], relPaths: readonly string[]): boolean {
  for (const g of globs) for (const p of relPaths) if (globMatches(g, p)) return true;
  return false;
}
