# TimeTracker macOS App Bundle
## Complete Guide for Building and Distribution

### Overview
This directory contains all the necessary files to build a complete macOS .app bundle for TimeTracker that:
- Works identically to the local Python version
- Is compatible with macOS Big Sur 11.0+ and optimized for macOS Tahoe 26.3+
- Includes automatic update notifications (as shown in the screenshots)
- Runs automatically in the background when opened
- Requires no additional setup from users

### Files Created for macOS Distribution

#### Core Build Files
- **`mac_desktop_app.spec`** - PyInstaller configuration for macOS .app bundle
- **`Info.plist`** - macOS app bundle metadata and permissions
- **`build_mac.sh`** - Complete build script with dependency management
- **`mac_auto_updater.py`** - Auto-update system with AI Server integration
- **`macos_compatibility.py`** - macOS compatibility layer and system integration

#### Validation Scripts
- **`validate_mac_build.py`** - Comprehensive validation (may cause segfault with some macOS APIs)
- **`test_build_simple.py`** - Basic validation script (safe to run)

### Quick Start

1. **Validate Setup**
   ```bash
   cd python-desktop-app
   python3 test_build_simple.py
   ```

2. **Build the App**
   ```bash
   ./build_mac.sh
   ```

3. **Find Your App**
   The built app will be in `dist/TimeTracker.app`

### Detailed Build Process

#### Prerequisites
- **macOS**: Big Sur 11.0 or later (Tahoe 26.3+ recommended)
- **Python**: 3.8 or later (3.11+ recommended)
- **Xcode Command Line Tools**: `xcode-select --install`
- **Homebrew** (recommended): `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`

#### Optional Dependencies
- **Tesseract OCR**: `brew install tesseract` (improves OCR accuracy)
- **Virtual Environment**: Automatically created if not present

#### Build Features

The build script (`build_mac.sh`) automatically:
1. ✅ Checks macOS and Python version compatibility
2. ✅ Creates/activates virtual environment
3. ✅ Installs all Python dependencies
4. ✅ Creates missing macOS compatibility modules
5. ✅ Builds the .app bundle with PyInstaller
6. ✅ Configures proper permissions and metadata
7. ✅ Optionally creates DMG file for distribution

### App Bundle Features

#### Core Functionality (Same as Local Version)
- 🔐 **Atlassian OAuth Integration** - Secure login with embedded credentials
- 📸 **Automatic Screenshot Capture** - Background time tracking
- 🤖 **OCR Text Extraction** - PaddleOCR + Tesseract dual engine support
- 💾 **Offline Data Storage** - SQLite with Supabase sync
- 🔔 **Desktop Notifications** - Native macOS notifications
- ⚙️ **System Tray Integration** - Menu bar app with LSUIElement=true

#### macOS-Specific Enhancements
- 🍎 **Native macOS App Bundle** - Double-click to run, no Terminal needed
- 🔄 **Automatic Updates** - Built-in update notifications (as shown in screenshots)
- 🚀 **Launch Agent Integration** - Auto-start on login
- 🛡️ **Privacy Permissions** - Proper screen capture and system access requests
- 🎯 **Apple Silicon Support** - Universal binary for Intel and M1/M2/M3 Macs
- 📱 **macOS Tahoe Ready** - Compatible with latest macOS versions

#### Security & Permissions
- **Screen Recording**: Required for screenshot capture
- **System Administration**: Required for application monitoring  
- **Network Access**: Required for Atlassian OAuth and Supabase sync
- **Hardened Runtime**: Configured for Gatekeeper compatibility

### Distribution

#### For Internal Use
1. Build the app: `./build_mac.sh`
2. Copy `TimeTracker.app` to target Mac's `/Applications/` folder
3. User double-clicks app to run
4. User grants screen capture permission when prompted
5. User logs in with Atlassian credentials
6. App runs in background automatically

#### For App Store Distribution (Optional)
1. **Code Signing**: Sign with Apple Developer ID
   ```bash
   codesign --force --deep --sign "Developer ID Application: Your Name" TimeTracker.app
   ```

2. **Notarization**: Submit to Apple for Gatekeeper approval
   ```bash
   xcrun notarytool submit TimeTracker.dmg --keychain-profile "AC_PASSWORD"
   ```

