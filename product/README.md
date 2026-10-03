# `product/` — installer, uninstaller, desktop and Omarchy integration

Everything that turns a VSCodium tarball plus `dist/kursor.vsix` into *Kursor* on a user's machine. Bash only, no sudo,
nothing written outside `$HOME`.

```
product/
├── install.sh                 entry point: preflight → fetch → rebrand → desktop → seeds → extension → Omarchy → verify
├── uninstall.sh               reverses install.sh; asks before deleting user data
├── lib/common.sh              constants (versions, sha256, every path), logging, confirm(), small helpers
├── lib/vscodium.sh            download + sha256 verification, extraction, the rebrand, atomic swap-in
├── lib/desktop.sh             ~/.local/bin/kursor wrapper, .desktop files, hicolor icons, MIME type, seeded files,
│                              headless extension install, --with-icons
├── lib/omarchy.sh             theme hook install/run, SUPER + SHIFT + K binding, default editor (+ their removal)
├── omarchy/kursor-theme.hook  Omarchy theme-set hook (installed via `omarchy hook install theme-set`)
├── defaults/settings.json     seeded ~/.config/Kursor/User/settings.json (JSONC, only when missing)
├── defaults/keybindings.json  seeded ~/.config/Kursor/User/keybindings.json (empty: the extension binds everything)
├── defaults/argv.json         seeded ~/.kursor/argv.json (password-store: gnome-libsecret)
├── defaults/kursor-flags.conf seeded ~/.config/kursor-flags.conf (comment-only template)
├── icons/kursor-*.png         app icons 16…1024 px (kursor-256.png is also the extension icon)
└── tools/keybindings-table.mjs  generates the README keybindings table from package.json (--write updates README.md)
```

## What `install.sh` produces

