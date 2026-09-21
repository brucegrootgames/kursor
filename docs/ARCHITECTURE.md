# Kursor — architecture & implementation brief

Kursor is a Cursor clone: a rebranded VSCodium plus this VS Code extension. Every AI feature is powered by the
**Claude Code CLI already installed on the user's machine** (`~/.local/bin/claude`, currently 2.1.263, signed in with
the user's own Claude Max login). We never touch credentials: we spawn the unmodified `claude` binary and it uses its
own auth. Target platform: Omarchy (Arch Linux + Hyprland, Wayland).

Research reports (read the ones relevant to your module — they contain verified facts, exact API shapes and code
excerpts; they are authoritative over memory):

- `/tmp/claude-1000/-home-bruce-Work/b031e703-4140-497c-96c6-fda9fcef64c6/scratchpad/research/cursor-spec.md` — what Cursor does (features, keybindings, UI).
- `/tmp/claude-1000/-home-bruce-Work/b031e703-4140-497c-96c6-fda9fcef64c6/scratchpad/research/vscode-api.md` — VS Code 1.13x extension API facts (verified against vscode.d.ts and the local bundle).
- `/tmp/claude-1000/-home-bruce-Work/b031e703-4140-497c-96c6-fda9fcef64c6/scratchpad/research/reference-impls.md` — how Continue/Cline/Roo/the official Claude Code extension implement inline diffs, checkpoints, terminal capture, @-mentions, markdown.
- `/tmp/claude-1000/-home-bruce-Work/b031e703-4140-497c-96c6-fda9fcef64c6/scratchpad/research/all-results.md` lines 4124–4989 — **Claude Code CLI + Agent SDK ground truth**: real stream-json output, SDK `Options`/`Query`/`SDKMessage`/hook types (verbatim from sdk.d.ts 0.3.278), `canUseTool` shapes, latency numbers, legal notes. The raw probe files are in `.../scratchpad/research/cli-probe/` and the SDK's `sdk.d.ts` is at `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` in this repo.
- `/tmp/claude-1000/-home-bruce-Work/b031e703-4140-497c-96c6-fda9fcef64c6/scratchpad/research/omarchy.md` and `vscodium.md` — desktop/product integration (product agent).

## Branding / compliance (non-negotiable)

- Product name is **Kursor**. Never name anything "Claude Code" or "Claude" as a product/feature name. UI copy may say, in plain text, "powered by the Claude Code CLI installed on your machine".
- We spawn the user's own unmodified `claude` binary; the extension never reads, stores or forwards tokens/credentials. If the CLI is not signed in, show a "Sign in" action that runs `claude auth login` in a terminal (`kursor.claude.login`).
- Tab completions burn the user's subscription window: keep them debounced and cheap (Haiku, tiny prompts).

## Repo layout & ownership

```
package.json                     manifest: ALL commands/keybindings/menus/settings are declared here (shared, do not remove entries)
esbuild.mjs                      builds dist/extension.js (node cjs), dist/webview.js + dist/settings.js (browser iife)
src/shared/protocol.ts           host <-> chat webview contract (shared)
src/extension/services.ts        cross-module interfaces: RulesService, EditTracker, ChatController, *Deps (shared)
src/extension/claude/types.ts    ClaudeBridge / ClaudeSession / SessionEvent contract (shared)
src/extension/extension.ts       wiring (shared)
src/extension/util/log.ts        Logger (shared)
src/extension/claude/**          [A] bridge over @anthropic-ai/claude-agent-sdk → user's claude binary
src/extension/rules/**           [A] Cursor rules (.cursor/rules/*.mdc, .cursorrules, AGENTS.md, user rules)
src/extension/chat/**            [B] chat view host: sessions, prompt composition, permissions, history, export, commands
src/extension/context/**         [B] @-mention search (ripgrep), problems/git/terminal/selection context providers, terminal output capture
src/extension/edits/**           [B] EditTracker: agent edit snapshots, Keep/Undo/Review, inline decorations + CodeLens, kursor.edits.* commands
src/webview/**                   [C] React chat UI (dist/webview.js)
src/extension/inline/**          [D1] Ctrl+K inline edit: vertical red/green diff engine, CodeLens accept/reject, prompt UI, apply-from-chat
src/extension/tab/**             [D2] Tab ghost-text completions + status bar item
src/extension/terminal/**        [D2] Ctrl+K in terminal (generate command)
src/extension/scm/**             [D2] commit message generation
src/extension/actions/**         [D2] lightbulb code actions (Fix in Chat / Add to Chat / Explain)
src/extension/settings/**        [F] "Kursor Settings" webview panel host
src/webview-settings/**          [F] settings panel UI (dist/settings.js)
src/extension/ide/**             [E] IDE bridge for a `claude` running in the integrated terminal (~/.claude/ide/<port>.lock, ws MCP server)
media/**                         icons, media/themes/kursor-dark.json [G]
product/**                       [G] installer: VSCodium download/rebrand, wrapper, desktop entry, Omarchy theme hook, default settings/keybindings
README.md, docs/**               [G] user docs
```