3. **Stapling**: Attach notarization to app
   ```bash
   xcrun stapler staple TimeTracker.app
   ```

### Update System

#### How Updates Work (As Shown in Screenshots)
1. App periodically checks AI Server for updates: `https://forgesync.amzur.com/api/updates/check`
2. If newer version available, shows native macOS notification
3. User clicks notification to download and install update
4. App automatically restarts with new version

#### Update Configuration
- **Current Version**: 1.2.1 (defined in `APP_VERSION`)
- **Update Interval**: 24 hours (configurable)
- **Update Server**: AI Server handles update distribution
- **Supported Formats**: DMG, ZIP, or .app.tar.gz files
- **Security**: SHA256 checksum verification

### Troubleshooting

#### Build Issues

**"Python 3.8+ required"**
```bash
brew install python@3.11
```

**"PyInstaller not found"**
```bash
pip install pyinstaller
```

**"Tesseract not found" (Warning)**
```bash
brew install tesseract  # Optional but recommended
```

**"macOS frameworks not available"**
```bash
pip install pyobjc
```

#### Runtime Issues

**"App won't start" / Crashes immediately**
- Check Console.app for crash logs
- Verify screen capture permission granted
- Try running from Terminal: `open TimeTracker.app`

**"Permission denied" for screen capture**
1. System Preferences → Security & Privacy → Privacy
2. Screen Recording → Add TimeTracker.app
3. Restart the app

**"Update notifications not working"**
- Check network connectivity
- Verify AI Server reachable: `curl https://forgesync.amzur.com/api/updates/check`

#### Performance Issues

**"High CPU usage"**
- OCR processing is CPU-intensive by design
- Background priority automatically configured
- Reduce capture interval in settings if needed

**"Large app size"**
- Normal for bundled Python app with ML libraries
- PaddleOCR models are ~50MB
- Use `upx=False` in spec file (already configured)

### Architecture Details

#### App Bundle Structure
```
TimeTracker.app/
├── Contents/
│   ├── Info.plist           # App metadata and permissions
│   ├── MacOS/
│   │   └── TimeTracker      # Main executable
│   ├── Resources/           # Python runtime and dependencies
│   └── Frameworks/          # System frameworks
```

#### Key Components
- **Main App**: `mac_desktop_app.py` - Core application logic
- **OCR Engine**: Dual PaddleOCR + Tesseract with macOS optimizations
- **OAuth Handler**: Atlassian integration with secure token storage
- **Update Manager**: `mac_auto_updater.py` - Handles app updates
- **Compatibility Layer**: `macos_compatibility.py` - macOS system integration

#### Data Storage
- **App Data**: `~/Library/Application Support/TimeTracker/`
- **Launch Agent**: `~/Library/LaunchAgents/com.amzur.timetracker.plist`
- **Secure Tokens**: macOS Keychain (via `keyring` module)

### Support

#### Version Compatibility
- ✅ **macOS Big Sur 11.0+**: Full support
- ✅ **macOS Monterey 12.0+**: Full support  
- ✅ **macOS Ventura 13.0+**: Full support
- ✅ **macOS Sonoma 14.0+**: Full support
- ✅ **macOS Sequoia 15.0+**: Full support (current)
- ✅ **macOS Tahoe 26.3+**: Optimized support

#### Hardware Compatibility
- ✅ **Intel Macs**: x86_64 architecture
- ✅ **Apple Silicon**: arm64 architecture (M1/M2/M3)
- ✅ **Universal Binary**: Single app works on both architectures

### Development Notes

#### Modifications Made to Existing Code
- ✅ **No changes to core functionality** - All existing features preserved
- ✅ **Added missing modules** - Created `mac_auto_updater.py` and `macos_compatibility.py`
- ✅ **Enhanced error handling** - Graceful fallbacks for missing dependencies
- ✅ **Improved compatibility** - Better support for different macOS versions

#### Future Enhancements
- 📦 **Automatic DMG creation** - Drag-and-drop installer
- 🔐 **Enhanced code signing** - Developer ID distribution
- 📱 **Menu bar redesign** - Native macOS UI patterns
- 🔄 **Background app updates** - Silent updates without user intervention

---

**Built for Amzur Technologies**  
TimeTracker v1.2.1 - macOS Distribution Ready 🚀