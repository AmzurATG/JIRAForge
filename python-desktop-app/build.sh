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

# Check for spacy model (required for Presidio PII detection)
echo ""
echo "[INFO] Checking spacy model for PII detection..."
if ! $PYTHON_CMD -c "import en_core_web_sm" 2>/dev/null; then
    echo "[INFO] Spacy model en_core_web_sm not found, downloading..."
    $PYTHON_CMD -m spacy download en_core_web_sm
    if [ $? -eq 0 ]; then
        echo "[OK] Spacy model en_core_web_sm downloaded successfully"
    else
        echo "[WARN] Failed to download spacy model - PII detection will be degraded"
    fi
else
    echo "[OK] Spacy model en_core_web_sm is already installed"
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

pyinstaller --clean desktop_app.spec 2>&1 | tee build_log.txt; true

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

# ============================================================================
# Bundle GStreamer plugins for Wayland screenshot capture
# ============================================================================
echo ""
echo "  Bundling GStreamer plugins for screenshot capture..."

GST_PLUGIN_DIRS=(
    "/usr/lib/x86_64-linux-gnu/gstreamer-1.0"
    "/usr/lib64/gstreamer-1.0"
    "/usr/lib/gstreamer-1.0"
)

# Find GStreamer plugin directory
GST_PLUGIN_DIR=""
for dir in "${GST_PLUGIN_DIRS[@]}"; do
    if [ -d "$dir" ]; then
        GST_PLUGIN_DIR="$dir"
        break
    fi
done

if [ -n "$GST_PLUGIN_DIR" ]; then
    echo "    Found GStreamer plugins at: $GST_PLUGIN_DIR"
    
    # Create plugin directory in AppDir
    mkdir -p "${APPDIR}/usr/lib/gstreamer-1.0"
    
    # Bundle essential plugins for screenshot capture
    REQUIRED_PLUGINS=(
        "libgstpipewiresrc.so"
        "libgstvideoconvert.so"
        "libgstvideoconvertscale.so"
        "libgstpngenc.so"
        "libgstpng.so"
        "libgstcoreelements.so"
        "libgstvideobox.so"
        "libgstvideoscale.so"
        "libgstvideorate.so"
        "libgstvideofilter.so"
        "libgstapp.so"
        "libgsttypefindfunctions.so"
        "libgstplayback.so"
    )
    
    BUNDLED_COUNT=0
    for plugin in "${REQUIRED_PLUGINS[@]}"; do
        if [ -f "${GST_PLUGIN_DIR}/${plugin}" ]; then
            cp "${GST_PLUGIN_DIR}/${plugin}" "${APPDIR}/usr/lib/gstreamer-1.0/" 2>/dev/null && BUNDLED_COUNT=$((BUNDLED_COUNT + 1))
        fi
    done
    
    if [ $BUNDLED_COUNT -gt 0 ]; then
        echo "    ✓ Bundled ${BUNDLED_COUNT} GStreamer plugins"
    else
        echo "    ⚠ No GStreamer plugins found to bundle"
        echo "      Screenshot capture will require system GStreamer installation"
    fi
else
    echo "    ⚠ GStreamer plugin directory not found"
    echo "      Screenshot capture will require system GStreamer installation"
fi

# Bundle GStreamer core libraries
GST_LIB_DIRS=(
    "/usr/lib/x86_64-linux-gnu"
    "/usr/lib64"
    "/usr/lib"
)

GST_LIB_DIR=""
for dir in "${GST_LIB_DIRS[@]}"; do
    if [ -f "$dir/libgstreamer-1.0.so.0" ]; then
        GST_LIB_DIR="$dir"
        break
    fi
done

if [ -n "$GST_LIB_DIR" ]; then
    mkdir -p "${APPDIR}/usr/lib"
    
    # Copy GStreamer core libraries (preserving symlinks)
    BUNDLED_LIBS=0
    for lib_pattern in libgstreamer-1.0.so* libgstbase-1.0.so* libgstvideo-1.0.so* libgstapp-1.0.so*; do
        for lib_file in "${GST_LIB_DIR}"/${lib_pattern}; do
            if [ -f "$lib_file" ] || [ -L "$lib_file" ]; then
                cp -P "$lib_file" "${APPDIR}/usr/lib/" 2>/dev/null && BUNDLED_LIBS=$((BUNDLED_LIBS + 1))
            fi
        done
    done
    
    if [ $BUNDLED_LIBS -gt 0 ]; then
        echo "    ✓ Bundled ${BUNDLED_LIBS} GStreamer core libraries"
    fi
