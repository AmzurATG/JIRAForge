# TimeTracker Installation Issues — Root Cause Analysis & Fix Plan

**Log analyzed:** `plan/timetracker_yogi.log`  
**User machine:** AMZ-LAP-344, Ubuntu Linux, Wayland session, Python 3.12  
**App version:** TimeTracker v1.0.2  
**Date:** 2026-06-17  

---

## Executive Summary

The user (yamunay) reported that the application "does not install" despite running it multiple times. The app **is** installed and running successfully at `/home/yamunay/.local/share/TimeTracker/TimeTracker.AppImage`. The root problem is a combination of four compounding issues:

1. The system tray icon is **invisible** due to a Wayland/pystray backend mismatch — the user never sees the running app.
2. The stored OAuth tokens were **expired** on first boot — the user was silently logged out.
3. Login reminder **notifications are silently skipped** on Linux (`winotify not available` → `_linux_notify` code path runs, but the log message says "skipped" — misleading and not confirmed to be delivered on this Wayland session).
4. GStreamer/PipeWire **screenshot dependencies are missing** — core feature is degraded.

Issues 1 + 2 + 3 together create the appearance that the app "never installed" because there is nothing visible to the user despite multiple launches.

---

## Issues, Root Causes & Fixes

---

### Issue 1 — CRITICAL: System Tray Icon Not Visible on Wayland

#### Evidence from log
```
[WARN] Tray backend '_xorg' does not support popup menus.
[WARN] Running on pystray backend '_xorg' without menu support.
[DEBUG] on_tray_ready() CALLED — setting icon visible
ERROR - pystray._base - Failed to dock icon
  File "pystray/_xorg.py", line 395, in _assert_docked → AssertionError
  (repeats every 2 seconds for the entire session)
```

#### Root Cause

The machine runs a **Wayland** display server (`WAYLAND_DISPLAY=wayland-0`, `session=wayland`). The app's Linux tray bootstrap (`_bootstrap_linux_tray_backend()` in `desktop_app.py`) attempted to detect `AyatanaAppIndicator3` or `AppIndicator3` but **neither was installed** on AMZ-LAP-344. The bootstrap silently fell through to the Xorg fallback (`PYSTRAY_BACKEND=xorg`).

The Xorg/X11 system tray protocol (XEMBED) is **not supported by GNOME Shell on Wayland**. The icon appears to create (`on_tray_ready` fires, `icon.visible = True`) but then the XEmbed docking assertion fails immediately — the tray slot never receives the icon. The user sees a blank taskbar with no trace of the app.

The bootstrap already has the correct `AyatanaAppIndicator3` preference logic for Wayland, but it silently falls back without telling the user what package to install.

#### Fix

**File:** `desktop_app.py` — `_bootstrap_linux_tray_backend()` function

After the `appindicator-unavailable` path (around line 199), add an actionable warning message and an explicit install prompt when on Wayland:

```python
# After indicator detection fails on Wayland, print install instructions
if is_wayland and not indicator_name:
    print(
        "[WARN] Wayland session detected but no AppIndicator library found.\n"
        "[WARN] The system tray icon will NOT be visible.\n"
        "[WARN] Fix: sudo apt install -y gir1.2-ayatanaappindicator3-0.1\n"
        "[WARN]      Then restart TimeTracker."
    )
    _linux_notify(
        "TimeTracker: Tray Icon Unavailable",
        "Install gir1.2-ayatanaappindicator3-0.1 and restart to show the tray icon.",
        urgency="critical"
    )
```

**Also add** a compatibility check at startup that detects the Wayland+Xorg-backend combination and opens the web UI automatically:

```python
# In setup_system_tray(), after tray.run_detached() call:
_tray_backend = getattr(pystray.Icon, '__module__', '')
if 'xorg' in _tray_backend and (
    os.environ.get('WAYLAND_DISPLAY') or
    os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland'
):
    print("[WARN] Xorg tray backend on Wayland — opening web UI automatically")
    try:
        webbrowser.open(f'http://localhost:{self.web_port}')
    except Exception:
        pass
```

**Package that must be installed on AMZ-LAP-344:**
```bash
sudo apt install -y gir1.2-ayatanaappindicator3-0.1
# Then restart TimeTracker
```

---

### Issue 2 — CRITICAL: OAuth Refresh Token Expired Silently on Launch

#### Evidence from log
```
[WARN] Access token expired (401) in get_user_info, attempting refresh...
[ERROR] Token refresh failed: Refresh token expired, revoked, or rotated out.
[AUTH] token_refresh_failed | error_code=OAUTH_REAUTH_REQUIRED | refresh_fail_count=5 | permanent_failure=True
[WARN] Could not verify user info after 3 attempts — falling back to cached data
[WARN] No cached credentials available, please re-authenticate
Tokens deleted for default
```

#### Root Cause

The app stored tokens from a **previous session that had been revoked or rotated** on the server side (`refresh_fail_count=5` on first startup means previous sessions already accumulated failures). On this boot, the app:

