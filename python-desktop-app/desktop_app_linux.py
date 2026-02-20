"""
Linux Implementation for Time Tracker Desktop App
This module provides Linux-specific implementations for screenshot capture and window tracking

Screenshot Strategy:
- Uses XDG ScreenCast Portal + PipeWire for Wayland screenshot capture
- First run shows permission dialog - select screen and click "Share"
- Uses persist_mode=2 for permanent permission (survives reboot)
- PERSISTENT SESSION: Screen share stays open for fast captures (no subprocess each time)
- No fallback methods - Wayland only

Idle Detection:
- Uses D-Bus GNOME Mutter IdleMonitor for Wayland (pynput doesn't work on Wayland)
- Directly queries system idle time based on cursor/keyboard activity
"""

import os
import sys
import time
import traceback
import subprocess
import tempfile
from datetime import datetime, timezone

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
# IDLE DETECTION (Wayland-compatible via D-Bus)
# ============================================================================

_idle_monitor_available = None
_dbus_bus = None

def get_idle_time_linux():
    """
    Get system idle time in seconds using D-Bus.
    Works on Wayland (unlike pynput which requires X11).
    
    Uses GNOME Mutter IdleMonitor which tracks cursor/keyboard inactivity.
    
    Returns:
        float: Idle time in seconds, or 0.0 if detection unavailable
    """
    global _idle_monitor_available, _dbus_bus
    
    # Quick return if we know it's not available
    if _idle_monitor_available is False:
        return 0.0
    
    try:
        import dbus
        
        # Reuse connection
        if _dbus_bus is None:
            _dbus_bus = dbus.SessionBus()
        
        # Try GNOME Mutter IdleMonitor (works on GNOME/Wayland)
        mutter = _dbus_bus.get_object(
            'org.gnome.Mutter.IdleMonitor',
            '/org/gnome/Mutter/IdleMonitor/Core'
        )
        # GetIdletime returns milliseconds
        idle_ms = mutter.GetIdletime(dbus_interface='org.gnome.Mutter.IdleMonitor')
        
        if _idle_monitor_available is None:
            print("[OK] Wayland idle detection enabled (GNOME Mutter IdleMonitor)")
            _idle_monitor_available = True
        
        return idle_ms / 1000.0
        
    except ImportError:
        if _idle_monitor_available is None:
            print("[WARN] dbus-python not available - install with: pip install dbus-python")
            _idle_monitor_available = False
        return 0.0
    except Exception as e:
        if _idle_monitor_available is None:
            print(f"[WARN] D-Bus idle detection not available: {e}")
            print("[INFO] Falling back to pynput for idle detection")
            _idle_monitor_available = False
        return 0.0


def is_idle_detection_available_linux():
    """Check if Wayland-compatible idle detection is available."""
    global _idle_monitor_available
    
    if _idle_monitor_available is None:
        # Trigger availability check
        get_idle_time_linux()
    
    return _idle_monitor_available is True


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
# WAYLAND SCREENCAST PORTAL (persist_mode=2) - PERSISTENT SESSION VIA DAEMON
# ============================================================================

# Socket path for daemon communication
_SCREENSHOT_SOCKET = os.path.expanduser("~/.local/share/timetracker/.screenshot_socket")
_daemon_process = None


