# Linux Auto-Update Installation & Implementation Plan

## Executive Summary

This document provides a comprehensive analysis and implementation plan for automatic updates on Linux systems for the JIRAForge Desktop Time Tracker. Unlike Windows, Linux has multiple package management systems and update mechanisms, requiring a carefully designed approach.

**Key Objectives:**
- ✅ Seamless automatic updates for Linux users
- ✅ Support multiple installation formats (.deb, AppImage, standalone)
- ✅ Maintain security and integrity (GPG signatures, checksums)
- ✅ Graceful fallback when privileged operations fail
- ✅ Consistent experience across distributions

---

## Table of Contents

1. [Linux Update Ecosystem Analysis](#1-linux-update-ecosystem-analysis)
2. [Recommended Approach](#2-recommended-approach)
3. [Implementation Options](#3-implementation-options)
4. [Detailed Implementation Plan](#4-detailed-implementation-plan)
5. [Security Considerations](#5-security-considerations)
6. [Testing Strategy](#6-testing-strategy)
7. [User Experience](#7-user-experience)
8. [Comparison Matrix](#8-comparison-matrix)

---

## 1. Linux Update Ecosystem Analysis

### 1.1 Update Mechanisms Overview

| Method | Install Type | Auto-Update | User Privileges | Update Speed | Complexity |
|--------|--------------|-------------|-----------------|--------------|------------|
| **apt/dpkg** (.deb) | System package | Via system | Requires sudo | Fast | Low |
| **AppImage** | Portable | Self-update | User-level | Medium | Medium |
| **Snap** | Sandboxed | Automatic | User-level | Fast | Low |
| **Flatpak** | Sandboxed | Via Flatpak | User-level | Fast | Low |
| **Standalone Binary** | User-installed | Self-update | User-level | Fast | Medium |

### 1.2 Challenges on Linux

**1. Multiple Package Formats**
- Users may install via different methods (.deb, AppImage, build from source)
- Each requires different update mechanisms
- Detection of installation method required

**2. Permissions**
- System packages (*.deb*) require `sudo` for updates
- User-level installations can update without privileges
- AppData directory permissions vary

**3. Display Servers**
- X11 and Wayland have different notification systems
- Some distributions block notifications from non-system apps

**4. Desktop Environments**
- GNOME, KDE, XFCE have different update workflows
- Integration with system updater varies

**5. Distribution Differences**
- Debian/Ubuntu use apt/dpkg
- Fedora/RHEL use dnf/rpm
- Arch uses pacman
- Different security policies and certificate handling

---

##2. Recommended Approach

### 2.1 Hybrid Update Strategy

**We recommend implementing THREE update strategies based on installation method:**

```
Installation Method Detection
      ↓
Is it a .deb package? → Use system update notification
                        (let apt handle it)
      ↓
Is it an AppImage? → Use AppImageUpdate
      ↓
Is it standalone binary? → Use custom self-updater
                           (similar to Windows)
```

**Why this approach?**
- ✅ Respects Linux conventions (system packages use system tools)
- ✅ Provides automatic updates for portable installations
- ✅ No sudo required for user-level installations
- ✅ Works across all distributions

### 2.2 Recommended Primary Method: AppImage with AppImageUpdate

**AppImage is recommended as the primary Linux distribution format because:**

1. **Universal Compatibility**
   - Works on all distributions without modification
   - No system dependencies needed
   - Portable - can run from any location

2. **Built-in Update Support**
   - AppImageUpdate protocol is standardized
   - Delta updates (only download changed parts)
   - No sudo required

3. **User-Friendly**
   - Single file - easy to download and run
   - No installation hassles
   - Works on USB drives

4. **Security**
   - GPG signature verification
   - Checksum validation
   - Rollback support

**Format comparison:**

| Criterion | .deb | AppImage | Snap | Standalone |
|-----------|------|----------|------|------------|
| Universal compatibility | ❌ | ✅ | ✅ | ✅ |
| No sudo needed | ❌ | ✅ | ✅ | ✅ |
| Auto-update | ❌* | ✅ | ✅ | ⚠️ |
| Delta updates | ❌ | ✅ | ✅ | ❌ |
| Offline installation | ✅ | ✅ | ❌ | ✅ |
| System integration | ✅ | ⚠️ | ✅ | ⚠️ |
| File size | Small | Medium | Medium | Medium |

* .deb updates via apt (system-wide)

---

## 3. Implementation Options

### Option A: AppImage with AppImageUpdate Protocol ⭐ **RECOMMENDED**

**How it works:**
1. Embed update information in AppImage metadata
2. Periodic check for updates via AppImageUpdate protocol
3. Download delta update (zsync)
4. Apply update and restart application

**Advantages:**
- ✅ Standardized protocol (AppImageUpdate)
- ✅ Delta updates (efficient bandwidth usage)
- ✅ No sudo required
- ✅ Works on all distributions
- ✅ Rollback support

**Disadvantages:**
- ⚠️ Requires AppImageUpdate libraries
- ⚠️ Slightly larger download (~10-20MB more than .deb)

**Implementation Complexity:** ⭐⭐⭐ (Medium)

---

### Option B: Self-Contained Update Script (Like Windows) ✅ **FALLBACK**

**How it works:**
1. Check AI server for updates (same API as Windows)
2. Download new version to temp directory
3. Verify checksum
4. Replace current executable
5. Restart application

**Advantages:**
- ✅ Full control over update process
- ✅ Works with any installation method
- ✅ No external dependencies
- ✅ Consistent with Windows implementation

**Disadvantages:**
- ❌ No delta updates (full download)
- ⚠️ File may be open/locked by system
- ⚠️ Requires careful replacement logic

**Implementation Complexity:** ⭐⭐ (Low-Medium)

---

### Option C: .deb Package with APT Repository 📦 **ENTERPRISE**

**How it works:**
1. Set up APT repository on AI server
2. Users add repository to their sources
3. System handles updates via `apt-get upgrade`
4. Application shows notification: "Update available via system updater"

**Advantages:**
- ✅ Native Linux experience
- ✅ Trusted by IT departments
- ✅ Integrated with system updates
- ✅ GPG signed and verified

**Disadvantages:**
- ❌ Requires repository hosting and maintenance
- ❌ Debian/Ubuntu only (need separate RPM repo for Fedora)
- ❌ Users must manually add repository
- ❌ No silent updates (requires sudo password)

**Implementation Complexity:** ⭐⭐⭐⭐ (High)

---

### Option D: Snap Store ☁️ **FUTURE**

**How it works:**
1. Publish to Snap Store
2. Automatic updates handled by snapd
3. No application code needed

**Advantages:**
- ✅ Fully automatic updates
- ✅ No code required
- ✅ Sandboxed (security)
- ✅ Works on many distributions

**Disadvantages:**
- ❌ Requires Snap Store approval
- ❌ Sandbox restrictions (may limit window access)
- ⚠️ Not all users have snapd installed
- ⚠️ Slower startup (sandboxing overhead)

**Implementation Complexity:** ⭐ (Very Low) - but requires Store approval

---

## 4. Detailed Implementation Plan

### 4.1 Phase 1: AppImage Auto-Update (Primary) ⭐

This is the **recommended primary implementation** for Linux.

#### Step 1: Prepare AppImage with Update Info

**Add update information to AppImage:**

Create `AppImageBuilder.yml`:

```yaml
version: 1

AppDir:
  path: ./TimeTracker.AppDir
  
  app_info:
    id: com.jiraforge.timetracker
    name: Time Tracker
    icon: timetracker
    version: 1.4.6
    exec: usr/bin/TimeTracker
    
  files:
    include:
      - usr/bin/TimeTracker
      - usr/share/applications/timetracker.desktop
      - usr/share/icons/hicolor/256x256/apps/timetracker.png
    
  runtime:
    env:
      LD_LIBRARY_PATH: ${APPDIR}/usr/lib:${LD_LIBRARY_PATH}
    
  test:
    fedora-30:
      image: appimagecrafters/tests-env:fedora-30
      command: ./AppRun
    debian-stable:
      image: appimagecrafters/tests-env:debian-stable
      command: ./AppRun
    ubuntu-xenial:
      image: appimagecrafters/tests-env:ubuntu-xenial
      command: ./AppRun

AppImage:
  update-information: gh-releases-zsync|AmzurATG|JIRAForge|latest|TimeTracker-*x86_64.AppImage.zsync
  sign-key: None
  arch: x86_64
```

**Update information formats:**

```bash
# Option 1: GitHub Releases (if using GitHub)
gh-releases-zsync|AmzurATG|JIRAForge|latest|TimeTracker-*-x86_64.AppImage.zsync

# Option 2: Custom server (recommended)
zsync|https://forgesync.amzur.com/downloads/linux/TimeTracker-latest-x86_64.AppImage.zsync

# Option 3: Direct download (no zsync)
gh-releases-direct|AmzurATG|JIRAForge|latest|TimeTracker-*-x86_64.AppImage
```

#### Step 2: Build AppImage with Update Info

**Build script (`build_appimage.sh`):**

```bash
#!/bin/bash
# Build AppImage with embedded update information

set -e

APP_VERSION="1.4.6"
APP_NAME="TimeTracker"
ARCH="x86_64"

echo "Building ${APP_NAME} v${APP_VERSION} AppImage..."

# Step 1: Build executable with PyInstaller
echo "[1/5] Building executable..."
./build.sh

# Step 2: Create AppDir structure
echo "[2/5] Creating AppDir structure..."
rm -rf ${APP_NAME}.AppDir
mkdir -p ${APP_NAME}.AppDir/usr/bin
mkdir -p ${APP_NAME}.AppDir/usr/share/applications
mkdir -p ${APP_NAME}.AppDir/usr/share/icons/hicolor/256x256/apps
mkdir -p ${APP_NAME}.AppDir/usr/lib

# Copy executable
cp dist/${APP_NAME} ${APP_NAME}.AppDir/usr/bin/

# Copy libraries (if needed)
# ldd dist/${APP_NAME} | grep "=> /" | awk '{print $3}' | xargs -I '{}' cp -v '{}' ${APP_NAME}.AppDir/usr/lib/

# Step 3: Create desktop entry
echo "[3/5] Creating desktop entry..."
cat > ${APP_NAME}.AppDir/${APP_NAME}.desktop << EOF
[Desktop Entry]
Type=Application
Name=Time Tracker
Comment=Automatic time tracking for JIRA
Exec=TimeTracker
Icon=timetracker
Terminal=false
Categories=Utility;Office;Development;
EOF

# Copy desktop file
cp ${APP_NAME}.AppDir/${APP_NAME}.desktop ${APP_NAME}.AppDir/usr/share/applications/

# Copy icon
cp assets/icon.png ${APP_NAME}.AppDir/timetracker.png
cp assets/icon.png ${APP_NAME}.AppDir/usr/share/icons/hicolor/256x256/apps/timetracker.png
cp assets/icon.png ${APP_NAME}.AppDir/.DirIcon

# Step 4: Create AppRun script
echo "[4/5] Creating AppRun script..."
cat > ${APP_NAME}.AppDir/AppRun << 'APPRUN_EOF'
#!/bin/bash
SELF=$(readlink -f "$0")
HERE=${SELF%/*}

# Set up environment
export PATH="${HERE}/usr/bin:${PATH}"
export LD_LIBRARY_PATH="${HERE}/usr/lib:${LD_LIBRARY_PATH}"
export XDG_DATA_DIRS="${HERE}/usr/share:${XDG_DATA_DIRS}"

# Run the application
exec "${HERE}/usr/bin/TimeTracker" "$@"
APPRUN_EOF

chmod +x ${APP_NAME}.AppDir/AppRun

# Step 5: Build AppImage with appimagetool
echo "[5/5] Building AppImage..."

# Download appimagetool if not present
if [ ! -f "appimagetool-x86_64.AppImage" ]; then
    echo "Downloading appimagetool..."
    wget -q https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage
    chmod +x appimagetool-x86_64.AppImage
fi

# Build AppImage with update information
APPIMAGE_NAME="${APP_NAME}-${APP_VERSION}-${ARCH}.AppImage"

./appimagetool-x86_64.AppImage \
    --updateinformation "zsync|https://forgesync.amzur.com/downloads/linux/${APP_NAME}-latest-${ARCH}.AppImage.zsync" \
    ${APP_NAME}.AppDir \
    ${APPIMAGE_NAME}

# Generate zsync file for delta updates
if command -v zsyncmake &> /dev/null; then
    echo "Generating zsync metadata..."
    zsyncmake -u "https://forgesync.amzur.com/downloads/linux/${APPIMAGE_NAME}" \
              -o "${APPIMAGE_NAME}.zsync" \
              ${APPIMAGE_NAME}
else
    echo "WARNING: zsyncmake not found - delta updates will not work"
    echo "Install with: sudo apt-get install zsync"
fi

# Calculate checksum
echo "Calculating SHA256 checksum..."
sha256sum ${APPIMAGE_NAME} > ${APPIMAGE_NAME}.sha256

echo ""
echo "=========================================="
echo "  AppImage Build Complete!"
echo "=========================================="
echo ""
echo "  File: ${APPIMAGE_NAME}"
echo "  Size: $(du -h ${APPIMAGE_NAME} | cut -f1)"
echo ""
echo "  Checksums:"
cat ${APPIMAGE_NAME}.sha256
echo ""
echo "Upload to server:"
echo "  - ${APPIMAGE_NAME}"
echo "  - ${APPIMAGE_NAME}.zsync (for delta updates)"
echo "  - ${APPIMAGE_NAME}.sha256 (for verification)"
echo ""
```

**Make it executable:**
```bash
chmod +x build_appimage.sh
```

#### Step 3: Implement Update Manager for AppImage

**Create `appimage_updater.py`:**

```python
"""
AppImage Update Manager

Handles automatic updates for AppImage format using AppImageUpdate protocol.
Supports delta updates via zsync for efficient bandwidth usage.
"""

import os
import sys
import logging
import subprocess
import hashlib
import tempfile
import shutil
from pathlib import Path
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)


class AppImageUpdater:
    """
    Manages AppImage updates using the AppImageUpdate protocol.
    
    Features:
    - Delta updates via zsync (only download changes)
    - Integrity verification (SHA256)
    - Atomic updates (old version kept as backup)
    - Rollback on failure
    """
    
    def __init__(self, ai_server_url: str = None):
        """
        Initialize AppImage updater.
        
        Args:
            ai_server_url: Base URL of AI server (for version checking)
        """
        self.ai_server_url = ai_server_url or os.getenv('AI_SERVER_URL')
        self.current_appimage = self._get_current_appimage_path()
        
    def _get_current_appimage_path(self) -> Optional[str]:
        """
        Get the path to the currently running AppImage.
        
        Returns:
            Path to AppImage file, or None if not running as AppImage
        """
        # When running as AppImage, APPIMAGE env var is set
        appimage_path = os.environ.get('APPIMAGE')
        
        if appimage_path and os.path.exists(appimage_path):
            return appimage_path
        
        # Not running as AppImage
        return None
    
    def is_appimage(self) -> bool:
        """Check if currently running as AppImage"""
        return self.current_appimage is not None
    
    def can_update(self) -> bool:
        """
        Check if updates are possible.
        
        Returns:
            True if running as AppImage and update tools are available
        """
        if not self.is_appimage():
            logger.debug("Not running as AppImage - updates not applicable")
            return False
        
        # Check if AppImageUpdate is available
        if not shutil.which('appimageupdatetool'):
            # Try to use embedded updater if available
            embedded_updater = os.path.join(
                os.path.dirname(self.current_appimage),
                'appimageupdatetool'
            )
            if not os.path.exists(embedded_updater):
                logger.warning(
                    "AppImageUpdate tool not found. "
                    "Install with: sudo apt-get install appimageupdatetool"
                )
                return False
        
        return True
    
    def check_for_update(self) -> Optional[Dict[str, Any]]:
        """
        Check if an update is available.
        
        Uses the AI server API to check version, then verifies
        update is available via AppImageUpdate.
        
        Returns:
            dict: Update info if available, None otherwise
        """
        if not self.can_update():
            return None
        
        # Check version via AI server API
        try:
            import requests
            
            version_url = (
                f"{self.ai_server_url}/api/app-version/check"
                f"?platform=linux&current={self._get_current_version()}"
            )
            
            response = requests.get(version_url, timeout=10)
            
            if response.status_code != 200:
                logger.warning(f"Version check failed: HTTP {response.status_code}")
                return None
            
            data = response.json()
            
            if not data.get('success'):
                return None
            
            result = data.get('data', {})
            
            if not result.get('updateAvailable'):
                logger.info("No update available")
                return None
            
            # Update is available - check if AppImageUpdate can handle it
            update_available = self._check_appimageupdate()
            
            if not update_available:
                logger.warning("Update available but AppImageUpdate failed to verify")
                return None
            
            return {
                'update_available': True,
                'latest_version': result.get('latestVersion'),
                'current_version': result.get('currentVersion'),
                'release_notes': result.get('releaseNotes'),
                'download_url': result.get('downloadUrl'),
                'checksum': result.get('checksum'),
            }
            
        except Exception as e:
            logger.error(f"Update check failed: {e}", exc_info=True)
            return None
    
    def _check_appimageupdate(self) -> bool:
        """
        Use appimageupdatetool to check if update is available.
        
        Returns:
            True if update is available
        """
        try:
            # Run appimageupdatetool with check-for-update option
            result = subprocess.run(
                ['appimageupdatetool', '--check-for-update', self.current_appimage],
                capture_output=True,
                text=True,
                timeout=30
            )
            
            # Exit code 1 means update available
            # Exit code 0 means no update
            # Exit code 2 means error
            
            if result.returncode == 1:
                logger.info("AppImageUpdate: Update available")
                return True
            elif result.returncode == 0:
                logger.info("AppImageUpdate: No update available")
                return False
            else:
                logger.warning(f"AppImageUpdate check failed: {result.stderr}")
                return False
                
        except FileNotFoundError:
            logger.error("appimageupdatetool not found")
            return False
        except subprocess.TimeoutExpired:
            logger.error("AppImageUpdate check timed out")
            return False
        except Exception as e:
            logger.error(f"AppImageUpdate check failed: {e}")
            return False
    
    def download_and_apply_update(
        self,
        progress_callback=None
    ) -> bool:
        """
        Download and apply update using AppImageUpdate.
        
        Uses delta updates (zsync) when available for efficiency.
        
        Args:
            progress_callback: Optional callback(percent: int, message: str)
            
        Returns:
            True if update was successful
        """
        if not self.can_update():
            logger.error("Cannot update - not running as AppImage or tools missing")
            return False
        
        try:
            if progress_callback:
                progress_callback(0, "Checking for updates...")
            
            # Create backup of current AppImage
            backup_path = f"{self.current_appimage}.backup"
            logger.info(f"Creating backup: {backup_path}")
            shutil.copy2(self.current_appimage, backup_path)
            
            if progress_callback:
                progress_callback(10, "Downloading update...")
            
            # Run appimageupdatetool to perform update
            # This will download delta update and apply it
            logger.info("Running AppImageUpdate...")
            result = subprocess.run(
                ['appimageupdatetool', self.current_appimage],
                capture_output=True,
                text=True,
                timeout=600  # 10 minutes max
            )
            
            if result.returncode != 0:
                logger.error(f"AppImageUpdate failed: {result.stderr}")
                # Restore backup
                logger.info("Restoring backup after failed update")
                shutil.copy2(backup_path, self.current_appimage)
                os.remove(backup_path)
                return False
            
            logger.info("AppImageUpdate completed successfully")
            
            if progress_callback:
                progress_callback(100, "Update complete!")
            
            # Clean up backup (keep it for one session in case of issues)
            # It will be cleaned up on next startup
            
            return True
            
        except subprocess.TimeoutExpired:
            logger.error("AppImageUpdate timed out")
            return False
        except Exception as e:
            logger.error(f"Update failed: {e}", exc_info=True)
            return False
    
    def restart_application(self):
        """
        Restart the application after update.
        
        Executes the updated AppImage and exits current process.
        """
        if not self.current_appimage:
            logger.error("Cannot restart - not running as AppImage")
            return
        
        try:
            logger.info("Restarting application...")
            
            # Execute new AppImage
            os.execv(self.current_appimage, [self.current_appimage])
            
        except Exception as e:
            logger.error(f"Failed to restart: {e}", exc_info=True)
    
    def _get_current_version(self) -> str:
        """
        Get current application version.
        
        Returns:
            Version string
        """
        try:
            from desktop_app import APP_VERSION
            return APP_VERSION
        except ImportError:
            return "unknown"
    
    @staticmethod
    def install_update_tool():
        """
        Install appimageupdatetool if not present.
        
        Downloads and installs the tool to ~/.local/bin/
        """
        tool_path = os.path.expanduser('~/.local/bin/appimageupdatetool')
        
        if os.path.exists(tool_path):
            logger.info("appimageupdatetool already installed")
            return True
        
        try:
            import requests
            
            logger.info("Downloading appimageupdatetool...")
            
            url = (
                "https://github.com/AppImage/AppImageUpdate/releases/download/"
                "continuous/appimageupdatetool-x86_64.AppImage"
            )
            
            response = requests.get(url, timeout=60)
            response.raise_for_status()
            
            # Create directory
            os.makedirs(os.path.dirname(tool_path), exist_ok=True)
            
            # Save file
            with open(tool_path, 'wb') as f:
                f.write(response.content)
            
            # Make executable
            os.chmod(tool_path, 0o755)
            
            logger.info(f"appimageupdatetool installed to {tool_path}")
            return True
            
        except Exception as e:
            logger.error(f"Failed to install appimageupdatetool: {e}")
            return False
```

#### Step 4: Integrate with Desktop App

**Update `desktop_app.py`:**

```python
# Near top of file
from platform_utils import IS_LINUX, IS_WINDOWS
if IS_LINUX:
    from appimage_updater import AppImageUpdater

class UpdateManager:
    """Cross-platform update manager"""
    
    def __init__(self, ai_server_url):
        self.ai_server_url = ai_server_url
        
        # Choose updater based on platform and installation type
        if IS_WINDOWS:
            self.updater = WindowsUpdater(ai_server_url)
        elif IS_LINUX:
            # Check if running as AppImage
            appimage_updater = AppImageUpdater(ai_server_url)
            if appimage_updater.is_appimage():
                logger.info("Running as AppImage - using AppImageUpdate")
                self.updater = appimage_updater
            else:
                logger.info("Running as standalone - using fallback updater")
                self.updater = LinuxStandaloneUpdater(ai_server_url)
        else:
            logger.warning(f"Unsupported platform: {sys.platform}")
            self.updater = None
    
    def check_for_updates(self):
        """Check for updates using platform-appropriate method"""
        if not self.updater:
            return None
        return self.updater.check_for_update()
    
    def apply_update(self):
        """Download and apply update"""
        if not self.updater:
            return False
        return self.updater.download_and_apply_update()
```

---

### 4.2 Phase 2: Standalone Binary Self-Updater (Fallback)

For users who build from source or install the standalone binary (not AppImage).

**Create `linux_standalone_updater.py`:**

```python
"""
Linux Standalone Binary Updater

Self-update mechanism for standalone TimeTracker binaries (non-AppImage).
Similar to Windows updater but adapted for Linux.
"""

import os
import sys
import logging
import requests
import hashlib
import tempfile
import shutil
import subprocess
import time
from pathlib import Path
from typing import Optional, Dict, Any

logger = logging.getLogger(__name__)


class LinuxStandaloneUpdater:
    """
    Self-updater for standalone Linux binaries.
    
    Update process:
    1. Download new version to temp directory
    2. Verify checksum
    3. Create backup of current version
    4. Replace current binary
    5. Restart application
    6. Clean up backup on successful start
    """
    
    def __init__(self, ai_server_url: str):
        self.ai_server_url = ai_server_url
        self.current_path = self._get_executable_path()
        self.update_dir = self._get_update_dir()
    
    def _get_executable_path(self) -> str:
        """Get path to current executable"""
        if getattr(sys, 'frozen', False):
            # Running as PyInstaller bundle
            return sys.executable
        else:
            # Running as script
            return os.path.abspath(__file__)
    
    def _get_update_dir(self) -> str:
        """Get directory for storing updates"""
        # Use XDG_DATA_HOME if available
        xdg_data = os.environ.get('XDG_DATA_HOME')
        if xdg_data:
            update_dir = os.path.join(xdg_data, 'timetracker', 'updates')
        else:
            update_dir = os.path.expanduser('~/.local/share/timetracker/updates')
        
        os.makedirs(update_dir, exist_ok=True)
        return update_dir
    
    def can_update(self) -> bool:
        """
        Check if updates are possible.
        
        Returns:
            True if binary is writable (can be updated)
        """
        # Check if current binary is writable
        if not os.access(self.current_path, os.W_OK):
            logger.warning(
                f"Binary not writable: {self.current_path}. "
                "Updates may require manual installation."
            )
            # Check if directory is writable (we can replace file)
            dir_path = os.path.dirname(self.current_path)
            if not os.access(dir_path, os.W_OK):
                logger.error(f"Directory not writable: {dir_path}")
                return False
        
        return True
    
    def check_for_update(self) -> Optional[Dict[str, Any]]:
        """
        Check AI server for available updates.
        
        Returns:
            dict: Update info if available, None otherwise
        """
        try:
            from desktop_app import APP_VERSION
            
            url = (
                f"{self.ai_server_url}/api/app-version/check"
                f"?platform=linux&current={APP_VERSION}"
            )
            
            response = requests.get(url, timeout=10)
            
            if response.status_code != 200:
                logger.warning(f"Version check failed: HTTP {response.status_code}")
                return None
            
            data = response.json()
            
            if not data.get('success'):
                return None
            
            result = data.get('data', {})
            
            if not result.get('updateAvailable'):
                return None
            
            return {
                'update_available': True,
                'latest_version': result.get('latestVersion'),
                'current_version': result.get('currentVersion'),
                'download_url': result.get('downloadUrl'),
                'release_notes': result.get('releaseNotes'),
                'checksum': result.get('checksum'),
                'file_size_bytes': result.get('fileSizeBytes'),
            }
            
        except Exception as e:
            logger.error(f"Update check failed: {e}", exc_info=True)
            return None
    
    def download_and_apply_update(
        self,
        update_info: Dict[str, Any],
        progress_callback=None
    ) -> bool:
        """
        Download and apply update.
        
        Args:
            update_info: Update information from check_for_update()
            progress_callback: Optional callback(percent, message)
            
        Returns:
            True if successful
        """
        download_url = update_info.get('download_url')
        expected_checksum = update_info.get('checksum')
        
        if not download_url:
            logger.error("No download URL in update info")
            return False
        
        try:
            # Step 1: Download
            if progress_callback:
                progress_callback(0, "Downloading update...")
            
            temp_file = os.path.join(self.update_dir, 'TimeTracker.new')
            
            logger.info(f"Downloading from {download_url}")
            response = requests.get(download_url, stream=True, timeout=300)
            response.raise_for_status()
            
            total_size = int(response.headers.get('content-length', 0))
            downloaded = 0
            
            with open(temp_file, 'wb') as f:
                for chunk in response.iter_content(chunk_size=8192):
                    if chunk:
                        f.write(chunk)
                        downloaded += len(chunk)
                        
                        if progress_callback and total_size > 0:
                            percent = int((downloaded / total_size) * 80)
                            progress_callback(
                                percent,
                                f"Downloaded {downloaded // 1024 // 1024}MB / "
                                f"{total_size // 1024 // 1024}MB"
                            )
            
            logger.info(f"Download complete: {temp_file}")
            
            # Step 2: Verify checksum
            if progress_callback:
                progress_callback(85, "Verifying download...")
            
            if not self._verify_checksum(temp_file, expected_checksum):
                logger.error("Checksum verification failed!")
                os.remove(temp_file)
                return False
            
            logger.info("Checksum verified")
            
            # Step 3: Make executable
            os.chmod(temp_file, 0o755)
            
            # Step 4: Create update script
            if progress_callback:
                progress_callback(90, "Preparing update...")
            
            update_script = self._create_update_script(temp_file)
            
            # Step 5: Launch update script and exit
            if progress_callback:
                progress_callback(95, "Applying update...")
            
            logger.info("Launching update script...")
            subprocess.Popen(
                ['bash', update_script],
                start_new_session=True,
                stdin=subprocess.DEVNULL,
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL
            )
            
            # Give script time to start
            time.sleep(1)
            
            logger.info("Update script launched - exiting application")
            
            return True
            
        except Exception as e:
            logger.error(f"Update failed: {e}", exc_info=True)
            return False
    
    def _verify_checksum(self, file_path: str, expected: str) -> bool:
        """Verify SHA256 checksum of downloaded file"""
        if not expected:
            logger.warning("No checksum provided - skipping verification")
            return True
        
        try:
            sha256 = hashlib.sha256()
            with open(file_path, 'rb') as f:
                for chunk in iter(lambda: f.read(8192), b''):
                    sha256.update(chunk)
            
            actual = sha256.hexdigest()
            
            if actual.lower() == expected.lower():
                logger.info(f"Checksum verified: {actual[:16]}...")
                return True
            else:
                logger.error(f"Checksum mismatch!")
                logger.error(f"  Expected: {expected}")
                logger.error(f"  Actual:   {actual}")
                return False
                
        except Exception as e:
            logger.error(f"Checksum verification failed: {e}")
            return False
    
    def _create_update_script(self, new_binary_path: str) -> str:
        """
        Create bash script to replace binary and restart.
        
        The script waits for current process to exit, then replaces
        the binary and restarts the application.
        """
        script_path = os.path.join(self.update_dir, 'apply_update.sh')
        
        current_pid = os.getpid()
        backup_path = f"{self.current_path}.backup"
        
        script_content = f"""#!/bin/bash
# Time Tracker Update Script (Linux)
# Auto-generated - do not edit

set -e

CURRENT_BINARY="{self.current_path}"
NEW_BINARY="{new_binary_path}"
BACKUP_BINARY="{backup_path}"
CURRENT_PID={current_pid}

echo "[UPDATE] Waiting for application to exit (PID $CURRENT_PID)..."

# Wait for current process to exit (max 30 seconds)
for i in {{1..30}}; do
    if ! kill -0 $CURRENT_PID 2>/dev/null; then
        echo "[UPDATE] Application exited"
        break
    fi
    sleep 1
done

# Force kill if still running
if kill -0 $CURRENT_PID 2>/dev/null; then
    echo "[UPDATE] Force terminating application..."
    kill -9 $CURRENT_PID 2>/dev/null || true
    sleep 2
fi

# Wait for file to be unlocked
echo "[UPDATE] Waiting for file to be unlocked..."
for i in {{1..10}}; do
    if fuser "$CURRENT_BINARY" 2>/dev/null; then
        sleep 1
    else
        break
    fi
done

# Create backup
echo "[UPDATE] Creating backup..."
if [ -f "$CURRENT_BINARY" ]; then
    cp -f "$CURRENT_BINARY" "$BACKUP_BINARY" || {{
        echo "[ERROR] Failed to create backup"
        exit 1
    }}
fi

# Replace binary
echo "[UPDATE] Replacing binary..."
cp -f "$NEW_BINARY" "$CURRENT_BINARY" || {{
    echo "[ERROR] Failed to replace binary"
    # Restore backup
    if [ -f "$BACKUP_BINARY" ]; then
        cp -f "$BACKUP_BINARY" "$CURRENT_BINARY"
    fi
    exit 1
}}

# Make executable
chmod +x "$CURRENT_BINARY"

# Clean up
rm -f "$NEW_BINARY"

echo "[UPDATE] Update complete - restarting application..."

# Restart application
"$CURRENT_BINARY" &

# Clean up this script after 5 seconds
(sleep 5 && rm -f "$0") &

echo "[UPDATE] Done!"
"""
        
        with open(script_path, 'w') as f:
            f.write(script_content)
        
        os.chmod(script_path, 0o755)
        
        return script_path
```

---

### 4.3 Phase 3: .deb Package Notification (Optional)

For users who install via .deb packages, notify them to use system updater.

**Detect .deb installation:**

```python
def is_deb_package() -> bool:
    """Check if app was installed via .deb package"""
    # .deb packages install to /opt/ or /usr/
    exe_path = sys.executable
    return (
        exe_path.startswith('/opt/') or
        exe_path.startswith('/usr/bin/') or
        exe_path.startswith('/usr/local/bin/')
    )

def show_system_update_notification():
    """Show notification directing user to system updater"""
    PlatformUtils.show_notification(
        "Update Available",
        "A new version of Time Tracker is available. "
        "Please update using your system package manager:\n"
        "sudo apt-get update && sudo apt-get upgrade timetracker",
        duration='long'
    )
```

---

## 5. Security Considerations

### 5.1 Update Integrity

**Checksum Verification:**
- All downloads must be verified with SHA256 checksums
- Checksums served from AI server over HTTPS
- Mismatch = abort update and show error

**GPG Signatures (AppImage):**
```bash
# Sign AppImage with GPG key
gpg --detach-sign --armor TimeTracker-1.4.6-x86_64.AppImage

# Verify signature
gpg --verify TimeTracker-1.4.6-x86_64.AppImage.asc TimeTracker-1.4.6-x86_64.AppImage
```

### 5.2 Secure Download

**HTTPS Only:**
- All update checks and downloads over HTTPS
- Certificate verification enabled
- No fallback to HTTP

**AI Server Certificate Pinning (Future):**
```python
import ssl
import certifi

def create_secure_context():
    context = ssl.create_default_context(cafile=certifi.where())
    context.check_hostname = True
    context.verify_mode = ssl.CERT_REQUIRED
    return context
```

### 5.3 Rollback Protection

**Backup Strategy:**
- Always create backup before replacing
- Keep backup for one session
- Automatic rollback on failure
- Manual rollback option in UI

**Atomic Updates:**
```bash
# Atomic file replacement using mv
mv -f TimeTracker.new TimeTracker
```

### 5.4 Privilege Handling

**No sudo Required:**
- User-level installations update without privileges
- System packages direct to apt (requires sudo)
- Clear messaging about permissions

**File Permissions:**
```python
# Ensure update script has correct permissions
os.chmod(update_script, 0o755)

# Ensure binary is executable
os.chmod(new_binary, 0o755)
```

---

## 6. Testing Strategy

### 6.1 Test Matrix

| Test Scenario | AppImage | Standalone | .deb |
|---------------|----------|------------|------|
| Fresh install | ✅ | ✅ | ✅ |
| Update available | ✅ | ✅ | ✅ |
| Download failure | ✅ | ✅ | N/A |
| Checksum mismatch | ✅ | ✅ | N/A |
| Network interruption | ✅ | ✅ | N/A |
| Insufficient space | ✅ | ✅ | ✅ |
| Permission denied | N/A | ✅ | ✅ |
| Multiple instances | ✅ | ✅ | ✅ |
| Rollback on failure | ✅ | ✅ | N/A |

### 6.2 Test Procedure

**Pre-Update Testing:**
1. Install app (AppImage/standalone/.deb)
2. Verify app functions correctly
3. Check current version displayed

**Update Testing:**
1. Trigger update check
2. Verify update detected
3. Start download
4. Monitor progress
5. Verify checksum check
6. Apply update
7. Verify app restarts
8. Verify new version active
9. Verify data persists
10. Verify no functionality lost

**Failure Testing:**
1. Interrupt download mid-way → Verify retry works
2. Corrupt downloaded file → Verify checksum fails, download again
3. Kill process during update → Verify backup restored
4. Remove write permission → Verify graceful error
5. Fill disk space → Verify cleanup and error message

### 6.3 Automated Testing

**test_appimage_updater.py:**

```python
import pytest
from appimage_updater import AppImageUpdater

def test_appimage_detection():
    """Test AppImage detection"""
    updater = AppImageUpdater()
    # In CI, this will be False
    assert isinstance(updater.is_appimage(), bool)

def test_cannot_update_non_appimage():
    """Test update check fails gracefully for non-AppImage"""
    updater = AppImageUpdater()
    if not updater.is_appimage():
        assert updater.can_update() is False

@pytest.mark.integration
def test_update_check():
    """Test update check against live server"""
    updater = AppImageUpdater()
    if updater.is_appimage():
        update_info = updater.check_for_update()
        assert update_info is None or isinstance(update_info, dict)

# ... more tests ...
```

---

## 7. User Experience

### 7.1 Update Flow

**Silent Check (Background):**
```
App Running
    ↓
4 hours pass
    ↓
Check for update (silent)
    ↓
Update available?
    ├─ No → Continue
    └─ Yes → Show notification
              ↓
          User clicks notification
              ↓
          Download in background
              ↓
          Show "Update ready" notification
              ↓
          User clicks "Install"
              ↓
          Apply update & restart
```

**Manual Check (From Menu):**
```
User: Settings → Check for Updates
    ↓
Show "Checking..."
    ↓
Update available?
    ├─ No → Show "Up to date"
    └─ Yes → Show update details
              ↓
          User clicks "Download"
              ↓
          Show progress bar
              ↓
          Download & verify
              ↓
          Show "Install" button
              ↓
          User clicks "Install"
              ↓
          Apply & restart
```

### 7.2 Notifications

**Update Available:**
```
┌──────────────────────────────────┐
│ Time Tracker                     │
│                                  │
│ Update v1.4.7 Available          │
│                                  │
│ • Bug fixes                      │
│ • Performance improvements       │
│                                  │
│ [Download Now]  [Later]          │
└──────────────────────────────────┘
```

**Download Progress:**
```
┌──────────────────────────────────┐
│ Time Tracker                     │
│                                  │
│ Downloading Update...            │
│                                  │
│ [████████░░░░] 67%               │
│ 15 MB / 22 MB                    │
└──────────────────────────────────┘
```

**Ready to Install:**
```
┌──────────────────────────────────┐
│ Time Tracker                     │
│                                  │
│ Update Ready!                    │
│                                  │
│ Click to install v1.4.7          │
│ (App will restart)               │
│                                  │
│ [Install Now]  [Later]           │
└──────────────────────────────────┘
```

### 7.3 Settings UI

**Update Preferences:**

```python
# In Settings dialog
┌─ Update Settings ─────────────────┐
│                                    │
│ [✓] Automatically check for updates│
│                                    │
│ Check frequency:                   │
│ [ ] Every 4 hours (recommended)    │
│ [ ] Daily                          │
│ [ ] Weekly                         │
│                                    │
│ [✓] Download updates automatically │
│ [ ] Install updates automatically  │
│     (requires restart)             │
│                                    │
│ Current version: 1.4.6             │
│ [] Check for Updates Now           │
│                                    │
└────────────────────────────────────┘
```

---

## 8. Comparison Matrix

### 8.1 Update Methods Comparison

| Feature | AppImage | Standalone | .deb | Snap | Flatpak |
|---------|----------|------------|------|------|---------|
| **Installation** |
| Requires sudo | ❌ | ❌ | ✅ | ❌ | ❌ |
| Single file | ✅ | ✅ | ❌ | ❌ | ❌ |
| Portable | ✅ | ✅ | ❌ | ❌ | ❌ |
| System integration | ⚠️ | ⚠️ | ✅ | ✅ | ✅ |
| **Updates** |
| Auto-update | ✅ | ✅ | Via apt | ✅ | ✅ |
| Delta updates | ✅ | ❌ | ✅ | ✅ | ✅ |
| Background download | ✅ | ✅ | ✅ | ✅ | ✅ |
| No user action | ✅ | ✅ | ❌* | ✅ | ✅ |
| Rollback support | ✅ | ⚠️ | ✅ | ✅ | ✅ |
| **Distribution** |
| Universal | ✅ | ✅ | ❌ | ✅ | ✅ |
| Distro-specific | ❌ | ❌ | ✅ | ❌ | ❌ |
| Store required | ❌ | ❌ | ❌ | ✅ | ✅ |
| **Security** |
| Signature verification | ✅ | ⚠️ | ✅ | ✅ | ✅ |
| Sandboxed | ❌ | ❌ | ❌ | ✅ | ✅ |
| **Performance** |
| Startup time | Fast | Fast | Fast | Slow | Medium |
| Disk space | Medium | Small | Small | Medium | Medium |
| Download size | Medium | Small** | Small | Medium | Medium |

* .deb updates require sudo password
** Standalone is smallest (no embedded updater)

### 8.2 Recommendation Summary

**Primary Distribution Method:** ⭐ **AppImage**
- Best balance of features
- Universal compatibility
- Built-in update support
- No sudo required
- Delta updates

**Secondary Methods:**
1. **.deb package** - For enterprise/IT-managed environments
2. **Standalone binary** - For advanced users who prefer building from source
3. **Snap** (Future) - When/if sandboxing limitations are resolved

---

## 9. Implementation Timeline

### Week 1: AppImage Infrastructure
- Day 1-2: Set up AppImage build system
- Day 3: Implement AppImageUpdater class
- Day 4: Integrate with desktop_app.py
- Day 5: Testing on Ubuntu

### Week 2: Fallback Updater
- Day 1-2: Implement LinuxStandaloneUpdater
- Day 3: Create update scripts
- Day 4: Integration testing
- Day 5: Documentation

### Week 3: Server-Side
- Day 1-2: Set up download endpoints on AI server
- Day 3: Implement zsync support
- Day 4: Update version API
- Day 5: Checksum generation automation

### Week 4: Testing & Polish
- Day 1-2: Cross-distribution testing
- Day 3: UI/UX refinement
- Day 4: Beta deployment
- Day 5: Documentation and release notes

---

## 10. Server-Side Requirements

### 10.1 File Hosting

**Directory structure:**
```
/var/www/forgesync.amzur.com/downloads/
├── linux/
│   ├── TimeTracker-latest-x86_64.AppImage
│   ├── TimeTracker-latest-x86_64.AppImage.zsync
│   ├── TimeTracker-latest-x86_64.AppImage.sha256
│   ├── TimeTracker-1.4.6-x86_64.AppImage
│   ├── TimeTracker-1.4.6-x86_64.AppImage.zsync
│   ├── TimeTracker-1.4.6-x86_64.AppImage.sha256
│   ├── TimeTracker-1.4.5-x86_64.AppImage
│   ├── ...
│   └── standalone/
│       ├── TimeTracker-latest
│       ├── TimeTracker-latest.sha256
│       └── ...
└── windows/
    └── ...
```

### 10.2 Version API

**Update `/api/app-version/check`:**

```javascript
// ai-server/src/routes/appVersion.js

router.get('/check', async (req, res) => {
    const { platform, current } = req.query;
    
    // ... existing code ...
    
    // Linux-specific logic
    if (platform === 'linux') {
        // Serve AppImage by default
        const downloadUrl = `${BASE_URL}/downloads/linux/TimeTracker-${latestVersion}-x86_64.AppImage`;
        const checksumUrl = `${downloadUrl}.sha256`;
        
        // Read checksum
        const checksumContent = await fs.readFile(checksumPath, 'utf-8');
        const checksum = checksumContent.split(' ')[0];
        
        return res.json({
            success: true,
            data: {
                updateAvailable: isNewer(latestVersion, current),
                latestVersion,
                currentVersion: current,
                downloadUrl,
                checksumUrl,
                checksum,
                releaseNotes: getReleaseNotes(latestVersion),
                fileSizeBytes: getFileSize(downloadUrl),
                // AppImage-specific
                zsyncUrl: `${downloadUrl}.zsync`,
                updateMethod: 'appimage'
            }
        });
    }
    
    // ... rest of code ...
});
```

### 10.3 Automation Script

**Create `upload_linux_release.sh`:**

```bash
#!/bin/bash
# Upload Linux release to server

set -e

VERSION="$1"
APPIMAGE_PATH="$2"

if [ -z "$VERSION" ] || [ -z "$APPIMAGE_PATH" ]; then
    echo "Usage: $0 <version> <appimage-path>"
    exit 1
fi

SERVER="forgesync.amzur.com"
REMOTE_DIR="/var/www/forgesync.amzur.com/downloads/linux"

echo "Uploading Linux release v${VERSION}..."

# Generate checksums
echo "Generating checksums..."
sha256sum "$APPIMAGE_PATH" > "${APPIMAGE_PATH}.sha256"

# Generate zsync
echo "Generating zsync metadata..."
zsyncmake -u "https://${SERVER}/downloads/linux/$(basename $APPIMAGE_PATH)" \
          -o "${APPIMAGE_PATH}.zsync" \
          "$APPIMAGE_PATH"

# Upload files
echo "Uploading files..."
scp "$APPIMAGE_PATH" \
    "${APPIMAGE_PATH}.sha256" \
    "${APPIMAGE_PATH}.zsync" \
    "deploy@${SERVER}:${REMOTE_DIR}/"

# Update 'latest' symlinks
echo "Updating latest symlinks..."
ssh "deploy@${SERVER}" << EOF
cd ${REMOTE_DIR}
ln -sf $(basename $APPIMAGE_PATH) TimeTracker-latest-x86_64.AppImage
ln -sf $(basename $APPIMAGE_PATH).zsync TimeTracker-latest-x86_64.AppImage.zsync
ln -sf $(basename $APPIMAGE_PATH).sha256 TimeTracker-latest-x86_64.AppImage.sha256
EOF

echo "Upload complete!"
echo ""
echo "Download URLs:"
echo "  AppImage: https://${SERVER}/downloads/linux/$(basename $APPIMAGE_PATH)"
echo "  zsync:    https://${SERVER}/downloads/linux/$(basename $APPIMAGE_PATH).zsync"
echo "  Checksum: https://${SERVER}/downloads/linux/$(basename $APPIMAGE_PATH).sha256"
echo ""
```

---

## 11. Documentation Required

### 11.1 User Documentation

**Create `UPDATING_LINUX.md`:**

```markdown
# Updating Time Tracker on Linux

Time Tracker supports automatic updates on Linux. The update mechanism
depends on how you installed the application.

## AppImage (Recommended)

If you downloaded the AppImage:

1. **Automatic Updates**: The app checks for updates every 4 hours
2. **Manual Check**: Menu → Help → Check for Updates
3. **Delta Updates**: Only downloads changed parts (saves bandwidth)
4. **No sudo**: Updates without administrator password

## Standalone Binary

If you built from source or installed manually:

1. **Automatic Updates**: Enabled by default
2. **Downloads**: Full binary (~80MB)
3. **Location**: Updates in-place

## System Package (.deb)

If you installed via `apt`:

```bash
# Check for updates
sudo apt-get update

# Install updates
sudo apt-get upgrade timetracker
```

Updates are managed by your system package manager.

## Troubleshooting

### Update check fails

- Check internet connection
- Verify firewall allows connections to forgesync.amzur.com
- Try manual check: Menu → Help → Check for Updates

### "Permission denied" error

If you get permission errors:

```bash
# Make file writable
chmod +w TimeTracker

# Or move to user directory
mv TimeTracker ~/.local/bin/
```

### AppImageUpdate not found

Install the update tool:

```bash
sudo apt-get install appimageupdatetool
```

Or download manually:
```bash
wget https://github.com/AppImage/AppImageUpdate/releases/download/continuous/appimageupdatetool-x86_64.AppImage
chmod +x appimageupdatetool-x86_64.AppImage
mv appimageupdatetool-x86_64.AppImage ~/.local/bin/appimageupdatetool
```

## Disabling Automatic Updates

To disable automatic update checks:

1. Open Settings
2. Go to Updates tab
3. Uncheck "Automatically check for updates"

```

### 11.2 Developer Documentation

**Add to `README.md`:**

```markdown
## Building Linux Releases

### AppImage

```bash
cd python-desktop-app
./build_appimage.sh
```

Output: `TimeTracker-1.4.6-x86_64.AppImage`

### Standalone Binary

```bash
cd python-desktop-app
./build.sh
```

Output: `dist/TimeTracker`

### .deb Package

```bash
cd python-desktop-app
./create_deb_package.sh 1.4.6
```

Output: `timetracker_1.4.6_amd64.deb`

## Publishing Releases

Upload to server:

```bash
./upload_linux_release.sh 1.4.6 TimeTracker-1.4.6-x86_64.AppImage
```

This will:
1. Generate checksums
2. Generate zsync metadata
3. Upload all files to server
4. Update 'latest' symlinks
```

---

## 12. Rollout Strategy

### 12.1 Phased Rollout

**Phase 1: Internal Testing (Week 1)**
- Deploy to development team (5 users)
- Test on Ubuntu 22.04, 24.04, Fedora 39
- Monitor logs for errors

**Phase 2: Beta Program (Week 2-3)**
- Deploy to opt-in beta users (50 users)
- Mix of distributions and installation methods
- Collect feedback and metrics

**Phase 3: Gradual Release (Week 4+)**
- 10% of Linux users → 25% → 50% → 100%
- Monitor:
  - Update success rate
  - Download failures
  - Checksum mismatches
  - Restart failures

### 12.2 Metrics to Track

**Success Metrics:**
- % of users with auto-update enabled
- Update check success rate (target: >95%)
- Download success rate (target: >90%)
- Update apply success rate (target: >98%)
- Average update time (target: <5 minutes)

**Error Metrics:**
- Network failures during download
- Checksum mismatches
- Permission errors
- Restart failures

---

## 13. Future Enhancements

### 13.1 Advanced Features

**Staged Rollouts:**
```python
# Server-side: gradually release to user cohorts
if user_id % 10 < rollout_percentage / 10:
    return latest_version
else:
    return previous_stable_version
```

**A/B Testing:**
- Test different update prompts
- Measure opt-in rates
- Optimize UX

**Background Intelligent Transfer Service (BITS):**
- Resume interrupted downloads
- Throttle during high usage
- Schedule updates

### 13.2 Additional Formats

**Flatpak:**
- Publish to Flathub
- Automatic updates via Flatpak daemon
- Sandboxed environment

**Snap:**
- Publish to Snap Store
- Automatic updates via snapd
- Strict confinement

**Native Repositories:**
- Set up apt repository (Ubuntu/Debian)
- Set up RPM repository (Fedora/RHEL)
- GPG signing and verification

---

## 14. Conclusion

### 14.1 Summary

This plan provides a comprehensive approach to automatic updates on Linux:

1. **AppImage with AppImageUpdate** (Primary)
   - Universal compatibility
   - Delta updates
   - No sudo required
   - Standardized protocol

2. **Standalone Binary Self-Updater** (Fallback)
   - Similar to Windows approach
   - Works for any installation
   - Full download (no deltas)

3. **.deb Package with System Integration** (Optional)
   - Enterprise-friendly
   - Integrated with system updates
   - Requires repository maintenance

### 14.2 Recommended Implementation Order

1. **Week 1-2:** Implement AppImage auto-update (primary)
2. **Week 3:** Implement standalone updater (fallback)
3. **Week 4:** Testing and refinement
4. **Future:** .deb repository and Snap/Flatpak support

### 14.3 Success Criteria

- ✅ AppImage users get automatic delta updates
- ✅ Standalone binary users get automatic full updates
- ✅ All updates verify checksums
- ✅ Failed updates rollback automatically
- ✅ No sudo required for user-level installations
- ✅ Works across all major distributions

---

**Document Version:** 1.0  
**Date:** June 1, 2026  
**Status:** Ready for Implementation
