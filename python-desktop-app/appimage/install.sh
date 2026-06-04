#!/bin/bash
# =============================================================================
# TimeTracker – Linux Installer
#
# Usage:
#   bash install.sh                  # interactive install
#   bash install.sh --uninstall      # remove a previous installation
#   bash install.sh --help           # show usage
#
# What it does:
#   1. Marks the AppImage executable (avoids the manual chmod / Properties step)
#   2. Copies it to ~/Applications/  (creates the folder if needed)
#   3. Installs a .desktop entry so the app appears in the application launcher
#   4. Adds a desktop shortcut (optional, user-prompted)
#   5. Updates the desktop and MIME databases
# =============================================================================

set -e

APP_NAME="TimeTracker"
DESKTOP_FILE_NAME="timetracker.desktop"
INSTALL_DIR="${HOME}/Applications"
DESKTOP_DIR="${HOME}/.local/share/applications"
ICON_DIR="${HOME}/.local/share/icons/hicolor/256x256/apps"
ICON_NAME="timetracker"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
info()    { echo "  [INFO] $*"; }
ok()      { echo "  [ OK ] $*"; }
warn()    { echo "  [WARN] $*"; }
error()   { echo "  [ERR ] $*" >&2; }
die()     { error "$*"; exit 1; }
ask_yes() {
    # ask_yes "Question?" → returns 0 for yes, 1 for no
    local prompt="$1 [y/N] "
    while true; do
        read -r -p "  $prompt" choice
        case "$choice" in
            [Yy]|[Yy][Ee][Ss]) return 0 ;;
            [Nn]|[Nn][Oo]|"")  return 1 ;;
            *) echo "  Please answer y or n." ;;
        esac
    done
}

# ---------------------------------------------------------------------------
# Locate the AppImage
# ---------------------------------------------------------------------------
# The script lives next to the AppImage in the same directory.
SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"

