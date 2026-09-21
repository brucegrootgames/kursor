import type * as vscode from 'vscode';
import type { BaseDeps, EditTracker } from '../services';

export function createEditTracker(_context: vscode.ExtensionContext, _deps: BaseDeps): EditTracker {
  throw new Error('edits/editTracker.ts not implemented yet');
}
