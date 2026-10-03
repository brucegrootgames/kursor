import { useRef } from 'react';
import type { AppState, ChatState } from '../../shared/protocol';
import { useStickToBottom } from '../hooks';
import { useStore } from '../store';
import { post } from '../vscode';
import { AssistantMessage } from './AssistantMessage';
import { Icon } from './Icon';
import { SystemNote } from './SystemNote';
import { UserMessage } from './UserMessage';

function WorkingRow({ chat }: { chat: ChatState }) {
  const last = chat.messages[chat.messages.length - 1];
  if (chat.status !== 'running' && chat.status !== 'starting') return null;
  // While the last block is streaming text the caret is enough.
  if (last?.kind === 'assistant' && last.streaming) {
    const lb = last.blocks[last.blocks.length - 1];
    if (lb && lb.type === 'text') return null;
  }
  return (
    <div className="working-row">
      <Icon name="loading" spin />
      <span className="shimmer">{chat.status === 'starting' ? 'Starting…' : 'Working…'}</span>
      <button type="button" className="link-btn" onClick={() => post({ type: 'stop', chatId: chat.id })}>
        Stop
      </button>
    </div>
  );
}

export function MessageList({ chat, app }: { chat: ChatState; app: AppState }) {
  const ref = useRef<HTMLDivElement>(null);
  const collapsedThinking = useStore((s) => s.collapsedThinking);
  const { pinned, scrollToBottom } = useStickToBottom(ref, [chat.id, chat.messages.length, chat.status]);
  const { showThinking, toolCallDensity } = app.settings;
  return (
    <div className="messages" ref={ref}>
      <div className="messages-inner">
        {chat.messages.map((m) => {
          switch (m.kind) {
            case 'user':
              return <UserMessage key={m.id} message={m} chatId={chat.id} />;
            case 'assistant':
              return (
                <AssistantMessage
                  key={m.id}
                  message={m}
                  chatId={chat.id}
                  density={toolCallDensity}
                  showThinking={showThinking}
                  collapsedThinking={collapsedThinking}
                  workspaceFolder={app.workspaceFolder}
                />
              );
            case 'system':
              return <SystemNote key={m.id} note={m} />;
            default:
              return null;
          }
        })}
        <WorkingRow chat={chat} />
        {chat.status === 'error' && chat.error && (
          <div className="msg msg-system level-error">
            <Icon name="error" />
            <span className="system-text">{chat.error}</span>
          </div>
        )}
      </div>
      {!pinned && (
        <button type="button" className="scroll-down" onClick={scrollToBottom} title="Scroll to bottom">
          <Icon name="arrow-down" />
        </button>
      )}
    </div>
  );
}
