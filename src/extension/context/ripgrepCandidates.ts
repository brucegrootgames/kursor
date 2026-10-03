/**
 * Where a `rg` binary may live, per platform (pure; unit-tested).
 *
 * VS Code / VSCodium ≥ 1.13x ship ripgrep as `@vscode/ripgrep-universal` inside
 * `node_modules.asar.unpacked` with one binary per `<platform>-<arch>` (verified against
 * the VSCodium 1.135 build installed on this machine); older builds used
 * `@vscode/ripgrep/bin/rg`. After the editor's own copy we try PATH, then the usual
 * package-manager locations.
 */
import { exeName, getEnv, isWindows, pathEntries, pathFor, type Platform } from '../util/platform';

export interface RipgrepCandidateInput {
  /** `vscode.env.appRoot` */
  appRoot: string;
  platform: Platform;
  arch: string;
  env: NodeJS.ProcessEnv;
  home: string;
}

export function ripgrepCandidates(input: RipgrepCandidateInput): string[] {
  const { appRoot, platform, arch, env, home } = input;
  const pp = pathFor(platform);
  const exe = exeName('rg', platform);
  const out: string[] = [];
  const add = (p: string): void => {
    if (p && !out.includes(p)) out.push(p);
  };
  const target = `${platform}-${arch}`;
  add(pp.join(appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep-universal', 'bin', target, exe));
  add(pp.join(appRoot, 'node_modules', '@vscode', 'ripgrep-universal', 'bin', target, exe));
  add(pp.join(appRoot, 'node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin', exe));
  add(pp.join(appRoot, 'node_modules', '@vscode', 'ripgrep', 'bin', exe));
  for (const dir of pathEntries(env, platform)) add(pp.join(dir, exe));
  if (isWindows(platform)) {
    const localAppData = getEnv(env, 'LOCALAPPDATA', platform) || pp.join(home, 'AppData', 'Local');
    const programFiles = getEnv(env, 'ProgramFiles', platform) || 'C:\\Program Files';
    add(pp.join(home, 'scoop', 'shims', exe));
    add(pp.join(localAppData, 'Microsoft', 'WinGet', 'Links', exe));
    add(pp.join(programFiles, 'Git', 'usr', 'bin', exe));
    add(pp.join(home, '.cargo', 'bin', exe));
  } else {
    if (platform === 'darwin') add('/opt/homebrew/bin/rg');
    add('/usr/local/bin/rg');
    add('/usr/bin/rg');
    add(pp.join(home, '.local', 'bin', 'rg'));
    add(pp.join(home, '.cargo', 'bin', 'rg'));
  }
  return out;
}
