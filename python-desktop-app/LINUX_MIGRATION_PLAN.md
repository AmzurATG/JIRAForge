# Linux Migration Plan - Time Tracker Desktop App

## Executive Summary
This document outlines the comprehensive plan to make the Time Tracker desktop app fully functional on Linux while maintaining Windows compatibility.

---

## Current Implementation Analysis

### 🖼️ **1. Screenshot Capture**
**Current (Windows):**
```python
screenshot = ImageGrab.grab()  # PIL.ImageGrab - Windows/macOS only
```

**How it works:**
- Uses PIL's `ImageGrab.grab()` to capture the entire screen
- Returns a PIL Image object
- Calculates MD5 hash to detect duplicate screenshots
- Converts to PNG/JPEG for storage

**Linux Solution:**
- Use `pyscreenshot` library (compatible with multiple backends)
- Or use `python-xlib` + X11 for native implementation
- **Recommended:** `pyscreenshot` with `scrot` or `gnome-screenshot` backend

---

### 🪟 **2. Window Tracking (Active Window Detection)**
**Current (Windows):**
```python
hwnd = win32gui.GetForegroundWindow()  # Windows-specific
title = win32gui.GetWindowText(hwnd)
_, pid = win32process.GetWindowThreadProcessId(hwnd)
process = psutil.Process(pid)
app_name = process.name()
```

**How it works:**
- Uses `pywin32` to get the foreground window handle
- Extracts window title and process ID
- Uses `psutil` to get process name from PID

**Linux Solution:**
- Use `python-xlib` to query X11 for active window
- Use `ewmh` (Extended Window Manager Hints) standard
- Get `_NET_ACTIVE_WINDOW` property
- Extract title from `_NET_WM_NAME` or `WM_NAME`
- Get PID from `_NET_WM_PID`

**Alternative:**
- Use `wmctrl` command-line tool via subprocess
- Parse output for active window info

---

### 🔒 **3. Single Instance Lock**
**Current (Windows):**
```python
_instance_mutex = win32event.CreateMutex(None, False, mutex_name)
last_error = win32api.GetLastError()
if last_error == winerror.ERROR_ALREADY_EXISTS:
    return False
```

**How it works:**
- Creates a named mutex in Windows
- Checks if mutex already exists (another instance running)

**Linux Solution:**
- Use file-based locking with `fcntl.flock()`
- Create lock file in `/tmp/timetracker.lock`
- Acquire exclusive lock (LOCK_EX | LOCK_NB)
- If lock fails, another instance is running

---

### 🔔 **4. Desktop Notifications**
**Current (Windows):**
```python
from winotify import Notification, audio
toast = Notification(app_id="Time Tracker", title="...", msg="...")
toast.show()
```

**How it works:**
- Uses Windows toast notifications
- Displays system-native notifications

**Linux Solution:**
- Use `notify-send` command (available on most Linux distros)
- Or use `dbus` to send notifications via D-Bus
- **Recommended:** `plyer` library (cross-platform notifications)

---

### 🚀 **5. Auto-Start (System Startup)**
**Current (Windows):**
```python
key = winreg.OpenKey(winreg.HKEY_CURRENT_USER, 
                     r"Software\Microsoft\Windows\CurrentVersion\Run", 
                     0, winreg.KEY_SET_VALUE)
winreg.SetValueEx(key, "TimeTracker", 0, winreg.REG_SZ, exe_path)
```

**How it works:**
- Adds entry to Windows Registry in startup location
- App launches on user login

**Linux Solution:**
- Create `.desktop` file in `~/.config/autostart/`
- Desktop entry format:
```ini
[Desktop Entry]
Type=Application
Name=Time Tracker
Exec=/path/to/timetracker
Hidden=false
X-GNOME-Autostart-enabled=true
```

---

### 📁 **6. Application Data Directory**
**Current (Windows):**
```python
app_data = os.environ.get('LOCALAPPDATA')  # C:\Users\...\AppData\Local
app_dir = os.path.join(app_data, 'TimeTracker')
```

