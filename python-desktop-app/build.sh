#!/bin/bash
# ============================================================================
# Time Tracker - Build Script for Linux
# Creates a standalone executable with embedded credentials
# No .env file needed for distribution - credentials are embedded in code
# ============================================================================

set -e  # Exit on error

echo ""
echo "============================================"
echo "  Time Tracker - Build Script (Linux)"
echo "============================================"
echo ""
echo "NOTE: Credentials are embedded in desktop_app.py"
echo "      No .env file needed for distribution!"
echo ""

# Check if we're in the right directory
if [ ! -f "desktop_app.py" ]; then
    echo "[ERROR] desktop_app.py not found"
    echo "Please run this script from the python-desktop-app directory"
    exit 1
fi

# Detect Python command (python3 or python)
PYTHON_CMD="python3"
if ! command -v python3 &> /dev/null; then
    if command -v python &> /dev/null; then
        PYTHON_CMD="python"
    else
        echo "[ERROR] Python is not available"
        echo "Please ensure Python 3.8+ is installed"
        exit 1
    fi
fi

echo "[INFO] Using Python: $PYTHON_CMD"
$PYTHON_CMD --version

SYSTEM_DIST_PACKAGES=""
for candidate in \
    "/usr/lib/python3/dist-packages" \
    "/usr/lib/python$(python3 -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')/dist-packages" \
    "/usr/local/lib/python3/dist-packages"
do
    if [ -d "$candidate" ]; then
        SYSTEM_DIST_PACKAGES="$candidate"
        break
    fi
done

if [ -n "$SYSTEM_DIST_PACKAGES" ]; then
    echo "[INFO] Detected system dist-packages: $SYSTEM_DIST_PACKAGES"
    echo "[INFO] (scoped to tray validation only — avoids version conflicts with venv packages)"
fi

# Check for virtual environment
if [ -d ".venv" ]; then
    echo "[INFO] Activating virtual environment .venv..."
    source .venv/bin/activate
elif [ -d "venv" ]; then
    echo "[INFO] Activating virtual environment venv..."
    source venv/bin/activate
else
    echo "[INFO] No virtual environment found, using system Python"
fi

# Check if PyInstaller is available
if ! $PYTHON_CMD -c "import PyInstaller" 2>/dev/null; then
    echo "[ERROR] PyInstaller is not installed"
    echo "Installing PyInstaller..."
    $PYTHON_CMD -m pip install pyinstaller>=6.2.0
fi

# Ensure runtime-critical packages are present in the venv.
# platformdirs is required by pkg_resources (setuptools) at runtime inside the
# PyInstaller bundle — if it is missing the app crashes on startup with
# ModuleNotFoundError: No module named 'platformdirs'.
echo "[INFO] Checking critical runtime dependencies..."
MISSING_DEPS=()
for pkg in platformdirs tzlocal; do
    if ! $PYTHON_CMD -c "import $pkg" 2>/dev/null; then
        MISSING_DEPS+=("$pkg")
    fi
