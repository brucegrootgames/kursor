All verification is green: 11/11 runner tests, 23/23 webview tests, typecheck 0 errors, build OK. Final report follows.

## Review/finish report — modules [B] chat host + [C] chat webview

**Verification:** `npm run typecheck` → 0 errors; `node esbuild.mjs` → OK; `node src/extension/chat/__tests__/runner.test.mjs` → 11 passed (ChatRunner driven through real event sequences with a stub `vscode`/session); `node src/webview/__tests__/markdown.test.mjs` → 23 passed (sanitizer, fence meta, mention helpers).

### Checklist

1. **Protocol conformance** — all 28 `WebviewToHost` types handled in `messages.ts`/`views.ts`; all 10 `HostToWebview` types handled in `store.ts`; field names match. Added (additive) `focusChanged` (see 3).
2. **Session events** — every `SessionEvent` variant handled. **Fixed:** (a) `userReplay`/`userMessageUuid` used "oldest user message without uuid", so restored/transcript messages stole the uuid → now a FIFO of messages sent through the runner; (b) a queued message's replay reset the current assistant message mid-stream → no longer; (c) interrupt → send-now race: the stopped turn's late `result` ended the new turn and posted a red error → late results are now recognised (bridge `session.running` + interrupted flag), cost kept, no note; (d) `interrupt()` on an idle chat called `finishTurn`/`onTurnEnd` → guarded; running tools now show "Interrupted"; (e) `setModel/setEffort/setPermissionMode` on a dead process threw into a toast → logged, applied on respawn; (f) plan **Build** now goes through `session.setMode('agent')` (bridge README) via `syncSessionMode()`; (g) removed a no-op in the `status` handler.
3. **Commands/context keys** — all 14 `kursor.chat.*` and 8 `kursor.edits.*` registered; `kursor.chatRunning`/`kursor.hasPendingEdits` set. **Fixed:** `kursor.chat.open` closed the bar whenever the view was *visible*; spec says visible **and focused** → webview reports `focusChanged` on window focus/blur, `ChatViewProvider.focused` drives the toggle. Badge counter reset was hooked to `onDidChangeVisibleTextEditors` → now the view's own visibility event.
4. **HTML** — loads `webview.js`, `webview.css` (existence-checked; `main.tsx` also self-links as fallback), `codicon.css`; CSP has `font-src cspSource`, `img-src … data:`, nonce script. No change needed.
5. **Webview** — code-fence Copy/Apply/Insert/Run/New file → host routes apply→`kursor.inlineEdit.applyCode {code,path,language}`, insert→`kursor.inlineEdit.insertAtCursor {code}`, run→terminal; mention popover with `requestId`; image paste/drop; mode/model/effort menus; permission/question/plan cards; two-click restore + host modal; sign-in panel; history; all shortcuts. **Fixed:** `sendComposer` dropped the message when `activeChatId` was set but its `chatState` had not arrived yet (went the `newChat` route, which reused the same chat so the queued send never flushed); drafts now keyed by `app.activeChatId`; `useStreamedText` resubscribed every render; multi-line `Run` uses `sendText` (shell-integration `executeCommand` is single-command).
6. **Persistence** — chats restored from `workspaceState`, sessions resumed lazily with `resume`; 200-message / 20 kB caps verified by test. **Fixed:** restored tool rows with a stale `pending` edit (tracker no longer tracks the file) are reconciled to `kept` at startup; user message is posted to the UI before the rules appendix/session spawn.
7. **Edit tracker** — keep/undo/review per file/all, decorations + CodeLens per hunk, `kursor-orig:` provider, status bar all present. **Fixed:** Undo via editor CodeLens/title/`Ctrl+Shift+Backspace` labelled chat rows "Kept" → new `onDidResolve {path,status}` event (fired from every path that stops tracking a file) consumed by the manager.

### Files written/changed
`src/extension/chat/{runner,manager,state,views,index,commands,messages}.ts`, `chat/README.md` (new), `chat/__tests__/{runner.test,vscode-stub}.mjs` (new); `src/extension/edits/editTracker.ts`, `edits/README.md`; `src/webview/{store,deltaStore}.ts`, `webview/components/{InputBox,App}.tsx`, `webview/README.md`, `webview/__tests__/markdown.test.mjs` (new).

