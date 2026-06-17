# Screenshot Capture & OCR Fix Plan
**Date:** 2026-06-17  
**Problem:** Both Suchith (Ubuntu 24.04 / GNOME 46) and Yogitha (Ubuntu 25.04 / GNOME 49) are stuck in **metadata-only mode** — OCR never fires because screenshot capture fails.  
**Root cause:** Wayland ScreenCast permission is not established at first run, AND `gstreamer1.0-pipewire` may be missing.

---

## Why the Current Code Does NOT Fix This

The OS Compatibility Phases 1–6 only improved **diagnostics and logging**. They did not change the capture flow. The capture chain still silently fails after ScreenCast → logs a warning → falls through to scrot/gnome-screenshot → gets a black image → OCR confidence = 0.00 → metadata-only.

```
Phase 4 only added:
  logger.warning("[ScreenCapture] ScreenCast unavailable: gstreamer1.0-pipewire not installed")
  logger.info("[ScreenCapture] FIX: sudo apt install gstreamer1.0-pipewire")
```
The user never sees this unless they actively read log files.

---

## Root Cause Per User

| User | System | Actual Failure | Required Fix |
|------|--------|---------------|--------------|
| Yogitha | Ubuntu 25.04 / GNOME 49 | `gstreamer1.0-pipewire` not installed → `_check_screencast_available()` returns False | Install package + grant permission |
| Suchith | Ubuntu 24.04 / GNOME 46 | `gstreamer1.0-pipewire` likely installed, but ScreenCast permission never granted (no `screencast_restore_token.json`) OR restore token expired/invalid | Re-trigger the XDG portal consent dialog |

The failure chain in both cases:
```
_check_screencast_available() → False  (missing plugin OR portal not available)
         ↓
_capture_xdg_portal()         → fails  (no permission / portal rejected)
         ↓
_capture_gnome_dbus_silent()  → fails  (GNOME 46+ access denied)
         ↓
_capture_gnome_screenshot_muted() → all-black image
         ↓
scrot → all-black image (XWayland root is black on Wayland)
         ↓
OCR receives black image → confidence 0.00 → "metadata" label
```

---

## Fix Strategy

Three parallel tracks are needed:

| Track | What | Who It Fixes |
|-------|------|-------------|
| **A** | Auto-install `gstreamer1.0-pipewire` on first launch (pkexec / guided UI) | Yogitha |
| **B** | ScreenCast onboarding: detect missing permission → guide user to grant it | Suchith + Yogitha |
| **C** | Proactive restore-token health-check: detect stale/missing token on startup → re-trigger consent silently | Suchith |

---

## Phase 1 — Package Auto-Detection & Guided Install (Track A)

### Goal
Detect at startup that `gstreamer1.0-pipewire` is missing and guide the user to install it **before** the first capture attempt, not after a failure.

### How It Works Today (Gap)
`SystemDependencyChecker.check_all()` already detects the missing plugin and the "Fix Screen Capture" web page shows the install command. **But the page is only opened if the user clicks the tray icon.** A fresh install user like Yogitha never does this.

### Changes Required

#### 1.1 `system_check.py` — Add `check_gstreamer_pipewire_installable()`
New method that distinguishes between:
- `gstreamer1.0-pipewire` not installed → show install guidance
- `gstreamer1.0-pipewire` installed but PipeWire daemon not running → show restart guidance

```python
def check_gstreamer_pipewire_installable(self) -> dict:
    """
    Returns a diagnostic dict:
    {
        'plugin_installed': bool,   # gstreamer1.0-pipewire pkg exists
        'plugin_loadable': bool,    # gst-inspect pipewiresrc returns 0
        'pipewire_running': bool,   # pipewire process in ps
        'action': str               # 'install' | 'restart' | 'ok' | 'unknown'
    }
    """
```

#### 1.2 `desktop_app.py` — Auto-open "Fix Screen Capture" on first launch
In `TimeTracker.__init__()`, after the existing dependency check block, add:

```python
# Phase 1 (OCR fix): Auto-open repair page on first run with missing deps
if (not self.screenshot_dependencies_ok and 
    not self._first_run_repair_shown and
    sys.platform.startswith('linux')):
    
    # Fire desktop notification with clickable action
    _linux_notify(
        "TimeTracker: Screen capture not working",
        "Click 'Fix Screen Capture' in the tray menu, or visit http://localhost:51777/fix-screen-capture",
        urgency="critical"
    )
    self._first_run_repair_shown = True
    # Also write a flag file so we re-open the repair page in the browser
    # when the web server is ready
    self._should_open_repair_page = True
```

In `run()`, after the web server starts and the user is authenticated, check `self._should_open_repair_page` and open the browser.

#### 1.3 `scripts/fix-screenshot-capture.sh` (new)
Shell script for terminal/SSH users:

