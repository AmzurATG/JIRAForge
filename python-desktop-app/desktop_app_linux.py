"""
Linux Implementation for Time Tracker Desktop App
This module provides Linux-specific implementations for screenshot capture and window tracking

Screenshot Strategy:
- Uses org.freedesktop.portal.Screenshot D-Bus portal directly
- On Wayland, first run shows permission dialog with "Always allow" option  
- Implements persist_mode=2 for permanent permission (survives reboot)
- Falls back to gnome-screenshot and other methods if portal unavailable
"""

import os
import sys
import time
import hashlib
import traceback
import subprocess
from datetime import datetime, timezone

# D-Bus for Wayland Screenshot portal (persist_mode=2)
try:
    import dbus
    from dbus.mainloop.glib import DBusGMainLoop
    DBUS_AVAILABLE = True
except ImportError:
    DBUS_AVAILABLE = False
    # dbus-python not required but provides better Wayland support

# Screenshot capture using mss (cross-platform, fast, silent)
try:
    import mss
    MSS_AVAILABLE = True
except ImportError:
    MSS_AVAILABLE = False
    print("[ERROR] mss library not available - install with: pip install mss")

# Linux window tracking
try:
    from ewmh import EWMH
    import Xlib.display
    LINUX_X11_AVAILABLE = True
except ImportError:
    LINUX_X11_AVAILABLE = False
    print("[WARN] X11 libraries not available - install with: pip install ewmh python-xlib")

try:
    import psutil
    PSUTIL_AVAILABLE = True
except ImportError:
    PSUTIL_AVAILABLE = False
    print("[ERROR] psutil not available - install with: pip install psutil")


# ============================================================================
# NOTIFICATIONS (Linux)
# ============================================================================

def show_notification_linux(title, message, duration=5000):
    """
    Show desktop notification on Linux using notify-send.
    
    Args:
        title: Notification title  
        message: Notification message
        duration: Duration in milliseconds (default 5000ms = 5 seconds)
    
    Returns:
        bool: True if notification was shown successfully
    """
    try:
        # Use notify-send command (available on most Linux distros)
        subprocess.run(
            ['notify-send', title, message, '-t', str(duration)],
            check=False,
            timeout=5
        )
        return True
    except FileNotFoundError:
        # Silently fail if notify-send not available
        return False
    except Exception:
        return False


# ============================================================================
# SCREENSHOT PERMISSION HELPER
# ============================================================================

def request_screenshot_permission_linux():
    """
    Request screenshot permission from user by triggering the Wayland portal.
    Uses PipeWire ScreenCast portal with persist_mode=2 for permanent permission.
    First time: Shows dialog - user selects screen and clicks "Share"
    After that: No more prompts (permission saved permanently)
    
    Returns True if permission was likely granted, False otherwise.
    """
    try:
        # Show notification to user
        show_notification_linux(
            "Time Tracker - Permission Required",
            "Please grant screenshot permission.\nSelect your screen and click 'Share'."
        )
        
        print("[INFO] Opening screenshot permission dialog...")
        print("[INFO] Please select your screen and click 'Share' when prompted")
        
        # Use PipeWire helper to trigger permission dialog with persist_mode=2
        script_dir = os.path.dirname(os.path.abspath(__file__))
        helper_script = os.path.join(script_dir, 'wayland_screenshot.py')
        
        import tempfile
        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
            tmp_path = tmp.name
        
        # Run helper with longer timeout for user interaction
        result = subprocess.run(
            ['/usr/bin/python3', helper_script, tmp_path],
            capture_output=True,
            text=True,
            timeout=60  # Give user 60 seconds to respond to dialog
        )
        
        # Clean up temp file
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        
        # If helper succeeded, permission is granted
        if result.returncode == 0 and 'SUCCESS' in result.stdout:
            show_notification_linux(
                "Time Tracker - Permission Granted",
                "Screenshot permission granted! Time tracking will now work automatically."
            )
            print("[SUCCESS] Screenshot permission granted")
            return True
        else:
            if result.stderr:
                for line in result.stderr.split('\n')[-3:]:
                    if line.strip():
                        print(f"[DEBUG] {line}")
            show_notification_linux(
                "Time Tracker - Permission Denied",
                "Please enable screenshot permission when the dialog appears."
            )
            print("[WARN] Screenshot permission was not granted")
            return False
            
    except subprocess.TimeoutExpired:
        show_notification_linux(
            "Time Tracker - Permission Timeout",
            "Permission dialog timed out. Please try again."
        )
        print("[ERROR] Permission request timed out")
        return False
    except FileNotFoundError:
        print("[ERROR] wayland_screenshot.py helper not found")
        return False
    except Exception as e:
        print(f"[WARN] Failed to request permission: {e}")
        return False


