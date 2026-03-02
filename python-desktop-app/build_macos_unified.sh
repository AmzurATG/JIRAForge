#!/bin/bash
#
# Unified macOS Build Script for JIRAForge Time Tracker
# Consolidates: build_simple.sh, build_macos.sh, build_macos_improved.sh, build_mac_complete.sh
# 
# Usage: ./build_macos_unified.sh [OPTIONS]
#
# Examples:
#   ./build_macos_unified.sh --mode simple
#   ./build_macos_unified.sh --mode complete --dmg --sign "Developer ID"
#   ./build_macos_unified.sh --version 1.4.0 --dmg --clean-cache
#

set -e  # Exit on any error

# ============================================================================
# CONFIGURATION
# ============================================================================

APP_NAME="TimeTracker"
BUNDLE_ID="com.jiraforge.timetracker"
DEFAULT_VERSION="1.3.0"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
PURPLE='\033[0;35m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Default settings
MODE="standard"
VERSION=$DEFAULT_VERSION
CREATE_DMG=false
SIGN_APP=false
CODESIGN_IDENTITY=""
RUN_TESTS=true
CLEAN_BUILD=true
CLEAN_CACHE=false
VERBOSE=false

# ============================================================================
# UTILITY FUNCTIONS
# ============================================================================

show_help() {
    echo -e "${BLUE}JIRAForge Time Tracker - Unified macOS Build Script${NC}"
    echo ""
    echo -e "${CYAN}Usage:${NC}"
    echo "    $0 [OPTIONS]"
    echo ""
    echo -e "${CYAN}Build Modes:${NC}"
    echo "    --mode simple       Minimal build (like build_simple.sh)"
    echo "    --mode standard     Standard build with full features (default)"
    echo "    --mode improved     Enhanced validation and error handling"
    echo "    --mode complete     Complete build with cache cleaning"
    echo ""
    echo -e "${CYAN}Options:${NC}"
    echo "    --version VERSION   Set application version (default: $DEFAULT_VERSION)"
    echo "    --dmg              Create DMG installer for distribution"
    echo "    --sign IDENTITY    Code sign with specified Developer ID"
    echo "    --no-tests         Skip pre-build validation tests"
    echo "    --no-clean         Skip cleaning previous builds"
    echo "    --clean-cache      Clean PyInstaller cache (for 'complete' mode)"
    echo "    --verbose          Enable verbose output"
    echo "    --help             Show this help message"
    echo ""
    echo -e "${CYAN}Examples:${NC}"
    echo "    $0 --mode simple"
    echo "    $0 --mode complete --dmg --version 2.0.0"
    echo "    $0 --mode improved --sign \"Developer ID Application: Your Name\""
    echo "    $0 --dmg --clean-cache --verbose"
    echo ""
}

print_header() {
    echo ""
    echo -e "${BLUE}🍎 JIRAForge Time Tracker - Unified macOS Builder (Mode: ${MODE})${NC}"
    echo "================================================================="
}

print_section() {
    echo ""
    echo -e "${PURPLE}$1${NC}"
}

print_info() {
    echo -e "${BLUE}$1${NC}"
}

print_success() {
    echo -e "${GREEN}$1${NC}"
}

print_warning() {
    echo -e "${YELLOW}$1${NC}"
}

print_error() {
    echo -e "${RED}$1${NC}"
}

log_verbose() {
    if [ "$VERBOSE" = true ]; then
        echo -e "${CYAN}[VERBOSE]${NC} $1"
    fi
}

# ============================================================================
# VALIDATION FUNCTIONS
# ============================================================================

check_macos() {
    print_section "🔍 Checking macOS compatibility..."
    if [[ "$OSTYPE" != "darwin"* ]]; then
        print_error "❌ This script must be run on macOS"
        exit 1
    fi
    print_success "✅ Running on macOS ${OSTYPE}"
}

