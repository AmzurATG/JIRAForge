#!/usr/bin/env bash
# =============================================================================
# JIRAForge Time Tracker — Linux Dependency Installer
# =============================================================================
# Detects the package manager and installs all system-level dependencies
# required for the desktop app on Linux (Wayland screenshots, D-Bus idle
# detection, GStreamer, notifications, etc.).
#
# Usage:
#   chmod +x install_linux.sh
#   ./install_linux.sh
# =============================================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

info()  { echo -e "${GREEN}[INFO]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
error() { echo -e "${RED}[ERROR]${NC} $*"; }

# ---------------------------------------------------------------------------
# Detect package manager
# ---------------------------------------------------------------------------

PKG_MANAGER=""
if command -v apt-get &>/dev/null; then
    PKG_MANAGER="apt"
elif command -v dnf &>/dev/null; then
    PKG_MANAGER="dnf"
elif command -v pacman &>/dev/null; then
    PKG_MANAGER="pacman"
else
    error "Unsupported package manager. Please install dependencies manually."
    exit 1
fi

info "Detected package manager: ${PKG_MANAGER}"

# ---------------------------------------------------------------------------
# Install system packages
# ---------------------------------------------------------------------------

install_apt() {
    info "Installing system dependencies via apt..."
    sudo apt-get update -qq

    sudo apt-get install -y --no-install-recommends \
        python3-gi \
        python3-gi-cairo \
        python3-dbus \
        gir1.2-gstreamer-1.0 \
        gir1.2-ayatanaappindicator3-0.1 \
        gstreamer1.0-pipewire \
        gstreamer1.0-plugins-base \
        gstreamer1.0-plugins-good \
        libnotify-bin \
        python3-dev \
        build-essential \
        pkg-config \
        xdotool \
        xprintidle \
        libdbus-1-dev \
        libglib2.0-dev \
        gnome-screenshot \
        scrot
}

install_dnf() {
    info "Installing system dependencies via dnf..."
    sudo dnf install -y \
        python3-gobject \
        python3-cairo \
        python3-dbus \
        gstreamer1-plugins-base \
        pipewire-gstreamer \
        libnotify \
        xdotool \
        xprintidle \
        dbus-devel \
        glib2-devel \
        pkg-config
}

install_pacman() {
    info "Installing system dependencies via pacman..."
    sudo pacman -S --noconfirm --needed \
        python-gobject \
        python-cairo \
        python-dbus \
        gst-plugins-base \
        gst-plugin-pipewire \
        gst-plugins-good \
        libnotify \
        xdotool \
        xprintidle \
        dbus \
        pkg-config \
        scrot
}

case "${PKG_MANAGER}" in
    apt)    install_apt ;;
    dnf)    install_dnf ;;
    pacman) install_pacman ;;
esac

# ---------------------------------------------------------------------------
# Install Python dependencies
# ---------------------------------------------------------------------------

info "Installing Python dependencies from requirements.txt..."
pip3 install --upgrade pip
pip3 install -r requirements.txt

# ---------------------------------------------------------------------------
# Verification
# ---------------------------------------------------------------------------

PASS=0
FAIL=0

check() {
    local label="$1"
    shift
    if "$@" &>/dev/null; then
        info "  ✓ ${label}"
        ((PASS++))
    else
        warn "  ✗ ${label}"
        ((FAIL++))
    fi
}

echo ""
info "Running dependency verification..."
echo ""

check "PyGObject (gi.repository.GLib)" \
    python3 -c "from gi.repository import GLib; print(GLib)"

check "GStreamer 1.0 (gi.repository.Gst)" \
    python3 -c "import gi; gi.require_version('Gst','1.0'); from gi.repository import Gst; Gst.init(None)"

check "PipeWire GStreamer plugin (pipewiresrc)" \
    python3 -c "
import gi; gi.require_version('Gst','1.0'); from gi.repository import Gst; Gst.init(None)
reg = Gst.Registry.get()
assert reg.find_feature('pipewiresrc', Gst.ElementFactory.__gtype__)
"

check "RapidOCR (rapidocr_onnxruntime)" \
    python3 -c "import rapidocr_onnxruntime"

check "notify-send" \
    command -v notify-send

check "xdotool" \
    command -v xdotool

check "ewmh (Python)" \
    python3 -c "from ewmh import EWMH"

check "dbus-python" \
    python3 -c "import dbus"

check "Pillow" \
    python3 -c "from PIL import Image"

check "psutil" \
    python3 -c "import psutil"

echo ""
info "Verification complete: ${PASS} passed, ${FAIL} failed"

if [ "${FAIL}" -gt 0 ]; then
    warn "Some checks failed. The app may still work with reduced functionality."
    warn "Re-run this script or install missing packages manually."
fi

echo ""
info "Installation complete! You can now run the desktop app:"
info "  python3 desktop_app.py"