def _start_screenshot_daemon():
    """Start the screenshot daemon (keeps screen share alive)."""
    global _daemon_process
    
    import socket
    
    # Check if already running
    if os.path.exists(_SCREENSHOT_SOCKET):
        try:
            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            client.settimeout(2)
            client.connect(_SCREENSHOT_SOCKET)
            client.send(b"PING\n")
            response = client.recv(1024).decode('utf-8').strip()
            client.close()
            if response == "PONG":
                # Daemon is alive, now check session status
                client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                client.settimeout(2)
                client.connect(_SCREENSHOT_SOCKET)
                client.send(b"STATUS\n")
                status = client.recv(1024).decode('utf-8').strip()
                client.close()
                if status == "ACTIVE":
                    print("[INFO] Screenshot daemon already running with active session")
                    return True
                else:
                    # Daemon alive but session dead - restart it
                    print("[INFO] Daemon running but session inactive, restarting...")
                    _stop_screenshot_daemon()
        except Exception:
            # Socket exists but daemon not responding, clean up
            try:
                os.unlink(_SCREENSHOT_SOCKET)
            except:
                pass
    
    # Start daemon with system Python
    script_dir = os.path.dirname(os.path.abspath(__file__))
    helper_script = os.path.join(script_dir, 'wayland_screenshot.py')
    
    print("[INFO] Starting screenshot daemon (persistent screen share)...")
    print("[INFO] First time: Select screen and click 'Share' when prompted")
    
    try:
        _daemon_process = subprocess.Popen(
            ['/usr/bin/python3', helper_script, '--daemon'],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            start_new_session=True  # Detach from parent
        )
        
        # Wait for daemon to be ready (max 60s for first-time permission)
        import select
        deadline = time.time() + 60
        while time.time() < deadline:
            readable, _, _ = select.select([_daemon_process.stdout], [], [], 1)
            if readable:
                line = _daemon_process.stdout.readline().decode('utf-8').strip()
                if line == "DAEMON_READY":
                    # Session initialized and socket ready
                    print("[OK] Screenshot daemon started (screen share active)")
                    return True
                elif line == "DAEMON_FAILED":
                    print("[ERROR] Daemon failed to initialize screen share")
                    print("[INFO] Please grant permission when prompted")
                    return False
            
            # Check if process died
            if _daemon_process.poll() is not None:
                stderr = _daemon_process.stderr.read().decode('utf-8')
                print(f"[ERROR] Daemon process exited: {stderr[:200] if stderr else 'no output'}")
                return False
        
        print("[WARN] Daemon start timeout - permission dialog may have been dismissed")
        return False
        
    except Exception as e:
        print(f"[ERROR] Failed to start screenshot daemon: {e}")
        return False


def _capture_via_daemon(output_path):
    """Send capture request to the daemon via socket."""
    import socket
    
    if not os.path.exists(_SCREENSHOT_SOCKET):
        return False
    
    try:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(30)  # Longer timeout for session reinit
        client.connect(_SCREENSHOT_SOCKET)
        client.send(f"CAPTURE:{output_path}\n".encode('utf-8'))
        response = client.recv(1024).decode('utf-8').strip()
        client.close()
        return response == "SUCCESS"
    except socket.timeout:
        print("[WARN] Daemon capture timeout - session may be reinitializing")
        return False
    except Exception as e:
        print(f"[WARN] Daemon capture error: {e}")
        return False


def _restart_daemon_session():
    """Tell daemon to restart its screen share session."""
    import socket
    
    if not os.path.exists(_SCREENSHOT_SOCKET):
        return False
    
    try:
        client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        client.settimeout(60)  # Long timeout for permission dialog
        client.connect(_SCREENSHOT_SOCKET)
        client.send(b"RESTART\n")
        response = client.recv(1024).decode('utf-8').strip()
        client.close()
        return response == "RESTARTED"
    except Exception:
        return False


def _stop_screenshot_daemon():
    """Stop the screenshot daemon."""
    global _daemon_process
    import socket
    
    if os.path.exists(_SCREENSHOT_SOCKET):
        try:
            client = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            client.settimeout(2)
            client.connect(_SCREENSHOT_SOCKET)
            client.send(b"QUIT\n")
            client.recv(1024)
            client.close()
        except Exception:
            pass
    
    if _daemon_process:
        try:
            _daemon_process.terminate()
            _daemon_process.wait(timeout=5)
        except:
            pass
        _daemon_process = None


