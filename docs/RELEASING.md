# Releasing and keeping updates clean

Kursor follows a small, strict routine so every update is traceable and users can upgrade in one step.

## Commits

- One logical change per commit, written in the imperative with a type prefix:
  `feat:`, `fix:`, `docs:`, `chore:`, `refactor:`, `test:`, `release:`.
- The tree must pass `npm run typecheck`, `npm run build`, the unit tests
  (`node --test src/extension/*/__tests__/*.test.mjs src/webview/__tests__/*.test.mjs`) and
  `node scripts/smoke-load.mjs` before it is committed. CI runs the same checks on every push.
- Never commit `dist/`, `node_modules/`, screenshots with personal data, or scratch files.
- User-visible changes get a line under `## [Unreleased]` in `CHANGELOG.md` in the same commit.

## Versioning

- `package.json` `version` is the single source of truth and follows SemVer:
  patch for fixes, minor for features, major for breaking changes to settings, commands or the installer.
- The VSCodium base version is pinned separately in `product/lib/common.mjs` and noted in the changelog when it moves.

## Cutting a release

```bash
# 1. make sure main is clean and green
git switch main && git pull && npm ci && npm run package && node scripts/smoke-load.mjs

# 2. bump + changelog (moves [Unreleased] into a dated section, updates the compare links)
npm version 0.2.0 --no-git-tag-version
$EDITOR CHANGELOG.md
git commit -am "release: v0.2.0"

# 3. tag and push — the tag triggers .github/workflows/release.yml
git tag -a v0.2.0 -m "Kursor 0.2.0"
git push origin main --follow-tags
```

The release workflow builds `kursor.vsix` once, then one bundle per platform/arch on native runners
(Linux x64/arm64, macOS arm64/x64, Windows x64/arm64) and attaches everything, with `.sha256` sidecars,
to the GitHub Release for the tag. Fill in the release notes from the changelog section.

## Updating an installed Kursor

Users upgrade by downloading the new bundle and running its installer, or by `git pull` and re-running
`product/install.sh` / `product\install.cmd`. The installer replaces the application directory atomically,
reinstalls the extension, and never touches `settings.json`, `keybindings.json`, chats or extensions.

## Website

`site/` is deployed to GitHub Pages by `.github/workflows/pages.yml` on every push to `main` that touches it.
Keep screenshots free of personal data; regenerate them from a scratch workspace.
