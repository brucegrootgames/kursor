/**
 * Anchored dropdown menu used by the mode / model / "Always allow" pickers.
 * Opens above (default, the toolbar sits at the bottom) or below its trigger, closes on
 * outside click / Esc, supports ArrowUp/Down + Enter.
 */
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon';
import { cx } from '../util';

export interface MenuItem {
  id: string;
  label: ReactNode;
  description?: ReactNode;
  icon?: string;
  checked?: boolean;
  disabled?: boolean;
  shortcut?: string;
  /** Renders a chevron and keeps the menu open when picked (caller switches content). */
  submenu?: boolean;
  separatorBefore?: boolean;
}

export interface MenuProps {
  items: MenuItem[];
  onPick(item: MenuItem): void;
  onClose(): void;
  header?: ReactNode;
  footer?: ReactNode;
  /** 'up' (default) opens above the anchor; 'down' below. */
  direction?: 'up' | 'down';
  align?: 'left' | 'right';
  width?: number;
  className?: string;
  /** Element whose clicks should not count as "outside" (the trigger). */
  anchorRef?: React.RefObject<HTMLElement>;
}

export function Menu({ items, onPick, onClose, header, footer, direction = 'up', align = 'left', width, className, anchorRef }: MenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const enabled = items.filter((i) => !i.disabled);
  const [active, setActive] = useState<number>(() => {
    const idx = items.findIndex((i) => i.checked && !i.disabled);
    return idx === -1 ? items.findIndex((i) => !i.disabled) : idx;
  });

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (anchorRef?.current?.contains(t)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (enabled.length === 0) return;
        setActive((cur) => {
          const list = items.map((it, i) => (it.disabled ? -1 : i)).filter((i) => i >= 0);
          const pos = list.indexOf(cur);
          const next = e.key === 'ArrowDown' ? (pos + 1) % list.length : (pos - 1 + list.length) % list.length;
          return list[next] ?? cur;
        });
        return;
      }
      if (e.key === 'Enter') {
        const it = items[active];
        if (it && !it.disabled) {
          e.preventDefault();
          onPick(it);
        }
      }
    };
    document.addEventListener('mousedown', onDoc, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDoc, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [items, active, enabled.length, onClose, onPick, anchorRef]);

  // Keep the menu inside the viewport horizontally.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const overflow = r.right - window.innerWidth + 6;
    if (overflow > 0) el.style.transform = `translateX(${-overflow}px)`;
    if (r.left < 6) el.style.transform = `translateX(${6 - r.left}px)`;
  }, []);

  return (
    <div ref={ref} className={cx('menu', `menu-${direction}`, `menu-${align}`, className)} style={width ? { minWidth: width } : undefined} role="menu">
      {header && <div className="menu-header">{header}</div>}
      <div className="menu-items">
        {items.map((it, i) => (
          <div key={it.id} className="menu-item-wrap">
            {it.separatorBefore && <div className="menu-sep" />}
            <button
              type="button"
              role="menuitem"
              className={cx('menu-item', i === active && 'active', it.checked && 'checked', it.disabled && 'disabled')}
              disabled={it.disabled}
              onMouseEnter={() => !it.disabled && setActive(i)}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!it.disabled) onPick(it);
              }}
            >
              <span className="menu-check">{it.checked ? <Icon name="check" /> : it.icon ? <Icon name={it.icon} /> : null}</span>
              <span className="menu-body">
                <span className="menu-label">{it.label}</span>
                {it.description && <span className="menu-desc">{it.description}</span>}
              </span>
              {it.shortcut && <kbd className="menu-shortcut">{it.shortcut}</kbd>}
              {it.submenu && <Icon name="chevron-right" className="menu-chevron" />}
            </button>
          </div>
        ))}
        {items.length === 0 && <div className="menu-empty">Nothing here</div>}
      </div>
      {footer && <div className="menu-footer">{footer}</div>}
    </div>
  );
}
