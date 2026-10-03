#!/usr/bin/env bash
# Kursor uninstaller — reverses everything product/install.sh did.
#
#   bash product/uninstall.sh [options]
#
#   --yes            answer yes to every question (also deletes settings, extensions, flags)
#   --keep-config    never delete ~/.config/Kursor, ~/.kursor or ~/.config/kursor-flags.conf (no questions)
#   --purge          additionally delete the cached VSCodium download (~/.cache/kursor)
#   -h, --help       this text
#
# Always removed: ~/.local/opt/kursor, ~/.local/bin/kursor, desktop entries, icons, the MIME package and
# the two defaults it registered, the Omarchy theme hook, the SUPER + SHIFT + K binding this installer added,
# and the Omarchy default-editor setting if it points at kursor.
# Asked (default keep; kept without a TTY): ~/.config/Kursor (settings, state), ~/.kursor (extensions,
# argv.json), ~/.config/kursor-flags.conf. Nothing under /usr is touched; no sudo.
set -euo pipefail

PRODUCT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "$PRODUCT_DIR/.." && pwd)
# shellcheck source=lib/common.sh
source "$PRODUCT_DIR/lib/common.sh"
# shellcheck source=lib/omarchy.sh
source "$PRODUCT_DIR/lib/omarchy.sh"

usage() { sed -n '2,/^set -euo/p' "${BASH_SOURCE[0]}" | sed -e '$d' -e 's/^# \{0,1\}//'; }

ASSUME_YES=0 KEEP_CONFIG=0 PURGE=0
while (($#)); do
  case $1 in
    --yes | -y) ASSUME_YES=1 ;;
    --keep-config) KEEP_CONFIG=1 ;;
    --purge) PURGE=1 ;;
    -h | --help) usage; exit 0 ;;
    *) die "unknown option: $1 (try --help)" ;;
  esac
  shift
done
export ASSUME_YES

[[ $(id -u) -ne 0 ]] || die "run this as your normal user, not root"

step "Removing Kursor"
if kursor_running; then
  warn "Kursor appears to be running — close it first; the running instance keeps working until then"
fi

# application tree (+ leftovers of interrupted installs)
shopt -s nullglob
for d in "$KURSOR_OPT_DIR" "$KURSOR_OPT_DIR".staging.* "$KURSOR_OPT_DIR".old.*; do
  remove_path "$d"
done
shopt -u nullglob

remove_path "$KURSOR_WRAPPER"

# desktop entries
removed_desktop=0
for f in kursor.desktop kursor-url-handler.desktop; do
  if [[ -f $KURSOR_APPS_DIR/$f ]]; then rm -f -- "$KURSOR_APPS_DIR/$f"; removed_desktop=1; fi
done
if ((removed_desktop)); then
  have update-desktop-database && update-desktop-database -q -- "$KURSOR_APPS_DIR" 2>/dev/null || true
  ok "removed desktop entries from $KURSOR_APPS_DIR"
fi

# icons
removed_icons=0
for p in "$KURSOR_ICON_DIR"/*/apps/kursor.png "$KURSOR_ICON_DIR"/scalable/apps/kursor.svg; do
  [[ -f $p ]] && { rm -f -- "$p"; removed_icons=1; }
done
if ((removed_icons)); then
  touch -- "$KURSOR_ICON_DIR" 2>/dev/null || true
  if [[ -f $KURSOR_ICON_DIR/index.theme ]] && have gtk-update-icon-cache; then
    gtk-update-icon-cache -q -t -f -- "$KURSOR_ICON_DIR" 2>/dev/null || true
  fi
  ok "removed icons from $KURSOR_ICON_DIR"
fi

# mime type + the two defaults we registered (other lines of mimeapps.list are untouched)
if [[ -f $KURSOR_MIME_DIR/packages/kursor.xml ]]; then
  rm -f -- "$KURSOR_MIME_DIR/packages/kursor.xml"
  have update-mime-database && update-mime-database -- "$KURSOR_MIME_DIR" >/dev/null 2>&1 || true
  ok "removed MIME type application/x-kursor-workspace"
fi
if [[ -f $KURSOR_MIMEAPPS ]] && grep -qE '^(x-scheme-handler/kursor|application/x-kursor-workspace)=' "$KURSOR_MIMEAPPS"; then
  tmp="$KURSOR_MIMEAPPS.tmp.$$"
  grep -vE '^(x-scheme-handler/kursor|application/x-kursor-workspace)=' "$KURSOR_MIMEAPPS" >"$tmp" || true
  mv -- "$tmp" "$KURSOR_MIMEAPPS"
  ok "removed kursor defaults from $KURSOR_MIMEAPPS"
fi

# omarchy / hyprland
remove_path "$OMARCHY_HOOK_FILE" "Omarchy theme hook"
omarchy_remove_hypr_bind
omarchy_unset_default_editor

# ---- user data ---------------------------------------------------------------------------------
step "User data"
if ((KEEP_CONFIG)); then
  info "kept $XDG_CONFIG_HOME/Kursor, $KURSOR_DATA_DIR and $KURSOR_FLAGS_FILE (--keep-config)"
else
  if [[ ! -t 0 && $ASSUME_YES == 0 ]]; then
    info "no terminal to ask on — keeping settings, extensions and flags (use --yes to delete, --keep-config to silence this)"
  fi
  if [[ -d $XDG_CONFIG_HOME/Kursor ]]; then
    if confirm "Delete $XDG_CONFIG_HOME/Kursor (settings, keybindings, window state, workspace storage)?" n; then
      remove_path "$XDG_CONFIG_HOME/Kursor"
    else info "kept $XDG_CONFIG_HOME/Kursor"; fi
  fi
  if [[ -d $KURSOR_DATA_DIR ]]; then
    if confirm "Delete $KURSOR_DATA_DIR (installed extensions, argv.json)?" n; then
      remove_path "$KURSOR_DATA_DIR"
    else info "kept $KURSOR_DATA_DIR"; fi
  fi
  if [[ -f $KURSOR_FLAGS_FILE ]]; then
    if confirm "Delete $KURSOR_FLAGS_FILE?" n; then
      remove_path "$KURSOR_FLAGS_FILE"
    else info "kept $KURSOR_FLAGS_FILE"; fi
  fi
fi

if ((PURGE)); then
  remove_path "$KURSOR_CACHE_DIR" "cached download $KURSOR_CACHE_DIR"
elif [[ -d $KURSOR_CACHE_DIR ]]; then
  info "kept the cached VSCodium download in $KURSOR_CACHE_DIR (pass --purge to delete it)"
fi

step "Done"
info "Kursor has been removed. Your Claude Code CLI (claude) and its login were never touched."
