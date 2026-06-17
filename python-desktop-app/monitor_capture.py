"""
Focused-Monitor Screenshot Capture Module

Captures the monitor containing the current foreground window instead of
defaulting to the primary monitor. Addresses multi-display setups where
window metadata (app/title) and OCR text must refer to the same screen.

Architectural review items addressed:
- P0-1: DPI awareness via SetProcessDpiAwarenessContext at module load
- P0-2: Privacy-safe fallback (focused → primary → skip); never all-screens
- P0-3: Foreground window stability (debounce, transient window filtering)
- P0-4: Minimized/cloaked window detection, spanning window handling
- P1-5: Platform scope (Windows-only; passthrough on other platforms)
- P1-6: Monitor topology re-enumerated per capture (no stale cache)
- P1-11: Feature flag via MULTIMON_CAPTURE_MODE env var

Feature flag (env var MULTIMON_CAPTURE_MODE):
    'on'  — Use focused-monitor capture (default)
    'off' — Legacy primary-monitor capture (ImageGrab.grab())
"""

import os
import sys
import time
import logging
import shutil
import subprocess
import tempfile
import random
import string

from PIL import Image as _PILImage, ImageGrab

logger = logging.getLogger(__name__)

# GStreamer for ScreenCast frame capture
try:
    import gi
    gi.require_version('Gst', '1.0')
    from gi.repository import Gst
    Gst.init(None)
    _GSTREAMER_AVAILABLE = True
except (ImportError, ValueError) as e:
    _GSTREAMER_AVAILABLE = False
    # Logger available now, but we'll log when functions are called

# ============================================================================
# PLATFORM DETECTION & WIN32 SETUP
# ============================================================================

_WIN32_AVAILABLE = False
_DPI_AWARENESS_SET = False

if sys.platform == 'win32':
    try:
        import win32gui
        import win32api
        import win32process
        import ctypes
        import ctypes.wintypes
        _WIN32_AVAILABLE = True
    except ImportError:
        pass

# ============================================================================
# DPI AWARENESS (P0-1)
# Must be set before any window/monitor API calls.
# PER_MONITOR_AWARE_V2 ensures GetMonitorInfo returns physical pixel
# coordinates on mixed-DPI setups (e.g. 4K at 150% + 1080p at 100%).
# ============================================================================

def _set_dpi_awareness():
    """Declare per-monitor DPI awareness at process level.
    
    Must be called once, early, before any Win32 display API is used.
    Safe to call multiple times (no-op after first success).
    """
    global _DPI_AWARENESS_SET
    if _DPI_AWARENESS_SET or not _WIN32_AVAILABLE:
        return

    try:
        # Windows 10 1703+ (Creators Update): PER_MONITOR_AWARE_V2
        # This is the strongest mode — all coordinates are in physical pixels.
        DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = ctypes.c_void_p(-4)
        result = ctypes.windll.user32.SetProcessDpiAwarenessContext(
            DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
        )
        if result:
            _DPI_AWARENESS_SET = True
            logger.info("DPI awareness set: PER_MONITOR_AWARE_V2")
            return
    except (AttributeError, OSError):
        pass

    try:
        # Windows 8.1+: fallback to PROCESS_PER_MONITOR_DPI_AWARE
        PROCESS_PER_MONITOR_DPI_AWARE = 2
        ctypes.windll.shcore.SetProcessDpiAwareness(PROCESS_PER_MONITOR_DPI_AWARE)
        _DPI_AWARENESS_SET = True
        logger.info("DPI awareness set: PROCESS_PER_MONITOR_DPI_AWARE (shcore)")
    except (AttributeError, OSError):
        # Pre-8.1 or already set by manifest/parent — non-fatal
        logger.debug("DPI awareness could not be set (may already be declared)")
        _DPI_AWARENESS_SET = True  # Mark as attempted to avoid retry


# Set DPI awareness at module import time (earliest safe point)
if _WIN32_AVAILABLE:
    _set_dpi_awareness()

# ============================================================================
# CONSTANTS
# ============================================================================

# MonitorFromWindow flags
MONITOR_DEFAULTTONULL = 0
MONITOR_DEFAULTTOPRIMARY = 1
MONITOR_DEFAULTTONEAREST = 2

# Known transient window classes that should NOT anchor monitor selection (P0-3)
_TRANSIENT_WINDOW_CLASSES = frozenset({
    'Shell_TrayWnd',                    # Taskbar
    'Windows.UI.Core.CoreWindow',       # Toast notifications, Action Center
    'Shell_SecondaryTrayWnd',           # Secondary taskbar (multi-monitor)
    'NotifyIconOverflowWindow',         # System tray overflow
    'Credential Dialog Xaml Host',      # UAC / credential prompts
    '#32770',                           # Generic dialog (includes UAC consent)
    'ForegroundStaging',                # Windows focus transition staging
    'MultitaskingViewFrame',            # Task View (Win+Tab)
    'XamlExplorerHostIslandWindow',     # Start menu flyouts
})

# DWM cloaked attribute constant (P0-4)
DWMWA_CLOAKED = 14

# Multi-monitor capture is always active when Win32 is available.
# No feature flag — this behavior is unconditional.

# ============================================================================
# FOREGROUND WINDOW STABILITY (P0-3)
# ============================================================================

_last_stable_hwnd = 0
_last_stable_hwnd_time = 0.0
_STABILITY_WINDOW_SEC = 0.3  # 300ms debounce
_MAX_STALENESS_SEC = 10.0    # Don't reuse a cached HWND older than this


def _get_stable_foreground_hwnd():
    """Return the foreground HWND only if it has been stable.
    
    If the current foreground window changed very recently (< 300ms),
    reuse the previously known stable HWND to avoid capturing the wrong
    monitor during transient focus shifts (Alt-Tab, toast, UAC).
    
    Returns 0 if no valid HWND is available.
    """
    global _last_stable_hwnd, _last_stable_hwnd_time

    try:
        hwnd = win32gui.GetForegroundWindow()
    except Exception:
        return 0

    if not hwnd:
        # NULL HWND — desktop switch, secure desktop, or workstation lock.
        # Do NOT fall back to primary or all-screens. Return 0 → skip capture.
        return _last_stable_hwnd if _is_cache_valid() else 0

    # Filter transient window classes (P0-3 step 3)
    try:
        cls_name = win32gui.GetClassName(hwnd)
        if cls_name in _TRANSIENT_WINDOW_CLASSES:
            return _last_stable_hwnd if _is_cache_valid() else 0
    except Exception:
        pass

    # Check stability: if this HWND matches cached, it's stable
    now = time.time()
    if hwnd == _last_stable_hwnd:
        _last_stable_hwnd_time = now
        return hwnd

    # New HWND — check if enough time has passed since last stable
    elapsed_since_change = now - _last_stable_hwnd_time
    if elapsed_since_change < _STABILITY_WINDOW_SEC:
        # Too recent — reuse cached if still valid
        if _is_cache_valid():
            return _last_stable_hwnd
        # Cache is stale AND new HWND is unstable — accept the new one anyway
        # (better than returning 0 and skipping capture entirely)

    # Accept this HWND as the new stable anchor
    _last_stable_hwnd = hwnd
    _last_stable_hwnd_time = now
    return hwnd


def _is_cache_valid():
    """Check if the cached stable HWND is still usable (not too old)."""
    return (time.time() - _last_stable_hwnd_time) < _MAX_STALENESS_SEC


# ============================================================================
# WINDOW STATE CHECKS (P0-4)
# ============================================================================

def _is_minimized(hwnd):
    """Check if a window is minimized (iconic). Minimized windows have
    coordinates at (-32000, -32000) which would resolve to wrong monitors."""
    try:
        return bool(ctypes.windll.user32.IsIconic(hwnd))
    except Exception:
        return False


def _is_cloaked(hwnd):
    """Check if a window is DWM-cloaked (UWP apps like Settings, Calculator
    when not visible). Cloaked windows report misleading coordinates."""
    try:
        cloaked = ctypes.c_int(0)
        # DwmGetWindowAttribute returns S_OK (0) on success
        hr = ctypes.windll.dwmapi.DwmGetWindowAttribute(
            hwnd,
            DWMWA_CLOAKED,
            ctypes.byref(cloaked),
            ctypes.sizeof(cloaked)
        )
        return hr == 0 and cloaked.value != 0
    except (AttributeError, OSError):
        return False


