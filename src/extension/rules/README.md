# `rules/` — RulesService

Cursor-style rules, appended to Claude Code's system prompt for every chat session
(`ChatStore` calls `buildAppendix(cwd, contextPaths)`) and reused by Ctrl+K.

| file | vscode-free | role |
|---|---|---|
| `parse.ts` | yes | `.mdc` front matter (`description`, `globs` comma/flow/block list, `alwaysApply`) |
| `glob.ts` | yes | tiny glob matcher (`**`, `*`, `?`, `[…]`, `{a,b}`); patterns without `/` match file names anywhere, others match the relative path (also with an implicit `**/`) |
| `scan.ts` | yes | discovery: `.cursor/rules/**` (`.mdc`/`.md`), nested `.cursor/rules` dirs (bounded walk, scoped to their subtree), `.cursorrules` (legacy, always), `AGENTS.md` (always) |
| `appendix.ts` | yes | markdown builder with a 60k-char cap (proportional body truncation, then a hard cut) |
| `rules.ts` | no | `createRulesService()`: config (`kursor.rules.user`, `kursor.rules.useProjectRules`), per-cwd cache (30 s TTL), `FileSystemWatcher` on `**/.cursor/rules/**` and `**/{.cursorrules,AGENTS.md}` (debounced), `onDidChange` |

Rule kinds (`RuleInfo.kind`): `always` (alwaysApply), `auto` (globs), `agent`
(description only — indexed as "Read `path` when relevant"), `manual` (neither),
`legacy` (`.cursorrules`), `agents-md`.

Appendix layout:

```
# User rules
…
# Project rules (always)
## <name> (`.cursor/rules/x.mdc`)
…
# Project rules for the files in context
## <name> (`…`) — globs: src/api/**
…
# Other project rules
- Read `.cursor/rules/y.mdc` when relevant: <description>
- `.cursor/rules/z.mdc` (manual rule; the user can attach it with @z)
```

`CLAUDE.md` is intentionally not read here — Claude Code loads it itself.
