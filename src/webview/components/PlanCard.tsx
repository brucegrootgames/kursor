import { memo, useState } from 'react';
import type { PlanBlock } from '../types';
import { post } from '../vscode';
import { Icon } from './Icon';
import { Markdown } from './Markdown';

export const PlanCard = memo(function PlanCard({ block, chatId }: { block: PlanBlock; chatId: string }) {
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [expanded, setExpanded] = useState(true);
  const decided = block.decision !== undefined;

  const build = () => post({ type: 'plan', chatId, requestId: block.id, decision: 'build' });
  const reject = () => post({ type: 'plan', chatId, requestId: block.id, decision: 'reject', feedback: feedback.trim() || undefined });

  return (
    <div className={`card plan-card ${decided ? 'decided' : 'pending'}`}>
      <button type="button" className="card-title clickable" onClick={() => setExpanded((v) => !v)}>
        <Icon name="checklist" />
        <span>Plan</span>
        {decided && <span className={`decision decision-${block.decision}`}>{block.decision === 'build' ? 'Building' : 'Rejected'}</span>}
        <span className="spacer" />
        <Icon name={expanded ? 'chevron-up' : 'chevron-down'} />
      </button>
      {expanded && (
        <div className="plan-body">
          <Markdown text={block.plan} readOnlyFences />
        </div>
      )}
      {!decided && (
        <div className="card-actions">
          <button type="button" className="btn primary" onClick={build} title="Approve the plan and start building">
            <Icon name="play" /> Build
          </button>
          {!feedbackOpen ? (
            <>
              <button type="button" className="btn" onClick={() => setFeedbackOpen(true)} title="Reject with feedback">
                <Icon name="comment" /> Feedback
              </button>
              <button type="button" className="btn" onClick={reject} title="Reject the plan">
                Reject
              </button>
            </>
          ) : null}
          <span className="hint">The agent keeps working after you decide</span>
        </div>
      )}
      {!decided && feedbackOpen && (
        <div className="plan-feedback">
          <textarea
            className="input"
            placeholder="What should change in the plan?"
            value={feedback}
            autoFocus
            rows={3}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                reject();
              }
            }}
          />
          <div className="card-actions">
            <button type="button" className="btn" onClick={reject}>
              Reject with feedback
            </button>
            <button type="button" className="btn ghost" onClick={() => setFeedbackOpen(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
});
