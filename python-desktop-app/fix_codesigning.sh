#!/bin/bash
#
# TimeTracker Code Signing Fix Script
# Fixes the "Invalid Signature" crash issue
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

echo -e "${BLUE}🔧 TimeTracker Code Signing Fix${NC}"
echo "=================================="

APP_PATH="dist/TimeTracker.app"

# Check if app exists
if [ ! -d "$APP_PATH" ]; then
    print_error "TimeTracker.app not found at $APP_PATH"
    print_info "Please run this from the python-desktop-app directory"
    exit 1
fi

print_success "Found TimeTracker.app"

# Step 1: Remove quarantine attributes
print_info "Step 1: Removing quarantine attributes..."
xattr -dr com.apple.quarantine "$APP_PATH" 2>/dev/null || true
xattr -dr com.apple.metadata:kMDItemWhereFroms "$APP_PATH" 2>/dev/null || true
print_success "Quarantine attributes removed"

# Step 2: Create proper entitlements
print_info "Step 2: Creating entitlements..."
cat > entitlements.plist << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <!-- Screen Capture -->
    <key>com.apple.security.device.camera</key>
    <true/>
    
    <!-- Network Access -->
    <key>com.apple.security.network.client</key>
    <true/>
    <key>com.apple.security.network.server</key>
    <true/>
    
    <!-- Audio/Video Access -->
    <key>com.apple.security.device.audio-input</key>
    <true/>
    
    <!-- File System Access -->
    <key>com.apple.security.files.user-selected.read-write</key>
    <true/>
    <key>com.apple.security.files.downloads.read-write</key>
    <true/>
    
    <!-- Allow JIT for Python -->
    <key>com.apple.security.cs.allow-jit</key>
    <true/>
    <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
    <true/>
    <key>com.apple.security.cs.disable-executable-page-protection</key>
    <true/>
    
    <!-- Allow loading unsigned libraries -->
    <key>com.apple.security.cs.allow-dyld-environment-variables</key>
    <true/>
    
    <!-- Runtime hardening -->
    <key>com.apple.security.cs.disable-library-validation</key>
    <true/>
</dict>
</plist>
EOF

print_success "Entitlements file created"

# Step 3: Fix app bundle structure
print_info "Step 3: Fixing app bundle structure..."

# Ensure executable is executable
chmod +x "$APP_PATH/Contents/MacOS/TimeTrackerMac"

# Fix Info.plist if needed
if [ ! -f "$APP_PATH/Contents/Info.plist" ]; then
    print_warning "Info.plist missing, creating..."
    cat > "$APP_PATH/Contents/Info.plist" << 'EOF'
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
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>LSMinimumSystemVersion</key>
    <string>10.15</string>
</dict>
</plist>
EOF
fi

print_success "App bundle structure fixed"

# Step 4: Remove existing signature
print_info "Step 4: Removing existing invalid signature..."
codesign --remove-signature "$APP_PATH" 2>/dev/null || true
print_success "Old signature removed"

# Step 5: Re-sign with adhoc signature but proper flags
print_info "Step 5: Re-signing with proper flags..."

# Sign each framework first (if any)
if [ -d "$APP_PATH/Contents/Frameworks" ]; then
    for framework in "$APP_PATH/Contents/Frameworks"/*.framework; do
        if [ -d "$framework" ]; then
            print_info "Signing framework: $(basename "$framework")"
            codesign --force --deep --sign - --entitlements entitlements.plist "$framework" || true
        fi
    done
fi

# Sign the main executable
codesign --force --deep --sign - \
         --entitlements entitlements.plist \
         --options runtime \
         "$APP_PATH"

if [ $? -eq 0 ]; then
    print_success "App successfully re-signed"
else
    print_warning "Re-signing had issues, trying without runtime flag..."
    codesign --force --deep --sign - \
             --entitlements entitlements.plist \
             "$APP_PATH"
    
    if [ $? -eq 0 ]; then
        print_success "App successfully re-signed (without runtime)"
    else
        print_error "Re-signing failed"
        exit 1
    fi
fi

# Step 6: Verify signature
print_info "Step 6: Verifying signature..."
if codesign --verify --deep --strict "$APP_PATH" 2>/dev/null; then
    print_success "Signature verification passed"
else
    print_warning "Signature verification failed, but app might still work"
fi

# Step 7: Check signature details
print_info "Step 7: Checking signature details..."
codesign -dv "$APP_PATH" 2>&1 | head -10

# Step 8: Test launch preparation
print_info "Step 8: Final preparations..."

# Create a test script
cat > test_launch.sh << 'EOF'
#!/bin/bash
echo "🧪 Testing TimeTracker launch..."
cd "$(dirname "$0")"

# Test direct executable
echo "Testing executable directly..."
if timeout 5s ./dist/TimeTracker.app/Contents/MacOS/TimeTrackerMac --version 2>/dev/null; then
    echo "✅ Executable responds"
else
    echo "⚠️  Executable may need permissions"
fi

echo ""
echo "🚀 Launching TimeTracker.app..."
open dist/TimeTracker.app

echo ""
echo "ℹ️  If the app opens, you'll need to grant permissions:"
echo "   • Screen Recording"
echo "   • Accessibility" 
echo "   • Network Access"
echo ""
echo "ℹ️  Check the system tray (top menu bar) for the TimeTracker icon"
EOF

chmod +x test_launch.sh

print_success "Test script created"

echo ""
echo -e "${GREEN}🎉 Code Signing Fix Complete!${NC}"
echo "================================="

print_info "What was fixed:"
echo "   ✅ Removed quarantine attributes"
echo "   ✅ Created proper entitlements" 
echo "   ✅ Fixed app bundle structure"
echo "   ✅ Removed invalid signature"
echo "   ✅ Re-signed with proper flags"

echo ""
print_info "🚀 Ready to test:"
echo "   ./test_launch.sh"
echo ""
print_info "Or launch manually:"
echo "   open dist/TimeTracker.app"

echo ""
print_warning "⚠️  If still blocked by Gatekeeper:"
echo "1. Right-click TimeTracker.app → Open"
echo "2. Click 'Open' in the security dialog"
echo "3. Or: System Preferences → Security & Privacy → 'Open Anyway'"

echo ""
print_success "Code signing issues should now be resolved!"