# Kursor Tab — ghost-text completions

`InlineCompletionItemProvider` for `file:` and `untitled:` documents, powered by
`ClaudeBridge.oneShot` (model `kursor.tab.model`, default `haiku`).

## Why it looks the way it does

A fresh Claude Code CLI round trip is **≥ 2.4 s** and every call consumes the
user's subscription window (research: all-results.md §B.4). Keystroke-level
completion is therefore impossible; the design is "explicit or debounced,
never speculative":

| Concern | Mechanism |
|---|---|
| Never fire per keystroke | Automatic triggers wait `kursor.tab.debounceMs` (default 900 ms) on a timer that resolves early when VS Code cancels the token (every keystroke cancels the previous provider call). Explicit triggers (Alt+\ / `kursor.tab.trigger`) skip the debounce. |
| One request per position | In-flight work is keyed by `(uri, version, line, character)`. A second call for the same key shares the promise; a call for a different key aborts the old `AbortController` and starts fresh. |
| Cancellation reaches the CLI | The `AbortSignal` is passed to `bridge.oneShot`; it fires only once *every* waiter's `CancellationToken` was cancelled (ref-counted), so a shared request is not killed by the first stale caller. |
| Typing along the suggestion | `CompletionCache` keeps the last result per document; if the user types characters matching the suggestion, the remainder is returned instantly (no request). |
| Failures do not spam | After an error the provider backs off 30 s; when the CLI is missing / not signed in it backs off 60 s and the status bar shows `Tab: unavailable`. |
| Suggest widget open | Skipped when `context.selectedCompletionInfo` is set (we would have to extend the selected item). |

## Prompt

`prompt.ts` builds a FIM prompt: a strict system prompt ("output only the text
to insert at `<CURSOR>`, no fences, ≤ 8 lines, stop when the code after the
cursor continues") plus `kursor.tab.contextLines` lines of prefix/suffix
(hard-capped at 16 kB / 8 kB), the language id, the relative file name and up to
three Error/Warning diagnostics within ±5 lines.

## Sanitizer (`sanitize.ts`, pure)

1. normalise newlines, remove an echoed `<CURSOR>`
2. strip markdown fences (balanced or dangling) and leading prose lines
3. drop an echoed copy of the text before the caret
4. reconcile with the text after the caret on the same line:
   * empty → multi-line insertion
   * completion ends with that text → **replace to end of line** (VS Code renders it as a pure insertion; the closing bracket moves down)
   * only closers `)]};,` → multi-line insertion allowed, echoed closers removed
   * anything else → single line, overlap with the suffix removed (`bar)` + `)` → `bar`)
5. drop trailing lines that repeat the following document lines
6. cap at 8 lines, trim trailing blank lines, reject empty

## State & UI

* `TabState`: `kursor.tab.enabled`, `kursor.tab.disabledLanguages`, a snooze
  (30 min, persisted in `globalState`) and a transient "unavailable" reason.
  Setting writes go to the configuration target that currently wins
  (workspace override vs. user) so the toggle is never shadowed.
* Status bar (right, priority 90): `$(sparkle) Kursor Tab` / `Tab: off` /
  `Tab: snoozed 28m` / `Tab: off (markdown)` / `$(loading~spin)` while a request
  runs; tooltip shows model, debounce and session stats.
* `kursor.tab.statusMenu` QuickPick: Enable/Disable · Snooze 30 min / End snooze ·
  Disable/Enable for `<language>` · Trigger now · Tab settings · Show logs.
* Commands: `kursor.tab.toggle`, `kursor.tab.snooze`, `kursor.tab.trigger`
  (offers to re-enable when off, then runs `editor.action.inlineSuggest.trigger`),
  and the internal `kursor.tab.accepted` (attached to each item's `command`, counts accepts).
* All `kursor.tab.*` settings are re-read on `onDidChangeConfiguration`; the cache
  and backoff are reset at the same time.
