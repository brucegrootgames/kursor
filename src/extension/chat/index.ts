import type * as vscode from 'vscode';
import type { ChatController, ChatDeps } from '../services';

export function registerChat(_context: vscode.ExtensionContext, _deps: ChatDeps): ChatController {
  throw new Error('chat/index.ts not implemented yet');
}
