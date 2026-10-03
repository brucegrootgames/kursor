/**
 * `kursor-orig:` read-only documents serving the pre-edit snapshot of a tracked
 * file, used as the left side of review diffs. URI: kursor-orig:<fsPath>?v=<n>
 * (`?empty=1` → always empty, used as the right side for deleted files).
 */
import * as vscode from 'vscode';
import type { TrackedFile } from './model';

export const ORIG_SCHEME = 'kursor-orig';

export class OrigContentProvider implements vscode.TextDocumentContentProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  constructor(private readonly lookup: (fsPath: string) => TrackedFile | undefined) {}

  static uriFor(file: TrackedFile): vscode.Uri {
    return vscode.Uri.from({ scheme: ORIG_SCHEME, path: file.path, query: `v=${file.version}` });
  }
  static emptyUriFor(fsPath: string): vscode.Uri {
    return vscode.Uri.from({ scheme: ORIG_SCHEME, path: fsPath, query: 'empty=1' });
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    if (uri.query.includes('empty=1')) return '';
    return this.lookup(uri.path)?.base ?? '';
  }

  refresh(file: TrackedFile): void {
    this.emitter.fire(OrigContentProvider.uriFor(file));
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
