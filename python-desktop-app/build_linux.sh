#!/usr/bin/env bash
# =============================================================================
# JIRAForge Time Tracker — Linux PyInstaller Build Script
# Produces:  dist/timetracker          (standalone binary)
#            dist/timetracker_<ver>.deb (.deb installer package)
# =============================================================================

set -euo pipefail

APP_NAME="timetracker"
APP_DISPLAY_NAME="Time Tracker"
APP_VERSION="1.3.0"
APP_DESCRIPTION="Automatic time tracking with Jira integration"
MAINTAINER="Amzur Technologies <support@amzur.com>"

# ── Step 1: PyInstaller one-file build ──────────────────────────────────────

echo "[BUILD] Building TimeTracker for Linux..."

# ── Collect OCR engine hidden imports dynamically ───────────────────────────
# PyInstaller can't trace imports inside engine files added as --add-data,
# so we must explicitly list them.  We probe the Python env to use only
# packages actually installed so the build doesn't error on missing ones.
OCR_HIDDEN_IMPORTS=""
OCR_DATA_ARGS=""

_add_hidden() { OCR_HIDDEN_IMPORTS="$OCR_HIDDEN_IMPORTS --hidden-import $1"; }
_add_data()   { OCR_DATA_ARGS="$OCR_DATA_ARGS --add-data $1"; }

