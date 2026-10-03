import { memo, useState } from 'react';
import type { Attachment, UserMessage as UserMessageT } from '../../shared/protocol';
import { attachmentIcon, copyText, cx } from '../util';
import { post } from '../vscode';
import { Icon } from './Icon';

export function AttachmentPill({ att, onRemove, small }: { att: Attachment; onRemove?: () => void; small?: boolean }) {
  const open = () => {
    if (att.path && (att.kind === 'file' || att.kind === 'selection' || att.kind === 'rule' || att.kind === 'diagnostic' || att.kind === 'folder')) {
      post({ type: 'openFile', path: att.path, line: att.range?.startLine, endLine: att.range?.endLine });
    } else if (att.url) {
      post({ type: 'openUrl', url: att.url });
    }
  };
  const title = att.relPath ?? att.path ?? att.url ?? att.label;
  return (
    <span className={cx('pill', `pill-${att.kind}`, small && 'pill-small')} title={title}>
      {att.kind === 'image' && att.image ? (
        <img className="pill-thumb" src={`data:${att.image.mediaType};base64,${att.image.dataBase64}`} alt={att.label} />
      ) : (
        <Icon name={attachmentIcon(att.kind)} />
      )}
      <button type="button" className="pill-label" onClick={open}>
        {att.label}
        {att.range && !att.label.includes(':') && (
          <span className="pill-range">
            :{att.range.startLine}
            {att.range.endLine !== att.range.startLine ? `-${att.range.endLine}` : ''}
          </span>
        )}
      </button>
      {onRemove && (
        <button type="button" className="pill-remove" onClick={onRemove} title="Remove">
          <Icon name="close" />
        </button>
      )}
    </span>
  );
}

export const UserMessage = memo(function UserMessage({ message, chatId }: { message: UserMessageT; chatId: string }) {
  const [copied, setCopied] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const onCopy = async () => {
    await copyText(message.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  };
  const onRestore = () => {
    if (!confirmRestore) {
      setConfirmRestore(true);
      setTimeout(() => setConfirmRestore(false), 4000);
      return;
    }
    setConfirmRestore(false);
    post({ type: 'restoreCheckpoint', chatId, messageId: message.id });
  };
  return (
    <div className={cx('msg msg-user', message.queued && 'queued')}>
      <div className="bubble">
        {message.attachments.length > 0 && (
          <div className="pills">
            {message.attachments.map((a) => (
              <AttachmentPill key={a.id} att={a} small />
            ))}
          </div>
        )}
        {message.text && <div className="user-text">{message.text}</div>}
        {message.queued && (
          <span className="queued-badge" title="Waiting for the current turn to finish">
            <Icon name="list-ordered" /> Queued
          </span>
        )}
        <div className="msg-actions">
          <button type="button" className="icon-btn" onClick={onCopy} title="Copy message">
            <Icon name={copied ? 'check' : 'copy'} />
          </button>
          {message.canRestore && (
            <button type="button" className={cx('icon-btn', confirmRestore && 'danger')} onClick={onRestore} title="Restore files to the state before this message">
              <Icon name="history" />
              <span>{confirmRestore ? 'Confirm restore?' : 'Restore checkpoint'}</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
});
