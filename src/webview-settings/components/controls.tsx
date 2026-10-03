/**
 * Form primitives, all themed with --vscode-* variables and keyboard accessible:
 * Section / SettingRow layout, Toggle (role=switch), RadioGroup (native radios), Select,
 * NumberField, TextField, TextAreaField, TagListField and the SettingControl wrappers that bind
 * them to a `SettingKey` (optimistic write + "overridden in workspace" / reset affordances).
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { SettingKey, SettingMeta, SettingsValues } from '../../shared/settingsProtocol';
import { useDraft, useId } from '../hooks';
import { resetSetting, setSetting, useStore } from '../store';
import { cx, sameJson } from '../util';
import { post } from '../vscode';
import { Icon } from './Icon';

// ---------------------------------------------------------------- layout

export function Section({ title, description, children, actions }: { title: string; description?: ReactNode; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="section">
      <header className="section-header">
        <div className="section-heading">
          <h2 className="section-title">{title}</h2>
          {description && <p className="section-desc">{description}</p>}
        </div>
        {actions && <div className="section-actions">{actions}</div>}
      </header>
      <div className="section-body">{children}</div>
    </section>
  );
}

export interface SettingRowProps {
  label: ReactNode;
  description?: ReactNode;
  /** Control rendered on the right (toggles, selects, short inputs). */
  control?: ReactNode;
  /** Content rendered below the label at full width (radio groups, textareas, lists). */
  children?: ReactNode;
  htmlFor?: string;
  descriptionId?: string;
  /** Extra line under the description: "Overridden in workspace", reset link… */
  footer?: ReactNode;
  className?: string;
}