done
# cv2 must be a real extension module (origin != None), not a broken namespace package.
# opencv-python ships a namespace package without the .so on some Linux installs —
# replace it with opencv-python-headless which always includes the real extension.
CV2_OK=$($PYTHON_CMD -c "
import importlib.util, sys
spec = importlib.util.find_spec('cv2')
print('ok' if spec and spec.origin else 'bad')
" 2>/dev/null)
if [ "$CV2_OK" != "ok" ]; then
    echo "[INFO] opencv-python-headless not properly installed — fixing..."
    $PYTHON_CMD -m pip uninstall -y opencv-python opencv-python-headless 2>/dev/null || true
    MISSING_DEPS+=("opencv-python-headless")
fi
if [ ${#MISSING_DEPS[@]} -gt 0 ]; then
    echo "[INFO] Installing missing runtime deps: ${MISSING_DEPS[*]}"
    $PYTHON_CMD -m pip install "${MISSING_DEPS[@]}"
fi

echo ""
echo "[0/5] Validating Linux tray runtime..."
PYTHONPATH="${SYSTEM_DIST_PACKAGES}${PYTHONPATH:+:$PYTHONPATH}" $PYTHON_CMD - <<'PY'
import importlib
checks = [
    ('gi', 'PyGObject'),
    ('gi.repository.Gtk', 'GTK 3 bindings'),
    ('gi.repository.AppIndicator3', 'AppIndicator typelib'),
    ('gi.repository.AyatanaAppIndicator3', 'Ayatana AppIndicator typelib'),
]
results = []
for module_name, label in checks:
    try:
        importlib.import_module(module_name)
        results.append((label, True, module_name))
    except Exception as exc:
        results.append((label, False, str(exc)))

for label, ok, detail in results:
    status = 'OK' if ok else 'MISSING'
    print(f'  [{status}] {label}: {detail}')

gi_ok = next(ok for label, ok, _ in results if label == 'PyGObject')
indicator_ok = any(ok for label, ok, _ in results if label in ('AppIndicator typelib', 'Ayatana AppIndicator typelib'))

if not gi_ok or not indicator_ok:
    print('  [WARN] Linux tray menus require python3-gi and either AppIndicator or Ayatana typelibs on the host.')
    print('  [WARN] Build will continue, but runtime may fall back to a menu-less tray backend.')
PY

# Clean previous build
echo ""
echo "[1/5] Cleaning previous build..."
rm -rf build/
rm -rf dist/
rm -rf AppDir/
rm -f *.spec.backup

# Validate configuration embed
echo ""
echo "[2/5] Validating embedded configuration..."
$PYTHON_CMD -c "
import sys
sys.path.insert(0, '.')
from desktop_app import EMBEDDED_CONFIG, APP_VERSION
print(f'  APP_VERSION: {APP_VERSION}')
print(f'  AI_SERVER_URL: {EMBEDDED_CONFIG.get(\"AI_SERVER_URL\", \"NOT SET\")}')
if not EMBEDDED_CONFIG.get('ATLASSIAN_CLIENT_ID'):
    print('[ERROR] ATLASSIAN_CLIENT_ID not set in EMBEDDED_CONFIG')
    sys.exit(1)
print('  ✓ Configuration valid')
"

if [ $? -ne 0 ]; then
    echo "[ERROR] Configuration validation failed"
    exit 1
fi

# Build with PyInstaller
echo ""
echo "[3/5] Building executable with PyInstaller..."
echo "      This may take 5-10 minutes..."
echo ""

pyinstaller desktop_app.spec 2>&1 | tee build_log.txt

# Check if build was successful
if [ ! -f "dist/TimeTracker" ]; then
    echo ""
    echo "[ERROR] Build failed - executable not created"
    echo "Check build_log.txt for details"
    exit 1
fi

# Get file size
FILE_SIZE=$(du -h "dist/TimeTracker" | cut -f1)
echo "  [OK] Standalone binary: dist/TimeTracker ($FILE_SIZE)"

# ============================================================================
# [4/5] Package AppImage
# ============================================================================
echo ""
echo "[4/5] Packaging AppImage..."
echo ""

# Resolve the app version
# Use tail -1 to grab only the printed version line, discarding INFO/WARN
# messages that desktop_app.py emits to stdout during import.
APP_VERSION=$($PYTHON_CMD -c "
import sys
sys.path.insert(0, '.')
from desktop_app import APP_VERSION
print(APP_VERSION)
" 2>/dev/null | tail -1)
ARCH=$(uname -m)
APPIMAGE_OUT="dist/TimeTracker-v${APP_VERSION}-${ARCH}.AppImage"

echo "  Version : ${APP_VERSION}"
echo "  Arch    : ${ARCH}"
echo "  Output  : ${APPIMAGE_OUT}"
echo ""

# Build the AppDir skeleton
APPDIR="$(pwd)/AppDir"
mkdir -p "${APPDIR}/usr/bin"
mkdir -p "${APPDIR}/usr/share/applications"
mkdir -p "${APPDIR}/usr/share/icons/hicolor/256x256/apps"

echo "  Copying binary into AppDir..."
cp dist/TimeTracker "${APPDIR}/usr/bin/TimeTracker"

echo "  Installing AppRun and desktop metadata..."
cp appimage/AppRun "${APPDIR}/AppRun"
chmod +x "${APPDIR}/AppRun"

DESKTOP_TEMPLATE="appimage/timetracker.desktop"
DESKTOP_FILE="${APPDIR}/timetracker.desktop"
DESKTOP_APP_FILE="${APPDIR}/usr/share/applications/timetracker.desktop"

sed "s/^X-AppImage-Version=.*/X-AppImage-Version=${APP_VERSION}/" "$DESKTOP_TEMPLATE" > "$DESKTOP_FILE"
cp "$DESKTOP_FILE" "$DESKTOP_APP_FILE"

# Generate the icon if it doesn't exist yet
if [ ! -f "appimage/timetracker.png" ]; then
    echo "  Generating app icon..."
    $PYTHON_CMD appimage/generate_icon.py || echo "  [WARN] Icon generation failed — continuing without icon"
fi

if [ -f "appimage/timetracker.png" ]; then
    cp appimage/timetracker.png "${APPDIR}/timetracker.png"
    cp appimage/timetracker.png "${APPDIR}/usr/share/icons/hicolor/256x256/apps/timetracker.png"
else
    echo "  [WARN] No icon found — AppImage will use the default icon"
fi

# Locate or download appimagetool
APPIMAGETOOL=""
if command -v appimagetool &>/dev/null; then
    APPIMAGETOOL="appimagetool"
    echo "  Using system appimagetool: $(command -v appimagetool)"
elif [ -f "./appimagetool-${ARCH}.AppImage" ]; then
    APPIMAGETOOL="./appimagetool-${ARCH}.AppImage"
    echo "  Using cached appimagetool: ${APPIMAGETOOL}"
else
    echo "  Downloading appimagetool for ${ARCH}..."
    TOOL_URL="https://github.com/AppImage/appimagetool/releases/download/continuous/appimagetool-${ARCH}.AppImage"
    if command -v wget &>/dev/null; then
        wget -q --show-progress -O "./appimagetool-${ARCH}.AppImage" "$TOOL_URL"
    elif command -v curl &>/dev/null; then
        curl -fSL -o "./appimagetool-${ARCH}.AppImage" "$TOOL_URL"
    else
        echo "[ERROR] Neither wget nor curl is available — cannot download appimagetool."
        echo "        Install manually: sudo apt install appimagetool"
        echo "        Standalone binary is still at dist/TimeTracker"
        APPIMAGETOOL=""
    fi
    if [ -n "$APPIMAGETOOL" ] || [ -f "./appimagetool-${ARCH}.AppImage" ]; then
        chmod +x "./appimagetool-${ARCH}.AppImage"
        APPIMAGETOOL="./appimagetool-${ARCH}.AppImage"
    fi
fi

if [ -z "$APPIMAGETOOL" ]; then
    echo "  [WARN] appimagetool not available — skipping AppImage packaging."
    echo "         The standalone binary dist/TimeTracker is still usable."
else
    # Support FUSE-less environments (Docker / CI / no fusermount)
    FUSE_AVAILABLE=0
    command -v fusermount &>/dev/null && FUSE_AVAILABLE=1

    echo "  Running appimagetool..."
    if [ "$FUSE_AVAILABLE" -eq 0 ] && [ "${APPIMAGE_EXTRACT_AND_RUN:-0}" != "1" ]; then
        echo "  [INFO] FUSE not detected — using extract-and-run mode"
        APPIMAGE_EXTRACT_AND_RUN=1 ARCH="$ARCH" "$APPIMAGETOOL" "$APPDIR" "$APPIMAGE_OUT" 2>&1 | tee -a build_log.txt
    else
        ARCH="$ARCH" "$APPIMAGETOOL" "$APPDIR" "$APPIMAGE_OUT" 2>&1 | tee -a build_log.txt
    fi

    if [ -f "$APPIMAGE_OUT" ]; then
        chmod +x "$APPIMAGE_OUT"
        APPIMAGE_SIZE=$(du -h "$APPIMAGE_OUT" | cut -f1)
        if command -v sha256sum &>/dev/null; then
            APPIMAGE_SHA256=$(sha256sum "$APPIMAGE_OUT" | awk '{print $1}')
        elif command -v shasum &>/dev/null; then
            APPIMAGE_SHA256=$(shasum -a 256 "$APPIMAGE_OUT" | awk '{print $1}')
        else
            APPIMAGE_SHA256="unavailable"
        fi
        echo ""
        echo "  [OK] AppImage : $APPIMAGE_OUT ($APPIMAGE_SIZE)"
        echo "  [OK] SHA256   : $APPIMAGE_SHA256"
    else
        echo ""
        echo "  [WARN] AppImage packaging failed — check build_log.txt for details."
        echo "         Standalone binary dist/TimeTracker is still available."
    fi
fi

# ============================================================================
# Final summary
# ============================================================================
echo ""
echo "============================================"
echo "  Build Complete!"
echo "============================================"
echo ""
echo "  Standalone : dist/TimeTracker"
if [ -f "$APPIMAGE_OUT" ]; then
echo "  AppImage   : $APPIMAGE_OUT"
if [ -n "${APPIMAGE_SHA256:-}" ]; then
echo "  SHA256     : $APPIMAGE_SHA256"
fi
fi
echo ""
echo "Next steps:"
echo "  1. Test standalone   : ./dist/TimeTracker"
if [ -f "$APPIMAGE_OUT" ]; then
echo "  2. Test AppImage     : ./$APPIMAGE_OUT"
echo "  3. Upload AppImage to storage and run publish-linux-release.sql"
fi
echo ""
