import type * as vscode from 'vscode';
import type { RulesService } from '../services';
import type { Logger } from '../util/log';

export function createRulesService(_context: vscode.ExtensionContext, _log: Logger): RulesService {
  throw new Error('rules/rules.ts not implemented yet');
}
