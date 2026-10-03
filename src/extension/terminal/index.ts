/**
 * [D2] Ctrl+K in the terminal — `kursor.terminal.generate`.
 *
 * Flow: InputBox ("Describe the command…") → oneShot (shell, cwd, OS in the
 * prompt; cancellable progress notification) → QuickPick with
 *   ▶ Run · ⎘ Insert · ✎ Edit prompt · Copy · Ask in Chat
 * Esc on the QuickPick inserts the command without running it (Cursor
 * behaviour). "Edit prompt" loops back to the InputBox with the previous text
 * and feeds the previous command to the model for refinement.
 */
import * as vscode from 'vscode';
import type { TerminalDeps } from '../services';
import { gatherTerminalContext, TerminalContext } from './context';
import { TERMINAL_SYSTEM_PROMPT, buildTerminalPrompt, sanitizeCommand } from './prompt';

type Action = 'run' | 'insert' | 'edit' | 'copy' | 'chat';

interface ActionItem extends vscode.QuickPickItem {
  action: Action;
}

const LAST_REQUEST_KEY = 'kursor.terminal.lastRequest';

export function registerTerminal(context: vscode.ExtensionContext, deps: TerminalDeps): void {
  context.subscriptions.push(
    vscode.commands.registerCommand('kursor.terminal.generate', async () => {
      try {
        await generateCommand(context, deps);
      } catch (e) {
        if (isAbortError(e)) return;
        deps.log.error('kursor.terminal.generate failed', e);
        const pick = await vscode.window.showErrorMessage(
          `Kursor: could not generate a command — ${e instanceof Error ? e.message : String(e)}`,
          'Show Logs',
        );
        if (pick === 'Show Logs') deps.log.show();
      }
    }),
  );
  deps.log.info('terminal command generation registered');
}

async function generateCommand(context: vscode.ExtensionContext, deps: TerminalDeps): Promise<void> {
  const { bridge, log } = deps;

  let terminal = vscode.window.activeTerminal;
  if (!terminal) {
    terminal = vscode.window.createTerminal({ name: 'Kursor' });
    terminal.show(true);
  }

  let request = '';
  let previous: { request: string; command: string } | undefined;

  for (;;) {
    const input = await vscode.window.showInputBox({
      title: previous ? 'Kursor: edit the request' : 'Kursor: generate a terminal command',
      prompt: 'Describe the command… (Enter to generate, Esc to cancel)',
      placeHolder: 'e.g. find all TODO comments under src, show the 10 largest files, undo the last commit but keep changes',
      value: request,
      valueSelection: request ? [0, request.length] : undefined,
      ignoreFocusOut: true,
      validateInput: (v) => (v.trim() ? undefined : 'Describe what the command should do'),
    });
    if (input === undefined) return;
    request = input.trim();
    void context.workspaceState.update(LAST_REQUEST_KEY, request);

    const ctx = await gatherTerminalContext(terminal);
    const model = (vscode.workspace.getConfiguration('kursor.terminal').get<string>('model', 'sonnet') || 'sonnet').trim();
    log.info(`generate: "${request}" (shell=${ctx.shell}, cwd=${ctx.cwd}, model=${model})`);

    const command = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'Kursor: generating command…', cancellable: true },
      async (_progress, token) => {
        const controller = new AbortController();
        const sub = token.onCancellationRequested(() => controller.abort());
        try {
          const raw = await bridge.oneShot({
            systemPrompt: TERMINAL_SYSTEM_PROMPT,
            prompt: buildTerminalPrompt({ request, context: ctx, previous }),
            model,
            cwd: ctx.workspace ?? ctx.cwd,
            signal: controller.signal,
            maxTurns: 1,
          });
          return sanitizeCommand(raw);
        } catch (e) {
          if (controller.signal.aborted || isAbortError(e)) return undefined;
          throw e;
        } finally {
          sub.dispose();
        }
      },
    );
    if (command === undefined) return; // cancelled

    if (!command) {
      const pick = await vscode.window.showWarningMessage('Kursor could not turn that request into a command.', 'Edit request', 'Cancel');
      if (pick !== 'Edit request') return;
      previous = undefined;
      continue;
    }
    log.info(`generated: ${command}`);

    const action = await pickAction(request, command, ctx);
    switch (action) {
      case 'run':
        terminal.show();
        terminal.sendText(command, true);
        return;
      case 'insert':
        terminal.show();
        terminal.sendText(command, false);
        return;
      case 'copy':
        await vscode.env.clipboard.writeText(command);
        vscode.window.setStatusBarMessage('Kursor: command copied to clipboard', 2500);
        return;
      case 'chat':
        await deps.chat.sendPrompt(
          `I am in a ${ctx.shell} terminal on ${ctx.os}, working directory \`${ctx.cwd}\`. ${request}\n\nA first suggestion was:\n\`\`\`sh\n${command}\n\`\`\`\nExplain what it does, point out risks, and improve it if needed.`,
          [],
          { mode: 'ask' },
        );
        return;
      case 'edit':
        previous = { request, command };
        continue;
    }
  }
}

function pickAction(request: string, command: string, ctx: TerminalContext): Promise<Action> {
  return new Promise<Action>((resolve) => {
    const qp = vscode.window.createQuickPick<ActionItem>();
    qp.title = `Kursor: ${request}`;
    qp.placeholder = command;
    qp.ignoreFocusOut = true;
    qp.matchOnDescription = true;
    qp.matchOnDetail = true;
    qp.items = [
      { label: '$(play) Run', detail: command, description: `in ${ctx.shell} · ${shorten(ctx.cwd)}`, action: 'run' },
      { label: '$(insert) Insert', description: 'Type it into the terminal without running (Esc does this too)', action: 'insert' },
      { label: '$(edit) Edit prompt', description: 'Refine the request and generate again', action: 'edit' },
      { label: '$(copy) Copy', description: 'Copy the command to the clipboard', action: 'copy' },
      { label: '$(comment-discussion) Ask in Chat', description: 'Discuss this command with Kursor', action: 'chat' },
    ];
    qp.activeItems = [qp.items[0]];
    let settled = false;
    const finish = (a: Action) => {
      if (settled) return;
      settled = true;
      resolve(a);
      qp.hide();
    };
    qp.onDidAccept(() => finish(qp.selectedItems[0]?.action ?? 'insert'));
    qp.onDidHide(() => {
      // Esc (or any other dismissal) = accept the command into the terminal without running.
      finish('insert');
      qp.dispose();
    });
    qp.show();
  });
}

function shorten(p: string): string {
  const home = process.env.HOME;
  if (home && p.startsWith(home)) return `~${p.slice(home.length)}`;
  return p;
}

function isAbortError(e: unknown): boolean {
  if (!e || typeof e !== 'object') return false;
  const name = (e as { name?: unknown }).name;
  const message = (e as { message?: unknown }).message;
  return name === 'AbortError' || (typeof message === 'string' && /\baborted\b/i.test(message));
}
