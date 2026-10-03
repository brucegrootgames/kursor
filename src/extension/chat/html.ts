/** Webview HTML for the chat UI (nonce CSP, loads dist/webview.js + dist/codicon.css). */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import { randomBytes } from 'node:crypto';

export function chatHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const nonce = randomBytes(16).toString('base64url');
  const dist = vscode.Uri.joinPath(extensionUri, 'dist');
  const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'webview.js'));
  const codiconUri = webview.asWebviewUri(vscode.Uri.joinPath(dist, 'codicon.css'));
  const cssPath = vscode.Uri.joinPath(dist, 'webview.css');
  const cssLink = fs.existsSync(cssPath.fsPath) ? `<link rel="stylesheet" href="${webview.asWebviewUri(cssPath)}">` : '';
  const csp = [
    "default-src 'none'",
    `img-src ${webview.cspSource} https: data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `font-src ${webview.cspSource}`,
    `script-src 'nonce-${nonce}'`,
  ].join('; ');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp};">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${codiconUri}">
${cssLink}
<title>Kursor</title>
<style nonce="${nonce}">html,body,#root{height:100%;margin:0;padding:0}</style>
</head>
<body>
<div id="root"></div>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