def _get_window_rect(hwnd):
    """Get the window rectangle as (left, top, right, bottom).
    Returns None on failure."""
    try:
        rect = win32gui.GetWindowRect(hwnd)
        return rect  # (left, top, right, bottom)
    except Exception:
        return None


def _rect_intersection_area(r1, r2):
    """Compute the intersection area of two (left, top, right, bottom) rects."""
    left = max(r1[0], r2[0])
    top = max(r1[1], r2[1])
    right = min(r1[2], r2[2])
    bottom = min(r1[3], r2[3])
    if left < right and top < bottom:
        return (right - left) * (bottom - top)
    return 0


# ============================================================================
# MONITOR RESOLUTION (P0-4, P1-6)
# Re-enumerates monitors on every call — handles hot-plug/undock.
# ============================================================================

def _resolve_monitor_for_hwnd(hwnd):
    """Determine which monitor to capture for the given HWND.
    
    For windows spanning multiple monitors, picks the monitor containing
    the largest area of the window (P0-4 step 2).
    
    Returns:
        tuple (left, top, right, bottom) of the chosen monitor's pixel rect,
        or None if resolution fails.
    """
    if not hwnd:
        return None

    # Fast path: use MonitorFromWindow with DEFAULTTONEAREST
    try:
        hmon = win32api.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
        info = win32api.GetMonitorInfo(hmon)
        mon_rect = info["Monitor"]  # (left, top, right, bottom)
    except Exception:
        return None

    # Check if window spans multiple monitors (P0-4 step 2)
    win_rect = _get_window_rect(hwnd)
    if win_rect is None:
        return mon_rect  # Can't determine spanning — use nearest

    # Get all monitors and find the one with the largest overlap
    try:
        monitors = win32api.EnumDisplayMonitors(None, None)
    except Exception:
        return mon_rect  # EnumDisplayMonitors failed — use nearest

    if len(monitors) <= 1:
        return mon_rect  # Single monitor, no spanning possible

    best_area = 0
    best_rect = mon_rect

    for hmon_item, _, _ in monitors:
        try:
            minfo = win32api.GetMonitorInfo(hmon_item)
            mrect = minfo["Monitor"]
        except Exception:
            continue
        area = _rect_intersection_area(win_rect, mrect)
        if area > best_area:
            best_area = area
            best_rect = mrect

    return best_rect if best_area > 0 else mon_rect


def _get_primary_monitor_rect():
    """Return the primary monitor rect as fallback (Tier 2)."""
    try:
        monitors = win32api.EnumDisplayMonitors(None, None)
        for hmon, _, _ in monitors:
            info = win32api.GetMonitorInfo(hmon)
            if info.get("Flags", 0) & 1:  # MONITORINFOF_PRIMARY = 1
                return info["Monitor"]
        # If no primary flag found, use first monitor
        if monitors:
            info = win32api.GetMonitorInfo(monitors[0][0])
            return info["Monitor"]
    except Exception:
        pass
    return None


# ============================================================================
# PUBLIC API: FOCUSED-MONITOR CAPTURE
# ============================================================================

# Capture telemetry counters (P1-11)
_capture_stats = {
    'tier1_focused': 0,
    'tier2_primary': 0,
    'tier3_skipped': 0,
    'total': 0,
}


def get_capture_stats():
    """Return a copy of capture telemetry counters for diagnostics."""
    return dict(_capture_stats)


def _is_wayland_session():
    """Return True when the running session is Wayland (not pure X11)."""
    return bool(
        os.environ.get('WAYLAND_DISPLAY') or
        os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland'
    )


def _clean_env_for_screenshot():
    """Return a copy of os.environ with snap-injected GTK/GIO variables stripped.

    When running inside a snap-packaged host app (e.g. VS Code snap), certain
    environment variables are overridden to point inside the snap bundle:

        GTK_PATH, GTK_IM_MODULE_FILE, GTK_EXE_PREFIX,
        GIO_MODULE_DIR, GSETTINGS_SCHEMA_DIR, LOCPATH, XDG_DATA_HOME

    These cause native binaries like gnome-screenshot to load GTK modules
    from the snap's runtime (core20), which links against a different libc/
    libpthread than the system, resulting in:

        symbol lookup error: .../snap/core20/.../libpthread.so.0:
            undefined symbol: __libc_pthread_init, version GLIBC_PRIVATE

    Fix: strip all known snap-injected GTK/GIO variables so gnome-screenshot
    uses its system-default paths. The _VSCODE_SNAP_ORIG backup variables
    that VS Code creates are used to restore the pre-snap values where present.
    """
    # Variables that snap-packaged VS Code (and similar) override
    _SNAP_OVERRIDDEN_VARS = frozenset({
        'GTK_PATH',
        'GTK_IM_MODULE_FILE',
        'GTK_EXE_PREFIX',
        'GIO_MODULE_DIR',
        'GSETTINGS_SCHEMA_DIR',
        'LOCPATH',
        'XDG_DATA_HOME',
    })

    env = {}
    for key, val in os.environ.items():
        # Skip snap-injected vars; skip the "_ORIG" backups (they're internal)
        if key in _SNAP_OVERRIDDEN_VARS:
            continue
        if key.endswith('_VSCODE_SNAP_ORIG'):
            continue
        env[key] = val

    # Restore pre-snap values for XDG_CONFIG_DIRS and XDG_DATA_DIRS if VS Code
    # snap stored the originals in *_VSCODE_SNAP_ORIG backup variables.
    for xdg_var in ('XDG_CONFIG_DIRS', 'XDG_DATA_DIRS'):
        orig_key = f'{xdg_var}_VSCODE_SNAP_ORIG'
        if orig_key in os.environ and os.environ[orig_key]:
            env[xdg_var] = os.environ[orig_key]

    return env


def _capture_gnome_screenshot():
    """Capture the full screen via gnome-screenshot with a snap-safe clean env.

    gnome-screenshot is the standard screenshot tool on GNOME and works on
    both X11 and Wayland sessions.  When running inside VS Code snap (or any
    other snap-packaged host), snap injects GTK_PATH / GTK_IM_MODULE_FILE /
    etc. that redirect GTK module loading into the snap bundle's runtime
    (core20).  Those modules link against a different libpthread, triggering
    "undefined symbol: __libc_pthread_init, version GLIBC_PRIVATE".

    Fix: pass a clean copy of os.environ that strips the snap-injected vars,
    so gnome-screenshot uses the system GTK paths.

    Returns PIL.Image on success, None on failure.
    """
    if not shutil.which('gnome-screenshot'):
        return None

    fh, filepath = tempfile.mkstemp('.png')
    os.close(fh)
    try:
        result = subprocess.run(
            ['gnome-screenshot', '--file', filepath],
            capture_output=True,
            timeout=8,
            env=_clean_env_for_screenshot(),
        )
        if result.returncode == 0 and os.path.exists(filepath) and os.path.getsize(filepath) > 0:
            im = _PILImage.open(filepath)
            im.load()  # read into memory before the temp file is deleted
            # Sanity-check: reject all-black captures (compositor not ready)
            import array as _array
            bands = im.split()
            if any(max(_array.array('B', b.tobytes())) > 0 for b in bands):
                return im.copy()
            logger.warning("gnome-screenshot produced an all-black image — skipping")
            return None
        stderr_msg = result.stderr.decode('utf-8', errors='replace')[:300] if result.stderr else ''
        logger.warning(f"gnome-screenshot failed (rc={result.returncode}): {stderr_msg}")
    except subprocess.TimeoutExpired:
        logger.warning("gnome-screenshot timed out")
    except Exception as e:
        logger.warning(f"gnome-screenshot error: {e}")
    finally:
        try:
            os.unlink(filepath)
        except OSError:
            pass
    return None


