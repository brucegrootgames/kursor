import { useRef, useState } from 'react';
import type { ChatState } from '../../shared/protocol';
import { cx, formatTokens } from '../util';
import { Menu } from './Menu';

export function ContextRing({ usage, rateLimit }: { usage: ChatState['contextUsage']; rateLimit: ChatState['rateLimit'] }) {
  const [open, setOpen] = useState(false);
  const anchor = useRef<HTMLButtonElement>(null);
  const pct = Math.max(0, Math.min(100, usage?.percent ?? 0));
  const r = 6;
  const c = 2 * Math.PI * r;
  const level = pct >= 95 ? 'danger' : pct >= 80 ? 'warn' : 'ok';
  const five = rateLimit?.fiveHour;
  const seven = rateLimit?.sevenDay;
  const tooltip = usage ? `Context: ${formatTokens(usage.usedTokens)} / ${formatTokens(usage.maxTokens)} (${Math.round(pct)}%)` : 'Context usage';
  const items = [
    ...(usage?.breakdown ?? []).map((b, i) => ({ id: `b${i}`, label: b.label, description: formatTokens(b.tokens), disabled: true })),
    ...(usage ? [{ id: 'total', label: 'Total', description: `${formatTokens(usage.usedTokens)} / ${formatTokens(usage.maxTokens)}`, disabled: true, separatorBefore: (usage.breakdown?.length ?? 0) > 0 }] : []),
    ...(five !== undefined ? [{ id: 'five', label: '5-hour usage window', description: `${Math.round(five)}%`, disabled: true, separatorBefore: true }] : []),
    ...(seven !== undefined ? [{ id: 'seven', label: '7-day usage window', description: `${Math.round(seven)}%`, disabled: true }] : []),
    ...(rateLimit?.status && rateLimit.status !== 'allowed' ? [{ id: 'status', label: `Rate limit: ${rateLimit.status}`, disabled: true }] : []),
  ];
  return (
    <span className="menu-anchor">
      <button ref={anchor} type="button" className={cx('ring-btn', level)} title={tooltip} onClick={() => setOpen((v) => !v)}>
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
          <circle className="ring-track" cx="8" cy="8" r={r} fill="none" strokeWidth="2" />
          <circle className="ring-fill" cx="8" cy="8" r={r} fill="none" strokeWidth="2" strokeDasharray={c} strokeDashoffset={c * (1 - pct / 100)} transform="rotate(-90 8 8)" strokeLinecap="round" />
        </svg>
        {pct >= 50 && <span className="ring-pct">{Math.round(pct)}%</span>}
      </button>
      {open && (
        <Menu
          items={items.length ? items : [{ id: 'none', label: 'Context usage is reported after the first response', disabled: true }]}
          header={usage ? `Context window · ${Math.round(pct)}%` : 'Context window'}
          direction="up"
          align="right"
          width={240}
          anchorRef={anchor}
          onClose={() => setOpen(false)}
          onPick={() => setOpen(false)}
        />
      )}
    </span>
  );
}
