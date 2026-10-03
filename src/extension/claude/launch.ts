/**
 * How to start `claude <args>` as the process of an integrated terminal (sign-in flow).
 *
 * We hand VS Code the executable and an args array (`shellPath` / `shellArgs`) instead of typing a
 * command line into whatever shell the user has: that avoids quoting rules that differ between
 * bash, PowerShell and cmd.exe. Batch-file shims go through cmd.exe and `.js` entry points through
 * `node`, mirroring `status.ts#spawnSpec`. vscode-free (unit-tested).
 */
import { getEnv, isWindows, isWindowsScript, type Platform } from '../util/platform';

export interface TerminalLaunchSpec {
  shellPath: string;
  shellArgs: string[];
}

export function terminalLaunchSpec(claudePath: string, args: readonly string[], platform: Platform = process.platform, env: NodeJS.ProcessEnv = process.env): TerminalLaunchSpec {
  if (/\.(m?js|cjs)$/i.test(claudePath)) return { shellPath: 'node', shellArgs: [claudePath, ...args] };
  if (isWindows(platform) && isWindowsScript(claudePath)) {
    const comspec = getEnv(env, 'ComSpec', platform) || 'cmd.exe';
    // node-pty quotes each argument itself; `/d` skips AutoRun, `/c` runs and exits.
    return { shellPath: comspec, shellArgs: ['/d', '/c', claudePath, ...args] };
  }
  return { shellPath: claudePath, shellArgs: [...args] };
}
