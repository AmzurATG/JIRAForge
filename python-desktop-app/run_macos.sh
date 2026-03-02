#!/bin/bash
#
# Run Time Tracker with Virtual Environment
# This script ensures the virtual environment is activated before running
#

# Change to the directory containing this script
cd "$(dirname "$0")"

# Check if virtual environment exists
if [ ! -d "venv" ]; then
    echo "❌ Virtual environment not found!"
    echo "Please run setup first: ./setup_macos.sh"
    exit 1
fi

# Activate virtual environment
echo "🔧 Activating virtual environment..."
source venv/bin/activate

# Check if mac_desktop_app.py exists
if [ ! -f "mac_desktop_app.py" ]; then
    echo "❌ mac_desktop_app.py not found!"
    exit 1
fi

echo "🚀 Starting Time Tracker for macOS..."
echo "   Web interface will be at: http://localhost:51777"
echo "   Press Ctrl+C to stop"
echo ""

# Run the application
python3 mac_desktop_app.py