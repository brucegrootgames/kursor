# chat/ — chat view host

The extension-host side of the Kursor chat. The webview (`src/webview`) only renders
`ChatState`/`AppState` snapshots and posts intents (`src/shared/protocol.ts`); everything
stateful lives here.

| File | Purpose |
|---|---|
| `index.ts` | `registerChat()`: wires terminal capture, @-mention search, `ChatManager`, the side-bar view + editor panel, permission badge/notification, commands; returns the `ChatController` used by other modules. |
| `manager.ts` | `ChatManager`: the `ChatStore`, one lazy `ChatRunner` per chat, connected webview hosts, `AppState` (models, slash commands, Claude status, settings), every user action (send/stop/permissions/mode/model/checkpoint/history/export/attachments). `chatState` posts are throttled 50 ms per chat; `textDelta` is immediate. Sets `kursor.chatRunning`. |
| `runner.ts` | `ChatRunner`: binds a `ClaudeSession` to a `ChatState` and translates every `SessionEvent` (see the header comment). Session created lazily on the first send (`cwd`, rules appendix + Kursor note, `resume: sessionId`), re-created with `resume` after a fatal error/exit, when rules change (deferred until idle) or when leaving/entering Ask mode without `session.setMode`. Tracks which user messages still await their Claude Code uuid (FIFO) so "Restore checkpoint" attaches to the right message even after a reload/resume. |
| `store.ts` | `ChatStore`: open chats + active id, persisted (debounced) in `workspaceState`; restore on activation. |
| `state.ts` | Pure helpers: ids, titles, block lookup, output cap (20 kB), persistence trimming (last 200 messages, image payloads stripped, running tools/permissions closed), `reconcileEditStatuses`. |
| `prompt.ts` | `composeTurn()`: user text → "## Attached context" (`@path` refs for files/folders/rules; fenced sections for selection/diagnostic/problems/terminal/git; URLs) → "Active file: …"; images become content blocks. `KURSOR_SYSTEM_NOTE` is appended to the system prompt together with the rules appendix. |
| `messages.ts` | `handleWebviewMessage()`: every `WebviewToHost` message (`ready`/`focusChanged` are consumed by `WebviewHost`). Code actions: apply → `kursor.inlineEdit.applyCode {code,path,language}`, insert → `kursor.inlineEdit.insertAtCursor {code}`, run → terminal, copy → clipboard, newFile → untitled document. |
| `views.ts` | `WebviewHost` (ready-queue, focus flag), `ChatViewProvider` (`kursor.chat`, badge, visibility event) and `ChatPanelController` (`kursor.chatPanel`, serializer). Both load `html.ts`. |
| `html.ts` | Webview HTML: nonce CSP (`font-src`/`img-src data:` for codicons and pasted images), `dist/codicon.css`, `dist/webview.css` (emitted by esbuild from `styles.css`), `dist/webview.js`. |
| `commands.ts` | All `kursor.chat.*` commands. `kursor.chat.open` toggles: closes the secondary side bar when the chat is visible *and* focused (the webview reports focus via `focusChanged`), otherwise reveals and focuses it. |
| `controller.ts` | `ChatController` implementation (`open`, `addAttachment`, `sendPrompt`, `insertText`, `focusInput`). |
| `export.ts` | Markdown transcript for `kursor.chat.exportChat`. |

## Turn lifecycle (runner)

```
send ─▶ status starting|running ─▶ init ─▶ userReplay (uuid → canRestore) ─▶ streamStart
  ─▶ blockStart/blockDelta (text/thinking → textDelta; tool_use → tool block with inputStreaming)
  ─▶ assistantBlock (authoritative; finalizes the streamed block; TodoWrite → todo block)
  ─▶ fileChanged (EditTracker.recordChange → `edit` summary on the tool block, pendingEdits)
  ─▶ toolResult (output capped 20 kB) ─▶ … ─▶ result (message.result, cost, status idle, onTurnEnd)
permissionRequest → permission/question/plan block, status waiting → respond → running
error(fatal)/exit → system note, status error, respawn with resume on the next send
interrupt → pending requests denied, running tools "Interrupted", late result of that turn ignored
```

Queued sends (while running) are appended with `queued: true` and handed to Claude Code, which
queues them; `userReplay` clears the flag and the chat stays `running` while
`result.queuedTurnCount > 0`. Send-now interrupts first.

## Edits

`EditTracker.onDidResolve` (kept/undone, from chat buttons, CodeLens, title buttons or keybindings)
updates the matching tool rows; `onDidChange` refreshes `pendingEdits` and the live summaries.

## Tests

`node src/extension/chat/__tests__/runner.test.mjs` bundles `runner.ts`/`state.ts`/`prompt.ts` with a
stub `vscode` module and drives the runner through the event sequences above with a fake session.
