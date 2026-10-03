/** ChatController implementation handed to other modules (inline edit, terminal, code actions). */
import type { Attachment, ChatMode } from '../../shared/protocol';
import type { ChatController } from '../services';
import type { ChatManager } from './manager';

export function createChatController(manager: ChatManager): ChatController {
  return {
    async open(options) {
      if (options?.newChat) manager.newChat();
      else manager.activeOrNew();
      await manager.reveal?.(options?.focus !== false);
      if (options?.focus !== false) manager.postToPrimary({ type: 'focusInput' });
    },
    addAttachment(attachment: Attachment, options) {
      return manager.addAttachment(attachment, options);
    },
    async sendPrompt(text: string, attachments: Attachment[] = [], options?: { newChat?: boolean; mode?: ChatMode }) {
      if (options?.newChat) manager.newChat({ mode: options.mode });
      else manager.activeOrNew();
      await manager.reveal?.(true);
      await manager.send(undefined, text, attachments, { mode: options?.mode });
    },
    insertText(text: string) {
      return manager.insertText(text);
    },
    focusInput() {
      return manager.focusInput();
    },
  };
}