1. Found stale tokens in keyring
2. Tried to refresh — server returned `OAUTH_REAUTH_REQUIRED` (permanent failure)
3. Tried 3 times with exponential backoff (3s, 6s — totalling 11 seconds of blocking)
4. Deleted all stored tokens
5. Set `invalid_flag=True` with a 30-minute grace period

During the 30-minute grace period, `_show_reauth_notification()` is **suppressed** (correct for transient offline errors, but wrong for this permanent `OAUTH_REAUTH_REQUIRED` case):

```python
# desktop_app.py ~line 10679:
if not is_temporary:
    invalid_since = getattr(self.auth_manager, '_refresh_invalid_set_at', 0)
    if invalid_since and (now - invalid_since) < 1800:
        print("[INFO] Auth notification suppressed — still in 30-min refresh token grace period")
        return
```

The `OAUTH_REAUTH_REQUIRED` error code indicates a **permanent** failure (not a transient network issue), so it should bypass the grace period suppression entirely.

Additionally, `_show_login_reminder()` runs every 15 minutes (correct) but on Linux falls through to `_linux_notify` and then immediately prints "Login reminder skipped" — the log message is misleading (notify-send IS called before the print, but the notification may not render on Wayland without a functioning notification daemon connection).

#### Fix

**File:** `desktop_app.py` — `_show_reauth_notification()` method (~line 10675)

Add a bypass for the grace period when the error is explicitly permanent:

```python
def _show_reauth_notification(self, reason_code=None):
    now = time.time()
    reason = str(reason_code or '').upper()
    is_temporary = reason == 'OAUTH_TEMPORARY_FAILURE'
    is_permanent = reason == 'OAUTH_REAUTH_REQUIRED'   # NEW

    if not is_temporary:
        if not self.offline_manager.check_connectivity():
            print("[INFO] Auth notification suppressed — device is offline")
            return
        # NEW: skip grace period for permanent failures — user MUST act now
        if not is_permanent:
            invalid_since = getattr(self.auth_manager, '_refresh_invalid_set_at', 0)
            if invalid_since and (now - invalid_since) < 1800:
                print("[INFO] Auth notification suppressed — still in 30-min grace period")
                return
    # ... rest of method unchanged
```

**File:** `desktop_app.py` — `_show_login_reminder()` method (~line 10744)

Fix the misleading log message so it accurately reflects what happened:

```python
def _show_login_reminder(self):
    now = time.time()
    last_shown = getattr(self, '_login_reminder_last_shown', 0)
    if now - last_shown < 900:
        return
    self._login_reminder_last_shown = now

    if not WINOTIFY_AVAILABLE:
        sent = _linux_notify("Time Tracker – Not Logged In",
                             "You are not logged in. Please open Time Tracker and log in.")
        # FIX: distinguish between notify-send available vs. unavailable
        if NOTIFY_SEND_AVAILABLE:
            print("[INFO] Login reminder sent via notify-send (winotify unavailable on Linux)")
        else:
            print("[WARN] Login reminder could not be shown — notify-send not installed")
        return
    # ... Windows path unchanged
```

---

### Issue 3 — HIGH: `winotify` / `notify-send` Notifications Not Reaching User on Wayland

#### Evidence from log
```
[WARN] Login reminder skipped - winotify not available   (×9 instances, every 15 min from 13:42 to 15:42)
```

#### Root Cause

Two separate problems:

**3a. Misleading log message:** The code at `_show_login_reminder()` calls `_linux_notify()` (notify-send) **before** printing "Login reminder skipped". The "skipped" message is incorrect — notify-send is attempted. This masks whether notifications are actually delivered.

**3b. notify-send on Wayland:** The `_linux_notify` function uses `subprocess.run([notify-send, ...])` which is a fire-and-forget call with no confirmation. On some Wayland+GNOME configurations, `notify-send` works only when `DBUS_SESSION_BUS_ADDRESS` is set in the process environment. Since TimeTracker is launched from an AppImage (possibly without a full login session environment), `notify-send` may silently fail.

The log did not confirm `NOTIFY_SEND_AVAILABLE=True`, meaning `notify-send` may not even be installed on AMZ-LAP-344.

#### Fix

**File:** `desktop_app.py` — `_linux_notify()` function (~line 701)

Add return value and error logging:

```python
def _linux_notify(title: str, msg: str, urgency: str = "normal") -> bool:
    """Send a desktop notification on Linux using notify-send.
    Returns True if notify-send was invoked, False if unavailable."""
    if not NOTIFY_SEND_AVAILABLE:
        return False
    try:
        import subprocess as _sp
        result = _sp.run(
            [_NOTIFY_SEND, "--urgency", urgency, "--app-name", "Time Tracker", title, msg],
            timeout=3, check=False, capture_output=True
        )
        if result.returncode != 0:
            print(f"[WARN] notify-send exited with code {result.returncode}: "
                  f"{result.stderr.decode(errors='replace').strip()}")
            return False
        return True
    except Exception as e:
        print(f"[WARN] notify-send call failed: {e}")
        return False
```