# ============================================================================
# WAYLAND SCREENCAST PORTAL (persist_mode=2) - PROPER IMPLEMENTATION
# ============================================================================

def capture_screenshot_screencast_portal():
    """
    Capture screenshot using XDG ScreenCast Portal + PipeWire.
    
    This implements the proper Wayland flow:
        Python App → XDG Desktop Portal → PipeWire → Wayland Compositor → Screenshot
    
    Uses persist_mode=2 for permanent permission (survives reboots).
    First time: Shows permission dialog - select screen and click "Share"
    After that: No more prompts!
    
    Returns PIL Image or None
    """
    from PIL import Image
    import tempfile
    import subprocess
    
    try:
        # Get script directory
        script_dir = os.path.dirname(os.path.abspath(__file__))
        helper_script = os.path.join(script_dir, 'wayland_screenshot.py')
        
        # Create temp file for output
        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
            tmp_path = tmp.name
        
        if not hasattr(capture_screenshot_screencast_portal, '_info_shown'):
            print("[INFO] Using PipeWire ScreenCast portal (persist_mode=2)")
            print("[INFO] First time: Select screen and click 'Share' when prompted")
            print("[INFO] Permission will be saved permanently")
            capture_screenshot_screencast_portal._info_shown = True
        
        # First-time needs longer timeout for user to grant permission (60s)
        # After first grant, screenshots are instant (use 10s timeout)
        timeout_seconds = 10
        if not hasattr(capture_screenshot_screencast_portal, '_permission_granted'):
            timeout_seconds = 60  # First time - give user time to grant permission
        
        # Run helper script with system Python (has PyGObject)
        result = subprocess.run(
            ['/usr/bin/python3', helper_script, tmp_path],
            capture_output=True,
            text=True,
            timeout=timeout_seconds
        )
        
        # Check if successful
        if result.returncode == 0 and 'SUCCESS' in result.stdout:
            if os.path.exists(tmp_path) and os.path.getsize(tmp_path) > 1000:
                try:
                    img = Image.open(tmp_path)
                    img.load()
                    os.unlink(tmp_path)
                    
                    if not hasattr(capture_screenshot_screencast_portal, '_success_logged'):
                        print("[SUCCESS] Screenshot captured via PipeWire!")
                        capture_screenshot_screencast_portal._success_logged = True
                    
                    return img
                except Exception:
                    if os.path.exists(tmp_path):
                        os.unlink(tmp_path)
        
        # Log errors once
        if result.returncode != 0:
            if not hasattr(capture_screenshot_screencast_portal, '_error_logged'):
                if result.stderr:
                    # Extract useful error messages
                    for line in result.stderr.split('\n'):
                        if line.startswith('ERROR:'):
                            print(f"[DEBUG] {line}")
                capture_screenshot_screencast_portal._error_logged = True
        
        # Clean up
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        
        return None
        
    except subprocess.TimeoutExpired:
        if not hasattr(capture_screenshot_screencast_portal, '_timeout_warned'):
            print("[WARN] PipeWire screenshot timeout - permission dialog may have been dismissed")
            capture_screenshot_screencast_portal._timeout_warned = True
        return None
    except FileNotFoundError:
        if not hasattr(capture_screenshot_screencast_portal, '_helper_missing'):
            print("[WARN] wayland_screenshot.py helper not found")
            capture_screenshot_screencast_portal._helper_missing = True
        return None
    except Exception as e:
        if not hasattr(capture_screenshot_screencast_portal, '_error_shown'):
            print(f"[DEBUG] PipeWire screenshot error: {e}")
            capture_screenshot_screencast_portal._error_shown = True
        return None


