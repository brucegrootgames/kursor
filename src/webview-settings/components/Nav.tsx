/** Left navigation: an accessible vertical tab list with roving focus (arrow keys, Home/End). */
import { useCallback, useEffect, useRef, type KeyboardEvent } from 'react';
import { SETTINGS_TABS, type SettingsTab } from '../../shared/settingsProtocol';
import { cx } from '../util';
import { Icon } from './Icon';

export const TAB_INFO: Record<SettingsTab, { label: string; icon: string; hint: string }> = {
  general: { label: 'General', icon: 'account', hint: 'Account, editor and terminal integration' },
  agents: { label: 'Agents', icon: 'hubot', hint: 'Modes, permissions and diffs' },
  tab: { label: 'Tab', icon: 'sparkle', hint: 'Ghost-text completions' },
  models: { label: 'Models', icon: 'circuit-board', hint: 'Default and per-feature models' },
  rules: { label: 'Rules', icon: 'law', hint: 'User rules and project rules' },
  indexing: { label: 'Indexing', icon: 'search', hint: 'What Kursor can see' },
  about: { label: 'About', icon: 'info', hint: 'Version and links' },
};

export function tabId(tab: SettingsTab): string {
  return `tab-${tab}`;
}

export function panelId(tab: SettingsTab): string {
  return `panel-${tab}`;
}

export function Nav({ active, onSelect }: { active: SettingsTab; onSelect: (tab: SettingsTab) => void }) {
  const refs = useRef<Partial<Record<SettingsTab, HTMLButtonElement | null>>>({});
  const pendingFocus = useRef<SettingsTab | null>(null);

  useEffect(() => {
    if (pendingFocus.current === active) {
      refs.current[active]?.focus();
      pendingFocus.current = null;
    }
  }, [active]);

  const move = useCallback(
    (from: SettingsTab, delta: number | 'first' | 'last') => {
      const i = SETTINGS_TABS.indexOf(from);
      let next: number;
      if (delta === 'first') next = 0;
      else if (delta === 'last') next = SETTINGS_TABS.length - 1;
      else next = (i + delta + SETTINGS_TABS.length) % SETTINGS_TABS.length;
      const tab = SETTINGS_TABS[next];
      pendingFocus.current = tab;
      onSelect(tab);
    },
    [onSelect],
  );

  const onKeyDown = (tab: SettingsTab) => (e: KeyboardEvent<HTMLButtonElement>) => {
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowRight':
        e.preventDefault();
        move(tab, 1);
        break;
      case 'ArrowUp':
      case 'ArrowLeft':
        e.preventDefault();
        move(tab, -1);
        break;
      case 'Home':
        e.preventDefault();
        move(tab, 'first');
        break;
      case 'End':
        e.preventDefault();
        move(tab, 'last');
        break;
      default:
        break;
    }
  };

  return (
    <nav className="nav" aria-label="Settings sections">
      <div className="nav-brand">
        <span className="nav-logo" aria-hidden="true">
          <Icon name="sparkle-filled" />
        </span>
        <span className="nav-title">Kursor Settings</span>
      </div>
      <div className="nav-list" role="tablist" aria-orientation="vertical">
        {SETTINGS_TABS.map((tab) => {
          const info = TAB_INFO[tab];
          const selected = tab === active;
          return (
            <button
              key={tab}
              ref={(el) => {
                refs.current[tab] = el;
              }}
              type="button"
              role="tab"
              id={tabId(tab)}
              aria-selected={selected}
              aria-controls={panelId(tab)}
              tabIndex={selected ? 0 : -1}
              className={cx('nav-item', selected && 'active')}
              onClick={() => onSelect(tab)}
              onKeyDown={onKeyDown(tab)}
              title={info.hint}
            >
              <Icon name={info.icon} className="nav-icon" />
              <span className="nav-label">{info.label}</span>
            </button>
          );
        })}
      </div>
      <div className="nav-footer">
        <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>J</kbd>
      </div>
    </nav>
  );
}
