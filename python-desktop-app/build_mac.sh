#!/bin/bash
# =============================================================================
# TimeTracker macOS Build & Package Script
# Builds .app bundle, ad-hoc signs it, and creates .pkg installer
# =============================================================================
set -e

# Configuration
APP_NAME="TimeTracker"
APP_VERSION="1.2.1"
BUNDLE_ID="com.amzur.timetracker"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
BUILD_DIR="$SCRIPT_DIR/build"
DIST_DIR="$SCRIPT_DIR/dist"
INSTALLER_DIR="$SCRIPT_DIR/installer"
PKG_OUTPUT_DIR="$DIST_DIR/pkg"
SPEC_FILE="$SCRIPT_DIR/mac_desktop_app.spec"
VENV_DIR="$SCRIPT_DIR/venv"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log_info() { echo -e "${BLUE}[INFO]${NC} $1"; }
log_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# =============================================================================
# Step 0: Pre-flight checks
# =============================================================================
echo ""
echo "=============================================="
echo "  TimeTracker macOS Build & Package Script"
echo "  Version: $APP_VERSION"
echo "=============================================="
echo ""

log_info "Checking build prerequisites..."

# Check macOS
if [[ "$(uname)" != "Darwin" ]]; then
    log_error "This script must be run on macOS."
    exit 1
fi

# Check Python
if [ -d "$VENV_DIR" ]; then
    log_info "Activating virtual environment..."
    source "$VENV_DIR/bin/activate"
else
    log_warn "No virtual environment found. Using system Python."
fi

PYTHON=$(which python3 || which python)
if [ -z "$PYTHON" ]; then
    log_error "Python not found. Please install Python 3.10+."
    exit 1
fi
log_info "Using Python: $($PYTHON --version)"

# Check PyInstaller
if ! $PYTHON -m PyInstaller --version &>/dev/null; then
    log_warn "PyInstaller not found. Installing..."
    $PYTHON -m pip install pyinstaller
fi
log_info "PyInstaller: $($PYTHON -m PyInstaller --version)"

# Check required tools
for tool in codesign pkgbuild productbuild; do
    if ! command -v "$tool" &>/dev/null; then
        log_error "$tool not found. Xcode Command Line Tools required."
        exit 1
    fi
done
log_success "All prerequisites satisfied."

# =============================================================================
# Step 1: Clean previous builds
# =============================================================================
echo ""
log_info "Step 1: Cleaning previous builds..."

rm -rf "$BUILD_DIR/$APP_NAME"
rm -rf "$DIST_DIR/$APP_NAME"
rm -rf "$DIST_DIR/$APP_NAME.app"
rm -rf "$PKG_OUTPUT_DIR"

log_success "Clean complete."

# =============================================================================
# Step 2: Build .app with PyInstaller
# =============================================================================
echo ""
log_info "Step 2: Building $APP_NAME.app with PyInstaller..."
log_info "Using spec file: $SPEC_FILE"

cd "$SCRIPT_DIR"
$PYTHON -m PyInstaller "$SPEC_FILE" \
    --noconfirm \
    --clean \
    --distpath "$DIST_DIR" \
    --workpath "$BUILD_DIR"

APP_PATH="$DIST_DIR/$APP_NAME.app"

if [ ! -d "$APP_PATH" ]; then
    log_error "Build failed! $APP_PATH not found."
    exit 1
fi

APP_SIZE=$(du -sh "$APP_PATH" | cut -f1)
log_success ".app bundle created: $APP_PATH ($APP_SIZE)"

# =============================================================================
# Step 3: Ad-hoc code signing
# =============================================================================
echo ""
log_info "Step 3: Ad-hoc code signing..."

# Sign all frameworks and dylibs first (deep sign from inside out)
log_info "Signing embedded frameworks and libraries..."
find "$APP_PATH/Contents/Frameworks" -name "*.dylib" -o -name "*.so" -o -name "*.framework" 2>/dev/null | while read lib; do
    codesign --force --sign - "$lib" 2>/dev/null || true
done

find "$APP_PATH/Contents/Resources" -name "*.dylib" -o -name "*.so" 2>/dev/null | while read lib; do
    codesign --force --sign - "$lib" 2>/dev/null || true
done

# Sign the main executable
log_info "Signing main executable..."
codesign --force --sign - "$APP_PATH/Contents/MacOS/$APP_NAME" 2>/dev/null || true

# Sign the entire .app bundle (deep sign)
log_info "Signing .app bundle..."
codesign --force --deep --sign - "$APP_PATH"

# Verify signing
codesign --verify --verbose "$APP_PATH" 2>&1 && {
    log_success "Ad-hoc code signing successful."
} || {
    log_warn "Code signing verification had warnings (ad-hoc signing expected)."
}

