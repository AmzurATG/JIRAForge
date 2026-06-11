#!/bin/bash
# Test script for ScreenCast fix - verifies flash-free, permission-persistent screenshot capture

echo "========================================================================"
echo "  ScreenCast Fix Test - Run this AFTER granting permission once"
echo "========================================================================"
echo ""

# 1. Kill any running TimeTracker instances
echo "[1] Stopping any running TimeTracker instances..."
pkill -f "TimeTracker" 2>/dev/null || true
sleep 2

# 2. Clear any old restore token to test fresh
TOKEN_FILE="$HOME/.config/timetracker/screencast_restore_token.json"
if [ -f "$TOKEN_FILE" ]; then
    echo "[2] Found existing restore token (from previous run):"
    cat "$TOKEN_FILE" | head -3
    echo ""
    read -p "    Delete it to test fresh permission flow? (y/n): " DELETE_TOKEN
    if [ "$DELETE_TOKEN" = "y" ]; then
        rm -f "$TOKEN_FILE"
        echo "    ✓ Deleted - will ask for permission once"
    else
        echo "    ✓ Keeping - should reuse existing permission"
    fi
else
    echo "[2] No existing restore token - will ask for permission on first capture"
fi
echo ""

# 3. Launch the app
echo "[3] Launching TimeTracker with verbose logging..."
echo "    Watch for these log messages:"
echo "      - 'ScreenCast Portal (NO FLASH, NO SOUND)'"
echo "      - 'Received restore token for persistent session'"
echo "      - 'Successfully reused session - no permission dialog needed'"
echo ""
echo "    The app will start capturing screenshots every 5 minutes."
echo "    You should see the permission dialog ONLY ONCE (on first capture)."
echo ""

APPIMAGE="/home/iswaryak/ATG/new-main-linux/JIRAForge/python-desktop-app/dist/TimeTracker-v1.0.0-x86_64.AppImage"

if [ ! -f "$APPIMAGE" ]; then
    echo "ERROR: AppImage not found at $APPIMAGE"
    exit 1
fi

# Launch and tail logs
echo "Starting app... (logs will appear below)"
echo "========================================================================"
"$APPIMAGE" &
APP_PID=$!
echo "App started (PID: $APP_PID)"
echo ""

# Wait a bit for app to initialize
sleep 3

# Find log file
LOG_DIR="$HOME/TimeTracker/logs"
if [ -d "$LOG_DIR" ]; then
    LOG_FILE=$(ls -t "$LOG_DIR"/*.log 2>/dev/null | head -1)
    if [ -n "$LOG_FILE" ]; then
        echo "Tailing log file: $LOG_FILE"
        echo "Press Ctrl+C to stop watching logs (app will keep running)"
        echo "========================================================================"
        tail -f "$LOG_FILE" | grep --line-buffered -i "screencast\|portal\|permission\|restore\|flash"
    else
        echo "No log file found yet in $LOG_DIR"
        echo "Logs may appear in: $LOG_DIR"
    fi
else
    echo "Log directory not found: $LOG_DIR"
    echo "App may be logging elsewhere or still initializing..."
fi

echo ""
echo "========================================================================"
echo "VERIFICATION CHECKLIST:"
echo "========================================================================"
echo "  [ ] Permission dialog appeared ONCE on first screenshot"
echo "  [ ] NO flash or camera sound during screenshot"
echo "  [ ] Restore token created: $TOKEN_FILE"
echo "  [ ] Subsequent screenshots (wait 5+ min) have NO dialog"
echo "  [ ] App restart: permission still remembered (no new dialog)"
echo ""
echo "To check restore token: cat $TOKEN_FILE"
echo "To stop app: pkill -f TimeTracker"
echo "========================================================================"
