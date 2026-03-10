#!/bin/bash

APP_PATH="/Applications/TimeTracker.app"
LOCAL_PATH="$(dirname "$0")/dist/TimeTracker.app"

# Use local version if exists, otherwise use installed version
if [ -d "$LOCAL_PATH" ]; then
    APP_TO_LAUNCH="$LOCAL_PATH"
elif [ -d "$APP_PATH" ]; then
    APP_TO_LAUNCH="$APP_PATH"
else
    echo "❌ TimeTracker.app not found"
    exit 1
fi

echo "🚀 Launching TimeTracker from: $APP_TO_LAUNCH"

# Method 1: Try direct executable launch
if "$APP_TO_LAUNCH/Contents/MacOS/TimeTracker" 2>/dev/null &
then
    echo "✅ Launched via direct executable"
    exit 0
fi

# Method 2: Try open command
if open "$APP_TO_LAUNCH" 2>/dev/null; then
    echo "✅ Launched via open command"
    exit 0
fi

# Method 3: System bypass
echo "🔧 Trying security bypass..."
sudo spctl --add "$APP_TO_LAUNCH" 2>/dev/null
xattr -d com.apple.quarantine "$APP_TO_LAUNCH" 2>/dev/null
open "$APP_TO_LAUNCH"
