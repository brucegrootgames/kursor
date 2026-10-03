# `ide/` — IDE bridge for a terminal `claude`

Lets the Claude Code CLI that a user starts in Kursor's **integrated terminal** integrate with the
editor exactly as it does with the reference IDE extension: it sees the current selection and
diagnostics, can open files, and shows its proposed edits as diff tabs the user accepts or rejects.
Kursor's own chat does not go through this module (it uses the Agent SDK bridge, `claude/`).

## How the CLI finds us

1. `IdeServer.start()` picks a random free port in `10000-65535` on `127.0.0.1` (`port.ts`) and
   listens with an `http.Server` that only accepts WebSocket upgrades.
2. It writes `~/.claude/ide/<port>.lock` (`$CLAUDE_CONFIG_DIR` respected, dir `0700`, file `0600`,
   atomic temp+rename) containing `{pid: process.ppid, workspaceFolders, ideName, transport: "ws",
   runningInWindows, authToken}` (`lockFile.ts`). The file is rewritten when workspace folders change
   and deleted on stop/deactivate.
3. It sets `CLAUDE_CODE_SSE_PORT=<port>` in `context.environmentVariableCollection` (non-persistent,
   so a stale port never leaks into restored terminals) plus `CLAUDE_CODE_IDE_SKIP_AUTO_INSTALL=true`
   so the CLI does not try to install the reference extension into Kursor.
4. The CLI connects to `ws://127.0.0.1:<port>` (subprotocol `mcp`) with header
   `X-Claude-Code-Ide-Authorization: <authToken>`; the upgrade is refused with `401` when the header
   or the loopback source address is wrong. One client at a time: a newer connection replaces the
   older one (its pending diffs are rejected).

## Protocol

Per connection an `McpServer` (`@modelcontextprotocol/sdk`) is attached to
`WebSocketServerTransport` (`wsTransport.ts`, one JSON-RPC message per text frame, frames that
arrive before `start()` are buffered). Tools (`tools.ts`, zod v4 schemas, names/result shapes match
the reference implementation): `openDiff`, `getDiagnostics`, `getOpenEditors`, `getWorkspaceFolders`,
`getCurrentSelection`, `getLatestSelection`, `checkDocumentDirty`, `saveDocument`, `close_tab`,
`closeAllDiffTabs`. Server → client notifications: `selection_changed` (debounced 100 ms, sent on
every change and once 500 ms after a client connects) and `at_mentioned` (command
`kursor.ide.insertAtMention`, 0-based `lineStart`/`lineEnd`). The client's `ide_connected`
notification is logged with the CLI pid.

## Diff approval (`diff.ts`)

`openDiff(old_file_path, new_file_path, new_file_contents, tab_name)` opens
`vscode.diff(kursor-ide-left:<old>?v=N, kursor-ide-right:<new>?v=N, tab_name)` — both sides live in
`MemoryFileSystemProvider`s (`memoryFs.ts`; left read-only, right editable, versioned URIs so
repeated diffs never reuse a stale document). The request resolves with the first of:

| event | result to the CLI |
| --- | --- |
| `kursor.ide.acceptDiff` (editor/title button, palette) | `FILE_SAVED` + current right-hand text (user edits included) |
| save of the right side while `files.autoSave` is `off` | `FILE_SAVED` + text (500 ms "undo storm" guard like the reference) |
| `kursor.ide.rejectDiff`, tab closed, request cancelled, client disconnected | `DIFF_REJECTED` + tab name |

Context key `kursor.ide.viewingDiff` gates the buttons (`resourceScheme == kursor-ide-right`).
Accepted diffs are recorded in the `EditTracker` under chat id `ide` so Keep/Undo/Review work.
For one second after a diff opens, `type` is intercepted for the right-hand document so keystrokes
still aimed at the terminal do not land in the proposal.

## Files

- `index.ts` — `registerIdeServer(context, deps)`: wires everything, registers commands, gates the
  server on `kursor.ide.enableServer` (start/stop on change, serialized).
- `server.ts` — `IdeServer` (http + ws + auth + lock file + env vars + client lifecycle).
- `tools.ts`, `diff.ts`, `selection.ts`, `memoryFs.ts`, `wsTransport.ts`, `lockFile.ts`, `port.ts`.
- `__tests__/pure.test.mjs` — `node --test` for the vscode-free parts (lock file contract, ports).
