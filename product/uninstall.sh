#!/bin/sh
# Kursor uninstaller bootstrap for Linux and macOS: same Node lookup as install.sh, then uninstall.mjs.
#   bash product/uninstall.sh [--yes] [--keep-config] [--purge]
set -eu
dir=$(cd "$(dirname "$0")" && pwd)
KURSOR_BOOTSTRAP_SCRIPT=uninstall.mjs exec sh "$dir/install.sh" "$@"
