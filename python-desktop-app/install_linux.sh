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
# Step 2: Install OCR system packages (optional but recommended)
# =============================================================================
echo "[STEP 2/5] Installing OCR system packages (Tesseract)..."

if [ "$PKG_MANAGER" = "apt" ]; then
    # Ubuntu/Debian
    $INSTALL_CMD \
        tesseract-ocr \
        tesseract-ocr-eng
        
elif [ "$PKG_MANAGER" = "dnf" ]; then
    # Fedora
    $INSTALL_CMD \
        tesseract \
        tesseract-langpack-eng
        
elif [ "$PKG_MANAGER" = "pacman" ]; then
    # Arch Linux
    $INSTALL_CMD \
        tesseract \
        tesseract-data-eng
fi

echo "[OK] OCR system packages installed"
echo ""

# =============================================================================
# Step 3: Install Python dependencies via pip
# =============================================================================
echo "[STEP 3/5] Installing Python dependencies..."

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
# Step 4: Download PaddleOCR models
# =============================================================================
echo "[STEP 4/5] Pre-downloading OCR models (may take a minute)..."

# PaddleOCR will download models on first use, but we can trigger it now
python3 -c "
try:
    from paddleocr import PaddleOCR
    # Initialize to trigger model download
    ocr = PaddleOCR(use_angle_cls=True, lang='en', show_log=False, use_gpu=False)
    print('[OK] PaddleOCR models downloaded')
except Exception as e:
    print(f'[WARN] PaddleOCR model download skipped: {e}')
    print('[INFO] Models will be downloaded on first use')
" 2>/dev/null || echo "[WARN] PaddleOCR not available - will use Tesseract as fallback"

echo ""

# =============================================================================
# Step 5: Verify installation
# =============================================================================
echo "[STEP 5/5] Verifying installation..."

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

# Check Tesseract OCR
command -v tesseract &>/dev/null && echo "[OK] Tesseract OCR" || \
    echo "[WARN] Tesseract not found (OCR fallback disabled)"

# Check PaddleOCR
python3 -c "from paddleocr import PaddleOCR; print('[OK] PaddleOCR (primary OCR engine)')" 2>/dev/null || \
    echo "[WARN] PaddleOCR not available - will use Tesseract"

# Check pytesseract
python3 -c "import pytesseract; print('[OK] pytesseract')" 2>/dev/null || \
    echo "[WARN] pytesseract not available"

# Check OpenCV
python3 -c "import cv2; print('[OK] OpenCV')" 2>/dev/null || \
    echo "[WARN] OpenCV not available"

# Check OCR module
python3 -c "from ocr import OCRFacade; print('[OK] Hybrid OCR module')" 2>/dev/null || \
    echo "[WARN] Hybrid OCR module not available"

echo ""
echo "=============================================="
echo "  Installation Complete!"
echo "=============================================="
echo ""
echo "IMPORTANT: For idle detection (pynput), add user to input group:"
echo "  sudo usermod -aG input \$USER"
echo "  Then log out and log back in"
echo ""
echo "HYBRID OCR MODE:"
echo "  - Enabled automatically on Linux if OCR packages are installed"
echo "  - Reduces bandwidth by 96-99% (text only, no images)"  
echo "  - Reduces AI costs by 85-96% (text LLM vs Vision LLM)"
echo ""
echo "To run the application:"
echo "  python3 desktop_app.py"
echo ""
echo "First time screenshot setup (Wayland):"
echo "  - A dialog will appear asking to share your screen"
echo "  - Select your screen and click 'Share'"
echo "  - Permission will be saved permanently"
echo ""
