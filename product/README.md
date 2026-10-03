# `product/` — installer, uninstaller, bundle builder, desktop and Omarchy integration

Everything that turns a VSCodium release archive plus `dist/kursor.vsix` into *Kursor* on a user's machine — Linux, macOS
and Windows, x64 and arm64. One Node ≥ 18 script with zero dependencies, thin platform bootstraps around it, no sudo,
nothing written outside the user's account (unless `--system` is asked for on macOS/Windows).

```
product/
├── install.mjs              the installer: preflight → fetch+verify → extract → rebrand → swap in → integrate → seed → extension → verify
├── uninstall.mjs            reverses install.mjs per platform; asks before deleting user data
├── build-bundle.mjs         Kursor-<platform>-<arch>-<version>.tar.gz|zip = rebranded app + kursor.vsix + these scripts
├── install.sh / uninstall.sh      Linux + macOS bootstraps (POSIX sh): find Node 18+, exec the .mjs
├── install.ps1 / install.cmd      Windows bootstraps (+ uninstall.ps1 / uninstall.cmd)
├── lib/common.mjs           constants (version, pinned sha256, assets), per-platform paths, logging, prompts, run(),
│                            download + sha256, archive extraction, atomic swap, small fs helpers
├── lib/rebrand.mjs          VSCodium tree → Kursor for linux / darwin / win32 (+ describeTree for proofs)
├── lib/icons.mjs            ICNS and ICO writers (PNG payloads) + readers
├── lib/plist.mjs            minimal XML plist parser/serializer (Info.plist edits on any host)
├── lib/platform-linux.mjs   wrapper, .desktop files, hicolor icons, MIME, Omarchy hook / Hyprland bind / default editor, uninstall
├── lib/platform-darwin.mjs  ad-hoc codesign + quarantine, CLI symlinks, uninstall
├── lib/platform-win32.mjs   shortcuts (WScript.Shell via PowerShell), user Path, kursor:// registry, uninstall
├── omarchy/kursor-theme.hook  Omarchy theme-set hook (installed via `omarchy hook install theme-set`)
├── defaults/settings.json   seeded User/settings.json (JSONC, only when missing)
├── defaults/keybindings.json  seeded User/keybindings.json (empty: the extension binds everything)
├── defaults/argv.json       seeded ~/.kursor/argv.json (Linux: password-store gnome-libsecret; macOS/Windows get it without that key)
├── defaults/kursor-flags.conf  seeded ~/.config/kursor-flags.conf (Linux only)
├── icons/kursor-*.png       app icons 16…1024 px (kursor-256.png is also the extension icon); source of the ICNS/ICO
└── tools/keybindings-table.mjs  generates the README keybindings table from package.json
```

## What the installer produces

| | Linux | macOS | Windows |
|---|---|---|---|
| download cache | `~/.cache/kursor/VSCodium-linux-<arch>-<v>.tar.gz` | `~/Library/Caches/kursor/VSCodium-darwin-<arch>-<v>.zip` | `%LOCALAPPDATA%\kursor\cache\VSCodium-win32-<arch>-<v>.zip` |
| application | `~/.local/opt/kursor/` | `~/Applications/Kursor.app` | `%LOCALAPPDATA%\Programs\Kursor\` |
| headless CLI used by the installer | `bin/kursor` (sh) | `Contents/Resources/app/bin/kursor` (bash) | `Kursor.exe resources\app\out\cli.js` with `ELECTRON_RUN_AS_NODE=1` (what `bin\kursor.cmd` does, without cmd.exe quoting) |
| `kursor` for the user | `~/.local/bin/kursor` wrapper | symlink `~/.local/bin/kursor` (+ `/usr/local/bin` with `--system`) | `bin\kursor.cmd` through the user `Path` |
| user data | `~/.config/Kursor/User/` | `~/Library/Application Support/Kursor/User/` | `%APPDATA%\Kursor\User\` |
| extensions + argv.json | `~/.kursor/` | `~/.kursor/` | `%USERPROFILE%\.kursor\` |
| desktop | `kursor.desktop`, `kursor-url-handler.desktop`, hicolor icons, `mime/packages/kursor.xml` + two `mimeapps.list` defaults | LaunchServices (bundle in `~/Applications`), `kursor://` from `Info.plist` | `Start Menu\Programs\Kursor.lnk` (`--desktop-shortcut` too), `HKCU\Software\Classes\kursor` |
| integrity | — | `codesign --force --deep --sign - Kursor.app`, `xattr -dr com.apple.quarantine` | `rcedit --set-icon` only if `rcedit` is on PATH |
| marker | `kursor-install.json` in the app root | `Contents/Resources/kursor-install.json` | `kursor-install.json` in the app root |
| Omarchy (optional) | hook in `~/.config/omarchy/hooks/theme-set.d/`, `--hypr-bind` line in `~/.config/hypr/bindings.lua`, `--default-editor` → `~/.local/state/omarchy/defaults/editor` | — | — |

