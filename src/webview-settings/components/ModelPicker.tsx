/**
 * Model chooser: a dropdown of presets (optionally "Default (Claude Code)") plus a "Custom…" entry
 * that reveals a free-text field for full model ids such as `claude-sonnet-4-5[1m]`.
 */
import { useState } from 'react';
import type { SettingKey, SettingsValues } from '../../shared/settingsProtocol';
import { useId } from '../hooks';
import { setSetting } from '../store';
import { CUSTOM_MODEL, MODEL_PRESETS } from '../util';
import { Select, SettingFooter, SettingRow, TextField, useSettingMeta, useSettingValue, type SelectOption } from './controls';

type ModelKey = { [K in SettingKey]: SettingsValues[K] extends string ? K : never }[SettingKey];

export function ModelSetting({ setting, label, description, allowDefault, defaultLabel }: { setting: ModelKey; label: string; description?: string; allowDefault?: boolean; defaultLabel?: string }) {
  const value = useSettingValue(setting);
  const meta = useSettingMeta(setting);
  const id = useId('model');
  const descId = `${id}-desc`;
  const presetValues = new Set(MODEL_PRESETS.map((p) => p.value));
  const isPreset = (allowDefault && value === '') || presetValues.has(value);
  const [custom, setCustom] = useState(!isPreset);
  const showCustom = custom || !isPreset;

  const options: SelectOption[] = [
    ...(allowDefault ? [{ value: '', label: defaultLabel ?? 'Default (Claude Code)', description: 'Whatever the CLI is configured to use' }] : []),
    ...MODEL_PRESETS.map((p) => ({ value: p.value, label: p.label, description: p.description })),
    { value: CUSTOM_MODEL, label: 'Custom model id…' },
  ];
  const selectValue = showCustom ? CUSTOM_MODEL : value;

  const onSelect = (v: string) => {
    if (v === CUSTOM_MODEL) {
      setCustom(true);
      return;
    }
    setCustom(false);
    setSetting(setting, v as SettingsValues[typeof setting]);
  };

  return (
    <SettingRow
      label={label}
      description={description}
      htmlFor={id}
      descriptionId={descId}
      footer={<SettingFooter meta={meta} value={value} />}
      control={
        <div className="model-control">
          <Select id={id} value={selectValue} options={options} describedBy={descId} onChange={onSelect} />
          {showCustom && (
            <TextField
              value={value}
              mono
              width={220}
              placeholder="e.g. claude-sonnet-4-5 or opus[1m]"
              ariaLabel={`${label} custom model id`}
              autoFocus={custom && isPreset}
              onCommit={(v) => {
                const next = v.trim();
                if (!next && !allowDefault) return false; // keep the previous value rather than writing an empty model
                if (next === value) return false; // only whitespace changed: restore the canonical text
                setSetting(setting, next as SettingsValues[typeof setting]);
                if (presetValues.has(next) || (allowDefault && next === '')) setCustom(false);
                return true;
              }}
            />
          )}
        </div>
      }
    />
  );
}