def _capture_gnome_dbus_silent():
    """Capture via GNOME Shell Screenshot D-Bus with flash=false (no shutter sound).

    Calls org.gnome.Shell.Screenshot.Screenshot(include_cursor=false, flash=false,
    filename=<path>) directly via gdbus.  The gnome-screenshot binary defaults to
    flash=true which triggers the GNOME Shell camera-shutter sound and animation;
    calling the D-Bus service directly with flash=false skips both.

    Works on GNOME 3.38+ (Ubuntu 20.04+).  Returns PIL.Image on success, None
    on failure (e.g. GNOME Shell not running, D-Bus session unavailable).
    """
    fh, filepath = tempfile.mkstemp('.png')
    os.close(fh)
    try:
        result = subprocess.run(
            [
                'gdbus', 'call', '--session',
                '--dest', 'org.gnome.Shell',
                '--object-path', '/org/gnome/Shell/Screenshot',
                '--method', 'org.gnome.Shell.Screenshot.Screenshot',
                'false',   # include_cursor
                'false',   # flash=false → no camera-shutter sound or animation
                filepath,
            ],
            capture_output=True,
            text=True,
            timeout=8,
            env=_clean_env_for_screenshot(),
        )
        # Response on success: "(true, '/path/to/file')\n"
        # Response on failure: "(false, '')\n"
        if (result.returncode == 0 and result.stdout and
                result.stdout.strip().startswith('(true,')):
            if os.path.exists(filepath) and os.path.getsize(filepath) > 0:
                im = _PILImage.open(filepath)
                im.load()  # read into memory before temp file is deleted
                import array as _array
                bands = im.split()
                if any(max(_array.array('B', b.tobytes())) > 0 for b in bands):
                    logger.debug("Linux capture: GNOME Screenshot D-Bus (silent, flash=false)")
                    return im.copy()
                logger.warning("GNOME D-Bus screenshot all-black — skipping")
                return None
        logger.debug(
            f"GNOME Screenshot D-Bus unavailable (rc={result.returncode}): "
            f"{result.stderr[:200] if result.stderr else ''}"
        )
    except subprocess.TimeoutExpired:
        logger.warning("GNOME Screenshot D-Bus timed out")
    except Exception as e:
        logger.debug(f"GNOME Screenshot D-Bus error: {e}")
    finally:
        try:
            os.unlink(filepath)
        except OSError:
            pass
    return None


# ============================================================================
# XDG DESKTOP PORTAL SCREENSHOT (GNOME 46+ / Standard Wayland)
# ============================================================================

_XDG_PORTAL_AVAILABLE = None  # None = untested, True/False = cached result


def _check_xdg_portal_available():
    """Check if XDG Desktop Portal Screenshot interface is available.
    
    Called once at module load to cache the result.
    Returns True if the portal daemon is running and supports screenshots.
    """
    global _XDG_PORTAL_AVAILABLE
    
    if _XDG_PORTAL_AVAILABLE is not None:
        return _XDG_PORTAL_AVAILABLE
    
    try:
        result = subprocess.run(
            ['gdbus', 'introspect', '--session',
             '--dest', 'org.freedesktop.portal.Desktop',
             '--object-path', '/org/freedesktop/portal/desktop'],
            capture_output=True,
            text=True,
            timeout=3
        )
        _XDG_PORTAL_AVAILABLE = (
            result.returncode == 0 and
            'org.freedesktop.portal.Screenshot' in result.stdout
        )
    except Exception as e:
        logger.debug(f"XDG Portal check failed: {e}")
        _XDG_PORTAL_AVAILABLE = False
    
    logger.info(f"XDG Desktop Portal Screenshot available: {_XDG_PORTAL_AVAILABLE}")
    return _XDG_PORTAL_AVAILABLE


def _capture_xdg_portal():
    """Capture screenshot via XDG Desktop Portal (standard Wayland API).
    
    The XDG Desktop Portal provides a desktop-environment-agnostic way to
    capture screenshots on Wayland. It works on GNOME, KDE, and wlroots-based
    compositors that implement the portal backend.
    
    Behavior:
    - First call may show a permission dialog to the user
    - After user grants permission, subsequent captures are silent
    - No flash or shutter animation
    
    Implementation uses DIRECT D-Bus Portal calls (NOT gnome-screenshot).
    gnome-screenshot still uses the old GNOME Shell API which causes flash.
    
    The Portal API is asynchronous:
    1. Call Screenshot() → get request object path
    2. Wait for Response signal on that request path
    3. Signal contains 'uri' with file:// path to screenshot
    4. Read the screenshot from that path
    
    Returns PIL.Image on success, None on failure.
    """
    if not _check_xdg_portal_available():
        return None
    
    try:
        # Try using GLib/GIO for proper async D-Bus handling
        import gi
        gi.require_version('Gio', '2.0')
        from gi.repository import Gio, GLib
        
        # Timeout and result storage
        result_data = {'screenshot_path': None, 'error': None}
        main_loop = GLib.MainLoop()
        
        def on_response_signal(connection, sender_name, object_path, interface_name,
                             signal_name, parameters, user_data):
            """Handle the Response signal from the portal."""
            try:
                response_code = parameters[0]
                results_dict = parameters[1]
                
                if response_code == 0:  # Success
                    uri = results_dict.get('uri', '')
                    if uri:
                        screenshot_path = uri.replace('file://', '')
                        result_data['screenshot_path'] = screenshot_path
                        logger.debug(f"Portal Response: screenshot at {screenshot_path}")
                    else:
                        result_data['error'] = "No URI in portal response"
                elif response_code == 1:
                    result_data['error'] = "User cancelled screenshot"
                else:
                    result_data['error'] = f"Portal returned error code {response_code}"
            except Exception as e:
                result_data['error'] = f"Error parsing response: {e}"
            finally:
                main_loop.quit()
        
        def on_timeout():
            """Handle timeout."""
            result_data['error'] = "Portal request timed out"
            main_loop.quit()
            return False
        
        # Get D-Bus connection
        connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        
        # Call Screenshot() method
        result = connection.call_sync(
            'org.freedesktop.portal.Desktop',
            '/org/freedesktop/portal/desktop',
            'org.freedesktop.portal.Screenshot',
            'Screenshot',
            GLib.Variant('(sa{sv})', ('', {'interactive': GLib.Variant('b', False)})),
            GLib.VariantType('(o)'),
            Gio.DBusCallFlags.NONE,
            5000,  # 5 second timeout for the call
            None
        )
        
        request_path = result[0]
        logger.debug(f"Portal request path: {request_path}")
        
        # Subscribe to Response signal on the request object
        subscription_id = connection.signal_subscribe(
            'org.freedesktop.portal.Desktop',
            'org.freedesktop.portal.Request',
            'Response',
            request_path,
            None,
            Gio.DBusSignalFlags.NONE,
            on_response_signal,
            None
        )
        
        # Set timeout (15 seconds for user to grant permission)
        GLib.timeout_add_seconds(15, on_timeout)
        
        # Wait for response
        main_loop.run()
        
        # Unsubscribe from signal
        connection.signal_unsubscribe(subscription_id)
        
        # Check result
        if result_data['error']:
            logger.debug(f"Portal capture failed: {result_data['error']}")
            return None
        
        screenshot_path = result_data['screenshot_path']
        if not screenshot_path or not os.path.exists(screenshot_path):
            logger.warning(f"Portal screenshot file not found: {screenshot_path}")
            return None
        
        # Read the screenshot
        im = _PILImage.open(screenshot_path)
        im.load()  # Load into memory before file is potentially deleted
        
        # Validate not all-black
        import array as _array
        bands = im.split()
        if any(max(_array.array('B', b.tobytes())) > 0 for b in bands):
            logger.debug("Linux capture: XDG Desktop Portal (direct D-Bus with GLib)")
            return im.copy()
        
        logger.warning("XDG Portal screenshot all-black — skipping")
        return None
        
    except ImportError:
        logger.debug("GLib not available for Portal capture")
        return None
    except Exception as e:
        logger.debug(f"XDG Portal screenshot error: {e}")
        return None


# ============================================================================
# PIPEWIRE SCREENCAST PORTAL (NO FLASH SOLUTION)
# ============================================================================

_SCREENCAST_AVAILABLE = None  # None = untested, True/False = cached result

