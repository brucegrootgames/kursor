import { dismissToast, useStore } from '../store';
import { cx } from '../util';
import { Icon } from './Icon';

export function Toasts() {
  const toasts = useStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="toasts" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast', `toast-${t.level}`)} role="status">
          <Icon name={t.level === 'error' ? 'error' : t.level === 'warning' ? 'warning' : 'info'} />
          <span className="toast-text">{t.text}</span>
          <button type="button" className="icon-btn" onClick={() => dismissToast(t.id)} title="Dismiss" aria-label="Dismiss notification">
            <Icon name="close" />
          </button>
        </div>
      ))}
    </div>
  );
}