find_appimage() {
    # Prefer an exact name match, then any *.AppImage in the same directory.
    if ls "${SCRIPT_DIR}/${APP_NAME}"*.AppImage 2>/dev/null | head -1 | grep -q .; then
        ls "${SCRIPT_DIR}/${APP_NAME}"*.AppImage 2>/dev/null | head -1
    elif ls "${SCRIPT_DIR}"/*.AppImage 2>/dev/null | head -1 | grep -q .; then
        ls "${SCRIPT_DIR}"/*.AppImage 2>/dev/null | head -1
    else
        echo ""
    fi
}

# ---------------------------------------------------------------------------
# Uninstall
# ---------------------------------------------------------------------------
do_uninstall() {
    echo ""
    echo "  Removing TimeTracker..."

    # Remove installed AppImage
    if [ -f "${INSTALL_DIR}/${APP_NAME}.AppImage" ]; then
        rm -f "${INSTALL_DIR}/${APP_NAME}.AppImage"
        ok "Removed ${INSTALL_DIR}/${APP_NAME}.AppImage"
    fi

    # Remove .desktop entry
    if [ -f "${DESKTOP_DIR}/${DESKTOP_FILE_NAME}" ]; then
        rm -f "${DESKTOP_DIR}/${DESKTOP_FILE_NAME}"
        ok "Removed .desktop entry"
    fi

    # Remove desktop shortcut
    local desk_shortcut="${HOME}/Desktop/${DESKTOP_FILE_NAME}"
    if [ -f "$desk_shortcut" ]; then
        rm -f "$desk_shortcut"
        ok "Removed desktop shortcut"
    fi

    # Remove icon
    if [ -f "${ICON_DIR}/${ICON_NAME}.png" ]; then
        rm -f "${ICON_DIR}/${ICON_NAME}.png"
        ok "Removed icon"
    fi

    # Refresh databases
    command -v update-desktop-database &>/dev/null && \
        update-desktop-database "${DESKTOP_DIR}" 2>/dev/null || true
    command -v gtk-update-icon-cache &>/dev/null && \
        gtk-update-icon-cache -f -t "${HOME}/.local/share/icons/hicolor" 2>/dev/null || true

    echo ""
    ok "TimeTracker has been uninstalled."
    echo ""
    exit 0
}

# ---------------------------------------------------------------------------
# Help
# ---------------------------------------------------------------------------
do_help() {
    echo ""
    echo "  Usage: bash install.sh [--uninstall] [--help]"
    echo ""
    echo "  Options:"
    echo "    (none)        Install TimeTracker for the current user"
    echo "    --uninstall   Remove a previously installed TimeTracker"
    echo "    --help        Show this help message"
    echo ""
    exit 0
}

# ---------------------------------------------------------------------------
# Argument parsing
# ---------------------------------------------------------------------------
for arg in "$@"; do
    case "$arg" in
        --uninstall|-u) do_uninstall ;;
        --help|-h)      do_help ;;
        *) die "Unknown option: $arg  (run with --help for usage)" ;;
    esac
done

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------
echo ""
echo "============================================"
echo "  TimeTracker – Linux Installer"
echo "============================================"
echo ""

# ---------------------------------------------------------------------------
# Step 1 – Locate the AppImage in the same directory as this script
# ---------------------------------------------------------------------------
info "Looking for AppImage..."
APPIMAGE_PATH="$(find_appimage)"
if [ -z "$APPIMAGE_PATH" ]; then
    die "No AppImage found in ${SCRIPT_DIR}/. Please keep install.sh next to the AppImage."
fi
APPIMAGE_FILENAME="$(basename "$APPIMAGE_PATH")"
ok "Found: $APPIMAGE_PATH"

# ---------------------------------------------------------------------------
# Step 2 – Make the AppImage executable RIGHT NOW
#           (this is the fix for the 'only Rename/Move to Trash' right-click issue)
# ---------------------------------------------------------------------------
info "Setting executable permission on the AppImage..."
chmod +x "$APPIMAGE_PATH"
ok "Executable bit set — you can now double-click the AppImage directly."

# ---------------------------------------------------------------------------
# Step 3 – Offer to install to ~/Applications/
# ---------------------------------------------------------------------------
echo ""
echo "  Installing to: ${INSTALL_DIR}/${APP_NAME}.AppImage"
echo ""

mkdir -p "${INSTALL_DIR}"
cp -f "$APPIMAGE_PATH" "${INSTALL_DIR}/${APP_NAME}.AppImage"
chmod +x "${INSTALL_DIR}/${APP_NAME}.AppImage"
ok "Installed: ${INSTALL_DIR}/${APP_NAME}.AppImage"

# ---------------------------------------------------------------------------
# Step 4 – Install icon
# ---------------------------------------------------------------------------
ICON_SRC="${SCRIPT_DIR}/timetracker.png"
if [ -f "$ICON_SRC" ]; then
    info "Installing application icon..."
    mkdir -p "${ICON_DIR}"
    cp -f "$ICON_SRC" "${ICON_DIR}/${ICON_NAME}.png"
    ok "Icon installed"
else
    warn "Icon file not found (${ICON_SRC}) — launcher will use a default icon."
fi

# ---------------------------------------------------------------------------
# Step 5 – Install .desktop entry (application launcher)
# ---------------------------------------------------------------------------
info "Installing application launcher entry..."
mkdir -p "${DESKTOP_DIR}"
cat > "${DESKTOP_DIR}/${DESKTOP_FILE_NAME}" <<EOF
[Desktop Entry]
Name=TimeTracker
GenericName=Time Tracker
Comment=Automatic time tracking for JIRA issues
Exec=${INSTALL_DIR}/${APP_NAME}.AppImage
Icon=${ICON_NAME}
Type=Application
Categories=Office;ProjectManagement;
Terminal=false
StartupNotify=false
Keywords=time;tracker;jira;productivity;
EOF
chmod 644 "${DESKTOP_DIR}/${DESKTOP_FILE_NAME}"
ok "Launcher entry created: ${DESKTOP_DIR}/${DESKTOP_FILE_NAME}"

# ---------------------------------------------------------------------------
# Step 6 – Optional desktop shortcut
# ---------------------------------------------------------------------------
echo ""
if ask_yes "Add a shortcut to your Desktop?"; then
    local DESK="${HOME}/Desktop"
    mkdir -p "$DESK"
    cp -f "${DESKTOP_DIR}/${DESKTOP_FILE_NAME}" "${DESK}/${DESKTOP_FILE_NAME}"
    # Mark the desktop file as trusted on GNOME (avoids the "Untrusted application" banner)
    if command -v gio &>/dev/null; then
        gio set "${DESK}/${DESKTOP_FILE_NAME}" metadata::trusted true 2>/dev/null || true
    fi
    chmod +x "${DESK}/${DESKTOP_FILE_NAME}"
    ok "Desktop shortcut created"
fi

# ---------------------------------------------------------------------------
# Step 7 – Refresh system databases
# ---------------------------------------------------------------------------
info "Refreshing desktop and icon caches..."
command -v update-desktop-database &>/dev/null && \
    update-desktop-database "${DESKTOP_DIR}" 2>/dev/null && ok "Desktop database updated" || \
    warn "update-desktop-database not found — skipping"
command -v gtk-update-icon-cache &>/dev/null && \
    gtk-update-icon-cache -f -t "${HOME}/.local/share/icons/hicolor" 2>/dev/null && ok "Icon cache updated" || \
    warn "gtk-update-icon-cache not found — skipping"

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------
echo ""
echo "============================================"
echo "  Installation complete!"
echo "============================================"
echo ""
echo "  You can now launch TimeTracker from:"
echo "    • Your application launcher (search 'TimeTracker')"
if [ -f "${HOME}/Desktop/${DESKTOP_FILE_NAME}" ]; then
echo "    • Your Desktop shortcut"
fi
echo "    • Terminal: ${INSTALL_DIR}/${APP_NAME}.AppImage"
echo ""
echo "  To uninstall later, run:"
echo "    bash install.sh --uninstall"
echo ""
