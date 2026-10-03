# context/ — @-mentions and context providers

| File | Purpose |
|---|---|
| `fuzzy.ts` | fzf-v1-style fuzzy scorer (`fuzzyScore`, `rankFuzzy`): forward/backward window scan, bonuses for path boundaries, camelCase, consecutive matches, basename matches; prefers shorter paths. |
| `ripgrep.ts` | `rg --files --follow --hidden` (+ `.cursorignore` via `--ignore-file`, excludes for node_modules/.git/dist/…), resolved from `vscode.env.appRoot/node_modules/@vscode/ripgrep/bin/rg` or `/usr/bin/rg`; falls back to `workspace.findFiles`. Capped at 25 000 files. |
| `mentions.ts` | `MentionSearch.search(query, kind, commands)`: categories + open files for an empty query, `/` → slash commands, otherwise fuzzy files/folders + workspace symbols (kind `code`, `value` = `L<start>-<end>`). Per-folder index cached, refreshed at most every 5 s on create/delete events. |
| `providers.ts` | Attachment builders (selection, file, diagnostic, problems, git, terminal, url) and `resolveAttachment()` which fills missing `text` for attachments created by the webview from mention pills. |
| `git.ts` | Minimal `vscode.git` API typings and `workingChanges()` (staged + unstaged diff + untracked previews, 60 kB cap). |
| `terminalCapture.ts` | Shell-integration capture: reads every `TerminalShellExecution`, strips ANSI, keeps 64 kB per terminal and the last 8 executions; `lastOutput()`. |

The chat host injects `AppState.commands` into `search()` so the `/` popover lists Claude Code's slash commands.
