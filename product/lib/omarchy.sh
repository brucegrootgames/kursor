# shellcheck shell=bash
# Kursor product scripts — Omarchy / Hyprland integration.
# Sourced by product/install.sh and product/uninstall.sh (needs common.sh, PRODUCT_DIR).
# Nothing here writes under /usr/share/omarchy: hooks go through `omarchy hook install`, bindings into the
# user's ~/.config/hypr/bindings.lua, the default editor into ~/.local/state/omarchy/defaults/editor.

omarchy_available() { have omarchy; }

omarchy_install_theme_hook() {
  omarchy hook install theme-set "$PRODUCT_DIR/omarchy/kursor-theme.hook" >/dev/null \
    || die "'omarchy hook install theme-set' failed"
  [[ -x $OMARCHY_HOOK_FILE ]] || die "hook was not installed at $OMARCHY_HOOK_FILE"
  ok "installed theme hook $OMARCHY_HOOK_FILE"
}

# Apply the current Omarchy theme to Kursor right away (the hook otherwise runs on the next `omarchy theme set`).
omarchy_run_theme_hook_once() {
  local theme=''
  have omarchy-theme-current && theme=$(omarchy-theme-current 2>/dev/null | tr '[:upper:]' '[:lower:]' | tr ' ' '-')
  [[ $theme == unknown ]] && theme=''   # omarchy-theme-current without a current theme link
  if PATH="$KURSOR_BIN_DIR:$PATH" bash "$OMARCHY_HOOK_FILE" "$theme"; then
    if [[ -f $OMARCHY_SKIP_TOGGLE ]]; then
      info "theme hook is opted out ($OMARCHY_SKIP_TOGGLE exists) — Kursor Dark stays"
    else
      ok "applied the current Omarchy theme${theme:+ ($theme)} to Kursor"
    fi
  else
    warn "theme hook reported an error — Kursor Dark stays active"
  fi
}

hypr_reload() {
  if [[ -n ${HYPRLAND_INSTANCE_SIGNATURE:-} ]] && have hyprctl; then
    if hyprctl reload >/dev/null 2>&1; then
      local errs
      errs=$(hyprctl configerrors 2>/dev/null || true)
      if [[ -n ${errs//[[:space:]]/} ]]; then
        warn "hyprctl configerrors:"
        printf '%s\n' "$errs" >&2
      else
        ok "Hyprland reloaded; hyprctl configerrors reports none"
      fi
    else
      warn "hyprctl reload failed — reload Hyprland by hand"
    fi
  else
    info "no running Hyprland session detected; the binding is active after the next reload/login"
  fi
}

omarchy_install_hypr_bind() {
  local f=$HYPR_BINDINGS_FILE
  mkdir -p -- "$(dirname -- "$f")"
  [[ -f $f ]] || : >"$f"
  if grep -qF -- "$HYPR_BIND_MARKER" "$f"; then
    ok "SUPER + SHIFT + K → Kursor already present in $f"
  elif grep -qF -- '"SUPER + SHIFT + K"' "$f"; then
    warn "$f already binds SUPER + SHIFT + K to something else — left untouched."
    warn "To bind Kursor yourself add:  $HYPR_BIND_LINE"
    return 0
  else
    [[ -s $f && -n $(tail -c 1 -- "$f") ]] && printf '\n' >>"$f"
    printf '%s\n' "$HYPR_BIND_LINE" >>"$f"
    ok "appended SUPER + SHIFT + K → Kursor to $f"
  fi
  hypr_reload
}

omarchy_remove_hypr_bind() {
  local f=$HYPR_BINDINGS_FILE tmp
  [[ -f $f ]] && grep -qF -- "$HYPR_BIND_MARKER" "$f" || return 0
  tmp="$f.tmp.$$"
  grep -vF -- "$HYPR_BIND_MARKER" "$f" >"$tmp" || true
  mv -- "$tmp" "$f"
  ok "removed the SUPER + SHIFT + K binding from $f"
  hypr_reload
}

omarchy_set_default_editor() {
  mkdir -p -- "$(dirname -- "$OMARCHY_DEFAULT_EDITOR_FILE")"
  printf 'kursor\n' >"$OMARCHY_DEFAULT_EDITOR_FILE"
  ok "Omarchy default editor → kursor (SUPER + SHIFT + N, omarchy-launch-editor, \$EDITOR in GUI apps)"
}

omarchy_unset_default_editor() {
  [[ -f $OMARCHY_DEFAULT_EDITOR_FILE ]] || return 0
  if [[ $(<"$OMARCHY_DEFAULT_EDITOR_FILE") == kursor ]]; then
    rm -f -- "$OMARCHY_DEFAULT_EDITOR_FILE"
    ok "Omarchy default editor reset (was kursor; Omarchy falls back to nvim — run 'omarchy default editor <name>' to pick another)"
  fi
}
