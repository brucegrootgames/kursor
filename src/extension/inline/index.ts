/**
 * [D1] Ctrl+K inline edit — command registration. See README.md in this directory.
 */
import * as vscode from 'vscode';
import type { InlineDeps } from '../services';
import { ApplyCodeService } from './applyCode';
import { InlineDiffCodeLensProvider } from './codeLens';
import { PromptHistory } from './history';
import { InlineEditController } from './inlineEdit';
import { PromptUi, type PromptAction } from './promptUi';
import { InlineSpinner, isAbortError } from './spinner';
import { VerticalDiffManager } from './verticalDiff';

const PROMPT_ACTIONS: ReadonlySet<string> = new Set<PromptAction>(['edit', 'question', 'wholeFile', 'sendToChat', 'acceptAll', 'rejectAll']);

export function registerInlineEdit(context: vscode.ExtensionContext, deps: InlineDeps): void {
  const log = deps.log;
  const manager = new VerticalDiffManager(log.child('diff'));
  const codeLens = new InlineDiffCodeLensProvider(manager);
  const prompt = new PromptUi(log);
  const history = new PromptHistory(context.workspaceState);
  const spinner = new InlineSpinner(log);
  const controller = new InlineEditController(deps, manager, prompt, history, spinner);
  const apply = new ApplyCodeService(deps, manager, spinner);

  const command = (id: string, handler: (...args: unknown[]) => Promise<void> | void): vscode.Disposable =>
    vscode.commands.registerCommand(id, async (...args: unknown[]) => {
      try {
        await handler(...args);
      } catch (e) {
        if (isAbortError(e)) return;
        const message = e instanceof Error ? e.message : String(e);
        log.error(`${id} failed: ${message}`, e);
        const pick = await vscode.window.showErrorMessage(`Kursor: ${message}`, 'Show Logs');
        if (pick === 'Show Logs') log.show();
      }
    });

  const requireDiff = (target: unknown) => {
    const handler = manager.resolve(target);
    if (!handler) void vscode.window.setStatusBarMessage('$(info) Kursor: no inline edit to accept or reject here', 3000);
    return handler;
  };

  const blockCommand = async (accept: boolean, target: unknown, index: unknown): Promise<void> => {
    const handler = requireDiff(target);
    if (!handler) return;
    let i = typeof index === 'number' ? index : -1;
    if (i < 0) {
      const editor = vscode.window.activeTextEditor;
      const line = editor && editor.document === handler.document ? editor.selection.active.line : 0;
      i = handler.blockIndexNear(line);
    }
    if (i < 0 || i >= handler.blocks.length) return;
    if (accept) await handler.acceptBlock(i);
    else await handler.rejectBlock(i);
  };

  context.subscriptions.push(
    manager,
    codeLens,
    prompt,
    spinner,
    controller,
    vscode.languages.registerCodeLensProvider('*', codeLens),

    command('kursor.inlineEdit.open', () => {
      if (!vscode.workspace.isTrusted) {
        void vscode.window.showWarningMessage('Kursor: trust this workspace to use inline edits.', 'Manage Workspace Trust').then((pick) => {
          if (pick) void vscode.commands.executeCommand('workbench.trust.manage');
        });
        return undefined;
      }
      return controller.open();
    }),
    command('kursor.inlineEdit.quickQuestion', () => controller.quickQuestionCommand()),
    command('kursor.inlineEdit.submit', (args) => {
      const action = (args as { action?: unknown } | undefined)?.action;
      if (typeof action !== 'string' || !PROMPT_ACTIONS.has(action)) return controller.open();
      return controller.submit(action as PromptAction);
    }),
    command('kursor.inlineEdit.cancel', () => controller.cancel()),

    command('kursor.inlineEdit.acceptAll', async (target) => {
      const handler = requireDiff(target);
      if (handler) await handler.acceptAll();
    }),
    command('kursor.inlineEdit.rejectAll', async (target) => {
      const handler = requireDiff(target);
      if (handler) await handler.rejectAll();
    }),
    command('kursor.inlineEdit.acceptBlock', (target, index) => blockCommand(true, target, index)),
    command('kursor.inlineEdit.rejectBlock', (target, index) => blockCommand(false, target, index)),

    command('kursor.inlineEdit.applyCode', (args) => apply.applyCode(args)),
    command('kursor.inlineEdit.insertAtCursor', (args) => apply.insertAtCursor(args)),
  );

  void manager.updateContext();
  log.info('inline edit ready');
}