The installer verifies the result: `<cli> --version` must print the VSCodium version and `product.json`'s `nameShort`
must be `Kursor`. Re-runs upgrade the application directory (atomic rename, stale `*.staging.*`/`*.old.*` cleaned up),
rewrite launchers/shortcuts, and keep every seeded user file that already exists.

### The rebrand (`lib/rebrand.mjs`)

**All platforms — `resources/app/product.json`:** `nameShort`, `nameLong` → `Kursor`; `applicationName` → `kursor`;
`dataFolderName` → `.kursor`; `sharedDataFolderName` → `.kursor-shared`; `urlProtocol` → `kursor`;
`serverApplicationName`/`serverDataFolderName`/`tunnelApplicationName` → `kursor-server`/`.kursor-server`/`kursor-tunnel`;
`linuxIconName` → `kursor`; `win32DirName`/`win32NameVersion`/`win32ShellNameShort`/`win32RegValueName` → `Kursor`;
`win32MutexName` → `kursor`; `win32AppUserModelId` → `Kursor.Kursor`; `win32TunnelServiceMutex`/`win32TunnelMutex`;
`darwinBundleIdentifier` → `com.kursor.editor`; `updateUrl`/`downloadUrl` (present in the macOS/Windows builds) removed.
With `KURSOR_REPO_URL` set, the Help-menu URLs point at that repository, otherwise they are deleted (VS Code hides the
entries). **Untouched:** `version`, `commit`, `quality`, `date`, `checksums` (so the "installation is corrupt" check
stays green), `extensionsGallery` (Open VSX), `builtInExtensions`, API proposals. `package.json`: `name` → `Kursor`,
`desktopName` → `kursor.desktop` (Wayland `app_id` / X11 `WM_CLASS`).

**Linux** (tarball, no top-level dir): `codium` → `kursor`, `bin/codium` → `bin/kursor` with
`ELECTRON="$VSCODE_PATH/kursor"` (the patch aborts if that anchor is missing), `which -a 'kursor'`, the `/usr/share/codium`
fallback → `$HOME/.local/opt/kursor`, messages; `bin/codium-tunnel` → `bin/kursor-tunnel`; `resources/app/resources/linux/code.png`
replaced; bash/zsh completions renamed.

**macOS** (`VSCodium.app` → `Kursor.app`): `Contents/Info.plist` — `CFBundleName`, `CFBundleDisplayName` → `Kursor`,
`CFBundleIdentifier` → `com.kursor.editor`, `CFBundleIconFile` → `Kursor.icns`, `CFBundleIconName`, HelpBook names,
`CFBundleURLTypes[0]` name/scheme → `Kursor`/`kursor`, "VSCodium document" type name. `CFBundleExecutable` stays
`VSCodium` (`Contents/MacOS/VSCodium`) so the helper apps and launcher keep working. `Contents/Resources/Kursor.icns` is
generated from `icons/kursor-*.png` (ICNS with PNG payloads: `ic11` 32, `ic12` 64, `ic07` 128, `ic08`/`ic13` 256,
`ic09`/`ic14` 512, `ic10` 1024) and `VSCodium.icns` removed. `Contents/Resources/app/bin/codium` → `bin/kursor` (it
resolves the bundle from its own path; only `which -a 'kursor'` changes), `bin/codium-tunnel` → `bin/kursor-tunnel`.
Signing happens on the Mac at install time.

**Windows** (portable zip): `VSCodium.exe` → `Kursor.exe`; `bin\codium.cmd` → `bin\kursor.cmd` (CRLF kept,
`"%~dp0..\Kursor.exe"`); `bin\codium` → `bin\kursor` (`NAME="Kursor"`, `APP_NAME="kursor"`);
`bin\codium-tunnel.exe` → `bin\kursor-tunnel.exe`; `Kursor.ico` (ICO with PNG entries 16/24/32/48/64/128/256) next to
the exe; `VSCodium.VisualElementsManifest.xml` → `Kursor.VisualElementsManifest.xml` (`ShortDisplayName="Kursor"`, tile
PNGs replaced).

### The theme hook

