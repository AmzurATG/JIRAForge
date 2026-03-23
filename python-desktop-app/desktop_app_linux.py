"""
Linux Platform Functions for JIRAForge Time Tracker
====================================================

Provides Linux-specific implementations for:
- Active window tracking (EWMH / xdotool)
- Idle detection (D-Bus / xprintidle)
- Desktop notifications (notify-send)
- Single-instance lock (fcntl.flock)
- Auto-start (XDG autostart .desktop file)
- Screenshot capture (Wayland ScreenCast Portal)
- App data directory (XDG Base Directory Spec)
"""

import os
import sys
import fcntl
import subprocess
import shutil

from PIL import Image

# ---------------------------------------------------------------------------
# Optional imports — degrade gracefully if not installed
# ---------------------------------------------------------------------------

_EWMH_AVAILABLE = False
try:
    from ewmh import EWMH
    import Xlib.display  # noqa: F401
    _EWMH_AVAILABLE = True
except ImportError:
    pass

_DBUS_AVAILABLE = False
try:
    import dbus
    _DBUS_AVAILABLE = True
except ImportError:
    pass

_PSUTIL_AVAILABLE = False
try:
    import psutil
    _PSUTIL_AVAILABLE = True
except ImportError:
    pass

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

_APP_NAME_LOWER = "timetracker"
_DESKTOP_FILE_NAME = f"{_APP_NAME_LOWER}.desktop"

# ---------------------------------------------------------------------------
# Single-instance lock (fcntl.flock)
# ---------------------------------------------------------------------------

_linux_lock_fd = None

