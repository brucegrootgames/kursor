/**
 * Minimal in-memory FileSystemProvider used for the two sides of an `openDiff` editor
 * (schemes `kursor-ide-left` / `kursor-ide-right`). Each diff gets versioned URIs
 * (`?v=N`) so consecutive diffs of the same file never share a stale document.
 */
import * as vscode from 'vscode';

interface MemoryFile {
  data: Uint8Array;
  ctime: number;
  mtime: number;
}

export class MemoryFileSystemProvider implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly files = new Map<string, MemoryFile>();
  private readonly changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.changes.event;

  constructor(readonly scheme: string) {}

  /** `scheme:/abs/path?v=N` — keeps the file name/extension so language detection and tab labels work. */
  uriFor(fsPath: string, version: number): vscode.Uri {
    return vscode.Uri.file(fsPath).with({ scheme: this.scheme, query: `v=${version}` });
  }

  private key(uri: vscode.Uri): string {
    return uri.with({ scheme: this.scheme, fragment: '' }).toString();
  }

  createFile(uri: vscode.Uri, text: string): void {
    const key = this.key(uri);
    const existed = this.files.has(key);
    const now = Date.now();
    this.files.set(key, { data: Buffer.from(text, 'utf8'), ctime: this.files.get(key)?.ctime ?? now, mtime: now });
    this.changes.fire([{ type: existed ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }]);
  }

  has(uri: vscode.Uri): boolean {
    return this.files.has(this.key(uri));
  }

  readText(uri: vscode.Uri): string | undefined {
    const file = this.files.get(this.key(uri));
    return file ? Buffer.from(file.data).toString('utf8') : undefined;
  }

  deleteFile(uri: vscode.Uri): void {
    if (this.files.delete(this.key(uri))) {
      this.changes.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    }
  }

  // ---- vscode.FileSystemProvider -------------------------------------------------------------

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const file = this.files.get(this.key(uri));
    if (file) {
      return { type: vscode.FileType.File, ctime: file.ctime, mtime: file.mtime, size: file.data.byteLength };
    }
    // Directories exist implicitly for any known file underneath (breadcrumbs may stat parents).
    const prefix = uri.with({ scheme: this.scheme, query: '', fragment: '' }).toString().replace(/\/+$/, '') + '/';
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) return { type: vscode.FileType.Directory, ctime: 0, mtime: 0, size: 0 };
    }
    throw vscode.FileSystemError.FileNotFound(uri);
  }

  readDirectory(uri: vscode.Uri): [string, vscode.FileType][] {
    const prefix = uri.with({ scheme: this.scheme, query: '', fragment: '' }).toString().replace(/\/+$/, '') + '/';
    const entries: [string, vscode.FileType][] = [];
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const name = rest.split('/')[0]?.split('?')[0];
      if (name && !entries.some((e) => e[0] === name)) entries.push([name, rest.includes('/') ? vscode.FileType.Directory : vscode.FileType.File]);
    }
    return entries;
  }

  createDirectory(): void {
    // directories are implicit
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const file = this.files.get(this.key(uri));
    if (!file) throw vscode.FileSystemError.FileNotFound(uri);
    return file.data;
  }

  writeFile(uri: vscode.Uri, content: Uint8Array, options: { create: boolean; overwrite: boolean }): void {
    const key = this.key(uri);
    const existing = this.files.get(key);
    if (!existing && !options.create) throw vscode.FileSystemError.FileNotFound(uri);
    if (existing && options.create && !options.overwrite) throw vscode.FileSystemError.FileExists(uri);
    const now = Date.now();
    this.files.set(key, { data: content, ctime: existing?.ctime ?? now, mtime: now });
    this.changes.fire([{ type: existing ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }]);
  }

  delete(uri: vscode.Uri): void {
    this.deleteFile(uri);
  }

  rename(oldUri: vscode.Uri): void {
    throw vscode.FileSystemError.NoPermissions(oldUri);
  }

  dispose(): void {
    this.files.clear();
    this.changes.dispose();
  }
}
