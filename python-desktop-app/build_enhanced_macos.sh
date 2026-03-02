#!/bin/bash
#
# Enhanced macOS Build Script with Auto-Launch & Cross-Compatibility
# Builds TimeTracker.app for distribution across different Mac systems
#
# Usage: ./build_enhanced_macos.sh [OPTIONS]
#

set -e

# Configuration
APP_NAME="TimeTracker"
BUNDLE_ID="com.jiraforge.timetracker"
VERSION="1.2.1"
PYTHON_MIN_VERSION="3.8"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m'

print_header() {
    echo -e "${BLUE}🚀 Enhanced TimeTracker Build System${NC}"
    echo "==========================================="
}

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

# Enhanced Info.plist with auto-launch capabilities
create_enhanced_info_plist() {
    print_info "Creating enhanced Info.plist..."
    
    cat > "dist/${APP_NAME}.app/Contents/Info.plist" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDisplayName</key>
    <string>TimeTracker</string>
    <key>CFBundleExecutable</key>
    <string>TimeTrackerMac</string>
    <key>CFBundleIdentifier</key>
    <string>com.jiraforge.timetracker</string>
    <key>CFBundleInfoDictionaryVersion</key>
    <string>6.0</string>
    <key>CFBundleName</key>
    <string>TimeTracker</string>
    <key>CFBundlePackageType</key>
    <string>APPL</string>
    <key>CFBundleShortVersionString</key>
    <string>1.2.1</string>
    <key>CFBundleVersion</key>
    <string>1.2.1</string>
    <key>NSMainNibFile</key>
    <string>MainMenu</string>
    <key>NSPrincipalClass</key>
    <string>NSApplication</string>
    
    <!-- High Resolution Display Support -->
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSSupportsAutomaticGraphicsSwitching</key>
    <true/>
    
    <!-- Background App Support -->
    <key>LSBackgroundOnly</key>
    <false/>
    <key>LSUIElement</key>
    <false/>
    
    <!-- Auto-launch and system tray support -->
    <key>NSUIElement</key>
    <false/>
    <key>LSMultipleInstancesProhibited</key>
    <true/>
    
    <!-- Required Privacy Permissions -->
    <key>NSCameraUsageDescription</key>
    <string>TimeTracker needs screen recording access to capture screenshots for time tracking.</string>
    <key>NSScreenCaptureDescription</key>
    <string>TimeTracker captures periodic screenshots to analyze work activity and time spent on different tasks.</string>
    <key>NSSystemAdministrationUsageDescription</key>
    <string>TimeTracker needs accessibility permissions to monitor active windows and applications for accurate time tracking.</string>
    <key>NSAppleEventsUsageDescription</key>
    <string>TimeTracker uses AppleEvents to interact with applications for enhanced window detection.</string>
    
    <!-- Network Access -->
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsArbitraryLoads</key>
        <true/>
        <key>NSExceptionDomains</key>
        <dict>
            <key>supabase.co</key>
            <dict>
                <key>NSExceptionAllowsInsecureHTTPLoads</key>
                <true/>
                <key>NSExceptionMinimumTLSVersion</key>
                <string>TLSv1.0</string>
                <key>NSIncludesSubdomains</key>
                <true/>
            </dict>
            <key>amzur.com</key>
            <dict>
                <key>NSExceptionAllowsInsecureHTTPLoads</key>
                <true/>
                <key>NSIncludesSubdomains</key>
                <true/>
            </dict>
        </dict>
    </dict>
    
    <!-- Supported macOS Versions -->
    <key>LSMinimumSystemVersion</key>
    <string>10.15</string>
    
    <!-- File Type Associations (if needed) -->
    <key>CFBundleDocumentTypes</key>
    <array>
        <dict>
            <key>CFBundleTypeExtensions</key>
            <array>
                <string>timetracker</string>
            </array>
            <key>CFBundleTypeName</key>
            <string>TimeTracker Data</string>
            <key>CFBundleTypeRole</key>
            <string>Editor</string>
        </dict>
    </array>
    
    <!-- Launch Services Registration -->
    <key>LSApplicationCategoryType</key>
    <string>public.app-category.productivity</string>
    
    <!-- Code Signing -->
    <key>NSSupportsAutomaticCodeSigning</key>
    <true/>
    
</dict>
</plist>
EOF

    print_success "Enhanced Info.plist created"
}

# Create launch agent plist for auto-start
create_launch_agent() {
    print_info "Creating launch agent for auto-start capability..."
    
    local plist_dir="dist/LaunchAgents"
    mkdir -p "$plist_dir"
    
    cat > "$plist_dir/com.jiraforge.timetracker.plist" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.jiraforge.timetracker</string>
    <key>ProgramArguments</key>
    <array>
        <string>/Applications/TimeTracker.app/Contents/MacOS/TimeTrackerMac</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <false/>
    <key>LaunchOnlyOnce</key>
    <true/>
    <key>StandardOutPath</key>
    <string>/tmp/timetracker.log</string>
    <key>StandardErrorPath</key>
    <string>/tmp/timetracker.error.log</string>
</dict>
</plist>
EOF

    print_success "Launch agent created"
}

