/** Handles every WebviewToHost message (except `ready`, handled by the host). */
import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Attachment, WebviewToHost } from '../../shared/protocol';
import type { MentionSearch } from '../context/mentions';
import { newAttachmentId } from '../context/providers';
import type { Logger } from '../util/log';
import type { ChatManager } from './manager';
import type { WebviewHost } from './views';

export interface MessageContext {
  manager: ChatManager;
  mentions: MentionSearch;
  log: Logger;
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };

function resolveFsPath(p: string, manager: ChatManager): vscode.Uri {
  if (path.isAbsolute(p)) return vscode.Uri.file(p);
  const folders = vscode.workspace.workspaceFolders ?? [];
  for (const f of folders) {
    const candidate = path.join(f.uri.fsPath, p);
    if (folders.length === 1) return vscode.Uri.file(candidate);
    try {
      // multi-root: first folder that contains the file wins
      fs.accessSync(candidate);
      return vscode.Uri.file(candidate);
    } catch {
      /* try next */
    }
  }
  return vscode.Uri.file(path.join(manager.defaultCwd(), p));
}

async function openFile(p: string, line: number | undefined, endLine: number | undefined, manager: ChatManager): Promise<void> {
  const uri = resolveFsPath(p, manager);
  const options: vscode.TextDocumentShowOptions = { preview: true, preserveFocus: false };
  if (line !== undefined) {
    const start = Math.max(0, line - 1);
    const end = Math.max(start, (endLine ?? line) - 1);
    options.selection = new vscode.Range(start, 0, end, Number.MAX_SAFE_INTEGER);
  }
  try {
    await vscode.window.showTextDocument(uri, options);
  } catch {
    await vscode.commands.executeCommand('vscode.open', uri, options);
  }
}

async function runInTerminal(code: string): Promise<void> {
  let terminal = vscode.window.activeTerminal;
  if (!terminal || terminal.exitStatus) terminal = vscode.window.createTerminal({ name: 'Kursor' });
  terminal.show(false);
  const text = code.trim();
  if (!text) return;
  // Shell integration gives us exit codes/output capture for single commands; multi-line scripts go through sendText.
  if (terminal.shellIntegration && !text.includes('\n')) {
    terminal.shellIntegration.executeCommand(text);
  } else {
    terminal.sendText(text, true);
  }
}

async function insertAtCursor(code: string): Promise<void> {
  try {
    await vscode.commands.executeCommand('kursor.inlineEdit.insertAtCursor', { code });
    return;
  } catch {
    /* fall back below */
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) throw new Error('No active editor to insert into.');
  await editor.edit((eb) => {
    if (editor.selection.isEmpty) eb.insert(editor.selection.active, code);
    else eb.replace(editor.selection, code);
  });
}

async function pickImage(host: WebviewHost): Promise<void> {
  const picked = await vscode.window.showOpenDialog({ canSelectMany: true, filters: { Images: ['png', 'jpg', 'jpeg', 'gif', 'webp'] }, title: 'Attach image' });
  if (!picked?.length) return;
  for (const uri of picked) {
    const ext = path.extname(uri.fsPath).toLowerCase();
    const mediaType = IMAGE_TYPES[ext];
    if (!mediaType) {
      host.post({ type: 'toast', level: 'warning', text: `Unsupported image type: ${ext}` });
      continue;
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength > MAX_IMAGE_BYTES) {
      host.post({ type: 'toast', level: 'warning', text: `${path.basename(uri.fsPath)} is larger than 5 MB.` });
      continue;
    }
    const attachment: Attachment = {
      id: newAttachmentId(),
      kind: 'image',
      label: path.basename(uri.fsPath),
      path: uri.fsPath,
      image: { mediaType, dataBase64: Buffer.from(bytes).toString('base64'), name: path.basename(uri.fsPath) },
    };
    host.post({ type: 'addAttachment', attachment });
  }
}