```bash
#!/bin/bash
# TimeTracker: Fix Screenshot Capture
# Usage: bash scripts/fix-screenshot-capture.sh

set -e

# Detect distro
if [ -f /etc/os-release ]; then source /etc/os-release; fi

DISTRO_ID="${ID:-ubuntu}"

install_packages() {
    case "$DISTRO_ID" in
        ubuntu|debian|linuxmint|pop)
            sudo apt install -y gstreamer1.0-pipewire pipewire wireplumber \
                xdg-desktop-portal xdg-desktop-portal-gnome
            ;;
        fedora|rhel|centos|rocky|alma)
            sudo dnf install -y gstreamer1-plugin-pipewire pipewire wireplumber \
                xdg-desktop-portal xdg-desktop-portal-gnome
            ;;
        arch|manjaro|endeavouros)
            sudo pacman -S --noconfirm gst-plugin-pipewire pipewire wireplumber \
                xdg-desktop-portal xdg-desktop-portal-gnome
            ;;
        *)
            echo "Unknown distro: $DISTRO_ID. Please install manually:"
            echo "  gstreamer1.0-pipewire pipewire wireplumber xdg-desktop-portal"
            exit 1
            ;;
    esac
}

restart_services() {
    systemctl --user restart pipewire pipewire-pulse wireplumber || true
    sleep 1
    echo "PipeWire restarted."
}

check_result() {
    if gst-inspect-1.0 pipewiresrc &>/dev/null; then
        echo "✓ gstreamer pipewiresrc plugin: OK"
    else
        echo "✗ gstreamer pipewiresrc plugin: STILL MISSING"
        exit 1
    fi
    if pgrep -x pipewire &>/dev/null; then
        echo "✓ PipeWire daemon: running"
    else
        echo "✗ PipeWire daemon: not running"
    fi
}

echo "=== TimeTracker: Fix Screenshot Capture ==="
echo ""
echo "Step 1: Installing required packages..."
install_packages

echo ""
echo "Step 2: Restarting PipeWire services..."
restart_services

echo ""
echo "Step 3: Verifying installation..."
check_result

echo ""
echo "=== Done! ==="
echo "Now restart TimeTracker. When prompted, click 'Allow' on the screen sharing dialog."
```

---

## Phase 2 — ScreenCast Permission Onboarding Flow (Track B)

### Goal
When the app starts for the first time (or after the restore token is missing/expired), proactively trigger the XDG ScreenCast consent dialog **during the startup sequence** rather than silently failing on first capture.

### How the ScreenCast Permission Works
1. `_capture_screencast()` calls `CreateSession` → `SelectSources` → `Start` (shows GNOME consent dialog)
2. On `Start` response, GNOME returns a `restore_token` (if `persist_mode=2` was set)
3. Token is saved to `~/.config/timetracker/screencast_restore_token.json`
4. All future sessions use the restore token → no dialog

**The problem:** The consent dialog currently only fires when the first `capture_interval` (default 300s = 5 min) elapses. The user never knows they need to click anything.

### Changes Required

#### 2.1 `monitor_capture.py` — Add `request_screencast_permission()`
New public function that explicitly triggers the consent dialog:

```python
def request_screencast_permission(timeout_seconds: int = 60) -> dict:
    """
    Proactively request ScreenCast permission from the user.
    
    Triggers the GNOME portal consent dialog immediately so the user
    can grant permission before the first capture attempt.
    
    Returns:
        {
            'granted': bool,
            'restore_token': str or None,
            'node_id': int or None,
            'error': str or None,
            'already_had_permission': bool
        }
    """
    # 1. Check if we already have a valid restore token
    existing = _load_restore_token()
    if existing and existing.get('restore_token'):
        # Validate the existing token by attempting a quick capture
        img = _capture_screencast()
        if img is not None:
            return {
                'granted': True,
                'restore_token': existing['restore_token'],
                'node_id': existing.get('node_id'),
                'error': None,
                'already_had_permission': True
            }
        else:
            # Token is stale - clear it and re-request
            _clear_restore_token()
    
    # 2. pipewiresrc must be installed first
    if not _check_screencast_available():
        return {
            'granted': False,
            'restore_token': None,
            'node_id': None,
            'error': 'gstreamer1.0-pipewire not installed. Run fix-screenshot-capture.sh first.',
            'already_had_permission': False
        }
    
    # 3. Trigger the consent flow (reuse existing _capture_screencast logic)
    #    The GLib.MainLoop will block until the user accepts/denies or timeout
    img = _capture_screencast()
    
    token_data = _load_restore_token()
    if img is not None and token_data:
        return {
            'granted': True,
            'restore_token': token_data.get('restore_token'),
            'node_id': token_data.get('node_id'),
            'error': None,
            'already_had_permission': False
        }
    
    return {
        'granted': False,
        'restore_token': None,
        'node_id': None,
        'error': 'User denied permission or consent timed out',
        'already_had_permission': False
    }


def get_screencast_permission_status() -> dict:
    """
    Return current ScreenCast permission status without triggering dialog.
    
    Returns:
        {
            'has_token': bool,
            'token_age_days': float or None,
            'token_valid': bool,   # False if >30 days old
            'plugin_installed': bool,
            'portal_available': bool,
            'status': 'ready' | 'needs_permission' | 'missing_plugin' | 'no_portal'
        }
    """
    plugin_ok = _check_screencast_available()
    token_data = _load_restore_token()
    
    has_token = bool(token_data and token_data.get('restore_token'))
    token_age = None
    token_valid = False
    
    if token_data and 'saved_at' in token_data:
        token_age = (time.time() - token_data['saved_at']) / 86400
        token_valid = token_age < 30
    
    if not plugin_ok:
        status = 'missing_plugin'
    elif not has_token:
        status = 'needs_permission'
    elif not token_valid:
        status = 'needs_permission'  # token expired
    else:
        status = 'ready'
    
    return {
        'has_token': has_token,
        'token_age_days': token_age,
        'token_valid': token_valid,
        'plugin_installed': plugin_ok,
        'portal_available': _check_screencast_available(),
        'status': status
    }
```

#### 2.2 `desktop_app.py` — Call permission onboarding at startup
Add a new method `_onboard_screencast_permission()` called from `run()` after authentication:

