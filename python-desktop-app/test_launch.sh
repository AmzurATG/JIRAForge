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
