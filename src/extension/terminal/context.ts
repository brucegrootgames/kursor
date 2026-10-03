/**
 * Facts about the terminal the user is in: shell, cwd, OS. All best-effort;
 * shell integration may not be active yet, in which case we fall back to the
 * creation options / `$SHELL` / the platform default (PowerShell on Windows,
 * zsh on macOS, bash elsewhere).
 */
import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describeOsFacts, defaultShellName, describeShell, shellBaseName, shellFamily, type OsFacts, type ShellFamily } from './shell';

export interface TerminalContext {
  /** Human-readable shell name for the prompt ("zsh", "pwsh (PowerShell 7)", …). */
  shell: string;
  /** Syntax family the generated command must use. */
  shellFamily?: ShellFamily;
  cwd: string;
  os: string;
  /** Workspace folder for the CLI's cwd (settings are not loaded, but the path is logged). */
  workspace: string | undefined;
}

let osDescription: Promise<string> | undefined;

export async function gatherTerminalContext(terminal: vscode.Terminal): Promise<TerminalContext> {
  const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const raw = detectShell(terminal);
  return {
    shell: describeShell(raw),
    shellFamily: shellFamily(raw),
    cwd: detectCwd(terminal) ?? workspace ?? os.homedir(),
    os: await describeOs(),
    workspace,
  };
}

/** Raw shell name: `terminal.state.shell` (VS Code ≥ 1.93), else the `shellPath` basename, else `$SHELL` / platform default. */
export function detectShell(terminal: vscode.Terminal): string {
  const detected = terminal.state.shell;
  if (detected) return detected;
  const opts = terminal.creationOptions;
  if ('shellPath' in opts && typeof opts.shellPath === 'string' && opts.shellPath) return shellBaseName(opts.shellPath) || path.basename(opts.shellPath);
  return defaultShellName(process.platform, process.env);
}

export function detectCwd(terminal: vscode.Terminal): string | undefined {
  const integrated = terminal.shellIntegration?.cwd;
  if (integrated) return integrated.fsPath;
  const opts = terminal.creationOptions;
  if ('cwd' in opts && opts.cwd) return typeof opts.cwd === 'string' ? opts.cwd : opts.cwd.fsPath;
  return undefined;
}

function runQuiet(cmd: string, args: string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 3000, encoding: 'utf8', windowsHide: true }, (err, stdout) => resolve(err ? undefined : String(stdout ?? '').trim() || undefined));
    } catch {
      resolve(undefined);
    }
  });
}

export async function collectOsFacts(): Promise<OsFacts> {
  const facts: OsFacts = { platform: process.platform, type: os.type(), release: os.release(), arch: os.arch() };
  try {
    facts.version = os.version();
  } catch {
    // os.version() can throw on exotic platforms
  }
  if (process.platform === 'linux') {
    try {
      const release = await fs.readFile('/etc/os-release', 'utf8');
      const m = /^PRETTY_NAME="?([^"\n]+)"?/m.exec(release);
      if (m) facts.prettyName = m[1].trim();
    } catch {
      // no os-release: fall through to the generic description
    }
  } else if (process.platform === 'darwin') {
    facts.macVersion = await runQuiet('/usr/bin/sw_vers', ['-productVersion']);
  }
  return facts;
}

export function describeOs(): Promise<string> {
  if (!osDescription) osDescription = collectOsFacts().then(describeOsFacts);
  return osDescription;
}
