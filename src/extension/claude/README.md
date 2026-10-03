# `claude/` — ClaudeBridge

The one place that talks to the Claude Code CLI. Everything else in Kursor programs
against `types.ts` (`ClaudeBridge`, `ClaudeSession`, `SessionEvent`).

We spawn the **user's own, unmodified `claude` binary** through
`@anthropic-ai/claude-agent-sdk` (`pathToClaudeCodeExecutable`), so it uses its own
login. No credentials are read, stored or forwarded.

## Files

| file | vscode-free | role |
|---|---|---|
| `types.ts` | yes | shared contract (additive changes only) |
| `sdk.ts` | yes | lazy `import()` of the ESM-only SDK + type re-exports (`resolution-mode: import`), `BridgeAbortError`, `isAbortError` |
| `env.ts` | yes | child environment: `process.env` minus `CLAUDECODE`, `CLAUDE_CODE_CHILD_SESSION`, `TRACEPARENT/STATE`, `ELECTRON_RUN_AS_NODE`; login-shell `PATH` merged in |
| `resolvePath.ts` | yes | executable resolution: setting → `$SHELL -lic 'command -v claude'` (5 s, cached; also captures `$PATH`) → `~/.local/bin/claude` → mise shim → `PATH`; mise shims are unwrapped with `mise which claude` |
| `status.ts` | yes | `claude --version` + `claude auth status --json` → `ClaudeStatus` |
| `labels.ts` | yes | human labels for `PermissionUpdate` suggestions and default permission titles |
| `translate.ts` | yes | `MessageTranslator`: every `SDKMessage` → `SessionEvent[]` |
| `sdkClient.ts` | yes | `createSdkSession()` (streaming-input session, canUseTool, hooks) and `runOneShot()` |
| `history.ts` | yes | `listSessions` / `getSessionTranscript` / `deleteSession` via SDK exports, fallback to `~/.claude/projects/<key>/*.jsonl` |
| `session.ts` | no | `ClaudeSessionImpl`: EventEmitter, `running`, transparent resume, runtime model/effort/mode changes, control calls with timeouts |
| `bridge.ts` | no | `createClaudeBridge()`: executable + status cache (60 s), session registry, `oneShot`, history |

`scripts/probe-bridge.mjs` bundles the vscode-free files with esbuild and runs one
session turn plus one one-shot against the real CLI (2 model calls).

## Session design

- `createSession()` spawns one long-lived process per chat with **streaming input**:
  the SDK `prompt` is an async generator fed by an in-memory queue; the generator is
  only closed by `dispose()`, so the process survives across turns (verified: the CLI
  stays alive while stdin is open). `send()` pushes
  `{type:'user', message:{role:'user', content:[text, images…]}, parent_tool_use_id:null}`.
- Options: `cwd`, `permissionMode` (ask → `default` + `disallowedTools: Edit/Write/NotebookEdit`,
  plan → `plan`, agent → configured), `allowDangerouslySkipPermissions: true` (so
  `bypassPermissions` can be selected at runtime), `model`, `effort`, `resume`,
  `includePartialMessages`, `enableFileCheckpointing`, `settingSources: [user, project, local]`,
  `systemPrompt: {preset: 'claude_code', append}`, `additionalDirectories`,
  `extraArgs: {'replay-user-messages': null}` (user turns are echoed with their uuid →
  `userReplay`, needed for "Restore checkpoint"), `env`, `stderr → log.debug`.
- `canUseTool` → `permissionRequest` (`kind`: `question` for AskUserQuestion with parsed
  `questions`, `plan` for ExitPlanMode with `plan`, else `tool`; `suggestions` carry human
  labels index-aligned with the SDK's `PermissionUpdate[]`). `respondPermission()` resolves
  the parked promise: allow → `{behavior:'allow', updatedInput: {...input, ...updatedInput},
  updatedPermissions: [suggestions[i]]}` (so a question card may pass just `{answers}`);
  deny → `{behavior:'deny', message}`. The CLI's abort signal, `dispose()` and process exit
  deny anything still pending (`permissionResolved` is emitted either way).
- Hooks `PreToolUse`/`PostToolUse`/`PostToolUseFailure` with matcher `Edit|Write|NotebookEdit`
  snapshot the file before/after (keyed by `tool_use_id`, ≤ 8 MB, bounded map) and emit
  `fileChanged {path, before, after}`. They return `{}` — except in **Ask mode**, where
  `PreToolUse` returns `permissionDecision: 'deny'` (hooks run before every other permission
  check, so this holds in any permission mode); `canUseTool` denies as a second line.
- `running` = pending turn counter: `+1` on `send`, set to `result.queued_turn_count`
  (fallback `-1`) on `result`, clamped by the interrupt receipt's `still_queued`.
- Process exit: the SDK's read loop ends → `error {fatal:true}` + `exit`; the next
  `send()` recreates the process with `resume: sessionId` (also after `setMode('agent')`
  on a session spawned in Ask mode, since `disallowedTools` cannot change at runtime).
- `setMode(mode)` (optional member added to `ClaudeSession`): ask → hook/canUseTool deny +
  `setPermissionMode('default')`; plan → `plan`; agent → configured permission mode.
- `oneShot()`: single-message `query()` with a custom string system prompt, `tools: []`
  (`--tools ""`), `maxTurns: 1`, `persistSession: false`, `settingSources: []`,
  `permissionPrompts: 'none'`, `thinking: {type:'disabled'}` unless `thinking: true`,
  `includePartialMessages` when `onDelta` is given. Rejects with `name === 'AbortError'`
  when the `signal` fires; throws on `result.is_error`.

## Observed wire order (2.1.263)

`system/init` → `system/status requesting` → `rate_limit_event` → `stream_event`
(`message_start`, `content_block_start`, `content_block_delta`×N) → **`assistant`**
(complete block, before `content_block_stop`) → `content_block_stop` → `message_delta` →
`message_stop` → `rate_limit_event` → `result`. Tool results arrive as `user` messages
with `tool_result` blocks (`content` string or block array — flattened; `is_error`).

## Notes for integrators

- `SessionEvent.status` gained `detail?` (API retries), `result` gained `queuedTurnCount?`,
  `OneShotRequest` gained `thinking?`.
- On the plan card's **Build**, call `respondPermission(id, {behavior:'allow'})` and then
  `setMode?.('agent')`; on **Reject** with feedback, `{behavior:'deny', message: feedback}`.
- `status()` is cached 60 s; `refreshStatus()` also re-resolves the executable (and the
  login shell). Changing `kursor.claude.path` refreshes automatically.
- Everything logs through the `Logger`; the CLI's stderr is logged at debug level.