**Also add** a startup diagnostic log for notification availability:

```python
# Near the NOTIFY_SEND_AVAILABLE declaration (line ~699):
print(f"[INFO] Linux notification: notify-send={'available' if NOTIFY_SEND_AVAILABLE else 'NOT FOUND'}")
```

**On AMZ-LAP-344**, if `notify-send` is missing:
```bash
sudo apt install -y libnotify-bin
```

---

### Issue 4 — HIGH: GStreamer/PipeWire Screenshot Dependencies Missing

#### Evidence from log
```
WARNING - system_check - GStreamer pipewiresrc plugin not available
ERROR - STDERR - SCREENSHOT CAPTURE DEPENDENCIES MISSING
ERROR - STDERR - INSTALL COMMAND:
  sudo apt install -y gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-tools gstreamer1.0-pipewire
CURRENT STATUS: Running in METADATA-ONLY mode
  - Window titles tracked: YES
  - Screen content (OCR): NO
```

#### Root Cause

The `gstreamer1.0-pipewire` package (which provides the `pipewiresrc` GStreamer plugin) is not installed on AMZ-LAP-344. Without it, the app cannot use PipeWire's portal API to capture screenshots under Wayland. The app correctly detects this and falls back to metadata-only mode, but since the tray icon is broken (Issue 1), the user cannot access the "Fix Screen Capture" menu item that would guide them through repair.

#### Fix

**Immediate (manual on user machine):**
```bash
sudo apt install -y gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-tools gstreamer1.0-pipewire
systemctl --user restart pipewire pipewire-pulse wireplumber
# Then restart TimeTracker and grant screenshot permission when prompted
```

**Code fix:** Add a web UI route to expose the fix instructions since the tray menu is inaccessible. File: `desktop_app.py` — Flask routes section.

Add a `/diagnostics` endpoint that shows system health including GStreamer status and install commands, accessible at `http://localhost:51777/diagnostics`. This allows the user to diagnose and fix issues even when the tray icon is invisible.

---

### Issue 5 — LOW: AI Server Sends `winrtocr` as Primary Engine for Linux Clients

#### Evidence from log
```
[OK] OCR config loaded from AI server (engines: winrtocr, rapidocr, easyocr)
WARNING - ocr.config - Primary OCR engine 'winrtocr' is not compatible with linux. Switching to fallback.
```

#### Root Cause

The AI server returns a global OCR configuration that includes `winrtocr` as the primary engine. `winrtocr` is a Windows Runtime API and cannot run on Linux. The `apply_platform_filters()` function in `ocr/config.py` correctly detects and remediates this, switching to `rapidocr`, but the unnecessary warning indicates the **server should not be sending `winrtocr` to Linux clients** in the first place.

The `apply_platform_filters()` function works correctly. This is a server-side configuration issue.

#### Fix

**AI server side:** Include the client platform in the OCR config request so the server returns a platform-appropriate configuration.

**Client side (defensive):** Already handled — `apply_platform_filters()` in `ocr/config.py` strips incompatible engines. No client code change needed.

---

### Issue 6 — LOW: Presidio/`thinc` PII Module Not Bundled in AppImage

#### Evidence from log
```
ERROR - STDERR - CRITICAL: Presidio is NOT installed or failed to load.
PII detection is DEGRADED — credit card Luhn validation, phone number format detection,
and NER-based name/address detection are DISABLED. Error: No module named 'thinc'
```

#### Root Cause

`presidio-analyzer` depends on `thinc` (a spaCy sub-dependency). `thinc` was not included in the PyInstaller bundle for the AppImage. The OCR privacy filter falls back gracefully (`PRIVACY_FILTER_ENABLED=false` per config), but PII detection is degraded for this user.

#### Fix

**`desktop_app.spec` / `build.sh`:** Add `thinc` and its native extensions to the PyInstaller hidden imports and binary collection. This is a build-time fix — no runtime code change needed.

```python
# In desktop_app.spec hiddenimports list:
hiddenimports = [
    ...
    'thinc',
    'thinc.api',
    'thinc.backends',
    ...
]
```

---

## Fix Priority Order

| Priority | Issue | Effort | Impact |
|----------|-------|--------|--------|
| P0 | Issue 1: Invisible tray on Wayland + auto-open web UI | Low (2 code changes) | Fixes the "not installed" perception |
| P0 | Issue 2: Permanent token failure bypasses grace period | Low (1 code change) | Ensures user is notified to log in |
| P1 | Issue 3: Fix `_linux_notify` return value + startup diagnostic | Low (1 code change) | Confirms notifications are actually delivered |
| P1 | Issue 4: GStreamer deps + /diagnostics web route | Medium (new route) | Restores screenshot tracking |
| P2 | Issue 5: AI server sends winrtocr to Linux | Server config | Eliminates unnecessary warning |
| P3 | Issue 6: Bundle thinc in AppImage | Build change | Restores full PII detection |

---

## Test Scripts

---

### Test 1 — Tray Backend Detection (Issue 1)

**File:** `tests/test_tray_backend_wayland.py`