def acquire_single_instance_lock_linux(lock_file_path):
    """Acquire a kernel-level exclusive lock via fcntl.flock().

    Returns True if this is the only running instance, False otherwise.
    """
    global _linux_lock_fd

    # Ensure directory exists
    lock_dir = os.path.dirname(lock_file_path)
    os.makedirs(lock_dir, exist_ok=True)

    _linux_lock_fd = open(lock_file_path, 'w')
    try:
        fcntl.flock(_linux_lock_fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        _linux_lock_fd.write(str(os.getpid()))
        _linux_lock_fd.flush()
        print("[OK] Single instance lock acquired (fcntl)")
        return True
    except (IOError, OSError):
        print("[WARN] Another instance is already running (fcntl lock held)")
        _linux_lock_fd.close()
        _linux_lock_fd = None
        return False


def release_single_instance_lock_linux():
    """Release the kernel-level lock."""
    global _linux_lock_fd
    if _linux_lock_fd is not None:
        try:
            fcntl.flock(_linux_lock_fd.fileno(), fcntl.LOCK_UN)
            _linux_lock_fd.close()
        except Exception:
            pass
        _linux_lock_fd = None
        print("[OK] Single instance lock released (fcntl)")

# ---------------------------------------------------------------------------
# App data directory (XDG Base Directory Spec)
# ---------------------------------------------------------------------------

def get_app_data_dir_linux():
    """Return ``$XDG_DATA_HOME/timetracker`` (default ``~/.local/share/timetracker``)."""
    xdg_data = os.environ.get('XDG_DATA_HOME', os.path.expanduser('~/.local/share'))
    app_dir = os.path.join(xdg_data, _APP_NAME_LOWER)
    os.makedirs(app_dir, exist_ok=True)
    return app_dir

# ---------------------------------------------------------------------------
# Active window tracking (D-Bus/GNOME Shell for Wayland, EWMH for X11, xdotool fallback)
# ---------------------------------------------------------------------------

def _is_wayland():
    """Check if the session is running on Wayland."""
    return os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland'


def get_active_window_linux():
    """Return active window info dict compatible with the Windows version.

    On Wayland sessions, uses the GNOME Shell D-Bus eval interface to read
    ``global.display.focus_window``.  Falls back to EWMH (X11) and xdotool.

    Retries once with a 300ms delay if the first attempt returns Unknown
    (handles race conditions during window focus transitions).
    """
    import time as _time

    for attempt in range(2):
        # Wayland: GNOME Shell D-Bus is the only reliable way
        if _is_wayland() and _DBUS_AVAILABLE:
            try:
                result = _get_active_window_gnome_dbus()
                if result and result.get('app') != 'Unknown' and result.get('title') != 'Unknown':
                    return result
            except Exception:
                pass

        # X11 primary: EWMH
        if _EWMH_AVAILABLE:
            try:
                result = _get_active_window_ewmh()
                if result and result.get('title') != 'Unknown':
                    return result
            except Exception:
                pass

        # X11 fallback: xdotool (also works via XWayland for apps like Chrome)
        result = _get_active_window_xdotool()
        if result and result.get('title') != 'Unknown':
            return result

        # gdbus fallback for non-GNOME Wayland
        result = _get_active_window_gdbus_fallback()
        if result and result.get('app') != 'Unknown' and result.get('title') != 'Unknown':
            return result

        # First attempt failed — wait 300ms for window to fully focus, then retry
        if attempt == 0:
            _time.sleep(0.3)

    return _unknown_window()


def _get_active_window_gnome_dbus():
    """Get active window via GNOME Shell D-Bus Eval interface (Wayland-compatible).

    Uses ``org.gnome.Shell.Eval`` to call JavaScript on the GNOME Shell process,
    which has access to the focused window's title and WM class.
    """
    bus = dbus.SessionBus()
    proxy = bus.get_object('org.gnome.Shell', '/org/gnome/Shell')
    iface = dbus.Interface(proxy, 'org.gnome.Shell')

    # Get window title
    js_code = '''
    (function() {
        let w = global.display.focus_window;
        if (!w) return JSON.stringify({title: "", app: "", pid: 0});
        return JSON.stringify({
            title: w.get_title() || "",
            app: w.get_wm_class() || "",
            pid: w.get_pid() || 0
        });
    })()
    '''
    success, result_str = iface.Eval(js_code)
    if not success:
        return _unknown_window()

    import json
    # Shell.Eval returns the JS result as a JSON-encoded string inside another string
    # e.g. '"{\\"title\\":\\"Firefox\\",...}"' — we need to parse twice
    try:
        inner = json.loads(result_str)
        if isinstance(inner, str):
            data = json.loads(inner)
        else:
            data = inner
    except (json.JSONDecodeError, TypeError):
        return _unknown_window()

    title = data.get('title', '') or ''
    app_name = data.get('app', '') or ''
    pid = data.get('pid', 0)

    # Try to get a better app name from the process if we have a PID
    if pid and _PSUTIL_AVAILABLE:
        try:
            proc_name = psutil.Process(pid).name()
            if proc_name:
                app_name = proc_name
        except Exception:
            pass

    if not title and not app_name:
        return _unknown_window()

    window_key = f"{app_name}|||{title}"
    return {
        'title': title,
        'app': app_name,
        'window_key': window_key,
        'is_new_window': False,
    }


def _get_active_window_gdbus_fallback():
    """Fallback: use gdbus command-line tool for GNOME Shell Eval.

    This works even when python-dbus fails to connect, since it spawns
    a subprocess calling gdbus directly.
    """
    try:
        result = subprocess.check_output([
            'gdbus', 'call', '--session',
            '--dest', 'org.gnome.Shell',
            '--object-path', '/org/gnome/Shell',
            '--method', 'org.gnome.Shell.Eval',
            '''(function(){
                let w = global.display.focus_window;
                if(!w) return JSON.stringify({title:"",app:"",pid:0});
                return JSON.stringify({
                    title: w.get_title()||"",
                    app: w.get_wm_class()||"",
                    pid: w.get_pid()||0
                });
            })()'''
        ], stderr=subprocess.DEVNULL, timeout=3).decode('utf-8', errors='replace')

        # gdbus output format: (true, '"{...}"')
        import json
        # Extract the JSON string from gdbus output
        # Format is typically: (true, '"{\\"title\\":\\"...\\"}"')
        if 'true' in result.lower():
            # Find the JSON part between quotes
            start = result.find("'") + 1
            end = result.rfind("'")
            if start > 0 and end > start:
                json_outer = result[start:end]
                try:
                    inner = json.loads(json_outer)
                    if isinstance(inner, str):
                        data = json.loads(inner)
                    else:
                        data = inner
                except (json.JSONDecodeError, TypeError):
                    return _unknown_window()

                title = data.get('title', '') or ''
                app_name = data.get('app', '') or ''
                pid = data.get('pid', 0)

                if pid and _PSUTIL_AVAILABLE:
                    try:
                        proc_name = psutil.Process(pid).name()
                        if proc_name:
                            app_name = proc_name
                    except Exception:
                        pass

                if title or app_name:
                    window_key = f"{app_name}|||{title}"
                    return {
                        'title': title,
                        'app': app_name,
                        'window_key': window_key,
                        'is_new_window': False,
                    }
    except Exception:
        pass

    return _unknown_window()


def _get_active_window_ewmh():
    """Get active window via python-xlib EWMH."""
    wm = EWMH()
    active = wm.getActiveWindow()
    if active is None:
        return _unknown_window()

    title = wm.getWmName(active) or ""
    if isinstance(title, bytes):
        title = title.decode('utf-8', errors='replace')

    pid = wm.getWmPid(active)
    app_name = ""
    if pid and _PSUTIL_AVAILABLE:
        try:
            app_name = psutil.Process(pid).name()
        except Exception:
            pass
    if not app_name:
        wm_class = active.get_wm_class()
        app_name = wm_class[1] if wm_class else ""

    window_key = f"{app_name}|||{title}"
    return {
        'title': title,
        'app': app_name,
        'window_key': window_key,
        'is_new_window': False,  # caller will determine
    }


def _get_active_window_xdotool():
    """Fallback: use xdotool to get the active window."""
    try:
        wid = subprocess.check_output(
            ['xdotool', 'getactivewindow'], stderr=subprocess.DEVNULL, timeout=2
        ).decode().strip()

        title = subprocess.check_output(
            ['xdotool', 'getactivewindow', 'getwindowname'],
            stderr=subprocess.DEVNULL, timeout=2
        ).decode().strip()

        pid_str = subprocess.check_output(
            ['xdotool', 'getactivewindow', 'getwindowpid'],
            stderr=subprocess.DEVNULL, timeout=2
        ).decode().strip()

        app_name = ""
        if pid_str and _PSUTIL_AVAILABLE:
            try:
                app_name = psutil.Process(int(pid_str)).name()
            except Exception:
                pass

        window_key = f"{app_name}|||{title}"
        return {
            'title': title,
            'app': app_name,
            'window_key': window_key,
            'is_new_window': False,
        }
    except Exception:
        return _unknown_window()


def _unknown_window():
    return {'title': 'Unknown', 'app': 'Unknown', 'window_key': 'unknown', 'is_new_window': False}

# ---------------------------------------------------------------------------
# Idle detection (D-Bus / xprintidle fallback)
# ---------------------------------------------------------------------------

def get_idle_time_linux():
    """Return user idle time in seconds.

    Tries GNOME Mutter IdleMonitor via D-Bus first, then ``xprintidle``.
    """
    if _DBUS_AVAILABLE:
        try:
            return _get_idle_dbus()
        except Exception:
            pass

    return _get_idle_xprintidle()


def _get_idle_dbus():
    """GNOME Mutter IdleMonitor — returns idle time in seconds."""
    bus = dbus.SessionBus()
    proxy = bus.get_object(
        'org.gnome.Mutter.IdleMonitor',
        '/org/gnome/Mutter/IdleMonitor/Core'
    )
    iface = dbus.Interface(proxy, 'org.gnome.Mutter.IdleMonitor')
    idle_ms = iface.GetIdletime()
    return idle_ms / 1000.0


def _get_idle_xprintidle():
    """Fallback: use ``xprintidle`` command (X11)."""
    try:
        output = subprocess.check_output(
            ['xprintidle'], stderr=subprocess.DEVNULL, timeout=2
        ).decode().strip()
        return int(output) / 1000.0  # ms → seconds
    except Exception:
        return 0.0

# ---------------------------------------------------------------------------
# Desktop notifications (notify-send)
# ---------------------------------------------------------------------------

def show_notification_linux(title, message, urgency="normal"):
    """Show a desktop notification via ``notify-send``."""
    notify_send = shutil.which('notify-send')
    if not notify_send:
        print(f"[INFO] {title}: {message} (notify-send not available)")
        return False

    try:
        subprocess.Popen(
            [notify_send, f'--urgency={urgency}', '--app-name=TimeTracker', title, message],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
        )
        return True
    except Exception as exc:
        print(f"[WARN] Notification failed: {exc}")
        return False

# ---------------------------------------------------------------------------
# Auto-start (XDG Autostart .desktop file)
# ---------------------------------------------------------------------------

def add_to_startup_linux(app_name, exe_path):
    """Write a ``.desktop`` file to ``~/.config/autostart/``."""
    autostart_dir = os.path.join(
        os.environ.get('XDG_CONFIG_HOME', os.path.expanduser('~/.config')),
        'autostart'
    )
    os.makedirs(autostart_dir, exist_ok=True)

    desktop_entry = (
        "[Desktop Entry]\n"
        "Type=Application\n"
        f"Name={app_name}\n"
        f"Exec={exe_path}\n"
        "Hidden=false\n"
        "NoDisplay=false\n"
        "X-GNOME-Autostart-enabled=true\n"
        "X-GNOME-Autostart-Delay=10\n"
    )

    path = os.path.join(autostart_dir, _DESKTOP_FILE_NAME)
    with open(path, 'w') as f:
        f.write(desktop_entry)

    print(f"[OK] Added to Linux autostart: {path}")
    return True


def remove_from_startup_linux():
    """Remove the ``.desktop`` file from ``~/.config/autostart/``."""
    autostart_dir = os.path.join(
        os.environ.get('XDG_CONFIG_HOME', os.path.expanduser('~/.config')),
        'autostart'
    )
    path = os.path.join(autostart_dir, _DESKTOP_FILE_NAME)
    try:
        if os.path.exists(path):
            os.remove(path)
            print(f"[OK] Removed from Linux autostart: {path}")
        else:
            print("[INFO] App was not in autostart")
        return True
    except Exception as exc:
        print(f"[ERROR] Failed to remove from autostart: {exc}")
        return False


def is_in_startup_linux():
    """Check whether the autostart ``.desktop`` file exists."""
    autostart_dir = os.path.join(
        os.environ.get('XDG_CONFIG_HOME', os.path.expanduser('~/.config')),
        'autostart'
    )
    return os.path.isfile(os.path.join(autostart_dir, _DESKTOP_FILE_NAME))

# ---------------------------------------------------------------------------
# Screenshot capture (Wayland → daemon/subprocess, X11 fallback)
# ---------------------------------------------------------------------------

def capture_screenshot_linux():
    """Capture a screenshot on Linux.

    Tries in order:
    1. Wayland ScreenCast daemon (via wayland_screenshot module)
    2. GNOME Screenshot D-Bus interface (no subprocess needed)
    3. ``gnome-screenshot`` / ``grim`` subprocess
    4. ``scrot`` as last resort (X11)

    Returns a PIL.Image or raises RuntimeError.
    """
    # 1. Try Wayland daemon/module (PipeWire-based)
    try:
        from wayland_screenshot import capture_screenshot as _wayland_capture
        img = _wayland_capture()
        if img is not None:
            return img
    except ImportError:
        pass
    except Exception as e:
        print(f"[SCREENSHOT] Wayland ScreenCast failed: {e}")

    # 2. GNOME Screenshot D-Bus (works on Wayland without subprocess)
    if _DBUS_AVAILABLE and _is_wayland():
        img = _capture_gnome_dbus_screenshot()
        if img is not None:
            return img

    # 3. gnome-screenshot (GNOME/Wayland)
    img = _capture_subprocess(['gnome-screenshot', '-f'])
    if img is not None:
        return img

    # 4. grim (wlroots/Sway Wayland)
    img = _capture_subprocess(['grim'])
    if img is not None:
        return img

    # 5. scrot (X11 fallback)
    img = _capture_subprocess(['scrot', '--overwrite'])
    if img is not None:
        return img

    raise RuntimeError("No screenshot tool available on this Linux system")


def _capture_gnome_dbus_screenshot():
    """Capture screenshot using GNOME Shell Screenshot D-Bus interface.

    Uses org.gnome.Shell.Screenshot.Screenshot() which works on Wayland
    without needing gnome-screenshot binary installed.
    """
    import tempfile
    try:
        bus = dbus.SessionBus()
        proxy = bus.get_object('org.gnome.Shell.Screenshot', '/org/gnome/Shell/Screenshot')
        iface = dbus.Interface(proxy, 'org.gnome.Shell.Screenshot')

        tmp = tempfile.NamedTemporaryFile(suffix='.png', delete=False)
        tmp_path = tmp.name
        tmp.close()

        # Screenshot(include_cursor, flash, filename) -> (success, filename)
        success, saved_path = iface.Screenshot(False, False, tmp_path)
        if success:
            img = Image.open(str(saved_path)).copy()
            try:
                os.unlink(str(saved_path))
            except OSError:
                pass
            return img
    except Exception as e:
        print(f"[SCREENSHOT] GNOME D-Bus Screenshot failed: {e}")
    finally:
        try:
            os.unlink(tmp_path)
        except (OSError, NameError):
            pass
    return None


def _capture_subprocess(cmd_prefix):
    """Run a screenshot tool that writes to a temp file and return a PIL Image."""
    import tempfile
    tool = cmd_prefix[0]
    if not shutil.which(tool):
        return None

    tmp = tempfile.NamedTemporaryFile(suffix='.png', delete=False)
    tmp_path = tmp.name
    tmp.close()

    try:
        full_cmd = cmd_prefix + [tmp_path]
        subprocess.run(full_cmd, timeout=5, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        img = Image.open(tmp_path).copy()
        return img
    except Exception:
        return None
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
