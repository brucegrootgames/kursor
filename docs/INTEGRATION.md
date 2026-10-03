# Kursor — integration notes

Status after integrating modules A (Claude bridge + rules), B (chat host), C (chat webview), D1 (inline edit),
D2 (tab / terminal / scm / actions), E (IDE server), F (settings) and G (product / theme / docs).

| Check | Result |
| --- | --- |
| `npm run typecheck` (3 tsconfigs) | 0 errors |
| `node esbuild.mjs` / `node esbuild.mjs --production` | OK (extension.js 2.5 MB minified, webview.js 419 kB, settings.js 185 kB) |
| `node scripts/smoke-load.mjs` | OK — 47 `kursor.*` commands registered = 47 declared, no stub fallbacks, chat view + settings panel answer `ready` |
| `node src/extension/inline/__tests__/diffBlocks.test.mjs` | 15 passed |
| `node src/extension/chat/__tests__/runner.test.mjs` | 11 passed |
| `node src/webview/__tests__/markdown.test.mjs` | 23 passed |
| `node --test src/extension/ide/__tests__/*.test.mjs` | 14 passed |
| `npm run package` | `dist/kursor.vsix`, 1.01 MB, 16 files |
| `bash -n` on `product/**/*.sh` + the theme hook | OK (shellcheck not installed on this machine) |

## What the integrator changed

Every module's design was kept; the fixes below are the smallest ones that made the tree consistent.

1. **`package.json`** — declared the internal command `kursor.tab.accepted` (attached to every Tab completion item
   to count accepts; module D2 registered it without a manifest entry) and hid it from the palette with
   `menus.commandPalette` `when: "false"`. Added `--no-rewrite-relative-links` to the `package` script: vsce 4 refuses
   to package a README with relative links when no repository URL is known (we deliberately do not invent one).
2. **`README.md`** — the one relative link to `docs/USAGE.md` (which is not shipped inside the vsix) is now plain text.
3. **`LICENSE`** — MIT, "Kursor contributors" (the manifest already said `"license": "MIT"`).
4. **`.vscodeignore`** — also excludes `scripts/**` and `package-lock.json` from the vsix.
5. **`scripts/smoke-load.mjs`** (new) — loads `dist/extension.js` outside VS Code with a stubbed `vscode` module (see
   "How to debug" below).
6. **`.vscode/launch.json` + `tasks.json`** (new) — F5 configurations and build/test tasks.
7. **`docs/INTEGRATION.md`** — this file.

No source file under `src/` was changed by the integration pass: typecheck, build and all tests were already green,
and the manifest cross-check (commands ↔ `registerCommand`, keybindings, menus) found only the one undeclared command.

## Cross-module contracts — verified facts

- All 47 commands in `contributes.commands` are registered at activation; every keybinding and menu entry references
  a declared command. Context keys set at activation: `kursor.hasPendingEdits`, `kursor.chatRunning`,
  `kursor.inlineDiffVisible`, `kursor.inlineDiffResource`, `kursor.ide.viewingDiff` (plus `kursor.inlineEditInputFocus`
  and `kursor.inlineEditRunning` while Ctrl+K is active).
- Additive shared-file changes made by the module authors (all backwards compatible):
  - `claude/types.ts`: `SessionEvent.status.detail?`, `SessionEvent.result.queuedTurnCount?`,
    `ClaudeSession.setMode?()`, `OneShotRequest.thinking?`.
  - `services.ts`: `EditResolution` + `EditTracker.onDidResolve?`.
  - `shared/protocol.ts`: `WebviewToHost` `focusChanged`.
  - `package.json`: D1's four hidden inline-edit commands + keybindings, E's three `kursor.ide.*` commands and menus,
    the integrator's `kursor.tab.accepted`.
- Settings panel (F) self-checks its `SETTING_SPECS` table against the manifest at activation and logs a warning on
  drift — add new `kursor.*` settings in three places: `package.json`, `src/shared/settingsProtocol.ts`
  (`SettingsValues`/`SETTING_KEYS`) and `src/extension/settings/config.ts` (`SETTING_SPECS`).