`omarchy/kursor-theme.hook` is a parametrised copy of `omarchy-theme-set-vscode`'s `set_theme` for the Kursor paths
(`KURSOR_SETTINGS`, `KURSOR_EXTENSIONS`, `KURSOR_CLI` overridable). Omarchy calls it after `omarchy theme set` with the
snake-cased theme name. Decision order: `~/.local/state/omarchy/current/theme/vscode.json` (`{name, extension}` — the
extension is installed from Open VSX if missing, the name validated before it is written) → generated
`vscode-theme.json` (registered as the local extension `local.omarchy-theme` in `~/.kursor/extensions/extensions.json`,
theme *Omarchy*) → fallback *Kursor Dark*. `workbench.colorTheme` is edited in place with `sed` because `settings.json`
is JSONC. Exit 0 when Kursor is not installed; honours `~/.local/state/omarchy/toggles/skip-kursor-theme-changes`.

## `uninstall.mjs`

Linux: application tree (+ stale staging dirs), wrapper, desktop entries, icons, MIME package and the two `mimeapps.list`
defaults, the hook, the tagged Hyprland binding (reloads Hyprland when running), the default-editor file if it says
`kursor`. macOS: `~/Applications/Kursor.app` and `/Applications/Kursor.app` (when writable), the two symlinks if they
point into a `Kursor.app`. Windows: both install locations (when writable), shortcuts, the `Path` entry, the
`HKCU\Software\Classes\kursor` key (only if its command points at `Kursor.exe`). Then asks (TTY) about the user data
directory, `~/.kursor` and the Linux flags file; `--yes` deletes them, `--keep-config` keeps them silently, `--purge`
also deletes the download cache. Without a TTY and without flags the user data is kept.

## Bundles and releases

`node product/build-bundle.mjs --platform <p> --arch <a>` runs `install.mjs --stage-only` for that target (so any host can
build any target — the Linux box builds the macOS and Windows bundles), then packs `app/` (`app/Kursor.app` on macOS),
`kursor.vsix`, `INSTALL.txt`, `LICENSE` and this directory's scripts into `dist/bundles/Kursor-<p>-<a>-<v>.tar.gz` (`.zip`
for Windows) plus a `.sha256`. `install.mjs` detects `app/` and `kursor.vsix` next to itself and installs from them
without downloading (`--from <dir>` does the same explicitly). `.github/workflows/release.yml` builds all six on a `v*` tag.

## Testing without touching your real home

```bash
# Rebrand only, for a foreign platform (download goes to KURSOR_CACHE_DIR, nothing is installed):
KURSOR_CACHE_DIR=/tmp/kc node product/install.mjs --stage-only /tmp/stage-mac --platform darwin --arch arm64
KURSOR_CACHE_DIR=/tmp/kc node product/install.mjs --stage-only /tmp/stage-win --platform win32 --arch x64

# Full Linux install + uninstall under a fake HOME (reuses your cached tarball):
T=$(mktemp -d)
env -u HYPRLAND_INSTANCE_SIGNATURE HOME="$T" XDG_CONFIG_HOME="$T/.config" XDG_DATA_HOME="$T/.local/share" \
    XDG_CACHE_HOME="$T/.cache" XDG_STATE_HOME="$T/.local/state" KURSOR_CACHE_DIR="$HOME/.cache/kursor" \
    bash product/install.sh --no-omarchy
HOME="$T" XDG_CONFIG_HOME="$T/.config" "$T/.local/bin/kursor" --version          # headless CLI, no window
env HOME="$T" XDG_CONFIG_HOME="$T/.config" XDG_DATA_HOME="$T/.local/share" KURSOR_CACHE_DIR="$T/.cache/kursor" \
    bash product/uninstall.sh --yes --purge
rm -rf "$T"
```

Override `XDG_*` as well as `HOME`: many sessions export them, and the scripts honour them. Unset
`HYPRLAND_INSTANCE_SIGNATURE` so `--hypr-bind` edits the fake `bindings.lua` without reloading your live compositor.
Point `KURSOR_CACHE_DIR` at a throw-away directory before testing `--purge`. The macOS signing / symlink and the
Windows shortcut / Path / registry steps only run on their own OS; `--stage-only` reports them as not executed.

## Bumping VSCodium

Change `VSCODIUM_PINNED_VERSION` and `PINNED_SHA256['linux-x64']` in `lib/common.mjs` (the hash is in the `.sha256` file
next to the release asset on GitHub; the other assets are verified against their published sidecars), re-run the three
`--stage-only` targets and the fake-home test above, and check the launcher diffs still show only the expected lines —
the rebrand aborts loudly if an anchor it patches (`ELECTRON=` line, `VSCodium.exe` in `codium.cmd`, `CFBundleURLTypes`)
disappears.