Rules for every agent:

1. Only create/edit files in the paths you own. Shared files (`package.json`, `src/shared/protocol.ts`, `services.ts`,
   `claude/types.ts`, `extension.ts`) may receive **additive, backwards-compatible** changes only (new optional
   fields, new commands) — list every such change in your final report. Never rename/remove existing members.
2. `npm run typecheck` and `npm run build` must pass for your files when you finish (other agents' stubs may still
   throw at runtime — that is expected; do not "fix" other modules).
3. TypeScript strict, no `any` leaking across module boundaries, `import * as vscode from 'vscode'`, Node 20 APIs.
   Only stable VS Code API (`@types/vscode` 1.100; no proposed APIs). Dependencies available: the Agent SDK,
   `diff` (jsdiff), `marked`, `highlight.js`, `react`/`react-dom` 18, `@vscode/codicons`, `ws`, `@modelcontextprotocol/sdk`,
   `zod`. Do not add dependencies.
4. Every command handler: `try/catch` → `log.error` + `vscode.window.showErrorMessage`. Never let a promise rejection
   escape an event handler. Everything disposable goes into `context.subscriptions`.
5. Log through the `Logger` you receive (`deps.log`); never `console.log` in the extension host.
6. Do not launch a GUI editor and do not run `claude` interactively. Running `claude -p …` or the SDK from a node script
   for a quick verification is fine (a few calls at most — each costs the user's subscription quota).
7. Write a short module README (`src/extension/<module>/README.md` or a header comment) describing the design, and end
   your report with: files written, shared-file changes, known gaps.

## Product decisions (from research)

- Chat lives in the **secondary side bar** (`contributes.viewsContainers.secondarySidebar`, view id `kursor.chat`).
  `workbench.view.extension.kursor` opens the container; `kursor.chat.focus` focuses the view.
- Modes (Cursor): **Agent** (edits + commands; Claude Code permission mode from `kursor.agent.permissionMode`, default
  `acceptEdits` = edits auto-applied, terminal commands prompt), **Ask** (read-only: disallow `Edit`, `Write`,
  `NotebookEdit`; commands prompt), **Plan** (Claude Code native `plan` permission mode; the `ExitPlanMode` approval
  is rendered as a plan card with **Build** / **Reject**).
- Permission prompts (`canUseTool`) are rendered as inline cards: **Run / Skip / Always allow…** (terminal), or
  **Allow / Deny** for other tools; `AskUserQuestion` becomes a question card; both block the turn until answered.
- Agent edits are applied to disk by Claude Code. We snapshot before/after via hooks and offer **Keep / Undo / Review**
  per file and for all files (Cursor's Inline Diffs + Review bar). "Restore checkpoint" on a user message calls Claude
  Code's `rewindFiles(userMessageUuid)` (files only; conversation is kept, like Cursor).
- Ctrl+K inline edit: Continue-style in-place vertical diff (red placeholder lines + green lines + CodeLens
  Accept/Reject per block, Ctrl+Enter / Ctrl+Backspace for all).
- Tab: `InlineCompletionItemProvider` ghost text, debounced (`kursor.tab.debounceMs`), Haiku by default, cancellable.
  A fresh CLI round trip is ≈2.5 s, so never fire per keystroke.
- Keybindings, commands, settings: see `package.json` (authoritative). Context keys we set with `setContext`:
  `kursor.chatRunning`, `kursor.hasPendingEdits`, `kursor.inlineDiffVisible`, `kursor.inlineDiffResource` (fsPath),
  `kursor.inlineEditInputFocus`.

## Contracts

Read these files in full before writing code: `src/shared/protocol.ts`, `src/extension/claude/types.ts`,
`src/extension/services.ts`, `src/extension/extension.ts`, `package.json`.

## Module specs

### [A] `claude/bridge.ts` — ClaudeBridge (+ `rules/rules.ts`)

- `import { query } from '@anthropic-ai/claude-agent-sdk'` (types from `sdk.d.ts`; esbuild bundles it into CJS — already
  verified). Always pass `pathToClaudeCodeExecutable` = resolved user binary. Resolution order: setting
  `kursor.claude.path` → `$SHELL -lic 'command -v claude'` (login shell, 5 s timeout, cache result) →
  `~/.local/bin/claude` → `~/.local/share/mise/shims/claude` → `which claude` in process env. Never fall back to the
  SDK's bundled binary silently (it is not packaged in the .vsix); if nothing is found, `status()` returns `ok:false`
  with a helpful error.
- `status()`: run `<claude> --version` and `<claude> auth status --json` (fields: `loggedIn`, `email`,
  `subscriptionType`, `authMethod`); cache 60 s; `refreshStatus()` forces.
- `createSession()` spawns ONE long-lived process per chat using **streaming input** (`prompt` = an async generator
  fed by an internal queue; `send()` pushes `{type:'user', message:{role:'user', content:[{type:'text',text}, images…]},
  parent_tool_use_id:null}`; keep the generator open until `dispose()`). Options: `cwd`, `permissionMode`, `model`,
  `effort`, `resume`, `includePartialMessages: true`, `enableFileCheckpointing: true`,
  `settingSources: ['user','project','local']`, `systemPrompt: {type:'preset', preset:'claude_code', append}`,
  `additionalDirectories`, `abortController`, `stderr: (d) => log.debug(d)`, `env: {...process.env}` (SDK `env`
  REPLACES the child env; delete `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`), `canUseTool`, `hooks`.
  Mode mapping: ask → `disallowedTools: ['Edit','Write','NotebookEdit']` and permissionMode `default`; plan →
  permissionMode `plan`; agent → configured permission mode (`bypassPermissions` also needs
  `allowDangerouslySkipPermissions: true`).
- Events: translate every `SDKMessage` into `SessionEvent`s exactly as typed in `claude/types.ts`. Observed order:
  `system/init` → `stream_event`s (`content_block_start/delta/stop`) → complete `assistant` block (emitted BEFORE
  `content_block_stop`) → `user` tool_result (`content` may be a string or array of blocks; flatten text; `is_error`)
  → `result`. `assistant.message.user_message_uuid` and `SDKUserMessageReplay.uuid` give the user-turn uuid for
  checkpoints; if replays don't arrive, add `extraArgs: {'replay-user-messages': null}`. Map `rate_limit_event`
  (`unifiedWindows.five_hour.utilization`), `system/status`, `system/permission_denied`, `system/thinking_tokens`,
  `system/compact_boundary`, `system/task_started|task_progress`, `system/api_retry` (→ status), errors.
- `canUseTool(toolName, input, {suggestions, description, title, blockedPath, decisionReason, toolUseID, requestId, signal})`:
  emit `permissionRequest` (kind: `AskUserQuestion` → 'question' with `questions` parsed from `input.questions`;
  `ExitPlanMode` → 'plan' with `plan = input.plan`; else 'tool'); build human labels for `suggestions`
  (e.g. `setMode acceptEdits` → "Always apply edits this session", `addRules Bash(npm test *)` → "Always allow `npm test`…").
  Resolve with the pending promise when `respondPermission()` is called: allow → `{behavior:'allow', updatedInput: input,
  updatedPermissions: suggestionIndex !== undefined ? [suggestions[i]] : undefined}`; question → `{behavior:'allow',
  updatedInput: {questions: input.questions, answers}}`; plan build → allow; deny → `{behavior:'deny', message}`.
  Honour `signal` (abort → resolve deny). A request left unanswered when the session is disposed must be denied.
- Hooks: `PreToolUse` matcher `Edit|Write|NotebookEdit` → read the file (`fs.readFile`, null if missing) keyed by
  `tool_use_id`; `PostToolUse` same matcher → read after → emit `fileChanged`. Return `{}` (continue) from hooks;
  never block. Also emit `fileChanged` for `PostToolUseFailure`? No — drop the snapshot.
- Process lifecycle: if the process exits unexpectedly, emit `error` (fatal) + `exit`; the next `send()` transparently
  recreates the process with `resume: sessionId`. `interrupt()` → `query.interrupt()`. `dispose()` → end input,
  abort, SIGTERM.
- `oneShot()`: `query({prompt, options:{systemPrompt (string), tools: [], maxTurns: 1, persistSession: false,
  settingSources: [], permissionMode:'default', permissionPrompts:'none', model, cwd, includePartialMessages: !!onDelta,
  abortController}})`; stream `text_delta`s to `onDelta`; return the final text; throw on `result.is_error`.
- History: use the SDK exports (`listSessions`, `getSessionMessages`, `deleteSession` — check their signatures in
  `sdk.d.ts`); fall back to reading `~/.claude/projects/<cwd with '/' → '-'>/*.jsonl`.
- `rules/rules.ts`: parse `.cursor/rules/*.mdc` front matter (`description`, `globs` comma-separated, `alwaysApply`),
  `.cursorrules` (legacy, treated as always), root `AGENTS.md` (always). User rules from `kursor.rules.user`.
  `buildAppendix(cwd, contextPaths)` → markdown: "# User rules", "# Project rules (always)", auto rules whose globs
  match any context path, and an index of description/manual rules ("Read `<path>` when relevant"). Cap at 60k chars.
  Watch with `FileSystemWatcher` and fire `onDidChange`.

### [B] `chat/**`, `context/**`, `edits/**` — chat host

- `ChatViewProvider` for `kursor.chat` (`retainContextWhenHidden: true`), CSP with nonce, loads `dist/webview.js`,
  `dist/codicon.css` (font-src cspSource). Also `kursor.chat.openInEditor` → a `WebviewPanel` (viewType
  `kursor.chatPanel`) hosting the same UI; both views share one `ChatStore`.
- `ChatStore`: chats (`ChatState`), active chat, per-chat `ClaudeSession` (created lazily on first send with
  `cwd` = workspace folder of the active file or first folder; `appendSystemPrompt` = rules appendix + a short
  "You are running inside the Kursor editor…" note). Persist chats (messages capped to last 200, tool outputs capped
  to 20 kB) in `context.workspaceState`; on reload, sessions are re-created with `resume`.
- Prompt composition for `send`: user text, then for each attachment: files/folders → "Attached: `relPath`" (Claude reads
  them with its tools), selection/diagnostic/problems/terminal/git → the text inside fenced blocks with a heading;
  images → content blocks; when `kursor.agent.attachOpenFile` → append "Active file: `relPath` (cursor at L{n},
  selection L{a}-{b})". Slash commands typed by the user (`/review …`) are passed through verbatim (Claude Code
  expands them).
