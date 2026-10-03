# `settings/` — Kursor Settings panel host ([F])

The "Kursor Settings" editor tab (`Ctrl+Shift+J`, command `kursor.settings.open`): a singleton
`WebviewPanel` (viewType `kursor.settings`, `retainContextWhenHidden`, serializer-restored) hosting
the React UI in `src/webview-settings/` (bundled to `dist/settings.js` + `dist/settings.css`).
The contract is `src/shared/settingsProtocol.ts`; nothing in the webview imports from `src/extension`.

| file | role |
|---|---|
| `index.ts` | `registerSettings(context, deps)`: creates the controller, registers `kursor.settings.open` (optional arg `'rules'` / `{ tab }`) and `kursor.rules.new` |
| `panel.ts` | `SettingsPanelController`: panel lifecycle, state snapshots, message dispatch, live refresh subscriptions |
| `config.ts` | typed `kursor.*` access: `SETTING_SPECS` (type / default / enum / min-max), `coerceValue()` validation of untrusted panel input, `readSnapshot()` (values + per-key meta from `package.json` + effective scope), `writeValue()` → `ConfigurationTarget.Global`, `verifySpecsAgainstManifest()` self-check at activation |
| `workspace.ts` | folder selection (active file's folder → first folder), `.cursorignore` / `.gitignore` open-or-create, path guard for `openFile` |
| `rulesActions.ts` | `kursor.rules.new`: name → type (Always / Auto Attached / Agent Requested / Manual) → globs / description → `.cursor/rules/<slug>.mdc` with front matter, opened with the cursor on the first bullet |
| `html.ts` | CSP/nonce HTML (same pattern as `chat/html.ts`) |

## Data flow

```
panel 'ready' ──▶ host posts {type:'state'} (settings + claude status + rules + workspace + about)
host pushes: 'settings'      on onDidChangeConfiguration('kursor')   (50 ms coalesced)
             'claudeStatus'  on bridge.onDidChangeStatus / refreshStatus()
             'rules'         on rules.onDidChange / folder change / refresh (generation-guarded)
             'workspace'     on onDidChangeWorkspaceFolders / ignore-file actions
             'selectTab'     when kursor.settings.open is called with a tab while open
panel posts: setSetting / resetSetting (optimistic in the UI; host validates with coerceValue, writes Global,
             warns when a workspace override shadows the value), refreshStatus, refreshRules, selectFolder,
             newRule, openRule/openFile (workspace- or home-scoped), openCursorignore, openGitignore,
             openUrl (http/https only), openEditorSettings (user or workspace, with query),
             runCommand (allow-listed command ids only), tabChanged, log
```

Every incoming message runs inside `try/catch`: failures are logged through `deps.log` and shown as a
toast in the panel; failed writes re-send the real values so the optimistic UI snaps back.

## Settings covered

All 22 `kursor.*` keys from `package.json`: `claude.{path,model,effort}`, `agent.{defaultMode,
permissionMode,inlineDiffs,autoSave,attachOpenFile,notifyOnPermission}`, `tab.{enabled,debounceMs,model,
disabledLanguages,contextLines}`, `inlineEdit.model`, `terminal.model`, `commit.model`,
`rules.{user,useProjectRules}`, `ide.enableServer`, `chat.{showThinking,toolCallDensity}`.
When a key is overridden at workspace / folder level the panel shows "Overridden in this workspace" with
a link to the workspace settings editor; when the user value differs from the default it offers "Reset
to default" (`update(key, undefined, Global)`).

## Tabs

General (Claude status card: executable, version, account/plan, last check; Sign in → `kursor.claude.login`,
Re-check → `bridge.refreshStatus()`, Change path → settings UI at `kursor.claude.path`; editor settings /
keybindings / theme; IDE bridge toggle; logs) · Agents (default mode, permission mode with Cursor-style
descriptions, notify, inline diffs, auto-save, attach open file, chat display) · Tab (enable, debounce,
model, context lines, disabled languages chip editor) · Models (default model + effort; Ctrl+K, terminal,
commit, Tab models; presets + custom id) · Rules (user rules textarea, project rules list with kind badges and
Open, New Rule, folder picker for multi-root) · Indexing (how access works, `.cursorignore` / `.gitignore`
open-or-create, privacy notes) · About (version, editor, CLI, diagnostics copy, links, shortcuts, notice).

Typecheck: `npx tsc --noEmit -p tsconfig.json` and `npx tsc --noEmit -p src/webview-settings/tsconfig.json`.