# Cache for ScreenCast session (to avoid repeated consent dialogs)
_SCREENCAST_SESSION_CACHE = {
    'session_handle': None,
    'pipewire_fd': None,
    'node_id': None,
    'restore_token': None
}


def _get_restore_token_file():
    """Get path to restore token file for persistent ScreenCast sessions."""
    # Store in user's config directory
    config_dir = os.path.expanduser('~/.config/timetracker')
    os.makedirs(config_dir, exist_ok=True)
    return os.path.join(config_dir, 'screencast_restore_token.json')


def _save_restore_token(restore_token, session_handle=None, node_id=None):
    """Save restore token to disk for persistent sessions across app restarts."""
    try:
        import json
        data = {
            'restore_token': restore_token,
            'saved_at': time.time(),
            'session_handle': session_handle,
            'node_id': node_id
        }
        with open(_get_restore_token_file(), 'w') as f:
            json.dump(data, f)
        logger.info(f"ScreenCast restore token saved for persistent sessions")
        return True
    except Exception as e:
        logger.warning(f"Failed to save restore token: {e}")
        return False


def _load_restore_token():
    """Load restore token from disk.
    
    Returns:
        dict with keys: restore_token, session_handle, node_id, saved_at
        or None if not found or invalid
    """
    try:
        import json
        token_file = _get_restore_token_file()
        if not os.path.exists(token_file):
            return None
        
        with open(token_file, 'r') as f:
            data = json.load(f)
        
        # Check if token is too old (older than 30 days) - conservative safety
        if 'saved_at' in data:
            age_days = (time.time() - data['saved_at']) / 86400
            if age_days > 30:
                logger.info(f"Restore token is {age_days:.1f} days old, discarding")
                _clear_restore_token()
                return None
        
        logger.info("Loaded ScreenCast restore token from disk")
        return data
    except Exception as e:
        logger.debug(f"Could not load restore token: {e}")
        return None


def _clear_restore_token():
    """Remove restore token file."""
    try:
        token_file = _get_restore_token_file()
        if os.path.exists(token_file):
            os.unlink(token_file)
            logger.info("ScreenCast restore token cleared")
    except Exception as e:
        logger.debug(f"Could not clear restore token: {e}")


def _generate_portal_token():
    """Generate random token for Portal D-Bus requests."""
    chars = string.ascii_letters + string.digits
    return ''.join(random.choice(chars) for _ in range(10))


def _check_screencast_available():
    """Check if ScreenCast portal is available.
    
    ScreenCast portal is used for flash-free screenshots by capturing
    a single frame from a video stream instead of using the Screenshot API.
    
    CRITICAL: Requires BOTH the ScreenCast D-Bus interface AND the GStreamer
    pipewiresrc plugin. If pipewiresrc is missing, ScreenCast will fail and
    fall back to Screenshot Portal which causes permission dialogs every time.
    
    Returns:
        bool: True if available, False otherwise
    """
    global _SCREENCAST_AVAILABLE
    
    if _SCREENCAST_AVAILABLE is not None:
        return _SCREENCAST_AVAILABLE
    
    # Check if GStreamer is available
    if not _GSTREAMER_AVAILABLE:
        logger.debug("ScreenCast unavailable: GStreamer not available")
        _SCREENCAST_AVAILABLE = False
        return False
    
    # CRITICAL FIX: Check if pipewiresrc plugin is installed
    # Without this plugin, ScreenCast will fail and cause repeated permission dialogs
    try:
        result = subprocess.run(
            ['gst-inspect-1.0', 'pipewiresrc'],
            capture_output=True,
            timeout=3
        )
        if result.returncode != 0:
            logger.warning("ScreenCast unavailable: GStreamer pipewiresrc plugin not installed")
            logger.info("Install with: sudo apt install gstreamer1.0-pipewire")
            _SCREENCAST_AVAILABLE = False
            return False
    except FileNotFoundError:
        logger.debug("ScreenCast unavailable: gst-inspect-1.0 not found")
        _SCREENCAST_AVAILABLE = False
        return False
    except Exception as e:
        logger.debug(f"GStreamer plugin check failed: {e}")
        _SCREENCAST_AVAILABLE = False
        return False
    
    # Check if ScreenCast Portal D-Bus interface exists
    try:
        result = subprocess.run(
            ['gdbus', 'introspect', '--session',
             '--dest', 'org.freedesktop.portal.Desktop',
             '--object-path', '/org/freedesktop/portal/desktop'],
            capture_output=True,
            text=True,
            timeout=3
        )
        _SCREENCAST_AVAILABLE = (
            result.returncode == 0 and
            'org.freedesktop.portal.ScreenCast' in result.stdout
        )
    except Exception as e:
        logger.debug(f"ScreenCast Portal check failed: {e}")
        _SCREENCAST_AVAILABLE = False
    
    if _SCREENCAST_AVAILABLE:
        logger.info("ScreenCast Portal available - flash-free captures enabled (pipewiresrc verified)")
    else:
        logger.debug("ScreenCast Portal not available - will use alternative capture methods")
    
    return _SCREENCAST_AVAILABLE


