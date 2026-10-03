# edits/ — agent edit review (Keep / Undo / Review)

Claude Code applies edits to disk itself; the bridge snapshots each file before and after
`Edit|Write|NotebookEdit` (hooks) and the chat host calls `EditTracker.recordChange(chatId, change)`.

- `model.ts` — pure data: `TrackedFile {path, base, current, chatId, toolUseIds, version}`; hunks from
  jsdiff `structuredPatch(base, current, {context: 0})`; `lineStats`; `applyHunkForward` (accept one hunk
  into the base), `revertHunk` (undo one hunk in the document), `minimalReplacement` (common prefix/suffix
  so undoing a hunk only touches the changed range).
- `origProvider.ts` — `kursor-orig:<fsPath>?v=<n>` read-only documents serving the base snapshot (left side
  of review diffs; `?empty=1` used as the right side for deleted files).
- `decorations.ts` — whole-line `kursor.addedLineBackground` on added lines, dashed "− N lines removed"
  markers with hover preview, CodeLens `Keep · Undo` per hunk (+ file-level lenses on the first hunk).
  Recomputed against the live document (150 ms debounce) so user edits keep the hunks accurate.
- `editTracker.ts` — the `EditTracker` service, all `kursor.edits.*` commands, `kursor.hasPendingEdits`,
  the status bar item `$(diff-multiple) N files · Review`, review via `vscode.diff` / `vscode.changes`,
  persistence of pending snapshots in `workspaceState` (per-file ≤ 512 kB, total ≤ 4 MB).

Semantics: consecutive changes to one file coalesce (base = first `before`); a file whose content
returns to base (manual revert or agent re-edit) is dropped automatically; `undo` of a new file deletes it,
of a deleted file recreates it; `keep` just forgets the snapshot.
