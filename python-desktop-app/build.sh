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
    "/usr/lib/python$(python3 - <<'PY'
import sys
print(f"{sys.version_info.major}.{sys.version_info.minor}")
PY)/dist-packages" \
    "/usr/local/lib/python3/dist-packages"
do
    if [ -d "$candidate" ]; then
        SYSTEM_DIST_PACKAGES="$candidate"
        break
    fi
done

if [ -n "$SYSTEM_DIST_PACKAGES" ]; then
    export PYTHONPATH="${PYTHONPATH:+$PYTHONPATH:}$SYSTEM_DIST_PACKAGES"
    echo "[INFO] Added system dist-packages to PYTHONPATH: $SYSTEM_DIST_PACKAGES"
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
    pip install pyinstaller>=6.2.0
fi

echo ""
echo "[0/4] Validating Linux tray runtime..."
$PYTHON_CMD - <<'PY'
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
echo "[1/4] Cleaning previous build..."
rm -rf build/
rm -rf dist/
rm -f *.spec.backup

# Validate configuration embed
echo ""
echo "[2/4] Validating embedded configuration..."
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
echo "[3/4] Building executable with PyInstaller..."
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

echo ""
echo "============================================"
echo "  Build Complete!"
echo "============================================"
echo ""
echo "  Executable: dist/TimeTracker"
echo "  Size: $FILE_SIZE"
echo ""
echo "Next steps:"
echo "  1. Test the build: ./dist/TimeTracker"
echo "  2. Check OCR engines work correctly"
echo "  3. Verify no WinRT errors in logs"
echo ""