### Additive shared-file changes (exact)
- `src/extension/services.ts`: new `export interface EditResolution { path: string; status: 'kept' | 'undone' }`; `EditTracker` gains `readonly onDidResolve?: vscode.Event<EditResolution>`.
- `src/shared/protocol.ts`: `WebviewToHost` gains `| { type: 'focusChanged'; focused: boolean }`.

### Known gaps
- Not run in a live editor (no GUI); the event-sequence tests use a fake session modelled on the bridge README's observed wire order.
- Ctrl+I toggle degrades to "focus" if the webview never reports focus (e.g. a hidden retained view).
- `kursor.agent.notifyOnPermission` notification does not target the editor panel when only the panel is open (it reveals the side-bar view).
- The late-result heuristic after an interrupt assumes the CLI emits a `result` for the interrupted turn (as the bridge's turn counter also assumes); if it never does, the next real result is still handled correctly (only its error note would be suppressed once).

### Notes for the integrator
No `extension.ts`/`package.json` changes. IDE module's `recordChange('ide', …)` is unaffected by `onDidResolve`.
## [F] Kursor Settings — report

**Verification:** `npm run typecheck` → 0 errors (all three tsconfigs); `node esbuild.mjs` → `dist/settings.js` (1.1 MB) + `dist/settings.css` emitted; 12 pure-logic tests + 4 round-trips of generated `.mdc` files through module A's real `parseRuleFile` pass (`/tmp/claude-1000/-home-bruce-Work/b031e703-4140-497c-96c6-fda9fcef64c6/scratchpad/settings-test.mjs`). Note: the research files referenced in the task (`scratchpad/research/*.md`) no longer exist on disk; I worked from ARCHITECTURE.md, the manifest and the existing modules.

### Design
- **Host owns state; panel is a renderer.** `SettingsPanelController` (`panel.ts`) is the singleton `WebviewPanel` (`kursor.settings`, `retainContextWhenHidden`, `enableFindWidget`, serializer-restored with the last tab). On `ready` it posts one `state` snapshot (settings + Claude status + rules + workspace + about); afterwards it pushes `settings` (coalesced 50 ms on `onDidChangeConfiguration('kursor')`), `claudeStatus` (`bridge.onDidChangeStatus`, plus `status()` warm-up on open), `rules` (`rules.onDidChange`, generation-guarded against stale scans), `workspace` (`onDidChangeWorkspaceFolders`), `selectTab`, `toast`.
- **Writes are validated, global, optimistic.** `config.ts` has a typed `SETTING_SPECS` table (type/default/enum/min-max) for all 22 `kursor.*` keys; `coerceValue()` rejects or normalizes untrusted panel input; `writeValue()` → `ConfigurationTarget.Global` and reports when a workspace/folder override shadows it (toast + "Overridden in this workspace → open workspace setting" link in the UI). `readMeta()` pulls descriptions/enumDescriptions/minimum from `context.extension.packageJSON`, and `verifySpecsAgainstManifest()` logs a warning at activation if the table drifts from the manifest (it currently matches). "Reset to default" appears whenever a user value differs from the default.
- **Panel intents are allow-listed**: `runCommand` only for a fixed set of command ids, `openUrl` http(s) only, `openFile/openRule` only inside workspace folders or `$HOME`. Every message runs in try/catch → `log.error` + toast; failed writes re-send the real values so the optimistic UI snaps back.
- **Claude status card**: executable (tildified, Copy), version, account/plan, last-checked; buttons Sign in (`kursor.claude.login`, shown when not ok / not signed in), Re-check (`bridge.refreshStatus()` with spinner), Change path (settings UI at `kursor.claude.path`), Logs. Shows "Checking…" until the first probe completes.
- **`kursor.rules.new`**: folder pick (multi-root) → name → type QuickPick (Always / Auto Attached / Agent Requested / Manual, Cursor's four) → globs and/or description → unique `.cursor/rules/<slug>.mdc` with `description/globs/alwaysApply` front matter → opened with the first bullet selected. Manual rules deliberately get an empty description so the parser classifies them as manual.
- **Indexing**: open-or-create `.cursorignore` (commented template) and `.gitignore`; copy reflects what the tree actually does (ripgrep `--ignore-file .cursorignore` in `context/ripgrep.ts`).
- **UI** (React 18, `useSyncExternalStore` store): left nav (`role=tablist`, roving tabindex, arrow/Home/End keys, collapses to icons < 640 px) + content; `Toggle` (`role=switch`), card-style native radios, styled `<select>`, number/text fields with Enter/Esc, auto-growing textarea with debounced save + "Saving…/Saved", chip editor for disabled languages with datalist suggestions, model picker (presets opus/sonnet/haiku/fable + Default where allowed + custom id). `useDraft` keeps keystrokes safe from host echoes while a field is focused. All colours via `--vscode-*`.

### Files written
- `src/shared/settingsProtocol.ts` (new, mine)
- `src/extension/settings/{index,panel,config,workspace,rulesActions,html}.ts`, `README.md` (index.ts replaced the stub)
- `src/webview-settings/{main.tsx,vscode.ts,store.ts,hooks.ts,util.ts,styles.css}`, `components/{App,Nav,controls,ModelPicker,ClaudeStatusCard,Icon,Toasts}.tsx`, `components/tabs/{General,Agents,TabCompletions,Models,Rules,Indexing,About}.tsx`

### Shared-file changes
None. `package.json`, `services.ts`, `protocol.ts`, `claude/types.ts`, `extension.ts` untouched (both commands were already declared; `extension.ts` already calls `registerSettings`).

### Known gaps
- Not exercised in a live window (no GUI); `color-mix()` in badges needs Chromium ≥ 111 (fine for VSCodium 1.135).
- `kursor.settings.open` accepts an optional tab (`'rules'` or `{tab}`); nothing calls it with one yet.
- Rules list depends on `RulesService.listProjectRules` returning absolute paths (it does); nested-folder rules show their path relative to the selected folder.
- Settings written to Global only — a user who keeps `kursor.*` in workspace settings sees the override hint rather than an in-place edit.

### Integrator notes
- Chat's `openSettings` already runs `kursor.settings.open`. Other modules can deep-link: `executeCommand('kursor.settings.open', 'rules')`.
- `html.ts` links `dist/settings.css` when present (esbuild emits it from `styles.css`); `main.tsx` has the same self-linking fallback as the chat bundle.
- If a new `kursor.*` setting is added to `package.json`, add it to `SettingsValues`/`SETTING_KEYS` (protocol) and `SETTING_SPECS` (config.ts); the activation self-check will warn until that is done.
## [G] Report — product & desktop integration

**Design**
- `product/install.sh` orchestrates six steps, sourcing focused libs: `lib/common.sh` (constants, every path, logging, `confirm`), `lib/vscodium.sh` (fetch/verify/extract/rebrand/swap), `lib/desktop.sh` (wrapper, desktop entries, icons, MIME, seeds, headless extension install), `lib/omarchy.sh` (hook, Hyprland bind, default editor, and their reversal). `set -euo pipefail`, no sudo, nothing under `/usr`.
- Tarball: cached in `KURSOR_CACHE_DIR` (default `~/.cache/kursor`), sha256 checked against a pinned hash on every run (re-download on mismatch); other `KURSOR_VSCODIUM_VERSION`s use VSCodium's `.sha256` sidecar.
- Rebrand happens in a staging dir, then one rename swaps `~/.local/opt/kursor` (stale `.staging.*`/`.old.*` cleaned). `codium`→`kursor`, `bin/codium`→`bin/kursor` (launcher patched via literal bash substitution and asserted), `bin/codium-tunnel`, product.json identity fields via `jq` (version/commit/checksums/gallery untouched, verified with `jq -e`), package.json `name: Kursor` + `desktopName: kursor.desktop`, icon, shell completions, `kursor-install.json` marker. Help-menu URLs point at `KURSOR_REPO_URL` when set, otherwise are deleted (no git remote exists, so nothing is fabricated).
- Wrapper `~/.local/bin/kursor`: flags file, Wayland flags only under `WAYLAND_DISPLAY`, and no GUI flags for CLI-only invocations (`--version`, `--install-extension`…) — that avoided a VS Code "unknown option" warning found in testing.
- Idempotent: `settings.json`, `keybindings.json`, `argv.json`, flags file are written only when missing; `--with-icons` and the hook add single keys to JSONC `settings.json` with the same `sed` approach Omarchy uses.
- Hook mirrors `omarchy-theme-set-vscode` for Kursor paths; falls back to "Kursor Dark" instead of removing the key; respects `skip-kursor-theme-changes`; exits 0 when Kursor is absent.
- `--hypr-bind` appends one line tagged `-- kursor:install` (refuses to clobber an existing `SUPER + SHIFT + K`), reloads only when a Hyprland instance is live. `--default-editor` writes `kursor` to Omarchy's defaults file (session PATH includes `~/.local/bin`, verified).
- Theme: generated from `dark_vs` + `dark_plus` token chain (65 rules, semantic colors) with a hand-built 519-key Cursor-like palette.

**Files written** (all under `/home/bruce/Work/kursor/`): `product/install.sh`, `product/uninstall.sh`, `product/lib/{common,vscodium,desktop,omarchy}.sh`, `product/omarchy/kursor-theme.hook`, `product/defaults/{settings.json,keybindings.json,argv.json,kursor-flags.conf}`, `product/tools/keybindings-table.mjs`, `product/README.md`, `media/themes/kursor-dark.json`, `README.md`, `docs/USAGE.md`.

**Shared-file changes:** none (`package.json` already declared the theme).

**Verification**
- `npm run typecheck` 0 errors; `node esbuild.mjs` succeeds; theme JSON parses.
- Installer run 6× under isolated fake HOMEs (HOME + XDG_* overridden, `HYPRLAND_INSTANCE_SIGNATURE` unset, cached tarball reused, ~4–5 s): product/package.json rebrand verified with `jq`, launcher diff reviewed, `bin/kursor --version` → `1.135.06055`, desktop files pass `desktop-file-validate`, headless `--install-extension PKief.material-icon-theme` from Open VSX landed in `~/.kursor/extensions` (proves `dataFolderName`), re-runs preserved a user-edited `settings.json` and did not duplicate the bind/iconTheme. Hook tested for all four paths (descriptor, generated theme, fallback, skip toggle). Uninstall tested non-interactively (keeps config) and `--yes --purge` (clean); real `$HOME` confirmed untouched throughout.

**Known gaps**
- The research docs (`vscodium.md`, `omarchy.md`) were absent from the scratchpad; recipes were re-derived from the installed Omarchy scripts and the extracted tarball.
- `--install-extension dist/kursor.vsix` itself was not exercised (no vsix present; I didn't run `npm run package` in the shared tree) — the identical code path was validated with an Open VSX package.
- No live GUI launch (per instructions): Wayland app_id, icon rendering and the hook's live theme switch are unverified visually.
- Non-pinned-version checksum path and a "vsix missing" preflight were tested; a real re-download was not (cache always present).

**Notes for the integrator**
- Build order: `npm install && npm run package && bash product/install.sh`. Preflight fails fast with instructions if `dist/kursor.vsix` is missing.
- On this machine the current Omarchy theme has no `vscode.json`, so the hook selects the generated "Omarchy" theme after install; the summary reports the actual selected theme and how to keep Kursor Dark.
- Regenerate the README keybindings table after manifest changes: `node product/tools/keybindings-table.mjs --write`.
- Bumping VSCodium: edit the two pinned constants in `product/lib/common.sh` (documented in `product/README.md`).
## Integration report — Kursor

**Verification (final state):** `npm run typecheck` 0 errors (all 3 tsconfigs); `node esbuild.mjs` and `--production` OK; `npm run package` → `/home/bruce/Work/kursor/dist/kursor.vsix` **1,056,604 bytes (1.01 MB, 16 files)**; smoke loader `SMOKE: OK`.

### Fixes made (smallest correct changes; no `src/` files touched)
1. **`package.json`** — declared `kursor.tab.accepted` (D2 attached it to every completion item but never declared it) and hid it via `menus.commandPalette` `when:"false"`. Added `--no-rewrite-relative-links` to the `package` script: vsce 4 aborted on a relative README link because there is (deliberately) no repository URL.
2. **`README.md`** — the one link to `docs/USAGE.md` (not shipped in the vsix) is now plain text.
3. **`LICENSE`** (MIT, "Kursor contributors") added; **`.vscodeignore`** now also excludes `scripts/**` and `package-lock.json`.
4. **`scripts/smoke-load.mjs`** (new): intercepts `require('vscode')` via `Module._load` with a comprehensive stub (real `EventEmitter`/`Uri`/`Range`/`Position`/`Selection`/`WorkspaceEdit`, enums, config stub seeded with manifest defaults + `kursor.ide.enableServer=false`, in-memory mementos, fake webviews/panels/terminals/status bar; unknown API falls back to a recorded proxy). It activates `dist/extension.js`, compares registered `kursor.*` commands with commands/keybindings/menus, resolves the chat view (`resolveWebviewView` → HTML has `webview.js`/CSP nonce/codicon → posts `ready` → expects `appState`, then a `searchMentions` round-trip), opens the settings panel (`ready` → `state`), runs a few editor-less commands, then `deactivate()` + disposes all subscriptions and exits. Result: activation 121 ms, 75 subscriptions, **47 registered = 47 declared**, 0 log errors, **no stub fallbacks used**. Flags: `--verbose`, `--json`, `KURSOR_SMOKE_CONFIG`.
5. **`.vscode/launch.json` + `tasks.json`** (new): F5 against `code` (`--extensionDevelopmentPath`, `--disable-extensions`) and against `~/.local/opt/kursor/bin/kursor`; build/watch/typecheck/tests/package/install tasks with an inline esbuild problem matcher (no third-party matcher dependency).
6. **`docs/INTEGRATION.md`** (new): fixes, verified contracts, consolidated known gaps from all 8 reports, develop/install/debug guides, ordered risk list.

### Test results
- inline `diffBlocks.test.mjs`: 15/15 · chat `runner.test.mjs`: 11/11 · webview `markdown.test.mjs`: 23/23 · IDE `node --test` (pure + server): 14/14 · smoke: OK.
- vsix contents verified: `extension/dist/{extension.js,webview.js,webview.css,settings.js,settings.css,codicon.css,codicon.ttf}`, `media/kursor.svg`, `media/kursor-activity.svg`, `media/themes/kursor-dark.json` (parses; 519 colors, 65 tokenColors; manifest path `./media/themes/kursor-dark.json` matches), `product/icons/kursor-256.png`, `readme.md`, `LICENSE.txt`, `package.json`. No `node_modules`, `src`, `.map`, `scripts`, `package-lock`.
- `bash -n` passes for `product/install.sh`, `uninstall.sh`, `lib/*.sh`, `omarchy/kursor-theme.hook`; shellcheck is not installed on this machine (not run); installer not executed against the real HOME.

### Runtime risks to verify manually (ordered)
1. First real chat turn end-to-end (streaming, tool rows, permission card Run/Skip/Always, result/cost), then interrupt vs. send-now races.
2. Agent edits → EditTracker: inline decorations + CodeLens Keep/Undo, `kursor-orig:` review diff, Undo of a created file, checkpoint restore via `rewindFiles` (uses `userReplay` uuid; `user_message_uuid` is absent on CLI 2.1.263).
3. Ctrl+K vertical diff rendering (per-instance `after.contentText` on the red decoration type — fallback is per-line types), block/all accept-reject, Esc cancel, chat "Apply".
4. Keybinding collisions: `ctrl+k` shadows VS Code's Ctrl+K chords in the editor (Cursor-style; remapped to `ctrl+r …`); `ctrl+i`/`ctrl+l` vs built-in chat; `ctrl+enter` meanings in chat view vs editor.
5. Tab completions: latency/debounce, sanitizer on bracketed suffixes, status bar states, quota impact (Haiku one-shots).
6. Webview CSP in both the side-bar view and `kursor.chatPanel`: `data:` images, codicon font, image paste/drop.
7. Settings panel writes (Global target, override hint), "New Rule" → `.cursor/rules/*.mdc` picked up by the watcher.
8. IDE bridge with a real `claude` in the integrated terminal: lock-file discovery, `openDiff` title buttons (`resourceScheme == kursor-ide-right` clause), `selection_changed`/`at_mentioned`.
9. Installer on a live Omarchy session: Wayland `app_id`/icon, `--hypr-bind`, theme hook after `omarchy theme set`, Open VSX reachable from the rebranded `product.json`, `--install-extension dist/kursor.vsix` (only exercised with an Open VSX package so far).
10. Process hygiene: Claude child processes exit on chat close/window close, no stale `~/.claude/ide/*.lock`, Tab aborts in-flight one-shots.

Key files: `/home/bruce/Work/kursor/scripts/smoke-load.mjs`, `/home/bruce/Work/kursor/docs/INTEGRATION.md`, `/home/bruce/Work/kursor/.vscode/{launch,tasks}.json`, `/home/bruce/Work/kursor/LICENSE`, `/home/bruce/Work/kursor/dist/kursor.vsix`.
