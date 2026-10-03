# Using Kursor

A tour of the day-to-day workflow. Shortcuts are written as on Linux/Windows; on macOS the Kursor shortcuts use the
Control key as listed (they are not remapped to Cmd), while VS Code's own shortcuts follow the usual Cmd conventions.
Everything is also reachable from the command palette (Ctrl+Shift+P / Cmd+Shift+P, category **Kursor**). Installation,
Omarchy integration and troubleshooting are in the [README](../README.md).

## Where things live

| | Linux | macOS | Windows |
|---|---|---|---|
| start Kursor | `kursor [path]`, launcher entry, `SUPER + SHIFT + K` (Omarchy, `--hypr-bind`) | `kursor [path]`, Launchpad / Spotlight, `open -a Kursor` | `kursor [path]` (new terminal), Start Menu |
| `settings.json`, `keybindings.json` | `~/.config/Kursor/User/` | `~/Library/Application Support/Kursor/User/` | `%APPDATA%\Kursor\User\` |
| extensions, `argv.json` | `~/.kursor/` | `~/.kursor/` | `%USERPROFILE%\.kursor\` |
| install a `.vsix` by hand | `kursor --install-extension file.vsix` | same | same |
| extra Electron flags | `~/.config/kursor-flags.conf` | `~/.kursor/argv.json` | `%USERPROFILE%\.kursor\argv.json` |
| upgrade / uninstall | `bash product/install.sh` / `bash product/uninstall.sh` | same | `product\install.cmd` / `product\uninstall.cmd` |

Kursor's own settings panel (Ctrl+Shift+J) and VS Code's settings UI (Ctrl+, / Cmd+,) edit the same `settings.json`.

## Layout

- **Primary side bar** (left, activity bar on top): Explorer, Search, Source Control, Extensions… as in VS Code.
- **Secondary side bar** (right): the **Kursor chat**. Ctrl+I toggles it; it starts visible. The view title has
  **New Chat**, **History**, **Open in Editor** and **Settings** buttons; its `…` menu has **Export Chat** and **Show Logs**.
- **Status bar**: `Kursor Tab` (completions state) on the right; `N files · Review` appears while agent edits are
  pending; a spinner shows while an inline edit is being generated.
- **Kursor Settings** (Ctrl+Shift+J): a dedicated panel with tabs *General* (Claude status: path, version, account,
  Sign in / Re-check / Change path), *Agents*, *Tab*, *Models*, *Rules*, *Indexing*, *About*. Plain VS Code settings
  (Ctrl+,) work too — everything lives under `kursor.*`.

## Chat

### Starting a chat

Type in the input box and press **Enter**. The first message starts a Claude Code session in the workspace folder of the
active file (or the first workspace folder). The session is a real Claude Code session: it loads your `CLAUDE.md`,
`~/.claude/settings.json`, hooks and MCP servers, and it shows up in `claude --resume` later.

Ctrl+L with a selection opens a **new** chat with the selection attached; Ctrl+Shift+L attaches the selection to the
**current** chat. Right-click a file in the Explorer → *Add File to Chat*; right-click in the editor → *Add Selection to
Chat*, *Edit with Kursor (Ctrl+K)*, *Explain with Kursor*.

### Modes

| Mode | What Claude may do | Permission handling |
|---|---|---|
| **Agent** | read, edit, create files, run commands | `kursor.agent.permissionMode`: `acceptEdits` (default — edits applied, commands ask), `default` (everything asks), `auto`, `bypassPermissions` |
| **Ask** | read only (`Edit`, `Write`, `NotebookEdit` are denied) | commands ask |
| **Plan** | explore, then present a plan | the plan arrives as a card with **Build** (switches to Agent and executes) and **Reject** (optionally with feedback) |

Switch with the dropdown at the bottom of the input, **Ctrl+.** or **Shift+Tab**. New chats start in
`kursor.agent.defaultMode`.

### Models and effort

The model dropdown lists what your Claude Code reports (`opus`, `sonnet`, `haiku`, `fable`, 1M-context variants…);
**Ctrl+/** cycles. Models that support it get an effort submenu (`low` … `max`). Defaults come from `kursor.claude.model`
and `kursor.claude.effort`; empty means "whatever Claude Code would pick".

### While it works

- Text streams in; **thinking** shows as a collapsible pill with elapsed time (`kursor.chat.showThinking`).
- **Tool rows**: `Read file`, `Searched for …`, `Ran command` with a live console box, `Edited file (+12 −3)` with
  **Review · Undo · Keep**, `Subagent: …`, web search/fetch, a `TodoWrite` checklist. Density is
  `kursor.chat.toolCallDensity` (`compact`, `balanced`, `detailed`).
- **Permission card** (terminal commands and other gated tools): **Run** (Ctrl+Enter when the input is empty),
  **Skip**, or **Always allow ▾** with Claude Code's own suggestions ("Always allow `npm test` in this project",
  "Always apply edits this session"…). The turn is blocked until you answer. If the chat is hidden, the view gets a
  badge and (with `kursor.agent.notifyOnPermission`) a desktop notification with **Open**.
- **Question card** (Claude asks you something): options as buttons or checkboxes, plus a free-text answer.
- **Queueing**: pressing Enter while a turn runs queues the message (shown with a *queued* badge); **Ctrl+Enter**
  interrupts and sends now. **Stop** (or Ctrl+Shift+Backspace) interrupts the turn; the session stays alive.
- The **context ring** next to the send button shows how full the context window is; hover for a breakdown. The footer
  shows your 5-hour window utilisation when Claude Code reports it.

### Context: `@`, `/`, images

- Type **@** to attach context: *Files & Folders*, *Code* (workspace symbols), *Problems* (diagnostics), *Terminal*
  (last output), *Git* (working changes), *Web* (a URL), *Docs*, *Rules*, plus open files up front. Fuzzy search over the
  workspace (ripgrep, honours `.gitignore` and `.cursorignore`). Files and folders are passed by path (Claude reads them
  with its own tools); selections, problems, terminal output and diffs are inlined.
- Type **/** for Claude Code's slash commands (`/review`, `/compact`, your custom commands…); they are passed through
  verbatim.
- Paste or drop an image into the input to attach it.
- With `kursor.agent.attachOpenFile` (default on) every message tells Claude which file is active and what is selected.
- Code blocks in answers have **Copy**, **Apply** (opens an inline diff in the target file — the fence's path is used when
  present), **Insert at cursor**, and **Run** for shell blocks.

### Reviewing agent edits

Agent edits land on disk immediately (Claude Code writes them). Kursor keeps a snapshot of each file from before the
first edit of the turn and offers:

- in the editor: added lines highlighted, removed-lines markers with hover preview, **Keep · Undo** code lenses per hunk
  (`kursor.agent.inlineDiffs`);
- in the chat: **Review · Undo · Keep** on each edit row; a sticky **review bar** above the input with
  *N files · Review · Undo All · Keep All* (Ctrl+Enter keeps all, Ctrl+Shift+Backspace undoes all while the chat is
  focused and idle);
- editor title buttons and the status bar item for the current file / all files. **Review** opens *Original ↔ Kursor*
  diff editors.

**Restore checkpoint** (hover a user message) rewinds the workspace files to their state before that message using
Claude Code's file checkpointing; the conversation itself is kept, like Cursor.

### Chats, history, export

- Several chats can be open at once (tabs appear in the chat header). Ctrl+N / Ctrl+T in the chat starts a new one.
- **History** (Ctrl+Alt+' or the clock button) lists past Claude Code sessions for this workspace; resume or delete them.
- **Open Chat in Editor** moves the same UI into an editor tab (useful on narrow screens).
- **Export Chat as Markdown** writes a transcript.
- Chats are persisted per workspace and re-attached to their Claude Code session on reload.

## Ctrl+K — inline edit

1. Select code (or just place the cursor on a line) and press **Ctrl+K**.
2. A prompt opens titled `Edit file.ts:12-30`. Type the instruction and press **Enter**, or pick an action:
   **✎ Edit selection**, **? Quick question** (Alt+Enter — answers in chat in Ask mode), **📄 Edit whole file**
   (Ctrl+Shift+Enter), **→ Send to chat** (Ctrl+L). Previous prompts are offered as history.
3. Kursor asks the model (`kursor.inlineEdit.model`) for the replacement only, with ±60 lines of context, the language,
   the file path and your rules. While it generates, the status bar shows a spinner; **Esc** cancels.
4. The result is shown as a vertical diff in place: red lines (removed), green lines (added), with **✓ Accept · ✗ Reject**
   code lenses per block. **Ctrl+Enter** accepts everything, **Ctrl+Backspace** / **Ctrl+Z** rejects everything,
   Ctrl+Alt+Y / Ctrl+Alt+N accept/reject the current block. Accepted edits are a single undo step.
5. Press **Ctrl+K** again while the diff is visible to **refine** (re-runs against the original text with the previous
   attempt as context), accept, reject, ask a question or send to chat.

**Apply from chat** uses the same engine: a code block whose fence names a file (```` ```ts src/x.ts ````) opens that file
with a whole-file diff; fragments ("`// ... existing code ...`") are merged by a quick model call first.