- Streaming: on `blockDelta` (text/thinking) post `textDelta`; on `assistantBlock`/`toolResult`/permission/result
  post full `chatState`. Coalesce `chatState` posts with a 50 ms throttle. `tool` blocks: create on `blockStart`
  (tool_use) with `inputStreaming`, finalize on `assistantBlock`, attach output on `toolResult` (cap 20 kB, mark
  truncated), attach `edit` summary on `fileChanged` (via `edits.recordChange` and `EditTracker.pending`).
  `TodoWrite` tool → `todo` block.
- Queue semantics: `send` while running → message appended with `queued: true`, then `session.send()` (Claude Code
  queues it); clear `queued` on `userReplay`. `sendNow` → `interrupt()` then send.
- Permission/question/plan cards → `session.respondPermission`. When a permission arrives and the view is not
  visible: set `webviewView.badge` and, if `kursor.agent.notifyOnPermission`, `showInformationMessage` with "Open".
- Checkpoint restore: confirm (modal) → `session.rewindFiles(uuid)` → `edits.clear(chatId)` → system note.
- Commands: all `kursor.chat.*` from `package.json`. `kursor.chat.open` toggles: if the view is visible and focused,
  `workbench.action.closeAuxiliaryBar`; else `kursor.chat.focus`. `addSelectionToNewChat` (Ctrl+L): with a selection
  → new chat + selection attachment; without → same as open. `addSelectionToChat` (Ctrl+Shift+L) → attachment on the
  active chat. `fixDiagnostic(uri, diagnostic)` → sendPrompt "Fix this problem: …" with a `diagnostic` attachment.
  `addTerminalSelection` → `workbench.action.terminal.copySelection` then clipboard (restore the previous clipboard).
  `debugTerminal` → `workbench.action.terminal.copyLastCommandAndLastCommandOutput` → sendPrompt "Debug this…".
  `exportChat` → save dialog → markdown transcript.
