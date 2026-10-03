#!/usr/bin/env bash
# Kursor installer — a rebranded VSCodium plus the Kursor extension, installed entirely under $HOME.
#
#   bash product/install.sh [options]
#
#   --vsix <path>      extension package to install (default: dist/kursor.vsix, built by `npm run package`)
#   --no-extension     skip installing the extension (editor only)
#   --with-icons       also install PKief.material-icon-theme from Open VSX and select it
#   --no-omarchy       skip the Omarchy theme hook (Kursor keeps the "Kursor Dark" theme)
#   --hypr-bind        bind SUPER + SHIFT + K to Kursor in ~/.config/hypr/bindings.lua and reload Hyprland
#   --default-editor   make Kursor Omarchy's default editor (~/.local/state/omarchy/defaults/editor)
#   --force-download   ignore the cached tarball and download VSCodium again
#   -h, --help         this text
#
# Environment: KURSOR_CACHE_DIR (default ~/.cache/kursor), KURSOR_VSCODIUM_VERSION (default 1.135.06055,
# other versions are verified against VSCodium's published .sha256), KURSOR_REPO_URL (Help-menu links).
#
# Idempotent: re-running upgrades ~/.local/opt/kursor and refreshes launcher/desktop files, but never
# overwrites ~/.config/Kursor/User/settings.json, keybindings.json, ~/.kursor/argv.json or
# ~/.config/kursor-flags.conf once they exist. No sudo anywhere; nothing under /usr is touched.
set -euo pipefail

PRODUCT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "$PRODUCT_DIR/.." && pwd)
# shellcheck source=lib/common.sh
source "$PRODUCT_DIR/lib/common.sh"
# shellcheck source=lib/vscodium.sh
source "$PRODUCT_DIR/lib/vscodium.sh"
# shellcheck source=lib/desktop.sh
source "$PRODUCT_DIR/lib/desktop.sh"
# shellcheck source=lib/omarchy.sh
source "$PRODUCT_DIR/lib/omarchy.sh"

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'; }