## Known gaps (collected from all module reports)

**Not verified in a live editor** — no module author launched a GUI. Everything below the API surface is exercised
only by node tests and the smoke loader.

- **A — bridge**: `assistant.message.user_message_uuid` is absent on Claude Code 2.1.263; checkpoints use the
  `userReplay` uuid (the chat does this). Thinking deltas arrive empty (signature only); `thinkingProgress` carries
  token estimates. With `bypassPermissions` + `canUseTool` the SDK prints a harmless
  `CLAUDE_SDK_CAN_USE_TOOL_SHADOWED` warning.
- **B — chat host**: the Ctrl+I toggle degrades to "focus" if the webview never reports focus (hidden retained
  view). `kursor.agent.notifyOnPermission` reveals the side-bar view even when only the editor panel is open. The
  late-result heuristic after an interrupt assumes the CLI emits a `result` for the interrupted turn.
- **C — webview**: multi-line "Run" from a code fence uses `sendText` (shell-integration `executeCommand` is
  single-command).
- **D1 — inline edit**: per-instance `after.contentText` on the red placeholder decoration type is standard API but
  untested live; if ghost text does not render, switch `DiffDecorations.render` to per-line decoration types. Saving
  while a diff is visible saves the empty placeholder lines (same as Continue). Fragment "fast apply" costs one model
  call.
- **D2 — tab/terminal/scm/actions**: ghost-text quality depends on Haiku honouring the FIM prompt; the sanitizer's
  bracket heuristic is string/comment-unaware. SCM progress is not user-cancellable (120 s timeout). The `scm/title`
  argument shape (`SourceControl`) is assumed.
- **E — IDE server**: no `executeCode` tool. If the Accept/Reject title buttons never appear in the proposal diff,
  drop the `resourceScheme == kursor-ide-right` clause from the `editor/title` `when`. Accepted proposals are
  recorded in the EditTracker before the CLI writes the file.
- **F — settings**: `color-mix()` needs Chromium ≥ 111 (fine for VSCodium 1.135). Settings are written to the
  Global target only; a workspace override shows a hint instead of being edited in place.
- **G — product**: `--install-extension dist/kursor.vsix` was exercised with an Open VSX package, not with the
  Kursor vsix itself (it did not exist yet); a real re-download of the VSCodium tarball was not exercised (cache was
  always present). Wayland `app_id`, icon rendering and the live theme switch are unverified visually. On this
  machine the current Omarchy theme has no `vscode.json`, so the hook selects the generated "Omarchy" theme after
  install.
- **Smoke loader**: a stubbed `vscode` cannot catch wrong `when` clauses, CSS/webview rendering issues, or
  behaviour that needs real editors/terminals.

## How to develop

Prerequisites: Node ≥ 20, `npm install` once (the Agent SDK, React, ws, MCP SDK, codicons… are all local
dependencies; the extension never uses the SDK's bundled Claude binary — it spawns the user's own `claude`).

```bash
npm run typecheck            # tsc for extension + both webviews
node esbuild.mjs             # dev bundles with source maps → dist/
node esbuild.mjs --watch     # rebuild on change
node scripts/smoke-load.mjs  # load dist/extension.js with a fake vscode, cross-check the manifest
node src/extension/inline/__tests__/diffBlocks.test.mjs
node src/extension/chat/__tests__/runner.test.mjs
node src/webview/__tests__/markdown.test.mjs
node --test src/extension/ide/__tests__/*.test.mjs
npm run package              # typecheck + production build + dist/kursor.vsix
```

### F5 (Extension Development Host)

`.vscode/launch.json` has three configurations; each runs the `kursor: build` task first (`.vscode/tasks.json`):

- **Run Extension (code)** — launches the `code` binary on `PATH` (VS Code or VSCodium) with
  `--extensionDevelopmentPath=<repo> --disable-extensions`, opening the repo as the workspace.
