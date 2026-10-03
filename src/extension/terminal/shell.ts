/**
 * Pure helpers for terminal command generation: which shell family we are talking to and a
 * one-line description of the OS. No `vscode` import (unit-tested).
 */
import type { Platform } from '../util/platform';

export type ShellFamily = 'posix' | 'powershell' | 'cmd' | 'unknown';

/**
 * Classify a shell name as reported by `terminal.state.shell` (`bash`, `zsh`, `fish`, `pwsh`,
 * `cmd`, `gitbash`, `wsl`, `nu`, …), a `shellPath` basename (`pwsh.exe`, `powershell.exe`,
 * `C:\Windows\System32\cmd.exe`) or `$SHELL`.
 */
export function shellFamily(shell: string): ShellFamily {
  const name = shellBaseName(shell);
  if (name === 'pwsh' || name === 'powershell' || name === 'powershell_ise') return 'powershell';
  if (name === 'cmd' || name === 'command') return 'cmd';
  if (['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'csh', 'tcsh', 'ash', 'gitbash', 'git-bash', 'wsl', 'mksh', 'busybox'].includes(name)) return 'posix';
  return 'unknown';
}

/** `C:\Program Files\PowerShell\7\pwsh.exe` → `pwsh`; `/bin/zsh` → `zsh`. */
export function shellBaseName(shell: string): string {
  const base = shell.trim().split(/[\\/]/).pop() ?? '';
  return base.toLowerCase().replace(/\.(exe|cmd|bat)$/i, '');
}

/** Human name for the prompt ("pwsh (PowerShell 7)", "bash (Git Bash)"). */
export function describeShell(shell: string): string {
  const name = shellBaseName(shell);
  switch (name) {
    case 'pwsh':
      return 'pwsh (PowerShell 7)';
    case 'powershell':
      return 'powershell (Windows PowerShell 5.1)';
    case 'cmd':
      return 'cmd (Windows Command Prompt)';
    case 'gitbash':
    case 'git-bash':
      return 'bash (Git Bash on Windows)';
    case 'wsl':
      return 'bash (WSL)';
    default:
      return name || shell;
  }
}

/** Shell to assume when VS Code has not told us yet. */
export function defaultShellName(platform: Platform, env: NodeJS.ProcessEnv): string {
  if (platform === 'win32') return 'powershell';
  const fromEnv = env.SHELL ? shellBaseName(env.SHELL) : '';
  if (fromEnv) return fromEnv;
  return platform === 'darwin' ? 'zsh' : 'bash';
}

/** Extra rules for the model, per shell family. */
export function shellGuidance(family: ShellFamily): string[] {
  switch (family) {
    case 'powershell':
      return [
        'The shell is PowerShell: use cmdlets and PowerShell syntax (Get-ChildItem, Select-String, Remove-Item, $env:VAR, ; to separate commands, | for pipelines). Do not use bash-only syntax such as &&, $(...), export or single-quoted globbing; external tools like git, npm and rg are fine.',
      ];
    case 'cmd':
      return ['The shell is the Windows Command Prompt (cmd.exe): use cmd built-ins (dir, del, findstr, %VAR%, & to chain, && on success). No PowerShell cmdlets, no bash syntax.'];
    case 'posix':
      return ['The shell is POSIX-compatible: GNU coreutils on Linux, BSD variants on macOS (check the OS line).'];
    default:
      return [];
  }
}

export interface OsFacts {
  platform: Platform;
  /** `os.type()` */
  type: string;
  /** `os.release()` */
  release: string;
  arch: string;
  /** `os.version()` (e.g. "Windows 11 Pro", "Darwin Kernel Version …") */
  version?: string;
  /** `PRETTY_NAME` from /etc/os-release (Linux). */
  prettyName?: string;
  /** `sw_vers -productVersion` (macOS). */
  macVersion?: string;
}

/** "Arch Linux (Linux 6.12, x64)", "macOS 15.1 (Darwin 24.1.0, arm64)", "Windows 11 Pro (10.0.26100, x64)". */
export function describeOsFacts(f: OsFacts): string {
  if (f.platform === 'darwin') {
    const base = f.macVersion ? `macOS ${f.macVersion}` : 'macOS';
    return `${base} (Darwin ${f.release}, ${f.arch})`;
  }
  if (f.platform === 'win32') {
    const base = f.version?.trim() || 'Windows';
    return `${base} (${f.release}, ${f.arch})`;
  }
  if (f.prettyName) return `${f.prettyName} (${f.type} ${f.release}, ${f.arch})`;
  return `${f.type} ${f.release} (${f.arch})`;
}