# RapidOCR + ONNX Runtime
if python3 -c "import rapidocr_onnxruntime" 2>/dev/null; then
    echo "[BUILD] rapidocr_onnxruntime detected — bundling"
    _add_hidden rapidocr_onnxruntime
    # Collect all submodules via a small Python helper
    for mod in $(python3 -c "
from PyInstaller.utils.hooks import collect_submodules
for m in collect_submodules('rapidocr_onnxruntime'):
    print(m)
" 2>/dev/null); do _add_hidden "$mod"; done
    # Collect data files (config.yaml, .onnx models)
    while IFS='|' read -r src dst; do
        _add_data "${src}:${dst}"
    done < <(python3 -c "
from PyInstaller.utils.hooks import collect_data_files
for src, dst in collect_data_files('rapidocr_onnxruntime'):
    print(f'{src}|{dst}')
" 2>/dev/null)
    echo "[BUILD] rapidocr_onnxruntime data files collected"
fi
if python3 -c "import onnxruntime" 2>/dev/null; then
    echo "[BUILD] onnxruntime detected — bundling"
    _add_hidden onnxruntime
    for mod in $(python3 -c "
from PyInstaller.utils.hooks import collect_submodules
for m in collect_submodules('onnxruntime'):
    print(m)
" 2>/dev/null); do _add_hidden "$mod"; done
    # Collect data files
    while IFS='|' read -r src dst; do
        _add_data "${src}:${dst}"
    done < <(python3 -c "
from PyInstaller.utils.hooks import collect_data_files
for src, dst in collect_data_files('onnxruntime'):
    print(f'{src}|{dst}')
" 2>/dev/null)
    echo "[BUILD] onnxruntime data files collected"
fi

# EasyOCR + PyTorch
if python3 -c "import easyocr" 2>/dev/null; then
    echo "[BUILD] easyocr detected — bundling"
    _add_hidden easyocr
    for mod in $(python3 -c "
from PyInstaller.utils.hooks import collect_submodules
for m in collect_submodules('easyocr'):
    print(m)
" 2>/dev/null); do _add_hidden "$mod"; done
    if python3 -c "import torch" 2>/dev/null; then
        echo "[BUILD] torch detected — bundling for EasyOCR"
        for mod in $(python3 -c "
from PyInstaller.utils.hooks import collect_submodules
for m in collect_submodules('torch') + collect_submodules('torchvision'):
    print(m)
" 2>/dev/null); do _add_hidden "$mod"; done
    fi
fi

# Shared deps
_add_hidden cv2
_add_hidden numpy
_add_hidden numpy.core
_add_hidden numpy.core.multiarray

# OCR package modules (PyInstaller can't trace dynamic imports in data files)
_add_hidden ocr
_add_hidden ocr.facade
_add_hidden ocr.config
_add_hidden ocr.engine_factory
_add_hidden ocr.base_engine
_add_hidden ocr.image_processor
_add_hidden ocr.auto_installer
_add_hidden ocr.runtime_installer
_add_hidden ocr.engines
_add_hidden ocr.engines.rapidocr_engine
_add_hidden ocr.engines.easyocr_engine
_add_hidden ocr.engines.winrtocr_engine
_add_hidden ocr.engines.dynamic_engine

# pystray submodules
_add_hidden pystray
_add_hidden pystray._xorg
_add_hidden pystray._appindicator

echo "[BUILD] OCR hidden imports collected"

pyinstaller --onefile \
    --name "$APP_NAME" \
    --add-data "ocr:ocr" \
    --add-data "privacy:privacy" \
    --add-data "local_storage:local_storage" \
    --add-data "wayland_screenshot.py:." \
    --add-data "desktop_app_linux.py:." \
    --hidden-import ewmh \
    --hidden-import Xlib \
    --hidden-import dbus \
    --hidden-import gi \
    --hidden-import fcntl \
    --hidden-import local_storage \
    --hidden-import local_storage.sqlite_manager \
    --hidden-import local_storage.session_tracker \
    --hidden-import local_storage.batch_uploader \
    $OCR_HIDDEN_IMPORTS \
    $OCR_DATA_ARGS \
    desktop_app.py

echo "[BUILD] Binary ready at dist/$APP_NAME"

# ── Step 2: Build .deb package ──────────────────────────────────────────────

DEB_ROOT="dist/deb_build"
DEB_FILE="dist/${APP_NAME}_${APP_VERSION}_amd64.deb"

echo "[DEB] Packaging .deb installer..."

rm -rf "$DEB_ROOT"

# Directory structure following Debian packaging standards
mkdir -p "$DEB_ROOT/DEBIAN"
mkdir -p "$DEB_ROOT/opt/$APP_NAME"
mkdir -p "$DEB_ROOT/usr/share/applications"
mkdir -p "$DEB_ROOT/usr/share/icons/hicolor/128x128/apps"
mkdir -p "$DEB_ROOT/usr/local/bin"

# ── DEBIAN/control ──
cat > "$DEB_ROOT/DEBIAN/control" <<EOF
Package: $APP_NAME
Version: $APP_VERSION
Section: utils
Priority: optional
Architecture: amd64
Maintainer: $MAINTAINER
Description: $APP_DISPLAY_NAME
 $APP_DESCRIPTION
Depends: libx11-6, libdbus-1-3, gir1.2-ayatanaappindicator3-0.1 | gir1.2-appindicator3-0.1
Replaces: $APP_NAME (<< $APP_VERSION)
Breaks: $APP_NAME (<< $APP_VERSION)
EOF

# ── DEBIAN/preinst (runs before install — auto-uninstall old version) ──
cat > "$DEB_ROOT/DEBIAN/preinst" <<'PREINST'
#!/bin/sh
set -e

# --- Stop any running timetracker instance before upgrade/install ---
if pgrep -f /opt/timetracker/timetracker >/dev/null 2>&1; then
    echo "[TimeTracker] Stopping running instance before install..."
    pkill -f /opt/timetracker/timetracker 2>/dev/null || true
    sleep 2
fi

# --- Remove previous dpkg-managed installation if present ---
if dpkg -s timetracker >/dev/null 2>&1; then
    INSTALLED_VER=$(dpkg-query -W -f='${Version}' timetracker 2>/dev/null || echo "unknown")
    echo "[TimeTracker] Found existing installation (v${INSTALLED_VER}). Removing before upgrade..."
    dpkg --remove --force-depends timetracker 2>/dev/null || true
fi

# --- Clean up manual (non-dpkg) installations ---
if [ -x /opt/timetracker/timetracker ] && ! dpkg -s timetracker >/dev/null 2>&1; then
    echo "[TimeTracker] Found manual installation in /opt/timetracker. Cleaning up..."
    rm -f /opt/timetracker/timetracker 2>/dev/null || true
    rm -f /usr/local/bin/timetracker 2>/dev/null || true
    rm -f /usr/share/applications/timetracker.desktop 2>/dev/null || true
    rm -f /usr/share/icons/hicolor/128x128/apps/timetracker.png 2>/dev/null || true
fi

# --- Remove stale lock files ---
for USERDIR in /home/*; do
    for LOCKFILE in \
        "$USERDIR/.local/share/timetracker/.lock" \
        "$USERDIR/snap/code/"*"/.local/share/timetracker/.lock"; do
        rm -f "$LOCKFILE" 2>/dev/null || true
    done
done

echo "[TimeTracker] System ready for installation."
PREINST
chmod 755 "$DEB_ROOT/DEBIAN/preinst"

# ── DEBIAN/postinst (runs after install) ──
cat > "$DEB_ROOT/DEBIAN/postinst" <<'POSTINST'
#!/bin/sh
set -e
# Ensure binary is executable
chmod 755 /opt/timetracker/timetracker
# Install AppIndicator typelib (required by pystray for system tray icon).
# The Depends field handles fresh installs, but upgrades from older .deb
# versions that lacked this dependency need it installed explicitly.
if ! dpkg -s gir1.2-ayatanaappindicator3-0.1 >/dev/null 2>&1 && \
   ! dpkg -s gir1.2-appindicator3-0.1 >/dev/null 2>&1; then
    echo "[TimeTracker] Installing AppIndicator typelib..."
    apt-get install -y gir1.2-ayatanaappindicator3-0.1 2>/dev/null || \
    apt-get install -y gir1.2-appindicator3-0.1 2>/dev/null || \
    echo "[TimeTracker] WARN: Could not install AppIndicator typelib. Tray icon may not appear."
fi
# Update desktop database so the launcher appears in the menu
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database /usr/share/applications || true
fi
POSTINST
chmod 755 "$DEB_ROOT/DEBIAN/postinst"

# ── DEBIAN/prerm (runs before removal / upgrade) ──
cat > "$DEB_ROOT/DEBIAN/prerm" <<'PRERM'
#!/bin/sh
set -e
# Stop running instances before uninstall/upgrade
pkill -f /opt/timetracker/timetracker 2>/dev/null || true
sleep 1
# Remove stale lock files so the next launch doesn't think an instance is running.
# The lock file lives under the user's XDG data dir; try common locations.
for USERDIR in /home/*; do
    for LOCKFILE in \
        "$USERDIR/.local/share/timetracker/.lock" \
        "$USERDIR/snap/code/"*"/.local/share/timetracker/.lock"; do
        rm -f "$LOCKFILE" 2>/dev/null || true
    done
done
PRERM
chmod 755 "$DEB_ROOT/DEBIAN/prerm"

# ── DEBIAN/postrm (runs after removal) ──
cat > "$DEB_ROOT/DEBIAN/postrm" <<'POSTRM'
#!/bin/sh
set -e
if command -v update-desktop-database >/dev/null 2>&1; then
    update-desktop-database /usr/share/applications || true
fi
POSTRM
chmod 755 "$DEB_ROOT/DEBIAN/postrm"

# ── Application binary ──
cp "dist/$APP_NAME" "$DEB_ROOT/opt/$APP_NAME/$APP_NAME"
chmod 755 "$DEB_ROOT/opt/$APP_NAME/$APP_NAME"

# ── Symlink so 'timetracker' works from terminal ──
ln -sf "/opt/$APP_NAME/$APP_NAME" "$DEB_ROOT/usr/local/bin/$APP_NAME"

# ── Generate app icon (128×128 blue square with 'TT') ──
python3 -c "
from PIL import Image, ImageDraw, ImageFont
img = Image.new('RGB', (128, 128), color=(52, 120, 246))
draw = ImageDraw.Draw(img)
try:
    font = ImageFont.truetype('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf', 48)
except Exception:
    font = ImageFont.load_default()
bbox = draw.textbbox((0, 0), 'TT', font=font)
x = (128 - (bbox[2] - bbox[0])) // 2
y = (128 - (bbox[3] - bbox[1])) // 2
draw.text((x, y), 'TT', fill='white', font=font)
img.save('$DEB_ROOT/usr/share/icons/hicolor/128x128/apps/$APP_NAME.png')
print('[DEB] Icon generated')
"

# ── .desktop launcher ──
cat > "$DEB_ROOT/usr/share/applications/$APP_NAME.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=$APP_DISPLAY_NAME
Comment=$APP_DESCRIPTION
Exec=env GSETTINGS_SCHEMA_DIR=/usr/share/glib-2.0/schemas /opt/$APP_NAME/$APP_NAME
Icon=$APP_NAME
Terminal=false
Categories=Utility;Office;
StartupNotify=true
Keywords=time;tracker;jira;
EOF

# ── Build the .deb ──
dpkg-deb --build --root-owner-group "$DEB_ROOT" "$DEB_FILE"

# Clean up build tree
rm -rf "$DEB_ROOT"

echo "[BUILD] Done."
echo "  Binary: dist/$APP_NAME"
echo "  .deb:   $DEB_FILE"