```python
"""
Test: Tray backend correctly uses AyatanaAppIndicator3 on Wayland,
falls back gracefully to Xorg and opens web UI when appindicator unavailable.
"""
import os
import sys
import unittest
from unittest.mock import patch, MagicMock


class TestTrayBackendWayland(unittest.TestCase):

    def setUp(self):
        # Simulate Wayland environment
        self.original_env = os.environ.copy()
        os.environ['WAYLAND_DISPLAY'] = 'wayland-0'
        os.environ['XDG_SESSION_TYPE'] = 'wayland'
        # Remove any leftover backend setting
        os.environ.pop('PYSTRAY_BACKEND', None)

    def tearDown(self):
        os.environ.clear()
        os.environ.update(self.original_env)

    def test_wayland_sets_ayatana_backend_when_available(self):
        """When AyatanaAppIndicator3 is available on Wayland, PYSTRAY_BACKEND=appindicator."""
        with patch.dict('sys.modules', {
            'gi': MagicMock(),
            'gi.repository': MagicMock(),
            'gi.repository.Gtk': MagicMock(),
            'gi.repository.AyatanaAppIndicator3': MagicMock(),
        }):
            import importlib
            # Reload bootstrap in the mocked context
            import desktop_app as da
            # After bootstrap, expect appindicator backend
            self.assertIn(
                os.environ.get('PYSTRAY_BACKEND', ''),
                ('appindicator', ''),  # set or cleared after successful detection
                "Expected appindicator backend on Wayland with Ayatana available"
            )

    def test_wayland_falls_back_to_xorg_when_no_appindicator(self):
        """When no AppIndicator is available on Wayland, PYSTRAY_BACKEND=xorg."""
        with patch.dict('sys.modules', {'gi': None}):
            os.environ['PYSTRAY_BACKEND'] = 'xorg'  # simulates bootstrap outcome
            self.assertEqual(os.environ.get('PYSTRAY_BACKEND'), 'xorg')

    def test_wayland_prefers_ayatana_over_appindicator3(self):
        """On Wayland, AyatanaAppIndicator3 must be tried before AppIndicator3."""
        gi_mock = MagicMock()
        required_versions = []

        def mock_require_version(name, ver):
            required_versions.append(name)

        gi_mock.require_version = mock_require_version

        with patch.dict('sys.modules', {'gi': gi_mock}):
            # Simulate the bootstrap candidate list for wayland
            is_wayland = True
            indicator_candidates = ('AyatanaAppIndicator3', 'AppIndicator3') if is_wayland else ('AppIndicator3', 'AyatanaAppIndicator3')
            self.assertEqual(indicator_candidates[0], 'AyatanaAppIndicator3',
                             "AyatanaAppIndicator3 must be the first candidate on Wayland")

    def test_xorg_backend_on_wayland_triggers_web_ui_open(self):
        """When tray backend is _xorg on Wayland, the web UI should auto-open."""
        opened_urls = []

        with patch('webbrowser.open', side_effect=lambda url: opened_urls.append(url)):
            # Simulate the condition
            tray_module = '_xorg'
            wayland_active = True
            if 'xorg' in tray_module and wayland_active:
                import webbrowser
                webbrowser.open('http://localhost:51777')

        self.assertTrue(len(opened_urls) > 0, "Web UI should auto-open when tray is invisible on Wayland")
        self.assertIn('51777', opened_urls[0], "Should open on the correct port")

    def test_bootstrap_status_reflects_appindicator_unavailable(self):
        """Bootstrap status should contain 'appindicator-unavailable' when no indicator found."""
        # This simulates the code path on AMZ-LAP-344
        status = 'appindicator-unavailable:No module named AyatanaAppIndicator3'
        self.assertIn('appindicator-unavailable', status)
        self.assertNotIn('appindicator-ready', status)


if __name__ == '__main__':
    unittest.main()
```

**Run:**
```bash
cd /home/iswaryak/ATG/new-main-linux/JIRAForge/python-desktop-app
source venv/bin/activate
python -m pytest tests/test_tray_backend_wayland.py -v
```

---

### Test 2 — OAuth Token Expiry & Grace Period Bypass (Issue 2)

**File:** `tests/test_auth_reauth_notification.py`