## Tab — completions

Ghost text appears after a typing pause (`kursor.tab.debounceMs`, 900 ms); **Tab** accepts, **Esc** dismisses,
**Alt+\\** requests one immediately. The status-bar item (`$(sparkle) Kursor Tab`) opens a menu: *Enable/Disable*,
*Snooze 30 min*, *Disable for <language>*, *Trigger now*, *Settings*, *Logs*. Completions use `kursor.tab.model`
(`haiku`) and `kursor.tab.contextLines` of prefix/suffix; they are skipped in `kursor.tab.disabledLanguages`, while the
regular suggest widget is open, and when the CLI is not ready. Each completion is a request to Claude Code, so the
debounce matters for your quota.

## Terminal

- **Ctrl+K** in the integrated terminal: *Describe the command…* → Kursor proposes one command for your shell, cwd and OS
  → **▶ Run**, **⎘ Insert**, **✎ Edit prompt**, **Copy**, **Ask in Chat** (Esc inserts without running).
- Right-click in the terminal: **Add Terminal Selection to Chat**, **Debug Terminal Output with Kursor** (sends the last
  command and its output with a "Debug this" prompt), **Generate Terminal Command**.
- Terminal output is captured through shell integration (last 64 kB per terminal) for the `@Terminal` mention.

## Git

