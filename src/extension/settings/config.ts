/**
 * Typed access to the `kursor.*` configuration for the settings panel.
 *
 * `SETTING_SPECS` mirrors `contributes.configuration` in package.json (type, default, enum,
 * minimum). The manifest stays authoritative: `verifySpecsAgainstManifest()` logs a warning at
 * activation when the two drift apart, and `readMeta()` takes descriptions / enum descriptions
 * from the manifest so the panel's copy never goes stale.
 *
 * Incoming writes from the webview are untrusted: `coerceValue()` validates and normalizes every
 * value against its spec before it reaches `WorkspaceConfiguration.update`.
 */
import * as vscode from 'vscode';
import {
  SETTING_KEYS,
  type SettingKey,
  type SettingMeta,
  type SettingScope,
  type SettingsSnapshot,
  type SettingsValues,
} from '../../shared/settingsProtocol';
import type { Logger } from '../util/log';

export const SECTION = 'kursor';

type SettingType = 'string' | 'boolean' | 'number' | 'string[]';

interface SettingSpec<K extends SettingKey = SettingKey> {
  type: SettingType;
  defaultValue: SettingsValues[K];
  enumValues?: readonly string[];
  minimum?: number;
  maximum?: number;
}

export const SETTING_SPECS: { [K in SettingKey]: SettingSpec<K> } = {
  'claude.path': { type: 'string', defaultValue: '' },
  'claude.model': { type: 'string', defaultValue: '' },
  'claude.effort': { type: 'string', defaultValue: '', enumValues: ['', 'low', 'medium', 'high', 'xhigh', 'max'] },
  'agent.defaultMode': { type: 'string', defaultValue: 'agent', enumValues: ['agent', 'ask', 'plan'] },
  'agent.permissionMode': { type: 'string', defaultValue: 'acceptEdits', enumValues: ['acceptEdits', 'default', 'auto', 'bypassPermissions'] },
  'agent.inlineDiffs': { type: 'boolean', defaultValue: true },
  'agent.autoSave': { type: 'boolean', defaultValue: true },
  'agent.attachOpenFile': { type: 'boolean', defaultValue: true },
  'agent.notifyOnPermission': { type: 'boolean', defaultValue: true },
  'tab.enabled': { type: 'boolean', defaultValue: true },
  'tab.debounceMs': { type: 'number', defaultValue: 900, minimum: 150, maximum: 60_000 },
  'tab.model': { type: 'string', defaultValue: 'haiku' },
  'tab.disabledLanguages': { type: 'string[]', defaultValue: ['plaintext', 'markdown', 'log', 'scminput'] },
  'tab.contextLines': { type: 'number', defaultValue: 120, minimum: 5, maximum: 2000 },
  'inlineEdit.model': { type: 'string', defaultValue: 'sonnet' },
  'terminal.model': { type: 'string', defaultValue: 'sonnet' },
  'commit.model': { type: 'string', defaultValue: 'sonnet' },
  'rules.user': { type: 'string', defaultValue: '' },
  'rules.useProjectRules': { type: 'boolean', defaultValue: true },
  'ide.enableServer': { type: 'boolean', defaultValue: true },
  'chat.showThinking': { type: 'boolean', defaultValue: true },
  'chat.toolCallDensity': { type: 'string', defaultValue: 'balanced', enumValues: ['compact', 'balanced', 'detailed'] },
};

export class SettingValueError extends Error {
  constructor(
    readonly key: SettingKey,
    message: string,
  ) {
    super(message);
    this.name = 'SettingValueError';
  }
}

/** Validate + normalize an untrusted value for `key`. Throws `SettingValueError` when it cannot be used. */
export function coerceValue<K extends SettingKey>(key: K, raw: unknown): SettingsValues[K] {
  const spec = SETTING_SPECS[key] as SettingSpec;
  switch (spec.type) {
    case 'boolean': {
      if (typeof raw === 'boolean') return raw as SettingsValues[K];
      if (raw === 'true' || raw === 'false') return (raw === 'true') as SettingsValues[K];
      throw new SettingValueError(key, `expected a boolean for ${key}`);
    }
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : NaN;
      if (!Number.isFinite(n)) throw new SettingValueError(key, `expected a number for ${key}`);
      let v = Math.round(n);
      if (spec.minimum !== undefined) v = Math.max(spec.minimum, v);
      if (spec.maximum !== undefined) v = Math.min(spec.maximum, v);
      return v as SettingsValues[K];
    }
    case 'string[]': {
      if (!Array.isArray(raw)) throw new SettingValueError(key, `expected a list for ${key}`);
      const seen = new Set<string>();
      const out: string[] = [];
      for (const item of raw) {
        const s = String(item ?? '').trim();
        if (!s) continue;
        const norm = key === 'tab.disabledLanguages' ? s.toLowerCase() : s;
        if (seen.has(norm)) continue;
        seen.add(norm);
        out.push(norm);
      }
      return out as SettingsValues[K];
    }
    case 'string': {
      if (typeof raw !== 'string') throw new SettingValueError(key, `expected text for ${key}`);
      // Multiline text (user rules) keeps its whitespace; single-line values are trimmed.
      const v = key === 'rules.user' ? raw.replace(/\r\n/g, '\n') : raw.trim();
      if (spec.enumValues && !spec.enumValues.includes(v)) {
        throw new SettingValueError(key, `"${v}" is not a valid value for ${key} (${spec.enumValues.map((e) => e || '(default)').join(', ')})`);
      }
      if (v.length > 100_000) throw new SettingValueError(key, `${key} is too long`);
      return v as SettingsValues[K];
    }
  }
}