fi

echo ""

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
# [5/5] Build .deb package — the single distribution file for all users.
#
# WHY .deb:
#   - User downloads a .deb → double-clicks → Ubuntu Software Center opens
#     → clicks Install → app appears in launcher.  Zero terminal, zero chmod,
#     zero folder navigation.
#   - The .deb installs the AppImage to /opt/timetracker/ and creates a
#     launcher wrapper at /usr/local/bin/timetracker that always runs the
#     auto-updated binary in ~/.local/share/TimeTracker/ if it exists,
#     falling back to /opt/.
#   - APPIMAGE_EXTRACT_AND_RUN=1 in the wrapper means FUSE is NOT required
#     (works on Ubuntu 22.04+ and 24.04 out of the box).
# ============================================================================
echo ""
echo "[5/5] Building .deb package..."
echo ""

DEB_OUT=""
if [ -f "$APPIMAGE_OUT" ]; then
    case "$ARCH" in
        x86_64)  DEB_ARCH="amd64"  ;;
        aarch64) DEB_ARCH="arm64"  ;;
        armv7l)  DEB_ARCH="armhf"  ;;
        *)       DEB_ARCH="$ARCH"  ;;
    esac

    DEB_PKG_NAME="timetracker_${APP_VERSION}_${DEB_ARCH}"
    DEB_BUILD_DIR="$(pwd)/deb_build/${DEB_PKG_NAME}"
    DEB_OUT="dist/${DEB_PKG_NAME}.deb"

    # Clean previous deb staging area
    rm -rf "$(pwd)/deb_build"

    # Directory skeleton
    mkdir -p "${DEB_BUILD_DIR}/DEBIAN"
    mkdir -p "${DEB_BUILD_DIR}/opt/timetracker"
    mkdir -p "${DEB_BUILD_DIR}/usr/share/applications"
    mkdir -p "${DEB_BUILD_DIR}/usr/share/icons/hicolor/256x256/apps"
    mkdir -p "${DEB_BUILD_DIR}/usr/local/bin"
    mkdir -p "${DEB_BUILD_DIR}/usr/share/gnome-shell/extensions/disable-screenshot-flash@timetracker"

    # Embed AppImage
    echo "  Copying AppImage into .deb..."
    cp "$APPIMAGE_OUT" "${DEB_BUILD_DIR}/opt/timetracker/TimeTracker.AppImage"
    chmod 755 "${DEB_BUILD_DIR}/opt/timetracker/TimeTracker.AppImage"

    # Icon
    if [ -f "appimage/timetracker.png" ]; then
        cp appimage/timetracker.png \
           "${DEB_BUILD_DIR}/usr/share/icons/hicolor/256x256/apps/timetracker.png"
    fi

    # Screenshot flash fix extension (GNOME Wayland)
    # Copy extension files to /usr/share so postinst can install them per-user
    echo "  Bundling GNOME Shell extension (screenshot flash fix)..."
    EXTENSION_SOURCE="${HOME}/.local/share/gnome-shell/extensions/disable-screenshot-flash@timetracker"
    if [ -d "$EXTENSION_SOURCE" ]; then
        cp -r "$EXTENSION_SOURCE"/* \
           "${DEB_BUILD_DIR}/usr/share/gnome-shell/extensions/disable-screenshot-flash@timetracker/"
        echo "    Extension bundled: disable-screenshot-flash@timetracker"
    else
        echo "    [WARN] Extension not found at $EXTENSION_SOURCE - creating minimal version"
        # Create minimal extension inline if source doesn't exist
        cat > "${DEB_BUILD_DIR}/usr/share/gnome-shell/extensions/disable-screenshot-flash@timetracker/metadata.json" << 'EXTMETA'
{
  "name": "Disable Screenshot Flash",
  "description": "Disables the camera flash animation when taking screenshots",
  "uuid": "disable-screenshot-flash@timetracker",
  "shell-version": ["45", "46"],
  "version": 1
}
EXTMETA
        cat > "${DEB_BUILD_DIR}/usr/share/gnome-shell/extensions/disable-screenshot-flash@timetracker/extension.js" << 'EXTJS'
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
export default class DisableScreenshotFlashExtension extends Extension {
    enable() {
        import('resource:///org/gnome/shell/ui/screenshot.js').then(Screenshot => {
            if (Screenshot.ScreenshotService?.prototype._flashAsync) {
                this._originalFlashAsync = Screenshot.ScreenshotService.prototype._flashAsync;
                Screenshot.ScreenshotService.prototype._flashAsync = () => Promise.resolve();
            }
        }).catch(e => console.error('DisableScreenshotFlash:', e));
    }
    disable() {
        import('resource:///org/gnome/shell/ui/screenshot.js').then(Screenshot => {
            if (Screenshot.ScreenshotService?.prototype && this._originalFlashAsync) {
                Screenshot.ScreenshotService.prototype._flashAsync = this._originalFlashAsync;
            }
        }).catch(e => console.error('DisableScreenshotFlash:', e));
        this._originalFlashAsync = null;
    }
}
EXTJS
    fi

    # Launcher wrapper script (/usr/local/bin/timetracker)
    # - Prefers the auto-updated binary in ~/.local/share/TimeTracker/
    # - Falls back to /opt/timetracker/ on first run
    # - APPIMAGE_EXTRACT_AND_RUN=1 avoids FUSE requirement
    cat > "${DEB_BUILD_DIR}/usr/local/bin/timetracker" << 'WRAPPER'
#!/bin/bash
CANONICAL="${HOME}/.local/share/TimeTracker/TimeTracker.AppImage"
if [ -f "$CANONICAL" ] && [ -x "$CANONICAL" ]; then
    exec env APPIMAGE_EXTRACT_AND_RUN=1 APPIMAGE="$CANONICAL" "$CANONICAL" "$@"
else
    exec env APPIMAGE_EXTRACT_AND_RUN=1 APPIMAGE="/opt/timetracker/TimeTracker.AppImage" /opt/timetracker/TimeTracker.AppImage "$@"
fi
WRAPPER
    chmod 755 "${DEB_BUILD_DIR}/usr/local/bin/timetracker"

    # .desktop launcher
    cat > "${DEB_BUILD_DIR}/usr/share/applications/timetracker.desktop" << DESKTOP
[Desktop Entry]
Name=TimeTracker
GenericName=Time Tracker
Comment=Automatic time tracking for JIRA issues
Exec=/usr/local/bin/timetracker
Icon=timetracker
Type=Application
Categories=Office;ProjectManagement;
Terminal=false
StartupNotify=false
Keywords=time;tracker;jira;productivity;
X-AppImage-Version=${APP_VERSION}
DESKTOP

    # DEBIAN/control
    cat > "${DEB_BUILD_DIR}/DEBIAN/control" << CONTROL
Package: timetracker
Version: ${APP_VERSION}
Architecture: ${DEB_ARCH}
Maintainer: Amzur Technologies <support@amzur.com>
Depends: gdebi, python3-gi, gir1.2-ayatanaappindicator3-0.1 | gir1.2-appindicator3-0.1
Recommends: gnome-shell-extension-appindicator, libnotify-bin
Description: Automatic time tracking for JIRA issues
 TimeTracker tracks time spent on JIRA issues automatically
 using active window detection and screenshot analysis.
CONTROL

    # DEBIAN/postinst — fix permissions, refresh caches, enable AppIndicator extension
    cat > "${DEB_BUILD_DIR}/DEBIAN/postinst" << 'POSTINST'
#!/bin/bash
set -e
chmod +x /opt/timetracker/TimeTracker.AppImage 2>/dev/null || true
chmod +x /usr/local/bin/timetracker 2>/dev/null || true
update-desktop-database /usr/share/applications 2>/dev/null || true
gtk-update-icon-cache -f -t /usr/share/icons/hicolor 2>/dev/null || true

# ── Install/upgrade canonical per-user AppImage copy + user .desktop ─────────
# On fresh install AND upgrades, pre-install the canonical AppImage for every
# user so that the first double-click launches instantly (no 150 MB self-install
# dance that previously made the app appear to "not launch" after .deb install).
# Also write a correct per-user .desktop entry pointing to the canonical path so
# GNOME uses it directly without going through the /usr/local/bin wrapper.
_OPT_APPIMAGE="/opt/timetracker/TimeTracker.AppImage"

# Verify source AppImage exists before processing users
if [ ! -f "$_OPT_APPIMAGE" ]; then
    echo "[ERROR] Source AppImage not found: $_OPT_APPIMAGE" >&2
    echo "Skipping per-user installation, but system files are in place." >&2
    echo "Users can run: /usr/local/bin/timetracker" >&2
fi

for _USER_HOME in /home/*; do
    _USERNAME=$(basename "$_USER_HOME")
    if ! id "$_USERNAME" &>/dev/null; then continue; fi

    _CANONICAL_DIR="${_USER_HOME}/.local/share/TimeTracker"
    _CANONICAL="${_CANONICAL_DIR}/TimeTracker.AppImage"
    _DESKTOP_DIR="${_USER_HOME}/.local/share/applications"
    _USER_DESKTOP="${_DESKTOP_DIR}/timetracker.desktop"

    # Stop any running instance before replacing the binary.
    _TT_PIDS=$(pgrep -u "$_USERNAME" -f TimeTracker 2>/dev/null || true)
    if [ -n "$_TT_PIDS" ]; then
        echo "  Stopping running TimeTracker for ${_USERNAME}..."
        echo "$_TT_PIDS" | xargs kill 2>/dev/null || true
        sleep 1
    fi

    # Create canonical dir (fresh install) or reuse existing (upgrade).
    mkdir -p "$_CANONICAL_DIR" 2>/dev/null || true
    chown "$_USERNAME":"$_USERNAME" "$_CANONICAL_DIR" 2>/dev/null || true

    # Atomically copy /opt/ AppImage → canonical so the wrapper finds it on
    # first launch without doing the slow self-install dance at runtime.
    _TMP="${_CANONICAL}.new"
    if cp "$_OPT_APPIMAGE" "$_TMP" 2>/dev/null; then
        chmod +x "$_TMP"
        mv -f "$_TMP" "$_CANONICAL"
        chown "$_USERNAME":"$_USERNAME" "$_CANONICAL" 2>/dev/null || true
        echo "Canonical AppImage installed/upgraded for ${_USERNAME}: ${_CANONICAL}"
    else
        echo "[WARN] Could not install canonical AppImage for ${_USERNAME}" >&2
        continue
    fi

    # Scaffold expected subdirectories so the app can write log files and
    # stage auto-updates even before the first successful login.
    for _SUB in logs updates; do
        _SUBDIR="${_CANONICAL_DIR}/${_SUB}"
        mkdir -p "$_SUBDIR" 2>/dev/null && \
            chown "$_USERNAME":"$_USERNAME" "$_SUBDIR" 2>/dev/null || true
    done
    echo "Scaffold directories created for ${_USERNAME}: logs/ updates/"

    # Write/overwrite the user-level .desktop entry with an absolute path to
    # the canonical AppImage.  This replaces any stale entries (old binary-path
    # entries without .AppImage, entries pointing to deleted paths, etc.) and
    # ensures the GNOME launcher uses the correct canonical path immediately.
    mkdir -p "$_DESKTOP_DIR" 2>/dev/null || true
    chown "$_USERNAME":"$_USERNAME" "$_DESKTOP_DIR" 2>/dev/null || true
    cat > "$_USER_DESKTOP" << USERDESKTOP
[Desktop Entry]
Name=TimeTracker
GenericName=Time Tracker
Comment=Automatic time tracking for JIRA issues
Exec=env APPIMAGE_EXTRACT_AND_RUN=1 APPIMAGE=${_CANONICAL} ${_CANONICAL}
Icon=timetracker
Type=Application
Categories=Office;ProjectManagement;
Terminal=false
StartupNotify=false
Keywords=time;tracker;jira;productivity;
USERDESKTOP
    chown "$_USERNAME":"$_USERNAME" "$_USER_DESKTOP" 2>/dev/null || true
    chmod 644 "$_USER_DESKTOP" 2>/dev/null || true
    update-desktop-database "$_DESKTOP_DIR" 2>/dev/null || true
    echo "User .desktop created/updated for ${_USERNAME}: ${_USER_DESKTOP}"

    # ── Install screenshot flash fix extension (GNOME Wayland only) ─────────
    # Copy extension to user's GNOME extensions directory and create an autostart
    # file that will automatically enable it on next GNOME login (no manual steps).
    if [ -d "/usr/share/gnome-shell/extensions/disable-screenshot-flash@timetracker" ]; then
        _EXT_DIR="${_USER_HOME}/.local/share/gnome-shell/extensions/disable-screenshot-flash@timetracker"
        mkdir -p "$_EXT_DIR" 2>/dev/null || true
        cp -r /usr/share/gnome-shell/extensions/disable-screenshot-flash@timetracker/* "$_EXT_DIR/" 2>/dev/null
        chown -R "$_USERNAME":"$_USERNAME" "$_EXT_DIR" 2>/dev/null || true
        
        # Create autostart entry that enables extension on first login
        _AUTOSTART_DIR="${_USER_HOME}/.config/autostart"
        _AUTOSTART_FILE="${_AUTOSTART_DIR}/timetracker-enable-flash-fix.desktop"
        mkdir -p "$_AUTOSTART_DIR" 2>/dev/null || true
        cat > "$_AUTOSTART_FILE" << AUTOSTART
[Desktop Entry]
Type=Application
Name=TimeTracker Flash Fix
Exec=sh -c 'gnome-extensions enable disable-screenshot-flash@timetracker 2>/dev/null && rm -f "$_AUTOSTART_FILE"'
Hidden=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
Comment=Enables screenshot flash fix extension (runs once)
AUTOSTART
        chown "$_USERNAME":"$_USERNAME" "$_AUTOSTART_FILE" 2>/dev/null || true
        chmod 644 "$_AUTOSTART_FILE" 2>/dev/null || true
        echo "Extension installed for ${_USERNAME}: ${_EXT_DIR}"
        echo "  Auto-enable configured via: ${_AUTOSTART_FILE}"
    fi
done

# NOTE: GNOME AppIndicator extension activation is intentionally NOT done here.
# gnome-extensions requires an active org.gnome.Shell D-Bus session, which does
# NOT exist during dpkg postinst execution.  Any 'su - user -c gnome-extensions'
# invocation silently fails with a D-Bus connection error.
# Activation is handled at first app launch (inside the user's live GNOME session)
# by _try_enable_gnome_appindicator_extension() in desktop_app.py instead.

# Set gdebi as the default handler for .deb files for all users.
# This ensures future double-clicks open GDebi (which shows a proper Upgrade
# button when a newer version is available) instead of Ubuntu App Center
# (which always shows "Installed" for local .deb upgrades — a known Ubuntu bug).
if command -v gdebi &>/dev/null; then
    for _USER_HOME in /home/*; do
        _USERNAME=$(basename "$_USER_HOME")
        if id "$_USERNAME" &>/dev/null; then
            su - "$_USERNAME" -c '
                mkdir -p ~/.config
                # Set gdebi as default for both Debian MIME types
                xdg-mime default gdebi.desktop application/vnd.debian.binary-package 2>/dev/null || true
                xdg-mime default gdebi.desktop application/x-debian-package 2>/dev/null || true
            ' 2>/dev/null || true
        fi
    done
    echo "GDebi set as default .deb handler — future upgrades will show a proper Upgrade button."
fi

# Summary message
echo ""
echo "========================================"
echo "  TimeTracker Installation Complete"
echo "========================================"
echo ""
echo "✓ TimeTracker installed to /opt/timetracker/"
echo "✓ Launcher created: /usr/local/bin/timetracker"
echo "✓ Desktop entry installed for all users"
echo ""
if [ -d "/usr/share/gnome-shell/extensions/disable-screenshot-flash@timetracker" ]; then
    echo "✓ Screenshot flash fix extension installed"
    echo "  → Will auto-enable on next GNOME login (no manual steps needed!)"
    echo ""
fi
echo "Launch TimeTracker from:"
echo "  • Applications menu → TimeTracker"
echo "  • Terminal: timetracker"
echo ""
POSTINST
    chmod 755 "${DEB_BUILD_DIR}/DEBIAN/postinst"

    # DEBIAN/prerm — stop any running instance BEFORE dpkg replaces the files.
    # Without this, dpkg may fail to overwrite /opt/timetracker/TimeTracker.AppImage
    # because the FUSE mount keeps a file-descriptor open.  This also gives the
    # old app a chance to flush pending data before being replaced.
    #
    # dpkg passes $1 = "upgrade <new-version>" for in-place upgrades,
    # and $1 = "remove" for uninstalls.  We stop the app in both cases.
    cat > "${DEB_BUILD_DIR}/DEBIAN/prerm" << 'PRERM'
#!/bin/bash
# Stop all running TimeTracker instances before dpkg replaces the binary.
# This prevents "text file busy" / FUSE lock errors during file replacement.
echo "Stopping TimeTracker before upgrade/removal..."
for _USER_HOME in /home/*; do
    _USERNAME=$(basename "$_USER_HOME")
    if id "$_USERNAME" &>/dev/null; then
        _TT_PIDS=$(pgrep -u "$_USERNAME" -f TimeTracker 2>/dev/null || true)
        if [ -n "$_TT_PIDS" ]; then
            echo "  Stopping TimeTracker for ${_USERNAME} (pids: ${_TT_PIDS})..."
            # Graceful SIGTERM first
            echo "$_TT_PIDS" | xargs kill 2>/dev/null || true
            # Wait up to 5 s for graceful exit
            for _i in 1 2 3 4 5; do
                _STILL=$(pgrep -u "$_USERNAME" -f TimeTracker 2>/dev/null || true)
                [ -z "$_STILL" ] && break
                sleep 1
            done
            # Force-kill any survivors
            _STILL=$(pgrep -u "$_USERNAME" -f TimeTracker 2>/dev/null || true)
            if [ -n "$_STILL" ]; then
                echo "  Force-stopping remaining TimeTracker for ${_USERNAME}..."
                echo "$_STILL" | xargs kill -9 2>/dev/null || true
                sleep 1
            fi
        fi
    fi
done
echo "TimeTracker stopped."
exit 0
PRERM
    chmod 755 "${DEB_BUILD_DIR}/DEBIAN/prerm"

    # Build the .deb
    # Force xz compression (-Zxz) so the data.tar uses lzma (xz) instead of
    # zstd.  dpkg >= 1.21.18 (Ubuntu 24.04) defaults to zstd, which the
    # auto-updater's pure-Python extractor cannot decompress without the
    # 'zstandard' package.  xz is supported by lzma in the stdlib on all
    # Python versions >= 3.3, making the .deb self-extractable on any host.
    if command -v dpkg-deb &>/dev/null; then
        mkdir -p dist
        echo "  Running dpkg-deb (xz compression)..."
        DPKG_DEB_OUTPUT=$(dpkg-deb -Zxz --build --root-owner-group "${DEB_BUILD_DIR}" "${DEB_OUT}" 2>&1)
        DPKG_DEB_EXIT=$?
        echo "$DPKG_DEB_OUTPUT" >> build_log.txt
        if [ $DPKG_DEB_EXIT -eq 0 ] && [ -f "${DEB_OUT}" ]; then
            DEB_BUILD_OK=1
        else
            DEB_BUILD_OK=0
            echo "  [ERR] dpkg-deb exit=${DPKG_DEB_EXIT}" >&2
            echo "  [ERR] Expected output: ${DEB_OUT}" >&2
            echo "  [ERR] dpkg-deb output: ${DPKG_DEB_OUTPUT}" >&2
            echo "  [ERR] dist/ contents: $(ls dist/ 2>/dev/null || echo 'empty/missing')" >&2
        fi
        if [ "${DEB_BUILD_OK}" = "1" ] && [ -f "$DEB_OUT" ]; then
            DEB_SIZE=$(du -h "$DEB_OUT" | cut -f1)
            if command -v sha256sum &>/dev/null; then
                DEB_SHA256=$(sha256sum "$DEB_OUT" | awk '{print $1}')
            else
                DEB_SHA256="unavailable"
            fi
            echo ""
            echo "  [OK] .deb package : ${DEB_OUT} (${DEB_SIZE})"
            echo "  [OK] SHA256       : ${DEB_SHA256}"
        else
            echo "  [WARN] .deb build failed — check build_log.txt"
            DEB_OUT=""
        fi
    else
        echo "  [WARN] dpkg-deb not found — skipping .deb packaging."
        echo "         Install with: sudo apt install dpkg"
        DEB_OUT=""
    fi

    # Clean up staging dir
    rm -rf "$(pwd)/deb_build"
else
    echo "  [SKIP] No AppImage available — skipping .deb packaging."
fi

# ============================================================================
# Final summary
# ============================================================================
echo ""
echo "============================================"
echo "  Build Complete!"
echo "============================================"
echo ""
echo "  Standalone binary : dist/TimeTracker"
if [ -n "${DEB_OUT:-}" ] && [ -f "$DEB_OUT" ]; then
echo "  .deb (distribute this) : $DEB_OUT"
if [ -n "${DEB_SHA256:-}" ]; then
echo "  SHA256                 : $DEB_SHA256"
fi
fi
echo ""
echo "Next steps:"
echo "  1. Test   : ./dist/TimeTracker"
echo ""
if [ -n "${DEB_OUT:-}" ] && [ -f "$DEB_OUT" ]; then
echo "  UPLOAD ONE FILE to storage and share with users:"
echo "    $DEB_OUT"
echo "    SHA256: ${DEB_SHA256:-<run sha256sum on the file>}"
echo ""
echo "  New users    : download .deb → double-click → Ubuntu Software → Install → done"
echo "  Auto-update  : running app downloads the .deb and extracts the AppImage automatically"
echo ""
echo "  Run supabase/migrations/publish-linux-release.sql with the .deb URL + SHA256"
fi
