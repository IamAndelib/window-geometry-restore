#!/bin/sh
# Install, upgrade or uninstall Window Geometry Restore from source.
#
# Usage: ./install.sh            install (or upgrade) and enable
#        ./install.sh --uninstall

set -eu

SCRIPT_NAME="windowgeometryrestore"
ROOT_DIR="$(cd "$(dirname "$0")" && pwd)"
SRC_DIR="$ROOT_DIR/src"

info() { printf '%s\n' "$*"; }
die()  { printf 'Error: %s\n' "$*" >&2; exit 1; }

command -v kpackagetool6 >/dev/null 2>&1 || die "kpackagetool6 not found - KDE Plasma 6 is required"
command -v kwriteconfig6 >/dev/null 2>&1 || die "kwriteconfig6 not found - KDE Plasma 6 is required"

if command -v qdbus >/dev/null 2>&1; then
    QDBUS=qdbus
elif command -v qdbus6 >/dev/null 2>&1; then
    QDBUS=qdbus6
else
    die "qdbus not found - KDE Plasma 6 is required"
fi

reconfigure() {
    "$QDBUS" org.kde.KWin /KWin reconfigure
}

if [ "${1-}" = "--uninstall" ]; then
    info "Uninstalling $SCRIPT_NAME..."
    kpackagetool6 --type=KWin/Script -r "$SCRIPT_NAME" || true
    reconfigure
    info "Uninstalled."
    exit 0
fi

[ -f "$SRC_DIR/metadata.json" ] || die "source not found at $SRC_DIR (run this script from the repo)"
command -v zip >/dev/null 2>&1 || die "zip not found - install it (e.g. 'sudo dnf install zip') and retry"

TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT INT TERM
PKG="$TMP_DIR/$SCRIPT_NAME.kwinscript"

info "Packaging..."
(cd "$ROOT_DIR" && zip -rq "$PKG" src)

info "Installing..."
kpackagetool6 --type=KWin/Script -i "$PKG" 2>/dev/null || \
    kpackagetool6 --type=KWin/Script -u "$PKG" || die "installation failed"

info "Enabling..."
kwriteconfig6 --file kwinrc --group Plugins --key "${SCRIPT_NAME}Enabled" true
reconfigure

info "Installed and enabled. Configure it in System Settings > Window Management > KWin Scripts."