**How it works:**
- Stores data in Windows LocalAppData folder
- Contains: tokens, offline DB, consent data

**Linux Solution:**
- Use XDG Base Directory specification
- `~/.local/share/timetracker/` for data
- `~/.config/timetracker/` for config
- `~/.cache/timetracker/` for cache

---

### 🗝️ **7. Secure Credential Storage**
**Current (Cross-platform):**
```python
import keyring
keyring.set_password(service, key, value)  # Already cross-platform!
```

**How it works:**
- Uses `keyring` library
- Windows: Windows Credential Manager
- Linux: Secret Service (GNOME Keyring, KWallet)
- **No changes needed!**

---

## 📋 Implementation Plan

### Phase 1: Cross-Platform Abstraction Layer
Create platform detection and abstraction functions:

```python
import sys
import platform

PLATFORM = sys.platform  # 'win32', 'linux', 'darwin'

def is_windows():
    return PLATFORM == 'win32'

def is_linux():
    return PLATFORM == 'linux'

def is_macos():
    return PLATFORM == 'darwin'
```

### Phase 2: Screenshot Capture (Cross-Platform)
```python
def capture_screenshot():
    """Capture screenshot - cross-platform"""
    try:
        if is_windows():
            # Use PIL ImageGrab (Windows/macOS optimized)
            from PIL import ImageGrab
            screenshot = ImageGrab.grab()
        elif is_linux():
            # Use pyscreenshot (supports multiple backends)
            import pyscreenshot as ImageGrab
            screenshot = ImageGrab.grab()
            # Or use scrot backend explicitly:
            # screenshot = ImageGrab.grab(backend='scrot')
        else:
            # macOS fallback
            from PIL import ImageGrab
            screenshot = ImageGrab.grab()
        
        # Calculate hash (same for all platforms)
        screenshot_bytes = screenshot.tobytes()
        current_hash = hashlib.md5(screenshot_bytes).hexdigest()
        
        if current_hash == self.screenshot_hash:
            return None
        
        self.screenshot_hash = current_hash
        return screenshot
        
    except Exception as e:
        print(f"[ERROR] Screenshot capture failed: {e}")
        return None
```

### Phase 3: Window Tracking (Linux Implementation)
```python
def get_active_window_linux():
    """Get active window info on Linux using X11"""
    try:
        from ewmh import EWMH
        import psutil
        
        ewmh = EWMH()
        
        # Get active window
        active_window = ewmh.getActiveWindow()
        if not active_window:
            return {'title': 'Unknown', 'app': 'Unknown', 'window_key': 'unknown'}
        
        # Get window title
        title = ewmh.getWmName(active_window) or 'Unknown'
        
        # Get PID
        pid = ewmh.getWmPid(active_window)
        
        # Get process name
        app_name = 'Unknown'
        if pid:
            try:
                process = psutil.Process(pid)
                app_name = process.name()
            except:
                pass
        
        window_key = f"{app_name}|||{title}"
        
        return {
            'title': title,
            'app': app_name,
            'window_key': window_key,
            'is_new_window': window_key != self.current_window_key
        }
        
    except Exception as e:
        print(f"[WARN] Failed to get window info: {e}")
        return {'title': 'Unknown', 'app': 'Unknown', 'window_key': 'unknown'}
```