# Create installation script
create_installer_script() {
    print_info "Creating installation script..."
    
    cat > "dist/install_timetracker.sh" << 'EOF'
#!/bin/bash
#
# TimeTracker Installation Script
# Handles installation, permissions, and auto-launch setup
#

set -e

APP_NAME="TimeTracker"
INSTALL_PATH="/Applications"
LAUNCH_AGENTS="$HOME/Library/LaunchAgents"

print_success() {
    echo "✅ $1"
}

print_info() {
    echo "ℹ️  $1"
}

print_error() {
    echo "❌ $1"
}

echo "🚀 Installing TimeTracker..."
echo "================================"

# Check if Applications directory is writable
if [ ! -w "$INSTALL_PATH" ]; then
    print_info "Need administrator privileges to install to $INSTALL_PATH"
    if ! sudo -n true 2>/dev/null; then
        echo "Please enter your password to install TimeTracker:"
        sudo true
    fi
    SUDO_PREFIX="sudo"
else
    SUDO_PREFIX=""
fi

# Install the app
print_info "Copying TimeTracker.app to $INSTALL_PATH..."
$SUDO_PREFIX cp -R "TimeTracker.app" "$INSTALL_PATH/"

# Fix permissions
$SUDO_PREFIX chmod +x "$INSTALL_PATH/TimeTracker.app/Contents/MacOS/TimeTrackerMac"

print_success "TimeTracker installed successfully!"

# Offer to set up auto-launch
echo ""
read -p "Would you like TimeTracker to start automatically on login? (y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    print_info "Setting up auto-launch..."
    
    # Create launch agents directory if it doesn't exist
    mkdir -p "$LAUNCH_AGENTS"
    
    # Copy launch agent
    if [ -f "LaunchAgents/com.jiraforge.timetracker.plist" ]; then
        cp "LaunchAgents/com.jiraforge.timetracker.plist" "$LAUNCH_AGENTS/"
        print_success "Auto-launch configured"
    else
        print_info "Adding to login items manually..."
        osascript -e "tell application \"System Events\" to make login item at end with properties {path:\"$INSTALL_PATH/TimeTracker.app\", hidden:false}" 2>/dev/null || true
    fi
fi

# Security instructions
echo ""
echo "🔒 Important Security Notes:"
echo "================================"
print_info "When first launching TimeTracker, you'll need to grant permissions:"
echo "   • Screen Recording (System Preferences → Security & Privacy → Screen Recording)"
echo "   • Accessibility (System Preferences → Security & Privacy → Accessibility)"
echo ""
print_info "If macOS blocks the app, you can:"
echo "   • Right-click TimeTracker.app and select 'Open'"
echo "   • Or go to System Preferences → Security & Privacy and click 'Open Anyway'"
echo ""

# Launch the app
echo "🎉 Installation Complete!"
echo "=========================="
read -p "Would you like to launch TimeTracker now? (y/n): " -n 1 -r
echo
if [[ $REPLY =~ ^[Yy]$ ]]; then
    print_info "Launching TimeTracker..."
    open "$INSTALL_PATH/TimeTracker.app" || print_error "Could not launch TimeTracker. You can start it manually from Applications."
fi

echo ""
print_success "TimeTracker is ready to use!"
echo "Find it in your Applications folder or Launchpad."
EOF

    chmod +x "dist/install_timetracker.sh"
    print_success "Installation script created"
}

# Create cross-compatibility test script
create_compatibility_test() {
    print_info "Creating compatibility test script..."
    
    cat > "dist/test_compatibility.sh" << 'EOF'
#!/bin/bash
#
# TimeTracker Compatibility Test Script
# Tests if the app works on the current Mac system
#

print_success() {
    echo "✅ $1"
}

print_warning() {
    echo "⚠️  $1"
}

print_error() {
    echo "❌ $1"
}

print_info() {
    echo "ℹ️  $1"
}

echo "🧪 TimeTracker Compatibility Test"
echo "=================================="

# Check macOS version
MACOS_VERSION=$(sw_vers -productVersion)
MAJOR_VERSION=$(echo $MACOS_VERSION | cut -d. -f1)
MINOR_VERSION=$(echo $MACOS_VERSION | cut -d. -f2)

print_info "macOS Version: $MACOS_VERSION"

# Version compatibility check
if [ "$MAJOR_VERSION" -ge 11 ] || ([ "$MAJOR_VERSION" -eq 10 ] && [ "$MINOR_VERSION" -ge 15 ]); then
    print_success "macOS version compatible"
else
    print_warning "macOS version may not be fully compatible (require 10.15+)"
fi

# Architecture check
ARCH=$(uname -m)
print_info "Architecture: $ARCH"

if [ "$ARCH" = "x86_64" ]; then
    print_success "Intel Mac detected - app should work"
elif [ "$ARCH" = "arm64" ]; then
    print_success "Apple Silicon Mac detected - app should work via Rosetta"
else
    print_warning "Unknown architecture: $ARCH"
fi

# Check if Python is installed (should NOT be required)
if command -v python3 >/dev/null 2>&1; then
    PYTHON_VERSION=$(python3 --version 2>&1)
    print_info "Python found: $PYTHON_VERSION (not required for standalone app)"
else
    print_success "No Python installation found - perfect for testing standalone app!"
fi

# Check app structure
if [ -d "TimeTracker.app" ]; then
    print_success "TimeTracker.app found"
    
    if [ -f "TimeTracker.app/Contents/Info.plist" ]; then
        print_success "Info.plist exists"
    else
        print_error "Info.plist missing"
    fi
    
    if [ -x "TimeTracker.app/Contents/MacOS/TimeTrackerMac" ]; then
        print_success "Executable found and is executable"
    else
        print_error "Executable missing or not executable"
    fi
else
    print_error "TimeTracker.app not found in current directory"
fi

# Test launch (without actually showing UI)
print_info "Testing app launch..."
if ./TimeTracker.app/Contents/MacOS/TimeTrackerMac --help >/dev/null 2>&1; then
    print_success "App executable responds to commands"
else
    print_warning "App may need security permissions or have launch issues"
fi

echo ""
echo "🏁 Compatibility Test Complete"
echo "=============================="
print_info "If all tests passed, the app should work on this system!"
echo ""
EOF

    chmod +x "dist/test_compatibility.sh"
    print_success "Compatibility test script created"
}

