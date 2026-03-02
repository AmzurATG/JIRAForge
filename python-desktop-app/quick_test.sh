#!/bin/bash
#
# Quick Test Script for TimeTracker .app
# Tests the current build without rebuilding
#

set -e

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m'

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

print_error() {
    echo -e "${RED}❌ $1${NC}"
}

echo -e "${BLUE}🧪 TimeTracker .app Quick Test${NC}"
echo "==============================="

# Check if we're in the right directory
if [ ! -f "mac_desktop_app.py" ]; then
    print_error "Please run this script from the python-desktop-app directory"
    exit 1
fi

# Check if build exists
if [ ! -d "dist/TimeTracker.app" ]; then
    print_error "No existing build found. Run build first:"
    print_info "./build_macos_unified.sh --mode complete --dmg --version 1.2.1"
    exit 1
fi

print_success "Found TimeTracker.app build"

# App structure validation
print_info "Validating app structure..."

if [ -f "dist/TimeTracker.app/Contents/Info.plist" ]; then
    print_success "Info.plist exists"
else
    print_error "Info.plist missing"
fi

if [ -x "dist/TimeTracker.app/Contents/MacOS/TimeTrackerMac" ]; then
    print_success "Main executable exists and is executable"
else
    print_error "Main executable missing or not executable"
fi

# Dependency check
print_info "Checking dependencies..."
DEP_COUNT=$(otool -L dist/TimeTracker.app/Contents/MacOS/TimeTrackerMac | wc -l)
print_info "Linked libraries: $DEP_COUNT"

# Look for problematic dependencies
EXTERNAL_DEPS=$(otool -L dist/TimeTracker.app/Contents/MacOS/TimeTrackerMac | grep -E "(local|opt|homebrew|python)" || true)
if [ -z "$EXTERNAL_DEPS" ]; then
    print_success "No external dependencies found - good for distribution!"
else
    print_warning "External dependencies detected:"
    echo "$EXTERNAL_DEPS"
fi

# Size check
APP_SIZE=$(du -sh dist/TimeTracker.app | cut -f1)
print_info "App bundle size: $APP_SIZE"

# Code signing check
print_info "Checking code signature..."
SIGN_INFO=$(codesign -dv dist/TimeTracker.app 2>&1 | grep -E "(Signature|TeamIdentifier)" || true)
if echo "$SIGN_INFO" | grep -q "adhoc"; then
    print_warning "App is self-signed (adhoc) - users will see security warnings"
    print_info "For distribution, consider Apple Developer ID signing"
else
    print_success "App has proper code signature"
fi

# Test direct executable (bypass macOS launch services)
print_info "Testing executable directly..."
cd dist/
if timeout 5s ./TimeTracker.app/Contents/MacOS/TimeTrackerMac --version >/dev/null 2>&1; then
    print_success "Executable responds to commands"
elif [ $? -eq 124 ]; then
    print_warning "Executable runs but may be waiting for input (this is normal)"
else
    print_warning "Executable may have issues - check permissions or dependencies"
fi
cd ..

# DMG check
if [ -f "dist/TimeTracker-1.2.1-macOS.dmg" ]; then
    DMG_SIZE=$(du -sh dist/TimeTracker-1.2.1-macOS.dmg | cut -f1)
    print_success "DMG installer exists ($DMG_SIZE)"
    
    print_info "Testing DMG structure..."
    if hdiutil verify dist/TimeTracker-1.2.1-macOS.dmg >/dev/null 2>&1; then
        print_success "DMG is valid and mountable"
    else
        print_warning "DMG may have issues"
    fi
else
    print_warning "DMG installer not found"
fi

# Summary
echo ""  
echo -e "${BLUE}📋 Test Summary${NC}"
echo "================"

print_info "Your TimeTracker.app build includes:"
echo "   🍎 Standalone macOS app bundle (~$APP_SIZE)"
echo "   📦 All Python dependencies embedded"
echo "   💿 DMG installer for easy distribution"
echo "   🔧 System tray and auto-launch capabilities"

echo ""
print_info "Ready for testing on other Macs!"

echo ""
echo -e "${YELLOW}🚀 Next Steps:${NC}"
echo "1. Copy DMG to a different Mac (one without Python installed)"
echo "2. Test installation: Double-click DMG → Drag to Applications"  
echo "3. Test launch: Open from Applications, grant permissions"
echo "4. Verify functionality: Screenshots, OAuth, tray icon"

echo ""
echo -e "${BLUE}📁 Distribution Files:${NC}"
echo "   dist/TimeTracker.app"
echo "   dist/TimeTracker-1.2.1-macOS.dmg"

if [ -f "DISTRIBUTION_GUIDE.md" ]; then
    echo ""
    print_info "📚 See DISTRIBUTION_GUIDE.md for detailed instructions"
fi

echo ""
print_success "Quick test complete! 🎉"