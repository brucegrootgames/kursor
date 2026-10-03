/**
 * The workbench UI font for the webviews. Webviews do not inherit `workbench.experimental.fontFamily` (which
 * Kursor defaults to its brand stack: Inter, then the system sans), so the chat and settings HTML carry it as
 * the `--k-ui-font` custom property. Their stylesheets fall back to the same stack when it is unset.
 */
import * as vscode from 'vscode';

/** A `:root{--k-ui-font:…}` rule for the configured UI font, or '' when unset or not a plain font list. */
export function uiFontRule(): string {
  const family = vscode.workspace.getConfiguration('workbench').get<string>('experimental.fontFamily');
  return family && /^[\w\s,'".-]+$/.test(family) ? `:root{--k-ui-font:${family}}` : '';
}
