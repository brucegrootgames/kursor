import { memo, useState } from 'react';
import { useStreamedText } from '../deltaStore';
import { useElapsedSeconds } from '../hooks';
import type { ThinkingBlock as ThinkingBlockT } from '../types';
import { cx } from '../util';
import { Icon } from './Icon';

export const ThinkingBlock = memo(function ThinkingBlock({ block, streaming, defaultCollapsed }: { block: ThinkingBlockT; streaming: boolean; defaultCollapsed: boolean }) {
  const active = streaming && !block.done;
  const text = useStreamedText(block.id, block.text, active);
  const [open, setOpen] = useState(!defaultCollapsed);
  const secs = useElapsedSeconds(block.startedAt, block.endedAt, active);
  const label = active ? `Thinking… ${secs}s` : `Thought for ${secs}s`;
  return (
    <div className={cx('thinking', active && 'active', open && 'open')}>
      <button type="button" className="thinking-pill" onClick={() => setOpen((v) => !v)} title={open ? 'Hide thinking' : 'Show thinking'}>
        <Icon name={active ? 'loading' : 'lightbulb'} spin={active} />
        <span className={cx(active && 'shimmer')}>{label}</span>
        <Icon name={open ? 'chevron-up' : 'chevron-down'} className="thinking-chevron" />
      </button>
      {open && (
        <div className="thinking-body">
          {text ? text : <span className="muted">…</span>}
          {active && <span className="stream-caret" aria-hidden="true" />}
        </div>
      )}
    </div>
  );
});