# ============================================================================
# SCREENSHOT CAPTURE (Linux)
# ============================================================================

def capture_screenshot_linux():
    """
    Capture screenshot on Linux using multiple fallback methods.
    Returns PIL Image object for compatibility with existing code.
    
    Tries in order:
    1. GNOME Screenshot tool (triggers portal permission on Wayland with persist_mode=2)
    2. gnome-screenshot fallback (may use X11 on older systems)
    3. grim (Wayland compositor direct access)
    4. spectacle (KDE Plasma portal)
    5. scrot (X11 tool)
    6. mss library (X11 only)
    7. PIL ImageGrab (X11 fallback)
    
    Method 1 (GNOME Screenshot) is best for Wayland:
    - First use: Shows screenshot tool UI to grant permission
    - Permission saved with persist_mode=2 (permanent, survives reboots)
    - No more prompts after first use
    - Just click "Take Screenshot" button when dialog appears
    """
    from PIL import Image
    import tempfile
    
    def is_blank_screenshot(img):
        """Check if screenshot is blank (all same color - black/white/solid)"""
        try:
            # Convert to grayscale and check variance
            grayscale = img.convert('L')
            width, height = grayscale.size
            
            # Sample pixels from different regions of the image
            # This avoids false positives from uniform headers/footers
            sample_pixels = []
            for y_pct in [0.1, 0.3, 0.5, 0.7, 0.9]:  # 5 horizontal bands
                for x_pct in [0.1, 0.3, 0.5, 0.7, 0.9]:  # 5 vertical bands
                    x = int(width * x_pct)
                    y = int(height * y_pct)
                    sample_pixels.append(grayscale.getpixel((x, y)))
            
            # Calculate variance from sampled regions
            if len(sample_pixels) < 2:
                return False
            
            avg = sum(sample_pixels) / len(sample_pixels)
            variance = sum((p - avg) ** 2 for p in sample_pixels) / len(sample_pixels)
            
            # Only consider blank if ALL sampled pixels are nearly identical
            # Variance < 1 means truly uniform (all same color)
            return variance < 1
        except Exception:
            return False
    
    # Method 1: Try D-Bus Screenshot Portal first (BEST for Wayland with persist_mode=2)
    # This uses system Python with PyGObject to properly handle portal async responses
    try:
        screenshot = capture_screenshot_screencast_portal()
        if screenshot:
            # Check if blank before rejecting
            if not is_blank_screenshot(screenshot):
                return screenshot
            else:
                if not hasattr(capture_screenshot_linux, '_portal_blank_warned'):
                    print("[WARN] Portal screenshot was blank, trying other methods...")
                    capture_screenshot_linux._portal_blank_warned = True
    except Exception as e:
        if not hasattr(capture_screenshot_linux, '_portal_error'):
            print(f"[DEBUG] Portal exception: {e}")
            capture_screenshot_linux._portal_error = True
    
    # Method 2: Try gnome-screenshot (SKIP if X11 fallback already detected)
    # Once X11 fallback is detected, it will always fail on Wayland, so don't retry
    if not hasattr(capture_screenshot_linux, '_x11_fallback_warned'):
        try:
            with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
                tmp_path = tmp.name
            
            # Use gnome-screenshot non-interactively
            result = subprocess.run(
                ['gnome-screenshot', '-f', tmp_path],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.PIPE,  # Capture stderr to detect X11 fallback
                timeout=5,
                text=True
            )
            
            # Check if it fell back to X11 (won't work on Wayland)
            if result.stderr and 'fallback X11' in result.stderr:
                print("[WARN] gnome-screenshot using X11 fallback (won't work on Wayland)")
                print("[INFO] Skipping gnome-screenshot for future captures...")
                capture_screenshot_linux._x11_fallback_warned = True
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
            elif result.returncode == 0 and os.path.exists(tmp_path) and os.path.getsize(tmp_path) > 1000:
                screenshot = Image.open(tmp_path)
                screenshot.load()
                os.unlink(tmp_path)
                # Check if screenshot is actually blank
                if not is_blank_screenshot(screenshot):
                    if not hasattr(capture_screenshot_linux, '_method_logged'):
                        print("[INFO] Using gnome-screenshot (portal-based, permanent permissions)")
                        print("[INFO] Grant permission when prompted, select 'Always allow'")
                        capture_screenshot_linux._method_logged = 'gnome-screenshot'
                    return screenshot
                else:
                    if not hasattr(capture_screenshot_linux, '_blank_warned'):
                        print("[WARN] gnome-screenshot captured blank screen")
                        print("[INFO] This indicates permission is needed on Wayland")
                        
                        # Check if on Wayland
                        is_wayland = os.environ.get('XDG_SESSION_TYPE') == 'wayland'
                        if is_wayland and not hasattr(capture_screenshot_linux, '_permission_requested'):
                            print("[INFO] Requesting screenshot permission...")
                            capture_screenshot_linux._permission_requested = True
                            
                            # Request permission immediately
                            if request_screenshot_permission_linux():
                                # Try again after permission granted
                                capture_screenshot_linux._blank_warned = True
                                return None  # Will try again on next interval
                        
                        capture_screenshot_linux._blank_warned = True
            else:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
        except FileNotFoundError:
            if not hasattr(capture_screenshot_linux, '_gnome_missing'):
                print("[WARN] gnome-screenshot not found - install with: sudo apt install gnome-screenshot")
                capture_screenshot_linux._gnome_missing = True
        except Exception:
            pass
    
    # Method 2: flameshot DISABLED - causes "Unable to capture screen" errors on GNOME Wayland
    # Flameshot conflicts with GNOME Screenshot tool
    
    # Method 3: Try grim (Wayland tool - direct compositor access)
    try:
        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
            tmp_path = tmp.name
        
        result = subprocess.run(
            ['grim', tmp_path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5
        )
        
        if result.returncode == 0 and os.path.exists(tmp_path) and os.path.getsize(tmp_path) > 1000:
            try:
                screenshot = Image.open(tmp_path)
                screenshot.load()
                os.unlink(tmp_path)
                if not is_blank_screenshot(screenshot):
                    if not hasattr(capture_screenshot_linux, '_method_logged'):
                        print("[INFO] Using grim for capture")
                        capture_screenshot_linux._method_logged = 'grim'
                    return screenshot
            except Exception:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
        else:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
    except FileNotFoundError:
        pass
    except Exception:
        pass
    
    # Method 4: Try spectacle (KDE Plasma - uses portal on Wayland)
    try:
        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
            tmp_path = tmp.name
        
        # spectacle --background saves without UI and uses portal permissions
        result = subprocess.run(
            ['spectacle', '--background', '--nonotify', '--output', tmp_path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5
        )
        
        if result.returncode == 0 and os.path.exists(tmp_path) and os.path.getsize(tmp_path) > 1000:
            try:
                screenshot = Image.open(tmp_path)
                screenshot.load()
                os.unlink(tmp_path)
                if not is_blank_screenshot(screenshot):
                    if not hasattr(capture_screenshot_linux, '_method_logged'):
                        print("[INFO] Using spectacle (KDE portal-based)")
                        capture_screenshot_linux._method_logged = 'spectacle'
                    return screenshot
            except Exception:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
        else:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
    except FileNotFoundError:
        pass
    except Exception:
        pass
    
    # Method 5: Try scrot (X11)
    try:
        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
            tmp_path = tmp.name
        
        result = subprocess.run(
            ['scrot', tmp_path],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5
        )
        
        if result.returncode == 0 and os.path.exists(tmp_path) and os.path.getsize(tmp_path) > 1000:
            try:
                screenshot = Image.open(tmp_path)
                screenshot.load()
                os.unlink(tmp_path)
                if not is_blank_screenshot(screenshot):
                    if not hasattr(capture_screenshot_linux, '_method_logged'):
                        print("[INFO] Using scrot for capture")
                        capture_screenshot_linux._method_logged = 'scrot'
                    return screenshot
            except Exception:
                if os.path.exists(tmp_path):
                    os.unlink(tmp_path)
        else:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
    except FileNotFoundError:
        pass
    except Exception:
        pass
    
    # Method 6: Try mss (X11 only - may capture blank on Wayland)
    if MSS_AVAILABLE:
        try:
            with mss.mss() as sct:
                if len(sct.monitors) > 1:
                    monitor = sct.monitors[1]
                else:
                    monitor = sct.monitors[0]
                
                screenshot = sct.grab(monitor)
                img = Image.frombytes('RGB', screenshot.size, screenshot.rgb)
                
                if not is_blank_screenshot(img):
                    if not hasattr(capture_screenshot_linux, '_method_logged'):
                        print("[INFO] Using mss for capture")
                        capture_screenshot_linux._method_logged = 'mss'
                    return img
                else:
                    print("[WARN] mss captured blank screen (Wayland compatibility issue)")
        except Exception:
            pass
    
    # Method 7: Try PIL ImageGrab (X11 fallback)
    try:
        from PIL import ImageGrab
        screenshot = ImageGrab.grab()
        if screenshot and not is_blank_screenshot(screenshot):
            if not hasattr(capture_screenshot_linux, '_method_logged'):
                print("[INFO] Using ImageGrab for capture")
                capture_screenshot_linux._method_logged = 'ImageGrab'
            return screenshot
    except Exception:
        pass
    
    # All methods failed or captured blank screens
    if not hasattr(capture_screenshot_linux, '_error_shown'):
        print("[ERROR] All screenshot methods failed or captured blank screens!")
        print("[ERROR] This may be due to Wayland permissions")
        
        # Check if running on Wayland
        is_wayland = os.environ.get('XDG_SESSION_TYPE') == 'wayland'
        
        if is_wayland:
            print("[INFO] Detected Wayland session - requesting screenshot permission...")
            
            # Show user-friendly notification
            show_notification_linux(
                "Time Tracker - Setup Required",
                "Screenshot permission needed. Click OK when the permission dialog appears."
            )
            
            # Request permission interactively
            permission_granted = request_screenshot_permission_linux()
            
            if permission_granted:
                print("[INFO] Permission granted! Try capturing again on next interval...")
                # Mark that we've shown the dialog and got permission
                capture_screenshot_linux._permission_granted = True
            else:
                print("[ERROR] Permission not granted. Screenshots will remain blank.")
                print("[INFO] To fix: Settings > Privacy > Screen Sharing > Allow Time Tracker")
        else:
            print("[INFO] Running on X11 - install screenshot tools:")
            print("[INFO]   sudo apt install gnome-screenshot scrot")
        
        capture_screenshot_linux._error_shown = True
    
    return None


# ============================================================================
# WINDOW TRACKING (Linux using EWMH/X11)
# ============================================================================

def get_active_window_linux():
    """
    Get active window information on Linux using EWMH (Extended Window Manager Hints).
    Returns dict with 'title', 'app', 'window_key', and 'is_new_window' keys.
    
    This matches the Windows implementation structure.
    """
    if not LINUX_X11_AVAILABLE:
        print("[WARN] X11 libraries not available - using fallback")
        return _get_active_window_fallback()
    
    try:
        ewmh = EWMH()
        
        # Get active window
        active_window = ewmh.getActiveWindow()
        if not active_window:
            return {'title': 'Unknown', 'app': 'Unknown', 'window_key': 'unknown', 'is_new_window': False}
        
        # Get window title
        title = ewmh.getWmName(active_window)
        if not title:
            title = 'Unknown'
        # Handle bytes (some window managers return bytes)
        if isinstance(title, bytes):
            title = title.decode('utf-8', errors='ignore')
        
        # Get PID (safely handle windows that don't have PID property)
        pid = None
        try:
            pid_result = ewmh.getWmPid(active_window)
            # getWmPid returns a list or None
            if pid_result:
                pid = pid_result if isinstance(pid_result, int) else pid_result
        except (TypeError, IndexError, AttributeError):
            # Window doesn't have _NET_WM_PID property
            pass
        
        # Get process name from PID
        app_name = 'Unknown'
        if pid and PSUTIL_AVAILABLE:
            try:
                process = psutil.Process(pid)
                app_name = process.name()
            except Exception as e:
                print(f"[WARN] Could not get process name for PID {pid}: {e}")
        
        return {
            'title': title,
            'app': app_name,
            'window_key': f"{app_name}|||{title}",  # Match Windows format
            'is_new_window': False  # Will be determined by caller
        }
        
    except Exception as e:
        print(f"[WARN] Failed to get window info (Linux/EWMH): {e}")
        traceback.print_exc()
        return {'title': 'Unknown', 'app': 'Unknown', 'window_key': 'unknown', 'is_new_window': False}


def _get_active_window_fallback():
    """
    Fallback method using xdotool and xprop commands if EWMH libraries not available.
    Requires: xdotool and x11-utils packages
    Install with: sudo apt install xdotool x11-utils
    """
    try:
        # Get active window title using xdotool
        result = subprocess.run(
            ['xdotool', 'getactivewindow', 'getwindowname'],
            capture_output=True,
            text=True,
            timeout=2
        )
        
        if result.returncode != 0:
            return {'title': 'Unknown', 'app': 'Unknown', 'window_key': 'unknown', 'is_new_window': False}
        
        title = result.stdout.strip()
        
        # Get window ID
        window_id_result = subprocess.run(
            ['xdotool', 'getactivewindow'],
            capture_output=True,
            text=True,
            timeout=2
        )
        
        if window_id_result.returncode != 0:
            return {'title': title, 'app': 'Unknown', 'window_key': f"Unknown|||{title}", 'is_new_window': False}
        
        window_id = window_id_result.stdout.strip()
        
        # Get window class (app name) using xprop
        class_result = subprocess.run(
            ['xprop', '-id', window_id, 'WM_CLASS'],
            capture_output=True,
            text=True,
            timeout=2
        )
        
        app_name = 'Unknown'
        if class_result.returncode == 0:
            # Parse WM_CLASS output: WM_CLASS(STRING) = "instance", "Class"
            # We want the class name (second value)
            import re
            matches = re.findall(r'"([^"]+)"', class_result.stdout)
            if len(matches) >= 2:
                app_name = matches[1]  # Use class name
            elif len(matches) >= 1:
                app_name = matches[0]  # Fallback to instance name
        
        return {
            'title': title,
            'app': app_name,
            'window_key': f"{app_name}|||{title}",
            'is_new_window': False
        }
        
    except FileNotFoundError:
        print("[WARN] xdotool not found - install with: sudo apt install xdotool x11-utils")
        return {'title': 'Unknown', 'app': 'Unknown', 'window_key': 'unknown', 'is_new_window': False}
    except Exception as e:
        print(f"[WARN] Fallback window detection failed: {e}")
        return {'title': 'Unknown', 'app': 'Unknown', 'window_key': 'unknown', 'is_new_window': False}


# ============================================================================
# SINGLE INSTANCE LOCK (Linux using fcntl)
# ============================================================================

_linux_lock_file = None

def acquire_single_instance_lock_linux(lock_file_path):
    """
    Acquire a file-based lock using fcntl (Linux/Unix).
    This ensures only one instance of the app runs at a time.
    
    Args:
        lock_file_path: Path to lock file
        
    Returns:
        bool: True if lock acquired, False if another instance is running
    """
    global _linux_lock_file
    
    try:
        import fcntl
        
        # Open lock file
        _linux_lock_file = open(lock_file_path, 'w')
        
        # Try to acquire exclusive lock (non-blocking)
        try:
            fcntl.flock(_linux_lock_file.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            # Write PID to lock file for debugging
            _linux_lock_file.write(str(os.getpid()))
            _linux_lock_file.flush()
            print(f"[OK] Single instance lock acquired: {lock_file_path}")
            return True
        except IOError:
            # Lock is held by another process
            _linux_lock_file.close()
            _linux_lock_file = None
            print(f"[INFO] Another instance is already running (lock file: {lock_file_path})")
            return False
            
    except Exception as e:
        print(f"[ERROR] Failed to acquire lock: {e}")
        traceback.print_exc()
        return True  # Allow running anyway


def release_single_instance_lock_linux():
    """Release the Linux file lock."""
    global _linux_lock_file
    
    if _linux_lock_file:
        try:
            import fcntl
            fcntl.flock(_linux_lock_file.fileno(), fcntl.LOCK_UN)
            _linux_lock_file.close()
            _linux_lock_file = None
            print("[OK] Single instance lock released")
        except Exception as e:
            print(f"[WARN] Failed to release lock: {e}")


# ============================================================================
# AUTO-START (Linux using .desktop file)
# ============================================================================

def add_to_startup_linux(app_name, exe_path):
    """
    Add application to Linux startup via .desktop file in ~/.config/autostart/.
    
    Args:
        app_name: Application name
        exe_path: Full path to executable
        
    Returns:
        bool: True if successful
    """
    try:
        autostart_dir = os.path.expanduser('~/.config/autostart')
        os.makedirs(autostart_dir, exist_ok=True)
        
        desktop_file_path = os.path.join(autostart_dir, 'timetracker.desktop')
        
        # Create .desktop file content
        desktop_content = f"""[Desktop Entry]
Type=Application
Name={app_name}
Comment=Automatic time tracking application
Exec={exe_path}
Icon=office-calendar
Terminal=false
Hidden=false
NoDisplay=false
X-GNOME-Autostart-enabled=true
X-GNOME-Autostart-Delay=10
Categories=Office;Utility;
StartupNotify=false
"""
        
        # Write .desktop file
        with open(desktop_file_path, 'w') as f:
            f.write(desktop_content)
        
        # Make it executable
        os.chmod(desktop_file_path, 0o755)
        
        print(f"[OK] Added to Linux startup: {desktop_file_path}")
        return True
        
    except Exception as e:
        print(f"[ERROR] Failed to add to Linux startup: {e}")
        traceback.print_exc()
        return False


def remove_from_startup_linux():
    """Remove application from Linux startup."""
    try:
        desktop_file = os.path.expanduser('~/.config/autostart/timetracker.desktop')
        
        if os.path.exists(desktop_file):
            os.remove(desktop_file)
            print(f"[OK] Removed from Linux startup")
        else:
            print("[INFO] App was not in startup")
        
        return True
        
    except Exception as e:
        print(f"[ERROR] Failed to remove from Linux startup: {e}")
        return False


def is_in_startup_linux():
    """Check if application is in Linux startup."""
    try:
        desktop_file = os.path.expanduser('~/.config/autostart/timetracker.desktop')
        return os.path.exists(desktop_file)
    except Exception as e:
        print(f"[ERROR] Failed to check startup status: {e}")
        return False


# ============================================================================
# APP DATA DIRECTORY (Linux following XDG spec)
# ============================================================================

def get_app_data_dir_linux():
    """
    Get application data directory following XDG Base Directory specification.
    Returns: ~/.local/share/timetracker/
    
    See: https://specifications.freedesktop.org/basedir-spec/basedir-spec-latest.html
    """
    xdg_data_home = os.environ.get('XDG_DATA_HOME', 
                                   os.path.expanduser('~/.local/share'))
    app_dir = os.path.join(xdg_data_home, 'timetracker')
    
    # Create directory if it doesn't exist
    os.makedirs(app_dir, exist_ok=True)
    
    return app_dir


# ============================================================================
# PLATFORM INFO (for debugging)
# ============================================================================

def get_platform_info_linux():
    """Get Linux platform information for debugging."""
    info = {
        'platform': 'Linux',
        'mss_available': MSS_AVAILABLE,
        'x11_available': LINUX_X11_AVAILABLE,
        'psutil_available': PSUTIL_AVAILABLE
    }
    
    # Get Linux distribution info
    try:
        with open('/etc/os-release', 'r') as f:
            for line in f:
                if line.startswith('PRETTY_NAME='):
                    info['distribution'] = line.split('=')[1].strip().strip('"')
                    break
    except:
        info['distribution'] = 'Unknown'
    
    # Get desktop environment
    try:
        desktop = os.environ.get('XDG_CURRENT_DESKTOP', 
                                os.environ.get('DESKTOP_SESSION', 'Unknown'))
        info['desktop_environment'] = desktop
    except:
        info['desktop_environment'] = 'Unknown'
    
    # Get Python version
    info['python_version'] = sys.version.split()[0]
    
    return info


# ============================================================================
# TEST FUNCTION
# ============================================================================

def test_linux_implementation():
    """Test the Linux implementation."""
    print("\n" + "="*70)
    print("LINUX IMPLEMENTATION TEST")
    print("="*70)
    
    # Print platform info
    info = get_platform_info_linux()
    print("\nPlatform Information:")
    for key, value in info.items():
        print(f"  {key:25s}: {value}")
    
    # Test screenshot
    print("\n[TEST 1] Screenshot capture using mss...")
    screenshot = capture_screenshot_linux()
    if screenshot:
        print(f"[OK] Screenshot captured successfully: {screenshot.size} pixels")
        print(f"     Mode: {screenshot.mode}, Format: {screenshot.format}")
    else:
        print("[FAIL] Screenshot capture failed")
    
    # Test window tracking
    print("\n[TEST 2] Active window detection...")
    window_info = get_active_window_linux()
    print(f"[OK] Active window:")
    print(f"     App: {window_info['app']}")
    print(f"     Title: {window_info['title'][:60]}")
    print(f"     Window Key: {window_info['window_key'][:60]}")
    
    # Test notification
    print("\n[TEST 3] Desktop notification...")
    result = show_notification_linux(
        "Time Tracker - Linux Test",
        "Linux implementation is working correctly!"
    )
    if result:
        print("[OK] Notification sent successfully")
    else:
        print("[WARN] Notification failed - check if notify-send is installed")
    
    # Test auto-start functions
    print("\n[TEST 4] Auto-start check...")
    is_startup = is_in_startup_linux()
    print(f"[OK] In startup: {is_startup}")
    
    # Test lock file
    print("\n[TEST 5] Single instance lock...")
    lock_path = os.path.join(get_app_data_dir_linux(), '.lock')
    locked = acquire_single_instance_lock_linux(lock_path)
    if locked:
        print(f"[OK] Lock acquired: {lock_path}")
        release_single_instance_lock_linux()
        print("[OK] Lock released")
    else:
        print("[FAIL] Could not acquire lock")
    
    print("\n" + "="*70)
    print("TEST COMPLETE")
    print("="*70 + "\n")


if __name__ == '__main__':
    # Run tests if executed directly
    test_linux_implementation()