def _capture_screencast():
    """Capture screenshot via ScreenCast Portal (NO FLASH).
    
    This uses the ScreenCast portal which is designed for screen recording/sharing
    (used by Teams, Zoom, OBS). We capture a single frame from the video stream.
    
    Why this doesn't flash:
    - ScreenCast uses GNOME Shell's video capture path, NOT screenshot service
    - Video capture doesn't trigger ScreenshotService._flashAsync()
    - Result is identical PNG but without the camera flash animation
    
    Flow:
    1. Check for cached session (to avoid repeated consent dialogs)
    2. If no cache: Create ScreenCast session
    3. Select monitor as source
    4. Start capture (shows consent dialog on first run only)
    5. Open PipeWire connection
    6. Use GStreamer to extract single frame
    7. Save as PNG and cache session
    
    Returns PIL.Image on success, None on failure.
    """
    global _SCREENCAST_SESSION_CACHE
    
    if not _check_screencast_available():
        return None
    
    try:
        import gi
        gi.require_version('Gio', '2.0')
        gi.require_version('GLib', '2.0')
        from gi.repository import Gio, GLib
        
        # Try to load restore token from disk first (persistent across app restarts)
        if not _SCREENCAST_SESSION_CACHE.get('restore_token'):
            saved_token_data = _load_restore_token()
            if saved_token_data and saved_token_data.get('restore_token'):
                _SCREENCAST_SESSION_CACHE['restore_token'] = saved_token_data['restore_token']
                _SCREENCAST_SESSION_CACHE['session_handle'] = saved_token_data.get('session_handle')
                _SCREENCAST_SESSION_CACHE['node_id'] = saved_token_data.get('node_id')
                logger.info("Loaded persistent ScreenCast session from restore token")
        
        # Try to reuse cached session first (avoids repeated consent dialogs)
        if (_SCREENCAST_SESSION_CACHE['session_handle'] and 
            _SCREENCAST_SESSION_CACHE['node_id']):
            
            logger.debug("Attempting to reuse cached ScreenCast session (no consent needed)")
            
            try:
                bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
                proxy = Gio.DBusProxy.new_sync(
                    bus,
                    Gio.DBusProxyFlags.NONE,
                    None,
                    'org.freedesktop.portal.Desktop',
                    '/org/freedesktop/portal/desktop',
                    'org.freedesktop.portal.ScreenCast',
                    None
                )
                
                # Try to open new PipeWire connection with cached session
                result = proxy.call_with_unix_fd_list_sync(
                    'OpenPipeWireRemote',
                    GLib.Variant('(oa{sv})', (_SCREENCAST_SESSION_CACHE['session_handle'], {})),
                    Gio.DBusCallFlags.NONE,
                    -1,
                    None,
                    None
                )
                
                fd_list = result[1]
                fd_index = result[0].unpack()[0]
                pipewire_fd = fd_list.get(fd_index)
                
                logger.debug(f"Reused session PipeWire fd: {pipewire_fd}")
                
                # Capture frame with cached node_id
                output_path = _capture_frame_with_gstreamer(pipewire_fd, _SCREENCAST_SESSION_CACHE['node_id'])
                
                if output_path and os.path.exists(output_path):
                    im = _PILImage.open(output_path)
                    im.load()
                    
                    try:
                        os.unlink(output_path)
                    except:
                        pass
                    
                    # Validate not all-black
                    import array as _array
                    bands = im.split()
                    if any(max(_array.array('B', b.tobytes())) > 0 for b in bands):
                        logger.info("ScreenCast: Successfully reused session - no permission dialog needed")
                        return im.copy()
                
            except Exception as e:
                import traceback
                logger.warning(
                    f"Cached ScreenCast session reuse failed: {e.__class__.__name__}: {e}\n"
                    f"Session handle: {_SCREENCAST_SESSION_CACHE['session_handle']}\n"
                    f"Node ID: {_SCREENCAST_SESSION_CACHE['node_id']}\n"
                    f"This is expected after system restarts or long idle periods.\n"
                    f"Will create new session (may require user consent).\n"
                    f"Traceback: {traceback.format_exc()[:500]}"
                )
                # Clear in-memory cache but keep restore token on disk for next attempt
                _SCREENCAST_SESSION_CACHE = {
                    'session_handle': None,
                    'pipewire_fd': None,
                    'node_id': None,
                    'restore_token': _SCREENCAST_SESSION_CACHE.get('restore_token')  # Preserve restore token
                }
        
        # No cache or cache failed - create new session
        logger.debug("Creating new ScreenCast session")
        
        # State for async operation
        session_state = {
            'session_handle': None,
            'pipewire_fd': None,
            'node_id': None,
            'error': None,
            'step': 'init'
        }
        
        loop = GLib.MainLoop()
        bus = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        sender = bus.get_unique_name()[1:].replace('.', '_')
        
        def on_create_session_response(connection, sender_name, object_path, 
                                      interface_name, signal_name, parameters, user_data):
            """Handle CreateSession response"""
            try:
                response_code = parameters[0]
                results = parameters[1]
                
                if response_code == 0:
                    session_state['session_handle'] = results['session_handle']
                    session_state['step'] = 'session_created'
                    logger.debug(f"ScreenCast session created: {session_state['session_handle']}")
                    # Continue to select sources
                    GLib.idle_add(_select_sources)
                else:
                    session_state['error'] = f"CreateSession failed: response {response_code}"
                    loop.quit()
            except Exception as e:
                session_state['error'] = f"CreateSession error: {e}"
                loop.quit()
        
        def on_select_sources_response(connection, sender_name, object_path,
                                       interface_name, signal_name, parameters, user_data):
            """Handle SelectSources response"""
            try:
                response_code = parameters[0]
                
                if response_code == 0:
                    session_state['step'] = 'sources_selected'
                    logger.debug("ScreenCast sources selected")
                    # Continue to start
                    GLib.idle_add(_start_capture)
                else:
                    session_state['error'] = f"SelectSources failed: response {response_code}"
                    loop.quit()
            except Exception as e:
                session_state['error'] = f"SelectSources error: {e}"
                loop.quit()
        
        def on_start_response(connection, sender_name, object_path,
                            interface_name, signal_name, parameters, user_data):
            """Handle Start response"""
            try:
                response_code = parameters[0]
                results = parameters[1]
                
                if response_code == 0:
                    # Extract streams information (contains node_id)
                    if 'streams' in results:
                        streams = results['streams']
                        if streams:
                            # Get first stream's node_id
                            first_stream = streams[0]
                            node_id = first_stream[0]  # First element is node_id
                            session_state['node_id'] = node_id
                            logger.debug(f"ScreenCast stream node_id: {node_id}")
                    
                    # Extract and save restore_token for persistent sessions
                    if 'restore_token' in results:
                        restore_token = results['restore_token']
                        session_state['restore_token'] = restore_token
                        logger.info(f"ScreenCast: Received restore token for persistent session")
                        # Save to disk immediately for use across app restarts
                        _save_restore_token(
                            restore_token,
                            session_handle=session_state.get('session_handle'),
                            node_id=session_state.get('node_id')
                        )
                    else:
                        logger.warning("ScreenCast: No restore_token in Start response - session may not persist")
                    
                    session_state['step'] = 'started'
                    logger.debug("ScreenCast capture started")
                    # Continue to open PipeWire
                    GLib.idle_add(_open_pipewire)
                elif response_code == 1:
                    session_state['error'] = "User denied consent"
                    logger.info("ScreenCast: User denied screen sharing permission")
                    loop.quit()
                else:
                    session_state['error'] = f"Start failed: response {response_code}"
                    logger.warning(f"ScreenCast Start failed with response code {response_code}")
                    loop.quit()
            except Exception as e:
                session_state['error'] = f"Start error: {e}"
                logger.error(f"ScreenCast Start response handler error: {e}")
                loop.quit()
        
        def _create_session():
            """Step 1: Create ScreenCast session"""
            try:
                request_token = _generate_portal_token()
                session_token = _generate_portal_token()
                request_path = f'/org/freedesktop/portal/desktop/request/{sender}/{request_token}'
                
                # Subscribe to response
                bus.signal_subscribe(
                    'org.freedesktop.portal.Desktop',
                    'org.freedesktop.portal.Request',
                    'Response',
                    request_path,
                    None,
                    Gio.DBusSignalFlags.NONE,
                    on_create_session_response,
                    None
                )
                
                proxy = Gio.DBusProxy.new_sync(
                    bus,
                    Gio.DBusProxyFlags.NONE,
                    None,
                    'org.freedesktop.portal.Desktop',
                    '/org/freedesktop/portal/desktop',
                    'org.freedesktop.portal.ScreenCast',
                    None
                )
                
                options = {
                    'handle_token': GLib.Variant('s', request_token),
                    'session_handle_token': GLib.Variant('s', session_token),
                    # persist_mode: 2 = persist until explicitly revoked by user
                    # This allows sessions to survive app restarts and avoids repeated permission dialogs
                    'persist_mode': GLib.Variant('u', 2)
                }
                
                # If we have a restore token from previous session, try to use it
                if _SCREENCAST_SESSION_CACHE.get('restore_token'):
                    options['restore_token'] = GLib.Variant('s', _SCREENCAST_SESSION_CACHE['restore_token'])
                    logger.info("CreateSession: Using restore token from previous session")
                
                proxy.call(
                    'CreateSession',
                    GLib.Variant('(a{sv})', (options,)),
                    Gio.DBusCallFlags.NONE,
                    -1,
                    None,
                    None,
                    None
                )
                logger.debug("ScreenCast CreateSession called")
                return False  # Don't repeat idle callback
            except Exception as e:
                session_state['error'] = f"CreateSession call failed: {e}"
                loop.quit()
                return False
        
        def _select_sources():
            """Step 2: Select monitor as source"""
            try:
                request_token = _generate_portal_token()
                request_path = f'/org/freedesktop/portal/desktop/request/{sender}/{request_token}'
                
                # Subscribe to response
                bus.signal_subscribe(
                    'org.freedesktop.portal.Desktop',
                    'org.freedesktop.portal.Request',
                    'Response',
                    request_path,
                    None,
                    Gio.DBusSignalFlags.NONE,
                    on_select_sources_response,
                    None
                )
                
                proxy = Gio.DBusProxy.new_sync(
                    bus,
                    Gio.DBusProxyFlags.NONE,
                    None,
                    'org.freedesktop.portal.Desktop',
                    '/org/freedesktop/portal/desktop',
                    'org.freedesktop.portal.ScreenCast',
                    None
                )
                
                options = {
                    'handle_token': GLib.Variant('s', request_token),
                    'types': GLib.Variant('u', 1),  # 1 = Monitor
                    'multiple': GLib.Variant('b', False),
                    'cursor_mode': GLib.Variant('u', 1)  # 1 = Hidden
                }
                
                proxy.call(
                    'SelectSources',
                    GLib.Variant('(oa{sv})', (session_state['session_handle'], options)),
                    Gio.DBusCallFlags.NONE,
                    -1,
                    None,
                    None,
                    None
                )
                logger.debug("ScreenCast SelectSources called")
                return False
            except Exception as e:
                session_state['error'] = f"SelectSources call failed: {e}"
                loop.quit()
                return False
        
        def _start_capture():
            """Step 3: Start capture (may show consent dialog)"""
            try:
                request_token = _generate_portal_token()
                request_path = f'/org/freedesktop/portal/desktop/request/{sender}/{request_token}'
                
                # Subscribe to response
                bus.signal_subscribe(
                    'org.freedesktop.portal.Desktop',
                    'org.freedesktop.portal.Request',
                    'Response',
                    request_path,
                    None,
                    Gio.DBusSignalFlags.NONE,
                    on_start_response,
                    None
                )
                
                proxy = Gio.DBusProxy.new_sync(
                    bus,
                    Gio.DBusProxyFlags.NONE,
                    None,
                    'org.freedesktop.portal.Desktop',
                    '/org/freedesktop/portal/desktop',
                    'org.freedesktop.portal.ScreenCast',
                    None
                )
                
                options = {
                    'handle_token': GLib.Variant('s', request_token)
                }
                
                proxy.call(
                    'Start',
                    GLib.Variant('(osa{sv})', (session_state['session_handle'], '', options)),
                    Gio.DBusCallFlags.NONE,
                    -1,
                    None,
                    None,
                    None
                )
                logger.debug("ScreenCast Start called")
                return False
            except Exception as e:
                session_state['error'] = f"Start call failed: {e}"
                loop.quit()
                return False
        
        def _open_pipewire():
            """Step 4: Open PipeWire connection"""
            try:
                proxy = Gio.DBusProxy.new_sync(
                    bus,
                    Gio.DBusProxyFlags.NONE,
                    None,
                    'org.freedesktop.portal.Desktop',
                    '/org/freedesktop/portal/desktop',
                    'org.freedesktop.portal.ScreenCast',
                    None
                )
                
                result = proxy.call_with_unix_fd_list_sync(
                    'OpenPipeWireRemote',
                    GLib.Variant('(oa{sv})', (session_state['session_handle'], {})),
                    Gio.DBusCallFlags.NONE,
                    -1,
                    None,
                    None
                )
                
                fd_list = result[1]
                fd_index = result[0].unpack()[0]
                session_state['pipewire_fd'] = fd_list.get(fd_index)
                session_state['step'] = 'pipewire_opened'
                
                logger.debug(f"PipeWire fd opened: {session_state['pipewire_fd']}")
                loop.quit()
                return False
            except Exception as e:
                session_state['error'] = f"OpenPipeWire failed: {e}"
                loop.quit()
                return False
        
        def on_timeout():
            """Handle timeout"""
            if session_state['step'] == 'init':
                session_state['error'] = "Timeout creating session"
            elif session_state['step'] in ('session_created', 'sources_selected'):
                session_state['error'] = "Timeout waiting for consent"
            else:
                session_state['error'] = f"Timeout at step: {session_state['step']}"
            loop.quit()
            return False
        
        # Set timeout (30 seconds for user consent)
        GLib.timeout_add_seconds(30, on_timeout)
        
        # Start the async flow
        GLib.idle_add(_create_session)
        
        # Run event loop
        loop.run()
        
        # Check for errors
        if session_state['error']:
            logger.debug(f"ScreenCast capture failed: {session_state['error']}")
            return None
        
        if not session_state['pipewire_fd']:
            logger.warning("ScreenCast: No PipeWire fd obtained")
            return None
        
        if not session_state.get('node_id'):
            logger.warning("ScreenCast: No stream node_id obtained")
            return None
        
        # Step 5: Capture frame with GStreamer
        output_path = _capture_frame_with_gstreamer(session_state['pipewire_fd'], session_state['node_id'])
        
        if not output_path or not os.path.exists(output_path):
            logger.warning("ScreenCast: GStreamer capture failed")
            return None
        
        # Read the image
        im = _PILImage.open(output_path)
        im.load()
        
        # Cleanup
        try:
            os.unlink(output_path)
        except:
            pass
        
        # Validate not all-black
        import array as _array
        bands = im.split()
        if any(max(_array.array('B', b.tobytes())) > 0 for b in bands):
            logger.info("Linux capture: ScreenCast Portal (NO FLASH, NO SOUND)")
            
            # Cache session info for future captures (avoids repeated consent dialogs)
            _SCREENCAST_SESSION_CACHE['session_handle'] = session_state['session_handle']
            _SCREENCAST_SESSION_CACHE['node_id'] = session_state['node_id']
            if 'restore_token' in session_state:
                _SCREENCAST_SESSION_CACHE['restore_token'] = session_state['restore_token']
                logger.info("ScreenCast session cached with restore token - permission will persist")
            else:
                logger.info("ScreenCast session cached for reuse (no restore token)")
            
            return im.copy()
        
        logger.warning("ScreenCast screenshot all-black — skipping")
        return None
        
    except ImportError as e:
        logger.debug(f"ScreenCast unavailable: {e}")
        return None
    except Exception as e:
        logger.debug(f"ScreenCast capture error: {e}")
        return None