```python
def _onboard_screencast_permission(self):
    """
    Phase 2 (OCR fix): Check ScreenCast permission at startup and guide user.
    
    Called once after authentication is confirmed. Does NOT block the main
    thread — runs in a background thread so the app remains responsive.
    Only triggers if:
      - Running on Linux/Wayland
      - gstreamer1.0-pipewire is installed
      - No valid restore token exists
    """
    if not sys.platform.startswith('linux'):
        return
    if not os.environ.get('WAYLAND_DISPLAY'):
        return  # X11 - scrot works fine
    
    from monitor_capture import get_screencast_permission_status, request_screencast_permission
    
    status = get_screencast_permission_status()
    
    if status['status'] == 'ready':
        if self.logger:
            self.logger.info("[ScreenCast] Permission already granted (valid restore token)")
        return
    
    if status['status'] == 'missing_plugin':
        # Already handled by system_check dep notification
        if self.logger:
            self.logger.warning("[ScreenCast] Cannot onboard: gstreamer1.0-pipewire not installed")
        return
    
    # status == 'needs_permission': trigger the consent dialog
    if self.logger:
        self.logger.info("[ScreenCast] No valid restore token found — requesting permission")
    
    _linux_notify(
        "TimeTracker: Screen capture setup",
        "Please click 'Allow' when the screen sharing dialog appears.",
        urgency="normal"
    )
    
    # Run in background thread so it doesn't block
    import threading
    def _request():
        result = request_screencast_permission(timeout_seconds=60)
        if result['granted']:
            if self.logger:
                self.logger.info("[ScreenCast] Permission granted — OCR will be active next capture")
            _linux_notify(
                "TimeTracker: Screen capture enabled",
                "Screen sharing permission granted. OCR is now active.",
                urgency="normal"
            )
        else:
            if self.logger:
                self.logger.warning(f"[ScreenCast] Permission not granted: {result['error']}")
            _linux_notify(
                "TimeTracker: Screen capture not enabled",
                "Permission was denied. Open tray → 'Fix Screen Capture' to retry.",
                urgency="critical"
            )
    
    t = threading.Thread(target=_request, daemon=True, name="screencast-onboard")
    t.start()
```

Integration point in `run()`:

```python
# After self._authenticated_user is confirmed, call:
if sys.platform.startswith('linux'):
    self._onboard_screencast_permission()
```

#### 2.3 Web UI — Add `/fix-screen-capture/grant-permission` endpoint

```python
@self.app.route('/api/system/grant-screencast-permission', methods=['POST'])
def api_grant_screencast_permission():
    """Trigger the ScreenCast consent dialog on demand (called by Fix Screen Capture page)."""
    from monitor_capture import request_screencast_permission
    result = request_screencast_permission(timeout_seconds=60)
    return jsonify(result)
```

Add a "Grant Permission" button to the existing "Fix Screen Capture" HTML page that calls this endpoint.

---

## Phase 3 — Restore Token Health Check (Track C)

### Goal
Detect and recover from a stale/corrupted restore token on **every startup**, not just when a capture fails.

### Changes Required

#### 3.1 `monitor_capture.py` — Enhance `_load_restore_token()`
Add token format validation:

```python
def _validate_restore_token(data: dict) -> Tuple[bool, str]:
    """
    Validate restore token structure.
    Returns (is_valid, reason_if_invalid)
    """
    if not data:
        return False, "empty"
    if not data.get('restore_token'):
        return False, "missing restore_token field"
    if not isinstance(data['restore_token'], str) or len(data['restore_token']) < 4:
        return False, "invalid token format"
    if 'saved_at' not in data:
        return False, "missing saved_at timestamp"
    age_days = (time.time() - data['saved_at']) / 86400
    if age_days > 30:
        return False, f"token expired ({age_days:.1f} days old)"
    return True, "ok"
```

#### 3.2 `desktop_app.py` — Startup health check
Add to `_onboard_screencast_permission()` (Phase 2):

```python
from monitor_capture import _load_restore_token, _validate_restore_token, _clear_restore_token

token_data = _load_restore_token()
if token_data:
    valid, reason = _validate_restore_token(token_data)
    if not valid:
        if self.logger:
            self.logger.warning(f"[ScreenCast] Restore token invalid ({reason}) — clearing and re-requesting")
        _clear_restore_token()
        # Fall through to re-request permission
```

---

## Phase 4 — Improve "Fix Screen Capture" Web Page (Track A+B)

Update the existing `/fix-screen-capture` page in `desktop_app.py` to:

1. Show **ScreenCast permission status** section (has token / needs permission / missing plugin)
2. Add a **"Grant Screen Permission"** button that calls the new `/api/system/grant-screencast-permission` endpoint
3. Add **live status indicator** that shows whether OCR is currently active (checks if last capture returned a non-black image)

### New UI Sections

```html
<!-- Add inside the existing fix-screen-capture HTML -->
<h2>ScreenCast Permission</h2>
<div id="permission-status">
  <!-- Populated by JS fetch to /api/system/screencast-permission-status -->
</div>
<button onclick="grantPermission()">Grant Screen Permission</button>

<h2>OCR Status</h2>
<div id="ocr-status">
  <!-- shows: Active / Inactive (metadata-only) / Black image detected -->
</div>
```

#### New API endpoint: `/api/system/screencast-permission-status`

```python
@self.app.route('/api/system/screencast-permission-status')
def api_screencast_permission_status():
    from monitor_capture import get_screencast_permission_status
    return jsonify(get_screencast_permission_status())
```

---

## Phase 5 — Black Image Detection & Fallback Improvement

### Problem
When all capture methods produce a black image, the code currently returns `None` and logs a warning. But it doesn't record HOW LONG this has been happening or alert the user.

### Changes Required

#### 5.1 `monitor_capture.py` — Track consecutive black-image count