def capture_screenshot_screencast_portal():
    """
    Capture screenshot using XDG ScreenCast Portal + PipeWire.
    
    Uses a DAEMON process to keep screen share alive for fast captures.
    Auto-restarts screen share if user stops it.
    First time: Shows permission dialog - select screen and click "Share"
    After that: Instant captures via socket!
    
    Returns PIL Image or None
    """
    from PIL import Image
    
    try:
        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
            tmp_path = tmp.name
        
        # Start daemon if not running
        if not hasattr(capture_screenshot_screencast_portal, '_daemon_started'):
            if _start_screenshot_daemon():
                capture_screenshot_screencast_portal._daemon_started = True
                capture_screenshot_screencast_portal._consecutive_failures = 0
        
        if hasattr(capture_screenshot_screencast_portal, '_daemon_started'):
            # Try capture (daemon auto-restarts session if needed)
            success = _capture_via_daemon(tmp_path)
            
            if success and os.path.exists(tmp_path) and os.path.getsize(tmp_path) > 1000:
                try:
                    img = Image.open(tmp_path)
                    img.load()
                    os.unlink(tmp_path)
                    
                    if not hasattr(capture_screenshot_screencast_portal, '_success_logged'):
                        print("[SUCCESS] Screenshot captured via daemon (persistent session)!")
                        capture_screenshot_screencast_portal._success_logged = True
                    
                    # Reset failure counter on success
                    capture_screenshot_screencast_portal._consecutive_failures = 0
                    return img
                except Exception as e:
                    print(f"[WARN] Failed to load captured image: {e}")
            else:
                # Track consecutive failures
                failures = getattr(capture_screenshot_screencast_portal, '_consecutive_failures', 0) + 1
                capture_screenshot_screencast_portal._consecutive_failures = failures
                
                if failures >= 3:
                    # Multiple failures - daemon probably dead, restart it
                    print("[WARN] Multiple capture failures, restarting daemon...")
                    show_notification_linux(
                        "Time Tracker - Screen Share Required",
                        "Please grant screen share permission when prompted."
                    )
                    _stop_screenshot_daemon()
                    if hasattr(capture_screenshot_screencast_portal, '_daemon_started'):
                        delattr(capture_screenshot_screencast_portal, '_daemon_started')
                    capture_screenshot_screencast_portal._consecutive_failures = 0
        
        # Clean up temp file
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        
        # Fall back to subprocess (slower but works)
        return _capture_screenshot_subprocess()
        
    except Exception as e:
        if not hasattr(capture_screenshot_screencast_portal, '_error_shown'):
            print(f"[DEBUG] PipeWire screenshot error: {e}")
            capture_screenshot_screencast_portal._error_shown = True
        return None


def _capture_screenshot_subprocess():
    """Capture using subprocess with system Python (has PyGObject)."""
    from PIL import Image
    import tempfile
    import subprocess
    
    try:
        script_dir = os.path.dirname(os.path.abspath(__file__))
        helper_script = os.path.join(script_dir, 'wayland_screenshot.py')
        
        with tempfile.NamedTemporaryFile(suffix='.png', delete=False) as tmp:
            tmp_path = tmp.name
        
        if not hasattr(_capture_screenshot_subprocess, '_info_shown'):
            print("[INFO] Using PipeWire ScreenCast portal (subprocess mode)")
            print("[INFO] First time: Select screen and click 'Share' when prompted")
            print("[INFO] Permission saved permanently - no prompts after first grant")
            _capture_screenshot_subprocess._info_shown = True
        
        timeout_seconds = 10
        if not hasattr(_capture_screenshot_subprocess, '_permission_granted'):
            timeout_seconds = 60
        
        result = subprocess.run(
            ['/usr/bin/python3', helper_script, tmp_path],
            capture_output=True,
            text=True,
            timeout=timeout_seconds
        )
        
        if result.returncode == 0 and 'SUCCESS' in result.stdout:
            if os.path.exists(tmp_path) and os.path.getsize(tmp_path) > 1000:
                try:
                    img = Image.open(tmp_path)
                    img.load()
                    os.unlink(tmp_path)
                    
                    if not hasattr(_capture_screenshot_subprocess, '_success_logged'):
                        print("[SUCCESS] Screenshot captured via PipeWire!")
                        _capture_screenshot_subprocess._success_logged = True
                    
                    _capture_screenshot_subprocess._permission_granted = True
                    return img
                except Exception:
                    if os.path.exists(tmp_path):
                        os.unlink(tmp_path)
        else:
            # Log errors for debugging
            if result.stderr and not hasattr(_capture_screenshot_subprocess, '_error_logged'):
                for line in result.stderr.strip().split('\n'):
                    if line and not line.startswith('INFO:'):
                        print(f"[DEBUG] {line}")
                _capture_screenshot_subprocess._error_logged = True
        
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        
        return None
        
    except subprocess.TimeoutExpired:
        if not hasattr(_capture_screenshot_subprocess, '_timeout_warned'):
            print("[WARN] Screenshot timeout - permission dialog may have been dismissed")
            _capture_screenshot_subprocess._timeout_warned = True
        return None
    except Exception as e:
        print(f"[ERROR] Screenshot subprocess failed: {e}")
        return None


