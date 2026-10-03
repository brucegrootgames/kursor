import { memo, useState } from 'react';
import type { QuestionBlock } from '../types';
import { cx } from '../util';
import { post } from '../vscode';
import { Icon } from './Icon';

const OTHER = '__other__';

export const QuestionCard = memo(function QuestionCard({ block, chatId }: { block: QuestionBlock; chatId: string }) {
  const answered = block.answers !== undefined;
  const [picked, setPicked] = useState<Record<number, string[]>>({});
  const [other, setOther] = useState<Record<number, string>>({});

  const toggle = (qi: number, label: string, multi: boolean) => {
    setPicked((cur) => {
      const list = cur[qi] ?? [];
      if (multi) return { ...cur, [qi]: list.includes(label) ? list.filter((l) => l !== label) : [...list, label] };
      return { ...cur, [qi]: [label] };
    });
  };

  const complete = block.questions.every((q, qi) => {
    const list = picked[qi] ?? [];
    if (list.includes(OTHER)) return (other[qi] ?? '').trim().length > 0;
    return list.length > 0;
  });

  const submit = () => {
    if (!complete) return;
    const answers: Record<string, string> = {};
    block.questions.forEach((q, qi) => {
      const list = (picked[qi] ?? []).map((l) => (l === OTHER ? (other[qi] ?? '').trim() : l)).filter(Boolean);
      answers[q.question] = list.join(', ');
    });
    post({ type: 'question', chatId, requestId: block.id, answers });
  };

  return (
    <div className={cx('card question-card', answered ? 'decided' : 'pending')}>
      {block.questions.map((q, qi) => {
        const list = picked[qi] ?? [];
        const hasOther = list.includes(OTHER);
        return (
          <div key={qi} className="question">
            <div className="card-title">
              <Icon name="question" />
              <span>{q.header || 'Question'}</span>
            </div>
            <div className="question-text">{q.question}</div>
            {answered ? (
              <div className="question-answer">
                <Icon name="check" /> {block.answers?.[q.question] || <span className="muted">(no answer)</span>}
              </div>
            ) : (
              <div className="question-options">
                {q.options.map((o) => {
                  const on = list.includes(o.label);
                  return (
                    <button
                      key={o.label}
                      type="button"
                      className={cx('option', on && 'selected')}
                      onClick={() => toggle(qi, o.label, q.multiSelect)}
                      title={o.description}
                    >
                      <Icon name={q.multiSelect ? (on ? 'check' : 'blank') : on ? 'circle-filled' : 'circle-outline'} />
                      <span className="option-body">
                        <span className="option-label">{o.label}</span>
                        {o.description && <span className="option-desc">{o.description}</span>}
                      </span>
                    </button>
                  );
                })}
                <button type="button" className={cx('option', hasOther && 'selected')} onClick={() => toggle(qi, OTHER, q.multiSelect)}>
                  <Icon name={q.multiSelect ? (hasOther ? 'check' : 'blank') : hasOther ? 'circle-filled' : 'circle-outline'} />
                  <span className="option-body">
                    <span className="option-label">Other…</span>
                  </span>
                </button>
                {hasOther && (
                  <input
                    className="input"
                    autoFocus
                    placeholder="Type your answer"
                    value={other[qi] ?? ''}
                    onChange={(e) => setOther((cur) => ({ ...cur, [qi]: e.target.value }))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        submit();
                      }
                    }}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
      {!answered && (
        <div className="card-actions">
          <button type="button" className="btn primary" disabled={!complete} onClick={submit}>
            Submit
          </button>
          <span className="hint">The agent keeps working while it waits</span>
        </div>
      )}
    </div>
  );
});
