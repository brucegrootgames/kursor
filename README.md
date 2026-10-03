<p align="center"><img src="brand/kursor-wordmark.svg" alt="Kursor" width="420"></p>

# Kursor

**Website:** https://brucegrootgames.github.io/kursor/ · **Releases:** https://github.com/brucegrootgames/kursor/releases · **Changelog:** [CHANGELOG.md](CHANGELOG.md) · **Release process:** [docs/RELEASING.md](docs/RELEASING.md) · **Brand:** [docs/BRAND.md](docs/BRAND.md)

Cursor-style AI coding: a rebranded [VSCodium](https://vscodium.com) plus the **Kursor** extension — agent chat,
Ctrl+K inline edits, Tab completions, terminal and commit helpers — all driven by the **Claude Code CLI that is already
installed and signed in on your machine**. Runs on Linux, macOS and Windows (x64 and arm64). Built first for
[Omarchy](https://omarchy.org) (Arch Linux + Hyprland, Wayland); the Omarchy bits are optional extras on Linux.

Kursor is an independent project. It is not affiliated with, endorsed by, or sponsored by Anthropic (Claude, Claude Code)
or Anysphere (Cursor). See [Compliance and licensing](#compliance-and-licensing).

**Status:** early (0.1.0). The whole tree typechecks and builds, the installer and Omarchy integration are exercised
headlessly in CI-style runs, and the Claude bridge was probed against Claude Code 2.1.263. Expect rough edges in the
GUI flows and please report them.

---

## Contents

- [What you get](#what-you-get)
- [Requirements](#requirements)
- [Install](#install)
- [First launch and sign-in](#first-launch-and-sign-in)
- [Features and keybindings](#features-and-keybindings)
- [How Kursor uses the Claude Code CLI](#how-kursor-uses-the-claude-code-cli)
- [Omarchy integration](#omarchy-integration)
- [Settings](#settings)
- [Files and locations](#files-and-locations)
- [Troubleshooting](#troubleshooting)
- [Uninstall](#uninstall)
- [Development](#development)
- [Compliance and licensing](#compliance-and-licensing)

## What you get

**The editor** — VSCodium 1.135.06055 (MIT, telemetry-free, Open VSX extension gallery), installed per user
(`~/.local/opt/kursor`, `~/Applications/Kursor.app` or `%LOCALAPPDATA%\Programs\Kursor`) and rebranded as *Kursor*: its
own user data directory, extensions directory (`~/.kursor/extensions`), `kursor` command, `kursor://` URL scheme,
launcher entry / app bundle / Start Menu shortcut, icons and its own look: the **Kursor Dark** colour theme built from
the brand palette (ink window, floating surface panels, violet accent, orchid cursor, its own syntax colours), VS Code's
Modern UI layout with rounded floating panels, the Inter-first UI font and a folded menu bar (see
[docs/BRAND.md](docs/BRAND.md#in-the-app)). No root/admin rights, no files outside your own account (see
[Files and locations](#files-and-locations)).

**The extension** (`dist/kursor.vsix`, installed into the editor by the installer):

| Area | What it does |
|---|---|
| Chat | Cursor-style agent pane in the secondary side bar. **Agent** (edits files and runs commands), **Ask** (read-only) and **Plan** (plan first, then **Build**) modes; model and effort pickers; streaming responses with thinking indicators and tool rows; permission cards (**Run / Skip / Always allow…**), question cards and plan cards; queued messages; `@` mentions (files, folders, code symbols, problems, terminal, git, rules…), `/` slash commands (Claude Code's own), image paste; history of past sessions (resume, delete); export to Markdown; "Open chat in editor". |
| Agent edits | Edits made by the agent are applied to disk by Claude Code, snapshotted before/after, highlighted inline, and reviewed with **Keep / Undo / Review** per hunk, per file and for everything (review bar + status bar). **Restore checkpoint** on any of your messages rewinds the files to that point (Claude Code's file checkpointing). |
| Ctrl+K inline edit | Select code, press Ctrl+K, describe the change: an in-place vertical diff (red removed lines, green added lines) with **Accept / Reject** per block, Ctrl+Enter / Ctrl+Backspace for all. Also quick questions about a selection, whole-file edits, "send to chat", and **Apply** from chat code blocks (fast-apply merge for fragments). |
| Tab | Ghost-text completions (`InlineCompletionItemProvider`), debounced, cheap (Haiku by default), cancellable, with a status-bar item to toggle, snooze, or disable per language. |
| Terminal | Ctrl+K in the integrated terminal: describe a command, get it, **Run / Insert / Edit prompt / Copy / Ask in chat**. Terminal output can be sent to chat (*Add Terminal Selection to Chat*, *Debug Terminal Output*). |
| Git | **Generate Commit Message** button in the Source Control view (conventional-commit style from the staged diff). |
| Code actions | Lightbulb: **Fix in Chat** for diagnostics; **Add to Chat**, **Explain with Kursor**, **Edit with Kursor (Ctrl+K)** for selections. |
| Rules | Cursor rules: `.cursor/rules/*.mdc` (front matter `description`, `globs`, `alwaysApply`), legacy `.cursorrules`, `AGENTS.md`, plus *User Rules* in settings. Appended to every session's system prompt; `CLAUDE.md` is handled by Claude Code itself. |
| Settings panel | **Kursor Settings** (Ctrl+Shift+J): Claude status, agents, Tab, models, rules, indexing, about. |
| IDE bridge | A `claude` started in Kursor's integrated terminal connects to Kursor like the official IDE integration: it sees your selection and diagnostics, opens diffs as tabs, and `kursor.ide.insertAtMention` sends `@file` references. |

## Requirements

- **Linux** x64/arm64 (tested on Omarchy — Arch + Hyprland; any desktop works), **macOS** 11+ (Apple silicon or Intel), or
  **Windows 10/11** x64/arm64.
- **Node.js 18+** — only to run the installer (and to build the extension from source). Kursor itself does not use it.
  macOS: `brew install node`; Arch/Omarchy: `sudo pacman -S nodejs npm`; Windows: `winget install OpenJS.NodeJS.LTS`;
  or <https://nodejs.org>.
- **Claude Code CLI** installed and signed in: `claude --version` and `claude auth status` should work in a terminal
  (Kursor was built against 2.1.263). Install instructions per OS: <https://code.claude.com/docs/en/setup>. Kursor does
  not need an API key.
- To build the extension from source: npm (comes with Node). Prebuilt bundles need nothing else.
- About 1 GB of disk for the editor plus the ~240 MB VSCodium download, cached in `~/.cache/kursor`,
  `~/Library/Caches/kursor` or `%LOCALAPPDATA%\kursor\cache`.

## Install

**From a release bundle** (no build step): download `Kursor-<platform>-<arch>-<version>.tar.gz` / `.zip` from the
[Releases](../../releases) page, unpack it, and run the installer inside:

```
Linux / macOS:   bash install.sh
Windows:         install.cmd            (PowerShell; double-click works too)
```

**From source:**

```bash
git clone <this repository> kursor && cd kursor
npm install
npm run package            # typecheck + production build + dist/kursor.vsix

bash product/install.sh    # Linux / macOS
product\install.cmd        # Windows (PowerShell)
```

`install.sh` / `install.cmd` only locate Node.js (PATH, mise, nvm, fnm, volta, Homebrew, the usual Windows locations)
and start `product/install.mjs`, a dependency-free Node script that does the same thing on every OS:

1. Downloads the matching VSCodium 1.135.06055 archive into the cache (skipped when already there) and verifies its
   SHA-256 (pinned for Linux x64, VSCodium's published `.sha256` for the others; other versions via
   `KURSOR_VSCODIUM_VERSION`). A release bundle already contains the rebranded editor, so this step is skipped.
2. Extracts it into a staging directory next to the install location, rebrands it (`product.json`: `nameShort`/`nameLong`
   *Kursor*, `applicationName` *kursor*, `dataFolderName` `.kursor`, `urlProtocol` *kursor*; `package.json`: `name`
   *Kursor*, `desktopName` `kursor.desktop`; binaries and CLI launchers renamed `codium` → `kursor`; icons generated from
   `product/icons/*.png` — ICNS on macOS, ICO on Windows; `Info.plist` identity on macOS), and swaps it into place
   atomically. Version, commit, checksums and the Open VSX gallery are left exactly as shipped.
3. Platform integration — **Linux:** `~/.local/bin/kursor` launcher (reads `~/.config/kursor-flags.conf`, adds
   `--ozone-platform=wayland --enable-wayland-ime` under Wayland), desktop entries, hicolor icons, MIME type for
   `*.code-workspace` / `kursor://`. **macOS:** ad-hoc `codesign` of the modified bundle, quarantine attribute removed,
   `~/.local/bin/kursor` → `Kursor.app/Contents/Resources/app/bin/kursor`. **Windows:** Start Menu shortcut, `<install>\bin`
   added to your user `Path`, `kursor://` protocol under `HKCU\Software\Classes`.
4. Seeds, **only when missing**, `argv.json`, `settings.json` (Cursor-like defaults, see [Settings](#settings)) and
   `keybindings.json` in the per-OS locations below.
5. Installs the extension headlessly: `<cli> --install-extension kursor.vsix --force`.
6. Linux with Omarchy: installs the theme hook (`omarchy hook install theme-set product/omarchy/kursor-theme.hook`) and
   runs it once. Then verifies (`kursor --version` must print `1.135.06055`) and prints the next steps for your OS.

Options (`--help` lists them all):

| Flag | Effect |
|---|---|
| `--vsix <path>` | extension package to install (default `dist/kursor.vsix`, or `kursor.vsix` inside a bundle) |
| `--no-extension` | editor only |
| `--with-icons` | also install `PKief.material-icon-theme` from Open VSX and select it |
| `--force-download` | ignore the cached archive |
| `--dry-run` | print the plan, change nothing |
| `--yes` | no questions |
| `--no-omarchy` | Linux: skip the Omarchy theme hook (Kursor keeps the Kursor Dark theme) |
| `--hypr-bind` | Linux: append `SUPER + SHIFT + K` → Kursor to `~/.config/hypr/bindings.lua`, then `hyprctl reload && hyprctl configerrors` |
| `--default-editor` | Linux: make Kursor Omarchy's default editor (`~/.local/state/omarchy/defaults/editor`) |
| `--system` | macOS/Windows: install for all users (`/Applications`, `%ProgramFiles%` — needs write access/elevation; never uses sudo itself) |
| `--desktop-shortcut`, `--no-protocol` | Windows: also create a desktop shortcut / skip the `kursor://` registration |
| `--stage-only <dir> --platform <p> --arch <a>` | download + verify + rebrand for any platform into `<dir>` without installing (what `npm run bundle` uses) |

Environment: `KURSOR_CACHE_DIR` (download cache), `KURSOR_VSCODIUM_VERSION`, `KURSOR_REPO_URL` (an https URL of this
repo; when set, Help › Report Issue / Documentation point at it, otherwise those menu entries are hidden).

**Upgrading** is re-running the installer. It replaces the application directory and refreshes launchers, shortcuts and
icons, but never overwrites `settings.json`, `keybindings.json`, `argv.json` or the flags file once they exist. Extensions
live outside the application directory and survive upgrades.

**macOS note.** The bundle is re-signed ad hoc after the rebrand (it cannot carry VSCodium's signature any more). If
macOS refuses the first launch, right-click `Kursor.app` → *Open* once. **Windows note.** `Kursor.exe` keeps VSCodium's
embedded icon unless [`rcedit`](https://github.com/electron/rcedit) is on `PATH` during install; shortcuts and the
Start Menu use `Kursor.ico` either way.

## First launch and sign-in

Run `kursor` (or `kursor .` in a project), pick *Kursor* in your launcher / Launchpad / Start Menu, or use
`SUPER + SHIFT + K` on Omarchy if you installed with `--hypr-bind` (Windows: open a new terminal first so the `Path`
change is picked up). The chat pane opens in the secondary side bar on the right (Ctrl+I toggles it).

Kursor checks the CLI on start (`claude --version` and `claude auth status --json`). If the CLI is missing or not signed
in, the chat shows a notice with **Sign in** (runs `claude auth login` in a terminal inside Kursor) and **Set path**
(`kursor.claude.path`). You can also run `claude auth login` in any terminal; Kursor re-checks when the login terminal
closes or when you run *Kursor: Claude Code Status* from the command palette.

## Features and keybindings

Cursor's defaults are mirrored where VS Code allows it. Because Ctrl+K becomes the inline-edit key, VS Code's `Ctrl+K …`
chords move to `Ctrl+R …` exactly like Cursor does. The table is generated from `package.json`
(`node product/tools/keybindings-table.mjs --write`).

<!-- KEYBINDINGS:BEGIN (generated by product/tools/keybindings-table.mjs --write) -->
**Chat**

| Shortcut | Action | When |
|---|---|---|
| `Ctrl+I` | Toggle Chat | not in terminal |
| `Ctrl+L` | Add Selection to New Chat | not in terminal · Ctrl+K prompt closed |
| `Ctrl+Shift+L` | Add Selection to Chat | editor |
| `Ctrl+N` / `Ctrl+T` | New Chat | chat focused |
| `Ctrl+Alt+'` | Chat History | chat focused |
| `Ctrl+Shift+Backspace` | Stop Generation | chat focused · generating |

**Agent edits**

| Shortcut | Action | When |
|---|---|---|
| `Ctrl+Enter` | Keep All Agent Edits | chat focused · pending agent edits · idle |
| `Ctrl+Shift+Backspace` | Undo All Agent Edits | chat focused · pending agent edits · idle |

**Inline edit (Ctrl+K)**

| Shortcut | Action | When |
|---|---|---|
| `Ctrl+K` | Edit with Kursor | editor · writable · no inline diff; editor · inline diff shown |
| `Ctrl+Enter` | Accept Inline Edit | editor · inline diff shown |
| `Ctrl+Backspace` / `Ctrl+Shift+Backspace` / `Ctrl+Z` | Reject Inline Edit | editor · inline diff shown |
| `Ctrl+Alt+Y` | Accept Inline Edit Block | editor · inline diff shown |
| `Ctrl+Alt+N` | Reject Inline Edit Block | editor · inline diff shown |
| `Esc` | Cancel Inline Edit | inline edit running · editor |
| `Alt+Enter` | Submit Inline Edit Prompt (question) | Ctrl+K prompt open |
| `Ctrl+Shift+Enter` | Submit Inline Edit Prompt (wholeFile) | Ctrl+K prompt open |
| `Ctrl+L` | Submit Inline Edit Prompt (sendToChat) | Ctrl+K prompt open |

**Terminal**

| Shortcut | Action | When |
|---|---|---|
| `Ctrl+K` | Generate Terminal Command | terminal |

**Tab completions**

| Shortcut | Action | When |
|---|---|---|
| `Alt+\` | Trigger Tab Completion | editor |

**Settings**

| Shortcut | Action | When |
|---|---|---|
| `Ctrl+Shift+J` | Kursor Settings |  |

**Cursor-style chords (VS Code built-ins)**

| Shortcut | Action | When |
|---|---|---|
| `Ctrl+R Ctrl+S` | Keyboard shortcuts |  |
| `Ctrl+R Ctrl+O` | Open folder |  |
| `Ctrl+R Ctrl+T` | Color theme |  |
| `Ctrl+R Ctrl+W` | Close all editors |  |
| `Ctrl+R Z` | Zen mode |  |
| `Ctrl+R Ctrl+C` | Add line comment | editor · writable |
| `Ctrl+R Ctrl+U` | Remove line comment | editor · writable |
| `Ctrl+R Ctrl+F` | Format document | editor · writable |
| `Ctrl+R Enter` | Keep editor (un-preview) | not in editor |
| `Ctrl+R Ctrl+0` | Fold all | editor |
| `Ctrl+R Ctrl+J` | Unfold all | editor |
<!-- KEYBINDINGS:END -->

Inside the chat input: **Enter** sends (while a turn is running it queues the message), **Shift+Enter** inserts a newline,
**Ctrl+Enter** sends immediately (interrupting the current turn) or approves a pending permission card, **Ctrl+.** and
**Shift+Tab** cycle Agent/Ask/Plan, **Ctrl+/** cycles the model, **@** opens the context picker, **/** the slash commands,
**Esc** closes a popover. Every command is also in the command palette under the *Kursor:* category.

A longer walkthrough of each feature is in `docs/USAGE.md` in the source repository.

## How Kursor uses the Claude Code CLI

- Kursor never talks to the Anthropic API itself. It spawns **your own, unmodified `claude` binary** through the Claude
  Agent SDK (`pathToClaudeCodeExecutable`), so the CLI uses its own login, settings (`~/.claude/settings.json`), hooks,
  MCP servers, `CLAUDE.md` files and slash commands. Kursor reads, stores or forwards **no credentials or tokens**.
- Executable resolution: `kursor.claude.path` → your login shell's `PATH` (`$SHELL -lic 'command -v claude'`, so mise or
  nvm shims work) → `~/.local/bin/claude` → `~/.local/share/mise/shims/claude` → the editor process `PATH`. The SDK's
  bundled binary is never used.
- Each chat is one long-lived `claude` process with streaming input (so follow-ups keep the context, and messages typed
  while it works are queued). Agent mode uses the permission mode from `kursor.agent.permissionMode`
  (`acceptEdits` by default: edits are applied, terminal commands ask). Ask mode disallows `Edit`/`Write`/`NotebookEdit`.
  Plan mode is Claude Code's native plan mode; **Build** approves the plan and switches to Agent.
- Permission prompts are rendered as cards and answered through the SDK's `canUseTool`; **Always allow…** entries are
  Claude Code's own suggestions (`setMode`, `addRules`) and are persisted by Claude Code, not by Kursor.
- Tab, Ctrl+K, terminal and commit requests are small one-shot `claude -p`-style calls without tools. **Everything counts
  against your Claude plan** (the chat footer shows the 5-hour window utilisation when the CLI reports it). Tab is
  debounced (`kursor.tab.debounceMs`, 900 ms) and uses Haiku by default; disable it per language or snooze it from the
  status bar if you want to save quota.
- Sessions are Claude Code sessions: they appear in `claude --resume`, and Kursor's history view lists the ones for the
  current workspace.

## Omarchy integration

- **Theme hook** — `product/omarchy/kursor-theme.hook` is installed with `omarchy hook install theme-set` into
  `~/.config/omarchy/hooks/theme-set.d/` and runs after every `omarchy theme set …`. It does for Kursor what
  `omarchy-theme-set-vscode` does for VS Code: if the theme ships `vscode.json` (`{name, extension}`) the extension is
  installed from Open VSX and the theme selected; otherwise the generated `vscode-theme.json` is exposed as the local
  *Omarchy* theme extension under `~/.kursor/extensions`; if neither exists Kursor falls back to *Kursor Dark*. Opt out:
  `touch ~/.local/state/omarchy/toggles/skip-kursor-theme-changes` (or install with `--no-omarchy`).
- **Launcher** — `kursor.desktop` appears in the Omarchy menu / app launcher; `StartupWMClass=kursor` matches the
  Wayland `app_id`, so window rules and focus-or-launch work (`omarchy-launch-or-focus kursor`).
- **SUPER + SHIFT + K** — `--hypr-bind` appends
  `o.bind("SUPER + SHIFT + K", "Kursor", "omarchy-launch-or-focus kursor 'uwsm-app -- kursor'")` to
  `~/.config/hypr/bindings.lua` (never touches `/usr/share/omarchy`), reloads Hyprland and shows `hyprctl configerrors`.
  It refuses to overwrite an existing `SUPER + SHIFT + K` binding and tells you the line to add instead.
- **Default editor** — `--default-editor` writes `kursor` to `~/.local/state/omarchy/defaults/editor`, so
  `SUPER + SHIFT + N`, `omarchy-launch-editor` and GUI apps that honour Omarchy's `$EDITOR` open Kursor. Omarchy's
  `$EDITOR` wrapper returns immediately for GUI editors; for git use `git config --global core.editor "kursor --wait"`.
- The installer never uses sudo and writes nothing under `/usr`; `uninstall.sh` removes all of the above again.
  (macOS and Windows have no Omarchy steps; `--hypr-bind`, `--default-editor` and `--no-omarchy` are ignored there.)

## Settings

Extension settings (`kursor.*`, also editable in the **Kursor Settings** panel, Ctrl+Shift+J):

| Setting | Default | Meaning |
|---|---|---|
| `kursor.claude.path` | `""` | path to `claude`; empty = auto-detect |
| `kursor.claude.model` / `kursor.claude.effort` | `""` | default chat model (`opus`, `sonnet`, `haiku`, `fable`, full id) and effort; empty = Claude Code default |
| `kursor.agent.defaultMode` | `agent` | mode new chats start in (`agent`, `ask`, `plan`) |
| `kursor.agent.permissionMode` | `acceptEdits` | `acceptEdits` (Cursor default), `default` (ask for everything), `auto`, `bypassPermissions` (Cursor "Run Everything") |
| `kursor.agent.inlineDiffs` | `true` | highlight agent edits in the editor with Keep/Undo |
| `kursor.agent.autoSave` | `true` | save dirty editors before the agent reads/writes |
| `kursor.agent.attachOpenFile` | `true` | tell the agent which file/selection is active |
| `kursor.agent.notifyOnPermission` | `true` | desktop notification when a permission card is waiting and the chat is hidden |
| `kursor.tab.enabled` / `debounceMs` / `model` / `disabledLanguages` / `contextLines` | `true` / `900` / `haiku` / `plaintext, markdown, log, scminput` / `120` | Tab completions |
| `kursor.inlineEdit.model` / `kursor.terminal.model` / `kursor.commit.model` | `sonnet` | models for Ctrl+K, terminal Ctrl+K and commit messages |
| `kursor.rules.user` | `""` | User Rules (applied to every chat) |
| `kursor.rules.useProjectRules` | `true` | read `.cursor/rules`, `.cursorrules`, `AGENTS.md` |
| `kursor.ide.enableServer` | `true` | IDE bridge for `claude` in the integrated terminal |
| `kursor.chat.showThinking` / `kursor.chat.toolCallDensity` | `true` / `balanced` | chat rendering |

Editor settings seeded into `~/.config/Kursor/User/settings.json` on first install (yours to change): Kursor Dark theme,
custom title bar with command center, menu bar folded into one button (`window.menuBarVisibility: compact`), activity
bar on top, secondary side bar visible, no welcome page, Nerd/mono font fallback list, built-in Copilot chat UI off
(`chat.disableAIFeatures`), ghost text on, auto-save after delay, workspace trust off, editor updates off
(`update.mode: none` — the editor is updated by re-running the installer, extensions update from Open VSX), telemetry
off. `keybindings.json` is seeded empty because the extension already contributes all Cursor-style shortcuts.

The extension contributes the rest of the look as defaults, so updates reach existing installs and anything you set
yourself wins: Kursor Dark, Modern UI floating panels (`workbench.experimental.modernUI`), the brand UI font stack
(`workbench.experimental.fontFamily`: Inter, Adwaita Sans, then the system sans), layout toggles in the title bar,
smooth cursor blinking and caret animation, and no minimap.

## Files and locations

| What | Linux | macOS | Windows |
|---|---|---|---|
| the rebranded editor | `~/.local/opt/kursor/` (`kursor` binary, `bin/kursor` CLI, `kursor-install.json` marker) | `~/Applications/Kursor.app` (`--system`: `/Applications`) | `%LOCALAPPDATA%\Programs\Kursor\` (`--system`: `%ProgramFiles%\Kursor`) |
| `kursor` command | `~/.local/bin/kursor` wrapper (flags file + Wayland flags; CLI calls such as `--version` pass through without GUI flags) | `~/.local/bin/kursor` → `Kursor.app/Contents/Resources/app/bin/kursor` (`--system` also `/usr/local/bin/kursor`) | `<install>\bin\kursor.cmd`, `<install>\bin` on the user `Path` |
| user data: `User/settings.json`, `User/keybindings.json`, state, logs | `~/.config/Kursor/` | `~/Library/Application Support/Kursor/` | `%APPDATA%\Kursor\` |
| extensions and `argv.json` | `~/.kursor/` | `~/.kursor/` | `%USERPROFILE%\.kursor\` |
| download cache | `~/.cache/kursor/` | `~/Library/Caches/kursor/` | `%LOCALAPPDATA%\kursor\cache\` |
| extra Chromium/Electron flags | `~/.config/kursor-flags.conf` | — (use `argv.json`) | — (use `argv.json`) |
| desktop integration | `~/.local/share/applications/kursor*.desktop`, `~/.local/share/icons/hicolor/*/apps/kursor.*`, `~/.local/share/mime/packages/kursor.xml` | LaunchServices picks the bundle up from `~/Applications` | `Start Menu\Programs\Kursor.lnk`, `HKCU\Software\Classes\kursor` |
| Omarchy theme hook | `~/.config/omarchy/hooks/theme-set.d/kursor-theme.hook` | — | — |
| IDE-bridge lock file (while Kursor runs) | `~/.claude/ide/<port>.lock` | same | `%USERPROFILE%\.claude\ide\<port>.lock` |

## Troubleshooting

**"Claude Code is not available" / Sign in keeps showing.** Run `claude --version` and `claude auth status` in a
terminal. If they work there but not in Kursor, the binary is probably only on the `PATH` of your interactive shell: set
`kursor.claude.path` to the output of `command -v claude` (for mise: `mise which claude`). Check *Kursor: Show Logs*
(Output panel, "Kursor") for the resolution steps. Sign in with `claude auth login`; Kursor stores nothing itself.

**`kursor: command not found`.** Linux/macOS: `~/.local/bin` is not on your `PATH` in that shell (Omarchy adds it for
login shells and the session; on macOS add `export PATH="$HOME/.local/bin:$PATH"` to your shell profile, or install
with `--system` for `/usr/local/bin`). Windows: open a new terminal — the `Path` change only applies to new ones.

**Wayland.** The launcher adds `--ozone-platform=wayland --enable-wayland-ime` when `WAYLAND_DISPLAY` is set. For
XWayland instead, put `--ozone-platform=x11` in `~/.config/kursor-flags.conf`; for scaling issues try
`--force-device-scale-factor=1.25`; for rendering glitches `--disable-gpu`. Fractional scaling and IME under Hyprland are
Chromium behaviours, not Kursor's.

**"Installation appears to be corrupt [Unsupported]".** VS Code shows this when the files listed in
`product.json` → `checksums` were modified. The installer only changes `product.json`/`package.json`/the icon, so a
fresh install never shows it. If it appears, something else (an extension that patches core files, a manual edit)
touched the editor's `resources/app/out`; re-run the installer to restore a clean tree.

**"The SUID sandbox helper binary was found, but is not configured correctly".** Chromium wants either a root-owned
`chrome-sandbox` or unprivileged user namespaces. Arch/Omarchy kernels have user namespaces enabled, so this should not
happen; if you disabled them, re-enable `kernel.unprivileged_userns_clone` or add `--no-sandbox` to the flags file
(less secure).

**Extensions.** Kursor uses the Open VSX gallery (like VSCodium), not the Microsoft marketplace. Most extensions are
there; a `.vsix` can always be installed with `kursor --install-extension file.vsix`.

**The theme changed to "Omarchy".** That is the theme hook following `omarchy theme set`. Keep Kursor Dark with
`touch ~/.local/state/omarchy/toggles/skip-kursor-theme-changes`, then pick *Kursor Dark* (Ctrl+R Ctrl+T).

**Tab completions do not appear.** Check the status-bar item (`Kursor Tab`): it shows off/snoozed/unavailable (the latter
when the CLI is not ready). Markdown and plaintext are disabled by default (`kursor.tab.disabledLanguages`). Completions
wait for a typing pause (`kursor.tab.debounceMs`); Alt+\ triggers one immediately.

**macOS: "Kursor.app is damaged / cannot be opened".** The app is signed ad hoc by the installer; right-click → *Open*
once, or re-run `bash product/install.sh` (it runs `codesign --force --deep --sign -` and clears the quarantine attribute).

**Kursor and VS Code side by side.** Both can run; they share nothing except your `claude` login. Only one editor's IDE
bridge is used by a given `claude` terminal (the one it was started from, via `CLAUDE_CODE_SSE_PORT`).

**Permission cards you never see.** When the chat is hidden, Kursor sets a badge on the view and, with
`kursor.agent.notifyOnPermission`, shows a notification with an *Open* button. The turn waits until you answer.

## Uninstall

```
Linux / macOS:   bash product/uninstall.sh            # or bash uninstall.sh inside a bundle
Windows:         product\uninstall.cmd

    --yes            delete settings, extensions and flags too, without asking
    --keep-config    keep them without being asked
    --purge          also delete the cached VSCodium download
```

Removes the application, the `kursor` command, desktop entries / shortcuts / `Path` entry / `kursor://` registration, the
Omarchy hook, keybinding and default-editor setting, then asks (TTY only; kept otherwise) about the user data directory,
`~/.kursor` and the flags file. Your `claude` installation and login are never touched.

## Development

```bash
npm install
npm run typecheck      # extension host + both webviews
npm run build          # dist/extension.js, dist/webview.js, dist/settings.js (+ codicons)
npm run watch
npm run package        # production build + dist/kursor.vsix
npm run install:kursor # = node product/install.mjs  (bash product/install.sh / product\install.cmd do the same)
npm run uninstall:kursor
npm run bundle -- --platform linux --arch x64   # redistributable Kursor-<platform>-<arch>-<version>.tar.gz|zip in dist/bundles
```

Releases: pushing a `v*` tag runs `.github/workflows/release.yml`, which builds the vsix on Ubuntu, then the six bundles
(linux/darwin/win32 × x64/arm64) on the native runners and attaches them to a GitHub Release.

Repository layout: `src/extension/**` (extension host: `claude/` bridge, `chat/`, `context/`, `edits/`, `inline/`, `tab/`,
`terminal/`, `scm/`, `actions/`, `settings/`, `ide/`, `rules/`), `src/webview/**` (chat UI, React), `src/webview-settings/**`
(settings panel), `src/shared/**` (host ↔ webview protocols), `media/` (icons, `themes/kursor-dark.json`), `product/`
(cross-platform installer, uninstaller, bundle builder, Omarchy hook, seeded defaults — see `product/README.md`), `docs/ARCHITECTURE.md` (design brief
and module contracts), `docs/USAGE.md` (user guide). Each extension module has a `README.md` describing its design.

To develop the extension against the installed editor: `kursor --extensionDevelopmentPath=$PWD` after `npm run build`.

## Compliance and licensing

- **Kursor** is not Cursor. *Cursor* is a trademark of Anysphere, Inc.; Kursor re-creates a similar workflow on top of
  open-source components and is not affiliated with, endorsed by, or derived from Cursor.
- *Claude* and *Claude Code* are trademarks of Anthropic, PBC. Kursor is not an Anthropic product. It launches the
  Claude Code CLI you installed, under your own account; your use of Claude Code through Kursor is governed by
  Anthropic's terms for your plan, and usage counts against that plan. Kursor contains no Anthropic code other than the
  published `@anthropic-ai/claude-agent-sdk` npm package it depends on.
- The editor is VSCodium (MIT) — a build of Microsoft's open-source VS Code without Microsoft branding, telemetry or
  marketplace. The rebrand changes names, identifiers and the icon only; Microsoft's marketplace is not used (Open VSX is).
  VS Code's Product Icons / branding are not included.
- Material Icon Theme (`--with-icons`) is by Philipp Kief, MIT, installed from Open VSX.
- This repository (extension, installer, theme, docs) is MIT licensed; see `package.json`. The Kursor Dark theme is
  generated from the Kursor palette by `scripts/build-theme.mjs`.
