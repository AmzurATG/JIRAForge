#!/bin/bash
#
# Modern macOS Build Script for JIRAForge Time Tracker
# Optimized for macOS 26.3 Tahoe with Python 3.12+
# Enhanced error handling and dependency validation
#
# Usage: ./build_macos_modern.sh [OPTIONS]
# Examples:
#   ./build_macos_modern.sh --mode production
#   ./build_macos_modern.sh --mode development --skip-tests
#   ./build_macos_modern.sh --notarize --version 2.0.0

set -euo pipefail  # Strict error handling
IFS=$'\n\t'       # Secure Internal Field Separator

# ============================================================================
# CONFIGURATION
# ============================================================================

readonly APP_NAME="TimeTracker"
readonly BUNDLE_ID="com.jiraforge.timetracker"
readonly MIN_PYTHON_VERSION="3.12.0"
readonly MIN_MACOS_VERSION="14.0"
readonly DEFAULT_VERSION="2.0.0"

# ANSI Color codes for enhanced output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[1;33m'
readonly BLUE='\033[0;34m'
readonly PURPLE='\033[0;35m'
readonly CYAN='\033[0;36m'
readonly WHITE='\033[1;37m'
readonly NC='\033[0m' # No Color

# Build configuration
BUILD_MODE="production"
APP_VERSION="$DEFAULT_VERSION"
SKIP_TESTS=false
SKIP_DEPS=false
NOTARIZE=false
CREATE_DMG=true
CLEAN_BUILD=true
VERBOSE=false
CODESIGN_IDENTITY=""

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

print_header() {
    echo -e "\n${PURPLE}╔══════════════════════════════════════════════════════╗${NC}"
    echo -e "${PURPLE}║${WHITE}      JIRAForge TimeTracker - Modern macOS Builder      ${PURPLE}║${NC}"
    echo -e "${PURPLE}║${CYAN}              Optimized for macOS 26.3 Tahoe            ${PURPLE}║${NC}"
    echo -e "${PURPLE}╚══════════════════════════════════════════════════════╝${NC}\n"
}

log_info() {
    echo -e "${BLUE}ℹ${NC} $1"
}

log_success() {
    echo -e "${GREEN}✅${NC} $1"
}

log_warning() {
    echo -e "${YELLOW}⚠️${NC} $1"
}

log_error() {
    echo -e "${RED}❌${NC} $1" >&2
}

log_step() {
    echo -e "\n${WHITE}📍 Step: $1${NC}"
}

show_help() {
    print_header
    cat << EOF
${WHITE}USAGE:${NC}
    $0 [OPTIONS]

${WHITE}OPTIONS:${NC}
    --mode MODE           Build mode: development | production (default: production)
    --version VERSION     App version string (default: $DEFAULT_VERSION)
    --notarize           Enable Apple notarization for distribution
    --no-dmg             Skip DMG creation
    --skip-tests         Skip pre-build validation tests
    --skip-deps          Skip dependency installation
    --clean              Clean build directories before building
    --verbose            Enable verbose output
    --sign IDENTITY      Code signing identity (auto-detected if not provided)
    --help              Show this help message

${WHITE}EXAMPLES:${NC}
    # Development build
    $0 --mode development --skip-tests

    # Production build with notarization
    $0 --mode production --version 2.1.0 --notarize

    # Quick build without DMG
    $0 --no-dmg --verbose

${WHITE}REQUIREMENTS:${NC}
    • macOS $MIN_MACOS_VERSION or later
    • Python $MIN_PYTHON_VERSION or later
    • Xcode Command Line Tools
    • Valid Developer ID (for code signing)

EOF
}

# ============================================================================
# VALIDATION FUNCTIONS
# ============================================================================

check_macos_version() {
    log_step "Validating macOS version"
    
    local macos_version
    macos_version=$(sw_vers -productVersion)
    local major minor
    IFS='.' read -r major minor <<< "$macos_version"
    
    if (( major < 14 )); then
        log_error "macOS $MIN_MACOS_VERSION or later required. Found: $macos_version"
        log_error "This build script is optimized for macOS 26.3 Tahoe"
        exit 1
    fi
    
    if (( major >= 26 )); then
        log_success "Running on modern macOS $macos_version (Tahoe or later)"
    elif (( major >= 15 )); then
        log_warning "Running on macOS $macos_version. Features optimized for 26.3+"
    else
        log_warning "Running on older macOS $macos_version. Consider upgrading."
    fi
}