WITH_EXTENSION=1 WITH_OMARCHY=1 HYPR_BIND=0 DEFAULT_EDITOR=0 WITH_ICONS=0 FORCE_DOWNLOAD=0
VSIX="$REPO_DIR/dist/kursor.vsix"
while (($#)); do
  case $1 in
    --no-extension) WITH_EXTENSION=0 ;;
    --no-omarchy) WITH_OMARCHY=0 ;;
    --hypr-bind) HYPR_BIND=1 ;;
    --default-editor) DEFAULT_EDITOR=1 ;;
    --with-icons) WITH_ICONS=1 ;;
    --force-download) FORCE_DOWNLOAD=1 ;;
    --vsix) [[ $# -ge 2 ]] || die "--vsix needs a path"; VSIX=$2; shift ;;
    --vsix=*) VSIX=${1#--vsix=} ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done

# ---- preflight --------------------------------------------------------------------------------
[[ $(id -u) -ne 0 ]] || die "run this as your normal user, not root — everything installs under \$HOME"
[[ ${BASH_VERSINFO[0]} -ge 4 ]] || die "bash 4+ required"
require_cmds curl tar sha256sum jq install mktemp awk sed grep
[[ -d $HOME && -w $HOME ]] || die "\$HOME ($HOME) is not writable"
[[ -f $PRODUCT_DIR/icons/kursor-1024.png && -f $REPO_DIR/media/kursor.svg ]] || die "icon assets missing — run from a complete checkout"
if ((WITH_EXTENSION)); then
  [[ -f $VSIX ]] || die "extension package not found: $VSIX
       Build it first:   npm install && npm run package
       …or pass --vsix <path>, or --no-extension to install the editor only."
  VSIX=$(readlink -f -- "$VSIX")
fi

step "Kursor installer"
info "VSCodium $KURSOR_VSCODIUM_VERSION → $KURSOR_OPT_DIR"
info "command: $KURSOR_WRAPPER    settings: $KURSOR_USER_DIR    extensions: $KURSOR_DATA_DIR/extensions"
((WITH_EXTENSION)) && info "extension: $VSIX" || info "extension: skipped (--no-extension)"
plan=()
if omarchy_available; then
  ((WITH_OMARCHY)) && plan+=("theme hook") || plan+=("theme hook skipped (--no-omarchy)")
  ((DEFAULT_EDITOR)) && plan+=("default editor")
else
  plan+=("not detected (no 'omarchy' command)")
fi
((HYPR_BIND)) && plan+=("SUPER + SHIFT + K binding")
info "omarchy: $(IFS=,; printf '%s' "${plan[*]}" | sed 's/,/, /g')"
if kursor_running; then
  warn "Kursor is running. The upgrade proceeds; restart Kursor afterwards to pick it up."
fi

# ---- 1. VSCodium tarball ----------------------------------------------------------------------
step "1/6  VSCodium $KURSOR_VSCODIUM_VERSION"
vscodium_fetch

# ---- 2. extract + rebrand + swap --------------------------------------------------------------
step "2/6  Installing to $KURSOR_OPT_DIR"
mkdir -p -- "$(dirname -- "$KURSOR_OPT_DIR")"
kursor_clean_stale_dirs
STAGE=$(mktemp -d -- "$KURSOR_OPT_DIR.staging.XXXXXX")
cleanup_stage() { [[ -n ${STAGE:-} && -d $STAGE ]] && rm -rf -- "$STAGE"; return 0; }
trap cleanup_stage EXIT
vscodium_extract "$STAGE"
kursor_rebrand "$STAGE"
kursor_swap_in "$STAGE"
STAGE=''
trap - EXIT

# ---- 3. command, launcher, icons, mime --------------------------------------------------------
step "3/6  Command, desktop entries, icons"
install_wrapper
install_flags_file
install_icons
install_desktop_entries
install_mime

# ---- 4. seeded user files ---------------------------------------------------------------------
step "4/6  Default settings (only written when missing)"
seed_user_files

# ---- 5. extension -----------------------------------------------------------------------------
step "5/6  Kursor extension"
if ((WITH_EXTENSION)); then
  install_kursor_extension "$VSIX"
else
  info "skipped (--no-extension). Later:  \"$KURSOR_OPT_DIR/bin/kursor\" --install-extension dist/kursor.vsix --force"
fi
((WITH_ICONS)) && install_icon_theme

# ---- 6. omarchy -------------------------------------------------------------------------------
step "6/6  Omarchy / Hyprland"
if omarchy_available; then
  if ((WITH_OMARCHY)); then
    omarchy_install_theme_hook
    omarchy_run_theme_hook_once
  else
    info "theme hook skipped (--no-omarchy); Kursor keeps the Kursor Dark theme"
  fi
  ((DEFAULT_EDITOR)) && omarchy_set_default_editor
else
  info "Omarchy not detected — theme hook and default-editor steps skipped"
  ((DEFAULT_EDITOR)) && warn "--default-editor ignored: no 'omarchy' command found"
fi
if ((HYPR_BIND)); then
  omarchy_install_hypr_bind
else
  info "no Hyprland keybinding added (pass --hypr-bind for SUPER + SHIFT + K)"
fi

# ---- verify + next steps ----------------------------------------------------------------------
step "Verifying"
if ver=$("$KURSOR_OPT_DIR/bin/kursor" --version 2>/dev/null | head -n 1); then
  ok "kursor --version → ${ver:-?} (commit $(jq -r '.commit[0:10]' "$KURSOR_OPT_DIR/resources/app/product.json"))"
else
  warn "'$KURSOR_OPT_DIR/bin/kursor --version' failed — the install may be incomplete"
fi
jq -e '.nameShort == "Kursor"' "$KURSOR_OPT_DIR/resources/app/product.json" >/dev/null && ok "product.json rebranded (nameShort = Kursor, dataFolderName = .kursor)"

CLAUDE_BIN=$(command -v claude 2>/dev/null || true)
[[ -z $CLAUDE_BIN && -x $HOME/.local/bin/claude ]] && CLAUDE_BIN="$HOME/.local/bin/claude"

step "Done — next steps"
launch_lines="    Launch      kursor [path]            or the \"Kursor\" entry in your launcher"
((HYPR_BIND)) && launch_lines+=$'\n'"                SUPER + SHIFT + K"
((DEFAULT_EDITOR)) && launch_lines+=$'\n'"                SUPER + SHIFT + N  (Omarchy default editor)"
if [[ -n $CLAUDE_BIN ]]; then
  claude_line="                found: $CLAUDE_BIN"
else
  claude_line="                NOT FOUND on PATH — install Claude Code (https://claude.com/claude-code) or set kursor.claude.path in Kursor"
fi
current_theme=$(sed -nE 's/.*"workbench\.colorTheme"[[:space:]]*:[[:space:]]*"([^"]*)".*/\1/p' "$KURSOR_USER_DIR/settings.json" 2>/dev/null | head -n 1)
theme_lines="    Theme       \"${current_theme:-Kursor Dark}\" is selected in settings.json (Kursor Dark ships with the extension)."
if omarchy_available && ((WITH_OMARCHY)); then
  theme_lines+=$'\n'"                With the Omarchy hook Kursor follows \`omarchy theme set …\`; to keep Kursor Dark instead:"
  theme_lines+=$'\n'"                touch $OMARCHY_SKIP_TOGGLE"
fi
cat <<NEXT
$launch_lines

    Claude      Kursor drives the Claude Code CLI already on this machine — your own binary and login.
                Kursor stores no credentials; usage counts against your Claude plan.
$claude_line
                Not signed in yet?  run:  claude auth login     (or use the Sign in button in Kursor's chat)

$theme_lines

    Settings    $KURSOR_USER_DIR/settings.json   (yours — the installer never overwrites it)
                Ctrl+Shift+J inside Kursor opens the Kursor Settings panel; Ctrl+, the VS Code settings.
    Flags       $KURSOR_FLAGS_FILE
    Upgrade     re-run:  bash product/install.sh          Uninstall:  bash product/uninstall.sh
NEXT
