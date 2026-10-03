import { memo } from 'react';
import { cx } from '../util';
import { Icon } from './Icon';

export interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export const TodoCard = memo(function TodoCard({ items, title }: { items: TodoItem[]; title?: string }) {
  const done = items.filter((i) => i.status === 'completed').length;
  return (
    <div className="card todo-card">
      <div className="card-title">
        <Icon name="checklist" />
        <span>{title ?? 'To-dos'}</span>
        <span className="muted">
          {done}/{items.length}
        </span>
      </div>
      <ul className="todo-list">
        {items.map((it, i) => (
          <li key={i} className={cx('todo-item', it.status)}>
            {it.status === 'completed' ? <Icon name="pass-filled" /> : it.status === 'in_progress' ? <Icon name="loading" spin /> : <Icon name="circle-large-outline" />}
            <span>{it.content}</span>
          </li>
        ))}
      </ul>
    </div>
  );
});

export function parseTodos(input: unknown): TodoItem[] {
  const todos = (input as { todos?: unknown } | undefined)?.todos;
  if (!Array.isArray(todos)) return [];
  const out: TodoItem[] = [];
  for (const t of todos) {
    if (!t || typeof t !== 'object') continue;
    const o = t as Record<string, unknown>;
    const content = typeof o.content === 'string' ? o.content : typeof o.activeForm === 'string' ? o.activeForm : '';
    const status = o.status === 'completed' || o.status === 'in_progress' ? o.status : 'pending';
    if (content) out.push({ content, status });
  }
  return out;
}