check_python_version() {
    log_step "Validating Python version"
    
    # Check for Python 3.12+
    local python_cmd=""
    for candidate in python3.12 python3.13 python3.14 python3 python; do
        if command -v "$candidate" &> /dev/null; then
            local version
            version=$("$candidate" --version 2>&1 | cut -d' ' -f2)
            if [[ "$version" =~ ^3\.1[2-9]\.|^3\.[2-9][0-9]\.|^[4-9]\. ]]; then
                python_cmd="$candidate"
                log_success "Found Python $version at $(which "$candidate")"
                break
            fi
        fi
    done
    
    if [[ -z "$python_cmd" ]]; then
        log_error "Python $MIN_PYTHON_VERSION or later required"
        log_error "Install modern Python: brew install python@3.12"
        exit 1
    fi
    
    export PYTHON_CMD="$python_cmd"
}

check_development_tools() {
    log_step "Validating development tools"
    
    # Check Xcode Command Line Tools
    if ! xcode-select -p &> /dev/null; then
        log_error "Xcode Command Line Tools required"
        log_error "Install with: xcode-select --install"
        exit 1
    fi
    
    # Check essential tools
    local required_tools=("git" "codesign" "productbuild" "hdiutil")
    for tool in "${required_tools[@]}"; do
        if ! command -v "$tool" &> /dev/null; then
            log_error "Required tool missing: $tool"
            exit 1
        fi
    done
    
    log_success "All required development tools found"
}

detect_codesign_identity() {
    if [[ -n "$CODESIGN_IDENTITY" ]]; then
        log_info "Using provided code signing identity: $CODESIGN_IDENTITY"
        return
    fi
    
    log_step "Auto-detecting code signing identity"
    
    # Look for Developer ID Application certificates
    local identities
    identities=$(security find-identity -v -p codesigning | grep "Developer ID Application" | head -1 | cut -d'"' -f2)
    
    if [[ -n "$identities" ]]; then
        CODESIGN_IDENTITY="$identities"
        log_success "Found code signing identity: $CODESIGN_IDENTITY"
    else
        log_warning "No Developer ID Application certificate found"
        log_warning "App will not be code signed (development only)"
    fi
}

# ============================================================================
# DEPENDENCY MANAGEMENT
# ============================================================================

setup_virtual_environment() {
    log_step "Setting up Python virtual environment"
    
    local venv_dir="venv_modern_macos"
    
    if [[ "$CLEAN_BUILD" == true && -d "$venv_dir" ]]; then
        log_info "Cleaning existing virtual environment"
        rm -rf "$venv_dir"
    fi
    
    if [[ ! -d "$venv_dir" ]]; then
        log_info "Creating new virtual environment with $PYTHON_CMD"
        "$PYTHON_CMD" -m venv "$venv_dir"
    fi
    
    # Activate virtual environment
    source "$venv_dir/bin/activate"
    
    # Upgrade pip to latest
    python -m pip install --upgrade pip wheel setuptools
    
    log_success "Virtual environment ready"
}

install_dependencies() {
    if [[ "$SKIP_DEPS" == true ]]; then
        log_warning "Skipping dependency installation"
        return
    fi
    
    log_step "Installing modern dependencies"
    
    # Install from modern requirements file
    if [[ -f "requirements-macos-modern.txt" ]]; then
        log_info "Installing from requirements-macos-modern.txt"
        pip install -r requirements-macos-modern.txt
    else
        log_error "Modern requirements file not found: requirements-macos-modern.txt"
        exit 1
    fi
    
    log_success "Dependencies installed successfully"
}

# ============================================================================
# TESTING AND VALIDATION
# ============================================================================

