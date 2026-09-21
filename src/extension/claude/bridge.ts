import type * as vscode from 'vscode';
import type { ClaudeBridge } from './types';
import type { Logger } from '../util/log';

export function createClaudeBridge(_context: vscode.ExtensionContext, _log: Logger): ClaudeBridge {
  throw new Error('claude/bridge.ts not implemented yet');
}
