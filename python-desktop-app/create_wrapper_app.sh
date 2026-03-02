#!/bin/bash
#
# Create Simple Wrapper App
# Launches Python script directly without complex bundling
#

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

echo -e "${BLUE}📦 Creating Simple Wrapper App${NC}"
echo "=================================="

WRAPPER_APP="TimeTrackerWrapper.app"

# Create app bundle structure
print_info "Creating app bundle structure..."
mkdir -p "$WRAPPER_APP/Contents/MacOS"
mkdir -p "$WRAPPER_APP/Contents/Resources"

# Copy Python script and dependencies
print_info "Copying application files..."
cp mac_desktop_app.py "$WRAPPER_APP/Contents/Resources/"
cp -R venv "$WRAPPER_APP/Contents/Resources/" 2>/dev/null || print_info "No venv to copy"

# Create wrapper executable
print_info "Creating wrapper executable..."
cat > "$WRAPPER_APP/Contents/MacOS/TimeTrackerWrapper" << 'EOF'
#!/bin/bash

# Get the directory where this app is located
APP_DIR="$(dirname "$0")/../Resources"
cd "$APP_DIR"

# Set up Python environment
export PYTHONPATH="$APP_DIR:$PYTHONPATH"

# Use system Python or bundled Python
if [ -d "venv" ]; then
    source venv/bin/activate
fi

# Launch the Python script
python3 mac_desktop_app.py "$@"
EOF

chmod +x "$WRAPPER_APP/Contents/MacOS/TimeTrackerWrapper"

# Create Info.plist
print_info "Creating Info.plist..."
cat > "$WRAPPER_APP/Contents/Info.plist" << 'EOF'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleDisplayName</key>
    <string>TimeTracker</string>
    <key>CFBundleExecutable</key>
    <string>TimeTrackerWrapper</string>
    <key>CFBundleIdentifier</key>
    <string>com.jiraforge.timetracker.wrapper</string>
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
    <key>LSMinimumSystemVersion</key>
    <string>10.15</string>
    <key>NSHighResolutionCapable</key>
    <true/>
    <key>NSCameraUsageDescription</key>
    <string>TimeTracker needs screen recording access.</string>
    <key>NSAppTransportSecurity</key>
    <dict>
        <key>NSAllowsArbitraryLoads</key>
        <true/>
    </dict>
</dict>
</plist>
EOF

# Sign the wrapper
print_info "Signing wrapper app..."
codesign --force --deep --sign - "$WRAPPER_APP"

print_success "Wrapper app created: $WRAPPER_APP"

# Test the wrapper
print_info "Testing wrapper app..."
if open "$WRAPPER_APP"; then
    print_success "Wrapper app launches successfully!"
else
    print_info "Wrapper needs Python dependencies to be installed"
fi

echo ""
print_info "📋 Wrapper App Details:"
echo "   • Uses system Python (no complex bundling)"
echo "   • Directly launches your Python script"  
echo "   • Much smaller and more reliable"
echo "   • Requires Python to be installed on target system"

print_success "Wrapper app creation complete!"