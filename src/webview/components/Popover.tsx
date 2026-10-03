/** List popover anchored above the input box: used for @ mentions and / commands. */
import { useEffect, useRef, type ReactNode } from 'react';
import { cx } from '../util';
import { Icon } from './Icon';

export interface PopoverItem {
  id: string;
  icon?: string;
  label: string;
  detail?: string;
  hint?: string;
  /** Category rows show a chevron. */
  drill?: boolean;
  disabled?: boolean;
}

export interface PopoverProps {
  title?: ReactNode;
  items: PopoverItem[];
  active: number;
  loading?: boolean;
  empty?: ReactNode;
  onPick(index: number): void;
  onHover(index: number): void;
  onBack?(): void;
  onClose(): void;
}

export function Popover({ title, items, active, loading, empty, onPick, onHover, onBack, onClose }: PopoverProps) {
  const listRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('.popover-item.active');
    el?.scrollIntoView({ block: 'nearest' });
  }, [active, items]);
  return (
    <div className="popover" role="listbox">
      {(title || onBack) && (
        <div className="popover-title">
          {onBack && (
            <button type="button" className="icon-btn" onClick={onBack} title="Back">
              <Icon name="arrow-left" />
            </button>
          )}
          <span>{title}</span>
          <span className="spacer" />
          {loading && <Icon name="loading" spin />}
          <button type="button" className="icon-btn" onClick={onClose} title="Close (Esc)">
            <Icon name="close" />
          </button>
        </div>
      )}
      <div className="popover-list" ref={listRef}>
        {items.map((it, i) => (
          <div
            key={it.id}
            role="option"
            aria-selected={i === active}
            className={cx('popover-item', i === active && 'active', it.disabled && 'disabled')}
            onMouseEnter={() => onHover(i)}
            onMouseDown={(e) => {
              e.preventDefault(); // keep the textarea focused
              if (!it.disabled) onPick(i);
            }}
          >
            {it.icon && <Icon name={it.icon} />}
            <span className="popover-label">{it.label}</span>
            {it.detail && <span className="popover-detail" title={it.detail}>{it.detail}</span>}
            {it.hint && <span className="popover-hint">{it.hint}</span>}
            {it.drill && <Icon name="chevron-right" className="popover-chevron" />}
          </div>
        ))}
        {items.length === 0 && !loading && <div className="popover-empty">{empty ?? 'No results'}</div>}
        {items.length === 0 && loading && <div className="popover-empty">Searching…</div>}
      </div>
    </div>
  );
}
