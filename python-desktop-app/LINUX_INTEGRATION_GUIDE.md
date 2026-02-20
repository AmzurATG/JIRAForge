# Linux Integration Guide for TimeTracker Desktop App

## Overview
This guide explains how to integrate the Linux implementation (`desktop_app_linux.py`) with the existing Windows implementation (`desktop_app.py`) to create a cross-platform application.

---

## Architecture

```
desktop_app.py (Windows implementation - keep as-is)
    ↓
    OS Detection at startup
    ↓
desktop_app_linux.py (Linux implementation - import when on Linux)
```

- **Windows**: Uses existing `desktop_app.py` code (unchanged)
- **Linux**: Imports and uses functions from `desktop_app_linux.py`
- **Screenshot**: Both use `mss` library (cross-platform, fast, silent)

---

## Files Created

### 1. `desktop_app_linux.py`
Linux-specific implementations:
- **Screenshot capture**: Using `mss` (same as Windows for consistency)
- **Window tracking**: Using EWMH/X11 or xdotool fallback
- **Notifications**: Using `notify-send`
- **Auto-start**: Using `.desktop` file in `~/.config/autostart/`
- **Single instance lock**: Using `fcntl.flock()`
- **App data directory**: Following XDG spec (`~/.local/share/timetracker/`)

### 2. `requirements.txt` (Updated)
Added:
- `mss==9.0.1` (cross-platform screenshot - **required for both Windows and Linux**)
- `ewmh==0.1.6; sys_platform == 'linux'` (Linux window tracking)
- `python-xlib==0.33; sys_platform == 'linux'` (Linux X11 access)

---

## Integration Steps

### Step 1: Add OS Detection to desktop_app.py

Add this at the top of `desktop_app.py`, right after the imports section:

```python
# ============================================================================
# PLATFORM DETECTION & LINUX INTEGRATION
# ============================================================================

import sys

# Detect platform
IS_LINUX = sys.platform == 'linux'
IS_WINDOWS = sys.platform == 'win32'

# Import Linux implementation if running on Linux
if IS_LINUX:
    print("[INFO] Detected Linux platform - loading Linux implementation")
    from desktop_app_linux import (
        capture_screenshot_linux,
        get_active_window_linux,
        show_notification_linux,
        add_to_startup_linux,
        remove_from_startup_linux,
        is_in_startup_linux,
        acquire_single_instance_lock_linux,
        release_single_instance_lock_linux,
        get_app_data_dir_linux,
        get_platform_info_linux
    )
```

### Step 2: Modify `capture_screenshot()` method

Find the `capture_screenshot()` method in the `TimeTracker` class and replace it:

```python
def capture_screenshot(self):
    """Capture screenshot and return PIL Image - cross-platform"""
    try:
        if IS_LINUX:
            # Linux: Use Linux implementation (mss-based)
            screenshot = capture_screenshot_linux()
        else:
            # Windows: Use existing implementation
            from PIL import ImageGrab
            screenshot = ImageGrab.grab()
        
        if not screenshot:
            return None
        
        # Calculate hash to detect duplicate screenshots (same for all platforms)
        screenshot_bytes = screenshot.tobytes()
        current_hash = hashlib.md5(screenshot_bytes).hexdigest()
        
        # Skip if unchanged
        if current_hash == self.screenshot_hash:
            return None
        
        self.screenshot_hash = current_hash
        return screenshot
        
    except Exception as e:
        print(f"[ERROR] Screenshot capture failed: {e}")
        traceback.print_exc()
        return None
```

### Step 3: Modify `get_active_window()` method

Find the `get_active_window()` method and replace it:

```python
def get_active_window(self):
    """Get active window information - cross-platform"""
    if IS_LINUX:
        # Linux: Use Linux implementation
        window_info = get_active_window_linux()
    elif WIN32_AVAILABLE:
        # Windows: Use existing win32 implementation
        try:
            hwnd = win32gui.GetForegroundWindow()
            title = win32gui.GetWindowText(hwnd)
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            process = psutil.Process(pid)
            app_name = process.name()
            
            window_info = {
                'title': title,
                'app': app_name,
                'window_key': f"{app_name}|||{title}",
                'is_new_window': False
            }
        except Exception as e:
            print(f"[WARN] Failed to get window info: {e}")
            window_info = {'title': 'Unknown', 'app': 'Unknown', 'window_key': 'unknown', 'is_new_window': False}
    else:
        window_info = {'title': 'Unknown', 'app': 'Unknown', 'window_key': 'unknown', 'is_new_window': False}
    
    # Detect window switch (common logic for all platforms)
    window_key = window_info['window_key']
    is_new_window = False
    
    if window_key != self.current_window_key:
        is_new_window = True
        # ... rest of the existing window switch logic ...
    
    window_info['is_new_window'] = is_new_window
    return window_info
```