The **✦** button in the Source Control title (or *Kursor: Generate Commit Message*) reads the staged diff (or the working
diff and untracked files when nothing is staged), asks `kursor.commit.model` for a conventional-commit message (summary
≤ 72 chars, optional body) and puts it in the commit box.

## Code actions

The lightbulb (Ctrl+.) offers **Fix in Chat: <diagnostic>** on problems, and with a selection **Edit with Kursor
(Ctrl+K)**, **Add to Chat**, **Explain with Kursor**.

## Rules

Kursor appends a rules section to the system prompt of every chat (and to Ctrl+K requests):

| Source | Kind |
|---|---|
| `kursor.rules.user` (User Rules in the settings panel) | always |
| `.cursor/rules/*.mdc` with `alwaysApply: true` | always |
| `.cursor/rules/*.mdc` with `globs:` | auto — included when an attached/active file matches |
| `.cursor/rules/*.mdc` with only `description:` | agent — indexed as "Read `path` when relevant" |
| `.cursor/rules/*.mdc` with neither | manual — attach with `@Rules` |
| `.cursorrules` (legacy) | always |
| `AGENTS.md` at the workspace root | always |

Front matter example:

```markdown
---
description: Conventions for API handlers
globs: src/api/**/*.ts, src/server/**
alwaysApply: false
---
Use zod for input validation. Never throw raw errors from handlers…
```

**New Kursor Rule** (settings panel or command palette) creates `.cursor/rules/<name>.mdc` from this template.
`CLAUDE.md` is not read by Kursor — Claude Code loads it itself. Nested `.cursor/rules` directories apply to their
subtree. The whole appendix is capped at 60 k characters.

## `claude` in the integrated terminal

Running `claude` in Kursor's terminal connects it to Kursor through the IDE bridge (`kursor.ide.enableServer`): the CLI
shows "IDE: Kursor", knows your current selection and diagnostics, opens proposed changes as diff tabs with
**Accept / Reject** buttons, and `kursor.ide.insertAtMention` (command palette) pastes an `@file#L1-L9` reference of the
current selection into it. Nothing is installed into Claude Code for this — Kursor only writes `~/.claude/ide/<port>.lock`
while it runs and exports `CLAUDE_CODE_SSE_PORT` to its terminals.

## Quota and privacy notes

- Every chat turn, Tab completion, Ctrl+K, terminal command and commit message is a request made by your `claude` CLI
  under your account. Cost per turn is shown in the chat (when the CLI reports it) and the 5-hour window in the footer.
- Kursor keeps chat transcripts in the editor's workspace storage (messages capped, tool outputs truncated to 20 kB) and
  the full sessions live where Claude Code keeps them (`~/.claude/projects/…`). Kursor never reads or copies
  `~/.claude/.credentials.json` or any token.
