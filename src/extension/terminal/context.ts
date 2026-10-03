/**
 * Facts about the terminal the user is in: shell, cwd, OS. All best-effort;
 * shell integration may not be active yet, in which case we fall back to the
 * creation options / `$SHELL` / the workspace folder.
 */
import * as vscode from 'vscode';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

export interface TerminalContext {
  shell: string;
  cwd: string;
  os: string;
  /** Workspace folder for the CLI's cwd (settings are not loaded, but the path is logged). */
  workspace: string | undefined;
}

let osDescription: Promise<string> | undefined;

export async function gatherTerminalContext(terminal: vscode.Terminal): Promise<TerminalContext> {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  return {
    shell: detectShell(terminal),
    cwd: detectCwd(terminal) ?? workspace ?? os.homedir(),
    os: await describeOs(),
    workspace,
  };
}

export function detectShell(terminal: vscode.Terminal): string {
  const detected = terminal.state.shell;
  if (detected) return detected;
  const opts = terminal.creationOptions;
  if ('shellPath' in opts && typeof opts.shellPath === 'string' && opts.shellPath) return path.basename(opts.shellPath);
  const envShell = process.env.SHELL;
  if (envShell) return path.basename(envShell);
  return process.platform === 'win32' ? 'pwsh' : 'bash';
}

export function detectCwd(terminal: vscode.Terminal): string | undefined {
  const integrated = terminal.shellIntegration?.cwd;
  if (integrated) return integrated.fsPath;
  const opts = terminal.creationOptions;
  if ('cwd' in opts && opts.cwd) return typeof opts.cwd === 'string' ? opts.cwd : opts.cwd.fsPath;
  return undefined;
}

export function describeOs(): Promise<string> {
  if (!osDescription) {
    osDescription = (async () => {
      let pretty: string | undefined;
      if (process.platform === 'linux') {
        try {
          const release = await fs.readFile('/etc/os-release', 'utf8');
          const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(release);
          if (m) pretty = m[1].trim();
        } catch {
          // no os-release: fall through to the generic description
        }
      }
      const base = pretty ?? `${os.type()} ${os.release()}`;
      const kernel = pretty ? ` (${os.type()} ${os.release()}, ${os.arch()})` : ` (${os.arch()})`;
      return `${base}${kernel}`;
    })();
  }
  return osDescription;
}
