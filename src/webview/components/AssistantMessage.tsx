import { memo, useState } from 'react';
import type { AssistantMessage as AssistantMessageT } from '../../shared/protocol';
import type { Density } from '../types';
import { copyText, cx, formatCost, formatDuration } from '../util';
import { Icon } from './Icon';
import { PermissionCard } from './PermissionCard';
import { PlanCard } from './PlanCard';
import { QuestionCard } from './QuestionCard';
import { TextBlock } from './TextBlock';
import { ThinkingBlock } from './ThinkingBlock';
import { TodoCard } from './TodoCard';
import { ToolRow } from './ToolRow';

export interface AssistantMessageProps {
  message: AssistantMessageT;
  chatId: string;
  density: Density;
  showThinking: boolean;
  collapsedThinking: boolean;
  workspaceFolder?: string;
}

export const AssistantMessage = memo(function AssistantMessage({ message, chatId, density, showThinking, collapsedThinking, workspaceFolder }: AssistantMessageProps) {
  const [copied, setCopied] = useState(false);
  const blocks = message.blocks;
  // The caret goes on the last text block of a streaming message (only if nothing follows it).
  let caretIndex = -1;
  if (message.streaming) {
    for (let i = blocks.length - 1; i >= 0; i--) {
      const b = blocks[i];
      if (b && b.type === 'text') {
        caretIndex = i;
        break;
      }
      if (b && b.type === 'tool' && b.status === 'running') break;
    }
    if (caretIndex !== blocks.length - 1) caretIndex = -1;
  }

  const onCopy = async () => {
    const text = blocks
      .filter((b): b is Extract<typeof b, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n\n');
    await copyText(text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };

  const hasText = blocks.some((b) => b.type === 'text' && b.text);
  const result = message.result;

  return (
    <div className={cx('msg msg-assistant', message.streaming && 'streaming')}>
      <div className="blocks">
        {blocks.map((b, i) => {
          switch (b.type) {
            case 'text':
              return <TextBlock key={b.id} block={b} streaming={message.streaming} showCaret={i === caretIndex} />;
            case 'thinking':
              if (!showThinking) return null;
              return <ThinkingBlock key={b.id} block={b} streaming={message.streaming} defaultCollapsed={collapsedThinking} />;
            case 'tool':
              return <ToolRow key={b.id} block={b} density={density} workspaceFolder={workspaceFolder} />;
            case 'permission':
              return <PermissionCard key={b.id} block={b} chatId={chatId} workspaceFolder={workspaceFolder} />;
            case 'question':
              return <QuestionCard key={b.id} block={b} chatId={chatId} />;
            case 'plan':
              return <PlanCard key={b.id} block={b} chatId={chatId} />;
            case 'todo':
              return <TodoCard key={b.id} items={b.items} />;
            default:
              return null;
          }
        })}
      </div>
      {result?.isError && (
        <div className="msg-error">
          <Icon name="error" />
          <span>{result.errorText || 'The request failed.'}</span>
        </div>
      )}
      {!message.streaming && (hasText || result) && (
        <div className="msg-footer">
          {density === 'detailed' && result && !result.isError && (
            <span className="muted">
              {result.durationMs !== undefined && formatDuration(result.durationMs)}
              {result.costUsd !== undefined && result.costUsd > 0 && ` · ${formatCost(result.costUsd)}`}
              {result.numTurns !== undefined && result.numTurns > 1 && ` · ${result.numTurns} turns`}
              {message.model && ` · ${message.model}`}
            </span>
          )}
          <span className="spacer" />
          {hasText && (
            <button type="button" className="icon-btn" onClick={onCopy} title="Copy response">
              <Icon name={copied ? 'check' : 'copy'} />
            </button>
          )}
        </div>
      )}
    </div>
  );
});