def _capture_frame_with_gstreamer(pipewire_fd, node_id):
    """Capture single frame from PipeWire using GStreamer.
    
    Args:
        pipewire_fd: PipeWire file descriptor from OpenPipeWireRemote
        node_id: PipeWire stream node ID
        
    Returns:
        str: Path to captured PNG file, or None on failure
    """
    if not _GSTREAMER_AVAILABLE:
        return None
    
    try:
        from gi.repository import Gst, GLib
        
        # Create temp output file
        fd, output_path = tempfile.mkstemp(suffix='.png', prefix='screencast_')
        os.close(fd)
        
        # Build GStreamer pipeline
        # Use path property with node_id instead of fd
        pipeline_str = (
            f'pipewiresrc fd={pipewire_fd} path={node_id} do-timestamp=true ! '
            f'videoconvert ! '
            f'pngenc ! '
            f'filesink location={output_path}'
        )
        
        # State for async capture
        capture_state = {
            'success': False,
            'error': None,
            'playing': False,
            'frames_captured': 0
        }
        
        loop = GLib.MainLoop()
        
        def on_message(bus, message):
            """Handle GStreamer bus messages"""
            t = message.type
            
            if t == Gst.MessageType.EOS:
                logger.debug("GStreamer: End of stream")
                capture_state['success'] = True
                loop.quit()
            elif t == Gst.MessageType.ERROR:
                err, debug = message.parse_error()
                capture_state['error'] = f"GStreamer error: {err.message}"
                logger.debug(f"GStreamer error: {err.message} (debug: {debug})")
                loop.quit()
            elif t == Gst.MessageType.STATE_CHANGED:
                if message.src == pipeline:
                    old_state, new_state, pending = message.parse_state_changed()
                    if new_state == Gst.State.PLAYING:
                        logger.debug("GStreamer: Pipeline playing")
                        capture_state['playing'] = True
                        # Schedule stop after 3 seconds of playing
                        GLib.timeout_add(3000, stop_pipeline)
            elif t == Gst.MessageType.STREAM_START:
                logger.debug("GStreamer: Stream started")
            elif t == Gst.MessageType.ASYNC_DONE:
                logger.debug("GStreamer: Async done")
            
            return True
        
        def stop_pipeline():
            """Stop pipeline after capturing frame"""
            if not capture_state['playing']:
                logger.debug("GStreamer: Not playing yet, waiting...")
                return True  # Try again
            
            logger.debug("GStreamer: Stopping pipeline after frame capture")
            pipeline.send_event(Gst.Event.new_eos())
            return False  # Don't repeat
        
        # Create pipeline
        try:
            pipeline = Gst.parse_launch(pipeline_str)
        except Exception as e:
            logger.warning(f"GStreamer: Failed to create pipeline: {e}")
            return None
        
        # Set up message bus BEFORE starting pipeline
        bus = pipeline.get_bus()
        bus.add_signal_watch()
        bus.connect('message', on_message)
        
        # Start pipeline
        ret = pipeline.set_state(Gst.State.PLAYING)
        if ret == Gst.StateChangeReturn.FAILURE:
            # Don't return immediately - wait to see actual error on bus
            logger.warning("GStreamer: State change returned FAILURE, waiting for error message...")
            
            # Set short timeout to get error details
            def on_early_timeout():
                if not capture_state['error']:
                    capture_state['error'] = "Pipeline state change failed with no error details"
                loop.quit()
                return False
            
            GLib.timeout_add(2000, on_early_timeout)
        elif ret == Gst.StateChangeReturn.ASYNC:
            logger.debug("GStreamer: State change is async, waiting...")
        elif ret == Gst.StateChangeReturn.SUCCESS:
            logger.debug("GStreamer: Pipeline set to playing immediately")
        
        # Timeout after 15 seconds
        def on_timeout():
            capture_state['error'] = "GStreamer capture timeout (15s)"
            logger.warning("GStreamer: Capture timeout - PipeWire stream may not be ready")
            pipeline.set_state(Gst.State.NULL)
            loop.quit()
            return False
        
        GLib.timeout_add_seconds(15, on_timeout)
        
        # Run event loop
        loop.run()
        
        # Cleanup
        pipeline.set_state(Gst.State.NULL)
        bus.remove_signal_watch()
        
        # Check result
        if capture_state['error']:
            logger.debug(f"GStreamer capture failed: {capture_state['error']}")
            try:
                os.unlink(output_path)
            except:
                pass
            return None
        
        if capture_state['success'] and os.path.exists(output_path) and os.path.getsize(output_path) > 0:
            logger.debug(f"GStreamer: Frame captured ({os.path.getsize(output_path)} bytes)")
            return output_path
        
        logger.debug("GStreamer: No frame captured or file empty")
        try:
            os.unlink(output_path)
        except:
            pass
        return None
        
    except Exception as e:
        logger.debug(f"GStreamer frame capture error: {e}")
        return None


