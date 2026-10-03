# shellcheck shell=bash
# Kursor product scripts — shared constants and helpers.
# Sourced by product/install.sh and product/uninstall.sh; never executed directly.
#
# Everything is user-scoped (no sudo). Paths follow what the consuming program does:
#   * VSCodium honours XDG_CONFIG_HOME for its user data dir (~/.config/<nameShort> = ~/.config/Kursor)
#     but always uses $HOME/<dataFolderName> (= ~/.kursor) for extensions and argv.json.
#   * Omarchy uses $HOME/.config/omarchy and $HOME/.local/state/omarchy literally.

if [[ -z ${BASH_VERSION:-} ]]; then
  echo "kursor: these scripts require bash" >&2
  exit 1
fi

# ---- product constants ------------------------------------------------------------------------
KURSOR_VSCODIUM_VERSION="${KURSOR_VSCODIUM_VERSION:-1.135.06055}"
# sha256 of VSCodium-linux-x64-1.135.06055.tar.gz, verified against the .sha256 VSCodium publishes.
# Another version (KURSOR_VSCODIUM_VERSION=…) is verified against its published .sha256 sidecar instead.
KURSOR_VSCODIUM_PINNED_VERSION="1.135.06055"
KURSOR_VSCODIUM_PINNED_SHA256="c09d8ac8dd7f52b09ee159ee24b440541dfd8f937a0f6f88cc428c78e48ee1f2"
KURSOR_VSCODIUM_TARBALL="VSCodium-linux-x64-${KURSOR_VSCODIUM_VERSION}.tar.gz"
KURSOR_VSCODIUM_URL="https://github.com/VSCodium/vscodium/releases/download/${KURSOR_VSCODIUM_VERSION}/${KURSOR_VSCODIUM_TARBALL}"
# Optional https URL of this repository: when set, Help › Report Issue / Documentation point at it.
KURSOR_REPO_URL="${KURSOR_REPO_URL:-}"

# ---- locations --------------------------------------------------------------------------------
XDG_CONFIG_HOME="${XDG_CONFIG_HOME:-$HOME/.config}"
XDG_DATA_HOME="${XDG_DATA_HOME:-$HOME/.local/share}"
XDG_CACHE_HOME="${XDG_CACHE_HOME:-$HOME/.cache}"

KURSOR_CACHE_DIR="${KURSOR_CACHE_DIR:-$XDG_CACHE_HOME/kursor}"   # downloaded tarball (+ .sha256)
KURSOR_OPT_DIR="$HOME/.local/opt/kursor"                          # the rebranded VSCodium tree
KURSOR_BIN_DIR="$HOME/.local/bin"
KURSOR_WRAPPER="$KURSOR_BIN_DIR/kursor"                           # launcher wrapper (flags file, Wayland)
KURSOR_APPS_DIR="$XDG_DATA_HOME/applications"
KURSOR_ICON_DIR="$XDG_DATA_HOME/icons/hicolor"
KURSOR_MIME_DIR="$XDG_DATA_HOME/mime"
KURSOR_MIMEAPPS="$XDG_CONFIG_HOME/mimeapps.list"
KURSOR_USER_DIR="$XDG_CONFIG_HOME/Kursor/User"                    # settings.json, keybindings.json
KURSOR_DATA_DIR="$HOME/.kursor"                                   # extensions/, argv.json
KURSOR_FLAGS_FILE="$XDG_CONFIG_HOME/kursor-flags.conf"
KURSOR_INSTALL_MARKER="$KURSOR_OPT_DIR/kursor-install.json"