check_python() {
    print_section "🐍 Checking Python installation..."
    
    if ! command -v python3 &> /dev/null; then
        print_error "❌ Python 3 is required but not installed"
        print_info "Install Python from: https://www.python.org/downloads/"
        exit 1
    fi
    
    PYTHON_VERSION=$(python3 --version | cut -d' ' -f2)
    print_success "✅ Python ${PYTHON_VERSION} found"
    
    # Check minimum version (3.8+)
    if ! python3 -c "import sys; exit(0 if sys.version_info >= (3, 8) else 1)" 2>/dev/null; then
        print_error "❌ Python 3.8+ is required. Current: ${PYTHON_VERSION}"
        exit 1
    fi
    
    log_verbose "Python version check passed"
}

check_xcode() {
    print_section "🔧 Checking Xcode Command Line Tools..."
    
    if ! command -v xcodebuild &> /dev/null; then
        print_warning "⚠️  Xcode Command Line Tools not found"
        if [ "$MODE" = "improved" ] || [ "$MODE" = "complete" ]; then
            print_info "Installing Xcode Command Line Tools..."
            xcode-select --install || print_warning "⚠️  Please install manually if needed"
        else
            print_warning "⚠️  May be needed for some dependencies"
        fi
    else
        print_success "✅ Xcode Command Line Tools found"
        log_verbose "Xcode tools version: $(xcodebuild -version | head -1)"
    fi
}

check_required_files() {
    print_section "📋 Checking required files..."
    
    local spec_file=""
    local main_file=""
    local requirements_file="requirements-macos.txt"
    
    case "$MODE" in
        simple)
            spec_file="desktop_app_mac_simple.spec"
            main_file="mac_desktop_app.py"
            ;;
        *)
            spec_file="desktop_app_mac.spec"
            main_file="mac_desktop_app.py"
            ;;
    esac
    
    # Check main Python file
    if [ ! -f "$main_file" ]; then
        print_error "❌ Main file not found: $main_file"
        exit 1
    fi
    print_success "✅ Main file found: $main_file"
    
    # Check spec file
    if [ ! -f "$spec_file" ]; then
        print_error "❌ PyInstaller spec file not found: $spec_file"
        exit 1
    fi
    print_success "✅ Spec file found: $spec_file"
    
    # Check requirements
    if [ ! -f "$requirements_file" ]; then
        print_error "❌ Requirements file not found: $requirements_file"
        exit 1
    fi
    print_success "✅ Requirements file found: $requirements_file"
    
    log_verbose "All required files validated"
}

# ============================================================================
# BUILD FUNCTIONS
# ============================================================================

clean_previous_builds() {
    if [ "$CLEAN_BUILD" = false ]; then
        log_verbose "Skipping build cleanup (--no-clean specified)"
        return
    fi
    
    print_section "🧹 Cleaning previous builds..."
    
    # Standard cleanup
    rm -rf build/ dist/ *.spec.bak
    rm -rf venv/__pycache__/ *.pyc __pycache__/
    print_info "   ✅ Cleaned build artifacts"
    
    # Mode-specific cleanup
    if [ "$MODE" = "complete" ] && [ "$CLEAN_CACHE" = true ]; then
        print_info "   🧹 Cleaning PyInstaller cache..."
        rm -rf ~/Library/Application\ Support/pyinstaller/ 2>/dev/null || true
        rm -rf ~/.pyinstaller/ 2>/dev/null || true
        print_success "   ✅ PyInstaller cache cleaned"
    fi
    
    log_verbose "Build cleanup completed"
}

