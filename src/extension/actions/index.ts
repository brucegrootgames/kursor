/**
 * [D2] Lightbulb / quick-fix code actions (Fix in Chat, Add to Chat, Explain,
 * Edit with Kursor). See provider.ts.
 */
import * as vscode from 'vscode';
import type { ActionsDeps } from '../services';
import { KursorCodeActionProvider, PROVIDED_KINDS } from './provider';

export function registerCodeActions(context: vscode.ExtensionContext, deps: ActionsDeps): void {
  const provider = new KursorCodeActionProvider();
  context.subscriptions.push(
    vscode.languages.registerCodeActionsProvider([{ scheme: 'file' }, { scheme: 'untitled' }], provider, {
      providedCodeActionKinds: PROVIDED_KINDS,
    }),
  );
  deps.log.info('code actions registered');
}