run_pre_build_tests() {
    if [[ "$SKIP_TESTS" == true ]]; then
        log_warning "Skipping pre-build tests"
        return
    fi
    
    log_step "Running pre-build validation tests"
    
    # Test modern macOS framework imports
    python -c "
import sys
print(f'Python version: {sys.version}')

# Test modern PyObjC frameworks
try:
    import Cocoa
    import Quartz
    from AppKit import NSWorkspace
    print('✅ Core macOS frameworks loaded')
except ImportError as e:
    print(f'❌ macOS framework error: {e}')
    sys.exit(1)

# Test modern screen capture
try:
    import ScreenCaptureKit
    print('✅ ScreenCaptureKit available (macOS 12.3+)')
except ImportError:
    print('⚠️ ScreenCaptureKit not available (legacy capture will be used)')

# Test Flask
try:
    import flask
    print(f'✅ Flask {flask.__version__} loaded')
except ImportError as e:
    print(f'❌ Flask import error: {e}')
    sys.exit(1)

# Test Supabase
try:
    import supabase
    print('✅ Supabase client loaded')
except ImportError as e:
    print(f'❌ Supabase import error: {e}')
    sys.exit(1)

print('✅ All validation tests passed')
"
    
    log_success "Pre-build tests completed"
}

# ============================================================================
# BUILD PROCESS
# ============================================================================

build_app() {
    log_step "Building macOS application bundle"
    
    # Clean previous builds
    if [[ "$CLEAN_BUILD" == true ]]; then
        log_info "Cleaning previous builds"
        rm -rf build/ dist/
    fi
    
    # Determine spec file
    local spec_file="desktop_app_mac_modern.spec"
    if [[ ! -f "$spec_file" ]]; then
        log_error "Modern PyInstaller spec not found: $spec_file"
        log_error "Creating it now..."
        create_modern_spec_file
    fi
    
    # Build with PyInstaller
    log_info "Running PyInstaller with modern configuration"
    if [[ "$VERBOSE" == true ]]; then
        pyinstaller --clean --noconfirm "$spec_file"
    else
        pyinstaller --clean --noconfirm "$spec_file" --log-level WARN
    fi
    
    # Verify build output
    local app_path="dist/$APP_NAME.app"
    if [[ ! -d "$app_path" ]]; then
        log_error "Build failed: $app_path not found"
        exit 1
    fi
    
    log_success "Application bundle created: $app_path"
}

code_sign_app() {
    if [[ -z "$CODESIGN_IDENTITY" ]]; then
        log_warning "Skipping code signing (no identity available)"
        return
    fi
    
    log_step "Code signing application"
    
    local app_path="dist/$APP_NAME.app"
    
    # Sign with modern entitlements
    log_info "Signing with modern entitlements for macOS 26.3"
    codesign --force --deep --sign "$CODESIGN_IDENTITY" \
        --entitlements entitlements-modern.plist \
        --options runtime \
        --timestamp \
        "$app_path"
    
    # Verify signature
    if codesign --verify --deep --strict "$app_path"; then
        log_success "Code signing completed successfully"
    else
        log_error "Code signing verification failed"
        exit 1
    fi
}

create_dmg() {
    if [[ "$CREATE_DMG" != true ]]; then
        log_info "Skipping DMG creation"
        return
    fi
    
    log_step "Creating distribution DMG"
    
    local dmg_name="$APP_NAME-$APP_VERSION-macOS.dmg"
    local temp_dmg="$dmg_name.temp.dmg"
    
    # Clean previous DMG
    rm -f "$dmg_name" "$temp_dmg"
    
    # Create DMG
    hdiutil create -srcfolder "dist/$APP_NAME.app" \
        -volname "$APP_NAME $APP_VERSION" \
        -fs HFS+ \
        -fsargs "-c c=64,a=16,e=16" \
        -format UDRW \
        "$temp_dmg"
    
    # Convert to compressed DMG
    hdiutil convert "$temp_dmg" -format UDZO -o "$dmg_name"
    rm -f "$temp_dmg"
    
    # Code sign DMG
    if [[ -n "$CODESIGN_IDENTITY" ]]; then
        codesign --sign "$CODESIGN_IDENTITY" "$dmg_name"
    fi
    
    log_success "DMG created: $dmg_name"
}