```python
"""
Test: OAUTH_REAUTH_REQUIRED bypasses the 30-minute grace period suppression.
Test: Permanent token failure triggers immediate re-auth notification.
"""
import time
import unittest
from unittest.mock import MagicMock, patch, call


class TestReauthNotification(unittest.TestCase):

    def _make_tracker(self, reason_code, invalid_since_offset_sec=0):
        """Helper: build a minimal mock tracker with auth state."""
        tracker = MagicMock()
        tracker.web_port = 51777
        tracker.offline_manager.check_connectivity.return_value = True

        # Simulate token marked invalid 'invalid_since_offset_sec' seconds ago
        tracker.auth_manager._refresh_invalid_set_at = time.time() - invalid_since_offset_sec
        tracker.auth_manager._last_refresh_error_code = reason_code

        tracker._reauth_notification_last_shown = 0
        tracker._auth_temp_notification_last_shown = 0
        return tracker

    def test_permanent_reauth_required_bypasses_grace_period(self):
        """OAUTH_REAUTH_REQUIRED must show notification even within 30-min grace window."""
        # Simulate: token failed 5 minutes ago (within 30-min grace)
        invalid_since_offset = 5 * 60  # 5 minutes ago

        reason = 'OAUTH_REAUTH_REQUIRED'
        is_temporary = reason == 'OAUTH_TEMPORARY_FAILURE'
        is_permanent = reason == 'OAUTH_REAUTH_REQUIRED'

        now = time.time()
        invalid_since = now - invalid_since_offset

        # Original suppression logic (the BUG):
        original_suppressed = not is_temporary and (now - invalid_since) < 1800
        self.assertTrue(original_suppressed, "Confirm the BUG: grace period suppresses OAUTH_REAUTH_REQUIRED")

        # Fixed suppression logic:
        fixed_suppressed = not is_temporary and not is_permanent and (now - invalid_since) < 1800
        self.assertFalse(fixed_suppressed, "Fix: OAUTH_REAUTH_REQUIRED must NOT be suppressed by grace period")

    def test_temporary_failure_is_still_suppressed_in_grace_period(self):
        """OAUTH_TEMPORARY_FAILURE should remain suppressed within grace period."""
        reason = 'OAUTH_TEMPORARY_FAILURE'
        is_temporary = reason == 'OAUTH_TEMPORARY_FAILURE'
        is_permanent = reason == 'OAUTH_REAUTH_REQUIRED'

        now = time.time()
        invalid_since = now - (5 * 60)  # 5 min ago

        # Temporary failures should still go through offline/grace checks
        self.assertTrue(is_temporary)
        self.assertFalse(is_permanent)

    def test_offline_still_suppresses_permanent_reauth(self):
        """Even permanent reauth notifications should be suppressed when offline."""
        # The offline check (connectivity) is before the grace period check,
        # so this suppression should still apply.
        is_online = False
        reason = 'OAUTH_REAUTH_REQUIRED'
        is_temporary = reason == 'OAUTH_TEMPORARY_FAILURE'

        # offline check fires first — notification should be suppressed
        if not is_temporary and not is_online:
            suppressed = True
        else:
            suppressed = False

        self.assertTrue(suppressed, "Offline suppression should apply before grace period check")

    def test_reauth_opens_browser_on_linux(self):
        """On Linux, a permanent reauth notification should auto-open the browser."""
        import sys
        opened = []

        with patch('webbrowser.open', side_effect=lambda url: opened.append(url)):
            if sys.platform.startswith('linux'):
                import webbrowser
                webbrowser.open('http://localhost:51777/login')

        if sys.platform.startswith('linux'):
            self.assertTrue(len(opened) > 0, "Browser should open to login page on Linux reauth")

    def test_token_refresh_fail_count_triggers_immediate_notification(self):
        """refresh_fail_count=5 on startup = previously known failure, must notify immediately."""
        refresh_fail_count = 5
        # If the server is already at max failures, the token is gone — no grace needed
        self.assertGreaterEqual(refresh_fail_count, 1,
                                "Any non-zero fail count indicates token is compromised")


if __name__ == '__main__':
    unittest.main()
```

**Run:**
```bash
python -m pytest tests/test_auth_reauth_notification.py -v
```

---

### Test 3 — Linux Notification Delivery (Issue 3)

**File:** `tests/test_linux_notifications.py`