setup_python_environment() {
    print_section "🐍 Setting up Python environment..."
    
    # Create virtual environment
    if [ ! -d "venv" ]; then
        print_info "   Creating virtual environment..."
        python3 -m venv venv
        log_verbose "Virtual environment created"
    else
        print_info "   Using existing virtual environment..."
    fi
    
    print_info "   Activating virtual environment..."
    source venv/bin/activate
    
    # Upgrade pip and build tools
    print_info "   Upgrading build tools..."
    if [ "$VERBOSE" = true ]; then
        pip install --upgrade pip setuptools wheel
    else
        pip install --upgrade pip setuptools wheel >/dev/null 2>&1
    fi
    
    # Install PyInstaller
    print_info "   Installing PyInstaller..."
    if [ "$MODE" = "complete" ]; then
        # Use specific PyInstaller version for complete mode
        if [ "$VERBOSE" = true ]; then
            pip install pyinstaller==6.3.0
        else
            pip install pyinstaller==6.3.0 >/dev/null 2>&1
        fi
    else
        if [ "$VERBOSE" = true ]; then
            pip install pyinstaller
        else
            pip install pyinstaller >/dev/null 2>&1
        fi
    fi
    
    log_verbose "Python environment setup completed"
}

install_dependencies() {
    print_section "📦 Installing dependencies..."
    
    case "$MODE" in
        simple)
            # Minimal dependencies for simple mode
            print_info "   Installing minimal requirements..."
            local deps="flask flask-cors pillow supabase pystray pynput keyring psutil requests python-dotenv cryptography"
            deps="$deps pyobjc-framework-cocoa pyobjc-framework-quartz pyobjc-framework-usernotifications"
            
            if [ "$VERBOSE" = true ]; then
                pip install $deps
            else
                pip install $deps >/dev/null 2>&1
            fi
            ;;
        *)
            # Full requirements file for other modes
            print_info "   Installing from requirements-macos.txt..."
            if [ "$VERBOSE" = true ]; then
                pip install -r requirements-macos.txt
            else
                pip install -r requirements-macos.txt >/dev/null 2>&1
            fi
            ;;
    esac
    
    print_success "   ✅ Dependencies installed successfully"
    log_verbose "Dependency installation completed"
}

validate_dependencies() {
    if [ "$MODE" = "improved" ] || [ "$MODE" = "complete" ]; then
        print_section "🔍 Validating critical dependencies..."
        
        python3 -c "
import sys
try:
    import PIL.Image, PIL.ImageGrab
    import supabase
    import pystray
    import pynput
    print('   ✅ All critical dependencies validated')
except ImportError as e:
    print(f'   ❌ Missing dependency: {e}')
    sys.exit(1)
except Exception as e:
    print(f'   ⚠️  Dependency check warning: {e}')
"
        
        log_verbose "Dependency validation completed"
    fi
}

run_pre_build_tests() {
    if [ "$RUN_TESTS" = false ]; then
        log_verbose "Skipping pre-build tests (--no-tests specified)"
        return
    fi
    
    if [ "$MODE" = "improved" ] || [ "$MODE" = "complete" ]; then
        print_section "🧪 Running pre-build validation tests..."
        
        # Check if test file exists
        if [ -f "test_mac_build.py" ]; then
            if python3 test_mac_build.py; then
                print_success "   ✅ All validation tests passed"
            else
                print_error "   ❌ Validation tests failed"
                print_info "   Build aborted. Fix issues and try again."
                exit 1
            fi
        else
            print_warning "   ⚠️  No test file found (test_mac_build.py), skipping tests"
        fi
        
        log_verbose "Pre-build tests completed"
    fi
}

update_version_info() {
    print_section "📝 Configuring build settings..."
    
    local spec_file=""
    case "$MODE" in
        simple)
            spec_file="desktop_app_mac_simple.spec"
            ;;
        *)
            spec_file="desktop_app_mac.spec"
            ;;
    esac
    
    # Backup original spec file
    cp "$spec_file" "${spec_file}.bak"
    
    # Update version numbers
    sed -i '' "s/version='[^']*'/version='$VERSION'/g" "$spec_file"
    sed -i '' "s/'CFBundleShortVersionString': '[^']*'/'CFBundleShortVersionString': '$VERSION'/g" "$spec_file"
    sed -i '' "s/'CFBundleVersion': '[^']*'/'CFBundleVersion': '$VERSION'/g" "$spec_file"
    
    print_success "   ✅ Version set to: $VERSION"
    
    # Check for app icon
    local icon_file=""
    if [ -f "assets/icon.icns" ]; then
        icon_file="assets/icon.icns"
        print_success "   ✅ App icon found: $icon_file"
    elif [ -f "icon.icns" ]; then
        icon_file="icon.icns"
        print_success "   ✅ App icon found: $icon_file"
    else
        print_warning "   ⚠️  No app icon found (will use default)"
        # Remove icon reference from spec if no icon exists
        sed -i '' "s/icon='[^']*'/icon=None/g" "$spec_file"
    fi
    
    log_verbose "Version and icon configuration completed"
}