```python
_CONSECUTIVE_BLACK_IMAGES = 0
_BLACK_IMAGE_FIRST_SEEN = None

def _record_black_image():
    global _CONSECUTIVE_BLACK_IMAGES, _BLACK_IMAGE_FIRST_SEEN
    _CONSECUTIVE_BLACK_IMAGES += 1
    if _BLACK_IMAGE_FIRST_SEEN is None:
        _BLACK_IMAGE_FIRST_SEEN = time.time()

def _reset_black_image_counter():
    global _CONSECUTIVE_BLACK_IMAGES, _BLACK_IMAGE_FIRST_SEEN
    _CONSECUTIVE_BLACK_IMAGES = 0
    _BLACK_IMAGE_FIRST_SEEN = None

def get_capture_health() -> dict:
    """Return capture health metrics for monitoring."""
    return {
        'consecutive_black_images': _CONSECUTIVE_BLACK_IMAGES,
        'black_image_duration_minutes': (
            (time.time() - _BLACK_IMAGE_FIRST_SEEN) / 60
            if _BLACK_IMAGE_FIRST_SEEN else 0
        ),
        'screencast_available': _check_screencast_available(),
        'restore_token_exists': bool(_load_restore_token()),
    }
```

#### 5.2 `desktop_app.py` — Alert user after 3+ consecutive failures

```python
# In the existing screenshot capture callback or monitor loop:
from monitor_capture import get_capture_health

health = get_capture_health()
if health['consecutive_black_images'] >= 3 and not self._capture_failure_notified:
    _linux_notify(
        "TimeTracker: Screenshot not working",
        "Screen capture has failed 3 times. Open tray → 'Fix Screen Capture'.",
        urgency="critical"
    )
    self._capture_failure_notified = True
    if self.logger:
        self.logger.error(
            f"[ScreenCapture] {health['consecutive_black_images']} consecutive black images. "
            f"Failing for {health['black_image_duration_minutes']:.1f} minutes. "
            f"ScreenCast available: {health['screencast_available']}. "
            f"Restore token: {health['restore_token_exists']}"
        )
```

---

## Test Scripts

### Test Script 1: `tests/test_screenshot_capture.py`
End-to-end test of the full screenshot → OCR pipeline.

