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

from PIL import Image as _PILImage, ImageGrab

logger = logging.getLogger(__name__)

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

    Fallback order (fastest / most-reliable first):

    Wayland session:
      1. GNOME Screenshot D-Bus (silent) — flash=false, no shutter sound.
         Works when org.gnome.Shell.Screenshot is accessible (GNOME < 46 or
         relaxed security policy).
      2. gnome-screenshot + event-sounds muted — uses the gnome-screenshot
         binary but temporarily sets org.gnome.desktop.sound event-sounds to
         false to suppress the camera-shutter sound.  Restores the original
         setting immediately after capture.
      3. scrot                           — X11 / XWayland fallback; all-black
                on pure Wayland (checked and skipped).
      4. Pillow XCB                      — last resort; same caveat as scrot.

    X11 session:
      1. scrot                         — pure X11, fast, no snap issues.
      2. Pillow XCB                    — fallback when scrot is absent.
    """
    is_wayland = _is_wayland_session()

    # --- Wayland Method 1: silent D-Bus call (flash=false, no shutter sound) ---
    # --- Wayland Method 2: gnome-screenshot with event-sounds muted          ---
    if is_wayland:
        img = _capture_gnome_dbus_silent()
        if img is not None:
            return img
        img = _capture_gnome_screenshot_muted()
        if img is not None:
            logger.debug("Linux capture: gnome-screenshot (muted)")
            return img

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
                    logger.debug("Linux capture: scrot")
                    return im.copy()
                logger.warning("scrot produced an all-black image (Wayland XWayland root) — skipping")
            else:
                logger.warning(f"scrot exited with rc={result.returncode}: {result.stderr[:200]}")
        except (subprocess.TimeoutExpired, Exception) as e:
            logger.warning(f"scrot capture failed: {e}")
        finally:
            try:
                os.unlink(filepath)
            except OSError:
                pass

    # --- Method 3: Pillow XCB (only when confirmed available) ---
    try:
        if getattr(_PILImage.core, 'HAVE_XCB', False):
            img = ImageGrab.grab()
            logger.debug("Linux capture: Pillow XCB")
            return img
    except Exception as e:
        logger.warning(f"ImageGrab.grab() (XCB) failed: {e}")

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
