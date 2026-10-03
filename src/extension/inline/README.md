# `inline/` — Ctrl+K inline edit (module D1)

Cursor-style inline edit: select code, press **Ctrl+K**, type an instruction, get an in-place
red/green diff with per-block Accept/Reject. Generation goes through `ClaudeBridge.oneShot`
(model `kursor.inlineEdit.model`, default `sonnet`, thinking off) with a strict
"replacement code only" system prompt plus the rules appendix from `RulesService`.

## Files

| File | Role |
| --- | --- |
| `index.ts` | `registerInlineEdit(context, deps)`: wires everything, registers all `kursor.inlineEdit.*` commands (uniform try/catch → log + error toast). |
| `inlineEdit.ts` | `InlineEditController`: target range (selection → whole lines, or current line), prompt → generate → post-process → diff; follow-up flow; Quick question / Send to chat; `RangeTracker` guards against edits made while generating. |
| `promptUi.ts` | The prompt: a `QuickPick` with `alwaysShow` action items (Edit selection · Quick question · Edit whole file · Send to chat) and a History section; sets `kursor.inlineEditInputFocus`; `submit(action)` is reached by the Alt+Enter / Ctrl+Shift+Enter / Ctrl+L keybindings via `kursor.inlineEdit.submit`. |
| `prompts.ts` | Pure prompt builders: strict system prompt (+ rules appendix, capped 8 kB), user prompt with `<before>` / `<region>` / `<after>` (±60 lines, numbered context, verbatim region), previous-attempt block for refinements; `buildMergePrompt` for fast apply. |
| `postprocess.ts` | Pure output cleanup: unwrap fences (also with a short prose line around them), strip echoed tags, blank edges, restore lost base indentation, tab/space normalisation, keep the region's trailing blank lines; `looksLikeFragment` for Apply. |
| `diffBlocks.ts` | Pure diff engine core: jsdiff `diffLines` → `DiffLine[]` → `VerticalDiffPlan` (document lines with `''` placeholders for removed lines + `DiffBlock[]`), plus bookkeeping helpers (`removeBlock`, `shiftBlocksForEdit`, `findBlockNearLine`, accept/reject simulations). |
| `verticalDiff.ts` | `VerticalDiffHandler` (one per document; blocks are the single source of truth; atomic `editor.edit` ops with undo-stop discipline; external-change line shifting; re-render on re-show) and `VerticalDiffManager` (handler map, listeners, context keys `kursor.inlineDiffVisible` / `kursor.inlineDiffResource`). |
| `decorations.ts` | Red placeholder lines (`display:none` text + old text as `after.contentText` ghost text, `kursor.removedLineBackground`) and green whole-line decorations (`kursor.addedLineBackground`), rendered from the block list. |
| `codeLens.ts` | `✓ Accept · ✗ Reject` per block (`[fsPath, index]`), plus Accept all / Reject all on the first block when there are several. |
| `applyCode.ts` | `kursor.inlineEdit.applyCode {code,path?,language?}` (chat "Apply": whole-file diff; fast-apply merge through the model when the snippet is a fragment; create-file offer; fallback to selection/cursor) and `kursor.inlineEdit.insertAtCursor {code}`. |
| `spinner.ts` | Status-bar `$(loading~spin) Kursor: editing…` with line counter, `AbortController`, context key `kursor.inlineEditRunning` (Esc → `kursor.inlineEdit.cancel`). |
| `history.ts` | Prompt history in `workspaceState` (30 entries, most recent first). |
| `__tests__/diffBlocks.test.mjs` | Node tests for the pure modules (`node src/extension/inline/__tests__/diffBlocks.test.mjs`; bundles the `.ts` files with esbuild first). |

## Diff engine semantics (port of Continue's vertical diff, instant-apply variant)

* The region is replaced by `plan.lines`: unchanged lines, one **empty placeholder line per removed
  line** (red, old text shown as ghost text so it cannot be edited) directly **above** the new lines (green).
* `DiffBlock { start, numRed, numGreen, oldLines }` — `start` is the first red line (or the first green
  line when nothing was removed).
* Accept block → delete its red placeholders (later blocks shift by `-numRed`). Reject block → replace
  `numRed + numGreen` lines with `oldLines` (shift `-numGreen`). Accept all / Reject all are single
  atomic edits over all blocks.
* Undo stops: apply `{before: true, after: false}`, block ops `{false, <last block>}`, all-ops
  `{false, true}` → an accepted edit is one undo unit; a rejected edit leaves the document as before.
  Ctrl+Z is bound to reject while `kursor.inlineDiffVisible`.
* User edits while a diff is visible: `onDidChangeTextDocument` (ignored during the handler's own
  edits) shifts blocks below the change; edits inside a green part grow/shrink it. Decorations are
  re-rendered from the blocks on every change and whenever the editor is re-shown.
* When the last block is resolved the handler is dropped, decorations cleared and context keys reset.
  Closing the document drops its pending diff.

## Flows

* **Ctrl+K** → prompt → *Edit selection* → spinner → diff. **Ctrl+K again** while the diff is visible →
  "Refine" prompt: a new instruction rejects the current diff and re-runs against the original text with
  the previous attempt as context; Accept all / Reject all are offered too.
* **Quick question** → `chat.sendPrompt(question, [selection], {mode:'ask'})`.
  **Send to chat** → `chat.addAttachment(selection)` + `chat.insertText(text)`.
* **Apply from chat** → see `applyCode.ts`. Fragment detection: `... existing code ...` style
  placeholders or a snippet much shorter than the file with different first/last lines.

## Context keys / commands / keybindings

`kursor.inlineDiffVisible`, `kursor.inlineDiffResource` (fsPath of the active editor's pending diff),
`kursor.inlineEditInputFocus`, `kursor.inlineEditRunning`. Commands: `open`, `acceptAll`, `rejectAll`
(Uri / fsPath / active editor), `acceptBlock`/`rejectBlock` (`[fsPath, index]` or nearest block to the
cursor), `quickQuestion`, hidden `applyCode`, `insertAtCursor`, `cancel`, `submit {action}`.