/** Current effective value of `key`, normalized (falls back to the default on garbage). */
export function readValue<K extends SettingKey>(config: vscode.WorkspaceConfiguration, key: K): SettingsValues[K] {
  const spec = SETTING_SPECS[key] as SettingSpec;
  const raw = config.get<unknown>(key);
  if (raw === undefined || raw === null) return spec.defaultValue as SettingsValues[K];
  try {
    return coerceValue(key, raw);
  } catch {
    return spec.defaultValue as SettingsValues[K];
  }
}

export function readValues(): SettingsValues {
  const config = vscode.workspace.getConfiguration(SECTION);
  const out = {} as Record<SettingKey, unknown>;
  for (const key of SETTING_KEYS) out[key] = readValue(config, key);
  return out as unknown as SettingsValues;
}

function scopeOf(config: vscode.WorkspaceConfiguration, key: SettingKey): SettingScope {
  const info = config.inspect<unknown>(key);
  if (!info) return 'default';
  if (info.workspaceFolderValue !== undefined || info.workspaceFolderLanguageValue !== undefined) return 'workspaceFolder';
  if (info.workspaceValue !== undefined || info.workspaceLanguageValue !== undefined) return 'workspace';
  if (info.globalValue !== undefined || info.globalLanguageValue !== undefined) return 'global';
  return 'default';
}

interface ManifestProperty {
  type?: string | string[];
  default?: unknown;
  enum?: unknown[];
  enumDescriptions?: unknown[];
  description?: string;
  markdownDescription?: string;
  minimum?: number;
}

function manifestProperties(packageJSON: unknown): Record<string, ManifestProperty> {
  const contributes = (packageJSON as { contributes?: { configuration?: unknown } } | undefined)?.contributes;
  const configuration = contributes?.configuration;
  const blocks = Array.isArray(configuration) ? configuration : configuration ? [configuration] : [];
  const out: Record<string, ManifestProperty> = {};
  for (const block of blocks) {
    const props = (block as { properties?: Record<string, ManifestProperty> })?.properties;
    if (props && typeof props === 'object') Object.assign(out, props);
  }
  return out;
}

/** Turn a `markdownDescription` into plain text good enough for a tooltip. */
function plainDescription(p: ManifestProperty | undefined): string | undefined {
  const text = p?.description ?? p?.markdownDescription;
  if (!text) return undefined;
  return text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*\*([^*]*)\*\*/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .trim();
}

export function readMeta(packageJSON: unknown): SettingMeta[] {
  const config = vscode.workspace.getConfiguration(SECTION);
  const props = manifestProperties(packageJSON);
  return SETTING_KEYS.map((key) => {
    const spec = SETTING_SPECS[key] as SettingSpec;
    const p = props[`${SECTION}.${key}`];
    const enumValues = Array.isArray(p?.enum) ? p.enum.map((e) => String(e)) : spec.enumValues ? [...spec.enumValues] : undefined;
    const enumDescriptions = Array.isArray(p?.enumDescriptions) ? p.enumDescriptions.map((e) => String(e)) : undefined;
    return {
      key,
      defaultValue: spec.defaultValue,
      scope: scopeOf(config, key),
      description: plainDescription(p),
      enumValues,
      enumDescriptions,
      minimum: typeof p?.minimum === 'number' ? p.minimum : spec.minimum,
    };
  });
}

export function readSnapshot(packageJSON: unknown): SettingsSnapshot {
  return { values: readValues(), meta: readMeta(packageJSON) };
}

/** Write a user-level (global) value. Returns true when the effective value is shadowed by a workspace override. */
export async function writeValue<K extends SettingKey>(key: K, value: SettingsValues[K] | undefined): Promise<{ shadowed: boolean }> {
  const config = vscode.workspace.getConfiguration(SECTION);
  const scope = scopeOf(config, key);
  await config.update(key, value, vscode.ConfigurationTarget.Global);
  return { shadowed: scope === 'workspace' || scope === 'workspaceFolder' };
}

function sameJson(a: unknown, b: unknown): boolean {
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Log a warning for every spec that disagrees with the manifest (defaults, enums, missing keys). */
export function verifySpecsAgainstManifest(packageJSON: unknown, log: Logger): void {
  const props = manifestProperties(packageJSON);
  const problems: string[] = [];
  for (const key of SETTING_KEYS) {
    const p = props[`${SECTION}.${key}`];
    const spec = SETTING_SPECS[key] as SettingSpec;
    if (!p) {
      problems.push(`${key}: not declared in package.json`);
      continue;
    }
    if (p.default !== undefined && !sameJson(p.default, spec.defaultValue)) problems.push(`${key}: default ${JSON.stringify(p.default)} ≠ ${JSON.stringify(spec.defaultValue)}`);
    if (Array.isArray(p.enum) && !sameJson(p.enum, spec.enumValues)) problems.push(`${key}: enum differs`);
  }
  for (const name of Object.keys(props)) {
    if (!name.startsWith(`${SECTION}.`)) continue;
    if (!(SETTING_KEYS as readonly string[]).includes(name.slice(SECTION.length + 1))) problems.push(`${name}: declared in package.json but unknown to the settings panel`);
  }
  if (problems.length) log.warn(`settings specs out of sync with package.json:\n  ${problems.join('\n  ')}`);
}
