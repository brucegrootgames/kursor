# Changelog

All notable changes to Kursor are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). Each release is a `vX.Y.Z` tag; CI
builds the extension and one bundle per platform from that tag.

## [Unreleased]

## [0.1.1] - 2026-10-03

### Added
- Brand identity: new Kursor mark (text cursor + code bracket), wordmark, palette and type guide (`docs/BRAND.md`); applied to app icons, the chat empty state, the Settings About tab, the Kursor Dark accent colours, the editor watermark, and the website (fonts, favicons, social card, Brand section).

## [0.1.0] - 2026-10-03

First public release.

### Added
- Agent chat in the secondary side bar with Agent / Ask / Plan modes, streaming replies, tool rows, @-mentions (files, folders, code, problems, terminal, git, web, rules), slash commands, image attachments, model and effort picker, context meter, queued messages and send-now.
- Permission cards (Run / Skip / Always allow), question cards and plan cards (Build / Reject) backed by Claude Code's permission system.
- Agent edit review: Keep / Undo / Review per file and per hunk, review bar, inline decorations, status-bar counter, checkpoint restore.
- Ctrl+K inline edit with in-place vertical diff and Accept / Reject CodeLens; quick question, whole-file edit, send to chat; Apply / Insert / Run from chat code blocks.
- Tab ghost-text completions with debounce, snooze and per-language opt-out.
- Terminal Ctrl+K command generation, commit-message generation, Fix in Chat / Add to Chat / Explain code actions, terminal context menu actions.
- Cursor rules support: `.cursor/rules/*.mdc`, `.cursorrules`, `AGENTS.md`, User Rules.
- Kursor Settings panel (Ctrl+Shift+J), chat history and Markdown export.
- IDE bridge so a `claude` started in the integrated terminal sees the editor (selection, diagnostics, diffs).
- Cross-platform installer (`product/install.mjs` with `install.sh` / `install.cmd` bootstraps) that downloads, verifies and rebrands VSCodium 1.135.06055 for Linux, macOS and Windows; release bundles via `npm run bundle` and GitHub Actions.
- Omarchy integration on Linux: theme hook, launcher entry, optional SUPER+SHIFT+K binding and default-editor hookup.
- "Kursor Dark" color theme.

### Fixed
- Installer and bundle builder use Windows' built-in `tar.exe` (bsdtar) instead of a GNU tar found on PATH, which misread `C:\` paths and cannot handle zip archives.

[Unreleased]: https://github.com/brucegrootgames/kursor/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/brucegrootgames/kursor/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/brucegrootgames/kursor/releases/tag/v0.1.0