### Step 4: Modify `acquire_single_instance_lock()` function

Find the global `acquire_single_instance_lock()` function and modify it:

```python
def acquire_single_instance_lock():
    """
    Acquire a system-wide lock to ensure only one instance runs.
    Returns True if lock acquired, False if another instance is running.
    """
    if IS_LINUX:
        # Linux: Use file-based lock (fcntl)
        lock_file_path = os.path.join(get_app_data_dir(), '.lock')
        return acquire_single_instance_lock_linux(lock_file_path)
    elif WIN32_AVAILABLE:
        # Windows: Use existing mutex implementation
        global _instance_mutex
        try:
            mutex_name = "Global\\TimeTracker_SingleInstance_Mutex"
            _instance_mutex = win32event.CreateMutex(None, False, mutex_name)
            last_error = win32api.GetLastError()
            
            if last_error == winerror.ERROR_ALREADY_EXISTS:
                print(f"[INFO] Another instance is already running")
                return False
            else:
                print(f"[OK] Single instance lock acquired")
                return True
        except Exception as e:
            print(f"[ERROR] Failed to acquire lock: {e}")
            return True
    else:
        # Fallback: Use file-based lock
        return _acquire_lock_file()
```

### Step 5: Modify `release_single_instance_lock()` function

```python
def release_single_instance_lock():
    """Release the single instance lock"""
    if IS_LINUX:
        release_single_instance_lock_linux()
    else:
        # Windows implementation (existing code)
        global _instance_mutex
        if _instance_mutex:
            try:
                win32event.ReleaseMutex(_instance_mutex)
                win32event.CloseHandle(_instance_mutex)
            except:
                pass
            _instance_mutex = None
    
    # Also clean up lock file (both platforms)
    lock_file = os.path.join(get_app_data_dir(), '.lock')
    try:
        if os.path.exists(lock_file):
            os.remove(lock_file)
    except:
        pass
```

### Step 6: Modify `get_app_data_dir()` function

```python
def get_app_data_dir():
    """Get the application data directory - cross-platform"""
    if IS_LINUX:
        # Linux: Use XDG spec (~/.local/share/timetracker/)
        return get_app_data_dir_linux()
    elif sys.platform == 'win32':
        # Windows: Use LocalAppData
        app_data = os.environ.get('LOCALAPPDATA', os.path.expanduser('~'))
        app_dir = os.path.join(app_data, 'TimeTracker')
    else:
        # macOS and others
        app_data = os.path.expanduser('~/.local/share')
        app_dir = os.path.join(app_data, 'TimeTracker')
    
    # Create directory if it doesn't exist
    if not os.path.exists(app_dir):
        os.makedirs(app_dir)
        print(f"[OK] Created app data directory: {app_dir}")
    
    return app_dir
```

### Step 7: Modify auto-start functions

```python
def add_to_startup():
    """Add application to system startup - cross-platform"""
    if IS_LINUX:
        exe_path = get_app_executable_path()
        return add_to_startup_linux("TimeTracker", exe_path)
    elif sys.platform == 'win32':
        # Existing Windows implementation
        # ... (keep existing code) ...
        pass
    else:
        print(f"[INFO] Auto-start not implemented for platform: {sys.platform}")
        return False

def remove_from_startup():
    """Remove application from system startup - cross-platform"""
    if IS_LINUX:
        return remove_from_startup_linux()
    elif sys.platform == 'win32':
        # Existing Windows implementation
        # ... (keep existing code) ...
        pass
    else:
        return False

def is_in_startup():
    """Check if application is in system startup - cross-platform"""
    if IS_LINUX:
        return is_in_startup_linux()
    elif sys.platform == 'win32':
        # Existing Windows implementation
        # ... (keep existing code) ...
        pass
    else:
        return False
```

### Step 8: Add notification wrapper (optional)

If you want to abstract notifications:

```python
def show_desktop_notification(title, message):
    """Show desktop notification - cross-platform wrapper"""
    if IS_LINUX:
        return show_notification_linux(title, message, duration=5000)
    elif WINOTIFY_AVAILABLE:
        # Windows implementation
        from winotify import Notification
        toast = Notification(app_id="Time Tracker", title=title, msg=message)
        toast.show()
        return True
    else:
        print(f"[WARN] Notifications not available on this platform")
        return False
```

---

## Installation Instructions

### For Linux Users

1. **Install system dependencies:**
   ```bash
   # For Ubuntu/Debian
   sudo apt update
   sudo apt install python3-tk xdotool x11-utils libnotify-bin
   
   # For Fedora
   sudo dnf install python3-tkinter xdotool xorg-x11-utils libnotify
   
   # For Arch Linux
   sudo pacman -S tk xdotool xorg-xprop libnotify
   ```

2. **Install Python dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

3. **Run the application:**
   ```bash
   python3 desktop_app.py
   ```

4. **Test Linux implementation separately:**
   ```bash
   python3 desktop_app_linux.py
   ```

### For Windows Users

Nothing changes! Continue using `desktop_app.py` as before:
```bash
python desktop_app.py
```

---

## Testing

### Test Linux Implementation

Run the Linux test script:
```bash
python3 desktop_app_linux.py
```

This will test:
- ✅ Platform detection
- ✅ Screenshot capture (using mss)
- ✅ Active window detection
- ✅ Desktop notifications
- ✅ Auto-start status
- ✅ Single instance lock

### Expected Output

```
======================================================================
LINUX IMPLEMENTATION TEST
======================================================================

Platform Information:
  platform                 : Linux
  mss_available            : True
  x11_available            : True
  psutil_available         : True
  distribution             : Ubuntu 22.04.3 LTS
  desktop_environment      : ubuntu:GNOME

[TEST 1] Screenshot capture using mss...
[OK] Screenshot captured successfully: (1920, 1080) pixels
     Mode: RGB, Format: None

[TEST 2] Active window detection...
[OK] Active window:
     App: firefox
     Title: Linux Integration Guide - TimeTracker
     Window Key: firefox|||Linux Integration Guide - TimeTracker

[TEST 3] Desktop notification...
[OK] Notification sent successfully

[TEST 4] Auto-start check...
[OK] In startup: False

[TEST 5] Single instance lock...
[OK] Lock acquired: /home/user/.local/share/timetracker/.lock
[OK] Lock released

======================================================================
TEST COMPLETE
======================================================================
```

---

## Troubleshooting

### Issue: "mss library not available"
**Solution:**
```bash
pip install mss
```

### Issue: "X11 libraries not available"
**Solution:**
```bash
pip install ewmh python-xlib
```

### Issue: "notify-send not found"
**Solution:**
```bash
sudo apt install libnotify-bin
```

### Issue: "xdotool not found"
**Solution:**
```bash
sudo apt install xdotool x11-utils
```

### Issue: Screenshots are black/empty
**Possible causes:**
- Running in Wayland instead of X11
- Insufficient permissions

**Solution:**
1. Check if running X11:
   ```bash
   echo $XDG_SESSION_TYPE
   ```
2. If Wayland, switch to X11 session or use different screenshot method

---

## Key Differences: Windows vs Linux

| Feature | Windows | Linux |
|---------|---------|-------|
| Screenshot | `mss` library | `mss` library (same!) |
| Window Tracking | `win32gui` API | EWMH/X11 + fallback to xdotool |
| Notifications | `winotify` (toast) | `notify-send` command |
| Auto-start | Registry key | `.desktop` file |
| Single Instance | Windows Mutex | fcntl file lock |
| Data Directory | `%LOCALAPPDATA%\TimeTracker\` | `~/.local/share/timetracker/` |

---

## Deployment

### Building Linux Binary

Use PyInstaller:
```bash
pyinstaller --onefile \
            --windowed \
            --name TimeTracker \
            --hidden-import=desktop_app_linux \
            desktop_app.py
```

### Building Windows Binary

Same as before - no changes needed:
```bash
pyinstaller --onefile --windowed --name TimeTracker desktop_app.py
```

---

## Summary

✅ **Created:** `desktop_app_linux.py` - Complete Linux implementation  
✅ **Updated:** `requirements.txt` - Added mss + Linux dependencies  
✅ **Keep unchanged:** `desktop_app.py` - Windows implementation stays as-is  
✅ **Integration:** Add OS detection + conditional imports to desktop_app.py  

The app will automatically detect the OS and use the correct implementation!