```python
#!/usr/bin/env python3
"""
TimeTracker Screenshot Capture & OCR Pipeline Test

Tests the complete capture → OCR chain to verify fixes work.

Usage:
    python tests/test_screenshot_capture.py
    python tests/test_screenshot_capture.py --verbose
    python tests/test_screenshot_capture.py --method screencast  # test specific method
    python tests/test_screenshot_capture.py --json report.json

Exit codes:
    0 = all critical tests pass
    1 = critical failure (screenshot cannot work)
    2 = partial failure (some methods unavailable but workaround exists)
"""

import os
import sys
import json
import time
import argparse
import subprocess
from typing import Optional

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class ScreenshotCaptureTest:

    def __init__(self, verbose=False, test_method=None):
        self.verbose = verbose
        self.test_method = test_method
        self.results = []
        self.critical_failures = []

    # -----------------------------------------------------------------------
    # HELPERS
    # -----------------------------------------------------------------------

    def _record(self, name: str, passed: bool, details: str = "",
                critical: bool = False):
        status = "PASS" if passed else "FAIL"
        color = "\033[92m" if passed else "\033[91m"
        reset = "\033[0m"
        marker = "[CRITICAL]" if (not passed and critical) else ""
        print(f"  [{color}{status}{reset}] {name} {marker}")
        if details and (self.verbose or not passed):
            print(f"         {details}")
        self.results.append({'name': name, 'passed': passed, 'details': details})
        if not passed and critical:
            self.critical_failures.append(name)

    def _is_wayland(self):
        return bool(os.environ.get('WAYLAND_DISPLAY'))

    def _is_black_image(self, img) -> bool:
        """Check if PIL Image is all-black."""
        import array as _array
        bands = img.split()
        return not any(max(_array.array('B', b.tobytes())) > 0 for b in bands)

    # -----------------------------------------------------------------------
    # PHASE 1 TESTS: PACKAGE AVAILABILITY
    # -----------------------------------------------------------------------

    def test_gstreamer_pipewire_plugin(self):
        """Test: gstreamer1.0-pipewire (pipewiresrc) is installed."""
        print("\n=== Phase 1: Package Availability ===")
        try:
            r = subprocess.run(
                ['gst-inspect-1.0', 'pipewiresrc'],
                capture_output=True, timeout=5
            )
            ok = r.returncode == 0
            self._record(
                "gstreamer1.0-pipewire (pipewiresrc)",
                ok,
                details=("" if ok else
                         "Install: sudo apt install gstreamer1.0-pipewire"),
                critical=self._is_wayland()
            )
        except FileNotFoundError:
            self._record(
                "gstreamer1.0-pipewire (pipewiresrc)",
                False,
                details="gst-inspect-1.0 not found — GStreamer not installed",
                critical=self._is_wayland()
            )

    def test_pipewire_running(self):
        """Test: PipeWire daemon is running."""
        try:
            r = subprocess.run(['pgrep', '-x', 'pipewire'],
                               capture_output=True, timeout=3)
            ok = r.returncode == 0
            self._record(
                "PipeWire daemon running",
                ok,
                details=("" if ok else
                         "Start: systemctl --user start pipewire"),
                critical=self._is_wayland()
            )
        except Exception as e:
            self._record("PipeWire daemon running", False, str(e))

    def test_xdg_portal_screencast(self):
        """Test: XDG ScreenCast portal D-Bus interface available."""
        try:
            r = subprocess.run(
                ['gdbus', 'introspect', '--session',
                 '--dest', 'org.freedesktop.portal.Desktop',
                 '--object-path', '/org/freedesktop/portal/desktop'],
                capture_output=True, text=True, timeout=5
            )
            ok = (r.returncode == 0 and
                  'org.freedesktop.portal.ScreenCast' in r.stdout)
            self._record(
                "XDG ScreenCast portal",
                ok,
                details=("" if ok else
                         "Install: sudo apt install xdg-desktop-portal xdg-desktop-portal-gnome"),
                critical=self._is_wayland()
            )
        except Exception as e:
            self._record("XDG ScreenCast portal", False, str(e))

    # -----------------------------------------------------------------------
    # PHASE 2 TESTS: RESTORE TOKEN
    # -----------------------------------------------------------------------

    def test_restore_token_exists(self):
        """Test: ScreenCast restore token file exists."""
        print("\n=== Phase 2: Restore Token ===")
        from monitor_capture import _load_restore_token, _get_restore_token_file
        token_file = _get_restore_token_file()
        exists = os.path.exists(token_file)
        self._record(
            "Restore token file exists",
            exists,
            details=(f"Path: {token_file}" if exists else
                     f"Missing: {token_file}\n"
                     "Fix: Run TimeTracker and grant screen sharing permission when prompted")
        )

    def test_restore_token_valid(self):
        """Test: Restore token is not expired or malformed."""
        from monitor_capture import _load_restore_token
        data = _load_restore_token()
        if data is None:
            self._record(
                "Restore token valid",
                False,
                "Token file missing or unreadable"
            )
            return
        has_token = bool(data.get('restore_token'))
        if not has_token:
            self._record(
                "Restore token valid",
                False,
                "Token file exists but 'restore_token' field is empty"
            )
            return
        age_days = (time.time() - data.get('saved_at', 0)) / 86400
        valid = age_days < 30
        self._record(
            "Restore token valid",
            valid,
            details=(f"Token age: {age_days:.1f} days" +
                     (" (OK)" if valid else " (EXPIRED — need to re-grant permission)"))
        )

    # -----------------------------------------------------------------------
    # PHASE 3 TESTS: ACTUAL CAPTURE
    # -----------------------------------------------------------------------

    def test_screencast_capture(self):
        """Test: ScreenCast portal produces a non-black image."""
        print("\n=== Phase 3: ScreenCast Capture ===")
        try:
            from monitor_capture import _capture_screencast, _check_screencast_available
        except ImportError as e:
            self._record("ScreenCast capture", False, f"Import failed: {e}", critical=True)
            return

        if not _check_screencast_available():
            self._record(
                "ScreenCast capture",
                False,
                "ScreenCast prerequisites not met (see Phase 1 tests)",
                critical=self._is_wayland()
            )
            return

        print("  [INFO] Attempting ScreenCast capture (may take up to 30s)...")
        start = time.time()
        img = _capture_screencast()
        elapsed = time.time() - start

        if img is None:
            self._record(
                "ScreenCast capture",
                False,
                f"Capture returned None after {elapsed:.1f}s — "
                "permission denied or restore token invalid",
                critical=True
            )
            return

        black = self._is_black_image(img)
        self._record(
            "ScreenCast capture",
            not black,
            details=(f"Captured {img.size[0]}x{img.size[1]} in {elapsed:.1f}s" if not black
                     else f"Captured in {elapsed:.1f}s but image is all-black"),
            critical=black
        )
        return img

    def test_fallback_methods(self):
        """Test: Fallback capture methods (gnome-screenshot, scrot)."""
        print("\n=== Phase 3b: Fallback Methods ===")
        if not self._is_wayland():
            # X11: scrot should just work
            self._test_scrot()
            return

        # Wayland: all non-portal methods are expected to be black
        for name, fn_name in [
            ("gnome-screenshot", '_capture_gnome_screenshot_muted'),
            ("scrot", None),
        ]:
            if fn_name:
                try:
                    from monitor_capture import _capture_gnome_screenshot_muted
                    img = _capture_gnome_screenshot_muted()
                    if img is None:
                        self._record(f"{name} fallback", False,
                                     "Returned None (expected on strict Wayland)")
                    elif self._is_black_image(img):
                        self._record(f"{name} fallback", False,
                                     "Black image (expected on Wayland — XWayland root is black)")
                    else:
                        self._record(f"{name} fallback", True,
                                     f"Captured {img.size[0]}x{img.size[1]}")
                except Exception as e:
                    self._record(f"{name} fallback", False, str(e))

    def _test_scrot(self):
        import shutil, tempfile
        if not shutil.which('scrot'):
            self._record("scrot", False, "scrot not installed")
            return
        fh, path = tempfile.mkstemp('.png')
        os.close(fh)
        os.unlink(path)
        try:
            r = subprocess.run(['scrot', '--silent', path],
                               capture_output=True, timeout=5)
            if r.returncode == 0 and os.path.exists(path):
                from PIL import Image
                img = Image.open(path)
                img.load()
                black = self._is_black_image(img)
                self._record("scrot", not black,
                             "Black image (Wayland)" if black else
                             f"Captured {img.size[0]}x{img.size[1]}")
                os.unlink(path)
            else:
                self._record("scrot", False, f"rc={r.returncode}")
        except Exception as e:
            self._record("scrot", False, str(e))

    # -----------------------------------------------------------------------
    # PHASE 4 TESTS: OCR PIPELINE
    # -----------------------------------------------------------------------

    def test_ocr_on_captured_image(self):
        """Test: OCR produces text from a real screen capture."""
        print("\n=== Phase 4: OCR Pipeline ===")
        # First, get a valid screenshot
        try:
            from monitor_capture import _capture_linux
        except ImportError as e:
            self._record("OCR pipeline", False, f"monitor_capture import failed: {e}")
            return

        img = _capture_linux()
        if img is None:
            self._record("OCR pipeline", False,
                         "No screenshot available — fix Phase 3 first",
                         critical=True)
            return

        if self._is_black_image(img):
            self._record("OCR pipeline", False,
                         "Screenshot is black — OCR has no content",
                         critical=True)
            return

        # Try OCR
        try:
            from ocr.facade import get_ocr_text
            text, confidence = get_ocr_text(img)
            has_text = bool(text and text.strip())
            self._record(
                "OCR on captured image",
                has_text,
                details=(f"Confidence: {confidence:.2f}, Text length: {len(text or '')} chars"
                         + (f"\n  Sample: {(text or '')[:100]}..." if has_text else
                            "\n  No text found — screen may be showing desktop only"))
            )
        except Exception as e:
            self._record("OCR on captured image", False, f"OCR failed: {e}")

    def test_ocr_engines_initialized(self):
        """Test: OCR engines (rapidocr, easyocr) load without errors."""
        try:
            from ocr.facade import OCRFacade
            ocr = OCRFacade()
            status = ocr.get_status() if hasattr(ocr, 'get_status') else {}
            ok = True
            self._record("OCR engines initialized", ok,
                         f"Primary: {status.get('primary', 'unknown')}, "
                         f"Status: {status.get('state', 'unknown')}")
        except Exception as e:
            self._record("OCR engines initialized", False, str(e))

    # -----------------------------------------------------------------------
    # PHASE 5 TESTS: PERMISSION ONBOARDING FLOW (new code)
    # -----------------------------------------------------------------------

    def test_get_screencast_permission_status(self):
        """Test: get_screencast_permission_status() returns expected structure."""
        print("\n=== Phase 5: Permission Onboarding Functions ===")
        try:
            from monitor_capture import get_screencast_permission_status
            status = get_screencast_permission_status()
            required_keys = {'has_token', 'token_age_days', 'token_valid',
                             'plugin_installed', 'portal_available', 'status'}
            missing = required_keys - set(status.keys())
            ok = not missing
            self._record(
                "get_screencast_permission_status()",
                ok,
                details=(f"Status: {status.get('status')} | "
                         f"Plugin: {status.get('plugin_installed')} | "
                         f"Token: {status.get('has_token')}" if ok
                         else f"Missing keys: {missing}")
            )
        except AttributeError:
            self._record(
                "get_screencast_permission_status()",
                False,
                "Function not yet implemented — this is Phase 2 work"
            )
        except Exception as e:
            self._record("get_screencast_permission_status()", False, str(e))

    def test_capture_health_metrics(self):
        """Test: get_capture_health() returns expected structure."""
        try:
            from monitor_capture import get_capture_health
            health = get_capture_health()
            required_keys = {'consecutive_black_images', 'black_image_duration_minutes',
                             'screencast_available', 'restore_token_exists'}
            missing = required_keys - set(health.keys())
            ok = not missing
            self._record(
                "get_capture_health()",
                ok,
                details=(f"Black images: {health.get('consecutive_black_images', '?')} | "
                         f"ScreenCast: {health.get('screencast_available', '?')}" if ok
                         else f"Missing keys: {missing}")
            )
        except AttributeError:
            self._record(
                "get_capture_health()",
                False,
                "Function not yet implemented — this is Phase 5 work"
            )
        except Exception as e:
            self._record("get_capture_health()", False, str(e))

    # -----------------------------------------------------------------------
    # RUNNER
    # -----------------------------------------------------------------------

    def run_all(self) -> int:
        print("\n╔════════════════════════════════════════════════════════════╗")
        print("║     TIMETRACKER SCREENSHOT CAPTURE & OCR TEST SUITE        ║")
        print("╚════════════════════════════════════════════════════════════╝")

        env_info = {
            'wayland': bool(os.environ.get('WAYLAND_DISPLAY')),
            'display': os.environ.get('DISPLAY', 'none'),
            'session_type': os.environ.get('XDG_SESSION_TYPE', 'unknown'),
        }
        print(f"\nEnvironment: Wayland={env_info['wayland']}  "
              f"DISPLAY={env_info['display']}  "
              f"SESSION={env_info['session_type']}")

        # Run all phases
        self.test_gstreamer_pipewire_plugin()
        self.test_pipewire_running()
        self.test_xdg_portal_screencast()
        self.test_restore_token_exists()
        self.test_restore_token_valid()
        self.test_screencast_capture()
        self.test_fallback_methods()
        self.test_ocr_engines_initialized()
        self.test_ocr_on_captured_image()
        self.test_get_screencast_permission_status()
        self.test_capture_health_metrics()

        # Summary
        total = len(self.results)
        passed = sum(1 for r in self.results if r['passed'])
        print(f"\n{'='*60}")
        print(f"  Total: {passed}/{total} tests passed")
        if self.critical_failures:
            print(f"\n  ✗ CRITICAL FAILURES:")
            for f in self.critical_failures:
                print(f"    - {f}")
            print("\n  Action Required: Fix critical failures for OCR to work.")
        else:
            print("\n  ✓ No critical failures — screenshot capture should work.")

        return 1 if self.critical_failures else 0


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Test screenshot capture & OCR pipeline')
    parser.add_argument('--verbose', '-v', action='store_true')
    parser.add_argument('--json', metavar='FILE', help='Write results to JSON file')
    parser.add_argument('--method', choices=['screencast', 'fallback', 'all'],
                        default='all')
    args = parser.parse_args()

    tester = ScreenshotCaptureTest(verbose=args.verbose, test_method=args.method)
    exit_code = tester.run_all()

    if args.json:
        with open(args.json, 'w') as f:
            json.dump({'results': tester.results,
                       'critical_failures': tester.critical_failures}, f, indent=2)

    sys.exit(exit_code)
```

