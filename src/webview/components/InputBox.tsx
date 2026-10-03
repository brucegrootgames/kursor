/**
 * The composer: auto-growing textarea, attachment pills, @-mention and /-command popovers,
 * image paste/drop, and the bottom toolbar (@, image, mode, model, context ring, send/stop).
 *
 * Keyboard: Enter send (queues while running) · Shift+Enter newline · Ctrl+Enter send now ·
 * Ctrl+. / Shift+Tab cycle mode · Ctrl+/ cycle model · Esc close popover / blur ·
 * Ctrl+Enter with an empty input approves the pending permission card.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react';
import type { AppState, Attachment, ChatMode, ChatState, EffortLevel, MentionKind, MentionResult } from '../../shared/protocol';
import { useAutoGrow } from '../hooks';
import { CATEGORY_TITLES, DEFAULT_CATEGORIES, findMentionTrigger, findSlashTrigger, looksLikeUrl, requestMentionSearch, resultToAttachment, urlAttachment } from '../mentions';
import { NO_CHAT_KEY, addAttachment, onUiEvent, pushToast, removeAttachment, sendComposer, setComposerText, useComposer, whenChatActive } from '../store';
import { cx, mentionIcon, uid } from '../util';
import { post } from '../vscode';
import { ContextRing } from './ContextRing';
import { Icon } from './Icon';
import { Menu, type MenuItem } from './Menu';
import { Popover, type PopoverItem } from './Popover';
import { AttachmentPill } from './UserMessage';

const MODES: { id: ChatMode; label: string; icon: string; description: string }[] = [
  { id: 'agent', label: 'Agent', icon: 'hubot', description: 'Edits files and runs commands' },
  { id: 'ask', label: 'Ask', icon: 'comment-discussion', description: 'Answers questions, read-only' },
  { id: 'plan', label: 'Plan', icon: 'checklist', description: 'Proposes a plan you approve first' },
];
const EFFORTS: EffortLevel[] = ['', 'low', 'medium', 'high', 'xhigh', 'max'];

type PopoverState =
  | { kind: 'mention'; start: number; query: string; category?: MentionKind; results: MentionResult[]; loading: boolean; active: number }
  | { kind: 'command'; query: string; active: number };

export interface InputBoxProps {
  chat: ChatState | undefined;
  app: AppState;
}

function findPendingPermission(chat: ChatState | undefined): string | undefined {
  if (!chat) return undefined;
  for (let i = chat.messages.length - 1; i >= 0; i--) {
    const m = chat.messages[i];
    if (!m || m.kind !== 'assistant') continue;
    for (const b of m.blocks) if (b.type === 'permission' && b.decision === undefined) return b.id;
  }
  return undefined;
}

export function InputBox({ chat, app }: InputBoxProps) {
  const chatKey = chat?.id ?? NO_CHAT_KEY;
  const composer = useComposer(chatKey);
  const text = composer.text;
  const ref = useRef<HTMLTextAreaElement>(null);
  const [pop, setPop] = useState<PopoverState | null>(null);
  const [menu, setMenu] = useState<'mode' | 'model' | 'effort' | null>(null);
  const [dragging, setDragging] = useState(false);
  const modeAnchor = useRef<HTMLButtonElement>(null);
  const modelAnchor = useRef<HTMLButtonElement>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout>>();
  const latestRequest = useRef<string>('');
  const running = chat?.status === 'running' || chat?.status === 'starting' || chat?.status === 'waiting';
  const mode: ChatMode = chat?.mode ?? app.settings.defaultMode;
  const model = chat?.model ?? '';
  const effort: EffortLevel = chat?.effort ?? '';
  const modelOption = useMemo(() => app.models.find((m) => m.value === model), [app.models, model]);
  const pendingPermission = findPendingPermission(chat);

  useAutoGrow(ref, text);

  // Imperative requests from the host (focus / insert).
  useEffect(
    () =>
      onUiEvent((e) => {
        if (e.type === 'focusInput') ref.current?.focus();
        if (e.type === 'insertText') insertAtCaret(e.text);
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chatKey, text],
  );

  // Focus on mount and when the chat switches.
  useEffect(() => {
    ref.current?.focus();
    setPop(null);
    setMenu(null);
  }, [chatKey]);

  const setText = useCallback((t: string) => setComposerText(chatKey, t), [chatKey]);

  function insertAtCaret(snippet: string): void {
    const el = ref.current;
    const cur = el ? el.value : text;
    const start = el ? el.selectionStart : cur.length;
    const end = el ? el.selectionEnd : cur.length;
    const before = cur.slice(0, start);
    const after = cur.slice(end);
    const sep = before && !/\s$/.test(before) ? ' ' : '';
    const next = before + sep + snippet + after;
    setText(next);
    const caret = (before + sep + snippet).length;
    requestAnimationFrame(() => {
      const t = ref.current;
      if (!t) return;
      t.focus();
      t.setSelectionRange(caret, caret);
      syncPopover(next, caret);
    });
  }

  // ---- popover management -------------------------------------------------

  function runSearch(query: string, category: MentionKind | undefined): void {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    searchTimer.current = setTimeout(() => {
      const id = requestMentionSearch(query, category, (results) => {
        if (latestRequest.current !== id) return;
        setPop((p) => {
          if (!p || p.kind !== 'mention') return p;
          let list = results;
          if (!query && !category && list.length === 0) list = DEFAULT_CATEGORIES;
          return { ...p, results: list, loading: false, active: Math.min(p.active, Math.max(0, list.length - 1)) };
        });
      });
      latestRequest.current = id;
    }, 120);
  }

  const popRef = useRef<PopoverState | null>(null);
  popRef.current = pop;

  function syncPopover(value: string, caret: number): void {
    const cur = popRef.current;
    const m = findMentionTrigger(value, caret);
    if (m) {
      if (cur && cur.kind === 'mention' && cur.start === m.start) {
        if (cur.query !== m.query) {
          runSearch(m.query, cur.category);
          setPop({ ...cur, query: m.query, loading: true, active: 0 });
        }
        return;
      }
      runSearch(m.query, undefined);
      setPop({ kind: 'mention', start: m.start, query: m.query, results: [], loading: true, active: 0 });
      return;
    }
    const s = findSlashTrigger(value, caret);
    if (s && app.commands.length > 0) {
      if (!(cur && cur.kind === 'command' && cur.query === s.query)) setPop({ kind: 'command', query: s.query, active: 0 });
      return;
    }
    if (cur) setPop(null);
  }

  const onChange = (e: ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setText(value);
    syncPopover(value, e.target.selectionStart ?? value.length);
  };

  const onSelect = () => {
    const el = ref.current;
    if (!el || !pop) return;
    syncPopover(el.value, el.selectionStart ?? el.value.length);
  };

  const mentionItems: PopoverItem[] = useMemo(() => {
    if (!pop || pop.kind !== 'mention') return [];
    const items: PopoverItem[] = [];
    const q = pop.query.trim();
    if (looksLikeUrl(q) || ((pop.category === 'web' || pop.category === 'docs') && q.length > 0)) {
      items.push({ id: '__url', icon: 'link', label: looksLikeUrl(q) ? `Fetch ${q}` : `Fetch https://${q}`, detail: 'Attach a web page' });
    }
    for (const r of pop.results) {
      items.push({
        id: `${r.kind}:${r.path ?? r.value ?? r.label}`,
        icon: mentionIcon(r.kind, r.icon),
        label: r.label,
        detail: r.detail ?? r.relPath,
        drill: r.kind === 'category',
      });
    }
    return items;
  }, [pop]);

  const commandItems: PopoverItem[] = useMemo(() => {
    if (!pop || pop.kind !== 'command') return [];
    const q = pop.query.toLowerCase();
    return app.commands
      .filter((c) => !q || c.name.toLowerCase().includes(q))
      .sort((a, b) => Number(b.name.toLowerCase().startsWith(q)) - Number(a.name.toLowerCase().startsWith(q)) || a.name.localeCompare(b.name))
      .slice(0, 40)
      .map((c) => ({ id: c.name, icon: 'terminal', label: `/${c.name}`, detail: c.description, hint: c.argumentHint }));
  }, [pop, app.commands]);

  const popItems = pop?.kind === 'mention' ? mentionItems : commandItems;

  function replaceRange(start: number, end: number, replacement: string): number {
    const el = ref.current;
    const cur = el ? el.value : text;
    let after = cur.slice(end);
    if (replacement === '' && after.startsWith(' ')) after = after.slice(1);
    const next = cur.slice(0, start) + replacement + after;
    setText(next);
    const caret = start + replacement.length;
    requestAnimationFrame(() => {
      const t = ref.current;
      if (!t) return;
      t.focus();
      t.setSelectionRange(caret, caret);
    });
    return caret;
  }

  function pickMention(index: number): void {
    if (!pop || pop.kind !== 'mention') return;
    const item = mentionItems[index];
    if (!item) return;
    const el = ref.current;
    const caret = el ? el.selectionStart : text.length;
    const end = Math.max(caret, pop.start + 1 + pop.query.length);
    if (item.id === '__url') {
      const q = pop.query.trim();
      const url = looksLikeUrl(q) ? q : `https://${q}`;
      addAttachment(chatKey, urlAttachment(url));
      replaceRange(pop.start, end, '');
      setPop(null);
      return;
    }
    const resultIndex = index - (mentionItems.length - pop.results.length);
    const r = pop.results[resultIndex];
    if (!r) return;
    if (r.kind === 'category') {
      const category = (r.value as MentionKind | undefined) ?? 'file';
      setPop({ ...pop, category, results: [], loading: true, active: 0 });
      runSearch(pop.query, category);
      return;
    }
    if (r.kind === 'command') {
      const name = r.value ?? r.label.replace(/^\//, '');
      replaceRange(pop.start, end, `/${name} `);
      setPop(null);
      return;
    }
    const att = resultToAttachment(r);
    if (!att) {
      pushToast('warning', `Cannot attach ${r.label}`);
      return;
    }
    addAttachment(chatKey, att);
    replaceRange(pop.start, end, '');
    setPop(null);
  }

  function pickCommand(index: number): void {
    if (!pop || pop.kind !== 'command') return;
    const item = commandItems[index];
    if (!item) return;
    const el = ref.current;
    const cur = el ? el.value : text;
    const firstWs = cur.search(/\s/);
    const wordEnd = firstWs === -1 ? cur.length : firstWs;
    replaceRange(0, wordEnd, `/${item.id}${cur.slice(wordEnd).startsWith(' ') ? '' : ' '}`);
    setPop(null);
  }

  // ---- actions --------------------------------------------------------------

  const doSend = (sendNow?: boolean) => {
    if (!sendComposer(chatKey, sendNow)) return;
    setPop(null);
    requestAnimationFrame(() => ref.current?.focus());
  };
  const doStop = () => {
    if (chat) post({ type: 'stop', chatId: chat.id });
  };
  const setMode = (m: ChatMode) => {
    setMenu(null);
    whenChatActive((chatId) => post({ type: 'setMode', chatId, mode: m }));
  };
  const cycleMode = (dir: 1 | -1 = 1) => {
    const i = MODES.findIndex((m) => m.id === mode);
    const next = MODES[(i + dir + MODES.length) % MODES.length];
    if (next) setMode(next.id);
  };
  const setModel = (value: string) => {
    setMenu(null);
    whenChatActive((chatId) => post({ type: 'setModel', chatId, model: value }));
  };
  const cycleModel = () => {
    if (app.models.length === 0) return;
    const i = app.models.findIndex((m) => m.value === model);
    const next = app.models[(i + 1) % app.models.length];
    if (next) setModel(next.value);
  };
  const setEffort = (e: EffortLevel) => {
    setMenu(null);
    whenChatActive((chatId) => post({ type: 'setEffort', chatId, effort: e }));
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (pop) {
      const count = popItems.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (count === 0) return;
        setPop((p) => (p ? { ...p, active: (p.active + (e.key === 'ArrowDown' ? 1 : count - 1)) % count } : p));
        return;
      }
      if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
        if (count > 0) {
          e.preventDefault();
          if (pop.kind === 'mention') pickMention(pop.active);
          else pickCommand(pop.active);
          return;
        }
        if (pop.kind === 'mention' && e.key === 'Tab') {
          e.preventDefault();
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setPop(null);
        return;
      }
      if (e.key === 'Backspace' && pop.kind === 'mention' && pop.category && pop.query === '') {
        e.preventDefault();
        setPop({ ...pop, category: undefined, results: [], loading: true, active: 0 });
        runSearch('', undefined);
        return;
      }
    }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (!text.trim() && composer.attachments.length === 0 && pendingPermission && chat) {
        post({ type: 'permission', chatId: chat.id, requestId: pendingPermission, decision: 'allow' });
        return;
      }
      doSend(true);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.altKey) {
      e.preventDefault();
      doSend(false);
      return;
    }
    if ((e.key === '.' && e.ctrlKey) || (e.key === 'Tab' && e.shiftKey)) {
      e.preventDefault();
      cycleMode(1);
      return;
    }
    if (e.key === '/' && e.ctrlKey) {
      e.preventDefault();
      cycleModel();
      return;
    }
    if (e.key === 'Escape') {
      if (menu) {
        setMenu(null);
        return;
      }
      e.preventDefault();
      ref.current?.blur();
      return;
    }
  };

  // ---- images ---------------------------------------------------------------

  const addImageFile = (file: File) => {
    if (!file.type.startsWith('image/')) return false;
    if (file.size > 8 * 1024 * 1024) {
      pushToast('warning', `${file.name || 'Image'} is larger than 8 MB`);
      return true;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const comma = dataUrl.indexOf(',');
      if (comma === -1) return;
      const dataBase64 = dataUrl.slice(comma + 1);
      const name = file.name || `pasted-${Date.now()}.${file.type.split('/')[1] ?? 'png'}`;
      const att: Attachment = { id: uid('img'), kind: 'image', label: name, image: { mediaType: file.type, dataBase64, name } };
      addAttachment(chatKey, att);
    };
    reader.onerror = () => pushToast('error', 'Could not read the image');
    reader.readAsDataURL(file);
    return true;
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = Array.from(e.clipboardData?.items ?? []);
    let handled = false;
    for (const it of items) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f && addImageFile(f)) handled = true;
      }
    }
    if (handled) e.preventDefault();
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const dt = e.dataTransfer;
    let handled = false;
    for (const f of Array.from(dt.files ?? [])) if (addImageFile(f)) handled = true;
    const uriList = dt.getData('text/uri-list') || dt.getData('resourceurls');
    if (uriList) {
      for (const raw of uriList.split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith('#'))) {
        try {
          const list: string[] = raw.startsWith('[') ? (JSON.parse(raw) as string[]) : [raw];
          for (const u of list) {
            const url = new URL(u);
            if (url.protocol !== 'file:') continue;
            const path = decodeURIComponent(url.pathname);
            if (/\.(png|jpe?g|gif|webp)$/i.test(path)) continue; // images arrive via dt.files
            addAttachment(chatKey, { id: uid('a'), kind: 'file', label: path.split('/').pop() ?? path, path, relPath: app.workspaceFolder && path.startsWith(app.workspaceFolder) ? path.slice(app.workspaceFolder.length + 1) : undefined });
            handled = true;
          }
        } catch {
          /* not a URI */
        }
      }
    }
    if (!handled) {
      const t = dt.getData('text/plain');
      if (t) insertAtCaret(t);
    }
    ref.current?.focus();
  };

  // ---- render -----------------------------------------------------------------

  const modeInfo = MODES.find((m) => m.id === mode) ?? MODES[0]!;
  const modelLabel = modelOption?.label ?? (model ? model : 'Default');
  const effortLevels: EffortLevel[] = (modelOption?.effortLevels as EffortLevel[] | undefined) ?? EFFORTS;
  const supportsEffort = modelOption?.supportsEffort ?? app.models.length === 0;
  const canSend = text.trim().length > 0 || composer.attachments.length > 0;
  const placeholder = mode === 'ask' ? 'Ask about your code… (@ for context, / for commands)' : mode === 'plan' ? 'Describe what to plan… (@ for context)' : 'Plan, search, build anything… (@ for context, / for commands)';

  const modeItems: MenuItem[] = MODES.map((m) => ({ id: m.id, label: m.label, description: m.description, icon: m.icon, checked: m.id === mode }));
  const modelItems: MenuItem[] =
    app.models.length > 0
      ? [
          ...app.models.map((m) => ({ id: `m:${m.value}`, label: m.label, description: m.description ?? (m.resolvedModel && m.resolvedModel !== m.value ? m.resolvedModel : undefined), checked: m.value === model })),
          ...(supportsEffort ? [{ id: 'effort', label: `Effort: ${effort || 'default'}`, icon: 'dashboard', submenu: true, separatorBefore: true }] : []),
        ]
      : [
          { id: 'm:', label: 'Default', description: "Claude Code's default model", checked: model === '' },
          { id: 'effort', label: `Effort: ${effort || 'default'}`, icon: 'dashboard', submenu: true, separatorBefore: true },
        ];
  const effortItems: MenuItem[] = effortLevels.map((lvl) => ({ id: `e:${lvl}`, label: lvl || 'Default', checked: lvl === effort }));

  return (
    <div
      className={cx('composer', dragging && 'dragging', running && 'running')}
      onDragOver={(e) => {
        e.preventDefault();
        if (!dragging) setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node)) return;
        setDragging(false);
      }}
      onDrop={onDrop}
    >
      {pop && (
        <Popover
          title={pop.kind === 'command' ? 'Commands' : pop.category ? CATEGORY_TITLES[pop.category] || pop.category : 'Add context'}
          items={popItems}
          active={pop.active}
          loading={pop.kind === 'mention' && pop.loading}
          empty={pop.kind === 'mention' ? (pop.category === 'web' || pop.category === 'docs' ? 'Type a URL' : 'No matches') : 'No commands'}
          onPick={(i) => (pop.kind === 'mention' ? pickMention(i) : pickCommand(i))}
          onHover={(i) => setPop((p) => (p ? { ...p, active: i } : p))}
          onBack={
            pop.kind === 'mention' && pop.category
              ? () => {
                  setPop({ ...pop, category: undefined, results: [], loading: true, active: 0 });
                  runSearch(pop.query, undefined);
                }
              : undefined
          }
          onClose={() => setPop(null)}
        />
      )}
      <div className="composer-box" onClick={() => ref.current?.focus()}>
        {composer.attachments.length > 0 && (
          <div className="pills">
            {composer.attachments.map((a) => (
              <AttachmentPill key={a.id} att={a} onRemove={() => removeAttachment(chatKey, a.id)} />
            ))}
          </div>
        )}
        <textarea
          ref={ref}
          className="composer-input"
          value={text}
          rows={1}
          placeholder={placeholder}
          spellCheck={false}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onKeyUp={onSelect}
          onClick={onSelect}
          onPaste={onPaste}
          aria-label="Message"
        />
        <div className="composer-toolbar" onClick={(e) => e.stopPropagation()}>
          <button type="button" className="tb-btn" title="Add context (@)" onClick={() => insertAtCaret('@')}>
            <Icon name="mention" />
          </button>
          <button type="button" className="tb-btn" title="Attach image" onClick={() => post({ type: 'pickImage' })}>
            <Icon name="file-media" />
          </button>
          <span className="spacer" />
          <span className="menu-anchor">
            <button ref={modeAnchor} type="button" className={cx('tb-select', `mode-${mode}`)} title="Mode (Ctrl+. / Shift+Tab to cycle)" onClick={() => setMenu(menu === 'mode' ? null : 'mode')}>
              <Icon name={modeInfo.icon} />
              <span>{modeInfo.label}</span>
              <Icon name="chevron-down" className="tb-chevron" />
            </button>
            {menu === 'mode' && <Menu items={modeItems} anchorRef={modeAnchor} direction="up" align="right" width={220} onClose={() => setMenu(null)} onPick={(it) => setMode(it.id as ChatMode)} footer={<span className="menu-hint">Ctrl+. cycles modes</span>} />}
          </span>
          <span className="menu-anchor">
            <button ref={modelAnchor} type="button" className="tb-select" title={`Model (Ctrl+/ to cycle)${modelOption?.resolvedModel ? ` · ${modelOption.resolvedModel}` : ''}`} onClick={() => setMenu(menu === 'model' ? null : 'model')}>
              <span className="tb-model">{modelLabel}</span>
              {effort && <span className="tb-effort">{effort}</span>}
              <Icon name="chevron-down" className="tb-chevron" />
            </button>
            {menu === 'model' && (
              <Menu
                items={modelItems}
                anchorRef={modelAnchor}
                direction="up"
                align="right"
                width={240}
                onClose={() => setMenu(null)}
                onPick={(it) => {
                  if (it.id === 'effort') setMenu('effort');
                  else setModel(it.id.slice(2));
                }}
                footer={<span className="menu-hint">Ctrl+/ cycles models</span>}
              />
            )}
            {menu === 'effort' && (
              <Menu
                items={effortItems}
                anchorRef={modelAnchor}
                direction="up"
                align="right"
                width={180}
                header={
                  <button type="button" className="link-btn" onClick={() => setMenu('model')}>
                    <Icon name="arrow-left" /> Effort
                  </button>
                }
                onClose={() => setMenu(null)}
                onPick={(it) => setEffort(it.id.slice(2) as EffortLevel)}
              />
            )}
          </span>
          <ContextRing usage={chat?.contextUsage} rateLimit={chat?.rateLimit} />
          {running ? (
            <button type="button" className="send-btn stop" onClick={doStop} title="Stop (Ctrl+Shift+Backspace)">
              <Icon name="debug-stop" />
            </button>
          ) : (
            <button type="button" className="send-btn" disabled={!canSend} onClick={() => doSend(false)} title="Send (Enter)">
              <Icon name="arrow-up" />
            </button>
          )}
        </div>
      </div>
      {running && (
        <div className="composer-hint">
          {canSend ? (
            <>
              <kbd>Enter</kbd> queue · <kbd>Ctrl+Enter</kbd> send now
            </>
          ) : pendingPermission ? (
            <>
              <kbd>Ctrl+Enter</kbd> approve
            </>
          ) : (
            <span className="muted">Working… type to queue a follow-up</span>
          )}
        </div>
      )}
      {dragging && <div className="drop-overlay">Drop files or images to attach</div>}
    </div>
  );
}