export function SettingRow({ label, description, control, children, htmlFor, descriptionId, footer, className }: SettingRowProps) {
  return (
    <div className={cx('row', !control && 'row-stacked', className)}>
      <div className="row-main">
        <div className="row-text">
          {htmlFor ? (
            <label className="row-label" htmlFor={htmlFor}>
              {label}
            </label>
          ) : (
            <div className="row-label">{label}</div>
          )}
          {description && (
            <div className="row-desc" id={descriptionId}>
              {description}
            </div>
          )}
          {footer && <div className="row-footer">{footer}</div>}
        </div>
        {control && <div className="row-control">{control}</div>}
      </div>
      {children && <div className="row-body">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- primitives

export function Toggle({ checked, onChange, id, disabled, describedBy, label }: { checked: boolean; onChange: (v: boolean) => void; id?: string; disabled?: boolean; describedBy?: string; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      id={id}
      aria-checked={checked}
      aria-describedby={describedBy}
      aria-label={label}
      disabled={disabled}
      className={cx('toggle', checked && 'on')}
      onClick={() => onChange(!checked)}
    >
      <span className="toggle-thumb" />
    </button>
  );
}

export interface RadioOption<T extends string> {
  value: T;
  label: ReactNode;
  description?: ReactNode;
  danger?: boolean;
}

export function RadioGroup<T extends string>({ name, value, options, onChange, ariaLabelledBy }: { name: string; value: T; options: RadioOption<T>[]; onChange: (v: T) => void; ariaLabelledBy?: string }) {
  return (
    <div className="radios" role="radiogroup" aria-labelledby={ariaLabelledBy}>
      {options.map((o) => {
        const id = `${name}-${o.value || 'default'}`;
        const selected = o.value === value;
        return (
          <label key={o.value} htmlFor={id} className={cx('radio', selected && 'selected', o.danger && 'danger')}>
            <input type="radio" id={id} name={name} value={o.value} checked={selected} onChange={() => onChange(o.value)} />
            <span className="radio-dot" aria-hidden="true" />
            <span className="radio-text">
              <span className="radio-label">{o.label}</span>
              {o.description && <span className="radio-desc">{o.description}</span>}
            </span>
          </label>
        );
      })}
    </div>
  );
}

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
}

export function Select({ value, options, onChange, id, describedBy, ariaLabel, className }: { value: string; options: SelectOption[]; onChange: (v: string) => void; id?: string; describedBy?: string; ariaLabel?: string; className?: string }) {
  const known = options.some((o) => o.value === value);
  return (
    <div className={cx('select-wrap', className)}>
      <select id={id} className="select" value={value} onChange={(e) => onChange(e.target.value)} aria-describedby={describedBy} aria-label={ariaLabel}>
        {!known && (
          <option value={value} disabled>
            {value || '(unset)'}
          </option>
        )}
        {options.map((o) => (
          <option key={o.value} value={o.value} disabled={o.disabled} title={o.description}>
            {o.label}
          </option>
        ))}
      </select>
      <Icon name="chevron-down" className="select-chevron" />
    </div>
  );
}

export function NumberField({ value, onCommit, min, max, step, id, describedBy, suffix, width }: { value: number; onCommit: (v: number) => void; min?: number; max?: number; step?: number; id?: string; describedBy?: string; suffix?: string; width?: number }) {
  const clamp = useCallback(
    (n: number) => {
      let v = Math.round(n);
      if (min !== undefined) v = Math.max(min, v);
      if (max !== undefined) v = Math.min(max, v);
      return v;
    },
    [min, max],
  );
  const { draft, setDraft, begin, end, revert } = useDraft<string>(String(value), (text) => {
    const n = Number(text);
    if (text.trim() === '' || !Number.isFinite(n)) return false; // rejected → the hook reverts the text
    const next = clamp(n);
    if (next === value) return false; // e.g. "50" clamped back to the current 150: just restore the text
    onCommit(next);
    return true;
  });
  const invalid = draft.trim() === '' || !Number.isFinite(Number(draft)) || (min !== undefined && Number(draft) < min) || (max !== undefined && Number(draft) > max);
  return (
    <span className="number-wrap">
      <input
        id={id}
        type="number"
        className={cx('input number', invalid && 'invalid')}
        value={draft}
        min={min}
        max={max}
        step={step ?? 1}
        inputMode="numeric"
        style={width ? { width } : undefined}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        onFocus={begin}
        onBlur={end}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') {
            revert();
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      {suffix && <span className="number-suffix">{suffix}</span>}
    </span>
  );
}

export function TextField({ value, onCommit, placeholder, id, describedBy, mono, width, ariaLabel, autoFocus }: { value: string; onCommit: (v: string) => void; placeholder?: string; id?: string; describedBy?: string; mono?: boolean; width?: number | string; ariaLabel?: string; autoFocus?: boolean }) {
  const { draft, setDraft, begin, end, revert } = useDraft<string>(value, onCommit);
  return (
    <input
      id={id}
      type="text"
      className={cx('input', mono && 'mono')}
      value={draft}
      placeholder={placeholder}
      spellCheck={false}
      autoFocus={autoFocus}
      style={width !== undefined ? { width } : undefined}
      aria-describedby={describedBy}
      aria-label={ariaLabel}
      onFocus={begin}
      onBlur={end}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        if (e.key === 'Escape') {
          revert();
          (e.target as HTMLInputElement).blur();
        }
      }}
    />
  );
}

export function TextAreaField({ value, onCommit, placeholder, id, describedBy, rows, debounceMs = 800 }: { value: string; onCommit: (v: string) => void; placeholder?: string; id?: string; describedBy?: string; rows?: number; debounceMs?: number }) {
  const { draft, setDraft, begin, end, dirty } = useDraft<string>(value, onCommit, { debounceMs });
  const ref = useRef<HTMLTextAreaElement>(null);
  // Auto-grow between rows and a max height; keeps the panel from needing nested scrollbars.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(480, Math.max(el.scrollHeight, 72))}px`;
  }, [draft]);
  return (
    <div className="textarea-wrap">
      <textarea ref={ref} id={id} className="input textarea" value={draft} rows={rows ?? 4} placeholder={placeholder} spellCheck={false} aria-describedby={describedBy} onFocus={begin} onBlur={end} onChange={(e) => setDraft(e.target.value)} />
      <div className={cx('textarea-status', dirty && 'dirty')} aria-live="polite">
        {dirty ? 'Saving…' : 'Saved'}
      </div>
    </div>
  );
}