build_application() {
    print_section "🔨 Building macOS application..."
    
    local spec_file=""
    case "$MODE" in
        simple)
            spec_file="desktop_app_mac_simple.spec"
            ;;
        *)
            spec_file="desktop_app_mac.spec"
            ;;
    esac
    
    print_info "   This may take 2-5 minutes depending on your system..."
    print_info "   Building application bundle (.app)..."
    echo ""
    
    # Build with PyInstaller
    local pyinstaller_args="$spec_file --clean --noconfirm"
    
    if [ "$VERBOSE" = false ]; then
        pyinstaller_args="$pyinstaller_args --log-level=WARN"
    fi
    
    if pyinstaller $pyinstaller_args; then
        echo ""
        print_success "✅ PyInstaller build completed successfully!"
    else
        echo ""
        print_error "❌ PyInstaller build failed"
        print_info ""
        print_info "Troubleshooting tips:"
        print_info "1. Try running with --verbose for more details"
        print_info "2. Try with --clean-cache flag"
        print_info "3. Check Python version is 3.8+ and dependencies are installed"
        print_info "4. Ensure Xcode Command Line Tools are installed"
        exit 1
    fi
    
    log_verbose "Application build completed"
}

validate_build_output() {
    print_section "🔍 Validating build output..."
    
    if [ ! -d "dist/${APP_NAME}.app" ]; then
        print_error "❌ Application bundle not found after build"
        print_info "Expected: dist/${APP_NAME}.app"
        exit 1
    fi
    
    # Get app information
    local app_size=$(du -sh "dist/${APP_NAME}.app" | cut -f1)
    print_success "🎉 macOS Application Successfully Created!"
    echo ""
    print_info "📱 Application Details:"
    print_info "   Name: ${APP_NAME}.app"
    print_info "   Bundle ID: ${BUNDLE_ID}"
    print_info "   Version: ${VERSION}"
    print_info "   Size: ${app_size}"
    print_info "   Location: $(pwd)/dist/${APP_NAME}.app"
    echo ""
    
    # Validate app structure
    print_info "🔍 Validating app structure..."
    
    if [ -f "dist/${APP_NAME}.app/Contents/Info.plist" ]; then
        print_success "   ✅ Info.plist found"
    else
        print_warning "   ❌ Info.plist missing"
    fi
    
    if [ -f "dist/${APP_NAME}.app/Contents/MacOS/TimeTrackerMac" ]; then
        print_success "   ✅ Executable found"
        # Make sure it's executable
        chmod +x "dist/${APP_NAME}.app/Contents/MacOS/TimeTrackerMac"
    else
        print_warning "   ❌ Executable missing"
    fi
    
    log_verbose "Build validation completed"
}

handle_code_signing() {
    print_section "🔐 Code signing..."
    
    if [ "$SIGN_APP" = true ] && [ -n "$CODESIGN_IDENTITY" ]; then
        print_info "   Code signing application..."
        
        local entitlements=""
        if [ -f "entitlements.plist" ]; then
            entitlements="--entitlements entitlements.plist"
        fi
        
        if codesign --deep --force --verify --verbose --sign "$CODESIGN_IDENTITY" \
                   --options runtime $entitlements \
                   "dist/${APP_NAME}.app"; then
            print_success "   ✅ Application successfully code signed"
            
            # Verify signing
            if codesign --verify --verbose "dist/${APP_NAME}.app" >/dev/null 2>&1; then
                print_success "   ✅ Code signature verified"
            fi
        else
            print_error "   ❌ Code signing failed"
            print_info "   Check your Developer ID certificate and identity"
        fi
    else
        # Check existing signing status
        if codesign -dv "dist/${APP_NAME}.app" >/dev/null 2>&1; then
            print_success "   ✅ Application is already code signed"
        else
            print_warning "   ⚠️  Application is not code signed"
            print_info "   For distribution, consider code signing with:"
            print_info "   $0 --sign \"Developer ID Application: Your Name\""
        fi
    fi
    
    log_verbose "Code signing handling completed"
}