# =============================================================================
# Step 4: Remove quarantine attribute
# =============================================================================
echo ""
log_info "Step 4: Removing quarantine attribute..."
xattr -cr "$APP_PATH" 2>/dev/null
log_success "Quarantine attribute removed."

# =============================================================================
# Step 5: Create .pkg installer
# =============================================================================
echo ""
log_info "Step 5: Creating .pkg installer..."

mkdir -p "$PKG_OUTPUT_DIR"

# Make installer scripts executable
chmod +x "$INSTALLER_DIR/scripts/preinstall"
chmod +x "$INSTALLER_DIR/scripts/postinstall"

# Create a clean staging directory with ONLY the .app bundle
# This avoids pkgbuild --filter issues that can strip the executable
STAGING_DIR="$BUILD_DIR/pkg-staging"
rm -rf "$STAGING_DIR"
mkdir -p "$STAGING_DIR"
log_info "Copying .app to staging directory..."
cp -a "$APP_PATH" "$STAGING_DIR/"

# Verify the executable exists in staging
if [ ! -f "$STAGING_DIR/$APP_NAME.app/Contents/MacOS/$APP_NAME" ]; then
    log_error "FATAL: Executable missing from staged app bundle!"
    log_error "Expected: $STAGING_DIR/$APP_NAME.app/Contents/MacOS/$APP_NAME"
    exit 1
fi
log_success "Staging verified: executable present ($(du -sh "$STAGING_DIR/$APP_NAME.app/Contents/MacOS/$APP_NAME" | cut -f1))"

# Create the component package from the clean staging directory
log_info "Building component package..."
pkgbuild \
    --root "$STAGING_DIR" \
    --component-plist /dev/stdin \
    --identifier "$BUNDLE_ID" \
    --version "$APP_VERSION" \
    --install-location "/Applications" \
    --scripts "$INSTALLER_DIR/scripts" \
    "$PKG_OUTPUT_DIR/${APP_NAME}-component.pkg" << 'COMPONENT_PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<array>
    <dict>
        <key>BundleHasStrictIdentifier</key>
        <false/>
        <key>BundleIsRelocatable</key>
        <false/>
        <key>BundleIsVersionChecked</key>
        <true/>
        <key>BundleOverwriteAction</key>
        <string>upgrade</string>
        <key>RootRelativeBundlePath</key>
        <string>TimeTracker.app</string>
    </dict>
</array>
</plist>
COMPONENT_PLIST

if [ ! -f "$PKG_OUTPUT_DIR/${APP_NAME}-component.pkg" ]; then
    log_error "Component package creation failed!"
    exit 1
fi

# Copy resources for the distribution package
cp "$INSTALLER_DIR/welcome.html" "$PKG_OUTPUT_DIR/" 2>/dev/null || true

# Create the final distribution package (with welcome screen)
log_info "Building distribution package..."

# Update distribution.xml to reference correct component pkg path
cd "$PKG_OUTPUT_DIR"

productbuild \
    --distribution "$INSTALLER_DIR/distribution.xml" \
    --package-path "$PKG_OUTPUT_DIR" \
    --resources "$INSTALLER_DIR" \
    "$PKG_OUTPUT_DIR/${APP_NAME}-Installer-${APP_VERSION}.pkg"

cd "$SCRIPT_DIR"

FINAL_PKG="$PKG_OUTPUT_DIR/${APP_NAME}-Installer-${APP_VERSION}.pkg"

if [ ! -f "$FINAL_PKG" ]; then
    log_error "Distribution package creation failed!"
    # Fallback: use the component package directly
    log_warn "Falling back to component package..."
    FINAL_PKG="$PKG_OUTPUT_DIR/${APP_NAME}-component.pkg"
fi

PKG_SIZE=$(du -sh "$FINAL_PKG" | cut -f1)
log_success ".pkg installer created: $FINAL_PKG ($PKG_SIZE)"

# =============================================================================
# Step 6: Summary
# =============================================================================
echo ""
echo "=============================================="
echo "  Build Complete!"
echo "=============================================="
echo ""
log_success "App Bundle:  $APP_PATH ($APP_SIZE)"
log_success "PKG Installer: $FINAL_PKG ($PKG_SIZE)"
echo ""
echo "Distribution Instructions:"
echo "  1. Share the .pkg file with users"
echo "  2. User right-clicks the .pkg → 'Open'"
echo "  3. User clicks 'Open' on the Gatekeeper dialog"
echo "  4. User follows the installer steps"
echo "  5. TimeTracker launches automatically!"
echo ""
echo "  No Terminal commands needed by end users."
echo ""
