#!/usr/bin/env bash
# TimeTracker tarball installer for distributions without .deb/.rpm (Arch,
# immutable systems, users without root).
#
#   ./install.sh --system     install to /opt/timetracker (root; same layout as the packages)
#   ./install.sh --user       install to ~/.local/opt/timetracker (no root; no auto-update)
#   ./install.sh --uninstall  remove whichever install exists (user data is kept)
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
MODE="${1:---user}"
UUID="timetracker@amzur.com"

if [ -f "$HERE/TimeTracker/TimeTracker" ]; then
    SRC_BUNDLE="$HERE/TimeTracker"; SRC_SHARE="$HERE/share"; SRC_DESKTOP="$HERE/com.amzur.timetracker.desktop"
else    # running the copy kept inside an installation
    SRC_BUNDLE=""; SRC_SHARE="$HERE"; SRC_DESKTOP=""
fi

paths_for() {
    if [ "$1" = system ]; then
        PREFIX=/opt/timetracker; APPS=/usr/share/applications; ICONS=/usr/share/icons/hicolor
        EXT=/usr/share/gnome-shell/extensions; KWIN=/usr/share/kwin/scripts; BIN=/usr/local/bin
    else
        PREFIX="$HOME/.local/opt/timetracker"; APPS="$HOME/.local/share/applications"
        ICONS="$HOME/.local/share/icons/hicolor"; EXT="$HOME/.local/share/gnome-shell/extensions"
        KWIN="$HOME/.local/share/kwin/scripts"; BIN="$HOME/.local/bin"
    fi
}

install_mode() {
    local mode="$1"
    paths_for "$mode"
    [ -n "$SRC_BUNDLE" ] || { echo "run install.sh from the extracted tarball" >&2; exit 1; }
    [ "$mode" = system ] && [ "$(id -u)" != 0 ] && { echo "--system needs root (sudo)" >&2; exit 1; }
    rm -rf "$PREFIX"; mkdir -p "$PREFIX" "$APPS" "$ICONS" "$EXT" "$KWIN" "$BIN"
    cp -r "$SRC_BUNDLE/." "$PREFIX/"
    mkdir -p "$PREFIX/share"
    cp -r "$SRC_SHARE/." "$PREFIX/share/"
    cp "$HERE/install.sh" "$PREFIX/share/install.sh"
    cp -r "$SRC_SHARE/session-helper" "$PREFIX/session-helper"
    cp -r "$SRC_SHARE/icons/." "$ICONS/"
    rm -rf "$KWIN/timetracker-focus"; cp -r "$SRC_SHARE/kwin-script/timetracker-focus" "$KWIN/"
    sed "s|^Exec=.*|Exec=$PREFIX/TimeTracker|" "$SRC_DESKTOP" > "$APPS/com.amzur.timetracker.desktop"
    ln -sf "$PREFIX/TimeTracker" "$BIN/timetracker"

    if command -v gnome-shell >/dev/null 2>&1; then
        major=$(gnome-shell --version | sed -E 's/[^0-9]*([0-9]+).*/\1/')
        variant=esm; [ "$major" -lt 45 ] && variant=legacy
        rm -rf "$EXT/$UUID"; cp -r "$SRC_SHARE/gnome-extension/$variant/$UUID" "$EXT/"
        if [ "$mode" = user ]; then
            # A per-user extension trusts only this user's TimeTracker binary.
            mkdir -p "$HOME/.config/timetracker"
            echo "$PREFIX/TimeTracker" > "$HOME/.config/timetracker/extension-allowed-exe"
        fi
    fi
    command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q "$APPS" || true
    echo "TimeTracker installed to $PREFIX."
    echo "Start it from the applications menu. On GNOME, log out and back in once."
    [ "$mode" = user ] && echo "Note: --user installs do not update automatically; download new versions from the portal."
}

uninstall() {
    for mode in user system; do
        paths_for "$mode"
        [ -e "$PREFIX/TimeTracker" ] || continue
        [ "$mode" = system ] && [ "$(id -u)" != 0 ] && { echo "system install found: rerun with sudo" >&2; continue; }
        pkill -TERM -f "^$PREFIX/TimeTracker" 2>/dev/null || true
        rm -rf "$PREFIX" "$EXT/$UUID" "$KWIN/timetracker-focus" "$APPS/com.amzur.timetracker.desktop" \
               "$BIN/timetracker"
        find "$ICONS" -name 'com.amzur.timetracker.png' -delete 2>/dev/null || true
        echo "Removed $mode install ($PREFIX). Your data in ~/.local/share/TimeTracker was kept."
    done
}

case "$MODE" in
    --system) install_mode system ;;
    --user) install_mode user ;;
    --uninstall) uninstall ;;
    *) echo "usage: $0 --system | --user | --uninstall" >&2; exit 2 ;;
esac