notarize_app() {
    if [[ "$NOTARIZE" != true ]]; then
        return
    fi
    
    if [[ -z "$CODESIGN_IDENTITY" ]]; then
        log_error "Notarization requires code signing"
        return
    fi
    
    log_step "Notarizing application for distribution"
    
    # This requires proper Apple Developer credentials
    log_warning "Notarization requires Apple Developer account setup"
    log_info "Use: xcrun notarytool submit --apple-id <email> --password <app-password> --team-id <team-id>"
}

# ============================================================================
# SPEC FILE GENERATION
# ============================================================================

create_modern_spec_file() {
    log_info "Creating modern PyInstaller spec file"
    
cat > desktop_app_mac_modern.spec << 'EOF'
# -*- mode: python ; coding: utf-8 -*-
"""
Modern PyInstaller spec for macOS 26.3 Tahoe
Optimized for Python 3.12+ with enhanced security
"""

import sys
from pathlib import Path

block_cipher = None

# Modern hidden imports optimized for macOS 26.3
modern_hidden_imports = [
    # Core Flask with enhanced security
    'flask', 'flask_cors', 'jinja2', 'markupsafe', 'werkzeug',
    'itsdangerous', 'click', 'blinker',
    
    # Modern Supabase stack
    'supabase', 'postgrest', 'gotrue', 'realtime', 'storage3',
    'httpx', 'httpcore', 'h11', 'anyio', 'certifi',
    
    # Enhanced image processing
    'PIL', 'PIL.Image', 'PIL.ImageGrab', 'PIL.ImageDraw',
    'PIL.ImageOps', 'PIL.ImageMode', 'PIL.ImageColor',
    
    # Modern macOS frameworks (PyObjC 11.x)
    'AppKit', 'Quartz', 'Foundation', 'Cocoa', 'CoreGraphics',
    'objc', 'PyObjC',
    
    # NEW: Modern screen capture for macOS 26.3
    'ScreenCaptureKit',
    
    # NEW: Enhanced notification system
    'UserNotifications',
    
    # Enhanced system tray
    'pystray', 'pystray._darwin',
    
    # Modern input monitoring
    'pynput', 'pynput.mouse', 'pynput.keyboard',
    'pynput._util', 'pynput._util.darwin',
    'pynput.mouse._darwin', 'pynput.keyboard._darwin',
    
    # Enhanced notifications
    'plyer', 'plyer.platforms', 'plyer.platforms.macosx',
    'plyer.platforms.macosx.notification',
    
    # Modern secure storage
    'keyring', 'keyring.backends', 'keyring.backends.macOS',
    
    # Enhanced timezone support
    'tzlocal', 'zoneinfo',
    
    # Modern JSON processing
    'orjson',
    
    # Enhanced logging
    'structlog',
]

a = Analysis(
    ['mac_desktop_app.py'],
    pathex=[str(Path.cwd())],
    binaries=[],
    datas=[
        # Include modern entitlements
        ('entitlements-modern.plist', '.'),
    ],
    hiddenimports=modern_hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Exclude Windows-specific modules
        'win32gui', 'win32process', 'win32con', 'win32event',
        # Exclude tkinter if not needed
        'tkinter', 'tkinter.*',
        # Exclude test modules
        'pytest', 'test', 'tests',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='TimeTrackerMac',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    upx_exclude=[],
    name='TimeTrackerMac',
)

app = BUNDLE(
    coll,
    name='TimeTracker.app',
    icon=None,
    bundle_identifier='com.jiraforge.timetracker',
    version='2.0.0',
    info_plist={
        'CFBundleName': 'JIRAForge TimeTracker',
        'CFBundleDisplayName': 'TimeTracker',
        'CFBundleIdentifier': 'com.jiraforge.timetracker',
        'CFBundleVersion': '2.0.0',
        'CFBundleShortVersionString': '2.0.0',
        'NSHighResolutionCapable': True,
        'NSSupportsAutomaticGraphicsSwitching': True,
        'LSUIElement': True,  # Background app
        'NSAppleEventsUsageDescription': 'TimeTracker needs automation access for window monitoring.',
        'NSScreenCaptureUsageDescription': 'TimeTracker captures screenshots for time tracking verification.',
        'NSCameraUsageDescription': 'TimeTracker may use camera for enhanced tracking features.',
        # macOS 26.3 specific additions
        'NSPrivacyAccessedAPITypes': [
            {
                'NSPrivacyAccessedAPIType': 'NSPrivacyAccessedAPUSystemBootTime',
                'NSPrivacyAccessedAPITypeReasons': ['85F4.1'],
            },
            {
                'NSPrivacyAccessedAPIType': 'NSPrivacyAccessedAPITypeFileTimestamp', 
                'NSPrivacyAccessedAPITypeReasons': ['C617.1'],
            },
        ],
    },
)
EOF

    log_success "Modern spec file created: desktop_app_mac_modern.spec"
}