export async function handleWebviewMessage(ctx: MessageContext, msg: WebviewToHost, host: WebviewHost): Promise<void> {
  const { manager, log } = ctx;
  switch (msg.type) {
    case 'ready':
    case 'focusChanged':
      return; // handled by WebviewHost
    case 'send':
      await manager.send(msg.chatId, msg.text, msg.attachments ?? [], { sendNow: msg.sendNow });
      return;
    case 'stop':
      await manager.stop(msg.chatId);
      return;
    case 'newChat':
      manager.newChat();
      host.post({ type: 'focusInput' });
      return;
    case 'switchChat':
      manager.switchChat(msg.chatId);
      return;
    case 'closeChat':
      await manager.closeChat(msg.chatId);
      return;
    case 'renameChat':
      manager.renameChat(msg.chatId, msg.title);
      return;
    case 'setMode':
      await manager.setMode(msg.chatId, msg.mode);
      return;
    case 'setModel':
      await manager.setModel(msg.chatId, msg.model);
      return;
    case 'setEffort':
      await manager.setEffort(msg.chatId, msg.effort);
      return;
    case 'setPermissionMode':
      await manager.setPermissionMode(msg.chatId, msg.permissionMode);
      return;
    case 'permission':
      manager.respondPermission(msg.chatId, msg.requestId, msg.decision, msg.suggestionIndex, msg.updatedInput);
      return;
    case 'question':
      manager.answerQuestion(msg.chatId, msg.requestId, msg.answers ?? {});
      return;
    case 'plan':
      await manager.respondPlan(msg.chatId, msg.requestId, msg.decision, msg.feedback);
      return;
    case 'searchMentions': {
      let results: Awaited<ReturnType<MentionSearch['search']>> = [];
      try {
        results = await ctx.mentions.search(msg.query ?? '', msg.kind, manager.slashCommands());
      } catch (err) {
        log.warn('mention search failed', err);
      }
      host.post({ type: 'mentionResults', requestId: msg.requestId, results });
      return;
    }
    case 'openFile':
      await openFile(msg.path, msg.line, msg.endLine, manager);
      return;
    case 'openUrl':
      if (/^https?:\/\//i.test(msg.url)) await vscode.env.openExternal(vscode.Uri.parse(msg.url));
      return;
    case 'edits':
      await manager.editsAction(msg.action, msg.path);
      return;
    case 'restoreCheckpoint':
      await manager.restoreCheckpoint(msg.chatId, msg.messageId);
      return;
    case 'codeAction':
      switch (msg.action) {
        case 'copy':
          await vscode.env.clipboard.writeText(msg.code);
          host.post({ type: 'toast', level: 'info', text: 'Copied to clipboard' });
          return;
        case 'insert':
          await insertAtCursor(msg.code);
          return;
        case 'apply':
          try {
            await vscode.commands.executeCommand('kursor.inlineEdit.applyCode', { code: msg.code, path: msg.path, language: msg.language });
          } catch (err) {
            log.warn('applyCode unavailable, inserting at cursor instead', err);
            await insertAtCursor(msg.code);
          }
          return;
        case 'run':
          await runInTerminal(msg.code);
          return;
        case 'newFile': {
          const doc = await vscode.workspace.openTextDocument({ content: msg.code, language: msg.language || undefined });
          await vscode.window.showTextDocument(doc, { preview: false });
          return;
        }
        default:
          return;
      }
    case 'exportChat':
      await manager.exportChat(msg.chatId);
      return;
    case 'openSettings':
      try {
        await vscode.commands.executeCommand('kursor.settings.open');
      } catch {
        await vscode.commands.executeCommand('workbench.action.openSettings', '@ext:kursor.kursor');
      }
      return;
    case 'openHistory': {
      const sessions = await manager.history();
      host.post({ type: 'history', sessions });
      host.post({ type: 'showHistory' });
      return;
    }
    case 'resumeSession':
      await manager.resumeSession(msg.sessionId);
      return;
    case 'deleteSession':
      await manager.deleteSession(msg.sessionId);
      host.post({ type: 'history', sessions: await manager.history() });
      return;
    case 'pickImage':
      await pickImage(host);
      return;
    case 'runCommand':
      if (typeof msg.command === 'string' && msg.command) await vscode.commands.executeCommand(msg.command, ...(msg.args ?? []));
      return;
    case 'log':
      if (msg.level === 'error') log.error(`[webview] ${msg.text}`);
      else if (msg.level === 'warn') log.warn(`[webview] ${msg.text}`);
      else log.info(`[webview] ${msg.text}`);
      return;
    default: {
      const unknown = msg as { type?: string };
      log.warn(`unhandled webview message: ${unknown.type ?? '?'}`);
    }
  }
}
