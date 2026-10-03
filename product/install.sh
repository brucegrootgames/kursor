#!/bin/sh
# Kursor installer bootstrap for Linux and macOS: finds Node.js 18+ and runs install.mjs with the same
# arguments (bash product/install.sh --help lists them). POSIX sh so it also works with macOS's /bin/sh
# and bash 3.2. The real work — download, rebrand, desktop/app integration — is in install.mjs.
set -eu

dir=$(cd "$(dirname "$0")" && pwd)
script="${KURSOR_BOOTSTRAP_SCRIPT:-install.mjs}"

# node_ok <path> → 0 when it is Node >= 18
node_ok() {
  [ -x "$1" ] || return 1
  major=$("$1" -p 'process.versions.node.split(".")[0]' 2>/dev/null) || return 1
  [ "${major:-0}" -ge 18 ] 2>/dev/null
}

find_node() {
  if command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
    command -v node
    return 0
  fi
  for c in \
    "$HOME/.local/share/mise/shims/node" \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME/.local/share/fnm/aliases/default/bin/node" \
    "$HOME/.fnm/aliases/default/bin/node" \
    "$HOME/Library/Application Support/fnm/aliases/default/bin/node" \
    "$HOME/.nvm/versions/node"/*/bin/node \
    "$HOME/.asdf/shims/node"; do
    if node_ok "$c"; then
      printf '%s\n' "$c"
      return 0
    fi
  done
  return 1
}

if ! node=$(find_node); then
  printf '%s\n' \
    'error: Node.js 18 or newer is required to run the Kursor installer (it is not needed to use Kursor).' \
    '' \
    '  macOS:        brew install node          or https://nodejs.org' \
    '  Arch/Omarchy: sudo pacman -S nodejs npm  (or: mise use -g node@lts)' \
    '  Debian/Ubuntu/Fedora: see https://nodejs.org/en/download/package-manager' \
    '' \
    'Then re-run this script.' >&2
  exit 1
fi

exec "$node" "$dir/$script" "$@"
