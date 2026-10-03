# shellcheck shell=bash
# Kursor product scripts — VSCodium download, verification, extraction and rebranding.
# Sourced by product/install.sh (needs common.sh, PRODUCT_DIR).

file_sha256() { sha256sum -- "$1" | awk '{print $1}'; }

# Prints the expected tarball hash: pinned for the default version, otherwise VSCodium's .sha256 sidecar.
vscodium_expected_sha256() {
  if [[ $KURSOR_VSCODIUM_VERSION == "$KURSOR_VSCODIUM_PINNED_VERSION" ]]; then
    printf '%s\n' "$KURSOR_VSCODIUM_PINNED_SHA256"
    return
  fi
  local side="$KURSOR_CACHE_DIR/$KURSOR_VSCODIUM_TARBALL.sha256"
  if [[ ! -s $side ]]; then
    info "fetching checksum for VSCodium $KURSOR_VSCODIUM_VERSION"
    curl -fsSL --retry 3 -o "$side.tmp" "$KURSOR_VSCODIUM_URL.sha256" || { rm -f -- "$side.tmp"; die "could not download $KURSOR_VSCODIUM_URL.sha256"; }
    mv -- "$side.tmp" "$side"
  fi
  awk 'NR == 1 { print $1 }' "$side"
}

# Ensures a verified tarball at $KURSOR_TARBALL_PATH (reuses the cache; re-downloads on mismatch).
vscodium_fetch() {
  mkdir -p -- "$KURSOR_CACHE_DIR"
  KURSOR_TARBALL_PATH="$KURSOR_CACHE_DIR/$KURSOR_VSCODIUM_TARBALL"
  local expected actual tmp progress=(-sS)
  expected=$(vscodium_expected_sha256)
  [[ $expected =~ ^[0-9a-f]{64}$ ]] || die "invalid expected checksum '$expected'"

  if [[ -f $KURSOR_TARBALL_PATH && ${FORCE_DOWNLOAD:-0} == 0 ]]; then
    info "verifying cached $KURSOR_TARBALL_PATH"
    if [[ $(file_sha256 "$KURSOR_TARBALL_PATH") == "$expected" ]]; then
      ok "sha256 ok — reusing cached download"
      return
    fi
    warn "cached tarball failed verification; downloading again"
    rm -f -- "$KURSOR_TARBALL_PATH"
  fi

  [[ -t 2 ]] && progress=(--progress-bar)
  info "downloading $KURSOR_VSCODIUM_URL"
  tmp="$KURSOR_TARBALL_PATH.part"
  curl -fL --retry 3 --retry-delay 2 -C - "${progress[@]}" -o "$tmp" "$KURSOR_VSCODIUM_URL" \
    || { rm -f -- "$tmp"; die "download failed: $KURSOR_VSCODIUM_URL"; }
  actual=$(file_sha256 "$tmp")
  if [[ $actual != "$expected" ]]; then
    rm -f -- "$tmp"
    die "sha256 mismatch for $KURSOR_VSCODIUM_TARBALL: expected $expected, got $actual"
  fi
  mv -- "$tmp" "$KURSOR_TARBALL_PATH"
  printf '%s  %s\n' "$expected" "$KURSOR_VSCODIUM_TARBALL" >"$KURSOR_TARBALL_PATH.sha256"
  ok "downloaded and verified (sha256 $expected)"
}

# vscodium_extract <staging-dir> — the tarball has no top-level directory, so it lands directly in the dir.
vscodium_extract() {
  local stage=$1
  info "extracting into $stage"
  tar -xzf "$KURSOR_TARBALL_PATH" -C "$stage"
  [[ -x $stage/codium && -f $stage/bin/codium && -f $stage/resources/app/product.json && -f $stage/resources/app/package.json ]] \
    || die "unexpected tarball layout (expected codium, bin/codium, resources/app/product.json)"
}

# replace_in_file <file> <old> <new> — literal replacement of every occurrence; returns 1 when <old> is absent.
# Uses bash substitution instead of sed so paths with sed metacharacters are safe. Keeps the file mode.
replace_in_file() {
  local file=$1 old=$2 new=$3 content
  content=$(<"$file")
  [[ $content == *"$old"* ]] || return 1
  printf '%s\n' "${content//"$old"/$new}" >"$file"
}