create_dmg_installer() {
    if [ "$CREATE_DMG" = false ]; then
        log_verbose "Skipping DMG creation (not requested)"
        return
    fi
    
    print_section "📦 Creating DMG installer..."
    
    local dmg_name="${APP_NAME}-${VERSION}-macOS"
    local dmg_path="dist/${dmg_name}.dmg"
    local dmg_temp="dist/dmg_temp"
    
    # Remove existing DMG
    rm -f "$dmg_path"
    
    # Check if hdiutil is available
    if ! command -v hdiutil >/dev/null 2>&1; then
        print_error "   ❌ hdiutil not available - cannot create DMG"
        return
    fi
    
    # Create temporary directory for DMG contents
    mkdir -p "$dmg_temp"
    
    # Copy app to temp directory
    cp -R "dist/${APP_NAME}.app" "$dmg_temp/"
    
    # Create Applications symlink for easy installation
    ln -sf /Applications "$dmg_temp/Applications"
    
    # Create the DMG
    print_info "   Creating DMG image..."
    if hdiutil create -volname "$APP_NAME" -srcfolder "$dmg_temp" -ov -format UDZO "$dmg_path" >/dev/null 2>&1; then
        # Clean up temp directory
        rm -rf "$dmg_temp"
        
        if [ -f "$dmg_path" ]; then
            local dmg_size=$(du -sh "$dmg_path" | cut -f1)
            print_success "   ✅ DMG installer created: ${dmg_name}.dmg (${dmg_size})"
        else
            print_error "   ❌ DMG creation appeared successful but file not found"
        fi
    else
        print_error "   ❌ Failed to create DMG"
        rm -rf "$dmg_temp"
    fi
    
    log_verbose "DMG creation completed"
}

create_zip_archive() {
    if [ "$MODE" = "simple" ]; then
        log_verbose "Skipping ZIP creation for simple mode"
        return
    fi
    
    print_section "📦 Creating ZIP archive..."
    
    local zip_name="${APP_NAME}-${VERSION}-macOS.zip"
    
    # Create ZIP archive
    cd dist
    zip -r "$zip_name" "${APP_NAME}.app" >/dev/null 2>&1
    cd ..
    
    if [ -f "dist/$zip_name" ]; then
        local zip_size=$(du -sh "dist/$zip_name" | cut -f1)
        print_success "   ✅ ZIP archive created: $zip_name (${zip_size})"
    else
        print_warning "   ⚠️  ZIP archive creation failed"
    fi
    
    log_verbose "ZIP archive creation completed"
}

cleanup_temp_files() {
    print_section "🧹 Cleaning up temporary files..."
    
    # Restore spec file
    case "$MODE" in
        simple)
            if [ -f "desktop_app_mac_simple.spec.bak" ]; then
                mv desktop_app_mac_simple.spec.bak desktop_app_mac_simple.spec
            fi
            ;;
        *)
            if [ -f "desktop_app_mac.spec.bak" ]; then
                mv desktop_app_mac.spec.bak desktop_app_mac.spec
            fi
            ;;
    esac
    
    print_success "   ✅ Cleanup completed"
    log_verbose "Temporary file cleanup completed"
}