OMARCHY_HOOK_DIR="$HOME/.config/omarchy/hooks/theme-set.d"
OMARCHY_HOOK_FILE="$OMARCHY_HOOK_DIR/kursor-theme.hook"
OMARCHY_DEFAULT_EDITOR_FILE="$HOME/.local/state/omarchy/defaults/editor"
OMARCHY_SKIP_TOGGLE="$HOME/.local/state/omarchy/toggles/skip-kursor-theme-changes"
HYPR_BINDINGS_FILE="$HOME/.config/hypr/bindings.lua"
HYPR_BIND_MARKER="kursor:install"
# Focus an existing Kursor window (app_id "kursor") or launch one through uwsm, like Omarchy's own app binds.
printf -v HYPR_BIND_LINE '%s' \
  "o.bind(\"SUPER + SHIFT + K\", \"Kursor\", \"omarchy-launch-or-focus kursor 'uwsm-app -- kursor'\") -- $HYPR_BIND_MARKER"

# ---- output -----------------------------------------------------------------------------------
if [[ -t 1 && -z ${NO_COLOR:-} ]]; then
  C_BOLD=$'\e[1m' C_GREEN=$'\e[32m' C_YELLOW=$'\e[33m' C_RED=$'\e[31m' C_BLUE=$'\e[34m' C_RESET=$'\e[0m'
else
  C_BOLD='' C_GREEN='' C_YELLOW='' C_RED='' C_BLUE='' C_RESET=''
fi
step() { printf '\n%s==>%s %s%s%s\n' "$C_BLUE" "$C_RESET" "$C_BOLD" "$*" "$C_RESET"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '    %s✓%s %s\n' "$C_GREEN" "$C_RESET" "$*"; }
warn() { printf '    %s!%s %s\n' "$C_YELLOW" "$C_RESET" "$*" >&2; }
die()  { printf '%serror:%s %s\n' "$C_RED" "$C_RESET" "$*" >&2; exit 1; }

have() { command -v "$1" >/dev/null 2>&1; }

# require_cmds <cmd>… — abort with one message listing everything that is missing.
require_cmds() {
  local missing=() c
  for c in "$@"; do have "$c" || missing+=("$c"); done
  ((${#missing[@]} == 0)) || die "missing required commands: ${missing[*]} (on Arch: sudo pacman -S --needed ${missing[*]})"
}

# confirm <question> [default y|n] → 0 = yes. ASSUME_YES=1 answers yes; without a TTY the default applies.
confirm() {
  local q=$1 def=${2:-n} ans hint='[y/N]'
  [[ ${ASSUME_YES:-0} == 1 ]] && return 0
  if [[ ! -t 0 ]]; then [[ $def == y ]]; return; fi
  [[ $def == y ]] && hint='[Y/n]'
  read -r -p "    $q $hint " ans || ans=''
  ans=${ans,,}
  [[ -z $ans ]] && ans=$def
  [[ $ans == y || $ans == yes ]]
}

path_has_dir() { case ":$PATH:" in *":$1:"*) return 0 ;; *) return 1 ;; esac; }

kursor_running() { pgrep -f -- "$KURSOR_OPT_DIR/kursor" >/dev/null 2>&1; }

# Quote a path for a .desktop Exec= value (only when it needs it, per the Desktop Entry spec).
desktop_quote() {
  local p=$1
  if [[ $p =~ ^[A-Za-z0-9_./+:@,-]+$ ]]; then
    printf '%s' "$p"
  else
    p=${p//\\/\\\\}; p=${p//\"/\\\"}; p=${p//\$/\\\$}; p=${p//\`/\\\`}
    printf '"%s"' "$p"
  fi
}

# install_if_missing <src> <dest> — seed a user file once; never overwrite what the user has.
install_if_missing() {
  local src=$1 dest=$2
  if [[ -e $dest ]]; then
    info "kept existing $dest"
  else
    install -Dm644 -- "$src" "$dest"
    ok "wrote $dest"
  fi
}

# Remove a path and report; silent when it does not exist.
remove_path() {
  local p=$1 label=${2:-$1}
  if [[ -e $p || -L $p ]]; then
    rm -rf -- "$p"
    ok "removed $label"
  fi
}