def _capture_gnome_screenshot_muted():
    """Capture via gnome-screenshot with the GNOME shutter sound suppressed.

    When org.gnome.Shell.Screenshot.Screenshot(flash=false) is denied
    (GNOME 46+ strict access control), this function falls back to the
    gnome-screenshot binary.  gnome-screenshot defaults to flash=true which
    causes GNOME Shell to play the camera-shutter sound via libcanberra.

    Workaround: temporarily set org.gnome.desktop.sound event-sounds to false
    via GSettings before invoking gnome-screenshot, then immediately restore
    the previous value.  The GSettings change propagates to GNOME Shell's
    canberra context before the screenshot D-Bus call is made, so the
    `screen-capture` sound event is suppressed.

    The mute window is < 300 ms — shorter than any user-perceptible audio gap.
    The original setting is always restored in a try/finally block.

    Returns PIL.Image on success, None on failure.
    """
    # --- Step 1: Read current event-sounds value so we can restore it ---
    sounds_were_on = True  # conservative default: assume sounds were on
    try:
        res = subprocess.run(
            ['gsettings', 'get', 'org.gnome.desktop.sound', 'event-sounds'],
            capture_output=True, text=True, timeout=1
        )
        sounds_were_on = res.stdout.strip() == 'true'
    except Exception:
        sounds_were_on = False  # couldn't read → don't try to restore

    # --- Step 2: Temporarily mute event sounds ---
    muted = False
    if sounds_were_on:
        try:
            subprocess.run(
                ['gsettings', 'set', 'org.gnome.desktop.sound', 'event-sounds', 'false'],
                capture_output=True, timeout=1, check=True
            )
            muted = True
        except Exception as e:
            logger.debug(f"Could not mute event-sounds: {e}")

    # --- Step 3: Take screenshot and restore sound in all cases ---
    try:
        return _capture_gnome_screenshot()
    finally:
        if muted:
            try:
                subprocess.run(
                    ['gsettings', 'set', 'org.gnome.desktop.sound', 'event-sounds', 'true'],
                    capture_output=True, timeout=1
                )
            except Exception as e:
                logger.warning(f"Could not restore event-sounds: {e}")


def _capture_linux():
    """Capture the full screen on Linux.

    On GNOME/Wayland, scrot and Pillow XCB capture via XWayland whose root
    window is entirely black (the compositor does not expose Wayland content
    through XComposite).  gnome-screenshot uses the GNOME Shell D-Bus
    screenshot service, which has access to the Wayland compositor buffers
    and produces a real, pixel-accurate screenshot.

    Fallback order (flash-free methods prioritized):

    Wayland session:
      1. ScreenCast Portal — PipeWire video capture, NO FLASH. Uses screen
         recording API to capture single frame. Requires one-time consent.
      2. XDG Desktop Portal Screenshot — Standard freedesktop.org API, but
         HAS FLASH on GNOME. May show one-time consent dialog.
      3. GNOME Screenshot D-Bus (silent) — flash=false, no shutter sound.
         Works when org.gnome.Shell.Screenshot is accessible (GNOME < 46 or
         relaxed security policy).
      4. gnome-screenshot + event-sounds muted — uses the gnome-screenshot
         binary but temporarily sets org.gnome.desktop.sound event-sounds to
         false to suppress the camera-shutter sound.  VISUAL FLASH MAY OCCUR.
      5. scrot                           — X11 / XWayland fallback; all-black
                on pure Wayland (checked and skipped).
      6. Pillow XCB                      — last resort; same caveat as scrot.

    X11 session:
      1. scrot                         — pure X11, fast, no snap issues.
      2. Pillow XCB                    — fallback when scrot is absent.
    
    Phase 4: Enhanced with comprehensive diagnostics logging for compatibility issues.
    """
    is_wayland = _is_wayland_session()
    methods_tried = []

    if is_wayland:
        # --- Wayland Method 1: ScreenCast Portal (NO FLASH) ---
        if _check_screencast_available():
            img = _capture_screencast()
            if img is not None:
                methods_tried.append("screencast: SUCCESS")
                return img
            methods_tried.append("screencast: failed (capture returned None)")
        else:
            # Log specific reasons why ScreenCast is unavailable
            if not _GSTREAMER_AVAILABLE:
                methods_tried.append("screencast: SKIP (GStreamer not available)")
                logger.debug("[ScreenCapture] ScreenCast unavailable: GStreamer (gst-launch-1.0) not found")
            else:
                # Check pipewiresrc specifically
                try:
                    result = subprocess.run(['gst-inspect-1.0', 'pipewiresrc'], capture_output=True, timeout=3)
                    if result.returncode != 0:
                        methods_tried.append("screencast: SKIP (gstreamer1.0-pipewire not installed)")
                        logger.warning("[ScreenCapture] ScreenCast unavailable: gstreamer1.0-pipewire not installed")
                        logger.info("[ScreenCapture] FIX: sudo apt install gstreamer1.0-pipewire")
                except Exception:
                    methods_tried.append("screencast: SKIP (pipewiresrc check failed)")
        
        # --- Wayland Method 2: XDG Desktop Portal Screenshot (HAS FLASH) ---
        img = _capture_xdg_portal()
        if img is not None:
            methods_tried.append("xdg_portal: SUCCESS (with flash)")
            return img
        methods_tried.append("xdg_portal: failed")
        
        # --- Wayland Method 3: GNOME D-Bus (flash=false, silent) ---
        img = _capture_gnome_dbus_silent()
        if img is not None:
            methods_tried.append("gnome_dbus_silent: SUCCESS")
            return img
        methods_tried.append("gnome_dbus_silent: failed")
        
        # --- Wayland Method 4: gnome-screenshot (muted sound, flash may occur) ---
        img = _capture_gnome_screenshot_muted()
        if img is not None:
            methods_tried.append("gnome_screenshot_muted: SUCCESS (flash may occur)")
            logger.debug("Linux capture: gnome-screenshot (muted) — flash may occur")
            return img
        methods_tried.append("gnome_screenshot_muted: failed")

    # --- Method 2: scrot (X11 / XWayland) ---
    if shutil.which('scrot'):
        fh, filepath = tempfile.mkstemp('.png')
        os.close(fh)
        os.unlink(filepath)   # scrot won't overwrite an existing file
        try:
            result = subprocess.run(
                ['scrot', '--silent', filepath],
                capture_output=True, timeout=5
            )
            if result.returncode == 0 and os.path.exists(filepath):
                im = _PILImage.open(filepath)
                im.load()   # read into memory before the temp file is deleted
                # On Wayland, scrot captures the XWayland root which is black.
                # Detect and skip those to avoid feeding blank images to OCR.
                import array as _array
                bands = im.split()
                if any(max(_array.array('B', b.tobytes())) > 0 for b in bands):
                    methods_tried.append("scrot: SUCCESS")
                    logger.debug("Linux capture: scrot")
                    return im.copy()
                methods_tried.append("scrot: all-black image (Wayland XWayland root)")
                logger.warning("scrot produced an all-black image (Wayland XWayland root) — skipping")
            else:
                methods_tried.append(f"scrot: failed (rc={result.returncode})")
                logger.warning(f"scrot exited with rc={result.returncode}: {result.stderr[:200]}")
        except (subprocess.TimeoutExpired, Exception) as e:
            methods_tried.append(f"scrot: failed ({type(e).__name__})")
            logger.warning(f"scrot capture failed: {e}")
        finally:
            try:
                os.unlink(filepath)
            except OSError:
                pass
    else:
        methods_tried.append("scrot: not installed")

    # --- Method 3: Pillow XCB (only when confirmed available) ---
    try:
        if getattr(_PILImage.core, 'HAVE_XCB', False):
            img = ImageGrab.grab()
            methods_tried.append("pillow_xcb: SUCCESS")
            logger.debug("Linux capture: Pillow XCB")
            return img
        else:
            methods_tried.append("pillow_xcb: not available (HAVE_XCB=False)")
    except Exception as e:
        methods_tried.append(f"pillow_xcb: failed ({type(e).__name__})")
        logger.warning(f"ImageGrab.grab() (XCB) failed: {e}")

    # Phase 4: Log all methods tried when capture fails
    logger.error("[ScreenCapture] ALL METHODS FAILED - returning None")
    logger.error(f"[ScreenCapture] Session: {'Wayland' if is_wayland else 'X11'}")
    logger.error(f"[ScreenCapture] Methods tried: {', '.join(methods_tried)}")
    
    if is_wayland:
        logger.error("[ScreenCapture] WAYLAND CAPTURE TROUBLESHOOTING:")
        logger.error("[ScreenCapture]   1. Install gstreamer1.0-pipewire: sudo apt install gstreamer1.0-pipewire")
        logger.error("[ScreenCapture]   2. Ensure PipeWire is running: systemctl --user status pipewire")
        logger.error("[ScreenCapture]   3. Grant ScreenCast permission when prompted")
    
    return None


