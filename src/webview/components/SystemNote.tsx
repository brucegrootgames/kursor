import { memo } from 'react';
import type { SystemNote as SystemNoteT } from '../../shared/protocol';
import { cx } from '../util';
import { post } from '../vscode';
import { Icon } from './Icon';

export const SystemNote = memo(function SystemNote({ note }: { note: SystemNoteT }) {
  const icon = note.level === 'error' ? 'error' : note.level === 'warning' ? 'warning' : 'info';
  return (
    <div className={cx('msg msg-system', `level-${note.level}`)}>
      <Icon name={icon} />
      <span className="system-text">{note.text}</span>
      {note.action && (
        <button type="button" className="link-btn" onClick={() => post({ type: 'runCommand', command: note.action!.command, args: note.action!.args })}>
          {note.action.label}
        </button>
      )}
    </div>
  );
});
