#!/bin/bash
# =============================================================================
# Time Tracker - Linux Installation Script
# =============================================================================
# This script installs all required dependencies for the Time Tracker app
# on Linux (Ubuntu/Debian/Fedora).
#
# Usage:
#   chmod +x install_linux.sh
#   ./install_linux.sh
# =============================================================================

set -e

echo "=============================================="
echo "  Time Tracker - Linux Installation"
echo "=============================================="
echo ""

# Detect package manager
if command -v apt &> /dev/null; then
    PKG_MANAGER="apt"
    INSTALL_CMD="sudo apt install -y"
elif command -v dnf &> /dev/null; then
    PKG_MANAGER="dnf"
    INSTALL_CMD="sudo dnf install -y"
elif command -v pacman &> /dev/null; then
    PKG_MANAGER="pacman"
    INSTALL_CMD="sudo pacman -S --noconfirm"
else
    echo "[ERROR] Unsupported package manager"
    echo "[INFO] Please install dependencies manually"
    exit 1
fi

echo "[INFO] Detected package manager: $PKG_MANAGER"
echo ""

# =============================================================================
# Step 1: Install system packages for Wayland screenshot
# =============================================================================
echo "[STEP 1/3] Installing system packages for Wayland screenshot..."

if [ "$PKG_MANAGER" = "apt" ]; then
    # Ubuntu/Debian
    $INSTALL_CMD \
        python3-gi \
        python3-gi-cairo \
        gir1.2-gstreamer-1.0 \
        gstreamer1.0-pipewire \
        gstreamer1.0-plugins-base \
        libnotify-bin
        
elif [ "$PKG_MANAGER" = "dnf" ]; then
    # Fedora
    $INSTALL_CMD \
        python3-gobject \
        python3-cairo \
        gstreamer1-plugins-base \
        pipewire-gstreamer \
        libnotify
        
elif [ "$PKG_MANAGER" = "pacman" ]; then
    # Arch Linux
    $INSTALL_CMD \
        python-gobject \
        python-cairo \
        gst-plugins-base \
        gst-plugin-pipewire \
        libnotify
fi

echo "[OK] System packages installed"
echo ""

# =============================================================================
# Step 2: Install Python dependencies via pip
# =============================================================================
echo "[STEP 2/3] Installing Python dependencies..."

# Check if we're in a virtual environment
if [ -n "$VIRTUAL_ENV" ]; then
    echo "[INFO] Virtual environment detected: $VIRTUAL_ENV"
    PIP_CMD="pip install"
else
    echo "[INFO] No virtual environment - using user install"
    PIP_CMD="pip install --user"
fi

$PIP_CMD -r requirements.txt

echo "[OK] Python packages installed"
echo ""

# =============================================================================
# Step 3: Verify installation
# =============================================================================
echo "[STEP 3/3] Verifying installation..."

# Check PyGObject
python3 -c "from gi.repository import GLib, Gio; print('[OK] PyGObject (GLib/Gio)')" 2>/dev/null || \
    echo "[FAIL] PyGObject not available"

# Check GStreamer
python3 -c "import gi; gi.require_version('Gst', '1.0'); from gi.repository import Gst; print('[OK] GStreamer')" 2>/dev/null || \
    echo "[FAIL] GStreamer not available"

# Check PipeWire GStreamer plugin
gst-inspect-1.0 pipewiresrc &>/dev/null && echo "[OK] PipeWire GStreamer plugin" || \
    echo "[WARN] PipeWire GStreamer plugin not found (may need gstreamer1.0-pipewire)"

# Check PIL
python3 -c "from PIL import Image; print('[OK] Pillow')" 2>/dev/null || \
    echo "[FAIL] Pillow not available"

# Check pynput (for idle detection)
python3 -c "from pynput import mouse, keyboard; print('[OK] pynput (idle detection)')" 2>/dev/null || \
    echo "[WARN] pynput not available - idle detection disabled"

# Check notify-send
command -v notify-send &>/dev/null && echo "[OK] notify-send" || \
    echo "[WARN] notify-send not found (notifications disabled)"

echo ""
echo "=============================================="
echo "  Installation Complete!"
echo "=============================================="
echo ""
echo "IMPORTANT: For idle detection (pynput), add user to input group:"
echo "  sudo usermod -aG input \$USER"
echo "  Then log out and log back in"
echo ""
echo "To run the application:"
echo "  python3 desktop_app.py"
echo ""
echo "First time screenshot setup (Wayland):"
echo "  - A dialog will appear asking to share your screen"
echo "  - Select your screen and click 'Share'"
echo "  - Permission will be saved permanently"
echo ""
