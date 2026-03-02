#!/bin/bash
#
# Alternative App Packaging with py2app
# More compatible with macOS than PyInstaller
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

echo -e "${BLUE}🔄 Alternative Package Creation with py2app${NC}"
echo "=================================================="

print_info "Installing py2app (macOS native packaging)..."
pip install py2app

print_info "Creating setup.py for py2app..."
cat > setup.py << 'EOF'
from setuptools import setup

APP = ['mac_desktop_app.py']
DATA_FILES = []
OPTIONS = {
    'argv_emulation': True,
    'includes': [
        'PIL', 'PIL.Image', 'PIL.ImageGrab', 'PIL.ImageDraw',
        'flask', 'flask_cors', 'requests', 'supabase', 'pystray',
        'keyring', 'psutil', 'cryptography', 'dotenv', 'sqlite3',
        'AppKit', 'Quartz', 'Foundation', 'Cocoa'
    ],
    'plist': {
        'CFBundleName': 'TimeTracker',
        'CFBundleDisplayName': 'TimeTracker',
        'CFBundleIdentifier': 'com.jiraforge.timetracker',
        'CFBundleVersion': '1.2.1',
        'CFBundleShortVersionString': '1.2.1',
        'NSHighResolutionCapable': True,
        'LSMinimumSystemVersion': '10.15',
        'NSCameraUsageDescription': 'TimeTracker needs screen recording access.',
    }
}

setup(
    app=APP,
    data_files=DATA_FILES,
    options={'py2app': OPTIONS},
    setup_requires=['py2app'],
)
EOF

print_info "Building with py2app..."
python setup.py py2app

if [ -d "dist/TimeTracker.app" ]; then
    print_success "py2app build completed!"
    print_info "Testing py2app version..."
    
    # Test the py2app version
    if open dist/TimeTracker.app; then
        print_success "py2app version launches successfully!"
    else
        print_warning "py2app version also has issues"
    fi
else
    print_warning "py2app build failed"
fi

print_success "Alternative packaging attempt complete"