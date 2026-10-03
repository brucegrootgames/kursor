# `src/webview` — Kursor chat UI

React 18 + TypeScript, bundled by esbuild (`node esbuild.mjs`) into `dist/webview.js` (+ `dist/webview.css`,
emitted from `styles.css`). The host (`src/extension/chat`) renders it in the `kursor.chat` secondary-side-bar
view and in the "Open Chat in Editor" panel. The only contract is `src/shared/protocol.ts`: the host owns all
chat state and posts `AppState` / `ChatState` snapshots plus `textDelta`s; the UI posts `WebviewToHost` intents.
Nothing here imports from `src/extension`.

Typecheck: `npx tsc --noEmit -p src/webview/tsconfig.json`. Tests (sanitizer, fence meta, mention helpers):
`node src/webview/__tests__/markdown.test.mjs` (bundles the sources with esbuild, no DOM needed).

## Data flow

```
window 'message' ──▶ store.handleHostMessage()
   appState  → store.app (+ migrates the pre-chat draft, flushes queued send / mode / model)
   chatState → reconcileChat(): unchanged messages & blocks keep identity → memo()-ed rows skip re-render
   textDelta → deltaStore.appendDelta(blockId) → notifies ONLY the <TextBlock>/<ThinkingBlock> for that id
   mentionResults → mentions.deliverMentionResults(requestId)
   history / showHistory / focusInput / insertText / addAttachment / toast
components ──▶ vscode.post(WebviewToHost)
window focus/blur ──▶ post({type:'focusChanged'}) (lets Ctrl+I toggle the pane only when the chat is focused)
```

- `store.ts` — external store (`useSyncExternalStore`): `app`, `chats`, per-chat composer drafts + attachment
  pills, history, toasts, and the `whenChatActive()` queue used when the user acts before any chat exists.
- `deltaStore.ts` — per-block streaming buffers; `chatState` snapshots raise/prune them (`syncBlock`, `dropBlocks`).
  A block shows the longer of snapshot text and buffered text (both are prefixes of the same string).
- `markdown.ts` — `marked` (GFM) + `highlight.js/lib/common`. Raw HTML tokens are escaped (never injected),
  links get `safeUrl()` (http/https/mailto/vscode/file/command only), images only http(s)/data. `parseFenceInfo`
  reads fence meta: ` ```ts src/a.ts `, ` ```ts:src/a.ts `, ` ```json title="x.json" `, ` ```ts src/a.ts (10-20) `.
- `mentions.ts` — `@`/`/` trigger detection at the caret, request registry for `searchMentions`, and
  `resultToAttachment()` (MentionResult → Attachment pill).
- `vscode.ts` — `acquireVsCodeApi` wrapper: `post()`, `getUiState()/setUiState()` (`WebviewUiState`: draft,
  collapsedThinking), `hostLog()`.
- `hooks.ts` — `useStickToBottom` (auto-scroll unless the user scrolled up), `useAutoGrow`, `useElapsedSeconds`.

## Components (`components/`)

| Component | Renders |
|---|---|
| `App` | message listener, `ready`, error boundary, layout: Header → (HistoryView \| MessageList/EmptyState → ReviewBar → InputBox) → Toasts |
| `Header` | tab strip when >1 chat (status spinner / orange "waiting" dot / unread dot, close, double-click rename, middle-click close) or title + workspace; new chat, history, export, settings buttons |
| `MessageList` | scroll container, `WorkingRow` (spinner + Stop while running and no text is streaming), chat error row, scroll-to-bottom button |
| `UserMessage` | bubble with `AttachmentPill`s, `Queued` badge, hover actions Copy / Restore checkpoint (two-click confirm) |
| `AssistantMessage` | iterates blocks → `TextBlock`, `ThinkingBlock`, `ToolRow`, `PermissionCard`, `QuestionCard`, `PlanCard`, `TodoCard`; error box; footer (duration/cost in `detailed` density, copy response) |
| `TextBlock` | `useStreamedText` + `Markdown`; caret on the last streaming text block |
| `Markdown` / `CodeFence` | per-token memoized markdown; fences get language, clickable path chip, Copy · Apply/Run · Insert · New file (Run for shell languages, `$ ` prompts stripped) |
| `ThinkingBlock` | collapsible "Thinking… Ns" / "Thought for Ns" pill (hidden when `settings.showThinking` is false) |
| `ToolRow` | per-tool header (Read / Listed / Searched for / Ran / Edited / Created / Subagent / Searched the web / Fetched / MCP `server › tool` / unknown) with status icon, +N −M and Review · Undo · Keep for edits, collapsible body (console with auto-scroll for Bash, old/new preview for Edit, content for Write, args + output otherwise). Density: `compact` (closed), `balanced` (Bash open), `detailed` (all open + args) |
| `PermissionCard` | command / tool input, description, blocked path, Run (Ctrl+Enter) · Skip · Always allow ▾ (suggestions) — or Allow / Deny for non-Bash tools; collapses to one line once decided |
| `QuestionCard` | one section per `QuestionSpec`: single-select radios or multi-select checks, "Other…" free text, Submit |
| `PlanCard` | rendered plan, Build / Feedback (textbox, Ctrl+Enter) / Reject |
| `TodoCard` | checklist with pending / in-progress spinner / completed |
| `ReviewBar` | sticky "N files +A −D · Review · Undo All · Keep All", expandable per-file list |
| `InputBox` | textarea, pills, `Popover` (@ mentions with categories → drill-in, `/` commands), image paste/drop + `text/uri-list` file drops, toolbar: @, image (`pickImage`), mode menu, model menu with effort submenu, `ContextRing`, send/stop; running hint line |
| `Menu` / `Popover` | anchored dropdown (keyboard nav, outside click, Esc) / list popover above the input |
| `EmptyState` | logo + hints; `SignInPanel` when `claude.ready` is false or `loggedIn === false` (Sign in → `kursor.claude.login`, Set path → settings, Re-check) |
| `HistoryView` | search box, entries (resume / switch to open tab, two-click delete, refresh) |
| `Toasts` | top-right auto-dismissing notifications |

## Keyboard (textarea)

Enter send (queues while a turn is running) · Shift+Enter newline · Ctrl+Enter send now (or approve the pending
permission card when the input is empty) · Ctrl+. / Shift+Tab cycle mode · Ctrl+/ cycle model · Esc close
popover / menu, else blur · popovers: ↑/↓, Enter/Tab select, Backspace on an empty query leaves a category.

## Theming

Everything uses `--vscode-*` variables (mapped to `--k-*` tokens at the top of `styles.css`); highlight.js gets a
dark palette by default and a light one under `body.vscode-light`. Icons are codicons (`dist/codicon.css` is
loaded by the host).