def capture_focused_monitor():
    """Capture the monitor containing the current foreground window.
    
    Privacy-safe fallback hierarchy (P0-2):
        Tier 1: Focused-monitor capture (foreground window's monitor)
        Tier 2: Primary monitor capture (deterministic, single monitor)
        Tier 3: Skip capture (return None), log reason
    
    Under NO automatic fallback does this function capture more monitors
    than the originally targeted one.
    
    Returns:
        PIL.Image or None. Returns None only for Tier 3 (skip) — callers
        must handle None by continuing metadata-only tracking.
    """
    _capture_stats['total'] += 1

    # Non-Windows: use Linux-specific capture (P1-5)
    if not _WIN32_AVAILABLE:
        return _capture_linux()

    # --- Tier 1: Focused-monitor capture ---
    hwnd = _get_stable_foreground_hwnd()

    if hwnd:
        # Skip minimized windows — no meaningful "focused monitor" (P0-4)
        if _is_minimized(hwnd):
            logger.debug(f"Foreground window 0x{hwnd:X} is minimized — Tier 3 skip")
            _capture_stats['tier3_skipped'] += 1
            return None

        # Skip cloaked UWP windows (P0-4)
        if _is_cloaked(hwnd):
            logger.debug(f"Foreground window 0x{hwnd:X} is cloaked — Tier 3 skip")
            _capture_stats['tier3_skipped'] += 1
            return None

        # Resolve monitor
        mon_rect = _resolve_monitor_for_hwnd(hwnd)
        if mon_rect:
            try:
                # all_screens=True is REQUIRED — without it Pillow clamps bbox
                # to the primary monitor, defeating the purpose for non-primary.
                screenshot = ImageGrab.grab(bbox=mon_rect, all_screens=True)
                _capture_stats['tier1_focused'] += 1
                return screenshot
            except Exception as e:
                logger.warning(f"Tier 1 focused-monitor grab failed: {e}")
                # Fall through to Tier 2

    # --- Tier 2: Primary monitor capture (privacy-safe fallback) ---
    primary_rect = _get_primary_monitor_rect()
    if primary_rect:
        try:
            screenshot = ImageGrab.grab(bbox=primary_rect, all_screens=True)
            _capture_stats['tier2_primary'] += 1
            logger.debug("Capture fell back to Tier 2 (primary monitor)")
            return screenshot
        except Exception as e:
            logger.warning(f"Tier 2 primary-monitor grab failed: {e}")

    # Last resort: bare grab (primary monitor, legacy behavior)
    try:
        screenshot = ImageGrab.grab()
        _capture_stats['tier2_primary'] += 1
        logger.debug("Capture fell back to Tier 2 (bare grab)")
        return screenshot
    except Exception:
        pass

    # --- Tier 3: Skip capture entirely ---
    _capture_stats['tier3_skipped'] += 1
    logger.info("Tier 3: All capture paths failed — skipping this tick")
    return None


# ============================================================================
# PUBLIC API: FOCUSED-MONITOR WORK RECT (for popup placement, P2-14)
# ============================================================================

def get_focused_monitor_work_rect(fallback=None):
    """Return the work area (excludes taskbar) of the focused monitor.
    
    Used for positioning popups on the correct monitor.
    
    Args:
        fallback: tuple (left, top, right, bottom) to return on failure.
    
    Returns:
        tuple (left, top, right, bottom) of the work area.
    """
    if not _WIN32_AVAILABLE:
        return fallback

    hwnd = _get_stable_foreground_hwnd()
    if not hwnd:
        return fallback

    try:
        hmon = win32api.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
        info = win32api.GetMonitorInfo(hmon)
        return info["Work"]
    except Exception:
        return fallback


# ============================================================================
# RDP SESSION DETECTION (P1-7)
# ============================================================================

def is_rdp_session():
    """Detect if the app is running inside a Remote Desktop session."""
    if not _WIN32_AVAILABLE:
        return False
    try:
        SM_REMOTESESSION = 0x1000
        return bool(ctypes.windll.user32.GetSystemMetrics(SM_REMOTESESSION))
    except Exception:
        return False


def log_display_environment():
    """Log the current display environment for support diagnostics.
    Call once at startup."""
    if not _WIN32_AVAILABLE:
        import sys as _sys
        session_type = os.environ.get('XDG_SESSION_TYPE', 'unknown')
        wayland = os.environ.get('WAYLAND_DISPLAY', '')
        display = os.environ.get('DISPLAY', '')
        logger.info(
            f"Display environment: Linux, session={session_type}, "
            f"DISPLAY={display!r}, WAYLAND_DISPLAY={wayland!r}"
        )
        logger.info(
            f"Screenshot backend: "
            f"gnome-screenshot={'available' if shutil.which('gnome-screenshot') else 'not found'}, "
            f"scrot={'available' if shutil.which('scrot') else 'not found'}, "
            f"PIL_XCB={getattr(_PILImage.core, 'HAVE_XCB', False)}"
        )
        return

    try:
        monitors = win32api.EnumDisplayMonitors(None, None)
        logger.info(f"Display environment: {len(monitors)} monitor(s) detected")
        for i, (hmon, _, _) in enumerate(monitors):
            info = win32api.GetMonitorInfo(hmon)
            rect = info["Monitor"]
            flags = info.get("Flags", 0)
            primary = " [PRIMARY]" if (flags & 1) else ""
            device = info.get("Device", "unknown")
            logger.info(
                f"  Monitor {i}: {device} rect={rect} "
                f"({rect[2]-rect[0]}x{rect[3]-rect[1]}){primary}"
            )
    except Exception as e:
        logger.warning(f"Could not enumerate monitors: {e}")

    if is_rdp_session():
        logger.info("Running inside RDP session — monitor geometry may be virtual")

    logger.info(f"DPI awareness set: {_DPI_AWARENESS_SET}")
    logger.info("Multi-monitor focused capture: always active")