- `context/mentions.ts`: file list via ripgrep (`vscode.env.appRoot/node_modules/@vscode/ripgrep/bin/rg` or
  `/usr/bin/rg`, `--files --follow --hidden -g !**/node_modules/** -g !**/.git/** …`, respect `.cursorignore` and
  `.gitignore` via rg defaults), cache per workspace, refresh on file events (throttled 5 s), fuzzy score (write a
  small scorer: subsequence match with bonuses for path-boundary/camelCase, prefer shorter), limit 30. Empty query →
  categories (Files & Folders, Code, Problems, Terminal, Git, Web, Docs, Rules) + open files. `/` query → slash commands
  from `AppState.commands`. `context/terminalCapture.ts`: track shell executions (`onDidStartTerminalShellExecution`
  → `read()`), keep the last 64 kB per terminal (strip ANSI), expose `lastOutput(terminal?)`.
- `edits/editTracker.ts`: model per file `{base, current, chatId, toolUseIds, isNew}`; stats with jsdiff
  `diffLines`; `keep` → forget; `undo` → restore base (WorkspaceEdit if the doc is open, else `workspace.fs`; delete if
  `isNew`); `review(path)` → `vscode.diff(Uri kursor-orig:<fsPath>?v=N, file uri, "name (Original ↔ Kursor)")` with a
  `TextDocumentContentProvider`; `review()` (all) → `vscode.changes("Kursor edits", [[fileUri, origUri, fileUri]…])`.
  Inline diffs (`kursor.agent.inlineDiffs`): whole-line decorations (`ThemeColor('kursor.addedLineBackground')`) on
  added lines from `structuredPatch(base, current, {context:0})`, CodeLens "Keep · Undo" per hunk
  (`kursor.edits.keepHunk/undoHunk` with `[fsPath, hunkIndex]`), refresh on document change (recompute against base).
  Register all `kursor.edits.*` commands here; set `kursor.hasPendingEdits`; status bar item
  `$(diff-multiple) N files · Review` while pending.

