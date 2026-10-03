/**
 * Minimal typings for the built-in `vscode.git` extension API — the subset
 * Kursor uses, copied from extensions/git/src/api/git.d.ts (VS Code 1.136).
 * Acquire with `vscode.extensions.getExtension<GitExtension>('vscode.git')`.
 *
 * Note: the real file declares `Status` as a `const enum`; we deliberately type
 * `Change.status` as a number because esbuild cannot inline const enums from
 * declaration files.
 */
import type { Event, Uri } from 'vscode';

export interface GitExtension {
  readonly enabled: boolean;
  readonly onDidChangeEnablement: Event<boolean>;
  getAPI(version: 1): API;
}

export type APIState = 'uninitialized' | 'initialized';

export interface API {
  readonly state: APIState;
  readonly onDidChangeState: Event<APIState>;
  readonly git: { readonly path: string };
  readonly repositories: Repository[];
  readonly onDidOpenRepository: Event<Repository>;
  readonly onDidCloseRepository: Event<Repository>;
  getRepository(uri: Uri): Repository | null;
  getRepositoryRoot(uri: Uri): Promise<Uri | null>;
}

export interface InputBox {
  value: string;
}

export interface UpstreamRef {
  readonly remote: string;
  readonly name: string;
  readonly commit?: string;
}

export interface Branch {
  readonly name?: string;
  readonly commit?: string;
  readonly upstream?: UpstreamRef;
  readonly ahead?: number;
  readonly behind?: number;
}

export interface Change {
  readonly uri: Uri;
  readonly originalUri: Uri;
  readonly renameUri: Uri | undefined;
  /** `Status` enum value (INDEX_MODIFIED = 0 … BOTH_MODIFIED = 18). */
  readonly status: number;
}

export interface RepositoryState {
  readonly HEAD: Branch | undefined;
  readonly mergeChanges: Change[];
  readonly indexChanges: Change[];
  readonly workingTreeChanges: Change[];
  readonly untrackedChanges: Change[];
  readonly onDidChange: Event<void>;
}

export interface Commit {
  readonly hash: string;
  readonly message: string;
  readonly parents: string[];
  readonly authorDate?: Date;
  readonly authorName?: string;
  readonly authorEmail?: string;
  readonly commitDate?: Date;
}

export interface LogOptions {
  readonly maxEntries?: number;
  readonly path?: string;
}

export interface Repository {
  readonly rootUri: Uri;
  readonly inputBox: InputBox;
  readonly state: RepositoryState;
  readonly kind?: 'repository' | 'submodule' | 'worktree';
  /** Unified diff of the working tree (or of the index when `cached` is true). */
  diff(cached?: boolean): Promise<string>;
  diffIndexWithHEAD(): Promise<Change[]>;
  diffWithHEAD(): Promise<Change[]>;
  log(options?: LogOptions): Promise<Commit[]>;
  getConfig(key: string): Promise<string>;
}