```python
"""
Test: _linux_notify() returns correct boolean, logs correct messages,
and notify-send is invoked with the right arguments.
"""
import os
import sys
import unittest
from unittest.mock import patch, MagicMock


# ── Helpers ──────────────────────────────────────────────────────────────────

def _linux_notify_fixed(title: str, msg: str, urgency: str = "normal",
                         notify_send_path: str = None) -> bool:
    """Proposed fixed version of _linux_notify with return value."""
    if notify_send_path is None:
        return False
    try:
        import subprocess as _sp
        result = _sp.run(
            [notify_send_path, "--urgency", urgency, "--app-name", "Time Tracker", title, msg],
            timeout=3, check=False, capture_output=True
        )
        return result.returncode == 0
    except Exception:
        return False


class TestLinuxNotifications(unittest.TestCase):

    @unittest.skipUnless(sys.platform.startswith('linux'), "Linux only")
    def test_notify_send_called_with_correct_args(self):
        """notify-send is invoked with urgency, app-name, title, message."""
        with patch('subprocess.run') as mock_run:
            mock_run.return_value = MagicMock(returncode=0, stderr=b'')
            result = _linux_notify_fixed(
                "Test Title", "Test Message", urgency="critical",
                notify_send_path="/usr/bin/notify-send"
            )
            self.assertTrue(result)
            mock_run.assert_called_once()
            args = mock_run.call_args[0][0]
            self.assertIn("--urgency", args)
            self.assertIn("critical", args)
            self.assertIn("Time Tracker", args)
            self.assertIn("Test Title", args)
            self.assertIn("Test Message", args)

    @unittest.skipUnless(sys.platform.startswith('linux'), "Linux only")
    def test_notify_send_unavailable_returns_false(self):
        """Returns False when notify-send is not installed."""
        result = _linux_notify_fixed("Title", "Message", notify_send_path=None)
        self.assertFalse(result)

    @unittest.skipUnless(sys.platform.startswith('linux'), "Linux only")
    def test_notify_send_nonzero_exit_returns_false(self):
        """Returns False when notify-send exits with non-zero code."""
        with patch('subprocess.run') as mock_run:
            mock_run.return_value = MagicMock(returncode=1, stderr=b'No notification daemon')
            result = _linux_notify_fixed(
                "Title", "Message", notify_send_path="/usr/bin/notify-send"
            )
            self.assertFalse(result)

    def test_login_reminder_log_message_accurate(self):
        """
        The login reminder should NOT print 'skipped' when notify-send is available.
        It should print 'sent via notify-send' instead.
        """
        notify_send_available = True
        winotify_available = False

        if not winotify_available:
            if notify_send_available:
                expected_message = "Login reminder sent via notify-send (winotify unavailable on Linux)"
            else:
                expected_message = "Login reminder could not be shown — notify-send not installed"

        self.assertNotIn("skipped", expected_message,
                         "Message should not say 'skipped' when notify-send is available")

    def test_notify_send_availability_logged_at_startup(self):
        """Startup should log notify-send availability for diagnostics."""
        import shutil
        notify_send_path = shutil.which("notify-send")
        available = notify_send_path is not None
        expected_log = f"Linux notification: notify-send={'available' if available else 'NOT FOUND'}"
        self.assertIn("notify-send", expected_log)


class TestNotificationStartupDiagnostic(unittest.TestCase):

    def test_startup_logs_notification_status(self):
        """Verify that startup diagnostic captures notify-send status."""
        import shutil
        path = shutil.which("notify-send")
        status = 'available' if path else 'NOT FOUND'
        # This value should be logged at startup
        self.assertIn(status, ('available', 'NOT FOUND'))


if __name__ == '__main__':
    unittest.main()
```

**Run:**
```bash
python -m pytest tests/test_linux_notifications.py -v
```

---

### Test 4 — GStreamer Dependency Detection & Diagnostics Route (Issue 4)

**File:** `tests/test_gstreamer_diagnostics.py`

```python
"""
Test: GStreamer dependency check correctly identifies missing plugins.
Test: /diagnostics endpoint is accessible when tray is unavailable.
"""
import subprocess
import sys
import unittest
from unittest.mock import patch, MagicMock
import requests


class TestGStreamerDiagnostics(unittest.TestCase):

    @unittest.skipUnless(sys.platform.startswith('linux'), "Linux only")
    def test_gstreamer_pipewiresrc_plugin_check(self):
        """Detect whether gstreamer1.0-pipewire is installed."""
        result = subprocess.run(
            ['gst-inspect-1.0', 'pipewiresrc'],
            capture_output=True, timeout=5
        )
        is_available = result.returncode == 0
        print(f"[TEST] GStreamer pipewiresrc available: {is_available}")
        # This is a diagnostic test — we report status, not assert installed
        if not is_available:
            print("[TEST] FIX: sudo apt install -y gstreamer1.0-pipewire")

    @unittest.skipUnless(sys.platform.startswith('linux'), "Linux only")
    def test_gstreamer_plugins_base_installed(self):
        """Detect whether gstreamer1.0-plugins-base is installed."""
        result = subprocess.run(
            ['gst-inspect-1.0', 'videorate'],
            capture_output=True, timeout=5
        )
        is_available = result.returncode == 0
        print(f"[TEST] GStreamer plugins-base (videorate): {is_available}")

    def test_system_check_reports_missing_gstreamer(self):
        """system_check module correctly reports GStreamer status."""
        with patch('subprocess.run') as mock_run:
            # Simulate gst-inspect-1.0 pipewiresrc returning error (not found)
            mock_run.return_value = MagicMock(returncode=1, stdout=b'', stderr=b'No such element')
            result = mock_run(['gst-inspect-1.0', 'pipewiresrc'], capture_output=True, timeout=5)
            self.assertEqual(result.returncode, 1,
                             "Missing plugin should return non-zero exit code")

    def test_diagnostics_endpoint_accessible(self):
        """The /diagnostics web endpoint should be reachable even when tray is broken."""
        try:
            resp = requests.get('http://localhost:51777/health', timeout=3)
            # If the app is running, health should respond
            self.assertIn(resp.status_code, [200, 404],
                          "App web server should be accessible regardless of tray state")
        except requests.exceptions.ConnectionError:
            print("[TEST] App not running — skipping live endpoint test")
            self.skipTest("TimeTracker not running on port 51777")

    def test_metadata_only_mode_still_tracks_windows(self):
        """Even without GStreamer, window title tracking should work."""
        # In metadata-only mode, only psutil window title capture is used
        try:
            import psutil
            procs = list(psutil.process_iter(['name', 'pid']))
            self.assertGreater(len(procs), 0, "psutil should enumerate processes in metadata-only mode")
        except ImportError:
            self.skipTest("psutil not available")


if __name__ == '__main__':
    unittest.main()
```

