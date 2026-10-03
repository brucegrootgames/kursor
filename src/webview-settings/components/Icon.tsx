import { memo } from 'react';
import { cx } from '../util';

/** Codicon glyph. `spin` applies the codicon spin modifier (works for loading/sync/gear). */
export const Icon = memo(function Icon({ name, spin, className, title }: { name: string; spin?: boolean; className?: string; title?: string }) {
  return <i className={cx('codicon', `codicon-${name}`, spin && 'codicon-modifier-spin', className)} title={title} aria-hidden={title ? undefined : true} />;
});
