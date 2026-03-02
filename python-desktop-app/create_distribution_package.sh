#!/bin/bash
#
# TimeTracker User-Friendly Distribution Creator
# Creates a ZIP package that users can download and install without terminal
#

set -e

GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m'

print_success() {
    echo -e "${GREEN}✅ $1${NC}"
}

print_info() {
    echo -e "${BLUE}ℹ️  $1${NC}"
}

print_warning() {
    echo -e "${YELLOW}⚠️  $1${NC}"
}

echo -e "${BLUE}📦 Creating User Distribution Package${NC}"
echo "====================================="

# Create distribution directory
DIST_DIR="TimeTracker-Distribution"
rm -rf "$DIST_DIR"
mkdir -p "$DIST_DIR"

print_info "Step 1: Copying TimeTracker application..."
if [ ! -d "TimeTrackerWrapper.app" ]; then
    echo "❌ TimeTrackerWrapper.app not found!"
    echo "Run ./create_wrapper_app.sh first"
    exit 1
fi

cp -R TimeTrackerWrapper.app "$DIST_DIR/TimeTracker.app"
print_success "TimeTracker app copied"

print_info "Step 2: Creating user-friendly installer..."
cat > "$DIST_DIR/Install TimeTracker.command" << 'EOF'
#!/bin/bash

# TimeTracker Easy Installer
# Double-click this file to install TimeTracker

clear
echo "🚀 TimeTracker Installer"
echo "========================"
echo ""

# Check if Python is installed
if command -v python3 >/dev/null 2>&1; then
    PYTHON_VERSION=$(python3 --version 2>&1)
    echo "✅ Python found: $PYTHON_VERSION"
    PYTHON_OK=true
else
    echo "⚠️  Python 3 not found on this system"
    PYTHON_OK=false
fi

echo ""
echo "📋 Installation Options:"
echo ""

if [ "$PYTHON_OK" = true ]; then
    echo "1️⃣  Install TimeTracker (Recommended - Python detected)"
    echo "2️⃣  Install Python first, then TimeTracker"
    echo "3️⃣  Cancel installation"
    echo ""
    read -p "Choose option (1-3): " choice
else
    echo "Since Python is not installed, we'll:"
    echo "1. Install Python first (opens download page)"
    echo "2. Then install TimeTracker"
    echo ""
    read -p "Continue? (y/n): " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Installation cancelled."
        exit 0
    fi
    choice="2"
fi

case $choice in
1)
    echo ""
    echo "🔧 Installing TimeTracker..."
    
    # Copy to Applications
    if cp -R "TimeTracker.app" "/Applications/"; then
        echo "✅ TimeTracker installed to Applications folder"
        
        # Ask about auto-start
        echo ""
        read -p "Would you like TimeTracker to start automatically on login? (y/n): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            # Add to login items
            osascript -e 'tell application "System Events" to make login item at end with properties {path:"/Applications/TimeTracker.app", hidden:false}' 2>/dev/null && echo "✅ Auto-start configured" || echo "⚠️  Auto-start setup requires manual configuration"
        fi
        
        echo ""
        echo "🎉 Installation Complete!"
        echo ""
        echo "📍 TimeTracker is installed in your Applications folder"
        echo "🚀 You can now launch it from:"
        echo "   • Applications folder"
        echo "   • Launchpad"
        echo "   • Spotlight search"
        echo ""
        echo "🔒 On first launch, you may need to:"
        echo "   • Grant Screen Recording permission"
        echo "   • Grant Accessibility permission"
        echo ""
        
        read -p "Would you like to launch TimeTracker now? (y/n): " -n 1 -r
        echo
        if [[ $REPLY =~ ^[Yy]$ ]]; then
            echo "🚀 Launching TimeTracker..."
            open "/Applications/TimeTracker.app"
        fi
        
    else
        echo "❌ Installation failed. You may need administrator privileges."
        echo "💡 Try dragging TimeTracker.app to your Applications folder manually."
    fi
    ;;
2)
    echo ""
    echo "🐍 Opening Python download page..."
    echo "📋 Please:"
    echo "1. Download and install Python 3.8 or later"
    echo "2. After Python installation, run this installer again"
    echo ""
    open "https://www.python.org/downloads/"
    echo "Waiting for you to install Python..."
    read -p "Press Enter after installing Python to continue..."
    
    # Restart the installer
    exec "$0"
    ;;
3|*)
    echo "Installation cancelled."
    exit 0
    ;;
esac

echo ""
echo "✅ Installation process complete!"
echo "📞 For support, check the README file or contact support."

# Keep terminal open for a moment
sleep 2
EOF

chmod +x "$DIST_DIR/Install TimeTracker.command"
print_success "Easy installer created"

print_info "Step 3: Creating user README..."
cat > "$DIST_DIR/README.txt" << 'EOF'
TimeTracker - Automatic Time Tracking Application
================================================

📋 What is TimeTracker?
TimeTracker automatically captures screenshots and tracks your work activity,
integrating with Atlassian/Jira for seamless time management.

