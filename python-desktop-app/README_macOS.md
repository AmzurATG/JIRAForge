# Time Tracker - macOS Version

This is the macOS-adapted version of the Time Tracker desktop application that works with Atlassian Jira for automatic work time tracking.

## System Requirements

- **macOS**: 10.14 (Mojave) or later
- **Python**: 3.8 or higher
- **Xcode Command Line Tools**: Required for some native dependencies

## Quick Start

### 1. Install Python Dependencies

```bash
# Install Xcode Command Line Tools (if not already installed)
xcode-select --install

# Install Python dependencies
pip3 install -r requirements-macos.txt
```

### 2. Run in Development Mode

```bash
# Run directly from source
python3 mac_desktop_app.py
```

### 3. Build Standalone Application

```bash
# Build macOS app bundle
./build_macos.sh
```

This creates `dist/TimeTracker.app` that you can double-click to run.

## macOS Permissions

The app will request these permissions on first run:

### Screen Recording
- **Purpose**: Captures screenshots for work tracking
- **When prompted**: Allow in System Preferences → Security & Privacy → Privacy → Screen Recording

### Accessibility
- **Purpose**: Detects active windows and applications
- **When prompted**: Allow in System Preferences → Security & Privacy → Privacy → Accessibility

### Notifications
- **Purpose**: Shows reminders and status updates
- **When prompted**: Allow notifications for Time Tracker

## Installation

### Option 1: Copy to Applications
```bash
cp -R dist/TimeTracker.app /Applications/
```

### Option 2: Use the built-in installer
The app will self-install to `~/Library/Application Support/TimeTracker/` on first run.

## Auto-Start Setup

To start automatically on login:

1. Open the app and go to Settings
2. Enable "Start with macOS"
3. Or manually: The app creates a Launch Agent in `~/Library/LaunchAgents/`

## Key Differences from Windows Version

| Feature | Windows | macOS |
|---------|---------|--------|
| Window Detection | win32gui | Cocoa/Quartz |
| Screenshots | PIL + win32 | PIL + Quartz |
| Notifications | winotify | plyer |
| Auto-start | Registry | Launch Agents |
| Secure Storage | Windows Credential Manager | macOS Keychain |
| App Data | %LOCALAPPDATA% | ~/.local/share |

## Troubleshooting

### Permission Issues
```bash
# Check current permissions
tccutil reset ScreenCapture com.amzur.timetracker
tccutil reset Accessibility com.amzur.timetracker
```

### Build Issues
```bash
# If PyObjC installation fails
pip3 install --upgrade setuptools wheel
pip3 install pyobjc-core pyobjc-framework-Cocoa
```

### Window Detection Not Working
- Ensure Accessibility permissions are granted
- Check that System Preferences → Security & Privacy → Accessibility includes Time Tracker

### Screenshots Not Working
- Ensure Screen Recording permissions are granted
- Check that System Preferences → Security & Privacy → Screen Recording includes Time Tracker

## Development

### Project Structure
```
mac_desktop_app.py          # Main macOS-adapted application
requirements-macos.txt      # macOS-specific dependencies
build_macos.sh             # Build script for standalone app
README_macOS.md            # This file
```

### Key macOS Adaptations
- **Window Management**: Uses Cocoa NSWorkspace and Quartz instead of win32gui
- **Notifications**: Uses plyer (cross-platform) instead of winotify
- **Auto-start**: Uses Launch Agents instead of Windows Registry
- **Single Instance**: Uses file locking instead of Windows mutex
- **Paths**: Uses macOS-standard paths (~/.local/share, ~/Library)

## Configuration

Same as Windows version - edit the web interface at `http://localhost:51777` after starting the app.

## Support

For macOS-specific issues:
1. Check Console.app for any crash logs
2. Verify all required permissions are granted
3. Try running from terminal to see debug output: `python3 mac_desktop_app.py`

For general issues, see the main project documentation.