### [C] `src/webview/**` — chat UI (React 18, esbuild iife, CSS in `src/webview/styles.css` imported from main.tsx)

Match Cursor's Agent pane (see cursor-spec.md §3.1): header (compact tab strip of open chats when > 1, title
otherwise), message list, sticky review bar, input box. Theme everything with `--vscode-*` variables (sideBar
background, foreground, editor font for code, `--vscode-textLink-foreground`, `--vscode-input-*`,
`--vscode-button-*`, `--vscode-badge-*`, `--vscode-diffEditor-inserted/removedTextBackground`,
`--vscode-focusBorder`); detect light/dark via `body.vscode-light`. Icons: codicons (`<i class="codicon codicon-…">`).

- User message: bubble with attachment pills, hover → "Restore checkpoint" (when `canRestore`) and copy; `queued` badge.
- Assistant message: markdown (`marked` + `highlight.js`, sanitize: escape raw HTML), streaming cursor; code fences get
  a toolbar: language, **Copy**, **Apply** (→ `codeAction apply` with path parsed from fence meta like ```` ```ts path/to.ts ````),
  **Insert at cursor**, **Run** (shell languages → `codeAction run`); fence meta path → clickable.
- Thinking block: collapsible "Thinking…" pill with elapsed seconds; hidden when `settings.showThinking` is false.
- Tool rows (collapsible, density from `settings.toolCallDensity`): Read → `$(file) Read <relPath>`; Glob/Grep → "Searched
  for `pattern`" (+ result count); Bash → "Ran `command`" with a console box for output (monospace, max-height,
  auto-scroll while running); Edit/Write/NotebookEdit → "Edited `<relPath>`" / "Created" with `+N −M` and per-row
  **Review · Undo · Keep** (only while `edit.status === 'pending'`); Task → "Subagent: description" with status;
  WebSearch/WebFetch → "Searched the web …" / "Fetched url"; TodoWrite → checklist card; unknown → name + JSON.
  Status icons: spinner (running), check, error, "denied".
- Permission card (Cursor terminal card): shows command / tool + description; buttons **Run** (Ctrl+Enter),
  **Skip**, and an **Always allow ▾** menu built from `suggestions`; once decided, collapse to a one-line status.
  Question card: options as buttons (multi-select → checkboxes + Submit) plus a free-text "Other". Plan card: rendered
  markdown plan with **Build** and **Reject** (+ optional feedback textbox).
- Review bar (sticky above input while `pendingEdits.length > 0`): "N files · Review · Undo All · Keep All".
- Input: auto-growing textarea; `@` opens the mention popover (host search via `searchMentions`, keyboard nav,
  Enter/Tab select, Esc close; selecting a category drills in), `/` opens the slash-command popover; attachments
  as removable pills above the text; paste/drag images → `image` attachments (read as base64); bottom toolbar: `@`
  button, image button, mode dropdown (Agent / Ask / Plan; **Ctrl+.** and **Shift+Tab** cycle), model dropdown
  (with effort submenu when supported; **Ctrl+/** cycles), context ring (percent, tooltip breakdown), send button
  that becomes **Stop** while running. Enter sends (Shift+Enter newline); Ctrl+Enter = send now (bypass queue);
  Esc blurs; while running Enter queues.
- Empty state: Kursor logo + hints ("Ctrl+K to edit code, Tab to complete, @ to add context"), and when
  `claude.ready` is false an error/sign-in panel with a "Sign in" button (`runCommand kursor.claude.login`) and
  "Set path" (`runCommand workbench.action.openSettings kursor.claude.path`).
- History view (toggled by `showHistory`/header button): list of `HistoryEntry` with resume/delete; search box.
- Persist UI-only state with `vscode.setState` (`WebviewUiState`). Keep `main.tsx` small; split components under
  `src/webview/components/`.

### [D1] `inline/**` — Ctrl+K inline edit

- `kursor.inlineEdit.open`: capture editor + selection (or the current line when empty). Prompt UI: `createQuickPick`
  titled `Edit <file>:<a>-<b>` (or "Insert at line n"), `placeholder` "Instructions… (Enter to edit, or pick an
  action)", items: "✎ Edit selection", "? Quick question", "📄 Edit whole file", "→ Send to chat", plus a
  "History" section of previous prompts (workspaceState). Set `kursor.inlineEditInputFocus` while open. Highlight the
  target range with a `editor.selectionHighlightBackground` whole-line decoration while generating.
- Generation via `bridge.oneShot` with a strict system prompt: return ONLY the replacement code for the range (no
  fences, no prose), preserve indentation/style; include language id, file path, ±60 lines of context around the range
  (marked), the selection, and rules appendix (`rules.buildAppendix(cwd,[file])`, truncated). Post-process: strip fences,
  keep leading indentation of the original first line if the model lost it.
- Diff engine: port Continue's vertical diff (reference-impls.md §1): compute `diffLines(old, new)` from jsdiff and
  apply blocks: old lines stay as **red placeholder lines** (empty lines inserted, decorated with the old text via
  `after.contentText`, `textDecoration: 'none; display: none'`, `ThemeColor('kursor.removedLineBackground')`),
  new lines inserted as real text with a green whole-line decoration; one CodeLens pair "Accept · Reject" per block
  (`kursor.inlineEdit.acceptBlock/rejectBlock [fsPath, blockIndex]`); `acceptAll`/`rejectAll` (Ctrl+Enter /
  Ctrl+Backspace / Ctrl+Z). Use `editor.edit(cb, {undoStopBefore:false, undoStopAfter:false})`; keep block
  bookkeeping updated on document changes (shift line numbers); set `kursor.inlineDiffVisible` and
  `kursor.inlineDiffResource`; when the last block is resolved, clear everything. Streaming feel: while waiting show a
  status-bar spinner "$(loading~spin) Kursor: editing…" and allow Esc to cancel (abort signal).
- Follow-up: after the diff is shown, Ctrl+K again on the same range re-opens the prompt; a new instruction rejects
  the current diff first.
- Quick question → `chat.sendPrompt(question, [selection attachment], {mode:'ask'})`. Send to chat →
  `chat.addAttachment(selection)` + insert text.
- Register hidden command `kursor.inlineEdit.applyCode` with args `{ code: string; path?: string; language?: string }`
  (used by the chat "Apply" button): if `path` resolves to a file, open it and show a whole-file vertical diff of
  current → code (if `code` looks like a fragment, ask Claude via `oneShot` to merge it into the file first — "fast
  apply"); else apply to the active editor selection/cursor. Also `kursor.inlineEdit.insertAtCursor {code}`.

### [D2] `tab/**`, `terminal/**`, `scm/**`, `actions/**`

- Tab: `registerInlineCompletionItemProvider({scheme:'file'}|{scheme:'untitled'})`. Skip when disabled, language in
  `kursor.tab.disabledLanguages`, or `context.selectedCompletionInfo` is set. Debounce with a timer + the
  `CancellationToken` (abort the CLI request when cancelled). Prompt: FIM-style system prompt ("You are a code
  completion engine… output only the text to insert at <CURSOR>, no fences, at most 8 lines, stop when the code after
  the cursor already continues") with `kursor.tab.contextLines` of prefix/suffix and the language id; model
  `kursor.tab.model`. Sanitize: strip fences, remove overlap with the existing suffix on the same line, trim trailing
  newline, reject empty/whitespace. Cache last result by (uri, version, position). Status bar item (right,
  `$(sparkle) Kursor Tab` / `$(sparkle) Tab: off` / snoozed) → `kursor.tab.statusMenu` QuickPick: Enable/Disable,
  Snooze 30 min, Disable for <language>. `kursor.tab.trigger` → `editor.action.inlineSuggest.trigger`.
- Terminal Ctrl+K (`kursor.terminal.generate`): `showInputBox` "Describe the command…"; context = shell
  (`terminal.state.shell` or `$SHELL`), cwd (`terminal.shellIntegration?.cwd`), OS; `oneShot` → single command line;
  then QuickPick: "▶ Run" (sendText(cmd, true)), "⎘ Insert" (sendText(cmd, false)), "✎ Edit prompt"; Esc inserts.
- SCM (`kursor.scm.generateCommitMessage`): git API `vscode.git` → active/first repo; `repo.diff(true)` (staged) else
  `repo.diff()`; if empty, tell the user; truncate 60 kB; `oneShot` → conventional-commit style message (summary ≤72
  chars + optional body); `repo.inputBox.value = msg`; `withProgress` in the SCM view.
- Actions: `CodeActionProvider` for `{scheme:'file'}`: for each diagnostic in `context.diagnostics` a QuickFix
  "Fix in Chat" → `kursor.chat.fixDiagnostic(uri, diagnostic)`; when there is a selection: "Add to Chat"
  (`kursor.chat.addSelectionToChat`), "Explain with Kursor" (`kursor.chat.explainSelection`), "Edit with Kursor (Ctrl+K)"
  (`kursor.inlineEdit.open`). Provide `providedCodeActionKinds: [QuickFix, Refactor]`.

### [E] `ide/**` — IDE bridge (so `claude` in the integrated terminal integrates with Kursor)

Implement what the official extension does (reference-impls.md §4.4, all-results.md E.3): WebSocket server
(`ws`) on 127.0.0.1 random port 10000–65535, lock file `~/.claude/ide/<port>.lock` = `{pid: process.ppid,
workspaceFolders, ideName: vscode.env.appName, transport:'ws', runningInWindows:false, authToken}` (mode 0600,
dir 0700, rewritten on workspace change, deleted on dispose), header check `x-claude-code-ide-authorization`,
`context.environmentVariableCollection.replace('CLAUDE_CODE_SSE_PORT', port)`. MCP server via
`@modelcontextprotocol/sdk` (`McpServer` + a custom `Transport` over the ws socket, JSON-RPC per message) with tools:
`openFile`, `getDiagnostics`, `getOpenEditors`, `getWorkspaceFolders`, `getCurrentSelection`, `getLatestSelection`,
`checkDocumentDirty`, `saveDocument`, `close_tab`, `closeAllDiffTabs`, `openDiff(old_file_path, new_file_path,
new_file_contents, tab_name)` (open `vscode.diff` with an in-memory right side; resolve `FILE_SAVED` + contents on
accept (editor/title buttons or save) or `DIFF_REJECTED` when the tab closes — reuse `kursor-ide-left`/`kursor-ide-right`
`FileSystemProvider` schemes), and notifications `selection_changed` (debounced 100 ms, `{text, filePath, fileUrl,
selection:{start,end,isEmpty}}`) and `at_mentioned` (command `kursor.ide.insertAtMention`, add a keybinding? no —
command only). Gate on `kursor.ide.enableServer`. Log connections.

### [F] `settings/**` + `src/webview-settings/**` — "Kursor Settings" (Ctrl+Shift+J)

`WebviewPanel` (viewType `kursor.settings`, singleton, `retainContextWhenHidden`), React UI with a left tab list:
**General** (Claude status card: path, version, signed-in email/plan, buttons Sign in / Re-check / Change path;
"Open VS Code settings"), **Agents** (default mode, permission mode radio with the Cursor-style descriptions,
inline diffs, auto-save, attach open file, notify on permission), **Tab** (enabled, debounce, model, disabled
languages), **Models** (default model + effort; presets: default/opus/sonnet/haiku/fable + free text; inline-edit,
terminal and commit models), **Rules** (User Rules textarea → `kursor.rules.user`; project rules list from
`rules.listProjectRules` with Open buttons; "New Rule" → creates `.cursor/rules/<slug>.mdc` with front matter
template and opens it — also registered as `kursor.rules.new`), **Indexing** (explain `.cursorignore`/`.gitignore`
handling, button to open/create `.cursorignore`), **About** (version, links). Read/write settings with
`workspace.getConfiguration('kursor')` (`ConfigurationTarget.Global`), refresh on `onDidChangeConfiguration`.
Protocol: define `src/shared/settingsProtocol.ts` (yours).

### [G] `product/**`, `media/themes/kursor-dark.json`, `README.md`

See vscodium.md §8 and omarchy.md §8 (recipes are verified against this machine). Deliver:

- `product/install.sh` (idempotent, `set -euo pipefail`, no sudo): download+sha256-verify VSCodium 1.135.06055 into
  `~/.cache/kursor` (skip if present), extract to `~/.local/opt/kursor` (replace), rename `codium`→`kursor`,
  `bin/codium`→`bin/kursor` (+ fix the launcher script), patch `resources/app/product.json` (nameShort/nameLong
  Kursor, applicationName kursor, dataFolderName .kursor, urlProtocol kursor, licence/report URLs; keep version,
  commit, checksums, gallery), patch `resources/app/package.json` (`name: Kursor`, `desktopName: kursor.desktop`),
  replace `resources/app/resources/linux/code.png` with `product/icons/kursor-1024.png`, install hicolor icons
  (256/512/scalable svg), `~/.local/bin/kursor` wrapper (flags file `~/.config/kursor-flags.conf`; Wayland flags only
  when `WAYLAND_DISPLAY` is set), `~/.local/share/applications/kursor.desktop` + `kursor-url-handler.desktop`
  (absolute Exec, `StartupWMClass=kursor`, `MimeType=text/plain;inode/directory;application/x-kursor-workspace;`),
  `update-desktop-database`, `gtk-update-icon-cache`, seed `~/.kursor/argv.json` (`password-store: gnome-libsecret`),
  seed `~/.config/Kursor/User/settings.json` **only if missing** (Cursor-like defaults: `window.titleBarStyle custom`,
  `window.commandCenter true`, `workbench.activityBar.location top`, `workbench.secondarySideBar.defaultVisibility
  visible`, `workbench.startupEditor none`, `security.workspace.trust.enabled false`, `chat.disableAIFeatures true`,
  `editor.inlineSuggest.enabled true`, `workbench.colorTheme "Kursor Dark"`, `update.mode none`,
  `extensions.autoCheckUpdates true`, `window.dialogStyle custom`, `editor.fontFamily` with a Nerd/mono fallback list),
  install the extension from `dist/kursor.vsix` (`~/.local/opt/kursor/bin/kursor --install-extension … --force`),
  optionally `--with-icons PKief.material-icon-theme`; Omarchy: install `product/omarchy/kursor-theme.hook` via
  `omarchy hook install theme-set` (only if `omarchy` exists) and run it once; print next steps. Flags:
  `--no-extension`, `--no-omarchy`, `--hypr-bind` (append the `o.bind("SUPER + SHIFT + K", …)` line to
  `~/.config/hypr/bindings.lua` then `hyprctl reload && hyprctl configerrors`), `--default-editor` (write
  `~/.local/state/omarchy/defaults/editor` = kursor). Never edit anything under `/usr/share/omarchy`.
- `product/uninstall.sh` reversing everything (asks before deleting `~/.config/Kursor`).
- `product/omarchy/kursor-theme.hook` (from omarchy.md §8.3, parametrised with `~/.config/Kursor/User/settings.json`
  and `~/.kursor/extensions`).
- `media/themes/kursor-dark.json`: a "Cursor Dark"-like VS Code color theme (dark grey `#181818` editor, `#141414`
  side bars, subtle borders, blue accent `#3794ff`-ish, readable token colors; base it on Default Dark Modern's token
  colors — write a complete, valid theme with `colors` + `tokenColors`).
- `README.md`: what Kursor is, install (`npm install && npm run package && bash product/install.sh`), features with
  keybindings table, how Claude Code is used (own binary/login, no credentials stored), Omarchy integration, settings,
  troubleshooting (sign-in, path, Wayland), uninstall, compliance note.