- **Run Extension (kursor)** — same, but with the rebranded binary installed by the installer:
  `~/.local/opt/kursor/bin/kursor`. Requires `bash product/install.sh` to have run once. The dev host then uses the
  Kursor user-data dir (`~/.config/Kursor`) and extensions dir (`~/.kursor/extensions`), so the packaged Kursor
  extension is replaced by the development copy for that window only.
- **Watch + Run Extension (code)** — runs `node esbuild.mjs --watch` as the pre-launch task; reload the dev host
  (Ctrl+R in the dev window) after each rebuild.

From a terminal the equivalent is:

```bash
node esbuild.mjs && code --extensionDevelopmentPath="$PWD" --disable-extensions "$PWD"
# or, against the rebranded build:
node esbuild.mjs && ~/.local/opt/kursor/bin/kursor --extensionDevelopmentPath="$PWD" "$PWD"
```

Webview bundles (`dist/webview.js`, `dist/settings.js`) are re-read every time a view is created; reload the dev
window to pick up extension-host changes.

## How to install

```bash
npm install
npm run package                  # → dist/kursor.vsix
bash product/install.sh          # VSCodium 1.135.06055 → ~/.local/opt/kursor, wrapper, desktop entries, theme hook
```

The installer is idempotent and never needs sudo (nothing under `/usr`). Flags: `--no-extension`, `--no-omarchy`,
`--with-icons PKief.material-icon-theme`, `--hypr-bind` (adds `SUPER + SHIFT + K` to `~/.config/hypr/bindings.lua`),
`--default-editor` (Omarchy default editor = `kursor`). Env: `KURSOR_CACHE_DIR`, `KURSOR_VSCODIUM_VERSION`,
`KURSOR_REPO_URL`. To test without touching the real home see `product/README.md` ("Testing without touching your
real home"). `bash product/uninstall.sh [--yes] [--purge]` reverses everything.

Re-installing only the extension into an existing Kursor: `~/.local/opt/kursor/bin/kursor --install-extension
dist/kursor.vsix --force`.

## How to debug

- **Kursor output channel** — `View → Output → Kursor` (or the command *Kursor: Show Kursor Logs*,
  `kursor.showLogs`; also in the chat view's `…` menu). It is a `LogOutputChannel`: set the level with the
  channel's gear or `Developer: Set Log Level… → Kursor` (`Debug` shows every bridge event, tool call, IDE server
  request and Tab decision; `Trace` adds the CLI's stderr). Each module logs under its own prefix
  (`[claude]`, `[chat]`, `[edits]`, `[inline]`, `[tab]`, `[terminal]`, `[scm]`, `[actions]`, `[settings]`, `[ide]`).
- **Claude Code status** — *Kursor: Claude Code Status* (`kursor.claude.status`) re-probes `claude --version` and
  `claude auth status --json` and shows the resolved path. Override the binary with `kursor.claude.path`. The
  resolution order is setting → login-shell `PATH` → `~/.local/bin/claude` → mise shim → process `PATH`.
- **Sign-in** — *Kursor: Sign in to Claude Code* opens a terminal running `claude auth login`; status is re-probed
  when that terminal closes.
- **Webviews** — `Developer: Open Webview Developer Tools` for the chat / settings panels (both post `log` messages
  to the host, which land in the Kursor channel).
- **IDE bridge** — with `kursor.ide.enableServer` on, the lock file is `~/.claude/ide/<port>.lock` and new
  integrated terminals get `CLAUDE_CODE_SSE_PORT`; `claude` started in such a terminal shows "IDE: Kursor" in `/ide`.
- **Headless smoke** — `node scripts/smoke-load.mjs --verbose` prints every log line produced during activation,
  the registered commands vs the manifest, context keys and any thrown error; `--json` for machine-readable output;
  `KURSOR_SMOKE_CONFIG='{"kursor.claude.path":"/x"}'` overrides settings. It disables the IDE server and creates no
  files outside a temp workspace.
- **Pure-logic tests** — see the commands above; each test bundles its TypeScript sources with esbuild into a temp
  dir, so they need no build step.

## Runtime risks to verify manually (ordered)

1. **First real chat turn end-to-end** (bridge → runner → webview): streaming text, tool rows, permission card
   Run/Skip/Always, `result` cost line; then interrupt and "send now" races.
2. **Agent edits → EditTracker**: inline decorations + CodeLens Keep/Undo, review diff (`kursor-orig:`), Undo of a
   newly created file, badge/status bar; "Restore checkpoint" (`rewindFiles`) on a user message.
3. **Ctrl+K inline edit**: red/green vertical diff rendering (per-instance `after.contentText`), Accept/Reject
   per block and all, Esc cancel, follow-up Ctrl+K on a visible diff, "Apply" from a chat code fence.
4. **Keybinding collisions**: `ctrl+k` in the editor shadows VS Code's Ctrl+K chords (Cursor does the same and the
   manifest remaps the common ones to `ctrl+r …`); `ctrl+i`/`ctrl+l` vs built-in chat (`chat.disableAIFeatures` is
   on by default); `ctrl+enter` in the chat view (keep-all vs send-now) and in the editor (accept-all).
5. **Tab completions**: latency/debounce feel, sanitizer behaviour on bracketed suffixes, status bar states,
   quota impact (each request is a Haiku one-shot).
6. **Webview CSP**: images (`data:`), codicon font, highlight.js styles, paste/drop of images in both the side-bar
   view and the editor panel (`kursor.chatPanel`).
7. **Settings panel**: writes land in Global settings; override hint when a workspace value exists; "New Rule"
   creates `.cursor/rules/<slug>.mdc` that the rules scanner picks up (watcher).
8. **IDE bridge with a real `claude` in the integrated terminal**: lock-file discovery, `openDiff` accept/reject
   buttons (the `resourceScheme == kursor-ide-right` clause), `selection_changed`, `at_mentioned`.
9. **Installer on a real Omarchy session**: Wayland `app_id`/icon, desktop entry, `--hypr-bind`, theme hook after
   `omarchy theme set`, Open VSX gallery reachable from the rebranded `product.json`.
10. **Process hygiene**: Claude Code child processes exit on window close / chat close / `deactivate`; no stale
    `~/.claude/ide/*.lock` after quitting; Tab aborts outstanding one-shots on cancel.

## Verified live on Omarchy (2026-10-03)

Driven through Chrome DevTools Protocol against the installed, rebranded build (`kursor --remote-debugging-port=9222`):

- Install: `product/install.sh` → `~/.local/opt/kursor`, wrapper, desktop entries, icons, Omarchy theme hook; window class/app_id `kursor`; Help › About shows Kursor 1.135.06055.
- Activation: extension activates in ~130 ms, finds the mise `claude` via the login shell, reports signed in (Max), IDE bridge lock file written to `~/.claude/ide/`.
- Chat: agent turn with Read + Edit tools streamed into the pane; Edited row with +N/−M and Review/Undo/Keep; review bar and status-bar "1 file · Review"; **Undo All** reverted the file and marked the row "Undone"; chat persisted and restored across a restart; history view lists sessions.
- Permissions: a non-read-only shell command produced the "Needs approval" card (Run Ctrl+⏎ / Skip / Always allow ▾); Run executed it and the output + reply rendered. Read-only commands such as `ls` are auto-approved by Claude Code itself (no card).
- Ctrl+K: QuickPick prompt ("Edit math.ts:1"), status-bar spinner, green/red vertical diff with ✓ Accept / ✗ Reject CodeLens, Ctrl+Enter accepted.
- Tab: ghost text appeared ~5 s after typing a function header (Haiku); Tab accepted it.
- Settings: Ctrl+Shift+J opens the Kursor Settings tab (account card, editor shortcuts, theme).

Fixed from these runs: first-launch blank chat pane (ready watchdog reloads the webview HTML once), narrow-pane layout (tool rows, review bar, permission badge), editor-title Keep/Undo only on files with pending edits (`resourcePath in kursor.pendingEditPaths`), workspace-trust support (`capabilities.untrustedWorkspaces: limited`; agent/Ctrl+K/Tab wait for trust), `sharedDataFolderName` rebrand.