# Enhanced DMG creation with installer script
create_enhanced_dmg() {
    print_info "Creating enhanced DMG with installer..."
    
    local dmg_name="${APP_NAME}-${VERSION}-Universal-macOS"
    local dmg_path="dist/${dmg_name}.dmg"
    local dmg_temp="dist/dmg_temp"
    
    # Remove existing DMG
    rm -f "$dmg_path"
    
    # Create temporary directory
    rm -rf "$dmg_temp"
    mkdir -p "$dmg_temp"
    
    # Copy app and support files
    cp -R "dist/${APP_NAME}.app" "$dmg_temp/"
    cp "dist/install_timetracker.sh" "$dmg_temp/"
    cp "dist/test_compatibility.sh" "$dmg_temp/"
    cp -R "dist/LaunchAgents" "$dmg_temp/" 2>/dev/null || true
    
    # Create README for DMG
    cat > "$dmg_temp/README.txt" << 'EOF'
TimeTracker - Standalone macOS Application
=========================================

📋 Installation Options:

🚀 AUTOMATIC (Recommended):
   • Run: ./install_timetracker.sh
   • Follow the prompts

📁 MANUAL:
   • Copy TimeTracker.app to Applications folder
   • Launch from Applications or Launchpad

🧪 TESTING:
   • Run: ./test_compatibility.sh
   • Verify system compatibility

🔒 SECURITY:
   • Grant Screen Recording permission when prompted
   • Grant Accessibility permission for window monitoring
   • If blocked by Gatekeeper, right-click → Open

💡 REQUIREMENTS:
   • macOS 10.15 (Catalina) or later
   • No Python or Node.js installation required!
   • Intel Mac or Apple Silicon (Rosetta compatible)

🆘 SUPPORT:
   Visit: https://github.com/your-repo/JIRAForge
EOF
    
    # Create Applications symlink
    ln -sf /Applications "$dmg_temp/Applications"
    
    # Create the DMG
    print_info "Building DMG image..."
    if hdiutil create -volname "${APP_NAME} Installer" -srcfolder "$dmg_temp" -ov -format UDZO "$dmg_path" >/dev/null 2>&1; then
        rm -rf "$dmg_temp"
        
        if [ -f "$dmg_path" ]; then
            local dmg_size=$(du -sh "$dmg_path" | cut -f1)
            print_success "Enhanced DMG created: ${dmg_name}.dmg (${dmg_size})"
        fi
    else
        print_error "DMG creation failed"
        rm -rf "$dmg_temp"
    fi
}

# Main build process
main() {
    print_header
    
    # Run the existing build system first
    print_info "Running base build system..."
    if [ -f "./build_macos_unified.sh" ]; then
        ./build_macos_unified.sh --mode complete --version "$VERSION" --verbose
    else
        print_error "build_macos_unified.sh not found!"
        exit 1
    fi
    
    # Enhance the build
    print_info "Enhancing build for cross-Mac compatibility..."
    
    create_enhanced_info_plist
    create_launch_agent
    create_installer_script
    create_compatibility_test
    create_enhanced_dmg
    
    print_success "Enhanced build complete!"
    
    echo ""
    echo "📦 Distribution Files Created:"
    echo "=============================="
    echo "🍎 TimeTracker.app - Standalone application"
    echo "💿 TimeTracker-${VERSION}-Universal-macOS.dmg - Complete installer"
    echo "📋 install_timetracker.sh - Automated installation"
    echo "🧪 test_compatibility.sh - System compatibility test"
    echo ""
    echo "🚀 Ready for Distribution!"
    echo "=========================="
    print_info "Users can download the DMG and run the installer script"
    print_info "No Python, Node.js, or manual setup required on target systems"
    print_info "App includes auto-launch capabilities and proper permissions"
    echo ""
}

# Run main function
main "$@"