export function TagListField({ values, onChange, suggestions, placeholder, id, describedBy, ariaLabel }: { values: string[]; onChange: (v: string[]) => void; suggestions?: string[]; placeholder?: string; id?: string; describedBy?: string; ariaLabel?: string }) {
  const [text, setText] = useState('');
  const listId = useId('taglist');
  const add = (raw: string) => {
    const items = raw
      .split(/[,\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
    if (items.length === 0) return;
    const next = [...values];
    for (const it of items) if (!next.includes(it)) next.push(it);
    if (next.length !== values.length) onChange(next);
    setText('');
  };
  const remove = (item: string) => onChange(values.filter((v) => v !== item));
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(text);
    } else if (e.key === 'Backspace' && text === '' && values.length > 0) {
      e.preventDefault();
      remove(values[values.length - 1]);
    }
  };
  const remaining = useMemo(() => (suggestions ?? []).filter((s) => !values.includes(s)), [suggestions, values]);
  return (
    <div className="taglist" onClick={(e) => (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}>
      {values.map((v) => (
        <span key={v} className="tag">
          <code>{v}</code>
          <button type="button" className="tag-remove" onClick={(e) => { e.stopPropagation(); remove(v); }} aria-label={`Remove ${v}`} title="Remove">
            <Icon name="close" />
          </button>
        </span>
      ))}
      <input
        id={id}
        type="text"
        className="tag-input"
        value={text}
        list={listId}
        placeholder={values.length === 0 ? placeholder : 'Add…'}
        spellCheck={false}
        aria-describedby={describedBy}
        aria-label={ariaLabel}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={() => add(text)}
      />
      <datalist id={listId}>
        {remaining.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </div>
  );
}

export function Button({ children, onClick, primary, ghost, small, icon, disabled, title, danger, className, type }: { children?: ReactNode; onClick?: () => void; primary?: boolean; ghost?: boolean; small?: boolean; icon?: string; disabled?: boolean; title?: string; danger?: boolean; className?: string; type?: 'button' | 'submit' }) {
  return (
    <button type={type ?? 'button'} className={cx('btn', primary && 'primary', ghost && 'ghost', small && 'small', danger && 'danger', className)} onClick={onClick} disabled={disabled} title={title}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

export function LinkButton({ children, onClick, icon, title }: { children: ReactNode; onClick: () => void; icon?: string; title?: string }) {
  return (
    <button type="button" className="link-btn" onClick={onClick} title={title}>
      {icon && <Icon name={icon} />}
      {children}
    </button>
  );
}

export function Badge({ children, kind }: { children: ReactNode; kind?: 'default' | 'warn' | 'ok' | 'error' | 'muted' }) {
  return <span className={cx('badge', kind && kind !== 'default' && `badge-${kind}`)}>{children}</span>;
}

// ---------------------------------------------------------------- setting bindings

export function useSettingValue<K extends SettingKey>(key: K): SettingsValues[K] {
  return useStore((s) => s.state!.settings.values[key]);
}

export function useSettingMeta(key: SettingKey): SettingMeta | undefined {
  return useStore((s) => s.state!.settings.meta.find((m) => m.key === key));
}

/** "Overridden in workspace" / "Reset to default" line shown under a bound setting. */
export function SettingFooter({ meta, value }: { meta: SettingMeta | undefined; value: unknown }) {
  if (!meta) return null;
  const overridden = meta.scope === 'workspace' || meta.scope === 'workspaceFolder';
  const differs = !sameJson(value, meta.defaultValue);
  if (!overridden && !differs) return null;
  return (
    <span className="setting-footer">
      {overridden && (
        <span className="override">
          <Icon name="warning" />
          Overridden in this {meta.scope === 'workspace' ? 'workspace' : 'folder'} —{' '}
          <LinkButton onClick={() => post({ type: 'openEditorSettings', query: `kursor.${meta.key}`, scope: 'workspace' })}>open workspace setting</LinkButton>
        </span>
      )}
      {differs && !overridden && (
        <LinkButton icon="discard" onClick={() => resetSetting(meta.key)} title={`Default: ${formatDefault(meta.defaultValue)}`}>
          Reset to default
        </LinkButton>
      )}
    </span>
  );
}

function formatDefault(v: unknown): string {
  if (Array.isArray(v)) return v.length ? v.join(', ') : '(none)';
  if (v === '') return '(empty)';
  return String(v);
}

type BooleanKey = { [K in SettingKey]: SettingsValues[K] extends boolean ? K : never }[SettingKey];
type NumberKey = { [K in SettingKey]: SettingsValues[K] extends number ? K : never }[SettingKey];
type StringKey = { [K in SettingKey]: SettingsValues[K] extends string ? K : never }[SettingKey];

export function ToggleSetting({ setting, label, description }: { setting: BooleanKey; label: ReactNode; description?: ReactNode }) {
  const value = useSettingValue(setting);
  const meta = useSettingMeta(setting);
  const id = useId('toggle');
  const descId = `${id}-desc`;
  return (
    <SettingRow label={label} description={description} htmlFor={id} descriptionId={descId} footer={<SettingFooter meta={meta} value={value} />} control={<Toggle id={id} checked={value} describedBy={descId} onChange={(v) => setSetting(setting, v)} />} />
  );
}

export function NumberSetting({ setting, label, description, min, max, step, suffix }: { setting: NumberKey; label: ReactNode; description?: ReactNode; min?: number; max?: number; step?: number; suffix?: string }) {
  const value = useSettingValue(setting);
  const meta = useSettingMeta(setting);
  const id = useId('number');
  const descId = `${id}-desc`;
  return (
    <SettingRow
      label={label}
      description={description}
      htmlFor={id}
      descriptionId={descId}
      footer={<SettingFooter meta={meta} value={value} />}
      control={<NumberField id={id} value={value} min={min ?? meta?.minimum} max={max} step={step} suffix={suffix} describedBy={descId} onCommit={(v) => setSetting(setting, v)} />}
    />
  );
}

export function SelectSetting({ setting, label, description, options }: { setting: StringKey; label: ReactNode; description?: ReactNode; options: SelectOption[] }) {
  const value = useSettingValue(setting);
  const meta = useSettingMeta(setting);
  const id = useId('select');
  const descId = `${id}-desc`;
  return (
    <SettingRow
      label={label}
      description={description}
      htmlFor={id}
      descriptionId={descId}
      footer={<SettingFooter meta={meta} value={value} />}
      control={<Select id={id} value={value} options={options} describedBy={descId} onChange={(v) => setSetting(setting, v as SettingsValues[typeof setting])} />}
    />
  );
}

export function RadioSetting<K extends StringKey>({ setting, label, description, options }: { setting: K; label: ReactNode; description?: ReactNode; options: RadioOption<SettingsValues[K] & string>[] }) {
  const value = useSettingValue(setting);
  const meta = useSettingMeta(setting);
  const id = useId('radio');
  return (
    <SettingRow label={<span id={`${id}-label`}>{label}</span>} description={description} footer={<SettingFooter meta={meta} value={value} />}>
      <RadioGroup name={id} value={value as SettingsValues[K] & string} options={options} ariaLabelledBy={`${id}-label`} onChange={(v) => setSetting(setting, v as SettingsValues[K])} />
    </SettingRow>
  );
}

export function TextAreaSetting({ setting, label, description, placeholder, rows }: { setting: StringKey; label: ReactNode; description?: ReactNode; placeholder?: string; rows?: number }) {
  const value = useSettingValue(setting);
  const meta = useSettingMeta(setting);
  const id = useId('textarea');
  const descId = `${id}-desc`;
  return (
    <SettingRow label={label} description={description} htmlFor={id} descriptionId={descId} footer={<SettingFooter meta={meta} value={value} />}>
      <TextAreaField id={id} value={value} placeholder={placeholder} rows={rows} describedBy={descId} onCommit={(v) => setSetting(setting, v as SettingsValues[typeof setting])} />
    </SettingRow>
  );
}
