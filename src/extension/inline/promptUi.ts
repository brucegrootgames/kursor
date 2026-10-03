/**
 * The Ctrl+K prompt: a QuickPick (VS Code has no floating editor widget API) whose action items
 * are `alwaysShow` so free text never filters them away; the history section is shown while the
 * input is empty and selecting an entry fills the input. Keybindings (Alt+Enter, Ctrl+Shift+Enter,
 * Ctrl+L) reach the open prompt through `kursor.inlineEdit.submit {action}` → `submit()`.
 */
import * as vscode from 'vscode';
import type { Logger } from '../util/log';

export const INPUT_FOCUS_KEY = 'kursor.inlineEditInputFocus';

export type PromptAction = 'edit' | 'question' | 'wholeFile' | 'sendToChat' | 'acceptAll' | 'rejectAll';

export interface PromptOptions {
  title: string;
  placeholder?: string;
  value?: string;
  /** Prompt shown while a diff is visible: "Refine" instead of "Edit selection", plus Accept/Reject all. */
  followUp?: boolean;
  /** Action listed first (Enter with no explicit choice). */
  preferred?: PromptAction;
  history: readonly string[];
}

export interface PromptResult {
  action: PromptAction;
  text: string;
}

interface PromptItem extends vscode.QuickPickItem {
  action?: PromptAction;
  historyValue?: string;
}

const NEEDS_TEXT: ReadonlySet<PromptAction> = new Set(['edit', 'question', 'wholeFile']);

export class PromptUi implements vscode.Disposable {
  private current:
    | { qp: vscode.QuickPick<PromptItem>; finish: (result: PromptResult | undefined) => void }
    | undefined;

  constructor(private readonly log: Logger) {}

  get isOpen(): boolean {
    return this.current !== undefined;
  }

  /** Resolves with the chosen action + text, or undefined when dismissed. */
  show(options: PromptOptions): Promise<PromptResult | undefined> {
    this.current?.finish(undefined);
    return new Promise<PromptResult | undefined>((resolve) => {
      const qp = vscode.window.createQuickPick<PromptItem>();
      const actions = buildActionItems(options);
      const history: PromptItem[] = options.history.length
        ? [
            { label: 'History', kind: vscode.QuickPickItemKind.Separator },
            ...options.history.map((h) => ({ label: `$(history) ${h}`, historyValue: h })),
          ]
        : [];
      const refreshItems = (): void => {
        qp.items = qp.value.trim() ? actions : [...actions, ...history];
        qp.activeItems = [actions[0]];
      };

      let done = false;
      const finish = (result: PromptResult | undefined): void => {
        if (done) return;
        done = true;
        this.current = undefined;
        void this.setFocusContext(false);
        qp.hide();
        qp.dispose();
        resolve(result);
      };
      const submit = (action: PromptAction): void => {
        const text = qp.value.trim();
        if (NEEDS_TEXT.has(action) && !text) {
          qp.placeholder = 'Type an instruction first…';
          return;
        }
        finish({ action, text });
      };

      qp.title = options.title;
      qp.placeholder = options.placeholder ?? 'Instructions… (Enter to edit, or pick an action)';
      qp.value = options.value ?? '';
      qp.ignoreFocusOut = true;
      qp.matchOnDescription = false;
      qp.matchOnDetail = false;
      refreshItems();

      qp.onDidChangeValue(refreshItems);
      qp.onDidAccept(() => {
        const item = qp.selectedItems[0] ?? qp.activeItems[0];
        if (item?.historyValue !== undefined) {
          qp.value = item.historyValue;
          refreshItems();
          return;
        }
        submit(item?.action ?? actions[0].action ?? 'edit');
      });
      qp.onDidHide(() => finish(undefined));

      this.current = { qp, finish: (r) => (r ? submit(r.action) : finish(undefined)) };
      void this.setFocusContext(true);
      qp.show();
    });
  }

  /** Submit the open prompt with `action` and its current text (from a keybinding). */
  submit(action: PromptAction): boolean {
    if (!this.current) return false;
    this.current.finish({ action, text: this.current.qp.value });
    return true;
  }

  close(): void {
    this.current?.finish(undefined);
  }

  private async setFocusContext(value: boolean): Promise<void> {
    try {
      await vscode.commands.executeCommand('setContext', INPUT_FOCUS_KEY, value);
    } catch (e) {
      this.log.warn('setContext failed', e);
    }
  }

  dispose(): void {
    this.close();
  }
}

function buildActionItems(options: PromptOptions): PromptItem[] {
  const items: PromptItem[] = options.followUp
    ? [
        { label: '$(pencil) Refine edit', description: 'Enter', detail: 'Reject the current suggestion and re-run with the follow-up instruction', action: 'edit', alwaysShow: true },
        { label: '$(check) Accept all', description: 'Ctrl+Enter', action: 'acceptAll', alwaysShow: true },
        { label: '$(close) Reject all', description: 'Ctrl+Backspace', action: 'rejectAll', alwaysShow: true },
        { label: '$(question) Quick question', description: 'Alt+Enter', action: 'question', alwaysShow: true },
        { label: '$(comment-discussion) Send to chat', description: 'Ctrl+L', action: 'sendToChat', alwaysShow: true },
      ]
    : [
        { label: '$(pencil) Edit selection', description: 'Enter', action: 'edit', alwaysShow: true },
        { label: '$(question) Quick question', description: 'Alt+Enter', detail: 'Ask about the selection in chat (Ask mode)', action: 'question', alwaysShow: true },
        { label: '$(file) Edit whole file', description: 'Ctrl+Shift+Enter', action: 'wholeFile', alwaysShow: true },
        { label: '$(comment-discussion) Send to chat', description: 'Ctrl+L', detail: 'Attach the selection to the chat with your text', action: 'sendToChat', alwaysShow: true },
      ];
  if (options.preferred) {
    const i = items.findIndex((it) => it.action === options.preferred);
    if (i > 0) items.unshift(...items.splice(i, 1));
  }
  return items;
}