---

### Test Script 2: `tests/test_screencast_permission.py`
Targeted test for the new permission onboarding functions.

```python
#!/usr/bin/env python3
"""
ScreenCast Permission Onboarding Test

Tests the Phase 2 & 3 functions added to monitor_capture.py:
  - get_screencast_permission_status()
  - request_screencast_permission()
  - _validate_restore_token()
  - get_capture_health()

Usage:
    python tests/test_screencast_permission.py
    python tests/test_screencast_permission.py --request-permission  # trigger dialog

NOTE: --request-permission will show a real GNOME screen sharing dialog.
Only use it on a desktop session (not CI/headless).
"""

import os
import sys
import json
import time
import argparse
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

PASS = "\033[92mPASS\033[0m"
FAIL = "\033[91mFAIL\033[0m"

def check(name, condition, details=""):
    status = PASS if condition else FAIL
    print(f"  [{status}] {name}")
    if details:
        print(f"         {details}")
    return condition


def test_restore_token_functions():
    """Test token save/load/clear/validate round-trip."""
    print("\n=== Token File Round-Trip ===")
    from monitor_capture import (
        _save_restore_token, _load_restore_token, _clear_restore_token,
        _get_restore_token_file
    )

    # Clear any existing token
    _clear_restore_token()
    check("Token file cleared", not os.path.exists(_get_restore_token_file()))

    # Save a token
    ok = _save_restore_token('test-token-abc123', session_handle='/test/handle', node_id=42)
    check("save_restore_token returns True", ok)
    check("Token file created", os.path.exists(_get_restore_token_file()))

    # Load it back
    data = _load_restore_token()
    check("load_restore_token returns dict", isinstance(data, dict))
    check("restore_token field correct", data and data.get('restore_token') == 'test-token-abc123',
          f"Got: {data.get('restore_token') if data else 'None'}")
    check("node_id preserved", data and data.get('node_id') == 42)
    check("saved_at present", data and 'saved_at' in data)

    # Cleanup
    _clear_restore_token()
    check("Token file removed after clear", not os.path.exists(_get_restore_token_file()))


def test_validate_restore_token():
    """Test _validate_restore_token() handles all edge cases."""
    print("\n=== Token Validation ===")
    try:
        from monitor_capture import _validate_restore_token
    except ImportError:
        print("  [SKIP] _validate_restore_token not yet implemented (Phase 3 work)")
        return

    cases = [
        (None, False, "None input"),
        ({}, False, "empty dict"),
        ({'restore_token': ''}, False, "empty token string"),
        ({'restore_token': 'ab'}, False, "token too short"),
        ({'restore_token': 'valid-token', 'saved_at': time.time()}, True, "valid token"),
        ({'restore_token': 'valid-token', 'saved_at': time.time() - 40 * 86400}, False, "expired token"),
    ]

    for data, expected_valid, desc in cases:
        if data is not None and 'restore_token' in data and len(data.get('restore_token','')) >= 4 and 'saved_at' not in data:
            data['saved_at'] = time.time()  # add timestamp for format-only tests
        valid, reason = _validate_restore_token(data) if data is not None else (False, "None")
        check(f"validate({desc})", valid == expected_valid,
              f"Expected valid={expected_valid}, got valid={valid} (reason: {reason})")


def test_get_screencast_permission_status():
    """Test get_screencast_permission_status() structure and accuracy."""
    print("\n=== Permission Status Function ===")
    try:
        from monitor_capture import get_screencast_permission_status
    except ImportError:
        print("  [SKIP] get_screencast_permission_status not yet implemented (Phase 2 work)")
        return

    status = get_screencast_permission_status()

    required_keys = {'has_token', 'token_age_days', 'token_valid',
                     'plugin_installed', 'portal_available', 'status'}
    missing = required_keys - set(status.keys())
    check("All required keys present", not missing, f"Missing: {missing}")

    valid_statuses = {'ready', 'needs_permission', 'missing_plugin', 'no_portal'}
    check("status value is valid", status.get('status') in valid_statuses,
          f"Got: {status.get('status')}")

    check("plugin_installed is bool", isinstance(status.get('plugin_installed'), bool))
    check("has_token is bool", isinstance(status.get('has_token'), bool))
    check("portal_available is bool", isinstance(status.get('portal_available'), bool))

    print(f"\n  Current status: {status.get('status')}")
    print(f"  Plugin installed: {status.get('plugin_installed')}")
    print(f"  Has token: {status.get('has_token')}")
    if status.get('token_age_days') is not None:
        print(f"  Token age: {status['token_age_days']:.1f} days")


def test_get_capture_health():
    """Test get_capture_health() structure."""
    print("\n=== Capture Health Metrics ===")
    try:
        from monitor_capture import get_capture_health
    except ImportError:
        print("  [SKIP] get_capture_health not yet implemented (Phase 5 work)")
        return

    health = get_capture_health()
    required_keys = {'consecutive_black_images', 'black_image_duration_minutes',
                     'screencast_available', 'restore_token_exists'}
    missing = required_keys - set(health.keys())
    check("All required keys present", not missing, f"Missing: {missing}")
    check("consecutive_black_images >= 0",
          isinstance(health.get('consecutive_black_images'), int) and
          health['consecutive_black_images'] >= 0)


def test_request_permission_dry_run():
    """Test request_screencast_permission when plugin is missing (no dialog)."""
    print("\n=== Permission Request (dry run — no dialog) ===")
    try:
        from monitor_capture import request_screencast_permission, _check_screencast_available
    except ImportError:
        print("  [SKIP] request_screencast_permission not yet implemented (Phase 2 work)")
        return

    # If plugin is not installed, function should return immediately with error
    from monitor_capture import _check_screencast_available
    plugin_ok = _check_screencast_available()

    if not plugin_ok:
        result = request_screencast_permission(timeout_seconds=5)
        check("Returns dict", isinstance(result, dict))
        check("granted=False when plugin missing", result.get('granted') is False)
        check("error message present", bool(result.get('error')))
        check("already_had_permission=False", result.get('already_had_permission') is False)
        print(f"  Error: {result.get('error')}")
    else:
        print("  [INFO] Plugin is installed — skipping dry-run (would trigger dialog)")
        print("         Run with --request-permission to test the real flow")


def test_request_permission_real(timeout=60):
    """Trigger the actual GNOME consent dialog (only run manually)."""
    print(f"\n=== Permission Request (REAL — will show dialog, timeout={timeout}s) ===")
    try:
        from monitor_capture import request_screencast_permission
    except ImportError:
        print("  [SKIP] request_screencast_permission not yet implemented")
        return

    print("  [INFO] Triggering ScreenCast permission dialog...")
    print("  [INFO] Please click 'Allow' or 'Deny' when the dialog appears.")

    result = request_screencast_permission(timeout_seconds=timeout)
    check("Returns dict", isinstance(result, dict))
    check("Permission granted", result.get('granted') is True,
          f"Error: {result.get('error')}")
    if result.get('granted'):
        check("restore_token present", bool(result.get('restore_token')))
        check("node_id present", result.get('node_id') is not None)
        print(f"  Token: {result['restore_token'][:20]}...")
        print(f"  Node ID: {result.get('node_id')}")


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--request-permission', action='store_true',
                        help='Trigger real GNOME consent dialog')
    parser.add_argument('--timeout', type=int, default=60)
    args = parser.parse_args()

    print("╔════════════════════════════════════════════════════════════╗")
    print("║     SCREENCAST PERMISSION ONBOARDING TEST                  ║")
    print("╚════════════════════════════════════════════════════════════╝")

    test_restore_token_functions()
    test_validate_restore_token()
    test_get_screencast_permission_status()
    test_get_capture_health()
    test_request_permission_dry_run()

    if args.request_permission:
        test_request_permission_real(timeout=args.timeout)
    else:
        print("\n  [INFO] Run with --request-permission to test the real dialog flow")

    print("\nDone.")
```