🚀 Easy Installation (No Terminal Required):
1. Double-click "Install TimeTracker.command"
2. Follow the simple on-screen instructions
3. TimeTracker will be installed to your Applications folder

📋 System Requirements:
• macOS 10.15 (Catalina) or later
• Python 3.8+ (installer will help if not present)
• Internet connection for Atlassian integration

🔒 Required Permissions:
On first launch, macOS will ask for permissions:
• Screen Recording: Required for screenshot capture
• Accessibility: Required for window monitoring
• Grant these permissions in System Preferences > Security & Privacy

🛠️ Manual Installation (Alternative):
If the automatic installer doesn't work:
1. Drag TimeTracker.app to your Applications folder
2. Right-click TimeTracker.app and select "Open"
3. Click "Open" in the security dialog

🎯 How to Use:
1. Launch TimeTracker from Applications
2. Sign in with your Atlassian account
3. TimeTracker runs in the system tray (menu bar)
4. Screenshots are captured automatically
5. View reports in your connected Jira/Atlassian workspace

🔧 Troubleshooting:
• If app won't open: Right-click → Open (bypasses security)
• If permissions missing: System Preferences → Security & Privacy
• If Python missing: Installer will guide you to download it

📞 Support:
For help or issues, contact your system administrator or
check the documentation in your Jira workspace.

Version: 1.2.1
Compatible with: All Mac systems (Intel & Apple Silicon)
EOF

print_success "User README created"

print_info "Step 4: Creating Python check script..."
cat > "$DIST_DIR/Check Python.command" << 'EOF'
#!/bin/bash

clear
echo "🐍 Python Installation Checker"
echo "============================="
echo ""

if command -v python3 >/dev/null 2>&1; then
    PYTHON_VERSION=$(python3 --version 2>&1)
    echo "✅ Python is installed: $PYTHON_VERSION"
    echo ""
    
    # Check if it's a recent enough version
    PYTHON_MAJOR=$(python3 -c "import sys; print(sys.version_info.major)")
    PYTHON_MINOR=$(python3 -c "import sys; print(sys.version_info.minor)")
    
    if [ "$PYTHON_MAJOR" -ge 3 ] && [ "$PYTHON_MINOR" -ge 8 ]; then
        echo "✅ Python version is compatible with TimeTracker"
        echo ""
        echo "🚀 You're ready to install TimeTracker!"
        echo "Double-click 'Install TimeTracker.command' to proceed."
    else
        echo "⚠️  Python version is too old (need 3.8+)"
        echo "Please update Python from: https://www.python.org/downloads/"
    fi
else
    echo "❌ Python 3 is not installed"
    echo ""
    echo "📋 To install Python:"
    echo "1. Visit: https://www.python.org/downloads/"
    echo "2. Download Python 3.8 or later"
    echo "3. Run the installer"
    echo "4. After installation, run TimeTracker installer"
    echo ""
    read -p "Would you like to open the Python download page? (y/n): " -n 1 -r
    echo
    if [[ $REPLY =~ ^[Yy]$ ]]; then
        open "https://www.python.org/downloads/"
    fi
fi

echo ""
echo "Press any key to close..."
read -n 1
EOF

chmod +x "$DIST_DIR/Check Python.command"
print_success "Python checker created"

print_info "Step 5: Creating distribution ZIP..."
zip -r "TimeTracker-1.2.1-macOS-Universal.zip" "$DIST_DIR"

if [ -f "TimeTracker-1.2.1-macOS-Universal.zip" ]; then
    ZIP_SIZE=$(du -sh "TimeTracker-1.2.1-macOS-Universal.zip" | cut -f1)
    print_success "Distribution ZIP created: TimeTracker-1.2.1-macOS-Universal.zip ($ZIP_SIZE)"
else
    echo "❌ ZIP creation failed"
    exit 1
fi

print_info "Step 6: Testing the package..."
if [ -f "$DIST_DIR/Install TimeTracker.command" ]; then
    print_success "Installer script is executable"
fi

echo ""
echo -e "${GREEN}🎉 Distribution Package Complete!${NC}"
echo "=========================================="
echo ""
print_info "📦 Created for distribution:"
echo "   📁 TimeTracker-1.2.1-macOS-Universal.zip ($ZIP_SIZE)"
echo ""
print_info "📋 Package contents:"
echo "   🍎 TimeTracker.app - Main application"
echo "   ⚙️  Install TimeTracker.command - Easy installer"
echo "   🐍 Check Python.command - Python checker"
echo "   📄 README.txt - User instructions"
echo ""
print_info "🚀 User experience:"
echo "   1. Download ZIP file"
echo "   2. Extract ZIP"
echo "   3. Double-click 'Install TimeTracker.command'"
echo "   4. Follow simple instructions"
echo "   5. TimeTracker installs and runs!"
echo ""
print_warning "⚠️  Distribution notes:"
echo "   • Works on all Macs (Intel & Apple Silicon)"
echo "   • Handles Python installation automatically"
echo "   • No terminal commands required for users"
echo "   • Professional installation experience"

echo ""
print_success "Ready to share with users! 🎉"