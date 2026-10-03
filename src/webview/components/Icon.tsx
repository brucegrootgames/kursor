import { memo } from 'react';
import { cx } from '../util';

/** Codicon glyph. `spin` applies the codicon spin modifier (works for loading/sync/gear). */
export const Icon = memo(function Icon({ name, spin, className, title }: { name: string; spin?: boolean; className?: string; title?: string }) {
  return <i className={cx('codicon', `codicon-${name}`, spin && 'codicon-modifier-spin', className)} title={title} aria-hidden={title ? undefined : true} />;
});

export function StatusIcon({ status }: { status: 'running' | 'done' | 'error' | 'denied' | 'pending' }) {
  switch (status) {
    case 'running':
      return <Icon name="loading" spin className="status-icon status-running" title="Running" />;
    case 'done':
      return <Icon name="check" className="status-icon status-done" title="Done" />;
    case 'error':
      return <Icon name="error" className="status-icon status-error" title="Failed" />;
    case 'denied':
      return <Icon name="circle-slash" className="status-icon status-denied" title="Denied" />;
    default:
      return <Icon name="circle-outline" className="status-icon status-pending" />;
  }
}