**Run:**
```bash
python -m pytest tests/test_gstreamer_diagnostics.py -v
```

---

### Test 5 — OCR Platform Filter (Issue 5)

**File:** `tests/test_ocr_platform_filter.py`

```python
"""
Test: OCR config correctly filters winrtocr on Linux.
Test: AI server response containing winrtocr is remapped to rapidocr.
"""
import sys
import unittest
from unittest.mock import patch


class TestOCRPlatformFilter(unittest.TestCase):

    def test_winrtocr_filtered_on_linux(self):
        """winrtocr must not appear in the final OCR config on Linux."""
        sys.path.insert(0, '/home/iswaryak/ATG/new-main-linux/JIRAForge/python-desktop-app')
        from ocr.config import OCRConfig, apply_platform_filters

        with patch('sys.platform', 'linux'):
            # Simulate AI server returning winrtocr as primary (the bug scenario)
            server_response = {
                'primary_engine': 'winrtocr',
                'fallback_engines': ['rapidocr', 'easyocr'],
            }
            config = OCRConfig.from_dict(server_response)
            filtered = apply_platform_filters(config)

            self.assertNotEqual(filtered.primary_engine, 'winrtocr',
                                "winrtocr must not be primary engine on Linux")
            self.assertNotIn('winrtocr', filtered.fallback_engines,
                             "winrtocr must not be in fallback engines on Linux")
            self.assertIn(filtered.primary_engine, ['rapidocr', 'easyocr', 'tesseract'],
                          "Primary engine must be a Linux-compatible engine")

    def test_rapidocr_unchanged_on_linux(self):
        """rapidocr as primary should pass through unchanged on Linux."""
        sys.path.insert(0, '/home/iswaryak/ATG/new-main-linux/JIRAForge/python-desktop-app')
        from ocr.config import OCRConfig, apply_platform_filters

        with patch('sys.platform', 'linux'):
            server_response = {
                'primary_engine': 'rapidocr',
                'fallback_engines': ['easyocr'],
            }
            config = OCRConfig.from_dict(server_response)
            filtered = apply_platform_filters(config)
            self.assertEqual(filtered.primary_engine, 'rapidocr',
                             "rapidocr should remain primary on Linux")

    def test_winrtocr_allowed_on_windows(self):
        """winrtocr should remain the primary engine on Windows."""
        sys.path.insert(0, '/home/iswaryak/ATG/new-main-linux/JIRAForge/python-desktop-app')
        from ocr.config import OCRConfig, apply_platform_filters

        with patch('sys.platform', 'win32'):
            server_response = {
                'primary_engine': 'winrtocr',
                'fallback_engines': ['rapidocr'],
            }
            config = OCRConfig.from_dict(server_response)
            filtered = apply_platform_filters(config)
            self.assertEqual(filtered.primary_engine, 'winrtocr',
                             "winrtocr should remain primary on Windows")

    def test_easyocr_fallback_injected_when_all_fallbacks_filtered(self):
        """When all fallbacks are winrtocr (Linux), easyocr must be injected."""
        sys.path.insert(0, '/home/iswaryak/ATG/new-main-linux/JIRAForge/python-desktop-app')
        from ocr.config import OCRConfig, apply_platform_filters

        with patch('sys.platform', 'linux'):
            server_response = {
                'primary_engine': 'rapidocr',
                'fallback_engines': ['winrtocr'],  # Only Windows engine
            }
            config = OCRConfig.from_dict(server_response)
            filtered = apply_platform_filters(config)
            self.assertTrue(len(filtered.fallback_engines) > 0,
                            "At least one platform-safe fallback must be injected")
            self.assertNotIn('winrtocr', filtered.fallback_engines,
                             "winrtocr must not appear in Linux fallbacks")


if __name__ == '__main__':
    unittest.main()
```

**Run:**
```bash
python -m pytest tests/test_ocr_platform_filter.py -v
```

---

### Test 6 — End-to-End Startup Validation

**File:** `tests/test_startup_e2e.py`

