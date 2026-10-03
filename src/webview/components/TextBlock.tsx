import { memo } from 'react';
import { useStreamedText } from '../deltaStore';
import type { TextBlock as TextBlockT } from '../types';
import { Markdown } from './Markdown';

export const TextBlock = memo(function TextBlock({ block, streaming, showCaret }: { block: TextBlockT; streaming: boolean; showCaret: boolean }) {
  const text = useStreamedText(block.id, block.text, streaming);
  if (!text && !showCaret) return null;
  return <Markdown text={text} streaming={showCaret} className="assistant-text" />;
});
