/**
 * Terminal output capture via shell integration.
 *
 * Every `onDidStartTerminalShellExecution` is read (`execution.read()`) as it
 * runs; ANSI/OSC sequences are stripped and the last 64 kB per terminal are
 * kept, together with the last few (command, output, exit code) records.
 * `lastOutput(terminal?)` returns "$ command\n<output>" of the most recent
 * execution — used by the @Terminal mention and the Debug Terminal command
 * (as a fallback when the clipboard-based copy commands yield nothing).
 */
import * as vscode from 'vscode';
import type { Logger } from '../util/log';

export const TERMINAL_BUFFER_LIMIT = 64 * 1024;
const MAX_EXECUTIONS_PER_TERMINAL = 8;

export interface TerminalExecutionRecord {
  command: string;
  output: string;
  exitCode?: number;
  startedAt: number;
  endedAt?: number;
  running: boolean;
}

interface TerminalRecord {
  buffer: string;
  executions: TerminalExecutionRecord[];
}

// OSC sequences: ESC ] ... (BEL | ESC \)
const OSC_RE = new RegExp('\\u001b\\][^\\u0007\\u001b]*(?:\\u0007|\\u001b\\\\)', 'g');
// CSI and other ESC sequences
const CSI_RE = new RegExp('\\u001b(?:\\[[0-?]*[ -/]*[@-~]|[@-Z\\\\-_]|\\([A-Za-z0-9])', 'g');
// Remaining C0 control chars except \t \n
const CTRL_RE = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f]', 'g');

export function stripAnsi(text: string): string {
  return text.replace(OSC_RE, '').replace(CSI_RE, '').replace(/\r\n?/g, '\n').replace(CTRL_RE, '');
}

export interface TerminalCapture extends vscode.Disposable {
  /** "$ <command>\n<output>" of the last execution in `terminal` (default: active terminal, else the most recent one). */
  lastOutput(terminal?: vscode.Terminal): { text: string; terminalName: string } | undefined;
  /** Raw tail of everything captured for the terminal. */
  buffer(terminal?: vscode.Terminal): string;
  /** Terminals with captured output, most recently active first. */
  terminalsWithOutput(): { terminal: vscode.Terminal; lastCommand?: string }[];
}

export function createTerminalCapture(context: vscode.ExtensionContext, log: Logger): TerminalCapture {
  const records = new Map<vscode.Terminal, TerminalRecord>();
  const recent: vscode.Terminal[] = [];
  const disposables: vscode.Disposable[] = [];

  const touch = (t: vscode.Terminal): TerminalRecord => {
    let r = records.get(t);
    if (!r) {
      r = { buffer: '', executions: [] };
      records.set(t, r);
    }
    const i = recent.indexOf(t);
    if (i >= 0) recent.splice(i, 1);
    recent.unshift(t);
    return r;
  };

  disposables.push(
    vscode.window.onDidStartTerminalShellExecution((e) => {
      const rec = touch(e.terminal);
      const exec: TerminalExecutionRecord = { command: e.execution.commandLine.value, output: '', startedAt: Date.now(), running: true };
      rec.executions.push(exec);
      if (rec.executions.length > MAX_EXECUTIONS_PER_TERMINAL) rec.executions.shift();
      void (async () => {
        try {
          for await (const chunk of e.execution.read()) {
            const clean = stripAnsi(chunk);
            if (!clean) continue;
            exec.output += clean;
            if (exec.output.length > TERMINAL_BUFFER_LIMIT) exec.output = exec.output.slice(-TERMINAL_BUFFER_LIMIT);
            rec.buffer += clean;
            if (rec.buffer.length > TERMINAL_BUFFER_LIMIT) rec.buffer = rec.buffer.slice(-TERMINAL_BUFFER_LIMIT);
          }
        } catch (err) {
          log.debug('terminal read ended', err);
        } finally {
          exec.running = false;
          exec.endedAt = exec.endedAt ?? Date.now();
        }
      })();
    }),
    vscode.window.onDidEndTerminalShellExecution((e) => {
      const rec = records.get(e.terminal);
      if (!rec) return;
      const exec = [...rec.executions].reverse().find((x) => x.command === e.execution.commandLine.value && x.exitCode === undefined);
      if (exec) {
        exec.exitCode = e.exitCode;
        exec.endedAt = Date.now();
      }
    }),
    vscode.window.onDidCloseTerminal((t) => {
      records.delete(t);
      const i = recent.indexOf(t);
      if (i >= 0) recent.splice(i, 1);
    }),
    vscode.window.onDidChangeActiveTerminal((t) => {
      if (t && records.has(t)) touch(t);
    }),
  );

  const pick = (terminal?: vscode.Terminal): vscode.Terminal | undefined => {
    if (terminal && records.has(terminal)) return terminal;
    const active = vscode.window.activeTerminal;
    if (active && records.has(active)) return active;
    return recent[0];
  };

  const capture: TerminalCapture = {
    lastOutput(terminal) {
      const t = pick(terminal);
      if (!t) return undefined;
      const rec = records.get(t);
      if (!rec) return undefined;
      const exec = rec.executions[rec.executions.length - 1];
      if (exec) {
        const status = exec.running ? ' (still running)' : exec.exitCode !== undefined && exec.exitCode !== 0 ? ` (exit code ${exec.exitCode})` : '';
        return { text: `$ ${exec.command}${status}\n${exec.output.trimEnd()}`, terminalName: t.name };
      }
      if (rec.buffer.trim()) return { text: rec.buffer.trimEnd(), terminalName: t.name };
      return undefined;
    },
    buffer(terminal) {
      const t = pick(terminal);
      return t ? (records.get(t)?.buffer ?? '') : '';
    },
    terminalsWithOutput() {
      return recent
        .filter((t) => records.has(t))
        .map((t) => {
          const ex = records.get(t)?.executions;
          return { terminal: t, lastCommand: ex && ex.length ? ex[ex.length - 1].command : undefined };
        });
    },
    dispose() {
      for (const d of disposables) d.dispose();
      records.clear();
      recent.length = 0;
    },
  };
  context.subscriptions.push(capture);
  return capture;
}
