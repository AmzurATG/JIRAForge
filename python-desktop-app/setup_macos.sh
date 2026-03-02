#!/bin/bash
# 
# macOS Setup Script for Time Tracker Desktop Application
# This script handles dependency conflicts and sets up a clean environment
#

set -e  # Exit on any error

echo "🍎 Setting up Time Tracker for macOS..."
echo "======================================"

# Check if we're on macOS
if [[ "$OSTYPE" != "darwin"* ]]; then
    echo "❌ Error: This script is for macOS only"
    exit 1
fi

# Check Python version
python_version=$(python3 -c 'import sys; print(".".join(map(str, sys.version_info[:2])))')
echo "🐍 Python version: $python_version"

# Minimum Python version check
if python3 -c 'import sys; exit(0 if sys.version_info >= (3, 8) else 1)'; then
    echo "✅ Python version is compatible"
else
    echo "❌ Error: Python 3.8 or higher is required"
    exit 1
fi

# Create and activate virtual environment to avoid conflicts
echo "📦 Creating clean virtual environment..."
if [ -d "venv" ]; then
    echo "   Removing existing virtual environment..."
    rm -rf venv
fi

python3 -m venv venv
echo "   Virtual environment created"

# Activate virtual environment
source venv/bin/activate
echo "✅ Virtual environment activated"

# Upgrade pip
echo "⬆️  Upgrading pip..."
pip install --upgrade pip

# First, remove any conflicting packages that might cause issues
echo "🧹 Cleaning up potential conflicts..."
pip uninstall -y supabase-auth supabase-functions supabase-storage supabase-realtime 2>/dev/null || true

# Install packages in specific order to avoid dependency conflicts
echo "📦 Installing core dependencies..."

# Step 1: Install basic Python packages
pip install --no-deps flask werkzeug jinja2 itsdangerous click blinker
pip install --no-deps flask-cors
pip install --no-deps pillow
pip install --no-deps requests urllib3 certifi charset-normalizer idna
pip install --no-deps python-dotenv
pip install --no-deps psutil
pip install --no-deps cryptography cffi pycparser
pip install --no-deps keyring importlib-metadata jaraco.classes more-itertools

# Step 2: Install macOS-specific packages
echo "🍎 Installing macOS frameworks..."
pip install pyobjc-core
pip install pyobjc-framework-Cocoa
pip install pyobjc-framework-Quartz
pip install pyobjc-framework-ApplicationServices

# Step 3: Install cross-platform packages
echo "🔔 Installing notification and system tray support..."
pip install plyer
pip install pystray six

# Step 4: Install pynput with its dependencies
pip install pynput

# Step 5: Install timezone support
pip install tzlocal

# Step 6: Install Supabase with compatible versions (let pip resolve dependencies)
echo "🗄️  Installing Supabase..."
pip install --upgrade supabase

echo ""
echo "✅ All dependencies installed successfully!"

# Test the installation
echo "🧪 Testing installation..."
python3 -c "
import flask
import PIL
import requests
import supabase
import psutil
import keyring
import pystray
import plyer
from Cocoa import NSScreen
from Quartz import CGWindowListCreateImage
from AppKit import NSWorkspace
print('✅ All imports successful!')
"

echo ""
echo "🎉 Setup completed successfully!"
echo ""
echo "📋 Next steps:"
echo "   1. Activate the virtual environment: source venv/bin/activate"
echo "   2. Run the application: python3 mac_desktop_app.py"
echo "   3. Or test compatibility: python3 test_macos_compatibility.py"
echo ""
echo "⚠️  Remember to activate the virtual environment each time:"
echo "   cd $(pwd)"
echo "   source venv/bin/activate"
echo "