# ============================================================================
# SCREENSHOT CAPTURE (Linux - Wayland Only)
# ============================================================================

def capture_screenshot_linux():
    """
    Capture screenshot on Linux using PipeWire ScreenCast portal.
    
    This is the only supported method for Wayland:
    - Uses XDG ScreenCast Portal + PipeWire
    - persist_mode=2 for permanent permission
    - First time: Shows dialog - select screen and click "Share"
    - After permission granted: No more prompts
    
    Returns PIL Image object or None if capture failed.
    """
    from PIL import Image
    
    # Try PipeWire ScreenCast portal (only method for Wayland)
    screenshot = capture_screenshot_screencast_portal()
    
    if screenshot:
        return screenshot
    
    # If failed, show helpful error message
    if not hasattr(capture_screenshot_linux, '_error_shown'):
        is_wayland = os.environ.get('XDG_SESSION_TYPE') == 'wayland'
        
        print("[ERROR] Screenshot capture failed!")
        
        if is_wayland:
            print("[INFO] Wayland session detected")
            print("[INFO] Requesting screenshot permission...")
            
            # Show notification
            show_notification_linux(
                "Time Tracker - Permission Required",
                "Please grant screenshot permission when the dialog appears."
            )
            
            # Request permission
            if request_screenshot_permission_linux():
                print("[OK] Permission granted! Screenshots will work on next capture.")
                capture_screenshot_linux._permission_granted = True
            else:
                print("[ERROR] Permission not granted.")
                print("[INFO] To fix manually:")
                print("       1. Run: python3 wayland_screenshot.py /tmp/test.png")
                print("       2. Select your screen and click 'Share'")
        else:
            print("[ERROR] Not running on Wayland - this module requires Wayland")
            print(f"[INFO] XDG_SESSION_TYPE = {os.environ.get('XDG_SESSION_TYPE', 'not set')}")
        
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
        'x11_available': LINUX_X11_AVAILABLE,
        'psutil_available': PSUTIL_AVAILABLE,
        'display_server': os.environ.get('XDG_SESSION_TYPE', 'unknown'),
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
    print("LINUX IMPLEMENTATION TEST (Wayland Only)")
    print("="*70)
    
    # Print platform info
    info = get_platform_info_linux()
    print("\nPlatform Information:")
    for key, value in info.items():
        print(f"  {key:25s}: {value}")
    
    # Check if Wayland
    if info['display_server'] != 'wayland':
        print(f"\n[WARN] Not running on Wayland (display_server={info['display_server']})")
        print("[INFO] This module is designed for Wayland only")
    
    # Test screenshot
    print("\n[TEST 1] Screenshot capture via PipeWire ScreenCast portal...")
    print("[INFO] First time: Select your screen and click 'Share' when prompted")
    screenshot = capture_screenshot_linux()
    if screenshot:
        print(f"[OK] Screenshot captured successfully: {screenshot.size} pixels")
        print(f"     Mode: {screenshot.mode}")
    else:
        print("[FAIL] Screenshot capture failed - permission may be required")
    
    # Test window tracking
    print("\n[TEST 2] Active window detection...")
    window_info = get_active_window_linux()
    print(f"[OK] Active window:")
    print(f"     App: {window_info['app']}")
    print(f"     Title: {window_info['title'][:60]}")
    
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


# ============================================================================
# CLEANUP
# ============================================================================

def cleanup_linux():
    """Cleanup Linux-specific resources (call on app exit)."""
    try:
        _stop_screenshot_daemon()
        print("[INFO] Screenshot daemon stopped")
    except Exception as e:
        print(f"[WARN] Error stopping screenshot daemon: {e}")


if __name__ == '__main__':
    # Run tests if executed directly
    test_linux_implementation()