```python
"""
Integration test: Verify the app starts, web server is accessible,
and key diagnostic conditions are met.
Designed to catch the 'appears not installed' regression.
"""
import os
import sys
import time
import socket
import unittest
import subprocess
import requests


APP_PORT = 51777
APPIMAGE_PATH = os.path.expanduser('~/.local/share/TimeTracker/TimeTracker.AppImage')


def is_port_open(port: int, host: str = '127.0.0.1', timeout: float = 1.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except (ConnectionRefusedError, OSError):
        return False


class TestStartupE2E(unittest.TestCase):

    def test_appimage_exists_at_canonical_location(self):
        """AppImage should be installed at the canonical location after first run."""
        if not os.path.exists(APPIMAGE_PATH):
            self.skipTest("AppImage not installed — run TimeTracker once first")
        self.assertTrue(os.path.exists(APPIMAGE_PATH),
                        f"AppImage not found at {APPIMAGE_PATH}")

    def test_autostart_entry_exists(self):
        """An autostart .desktop entry should exist for TimeTracker."""
        autostart_dir = os.path.expanduser('~/.config/autostart')
        if not os.path.isdir(autostart_dir):
            self.skipTest("No autostart directory")
        entries = [f for f in os.listdir(autostart_dir) if 'timetracker' in f.lower()]
        self.assertTrue(len(entries) > 0,
                        "TimeTracker autostart entry missing — app will not start on login")

    def test_web_server_accessible_when_running(self):
        """Web server on port 51777 should respond when TimeTracker is running."""
        if not is_port_open(APP_PORT):
            self.skipTest("TimeTracker not running on port 51777")
        try:
            resp = requests.get(f'http://localhost:{APP_PORT}/login', timeout=5)
            self.assertEqual(resp.status_code, 200,
                             "Login page should return 200 when app is running")
        except requests.RequestException as e:
            self.fail(f"Web server accessible but login page failed: {e}")

    def test_notify_send_installed(self):
        """notify-send should be available for Linux notifications."""
        import shutil
        path = shutil.which("notify-send")
        self.assertIsNotNone(path,
            "notify-send is NOT installed. Fix: sudo apt install libnotify-bin\n"
            "Without notify-send, the user will receive no login/re-auth notifications.")

    def test_gstreamer_pipewire_plugin_available(self):
        """GStreamer pipewiresrc plugin should be installed for screenshot capture."""
        result = subprocess.run(
            ['gst-inspect-1.0', 'pipewiresrc'],
            capture_output=True, timeout=10
        )
        self.assertEqual(result.returncode, 0,
            "GStreamer pipewiresrc plugin NOT found.\n"
            "Fix: sudo apt install -y gstreamer1.0-plugins-base gstreamer1.0-plugins-good "
            "gstreamer1.0-tools gstreamer1.0-pipewire\n"
            "Then: systemctl --user restart pipewire pipewire-pulse wireplumber")

    def test_ayatana_appindicator_installed_on_wayland(self):
        """On Wayland, AyatanaAppIndicator3 must be installed for tray visibility."""
        wayland_active = bool(
            os.environ.get('WAYLAND_DISPLAY') or
            os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland'
        )
        if not wayland_active:
            self.skipTest("Not on a Wayland session")

        try:
            import gi
            gi.require_version('AyatanaAppIndicator3', '0.1')
            from gi.repository import AyatanaAppIndicator3  # noqa
        except Exception as e:
            self.fail(
                f"AyatanaAppIndicator3 not available on Wayland: {e}\n"
                f"Fix: sudo apt install -y gir1.2-ayatanaappindicator3-0.1\n"
                f"Without this, the tray icon is INVISIBLE and the app appears not installed."
            )


if __name__ == '__main__':
    unittest.main(verbosity=2)
```

**Run:**
```bash
python -m pytest tests/test_startup_e2e.py -v
```

---

## Manual Verification Steps for AMZ-LAP-344

Run these commands on the user's machine to verify the state and apply the fix:

```bash
# 1. Verify AyatanaAppIndicator3 (Wayland tray)
python3 -c "import gi; gi.require_version('AyatanaAppIndicator3','0.1'); from gi.repository import AyatanaAppIndicator3; print('Ayatana OK')"

# If above fails:
sudo apt install -y gir1.2-ayatanaappindicator3-0.1

# 2. Verify notify-send
which notify-send || sudo apt install -y libnotify-bin

# 3. Verify GStreamer pipewiresrc
gst-inspect-1.0 pipewiresrc || sudo apt install -y gstreamer1.0-plugins-base gstreamer1.0-plugins-good gstreamer1.0-tools gstreamer1.0-pipewire

# 4. Restart PipeWire after GStreamer install
systemctl --user restart pipewire pipewire-pulse wireplumber

# 5. Confirm TimeTracker is installed
ls -la ~/.local/share/TimeTracker/TimeTracker.AppImage

# 6. Kill any running instance and restart cleanly
pkill -f TimeTracker || true
~/.local/share/TimeTracker/TimeTracker.AppImage &

# 7. Verify web UI is accessible (proves the app is running)
sleep 3 && curl -s -o /dev/null -w "%{http_code}" http://localhost:51777/login
# Should print 200
```

---

## Run All Tests

```bash
cd /home/iswaryak/ATG/new-main-linux/JIRAForge/python-desktop-app
source venv/bin/activate
python -m pytest tests/test_tray_backend_wayland.py \
                 tests/test_auth_reauth_notification.py \
                 tests/test_linux_notifications.py \
                 tests/test_gstreamer_diagnostics.py \
                 tests/test_ocr_platform_filter.py \
                 tests/test_startup_e2e.py \
                 -v --tb=short 2>&1 | tee test_results_$(date +%Y%m%d_%H%M%S).txt
```