### Phase 4: Platform-Specific Helpers
```python
def get_app_data_dir():
    """Get application data directory - cross-platform"""
    if is_windows():
        app_data = os.environ.get('LOCALAPPDATA', os.path.expanduser('~'))
        app_dir = os.path.join(app_data, 'TimeTracker')
    elif is_linux():
        # XDG Base Directory spec
        xdg_data_home = os.environ.get('XDG_DATA_HOME', 
                                       os.path.expanduser('~/.local/share'))
        app_dir = os.path.join(xdg_data_home, 'timetracker')
    else:  # macOS
        app_dir = os.path.expanduser('~/Library/Application Support/TimeTracker')
    
    os.makedirs(app_dir, exist_ok=True)
    return app_dir

def add_to_startup():
    """Add to system startup - cross-platform"""
    if is_windows():
        # Windows registry method (existing)
        ...
    elif is_linux():
        # Create .desktop file
        autostart_dir = os.path.expanduser('~/.config/autostart')
        os.makedirs(autostart_dir, exist_ok=True)
        
        desktop_file = os.path.join(autostart_dir, 'timetracker.desktop')
        exe_path = get_app_executable_path()
        
        content = f"""[Desktop Entry]
Type=Application
Name=Time Tracker
Exec={exe_path}
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
"""
        with open(desktop_file, 'w') as f:
            f.write(content)
        
        # Make executable
        os.chmod(desktop_file, 0o755)

def show_notification_cross_platform(title, message):
    """Show notification - cross-platform"""
    if is_windows():
        if WINOTIFY_AVAILABLE:
            from winotify import Notification
            toast = Notification(app_id="Time Tracker", title=title, msg=message)
            toast.show()
    elif is_linux():
        # Use notify-send command
        try:
            subprocess.run(['notify-send', title, message], 
                          check=False, timeout=5)
        except:
            print(f"[WARN] Could not send notification: {title}")
```

---

## 📦 Dependency Updates

### Updated `requirements.txt`:
```txt
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

# Windows-specific
pywin32==306; sys_platform == 'win32'
winotify==1.1.0; sys_platform == 'win32'

# Linux-specific
pyscreenshot==3.1; sys_platform == 'linux'
python-xlib==0.33; sys_platform == 'linux'
ewmh==0.1.6; sys_platform == 'linux'
```

---

## 🎯 Key Changes Summary

| Feature | Windows | Linux | Status |
|---------|---------|-------|--------|
| Screenshot | `ImageGrab.grab()` | `pyscreenshot.grab()` | ✅ Ready |
| Window Tracking | `win32gui` | `ewmh` + `xlib` | ✅ Ready |
| System Tray | `pystray` | `pystray` | ✅ Works |
| Single Instance | Windows Mutex | `fcntl.flock()` | ✅ Ready |
| Notifications | `winotify` | `notify-send` | ✅ Ready |
| Auto-start | Registry | `.desktop` file | ✅ Ready |
| Data Directory | `%LOCALAPPDATA%` | `~/.local/share` | ✅ Ready |
| Keyring | Credential Manager | Secret Service | ✅ Works |

---

## ✅ Testing Checklist

### Linux Testing:
- [ ] Screenshot capture works
- [ ] Active window detection works
- [ ] Window switching triggers events
- [ ] System tray icon appears
- [ ] Tray menu works (pause/resume/settings)
- [ ] Notifications display
- [ ] Auto-start on login works
- [ ] Data persists in correct directory
- [ ] OAuth flow works
- [ ] Offline mode works
- [ ] Single instance lock works

### Cross-Platform Testing:
- [ ] Works on Ubuntu 22.04+
- [ ] Works on Fedora 38+
- [ ] Works on Arch Linux
- [ ] Works on Windows 10/11
- [ ] Code runs without platform-specific errors

---

## 🚀 Deployment

### Linux Binary Build:
```bash
pyinstaller --onefile \
            --windowed \
            --name TimeTracker \
            --add-data "assets:assets" \
            desktop_app.py
```

### Distribution:
- **AppImage**: Universal Linux binary
- **Snap**: For Ubuntu/derivatives
- **Flatpak**: For all distros
- **DEB package**: For Debian/Ubuntu
- **RPM package**: For Fedora/RHEL

---

## 📌 Next Steps
1. ✅ Install Linux dependencies
2. ✅ Implement cross-platform abstraction layer
3. ✅ Test on Linux VM/device
4. ✅ Package for Linux distribution
5. ✅ Update documentation