show_final_summary() {
    print_section "📋 Build Summary"
    
    echo -e "${GREEN}🎉 Build Completed Successfully!${NC}"
    echo ""
    
    print_info "📱 Generated Files:"
    print_info "   🍎 Mac App Bundle: dist/${APP_NAME}.app"
    
    if [ "$CREATE_DMG" = true ] && [ -f "dist/${APP_NAME}-${VERSION}-macOS.dmg" ]; then
        print_info "   💿 DMG Installer: dist/${APP_NAME}-${VERSION}-macOS.dmg"
    fi
    
    if [ "$MODE" != "simple" ] && [ -f "dist/${APP_NAME}-${VERSION}-macOS.zip" ]; then
        print_info "   📦 ZIP Archive: dist/${APP_NAME}-${VERSION}-macOS.zip"
    fi
    
    echo ""
    print_info "🚀 Installation & Usage:"
    echo ""
    
    print_info "📋 To Install:"
    if [ "$CREATE_DMG" = true ] && [ -f "dist/${APP_NAME}-${VERSION}-macOS.dmg" ]; then
        print_info "1. Double-click: dist/${APP_NAME}-${VERSION}-macOS.dmg"
        print_info "2. Drag ${APP_NAME}.app to Applications folder"
        print_info "3. Launch from Applications or Launchpad"
    else
        print_info "1. Copy: cp -R dist/${APP_NAME}.app /Applications/"
        print_info "2. Launch from Applications or Launchpad"
    fi
    
    echo ""
    print_info "🧪 To Test:"
    print_info "   open dist/${APP_NAME}.app"
    
    echo ""
    print_info "🔒 System Permissions Required:"
    print_info "• Screen Recording (for screenshots)"
    print_info "• Accessibility (for window monitoring)"
    print_info "• Files and Folders (for data storage)"
    
    echo ""
    if [ "$SIGN_APP" = true ]; then
        print_success "✅ App is code signed - ready for distribution"
    else
        print_warning "⚠️  For distribution to other users:"
        print_info "   • Code sign with Apple Developer ID"
        print_info "   • Consider notarization for macOS Gatekeeper"
    fi
    
    echo ""
    local build_time=$((SECONDS))
    print_info "⏱️  Total build time: ${build_time} seconds"
    echo ""
}

# ============================================================================
# MAIN EXECUTION
# ============================================================================

# Parse command line arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --mode)
            MODE="$2"
            if [[ ! "$MODE" =~ ^(simple|standard|improved|complete)$ ]]; then
                print_error "Invalid mode: $MODE"
                print_info "Valid modes: simple, standard, improved, complete"
                exit 1
            fi
            shift 2
            ;;
        --version)
            VERSION="$2"
            shift 2
            ;;
        --dmg)
            CREATE_DMG=true
            shift
            ;;
        --sign)
            SIGN_APP=true
            CODESIGN_IDENTITY="$2"
            shift 2
            ;;
        --no-tests)
            RUN_TESTS=false
            shift
            ;;
        --no-clean)
            CLEAN_BUILD=false
            shift
            ;;
        --clean-cache)
            CLEAN_CACHE=true
            shift
            ;;
        --verbose)
            VERBOSE=true
            shift
            ;;
        --help)
            show_help
            exit 0
            ;;
        *)
            print_error "Unknown option: $1"
            print_info "Use --help for usage information"
            exit 1
            ;;
    esac
done

# Start build process
SECONDS=0  # Reset timer

print_header

# Pre-flight checks
check_macos
check_python

# Mode-specific checks
if [ "$MODE" = "improved" ] || [ "$MODE" = "complete" ]; then
    check_xcode
fi

check_required_files

# Build process
clean_previous_builds
setup_python_environment
install_dependencies

# Mode-specific steps
if [ "$MODE" = "improved" ] || [ "$MODE" = "complete" ]; then
    validate_dependencies
    run_pre_build_tests
fi

update_version_info
build_application
validate_build_output

# Post-build steps
handle_code_signing
create_dmg_installer

if [ "$MODE" != "simple" ]; then
    create_zip_archive
fi

cleanup_temp_files
show_final_summary

print_success "🎯 Build completed successfully!"