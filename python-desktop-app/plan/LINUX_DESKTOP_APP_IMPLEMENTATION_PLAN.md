# Linux Desktop App Implementation Plan

## Executive Summary

This document provides a comprehensive plan for making the JIRAForge Desktop Time Tracker application compatible with Linux systems. The implementation will maintain full feature parity with the Windows version while adapting platform-specific functionality for Linux environments.

**Key Goals:**
- ✅ Full Linux compatibility (Ubuntu, Debian, Fedora, Arch, etc.)
- ✅ OCR functionality with automatic engine selection
- ✅ System tray integration
- ✅ Desktop notifications
- ✅ Window tracking and activity monitoring
- ✅ Automated build and packaging
- ✅ No code changes to AI server or backend

---

## Table of Contents

1. [Current Architecture Analysis](#1-current-architecture-analysis)
2. [Platform-Specific Dependencies](#2-platform-specific-dependencies)
3. [OCR Engine Compatibility](#3-ocr-engine-compatibility)
4. [Implementation Roadmap](#4-implementation-roadmap)
5. [File Changes Required](#5-file-changes-required)
6. [Build and Packaging](#6-build-and-packaging)
7. [Testing Strategy](#7-testing-strategy)
8. [Deployment Strategy](#8-deployment-strategy)

---

## 1. Current Architecture Analysis

### 1.1 Current Platform Support

**Current State:**
- ✅ Fully functional on Windows 10/11
- ❌ Limited/untested on Linux
- ❌ No Linux-specific optimizations

**Key Windows-Specific Components:**
- `pywin32` - Window management and system APIs
- `winotify` - Desktop notifications
- `WinRTOCR` - Native Windows OCR engine
- Windows-specific system event monitoring
- `.bat` batch scripts for build and launch
- Win32 mutex for single instance management

### 1.2 Architecture Components

```
Desktop App Architecture
├── Core Application (desktop_app.py)
│   ├── Authentication & Token Management ✅ Cross-platform
│   ├── Activity Tracking ⚠️ Needs platform abstraction
│   ├── Screenshot Capture ⚠️ Needs platform adaptation
│   ├── OCR Processing ✅ Mostly cross-platform
│   ├── Data Sync with Supabase ✅ Cross-platform
│   └── System Tray Integration ⚠️ Needs platform adaptation
│
├── OCR Module (ocr/)
│   ├── Facade (facade.py) ✅ Cross-platform
│   ├── Engine Factory ✅ Cross-platform
│   ├── Image Processor ✅ Cross-platform
│   ├── Engines
│   │   ├── RapidOCR ✅ Linux compatible
│   │   ├── WinRTOCR ❌ Windows only
│   │   ├── EasyOCR ✅ Linux compatible
│   │   └── Tesseract ✅ Linux compatible (requires system binary)
│   └── Auto Installer ⚠️ Needs Linux package management
│
├── Auth Module (auth/) ✅ Cross-platform
│   ├── OAuth flows
│   └── Secure token storage (keyring)
│
└── Build System
    ├── PyInstaller spec ⚠️ Needs Linux configuration
    ├── Build scripts ❌ Windows batch files only
    └── Update mechanism ❌ Windows-specific
```

### 1.3 Dependencies Analysis

| Dependency | Windows | Linux | Notes |
|------------|---------|-------|-------|
| **Core** |
| flask | ✅ | ✅ | Cross-platform |
| supabase | ✅ | ✅ | Cross-platform |
| pystray | ✅ | ✅ | Cross-platform with Xorg/Wayland support |
| Pillow | ✅ | ✅ | Cross-platform |
| psutil | ✅ | ✅ | Cross-platform |
| requests | ✅ | ✅ | Cross-platform |
| cryptography | ✅ | ✅ | Cross-platform |
| keyring | ✅ | ✅ | Cross-platform (uses SecretService on Linux) |
| pynput | ✅ | ✅ | Cross-platform |
| **Windows-Specific** |
| pywin32 | ✅ | ❌ | Windows only - needs Linux alternatives |
| winotify | ✅ | ❌ | Windows only - use notify2/plyer instead |
| sqlcipher3-wheels | ✅ | ❌ | Windows only - use pysqlcipher3 on Linux |
| **OCR** |
| rapidocr-onnxruntime | ✅ | ✅ | Cross-platform (primary engine) |
| winrtocr | ✅ | ❌ | Windows only - enable fallback on Linux |
| numpy | ✅ | ✅ | Cross-platform |
| opencv-python | ✅ | ✅ | Cross-platform |
| **Privacy** |
| presidio-analyzer | ✅ | ✅ | Cross-platform |
| presidio-anonymizer | ✅ | ✅ | Cross-platform |

---

## 2. Platform-Specific Dependencies

### 2.1 Linux Alternatives for Windows Dependencies

#### A. Window Management (pywin32 replacement)

**Windows (current):**
```python
import win32gui
import win32process

hwnd = win32gui.GetForegroundWindow()
title = win32gui.GetWindowText(hwnd)
_, pid = win32process.GetWindowThreadProcessId(hwnd)
```

**Linux (proposed):**
```python
# Use python-xlib for X11 or PyQt5/PyGObject for Wayland
# Option 1: python-xlib (X11 systems)
from Xlib import display, X

def get_active_window_linux_x11():
    """Get active window info on X11"""
    d = display.Display()
    root = d.screen().root
    
    # Get active window
    NET_ACTIVE_WINDOW = d.intern_atom('_NET_ACTIVE_WINDOW')
    window = root.get_full_property(NET_ACTIVE_WINDOW, X.AnyPropertyType).value[0]
    window_obj = d.create_resource_object('window', window)
    
    # Get window title
    WM_NAME = d.intern_atom('WM_NAME')
    title = window_obj.get_full_property(WM_NAME, 0)
    
    # Get PID
    NET_WM_PID = d.intern_atom('_NET_WM_PID')
    pid = window_obj.get_full_property(NET_WM_PID, 0)
    
    return {
        'title': title.value.decode('utf-8') if title else '',
        'pid': pid.value[0] if pid else None,
        'app': get_process_name(pid.value[0]) if pid else ''
    }

# Option 2: psutil for process name (already available)
def get_process_name(pid):
    """Get process name from PID using psutil (cross-platform)"""
    try:
        proc = psutil.Process(pid)
        return proc.name()
    except (psutil.NoSuchProcess, psutil.AccessDenied):
        return 'Unknown'
```

**Dependencies to add:**
```txt
# Linux-specific window management
python-xlib>=0.33; sys_platform == 'linux'
# Wayland support (future)
pydbus>=0.6.0; sys_platform == 'linux'
```

#### B. Desktop Notifications (winotify replacement)

**Windows (current):**
```python
from winotify import Notification, audio

notification = Notification(
    app_id="Time Tracker",
    title="Update Available",
    msg="A new version is available",
    duration="short"
)
notification.set_audio(audio.Default, loop=False)
notification.show()
```

**Linux (proposed):**
```python
# Use notify2 (libnotify bindings) or plyer
# Option 1: notify2 (recommended - native Linux notifications)
import notify2

def show_notification_linux(title, message, duration='short'):
    """Show desktop notification on Linux using libnotify"""
    try:
        if not notify2.is_initted():
            notify2.init("Time Tracker")
        
        n = notify2.Notification(title, message)
        n.set_urgency(notify2.URGENCY_NORMAL)
        n.set_timeout(5000 if duration == 'short' else 10000)
        n.show()
    except Exception as e:
        print(f"[WARN] Could not show notification: {e}")

# Option 2: plyer (multi-platform, simpler but less features)
from plyer import notification

def show_notification_plyer(title, message, duration=5):
    """Cross-platform notification using plyer"""
    try:
        notification.notify(
            title=title,
            message=message,
            app_name='Time Tracker',
            timeout=duration
        )
    except Exception as e:
        print(f"[WARN] Could not show notification: {e}")
```

**Dependencies to add:**
```txt
# Linux-specific notifications
notify2>=0.3; sys_platform == 'linux'
# Alternative: plyer (cross-platform)
plyer>=2.1.0
```

**System dependencies (apt):**
```bash
# Ubuntu/Debian
sudo apt-get install libnotify-dev

# Fedora
sudo dnf install libnotify-devel

# Arch
sudo pacman -S libnotify
```

#### C. SQLCipher

**Windows (current):**
```txt
sqlcipher3-wheels>=0.5.0; sys_platform == 'win32'
```

**Linux (proposed):**
```txt
# Linux uses native SQLCipher
pysqlcipher3>=1.1.0; sys_platform == 'linux'
```

**System dependencies:**
```bash
# Ubuntu/Debian
sudo apt-get install libsqlcipher-dev

# Fedora
sudo dnf install sqlcipher-devel

# Arch
sudo pacman -S sqlcipher
```

#### D. Single Instance Lock

**Windows (current):**
```python
# Uses Win32 mutex
_instance_mutex = win32event.CreateMutex(None, True, mutex_name)
```

**Linux (proposed):**
```python
import fcntl
import os

def acquire_single_instance_lock_linux():
    """Linux-specific single instance lock using fcntl"""
    lock_file = os.path.join(get_app_data_dir(), '.lock')
    
    try:
        # Open lock file
        lock_fd = open(lock_file, 'w')
        
        # Try to acquire exclusive lock (non-blocking)
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        
        # Write PID
        lock_fd.write(str(os.getpid()))
        lock_fd.flush()
        
        # Keep file descriptor open (lock is released when closed)
        return lock_fd
    except IOError:
        # Lock already held by another process
        return None
```

---

## 3. OCR Engine Compatibility

### 3.1 OCR Engine Support Matrix

| Engine | Windows | Linux | macOS | Performance | Notes |
|--------|---------|-------|-------|-------------|-------|
| **RapidOCR** | ✅ | ✅ | ✅ | ⚡⚡⚡ Fast | **Primary** - ONNX Runtime, works everywhere |
| **WinRTOCR** | ✅ | ❌ | ❌ | ⚡⚡⚡ Fast | Windows native OCR - **skip on Linux** |
| **EasyOCR** | ✅ | ✅ | ✅ | ⚡⚡ Medium | PyTorch-based, large download (~500MB) |
| **Tesseract** | ✅ | ✅ | ✅ | ⚡ Slow | Fallback - requires system binary |

### 3.2 Platform Detection Logic

**Implementation in `ocr/config.py`:**

```python
import sys
import platform

def get_platform_compatible_engines():
    """
    Return list of OCR engines compatible with current platform.
    
    Returns:
        list: Available engine names for this platform
    """
    os_type = sys.platform
    
    # Common engines (work on all platforms)
    common_engines = ['rapidocr', 'easyocr', 'tesseract']
    
    # Platform-specific engines
    if os_type == 'win32':
        # Windows: all engines including native WinRT
        return common_engines + ['winrtocr']
    elif os_type == 'linux':
        # Linux: all except WinRT
        return common_engines
    elif os_type == 'darwin':
        # macOS: all except WinRT
        return common_engines
    else:
        # Unknown platform: use common engines
        return common_engines

def filter_engines_by_platform(engine_list):
    """
    Filter a list of configured engines to only include platform-compatible ones.
    
    Args:
        engine_list: List of engine names from config
        
    Returns:
        list: Filtered list containing only compatible engines
    """
    compatible = get_platform_compatible_engines()
    filtered = [e for e in engine_list if e in compatible]
    
    # Log filtered engines
    removed = [e for e in engine_list if e not in filtered]
    if removed:
        import logging
        logger = logging.getLogger(__name__)
        logger.info(
            f"Filtered incompatible engines for {sys.platform}: {removed}"
        )
        logger.info(f"Using compatible engines: {filtered}")
    
    return filtered
```

**Implementation in `ocr/facade.py`:**

```python
class OCRFacade:
    def __init__(self, config: Optional[OCRConfig] = None):
        """Initialize OCR Facade with platform-aware engine selection."""
        self.config = config or OCRConfig.from_env()
        
        # IMPORTANT: Filter engines by platform compatibility
        self.config = self._apply_platform_filters(self.config)
        
        # ... rest of initialization ...
    
    def _apply_platform_filters(self, config: OCRConfig) -> OCRConfig:
        """
        Filter configured engines to only use platform-compatible ones.
        Automatically switches to fallback if primary is unavailable.
        """
        compatible = get_platform_compatible_engines()
        
        # Check if primary engine is compatible
        if config.primary_engine not in compatible:
            logger.warning(
                f"Primary OCR engine '{config.primary_engine}' not compatible "
                f"with {sys.platform}. Switching to fallback."
            )
            # Find first compatible fallback
            for fallback in config.fallback_engines:
                if fallback in compatible:
                    logger.info(f"Using '{fallback}' as primary OCR engine")
                    config.primary_engine = fallback
                    break
            else:
                # No compatible engines configured - use rapidocr as default
                logger.warning("No compatible fallback found. Using 'rapidocr' as default.")
                config.primary_engine = 'rapidocr'
        
        # Filter fallback engines
        config.fallback_engines = filter_engines_by_platform(config.fallback_engines)
        
        return config
```

### 3.3 Recommended OCR Configuration for Linux

**.env configuration:**
```bash
# OCR Configuration (Linux-optimized)
OCR_PRIMARY_ENGINE=rapidocr
OCR_FALLBACK_ENGINES=tesseract

# RapidOCR settings (fast, accurate, cross-platform)
OCR_RAPIDOCR_MIN_CONFIDENCE=0.6
OCR_RAPIDOCR_USE_GPU=false  # Set to true if CUDA available
OCR_RAPIDOCR_LANGUAGE=en

# Tesseract settings (fallback)
OCR_TESSERACT_MIN_CONFIDENCE=0.5
OCR_TESSERACT_LANGUAGE=eng
OCR_TESSERACT_TIMEOUT=10

# Global OCR settings
OCR_USE_PREPROCESSING=true
OCR_MAX_IMAGE_DIMENSION=4096
OCR_PREPROCESSING_TARGET_DPI=300
```

**Why this configuration?**
- ✅ **RapidOCR** as primary: Fast, accurate, no system dependencies
- ✅ **Tesseract** as fallback: Widely available, reliable
- ❌ **EasyOCR** excluded: Large download (~500MB), slower
- ❌ **WinRTOCR** excluded: Not available on Linux (automatically filtered)

---

## 4. Implementation Roadmap

### Phase 1: Platform Abstraction Layer (Week 1)

**Goal:** Create abstraction layer for platform-specific functionality.

#### 1.1 Create `platform_utils.py`

Create new file: `python-desktop-app/platform_utils.py`

```python
"""
Platform Abstraction Layer

Provides unified interface for platform-specific functionality:
- Window management
- Desktop notifications
- Single instance locking
- System tray integration
- Screen lock detection
"""

import sys
import platform
import logging
from typing import Dict, Optional, Any

logger = logging.getLogger(__name__)

# Platform detection
IS_WINDOWS = sys.platform == 'win32'
IS_LINUX = sys.platform.startswith('linux')
IS_MACOS = sys.platform == 'darwin'

# Feature availability flags
NOTIFICATIONS_AVAILABLE = False
WINDOW_TRACKING_AVAILABLE = False
TRAY_AVAILABLE = False


class PlatformUtils:
    """Platform-specific utility functions"""
    
    @staticmethod
    def init():
        """Initialize platform-specific modules"""
        global NOTIFICATIONS_AVAILABLE, WINDOW_TRACKING_AVAILABLE, TRAY_AVAILABLE
        
        if IS_WINDOWS:
            NOTIFICATIONS_AVAILABLE = _init_windows_notifications()
            WINDOW_TRACKING_AVAILABLE = _init_windows_window_tracking()
        elif IS_LINUX:
            NOTIFICATIONS_AVAILABLE = _init_linux_notifications()
            WINDOW_TRACKING_AVAILABLE = _init_linux_window_tracking()
        elif IS_MACOS:
            NOTIFICATIONS_AVAILABLE = _init_macos_notifications()
            WINDOW_TRACKING_AVAILABLE = _init_macos_window_tracking()
        
        # pystray works on all platforms
        TRAY_AVAILABLE = True
        
        logger.info(f"Platform: {platform.system()} {platform.release()}")
        logger.info(f"  Notifications: {'✅' if NOTIFICATIONS_AVAILABLE else '❌'}")
        logger.info(f"  Window Tracking: {'✅' if WINDOW_TRACKING_AVAILABLE else '❌'}")
        logger.info(f"  System Tray: {'✅' if TRAY_AVAILABLE else '❌'}")
    
    @staticmethod
    def get_active_window() -> Optional[Dict[str, Any]]:
        """
        Get information about the currently active window.
        
        Returns:
            dict: {'title': str, 'app': str, 'pid': int} or None
        """
        if IS_WINDOWS:
            return _get_active_window_windows()
        elif IS_LINUX:
            return _get_active_window_linux()
        elif IS_MACOS:
            return _get_active_window_macos()
        return None
    
    @staticmethod
    def show_notification(title: str, message: str, duration: str = 'short'):
        """
        Show a desktop notification.
        
        Args:
            title: Notification title
            message: Notification message
            duration: 'short' or 'long'
        """
        if IS_WINDOWS:
            _show_notification_windows(title, message, duration)
        elif IS_LINUX:
            _show_notification_linux(title, message, duration)
        elif IS_MACOS:
            _show_notification_macos(title, message, duration)
    
    @staticmethod
    def acquire_single_instance_lock():
        """
        Acquire a single instance lock.
        
        Returns:
            bool: True if lock acquired (this is the only instance)
        """
        if IS_WINDOWS:
            return _acquire_lock_windows()
        elif IS_LINUX:
            return _acquire_lock_linux()
        elif IS_MACOS:
            return _acquire_lock_macos()
        return True  # Allow running if platform unsupported
    
    @staticmethod
    def is_screen_locked() -> bool:
        """
        Check if the screen is currently locked.
        
        Returns:
            bool: True if screen is locked
        """
        if IS_WINDOWS:
            return _is_screen_locked_windows()
        elif IS_LINUX:
            return _is_screen_locked_linux()
        elif IS_MACOS:
            return _is_screen_locked_macos()
        return False
    
    @staticmethod
    def get_platform_name() -> str:
        """Get human-readable platform name"""
        if IS_WINDOWS:
            return 'windows'
        elif IS_LINUX:
            return 'linux'
        elif IS_MACOS:
            return 'macos'
        return 'unknown'


# ============================================================================
# WINDOWS IMPLEMENTATIONS
# ============================================================================

def _init_windows_notifications():
    """Initialize Windows notification system"""
    try:
        from winotify import Notification
        return True
    except ImportError:
        logger.warning("winotify not available - notifications disabled")
        return False

def _init_windows_window_tracking():
    """Initialize Windows window tracking"""
    try:
        import win32gui
        return True
    except ImportError:
        logger.warning("pywin32 not available - window tracking disabled")
        return False

def _get_active_window_windows():
    """Get active window on Windows"""
    try:
        import win32gui
        import win32process
        import psutil
        
        hwnd = win32gui.GetForegroundWindow()
        title = win32gui.GetWindowText(hwnd)
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        
        try:
            proc = psutil.Process(pid)
            app_name = proc.name()
        except:
            app_name = 'Unknown'
        
        return {'title': title, 'app': app_name, 'pid': pid}
    except Exception as e:
        logger.debug(f"Could not get active window: {e}")
        return None

def _show_notification_windows(title, message, duration):
    """Show notification on Windows"""
    try:
        from winotify import Notification, audio
        
        notification = Notification(
            app_id="Time Tracker",
            title=title,
            msg=message,
            duration=duration
        )
        notification.set_audio(audio.Default, loop=False)
        notification.show()
    except Exception as e:
        logger.debug(f"Could not show notification: {e}")

def _acquire_lock_windows():
    """Acquire single instance lock on Windows"""
    try:
        import win32event
        import winerror
        import ctypes
        
        mutex_name = "TimeTracker_SingleInstance_Mutex"
        mutex = win32event.CreateMutex(None, True, mutex_name)
        last_error = ctypes.windll.kernel32.GetLastError()
        
        if last_error == winerror.ERROR_ALREADY_EXISTS:
            logger.warning("Another instance is already running")
            return False
        
        return True
    except Exception:
        # Fallback to file-based lock
        return _acquire_lock_file()

def _is_screen_locked_windows():
    """Check if screen is locked on Windows"""
    try:
        import ctypes
        from ctypes import windll
        
        # Check if workstation is locked
        user32 = windll.user32
        # Use GetForegroundWindow - returns 0 if workstation is locked
        hwnd = user32.GetForegroundWindow()
        return hwnd == 0
    except Exception:
        return False


# ============================================================================
# LINUX IMPLEMENTATIONS
# ============================================================================

def _init_linux_notifications():
    """Initialize Linux notification system"""
    try:
        import notify2
        notify2.init("Time Tracker")
        return True
    except ImportError:
        logger.warning("notify2 not available - trying plyer")
        try:
            from plyer import notification
            return True
        except ImportError:
            logger.warning("No notification library available")
            return False

def _init_linux_window_tracking():
    """Initialize Linux window tracking"""
    # Check if running on X11 or Wayland
    session_type = os.environ.get('XDG_SESSION_TYPE', 'x11').lower()
    
    if session_type == 'x11':
        try:
            from Xlib import display
            return True
        except ImportError:
            logger.warning("python-xlib not available - window tracking disabled")
            return False
    elif session_type == 'wayland':
        logger.warning("Wayland window tracking not yet implemented")
        # TODO: Implement Wayland support using pydbus
        return False
    else:
        logger.warning(f"Unknown session type: {session_type}")
        return False

def _get_active_window_linux():
    """Get active window on Linux"""
    session_type = os.environ.get('XDG_SESSION_TYPE', 'x11').lower()
    
    if session_type == 'x11':
        return _get_active_window_linux_x11()
    elif session_type == 'wayland':
        # Wayland doesn't allow arbitrary window access for security
        # Fall back to monitoring own app's focus
        logger.debug("Wayland window tracking not available")
        return None
    return None

def _get_active_window_linux_x11():
    """Get active window on Linux X11"""
    try:
        from Xlib import display, X, error
        import psutil
        
        d = display.Display()
        root = d.screen().root
        
        # Get active window
        NET_ACTIVE_WINDOW = d.intern_atom('_NET_ACTIVE_WINDOW')
        active = root.get_full_property(NET_ACTIVE_WINDOW, X.AnyPropertyType)
        
        if not active or not active.value:
            return None
        
        window_id = active.value[0]
        window = d.create_resource_object('window', window_id)
        
        # Get window title
        title = ''
        try:
            NET_WM_NAME = d.intern_atom('_NET_WM_NAME')
            WM_NAME = d.intern_atom('WM_NAME')
            
            # Try _NET_WM_NAME first (UTF-8)
            prop = window.get_full_property(NET_WM_NAME, 0)
            if prop:
                title = prop.value
                if isinstance(title, bytes):
                    title = title.decode('utf-8', errors='ignore')
            else:
                # Fallback to WM_NAME
                prop = window.get_full_property(WM_NAME, 0)
                if prop:
                    title = prop.value
                    if isinstance(title, bytes):
                        title = title.decode('latin1', errors='ignore')
        except Exception:
            pass
        
        # Get PID
        pid = None
        app_name = 'Unknown'
        try:
            NET_WM_PID = d.intern_atom('_NET_WM_PID')
            prop = window.get_full_property(NET_WM_PID, 0)
            if prop:
                pid = prop.value[0]
                # Get process name
                proc = psutil.Process(pid)
                app_name = proc.name()
        except Exception:
            pass
        
        return {
            'title': title or '',
            'app': app_name,
            'pid': pid
        }
        
    except Exception as e:
        logger.debug(f"Could not get active window: {e}")
        return None

def _show_notification_linux(title, message, duration):
    """Show notification on Linux"""
    # Try notify2 first (native libnotify)
    try:
        import notify2
        
        if not notify2.is_initted():
            notify2.init("Time Tracker")
        
        n = notify2.Notification(title, message)
        n.set_urgency(notify2.URGENCY_NORMAL)
        n.set_timeout(5000 if duration == 'short' else 10000)
        n.show()
        return
    except Exception as e:
        logger.debug(f"notify2 failed: {e}")
    
    # Fallback to plyer
    try:
        from plyer import notification
        
        notification.notify(
            title=title,
            message=message,
            app_name='Time Tracker',
            timeout=5 if duration == 'short' else 10
        )
        return
    except Exception as e:
        logger.debug(f"plyer failed: {e}")
    
    # Fallback to command-line notify-send
    try:
        import subprocess
        subprocess.run(
            ['notify-send', title, message],
            check=False,
            timeout=1
        )
    except Exception as e:
        logger.debug(f"notify-send failed: {e}")

def _acquire_lock_linux():
    """Acquire single instance lock on Linux using fcntl"""
    import fcntl
    
    lock_file = os.path.join(get_app_data_dir(), '.lock')
    
    try:
        # Open lock file
        lock_fd = open(lock_file, 'w')
        
        # Try to acquire exclusive lock (non-blocking)
        fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        
        # Write PID
        lock_fd.write(str(os.getpid()))
        lock_fd.flush()
        
        # Keep file descriptor open globally
        # (lock is released when closed/process exits)
        globals()['_lock_fd'] = lock_fd
        
        return True
    except IOError:
        # Lock already held by another process
        logger.warning("Another instance is already running")
        return False

def _is_screen_locked_linux():
    """Check if screen is locked on Linux"""
    # Try multiple methods (systemd-logind, gnome-screensaver, etc.)
    
    # Method 1: systemd-logind (most common on modern Linux)
    try:
        import subprocess
        result = subprocess.run(
            ['loginctl', 'show-session', 'self', '--property=LockedHint'],
            capture_output=True,
            text=True,
            timeout=1
        )
        if result.returncode == 0:
            output = result.stdout.strip()
            # LockedHint=yes means locked
            return 'LockedHint=yes' in output
    except Exception:
        pass
    
    # Method 2: Check for lock screen processes
    try:
        import psutil
        lock_processes = [
            'gnome-screensaver',
            'xscreensaver',
            'xflock4',
            'i3lock',
            'slimlock',
            'slock'
        ]
        for proc in psutil.process_iter(['name']):
            if proc.info['name'] in lock_processes:
                return True
    except Exception:
        pass
    
    # Unable to determine - assume unlocked
    return False


# ============================================================================
# MACOS IMPLEMENTATIONS (Future)
# ============================================================================

def _init_macos_notifications():
    """Initialize macOS notification system"""
    # TODO: Implement using pync or pyobjc
    logger.warning("macOS notifications not yet implemented")
    return False

def _init_macos_window_tracking():
    """Initialize macOS window tracking"""
    # TODO: Implement using Quartz/PyObjC
    logger.warning("macOS window tracking not yet implemented")
    return False

def _get_active_window_macos():
    """Get active window on macOS"""
    # TODO: Implement
    return None

def _show_notification_macos(title, message, duration):
    """Show notification on macOS"""
    # TODO: Implement
    pass

def _acquire_lock_macos():
    """Acquire single instance lock on macOS"""
    # Use file-based lock (same as Linux)
    return _acquire_lock_linux()

def _is_screen_locked_macos():
    """Check if screen is locked on macOS"""
    # TODO: Implement using Quartz
    return False


# ============================================================================
# COMMON IMPLEMENTATIONS
# ============================================================================

def _acquire_lock_file():
    """Fallback file-based lock (cross-platform)"""
    import os
    import psutil
    
    lock_file = os.path.join(get_app_data_dir(), '.lock')
    
    try:
        # Check if lock file exists
        if os.path.exists(lock_file):
            with open(lock_file, 'r') as f:
                pid = int(f.read().strip())
            
            # Check if process is still running
            if psutil.pid_exists(pid):
                try:
                    proc = psutil.Process(pid)
                    if 'timetracker' in proc.name().lower() or 'python' in proc.name().lower():
                        logger.warning(f"Another instance is running (PID: {pid})")
                        return False
                except (psutil.NoSuchProcess, psutil.AccessDenied):
                    pass
        
        # Write our PID
        with open(lock_file, 'w') as f:
            f.write(str(os.getpid()))
        
        return True
    except Exception as e:
        logger.warning(f"Lock file error: {e}")
        return True  # Allow running if we can't check


def get_app_data_dir():
    """Get platform-specific application data directory"""
    if IS_WINDOWS:
        app_data = os.environ.get('LOCALAPPDATA', os.path.expanduser('~'))
        app_dir = os.path.join(app_data, 'TimeTracker')
    elif IS_LINUX:
        # Follow XDG Base Directory Specification
        xdg_data_home = os.environ.get('XDG_DATA_HOME')
        if xdg_data_home:
            app_dir = os.path.join(xdg_data_home, 'timetracker')
        else:
            app_dir = os.path.expanduser('~/.local/share/timetracker')
    elif IS_MACOS:
        app_dir = os.path.expanduser('~/Library/Application Support/TimeTracker')
    else:
        app_dir = os.path.expanduser('~/.timetracker')
    
    # Create directory if it doesn't exist
    os.makedirs(app_dir, exist_ok=True)
    
    return app_dir
```

#### 1.2 Update `desktop_app.py` to use platform abstraction

**Changes needed:**

1. Replace Windows-specific imports with platform abstraction
2. Replace direct win32/winotify calls with PlatformUtils calls
3. Add platform detection to update check API

**Example changes:**

```python
# OLD (Windows-specific)
import win32gui
import win32process
from winotify import Notification, audio

# NEW (platform-agnostic)
from platform_utils import PlatformUtils, IS_WINDOWS, IS_LINUX, IS_MACOS

# At startup
PlatformUtils.init()

# When getting active window
# OLD
hwnd = win32gui.GetForegroundWindow()
title = win32gui.GetWindowText(hwnd)

# NEW
window_info = PlatformUtils.get_active_window()
if window_info:
    title = window_info['title']
    app = window_info['app']

# When showing notifications
# OLD
notification = Notification(...)
notification.show()

# NEW
PlatformUtils.show_notification(title, message, duration)

# Single instance check
# OLD
if not acquire_single_instance_lock():
    sys.exit(1)

# NEW
if not PlatformUtils.acquire_single_instance_lock():
    sys.exit(1)
```

### Phase 2: Update Build System (Week 1)

#### 2.1 Create Linux build script

Create new file: `python-desktop-app/build.sh`

```bash
#!/bin/bash
# ============================================================================
# Time Tracker - Build Script for Linux
# Creates a standalone executable with embedded credentials
# No .env file needed for distribution - credentials are embedded in code
# ============================================================================

set -e  # Exit on error

echo ""
echo "============================================"
echo "  Time Tracker - Build Script (Linux)"
echo "============================================"
echo ""
echo "NOTE: Credentials are embedded in desktop_app.py"
echo "      No .env file needed for distribution!"
echo ""

# Check if we're in the right directory
if [ ! -f "desktop_app.py" ]; then
    echo "[ERROR] desktop_app.py not found"
    echo "Please run this script from the python-desktop-app directory"
    exit 1
fi

# Detect Python command (python3 or python)
PYTHON_CMD="python3"
if ! command -v python3 &> /dev/null; then
    if command -v python &> /dev/null; then
        PYTHON_CMD="python"
    else
        echo "[ERROR] Python is not available"
        echo "Please ensure Python 3.8+ is installed"
        exit 1
    fi
fi

echo "[INFO] Using Python: $PYTHON_CMD"
$PYTHON_CMD --version

# Check for virtual environment
if [ -d ".venv" ]; then
    echo "[INFO] Activating virtual environment .venv..."
    source .venv/bin/activate
elif [ -d "venv" ]; then
    echo "[INFO] Activating virtual environment venv..."
    source venv/bin/activate
else
    echo "[INFO] No virtual environment found, using system Python"
fi

# Check if PyInstaller is available
if ! $PYTHON_CMD -c "import PyInstaller" 2>/dev/null; then
    echo "[ERROR] PyInstaller is not installed"
    echo "Installing PyInstaller..."
    pip install pyinstaller>=6.2.0
fi

# Clean previous build
echo ""
echo "[1/4] Cleaning previous build..."
rm -rf build/
rm -rf dist/
rm -f *.spec.backup

# Validate configuration embed
echo ""
echo "[2/4] Validating embedded configuration..."
$PYTHON_CMD -c "
import sys
sys.path.insert(0, '.')
from desktop_app import EMBEDDED_CONFIG, APP_VERSION
print(f'  APP_VERSION: {APP_VERSION}')
print(f'  AI_SERVER_URL: {EMBEDDED_CONFIG.get(\"AI_SERVER_URL\", \"NOT SET\")}')
if not EMBEDDED_CONFIG.get('ATLASSIAN_CLIENT_ID'):
    print('[ERROR] ATLASSIAN_CLIENT_ID not set in EMBEDDED_CONFIG')
    sys.exit(1)
print('  ✓ Configuration valid')
"

if [ $? -ne 0 ]; then
    echo "[ERROR] Configuration validation failed"
    exit 1
fi

# Build with PyInstaller
echo ""
echo "[3/4] Building executable with PyInstaller..."
echo "      This may take 5-10 minutes..."
echo ""

pyinstaller desktop_app.spec 2>&1 | tee build_log.txt

# Check if build was successful
if [ ! -f "dist/TimeTracker" ]; then
    echo ""
    echo "[ERROR] Build failed - executable not created"
    echo "Check build_log.txt for details"
    exit 1
fi

# Get file size
FILE_SIZE=$(du -h "dist/TimeTracker" | cut -f1)

echo ""
echo "============================================"
echo "  Build Complete!"
echo "============================================"
echo ""
echo "  Executable: dist/TimeTracker"
echo "  Size: $FILE_SIZE"
echo ""
echo "Next steps:"
echo "  1. Test the build: ./dist/TimeTracker"
echo "  2. Create installer package (see packaging instructions)"
echo ""
```

**Make it executable:**
```bash
chmod +x build.sh
```

#### 2.2 Update `desktop_app.spec` for Linux

Add platform detection at the top:

```python
import sys

# Platform-specific configuration
IS_WINDOWS = sys.platform == 'win32'
IS_LINUX = sys.platform.startswith('linux')
IS_MACOS = sys.platform == 'darwin'

# Platform-specific dependencies
platform_hiddenimports = []
platform_binaries = []
platform_excludes = []

if IS_WINDOWS:
    # Windows-specific
    platform_hiddenimports += ['win32gui', 'win32process', 'win32con', 
                                'win32event', 'win32api', 'winotify']
elif IS_LINUX:
    # Linux-specific
    platform_hiddenimports += ['notify2', 'Xlib', 'Xlib.display', 
                                'Xlib.X', 'Xlib.error']
    platform_excludes += ['pywin32', 'win32gui', 'win32process', 
                          'win32con', 'win32event', 'win32api', 'winotify']
elif IS_MACOS:
    # macOS-specific (future)
    pass
```

Update the `a = Analysis()` section:

```python
a = Analysis(
    ['desktop_app.py'],
    pathex=[],
    binaries=engine_binaries + platform_binaries,
    datas=ocr_datas + auth_datas + privacy_datas + platform_datas,
    hiddenimports=base_hiddenimports + engine_hiddenimports + platform_hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=base_excludes + engine_excludes + platform_excludes,
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)
```

Update EXE options for Linux:

```python
exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='TimeTracker',  # No .exe extension on Linux
    debug=False,
    bootloader_ignore_signals=False,
    strip=not IS_WINDOWS,  # Strip symbols on Linux for smaller size
    upx=True,  # Compress with UPX if available
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,  # No console window
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    # Windows-specific options
    icon='icon.ico' if IS_WINDOWS else None,
    version='version_info.txt' if IS_WINDOWS else None,
)
```

### Phase 3: Update Dependencies (Week 1)

#### 3.1 Update `requirements.txt`

```txt
# =============================================================================
# JIRAForge Desktop App - Python Dependencies
# =============================================================================
# Platform support: Windows, Linux, macOS (Intel & Apple Silicon)
# =============================================================================

# Core application dependencies
flask==3.0.0
flask-cors==4.0.0
supabase==2.0.0
pystray==0.19.5
Pillow==10.1.0
psutil==5.9.6
requests==2.31.0
python-dotenv==1.0.0
cryptography==41.0.7
pyinstaller==6.2.0
pynput==1.7.6
keyring==25.2.1
tzlocal>=5.0
jaraco.text>=4.0.0
jaraco.functools>=4.0.0
jaraco.context>=6.0.0

# Platform-specific dependencies
# Windows
pywin32==306; sys_platform == 'win32'
winotify==1.1.0; sys_platform == 'win32'
sqlcipher3-wheels>=0.5.0; sys_platform == 'win32'

# Linux
python-xlib>=0.33; sys_platform == 'linux'
notify2>=0.3; sys_platform == 'linux'
pysqlcipher3>=1.1.0; sys_platform == 'linux'
dbus-python>=1.3.2; sys_platform == 'linux'

# macOS (future)
# pync>=2.0.3; sys_platform == 'darwin'

# Cross-platform notification fallback
plyer>=2.1.0

# =============================================================================
# OCR Dependencies
# =============================================================================
# RapidOCR - Primary OCR engine (works on all platforms)
rapidocr_onnxruntime

# WinRTocr - Windows built-in OCR (Windows only)
winrtocr; sys_platform == 'win32'

# Image processing (cross-platform)
numpy==1.26.4
opencv-python==4.10.0.84

# =============================================================================
# Privacy & Security Dependencies
# =============================================================================
presidio-analyzer>=2.2.0
presidio-anonymizer>=2.2.0

# =============================================================================
# Optional OCR Engines (not included by default)
# =============================================================================
# Tesseract - System binary required
# pip install pytesseract>=0.3.10
#
# EasyOCR - Large download (~500MB)
# pip install torch>=2.0.0 torchvision>=0.15.0 easyocr>=1.7.0
```

#### 3.2 Create Linux system dependencies guide

Create new file: `python-desktop-app/LINUX_DEPENDENCIES.md`

```markdown
# Linux System Dependencies

This document lists the system-level dependencies required for the Time Tracker desktop app on Linux.

## Core Dependencies

### Ubuntu/Debian
```bash
sudo apt-get update
sudo apt-get install -y \\
    python3 \\
    python3-pip \\
    python3-tk \\
    libxlib xcb \\
    libnotify-dev \\
    libsqlcipher-dev \\
    libdbus-1-dev \\
    libgirepository1.0-dev \\
    gobject-introspection \\
    gir1.2-gtk-3.0
```

### Fedora/RHEL
```bash
sudo dnf install -y \\
    python3 \\
    python3-pip \\
    python3-tkinter \\
    libX11-devel \\
    libnotify-devel \\
    sqlcipher-devel \\
    dbus-devel \\
    gobject-introspection-devel
```

### Arch Linux
```bash
sudo pacman -S --noconfirm \\
    python \\
    python-pip \\
    tk \\
    libx11 \\
    libnotify \\
    sqlcipher \\
    dbus \\
    gobject-introspection
```

## Optional OCR Dependencies

### Tesseract OCR (Recommended for fallback)

**Ubuntu/Debian:**
```bash
sudo apt-get install -y tesseract-ocr tesseract-ocr-eng
pip install pytesseract>=0.3.10
```

**Fedora:**
```bash
sudo dnf install -y tesseract tesseract-langpack-eng
pip install pytesseract>=0.3.10
```

**Arch:**
```bash
sudo pacman -S tesseract tesseract-data-eng
pip install pytesseract>=0.3.10
```

### EasyOCR (Optional - Large Download)

```bash
pip install torch>=2.0.0 torchvision>=0.15.0 easyocr>=1.7.0
```

**Note:** EasyOCR downloads ~500MB of models on first use.

## Runtime Requirements

- **Python:** 3.8 or higher
- **Display Server:** X11 or Wayland (X11 recommended for window tracking)
- **Desktop Environment:** Any (GNOME, KDE, XFCE, etc.)
- **Notification Daemon:** Any freedesktop.org-compliant notification daemon

## Verification

After installing systems dependencies, verify they're available:

```bash
# Check Python
python3 --version

# Check X11 libraries
python3 -c "from Xlib import display; print('X11: OK')"

# Check notifications
python3 -c "import notify2; print('notify2: OK')"

# Check SQLCipher
python3 -c "import pysqlcipher3; print('SQLCipher: OK')"

# Check D-Bus
python3 -c "import dbus; print('D-Bus: OK')"
```

## Troubleshooting

### X11 not available
If you're on Wayland, window tracking may be limited. Consider switching to X11:
```bash
# Log out and select "Ubuntu on Xorg" (or similar) from login screen
```

### Notification daemon not running
```bash
# Check if notification daemon is running
ps aux | grep notification-daemon

# If not, your desktop environment should have one
# GNOME: Built-in
# KDE: Built-in
# XFCE: xfce4-notifyd
# Others: dunst, mako, etc.
```

### Permission issues with keyring
```bash
# Ensure gnome-keyring or similar is running
# This is usually automatic in modern desktop environments
```
```

### Phase 4: Testing & Validation (Week 2)

#### 4.1 Create Linux test script

Create new file: `python-desktop-app/test_linux_compatibility.py`

```python
"""
Linux Compatibility Test Suite

Tests all platform-specific functionality on Linux systems.
Run this before creating a release build.
"""

import sys
import os
import subprocess
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

def test_python_version():
    """Test Python version (3.8+)"""
    logger.info("Testing Python version...")
    version = sys.version_info
    if version.major >= 3 and version.minor >= 8:
        logger.info(f"  ✓ Python {version.major}.{version.minor}.{version.micro}")
        return True
    else:
        logger.error(f"  ✗ Python {version.major}.{version.minor} (requires 3.8+)")
        return False

def test_system_dependencies():
    """Test system dependencies"""
    logger.info("Testing system dependencies...")
    
    dependencies = {
        'X11': 'from Xlib import display',
        'notify2': 'import notify2',
        'dbus': 'import dbus',
        'pysqlcipher3': 'import pysqlcipher3',
    }
    
    all_ok = True
    for name, import_cmd in dependencies.items():
        try:
            exec(import_cmd)
            logger.info(f"  ✓ {name}")
        except ImportError:
            logger.error(f"  ✗ {name} - not installed")
            all_ok = False
    
    return all_ok

def test_ocr_engines():
    """Test OCR engine availability"""
    logger.info("Testing OCR engines...")
    
    sys.path.insert(0, '.')
    from ocr.engine_factory import EngineFactory
    from ocr.config import get_platform_compatible_engines
    
    compatible_engines = get_platform_compatible_engines()
    logger.info(f"  Compatible engines for Linux: {compatible_engines}")
    
    all_ok = True
    for engine_name in compatible_engines:
        try:
            engine = EngineFactory.create(engine_name)
            is_available = engine.is_available()
            if is_available:
                logger.info(f"  ✓ {engine_name} - available")
            else:
                logger.warning(f"  ⚠ {engine_name} - not available (OK if fallback)")
        except Exception as e:
            logger.error(f"  ✗ {engine_name} - error: {e}")
            all_ok = False
    
    # Ensure at least one engine is available
    if not any(EngineFactory.create(e).is_available() for e in compatible_engines[:2]):
        logger.error("  ✗ No OCR engines available")
        all_ok = False
    
    return all_ok

def test_platform_utils():
    """Test platform abstraction layer"""
    logger.info("Testing platform utilities...")
    
    sys.path.insert(0, '.')
    from platform_utils import PlatformUtils
    
    # Initialize
    PlatformUtils.init()
    
    # Test window tracking
    window = PlatformUtils.get_active_window()
    if window:
        logger.info(f"  ✓ Window tracking: {window['title'][:50]}")
    else:
        logger.warning("  ⚠ Window tracking unavailable (may need X11)")
    
    # Test notifications
    try:
        PlatformUtils.show_notification(
            "Time Tracker Test",
            "Testing Linux notifications",
            duration='short'
        )
        logger.info("  ✓ Notifications working")
    except Exception as e:
        logger.error(f"  ✗ Notifications failed: {e}")
        return False
    
    # Test data directory
    data_dir = PlatformUtils.get_app_data_dir()
    if os.path.exists(data_dir):
        logger.info(f"  ✓ Data directory: {data_dir}")
    else:
        logger.error(f"  ✗ Data directory not created: {data_dir}")
        return False
    
    return True

def test_build_system():
    """Test build system"""
    logger.info("Testing build system...")
    
    # Check if build.sh exists and is executable
    if not os.path.exists('build.sh'):
        logger.error("  ✗ build.sh not found")
        return False
    
    if not os.access('build.sh', os.X_OK):
        logger.warning("  ⚠ build.sh not executable (run: chmod +x build.sh)")
    else:
        logger.info("  ✓ build.sh ready")
    
    # Check desktop_app.spec
    if not os.path.exists('desktop_app.spec'):
        logger.error("  ✗ desktop_app.spec not found")
        return False
    logger.info("  ✓ desktop_app.spec found")
    
    return True

def main():
    """Run all tests"""
    logger.info("=" * 60)
    logger.info("Linux Compatibility Test Suite")
    logger.info("=" * 60)
    logger.info("")
    
    tests = [
        ("Python Version", test_python_version),
        ("System Dependencies", test_system_dependencies),
        ("OCR Engines", test_ocr_engines),
        ("Platform Utilities", test_platform_utils),
        ("Build System", test_build_system),
    ]
    
    results = {}
    for name, test_func in tests:
        logger.info("")
        try:
            results[name] = test_func()
        except Exception as e:
            logger.error(f"  ✗ Test crashed: {e}")
            results[name] = False
    
    # Summary
    logger.info("")
    logger.info("=" * 60)
    logger.info("Test Summary")
    logger.info("=" * 60)
    
    all_passed = True
    for name, passed in results.items():
        status = "✓ PASS" if passed else "✗ FAIL"
        logger.info(f"  {status}: {name}")
        if not passed:
            all_passed = False
    
    logger.info("")
    if all_passed:
        logger.info("✓ All tests passed! Ready for Linux build.")
        return 0
    else:
        logger.error("✗ Some tests failed. Fix issues before building.")
        return 1

if __name__ == '__main__':
    sys.exit(main())
```

**Make it executable:**
```bash
chmod +x test_linux_compatibility.py
```

---

## 5. File Changes Required

### Summary of Files to Create

| File | Purpose |
|------|---------|
| `platform_utils.py` | Platform abstraction layer |
| `build.sh` | Linux build script |
| `LINUX_DEPENDENCIES.md` | System dependency guide |
| `test_linux_compatibility.py` | Linux compatibility test suite |

### Summary of Files to Modify

| File | Changes |
|------|---------|
| `desktop_app.py` | Replace Windows-specific code with platform abstraction |
| `desktop_app.spec` | Add Linux-specific configuration |
| `requirements.txt` | Add Linux dependencies |
| `ocr/config.py` | Add platform filtering functions |
| `ocr/facade.py` | Apply platform filters during initialization |

### Detailed Change List for `desktop_app.py`

**Section 1: Imports (Lines 250-280)**
```python
# REPLACE Windows-specific imports
# OLD:
try:
    import win32gui
    import win32process
    import win32con
    import win32event
    import winerror
    import win32api
    WIN32_AVAILABLE = True
except ImportError:
    WIN32_AVAILABLE = False

try:
    from winotify import Notification, audio
    WINOTIFY_AVAILABLE = True
except ImportError:
    WINOTIFY_AVAILABLE = False

# NEW:
from platform_utils import (
    PlatformUtils,
    IS_WINDOWS,
    IS_LINUX,
    IS_MACOS,
    NOTIFICATIONS_AVAILABLE,
    WINDOW_TRACKING_AVAILABLE
)

# Initialize platform-specific functionality
PlatformUtils.init()
```

**Section 2: Single Instance Lock (Lines 285-320)**
```python
# REPLACE
# OLD:
def acquire_single_instance_lock():
    global _instance_mutex
    if not WIN32_AVAILABLE:
        return _acquire_lock_file()
    # ... Windows mutex code ...

# NEW:
def acquire_single_instance_lock():
    """Acquire single instance lock (cross-platform)"""
    return PlatformUtils.acquire_single_instance_lock()
```

**Section 3: Notifications (Lines 730-780)**
```python
# REPLACE all show_notification calls
# OLD:
if WINOTIFY_AVAILABLE:
    notification = Notification(...)
    notification.show()

# NEW:
if NOTIFICATIONS_AVAILABLE:
    PlatformUtils.show_notification(title, message, duration)
```

**Section 4: Window Tracking (Lines 9880-9920)**
```python
# REPLACE
# OLD:
if not WIN32_AVAILABLE:
    return None
hwnd = win32gui.GetForegroundWindow()
title = win32gui.GetWindowText(hwnd)
_, pid = win32process.GetWindowThreadProcessId(hwnd)

# NEW:
window_info = PlatformUtils.get_active_window()
if not window_info:
    return None
title = window_info['title']
app = window_info['app']
pid = window_info['pid']
```

**Section 5: Update Check (Lines 605-615)**
```python
# MODIFY to include platform parameter
# OLD:
url = f"{server_url}/api/app-version/check?platform=windows&current={APP_VERSION}"

# NEW:
platform_name = PlatformUtils.get_platform_name()
url = f"{server_url}/api/app-version/check?platform={platform_name}&current={APP_VERSION}"
```

**Section 6: Data Directory (Lines 830-845)**
```python
# REPLACE
# OLD:
def get_app_data_dir():
    if sys.platform == 'win32':
        app_data = os.environ.get('LOCALAPPDATA', os.path.expanduser('~'))
    else:
        app_data = os.path.expanduser('~/.local/share')
    app_dir = os.path.join(app_data, 'TimeTracker')
    # ...

# NEW:
def get_app_data_dir():
    """Get platform-specific application data directory"""
    from platform_utils import get_app_data_dir as get_platform_data_dir
    return get_platform_data_dir()
```

---

##6. Build and Packaging

### 6.1 Build Process

**Development Build (Testing):**
```bash
# Install dependencies
pip install -r requirements.txt

# Install Linux system dependencies
# See LINUX_DEPENDENCIES.md for your distribution

# Run compatibility tests
python3 test_linux_compatibility.py

# Build executable
chmod +x build.sh
./build.sh

# Test the build
./dist/TimeTracker
```

### 6.2 Packaging Options

#### Option A: .deb Package (Recommended for Debian/Ubuntu)

Create `packaging/debian/` structure:

```
packaging/debian/
├── DEBIAN/
│   ├── control
│   ├── postinst
│   └── prerm
├── opt/
│   └── timetracker/
│       └── TimeTracker (executable)
├── usr/
│   ├── share/
│   │   ├── applications/
│   │   │   └── timetracker.desktop
│   │   └── icons/
│   │       └── hicolor/
│   │           └── 256x256/
│   │               └── apps/
│   │                   └── timetracker.png
│   └── bin/
│       └── timetracker (symlink)
```

**control file:**
```
Package: timetracker
Version: 1.4.6
Section: utils
Priority: optional
Architecture: amd64
Depends: python3 (>= 3.8), libnotify4, libx11-6, libsqlcipher0
Maintainer: JIRAForge <support@jiraforge.com>
Description: JIRAForge Time Tracker Desktop App
 Automatic time tracking for JIRA with OCR-based task detection
```

**Build .deb:**
```bash
# Create package structure
mkdir -p packaging/debian/opt/timetracker
mkdir -p packaging/debian/usr/bin
mkdir -p packaging/debian/usr/share/applications
mkdir -p packaging/debian/usr/share/icons/hicolor/256x256/apps
mkdir -p packaging/debian/DEBIAN

# Copy executable
cp dist/TimeTracker packaging/debian/opt/timetracker/

# Create symlink
ln -s /opt/timetracker/TimeTracker packaging/debian/usr/bin/timetracker

# Create desktop entry
cat > packaging/debian/usr/share/applications/timetracker.desktop << EOF
[Desktop Entry]
Type=Application
Name=Time Tracker
Comment=Automatic time tracking for JIRA
Exec=/opt/timetracker/TimeTracker
Icon=timetracker
Terminal=false
Categories=Utility;Office;
EOF

# Build deb package
dpkg-deb --build packaging/debian timetracker_1.4.6_amd64.deb
```

#### Option B: AppImage (Universal Linux Package)

**Uses `appimagetool` to create self-contained package:**

```bash
# Install appimagetool
wget https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage
chmod +x appimagetool-x86_64.AppImage

# Create AppDir structure
mkdir -p TimeTracker.AppDir/usr/bin
mkdir -p TimeTracker.AppDir/usr/share/applications
mkdir -p TimeTracker.AppDir/usr/share/icons/hicolor/256x256/apps

# Copy files
cp dist/TimeTracker TimeTracker.AppDir/usr/bin/
cp timetracker.desktop TimeTracker.AppDir/
cp timetracker.png TimeTracker.AppDir/
cp timetracker.png TimeTracker.AppDir/usr/share/icons/hicolor/256x256/apps/

# Create AppRun script
cat > TimeTracker.AppDir/AppRun << 'EOF'
#!/bin/bash
SELF=$(readlink -f "$0")
HERE=${SELF%/*}
export PATH="${HERE}/usr/bin:${PATH}"
export LD_LIBRARY_PATH="${HERE}/usr/lib:${LD_LIBRARY_PATH}"
exec "${HERE}/usr/bin/TimeTracker" "$@"
EOF
chmod +x TimeTracker.AppDir/AppRun

# Build AppImage
./appimagetool-x86_64.AppImage TimeTracker.AppDir TimeTracker-1.4.6-x86_64.AppImage
```

#### Option C: Snap Package (Universal, Sandboxed)

Create `snap/snapcraft.yaml`:

```yaml
name: timetracker
version: '1.4.6'
summary: Automatic time tracking for JIRA
description: |
  JIRAForge Time Tracker automatically tracks your work time
  and matches screenshots to JIRA issues using OCR.

grade: stable
confinement: strict
base: core22

apps:
  timetracker:
    command: bin/TimeTracker
    plugs:
      - desktop
      - desktop-legacy
      - x11
      - wayland
      - network
      - home

parts:
  timetracker:
    plugin: dump
    source: dist/
    stage-packages:
      - libnotify4
      - libx11-6
      - libsqlcipher0
```

**Build snap:**
```bash
snapcraft
```

### 6.3 Recommended Distribution Strategy

**For maximum compatibility:**

1. **Primary:** `.deb` package for Ubuntu/Debian users (largest user base)
2. **Secondary:** AppImage for universal compatibility (works everywhere)
3. **Optional:** Snap for users who prefer sandboxed apps

---

## 7. Testing Strategy

### 7.1 Test Environments

**Minimum test coverage:**

| Distribution | Version | DE | Session Type |
|--------------|---------|----|----|
| Ubuntu | 22.04 LTS | GNOME | Wayland & X11 |
| Ubuntu | 24.04 LTS | GNOME | Wayland & X11 |
| Debian | 12 (Bookworm) | GNOME | X11 |
| Fedora | 39 | GNOME | Wayland |
| Linux Mint | 21 | Cinnamon | X11 |

### 7.2 Test Checklist

**Phase 1: Basic Functionality**
- [ ] App launches without errors
- [ ] Authentication works (Atlassian OAuth)
- [ ] System tray icon appears
- [ ] Notifications appear
- [ ] Settings can be changed
- [ ] App can be closed/reopened

**Phase 2: Activity Tracking**
- [ ] Window titles are captured correctly
- [ ] Screenshots are taken
- [ ] OCR extracts text from screenshots
- [ ] Tasks are matched to JIRA issues
- [ ] Time is logged correctly
- [ ] Data syncs to Supabase

**Phase 3: OCR Functionality**
- [ ] RapidOCR works (primary engine)
- [ ] Tesseract works (fallback)
- [ ] WinRTOCR is skipped on Linux (no errors)
- [ ] OCR confidence scores are reasonable
- [ ] Privacy filter redacts sensitive data

**Phase 4: Edge Cases**
- [ ] Survives screen lock/unlock
- [ ] Handles network disconnection gracefully
- [ ] Single instance enforcement works
- [ ] Data persists across restarts
- [ ] Handles display server changes (X11<->Wayland)

### 7.3 Automated Testing

**Run test suite:**
```bash
# Unit tests
python3 -m pytest tests/

# Integration tests
python3 -m pytest tests/integration/

# Linux compatibility tests
python3 test_linux_compatibility.py

# OCR engine tests
python3 -m pytest tests/test_ocr_engines.py -v
```

---

## 8. Deployment Strategy

### 8.1 Release Process

**Step 1: Version Bump**
- Update `APP_VERSION` in `desktop_app.py`
- Update version in package control files
- Create release notes

**Step 2: Build for All Platforms**
```bash
# Windows build (on Windows machine)
cd python-desktop-app
build.bat

# Linux build (on Linux machine)
cd python-desktop-app
./build.sh

# Create packages
./create_deb_package.sh
./create_appimage.sh
```

**Step 3: Upload to Distribution Server**
- Upload to AI server's download endpoint
- Update version manifest
- Update checksums

**Step 4: Test Auto-Update**
- Test update mechanism on both platforms
- Verify checksum validation
- Verify rollback on failure

### 8.2 Distribution Channels

**Primary:**
- AI Server download endpoint: `https://forgesync.amzur.com/downloads/`
- Auto-update mechanism (for existing users)

**Secondary:**
- GitHub Releases (for manual download)
- Linux package repositories (future: apt/yum/snap store)

### 8.3 Rollout Strategy

**Phase 1: Beta Testing (Week 1-2)**
- Internal testing team (5-10 users)
- Mix of Linux distributions
- Collect logs and feedback

**Phase 2: Early Adopters (Week 3-4)**
- Opt-in beta program (50-100 users)
- Monitor error rates
- Fix critical issues

**Phase 3: General Release (Week 5+)**
- Gradual rollout (10% → 25% → 50% → 100%)
- Monitor metrics:
  - Installation success rate
  - OCR engine selection
  - Crash/error rates
  - Performance metrics

---

## 9. Monitoring & Metrics

### 9.1 Key Metrics to Track

**Installation:**
- Total Linux installations
- Distribution breakdown (Ubuntu/Fedora/Arch/etc.)
- Installation success rate
- Update success rate

**OCR Engine Usage:**
- % using RapidOCR
- % falling back to Tesseract
- % with no OCR available
- Average OCR confidence scores

**Performance:**
- App startup time
- Memory usage
- CPU usage
- OCR processing time

**Errors:**
- Platform-specific errors
- OCR failures
- Network errors
- Authentication failures

### 9.2 Logging

**Add platform info to logs:**
```python
import platform
import logging

logger = logging.getLogger(__name__)

# Log platform info at startup
logger.info(f"Platform: {platform.system()} {platform.release()}")
logger.info(f"Distribution: {platform.freedesktop_os_release()}")
logger.info(f"Session Type: {os.environ.get('XDG_SESSION_TYPE', 'unknown')}")
logger.info(f"Desktop Environment: {os.environ.get('XDG_CURRENT_DESKTOP', 'unknown')}")
```

---

## 10. Future Enhancements

### 10.1 Wayland Support

**Current limitation:** Window tracking requires X11

**Future work:**
- Implement Wayland protocol extensions
- Use D-Bus for GNOME Shell extensions
- Document limitations for users

### 10.2 Flatpak Support

**Benefits:**
- Sandboxed environment
- Automatic updates via Flathub
- Wide compatibility

**Challenges:**
- Sandbox restrictions (window access, notifications)
- Portal API integration needed

### 10.3 macOS Support

**Similar approach to Linux:**
- Use PyObjC for native APIs
- Cocoa for window management
- NSUserNotificationCenter for notifications
- Keychain for secure storage

---

## 11. Documentation Updates Required

### 11.1 User Documentation

Create/update:
- `README_LINUX.md` - Linux-specific installation guide
- `TROUBLESHOOTING_LINUX.md` - Common Linux issues
- Update main `README.md` with Linux support announcement

### 11.2 Developer Documentation

Create/update:
- `CONTRIBUTING_LINUX.md` - Linux development setup
- `ARCHITECTURE_LINUX.md` - Linux-specific architecture notes
- API documentation for platform abstraction layer

---

## 12. Success Criteria

### 12.1 Must Have (Blocking Release)

- ✅ App launches and runs on Ubuntu 22.04 LTS
- ✅ Authentication works
- ✅ Activity tracking works
- ✅ OCR engine fallback works (no WinRTOCR errors)
- ✅ Notifications appear
- ✅ System tray integration works
- ✅ Data syncs to Supabase
- ✅ No crashes during normal operation
- ✅ Build script produces working executable

### 12.2 Should Have (Non-Blocking)

- ✅ Works on Fedora and Arch
- ✅ Works on both Wayland and X11
- ✅ .deb package installs cleanly
- ✅ AppImage runs on all distributions
- ✅ Auto-update works
- ✅ Screen lock detection works

### 12.3 Nice to Have (Future)

- Snap package available
- Flatpak package available
- Available in official repositories
- Wayland window tracking
- macOS support

---

## 13. Risk Assessment

### 13.1 Technical Risks

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| X11/Wayland compatibility issues | High | Medium | Support X11 first, document Wayland limitations |
| OCR engine dependencies | Medium | Low | Use RapidOCR (no system deps) |
| Notification daemon variations | Low | Medium | Fallback to multiple methods |
| Package manager conflicts | Medium | Low | Test on multiple distributions |
| Single instance lock edge cases | Low | Low | Test thoroughly, fall back to file lock |

### 13.2 User Experience Risks

| Risk | Impact | Mitigation |
|------|--------|------------|
| Confusions about installation | High | Provide clear step-by-step guides |
| Missing system dependencies | Medium | Detect and show helpful error messages |
| Different desktop environments | Medium | Test on popular DEs (GNOME, KDE, XFCE) |
| Permission issues | Low | Document required permissions |

---

## 14. Timeline Estimate

### Week 1: Core Implementation
- Day 1-2: Create platform abstraction layer
- Day 3-4: Update desktop_app.py with platform abstraction
- Day 5: Update build system and spec file

### Week 2: Testing & Packaging
- Day 1-2: Test on multiple distributions
- Day 3: Create .deb package
- Day 4: Create AppImage
- Day 5: Integration testing

### Week 3-4: Beta Testing & Refinement
- Deploy to beta testers
- Fix bugs and issues
- Performance optimization
- Documentation

### Week 5+: General Release
- Gradual rollout
- Monitor metrics
- Support users

---

## 15. Support Plan

### 15.1 Documentation

- Installation guides for popular distributions
- Troubleshooting guides
- FAQ for Linux-specific issues

### 15.2 Support Channels

- GitHub Issues (tag: `linux`)
- Email support
- Community forum/Discord

### 15.3 Known Limitations

Document clearly:
- X11 recommended for full functionality
- Wayland has limited window tracking
- Some OCR engines require system binaries
- AppImage may be slower than native packages

---

## Conclusion

This implementation plan provides a comprehensive roadmap for making the JIRAForge Desktop Time Tracker fully compatible with Linux systems. The approach focuses on:

1. **Platform abstraction** to isolate OS-specific code
2. **OCR engine compatibility** with automatic fallback
3. **Multiple packaging options** for maximum distribution
4. **Thorough testing** across distributions and desktop environments
5. **Gradual rollout** to minimize risk

**Key Advantages:**
- ✅ No changes to AI server or backend
- ✅ Maintains Windows functionality unchanged
- ✅ Automatic OCR engine selection per platform
- ✅ Uses existing OCR infrastructure
- ✅ Cross-platform codebase easier to maintain

**Next Steps:**
1. Review and approve this plan
2. Set up Linux development environment
3. Begin Phase 1 implementation
4. Schedule beta testing period

---

**Document Version:** 1.0  
**Date:** June 1, 2026  
**Status:** Ready for Implementation