| Path | Content |
|---|---|
| `~/.cache/kursor/VSCodium-linux-x64-<v>.tar.gz` (+`.sha256`) | the download; reused on every re-run after re-verifying its hash |
| `~/.local/opt/kursor/` | the tarball (it has no top-level directory) with: `codium` → `kursor`, `bin/codium` → `bin/kursor` (launcher patched: `ELECTRON="$VSCODE_PATH/kursor"`, install path, messages), `bin/codium-tunnel` → `bin/kursor-tunnel`, `resources/app/product.json` patched, `resources/app/package.json` patched (`name: Kursor`, `desktopName: kursor.desktop`), `resources/app/resources/linux/code.png` replaced, shell completions renamed, `kursor-install.json` marker |
| `~/.local/bin/kursor` | wrapper: flags file → `--ozone-platform=wayland --enable-wayland-ime` when `WAYLAND_DISPLAY` is set (unless the flags file sets `--ozone-platform`) → `exec ~/.local/opt/kursor/bin/kursor "$@" flags…`; CLI-only invocations (`--version`, `--install-extension`, …) get no GUI flags |
| `~/.local/share/applications/kursor.desktop`, `kursor-url-handler.desktop` | absolute `Exec`, `Icon=kursor`, `StartupWMClass=kursor`, `MimeType=text/plain;inode/directory;application/x-kursor-workspace;` / `x-scheme-handler/kursor;` |
| `~/.local/share/icons/hicolor/{16…512}x…/apps/kursor.png`, `scalable/apps/kursor.svg` | icons (`gtk-update-icon-cache` only when the directory has an `index.theme`; otherwise GTK scans) |
| `~/.local/share/mime/packages/kursor.xml` + `~/.config/mimeapps.list` | `application/x-kursor-workspace` (glob `*.code-workspace`, weight 40 so VS Code's own type wins where present) and the `kursor://` scheme, both defaulting to `kursor.desktop` |
| `~/.kursor/argv.json`, `~/.config/Kursor/User/settings.json`, `…/keybindings.json`, `~/.config/kursor-flags.conf` | seeded only when missing |
| `~/.kursor/extensions/kursor.kursor-<ver>` | the extension (`bin/kursor --install-extension dist/kursor.vsix --force`, headless) |
| `~/.config/omarchy/hooks/theme-set.d/kursor-theme.hook` | the theme hook (Omarchy only, unless `--no-omarchy`) |
| `~/.config/hypr/bindings.lua` | `--hypr-bind`: one appended line tagged `-- kursor:install` |
| `~/.local/state/omarchy/defaults/editor` | `--default-editor`: `kursor` |

### `product.json` fields changed

`nameShort`, `nameLong` → `Kursor`; `applicationName` → `kursor`; `dataFolderName` → `.kursor`; `urlProtocol` → `kursor`;
`serverApplicationName`/`serverDataFolderName`/`tunnelApplicationName` → `kursor-server`/`.kursor-server`/`kursor-tunnel`;
`linuxIconName` → `kursor`; `win32DirName`/`win32NameVersion`/`win32ShellNameShort` → `Kursor`. With `KURSOR_REPO_URL`
set, `licenseUrl`, `reportIssueUrl`, `requestFeatureUrl`, `documentationUrl`, `releaseNotesUrl`,
`keyboardShortcutsUrlLinux` point at that repository; without it the Help-menu URLs are deleted (VS Code hides the
entries) and `licenseUrl` stays VSCodium's. **Untouched:** `version`, `commit`, `quality`, `date`, `checksums`
(so the "installation is corrupt" check stays green), `extensionsGallery` (Open VSX), `builtInExtensions`, API proposals.

Consequences of the identifiers: user data dir `~/.config/Kursor` (`$XDG_CONFIG_HOME/<nameShort>`), extensions and
`argv.json` under `~/.kursor` (`$HOME/<dataFolderName>`), Wayland `app_id` / X11 `WM_CLASS` `kursor` (from
`desktopName`), `vscode.env.appName` = `Kursor` (used by the IDE bridge's lock file), `kursor://` URL handling.

## The theme hook

`omarchy/kursor-theme.hook` is a parametrised copy of `omarchy-theme-set-vscode`'s `set_theme` for the Kursor paths
(`KURSOR_SETTINGS`, `KURSOR_EXTENSIONS`, `KURSOR_CLI` overridable). Omarchy calls it after `omarchy theme set` with the
snake-cased theme name. Decision order: `~/.local/state/omarchy/current/theme/vscode.json` (`{name, extension}` — the
extension is installed from Open VSX if missing, the name validated before it is written) → generated
`vscode-theme.json` (registered as the local extension `local.omarchy-theme` in `~/.kursor/extensions/extensions.json`,
theme *Omarchy*) → fallback *Kursor Dark*. `workbench.colorTheme` is edited in place with `sed` because `settings.json`
is JSONC. Exit 0 when Kursor is not installed; honours `~/.local/state/omarchy/toggles/skip-kursor-theme-changes`.

## `uninstall.sh`

Removes the application tree (and stale `.staging.*`/`.old.*` dirs), wrapper, desktop entries, icons, MIME package and
the two `mimeapps.list` defaults, the hook, the tagged Hyprland binding (reloads Hyprland when running), and the
default-editor file if it says `kursor`. Then asks (TTY) about `~/.config/Kursor`, `~/.kursor` and the flags file;
`--yes` deletes them, `--keep-config` keeps them silently, `--purge` also deletes `~/.cache/kursor`. Without a TTY and
without flags the user data is kept.

## Testing without touching your real home

```bash
T=$(mktemp -d)
env -u HYPRLAND_INSTANCE_SIGNATURE HOME="$T" XDG_CONFIG_HOME="$T/.config" XDG_DATA_HOME="$T/.local/share" \
    XDG_CACHE_HOME="$T/.cache" KURSOR_CACHE_DIR="$HOME/.cache/kursor" \
    bash product/install.sh --no-extension --no-omarchy          # reuses your cached tarball
jq '{nameShort,applicationName,dataFolderName}' "$T/.local/opt/kursor/resources/app/product.json"
HOME="$T" XDG_CONFIG_HOME="$T/.config" "$T/.local/bin/kursor" --version   # headless CLI, no window
env HOME="$T" XDG_CONFIG_HOME="$T/.config" XDG_DATA_HOME="$T/.local/share" KURSOR_CACHE_DIR="$T/.cache/kursor" \
    bash product/uninstall.sh --yes --purge
rm -rf "$T"
```

Override `XDG_*` as well as `HOME`: many sessions export them, and the scripts honour them. Unset
`HYPRLAND_INSTANCE_SIGNATURE` so `--hypr-bind` edits the fake `bindings.lua` without reloading your live compositor.
Point `KURSOR_CACHE_DIR` at a throw-away directory before testing `--purge`.

## Bumping VSCodium

Change `KURSOR_VSCODIUM_PINNED_VERSION` and `KURSOR_VSCODIUM_PINNED_SHA256` in `lib/common.sh` (the hash is in the
`.sha256` file next to the release asset on GitHub), re-run the fake-home test above, and check the launcher diff
(`diff <(tar -xzOf tarball ./bin/codium) ~/.local/opt/kursor/bin/kursor`) still shows only the expected lines — the
rebrand aborts loudly if the `ELECTRON=` line it patches disappears.