# kursor_rebrand <staging-dir> — turn the VSCodium tree into Kursor (names, ids, icon, launcher).
kursor_rebrand() {
  local stage=$1 app="$1/resources/app" launcher tmp pj pk comp

  # 1. Binaries: the Electron executable and the CLI launchers.
  mv -- "$stage/codium" "$stage/kursor"
  mv -- "$stage/bin/codium" "$stage/bin/kursor"
  [[ -f $stage/bin/codium-tunnel ]] && mv -- "$stage/bin/codium-tunnel" "$stage/bin/kursor-tunnel"

  # 2. bin/kursor (POSIX sh launcher): run the renamed executable, resolve our install dir, fix messages.
  launcher="$stage/bin/kursor"
  replace_in_file "$launcher" 'ELECTRON="$VSCODE_PATH/codium"' 'ELECTRON="$VSCODE_PATH/kursor"' \
    || die "launcher patch failed: ELECTRON line not found in bin/codium (VSCodium layout changed?)"
  replace_in_file "$launcher" "which -a 'codium'" "which -a 'kursor'" || true
  replace_in_file "$launcher" 'VSCODE_PATH="/usr/share/codium"' "VSCODE_PATH=\"$KURSOR_OPT_DIR\"" || true
  replace_in_file "$launcher" 'VSCodium' 'Kursor' || true
  replace_in_file "$launcher" '\`codium\`' '\`kursor\`' || true   # the file escapes its backticks
  grep -q 'ELECTRON="\$VSCODE_PATH/kursor"' "$launcher" || die "launcher patch verification failed"
  chmod 755 -- "$launcher"

  # 3. product.json — identity only; version, commit, checksums, quality and the Open VSX gallery stay as shipped.
  pj="$app/product.json"
  tmp=$(mktemp -- "$app/product.json.XXXXXX")
  jq --arg repo "$KURSOR_REPO_URL" '
    .nameShort = "Kursor"
    | .nameLong = "Kursor"
    | .applicationName = "kursor"
    | .dataFolderName = ".kursor"
    | .urlProtocol = "kursor"
    | .serverApplicationName = "kursor-server"
    | .serverDataFolderName = ".kursor-server"
    | .tunnelApplicationName = "kursor-tunnel"
    | .linuxIconName = "kursor"
    | .win32DirName = "Kursor"
    | .win32NameVersion = "Kursor"
    | .win32ShellNameShort = "Kursor"
    | if $repo != "" then
        .licenseUrl = ($repo + "/blob/main/LICENSE")
        | .reportIssueUrl = ($repo + "/issues/new")
        | .requestFeatureUrl = ($repo + "/issues/new")
        | .documentationUrl = ($repo + "#readme")
        | .releaseNotesUrl = ($repo + "/releases")
        | .keyboardShortcutsUrlLinux = ($repo + "/blob/main/docs/USAGE.md")
        | del(.introductoryVideosUrl, .tipsAndTricksUrl, .twitterUrl)
      else
        # No public repository configured: hide the Help-menu links that would otherwise point at VSCodium/Microsoft.
        del(.reportIssueUrl, .requestFeatureUrl, .documentationUrl, .releaseNotesUrl,
            .keyboardShortcutsUrlLinux, .keyboardShortcutsUrlMac, .keyboardShortcutsUrlWin,
            .introductoryVideosUrl, .tipsAndTricksUrl, .twitterUrl)
      end' "$pj" >"$tmp" || { rm -f -- "$tmp"; die "jq failed while patching product.json"; }
  chmod 644 -- "$tmp" && mv -- "$tmp" "$pj"
  jq -e --arg v "$KURSOR_VSCODIUM_VERSION" '
      .nameShort == "Kursor" and .nameLong == "Kursor" and .applicationName == "kursor"
      and .dataFolderName == ".kursor" and .urlProtocol == "kursor" and .version == $v
      and (.commit | type) == "string" and (.checksums | type) == "object"
      and (.extensionsGallery.serviceUrl | type) == "string"' "$pj" >/dev/null \
    || die "product.json verification failed after patching"

  # 4. package.json — Electron reads `name` and `desktopName`; desktopName gives the Wayland app_id "kursor".
  pk="$app/package.json"
  tmp=$(mktemp -- "$app/package.json.XXXXXX")
  jq '.name = "Kursor" | .desktopName = "kursor.desktop"' "$pk" >"$tmp" || { rm -f -- "$tmp"; die "jq failed while patching package.json"; }
  chmod 644 -- "$tmp" && mv -- "$tmp" "$pk"
  jq -e '.name == "Kursor" and .desktopName == "kursor.desktop" and (.main | type) == "string"' "$pk" >/dev/null \
    || die "package.json verification failed after patching"

  # 5. Window/about icon used by Electron on Linux.
  install -m644 -- "$PRODUCT_DIR/icons/kursor-1024.png" "$app/resources/linux/code.png"

  # 6. Shell completions ship under the old command name.
  comp="$stage/resources/completions"
  if [[ -f $comp/bash/codium ]]; then
    replace_in_file "$comp/bash/codium" codium kursor || true
    mv -- "$comp/bash/codium" "$comp/bash/kursor"
  fi
  if [[ -f $comp/zsh/_codium ]]; then
    replace_in_file "$comp/zsh/_codium" codium kursor || true
    mv -- "$comp/zsh/_codium" "$comp/zsh/_kursor"
  fi

  # 7. Marker consumed by re-runs / the uninstaller / humans.
  jq -n --arg v "$KURSOR_VSCODIUM_VERSION" --arg sha "$(vscodium_expected_sha256)" --arg repo "$REPO_DIR" \
        --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        '{product: "Kursor", vscodiumVersion: $v, tarballSha256: $sha, installedAt: $at, installer: "product/install.sh", sourceRepo: $repo}' \
    >"$stage/kursor-install.json"
  ok "rebranded VSCodium $KURSOR_VSCODIUM_VERSION as Kursor"
}

# Remove leftovers of interrupted runs (fixed prefix, so the globs can only match our own directories).
kursor_clean_stale_dirs() {
  local d
  shopt -s nullglob
  for d in "$KURSOR_OPT_DIR".staging.* "$KURSOR_OPT_DIR".old.*; do rm -rf -- "$d"; done
  shopt -u nullglob
}

# kursor_swap_in <staging-dir> — replace $KURSOR_OPT_DIR with the staged tree (one rename each way).
kursor_swap_in() {
  local stage=$1 old="$KURSOR_OPT_DIR.old.$$"
  [[ -e $KURSOR_OPT_DIR ]] && mv -- "$KURSOR_OPT_DIR" "$old"
  mv -- "$stage" "$KURSOR_OPT_DIR"
  [[ -e $old ]] && rm -rf -- "$old"
  ok "installed $KURSOR_OPT_DIR"
}