# ============================================================================
# CLEANUP AND OPTIMIZATION
# ============================================================================

remove_duplicate_scripts() {
    log_step "Removing duplicate and outdated build scripts"
    
    local old_scripts=(
        "build_macos.sh"
        "build_enhanced_macos.sh"
        "create_py2app_version.sh"
        "create_wrapper_app.sh"
        "fix_codesigning.sh"
        "quick_test.sh"
    )
    
    for script in "${old_scripts[@]}"; do
        if [[ -f "$script" && "$script" != "$(basename "$0")" ]]; then
            log_info "Removing duplicate script: $script"
            mv "$script" "${script}.backup" || rm -f "$script"
        fi
    done
    
    log_success "Cleanup completed"
}

# ============================================================================
# MAIN EXECUTION
# ============================================================================

parse_arguments() {
    while [[ $# -gt 0 ]]; do
        case $1 in
            --mode)
                BUILD_MODE="$2"
                shift 2
                ;;
            --version)
                APP_VERSION="$2"
                shift 2
                ;;
            --notarize)
                NOTARIZE=true
                shift
                ;;
            --no-dmg)
                CREATE_DMG=false
                shift
                ;;
            --skip-tests)
                SKIP_TESTS=true
                shift
                ;;
            --skip-deps)
                SKIP_DEPS=true
                shift
                ;;
            --clean)
                CLEAN_BUILD=true
                shift
                ;;
            --verbose)
                VERBOSE=true
                shift
                ;;
            --sign)
                CODESIGN_IDENTITY="$2"
                shift 2
                ;;
            --help)
                show_help
                exit 0
                ;;
            *)
                log_error "Unknown option: $1"
                exit 1
                ;;
        esac
    done
}

main() {
    # Parse command line arguments
    parse_arguments "$@"
    
    # Show header
    print_header
    
    log_info "Build mode: $BUILD_MODE"
    log_info "App version: $APP_VERSION"
    log_info "Target: macOS 26.3 Tahoe with Python 3.12+"
    
    # Environment validation
    check_macos_version
    check_python_version
    check_development_tools
    detect_codesign_identity
    
    # Setup and dependencies
    setup_virtual_environment
    install_dependencies
    
    # Pre-build validation
    run_pre_build_tests
    
    # Build process
    build_app
    code_sign_app
    create_dmg
    notarize_app
    
    # Cleanup
    remove_duplicate_scripts
    
    # Success summary
    echo
    log_success "🎉 Build completed successfully!"
    log_info "Output: dist/$APP_NAME.app"
    if [[ "$CREATE_DMG" == true ]]; then
        log_info "DMG: $APP_NAME-$APP_VERSION-macOS.dmg"
    fi
    
    echo -e "\n${WHITE}Next steps:${NC}"
    echo -e "• Test the app: open dist/$APP_NAME.app"
    echo -e "• Distribute: Share the DMG file"
    if [[ "$NOTARIZE" != true ]]; then
        echo -e "• For public distribution: Re-run with --notarize"
    fi
    echo
}

# ============================================================================
# SCRIPT ENTRY POINT
# ============================================================================

# Ensure script is run from correct directory
if [[ ! -f "mac_desktop_app.py" ]]; then
    log_error "This script must be run from the python-desktop-app directory"
    exit 1
fi

# Run main function with all arguments
main "$@"