---

### Test Script 3: `scripts/fix-screenshot-capture.sh`
Distro-aware shell script (implementation shown in Phase 1 above).

---

## Implementation Order & Priority

| Priority | Phase | Effort | Fixes |
|----------|-------|--------|-------|
| **P0** | Phase 1 (package auto-detect + guided notification) | 1–2h | Yogitha: detects and guides install |
| **P0** | Phase 2 (ScreenCast onboarding on startup) | 3–4h | Suchith + Yogitha: triggers consent dialog proactively |
| **P1** | Phase 3 (restore token health check) | 1h | Both: handles stale tokens |
| **P1** | Phase 4 (Fix Screen Capture UI improvements) | 2–3h | Both: self-service UI improvement |
| **P2** | Phase 5 (black image counter + alerting) | 1–2h | Both: better failure visibility |

**Total estimated effort: ~10–12 hours for all 5 phases.**

---

## Verification Checklist (Post-Implementation)

Run these tests to confirm the fix works:

```bash
# On Ubuntu 24.04 (Suchith's setup)
python tests/test_screenshot_capture.py --verbose
python tests/test_screencast_permission.py --request-permission

# On Ubuntu 25.04 (Yogitha's setup)
# Step 1: Check if gstreamer1.0-pipewire is missing
python tests/test_screenshot_capture.py

# Step 2: If missing, run fix script
bash scripts/fix-screenshot-capture.sh

# Step 3: Re-run tests after install
python tests/test_screenshot_capture.py --verbose
python tests/test_screencast_permission.py --request-permission

# Full regression (all features)
python tests/test_os_compatibility.py
python tests/test_screenshot_capture.py
python tests/test_screencast_permission.py
```

### Expected Results After Fix

| Test | Yogitha (25.04) After Fix | Suchith (24.04) After Fix |
|------|--------------------------|--------------------------|
| gstreamer1.0-pipewire | PASS (after install) | PASS |
| PipeWire running | PASS | PASS |
| XDG ScreenCast portal | PASS | PASS |
| Restore token valid | PASS (after grant) | PASS (after grant) |
| ScreenCast capture | PASS (non-black image) | PASS (non-black image) |
| OCR on captured image | PASS (text found) | PASS (text found) |

---

## Key Files Reference

| File | Role |
|------|------|
| `monitor_capture.py` | Main capture pipeline — add `request_screencast_permission()`, `get_screencast_permission_status()`, `get_capture_health()`, `_validate_restore_token()` |
| `system_check.py` | Dependency checker — add `check_gstreamer_pipewire_installable()` |
| `desktop_app.py` | Main app — add `_onboard_screencast_permission()`, call from `run()`, add API endpoints, update Fix Screen Capture HTML |
| `scripts/fix-screenshot-capture.sh` | New shell script for terminal users |
| `tests/test_screenshot_capture.py` | New: end-to-end capture + OCR test |
| `tests/test_screencast_permission.py` | New: permission onboarding unit tests |
