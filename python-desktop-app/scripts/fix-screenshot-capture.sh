#!/bin/bash
# TimeTracker: Fix Screenshot Capture
# Installs gstreamer1.0-pipewire and related packages required for
# Wayland screenshot capture (ScreenCast Portal via PipeWire).
#
# Usage: bash scripts/fix-screenshot-capture.sh
#        sudo bash scripts/fix-screenshot-capture.sh  (on systems without sudo)
#
# Supports: Ubuntu/Debian, Fedora/RHEL, Arch/Manjaro

set -e

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

ok()   { echo -e "${GREEN}✓${NC} $*"; }
fail() { echo -e "${RED}✗${NC} $*"; }
warn() { echo -e "${YELLOW}⚠${NC} $*"; }

# Detect distro from /etc/os-release
DISTRO_ID="unknown"
if [ -f /etc/os-release ]; then
    # shellcheck disable=SC1091
    source /etc/os-release
    DISTRO_ID="${ID:-unknown}"
fi

echo "=== TimeTracker: Fix Screenshot Capture ==="
echo ""
echo "Detected distro: ${DISTRO_ID}"
echo ""

# ─── Step 1: Install packages ────────────────────────────────────────────────
echo "Step 1: Installing required packages..."

install_packages() {
    case "${DISTRO_ID}" in
        ubuntu|debian|linuxmint|pop|neon|zorin|elementary)
            sudo apt-get update -qq
            sudo apt-get install -y \
                gstreamer1.0-pipewire \
                pipewire \
                wireplumber \
                xdg-desktop-portal \
                xdg-desktop-portal-gnome \
                libgstreamer1.0-0 \
                gstreamer1.0-tools
            ;;
        fedora)
            sudo dnf install -y \
                gstreamer1-plugin-pipewire \
                pipewire \
                wireplumber \
                xdg-desktop-portal \
                xdg-desktop-portal-gnome \
                gstreamer1
            ;;
        rhel|centos|rocky|alma|ol)
            sudo dnf install -y \
                gstreamer1-plugin-pipewire \
                pipewire \
                wireplumber \
                xdg-desktop-portal \
                xdg-desktop-portal-gnome || \
            sudo yum install -y \
                gstreamer1-plugin-pipewire \
                pipewire \
                wireplumber \
                xdg-desktop-portal \
                xdg-desktop-portal-gnome
            ;;
        opensuse*|sles|sle)
            sudo zypper install -y \
                gstreamer-plugin-pipewire \
                pipewire \
                wireplumber \
                xdg-desktop-portal \
                xdg-desktop-portal-gnome
            ;;
        arch|manjaro|endeavouros|garuda|artix)
            sudo pacman -S --noconfirm \
                gst-plugin-pipewire \
                pipewire \
                wireplumber \
                xdg-desktop-portal \
                xdg-desktop-portal-gnome
            ;;
        *)
            warn "Unknown distro '${DISTRO_ID}'. Attempting apt install..."
            sudo apt-get install -y \
                gstreamer1.0-pipewire \
                pipewire \
                wireplumber \
                xdg-desktop-portal \
                xdg-desktop-portal-gnome || {
                fail "Could not install packages. Please install manually:"
                echo "  Packages needed: gstreamer1.0-pipewire pipewire wireplumber"
                echo "                   xdg-desktop-portal xdg-desktop-portal-gnome"
                exit 1
            }
            ;;
    esac
}

if install_packages; then
    ok "Packages installed successfully"
else
    fail "Package installation failed"
    exit 1
fi

# ─── Step 2: Restart PipeWire services ───────────────────────────────────────
echo ""
echo "Step 2: Restarting PipeWire services..."

restart_ok=true
systemctl --user restart pipewire 2>/dev/null && ok "pipewire restarted" || { warn "Could not restart pipewire (may already be running)"; restart_ok=false; }
systemctl --user restart pipewire-pulse 2>/dev/null && ok "pipewire-pulse restarted" || warn "pipewire-pulse not available (OK)"
systemctl --user restart wireplumber 2>/dev/null && ok "wireplumber restarted" || warn "wireplumber not available"

# Give services 1s to settle
sleep 1

# ─── Step 3: Verify installation ─────────────────────────────────────────────
echo ""
echo "Step 3: Verifying installation..."

all_ok=true

if gst-inspect-1.0 pipewiresrc &>/dev/null; then
    ok "gstreamer pipewiresrc plugin: AVAILABLE"
else
    fail "gstreamer pipewiresrc plugin: STILL MISSING"
    all_ok=false
fi

if pgrep -x pipewire &>/dev/null; then
    ok "PipeWire daemon: running"
else
    fail "PipeWire daemon: not running"
    warn "Try: systemctl --user start pipewire"
    all_ok=false
fi

if gdbus introspect --session \
        --dest org.freedesktop.portal.Desktop \
        --object-path /org/freedesktop/portal/desktop \
        2>/dev/null | grep -q ScreenCast; then
    ok "XDG ScreenCast portal: available"
else
    warn "XDG ScreenCast portal: not detected (may require logout/login to activate)"
fi

# ─── Summary ─────────────────────────────────────────────────────────────────
echo ""
echo "=== Summary ==="
if $all_ok; then
    ok "All required components installed and running."
    echo ""
    echo "Next steps:"
    echo "  1. Restart TimeTracker"
    echo "  2. When the screen sharing dialog appears, click 'Allow'"
    echo "  3. OCR will activate on the next screenshot capture"
else
    fail "Some components are still missing. Check the errors above."
    echo ""
    echo "Manual fix options:"
    echo "  Ubuntu/Debian: sudo apt install gstreamer1.0-pipewire pipewire wireplumber"
    echo "  Fedora:        sudo dnf install gstreamer1-plugin-pipewire pipewire wireplumber"
    echo "  Arch:          sudo pacman -S gst-plugin-pipewire pipewire wireplumber"
    exit 1
fi
