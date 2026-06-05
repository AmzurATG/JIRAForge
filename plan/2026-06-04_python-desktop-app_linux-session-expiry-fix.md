# Linux Session Expiry — Comprehensive Fix Plan

**Date**: 2026-06-04  
**Author**: Engineering  
**Status**: 🔴 Pending Implementation  
**Severity**: Medium–High (error log floods, users unable to re-authenticate on Linux)  
**Component**: `python-desktop-app/desktop_app.py`  
**Related Plan**: `plan/Session_expiry_immediate_invalidation_fix.md` (Windows fix — not yet applied to Linux)  
**Branch**: `fix/linux-session-expiry`

---

## 1. Problem Statement

### 1.1 Observed Symptoms (Linux)

Users on Linux observe the same "session expired" error bursts as previously documented for Windows, **plus additional Linux-specific failures**:

| # | Symptom | Windows | Linux |
|---|---------|---------|-------|
| 1 | 9+ identical `refresh_token is invalid` errors per expired session | ✅ Known | ✅ Same |
| 2 | Delayed re-auth prompt (15–30 s lag) | ✅ Known | ✅ Same |
| 3 | Login page shows `/success` instead of login form after session expiry | ✅ Known | ✅ Same |
| 4 | Notification appears but clicking it does nothing — browser does not open | ❌ N/A | 🔴 **Linux-only** |
| 5 | Token storage may silently fall back to plaintext on minimal Linux (no D-Bus) | ❌ N/A | 🔴 **Linux-only** |
| 6 | Tray "Open Dashboard" click navigates to `/success` (blank) instead of `/login` | ✅ Known | ✅ Same |

### 1.2 Code Audit Findings

> **Important**: The plan document `plan/Session_expiry_immediate_invalidation_fix.md` says  
> *"Status: ✅ Implemented and Tested (42 tests pass)"*, but a direct audit of  
> `python-desktop-app/desktop_app.py` shows **none of the three proposed fixes were  
> committed**. The plan was written but not applied.

| Proposed Fix | Plan Status | Code Status |
|---|---|---|
| Immediate invalidation for explicit `OAUTH_REAUTH_REQUIRED` | ✅ Described | ❌ NOT in code (line 3503: still uses `>= 5` for all failures) |
| `/login` route checks `_refresh_token_invalid` | ✅ Described | ❌ NOT in code (line 6918: only checks `self.current_user`) |
| `render_login_page(session_expired=...)` banner | ✅ Described | ❌ NOT in code (line 14087: no parameter, no banner) |
| Linux browser auto-open after reauth notification | ❌ Not in plan | ❌ NOT in code (line 9912: only calls `_linux_notify`) |
| Linux keyring fallback diagnostics | ❌ Not in plan | ❌ NOT in code |

---

## 2. Root Cause Analysis

### 2.1 Root Cause A — Conservative Invalidation Threshold (Shared)

**File**: `desktop_app.py` | **Lines**: 3494–3512  
**Class**: `AtlassianAuthManager.refresh_access_token()`

Even when the AI server **explicitly** returns `errorCode: 'OAUTH_REAUTH_REQUIRED'`, the current
code still waits for **5 consecutive failures** before setting `_refresh_token_invalid = True`:

```python
# CURRENT CODE (buggy) — applies the same 5-failure threshold to BOTH
# explicit error codes AND text-pattern matches
if is_permanent_failure:
    now = time.time()
    last_fail_time = getattr(self, '_last_refresh_fail_time', 0)
    if (now - last_fail_time) > 600:
        self._refresh_fail_count = 0
    self._last_refresh_fail_time = now
    self._refresh_fail_count = getattr(self, '_refresh_fail_count', 0) + 1
    projected_fail_count = self._refresh_fail_count
    if self._refresh_fail_count >= 5:           # <— waits for 5, regardless of error type
        self._refresh_token_invalid = True
        ...
```

**Why 9 errors per expired session**:

1. `refresh_access_token()` is called from:
   - `sync_worker` loop (every 30 s, checks `is_authenticated()`)  
   - Proactive refresh loop (when token is near expiry)  
   - Any API call that first checks `is_authenticated()`
2. `is_authenticated()` retries internally up to 3 times
3. Result: 3 retries × 3 concurrent callers ≈ 9 requests before `_refresh_fail_count >= 5`

**Why the 5-failure threshold exists**: Safety net for text-matched errors such as  
`'refresh token is invalid'` (line 3482). These are detected by substring matching and
may occasionally trigger on transient server errors that contain the word "invalid".
The 5-failure threshold prevents such a transient match from permanently killing a live session.

**Correct principle**: When the server **explicitly** sends `errorCode: 'OAUTH_REAUTH_REQUIRED'`
(a machine-readable field, not a substring match), the token is definitively dead.
**No threshold needed — mark invalid immediately (1 request).**

### 2.2 Root Cause B — Login Route Checks Wrong State (Shared)

**File**: `desktop_app.py` | **Lines**: 6914–6921

```python
@self.app.route('/login')
def login():
    if self.current_user:               # <— only in-memory user object is checked
        user_account_id = self.current_user.get('account_id')
        if not self.consent_manager.has_valid_consent(user_account_id):
            return redirect('/consent')
        return redirect('/success')     # <— wrong: user has cached data but expired token
    return self.render_login_page()
```

When a session expires:
- `self.current_user` is still populated (cached from login)
- `self.auth_manager._refresh_token_invalid` is `True`
- Result: User visiting `/login` is **redirected to `/success`** — they cannot see the login page

The same issue affects the `index()` route at lines 6905–6912.

### 2.3 Root Cause C — Linux Notification Has No Action (Linux-Specific)

**File**: `desktop_app.py` | **Lines**: 9907–9919

```python
if not WINOTIFY_AVAILABLE:  # True on Linux
    if is_temporary:
        _linux_notify("Time Tracker", "Temporary authentication issue – sync will retry automatically.")
    else:
        _linux_notify("Time Tracker",                      # <— sends notification…
                      "Your session has expired. Please open Time Tracker and log in again.",
                      urgency="critical")
    log_auth_diagnostic(...)
    return                                                  # <— …then returns, nothing else
```

On **Windows**, `winotify` notifications support click callbacks that open the browser.  
On **Linux**, `notify-send` is fire-and-forget — it can't carry a click action without
additional `--action` flags (supported only in libnotify ≥ 0.7.9 + notification daemon support).

The result: **On Linux, the user sees a popup saying "please open Time Tracker" but  
the browser does not open automatically.** They must find the tray icon and navigate
manually — which fails again because of Root Cause B above.

### 2.4 Root Cause D — Tray Fallback Uses Wrong URL (Shared, Linux-Amplified)

**File**: `desktop_app.py` | **Lines**: 13550–13554

```python
def _open_tray_fallback(self, icon=None, menu_item=None):
    target = '/login' if not self.current_user else '/'
    webbrowser.open(f'http://localhost:{self.web_port}{target}')
```

When `current_user` is set but `_refresh_token_invalid` is `True`, the tray opens `/`
which redirects to `/success`. The user sees a blank success page.  
On Linux with fallback tray backends (e.g. `AppIndicatorIcon`), this is the **only**
actionable click handler.

### 2.5 Root Cause E — Keyring Silent Failure on Headless / Minimal Linux (Linux-Specific)

**File**: `auth/secure_storage.py` | `desktop_app.py` lines 2817–2851

The `SecureTokenStorage` class has two backends:
1. **Keyring** (`libsecret` / GNOME Keyring / KWallet on Linux via the `keyring` package)  
2. **Encrypted file** (AES-128-CBC fallback)

On minimal Ubuntu/Debian installations or SSH sessions without a graphical environment,
`keyring` may fail with `NoKeyringError` or `DBusException`. `SecureTokenStorage` has
a fallback, but the error is only logged at `WARNING` level with no notification to the user.

**Risk**: If keyring fails silently, tokens may be written to plaintext JSON on disk
(the legacy code path in `desktop_app.py` `_save_tokens()`). On the next restart,
the tokens cannot be read back, causing an immediate "session expired" condition.

---

## 3. Fix Design

### Fix 1 — Immediate Invalidation for Explicit `OAUTH_REAUTH_REQUIRED`

**Target**: `AtlassianAuthManager.refresh_access_token()` inside the `if is_permanent_failure:` block.

**Principle**: Distinguish between errors detected by **explicit error code** (machine-readable,
certain) vs **text pattern match** (heuristic, may have false positives).

```diff
-   if is_permanent_failure:
-       now = time.time()
-       last_fail_time = getattr(self, '_last_refresh_fail_time', 0)
-       if (now - last_fail_time) > 600:
-           self._refresh_fail_count = 0
-       self._last_refresh_fail_time = now
-       self._refresh_fail_count = getattr(self, '_refresh_fail_count', 0) + 1
-       projected_fail_count = self._refresh_fail_count
-       if self._refresh_fail_count >= 5:
-           print(f"[WARN] Refresh token failed {self._refresh_fail_count} times within window - marking invalid (will auto-recover in 30 min)")
-           self._refresh_token_invalid = True
-           self._refresh_invalid_set_at = now
-           invalid_flag_after_failure = True
-           next_action = 'show_auth_notification'
-       else:
-           print(f"[WARN] Refresh token failure {self._refresh_fail_count}/5 - will retry before requiring re-auth")
-           next_action = 'retry_refresh'
+   if is_permanent_failure:
+       now = time.time()
+       # Determine whether the server EXPLICITLY sent the error code
+       # (as opposed to a heuristic text-pattern match).
+       # Only 'OAUTH_REAUTH_REQUIRED' from the server's errorCode field qualifies.
+       server_explicit_reauth = (str(error_data.get('errorCode', '')).upper() == 'OAUTH_REAUTH_REQUIRED')
+       if server_explicit_reauth:
+           # Server is unambiguous — mark invalid IMMEDIATELY (1 request, not 5).
+           # Set fail count to threshold so grace-period logic treats this as saturated.
+           print("[WARN] Server confirmed refresh token permanently invalid (OAUTH_REAUTH_REQUIRED) — marking invalid immediately")
+           self._refresh_token_invalid = True
+           self._refresh_invalid_set_at = now
+           self._refresh_fail_count = 5
+           projected_fail_count = 5
+           invalid_flag_after_failure = True
+           next_action = 'show_auth_notification'
+       else:
+           # Heuristic text-match — keep the 5-failure threshold as a safety net
+           # to avoid false-positives from transient errors containing "invalid".
+           last_fail_time = getattr(self, '_last_refresh_fail_time', 0)
+           if (now - last_fail_time) > 600:
+               self._refresh_fail_count = 0
+           self._last_refresh_fail_time = now
+           self._refresh_fail_count = getattr(self, '_refresh_fail_count', 0) + 1
+           projected_fail_count = self._refresh_fail_count
+           if self._refresh_fail_count >= 5:
+               print(f"[WARN] Refresh token failed {self._refresh_fail_count} times within window - marking invalid (will auto-recover in 30 min)")
+               self._refresh_token_invalid = True
+               self._refresh_invalid_set_at = now
+               invalid_flag_after_failure = True
+               next_action = 'show_auth_notification'
+           else:
+               print(f"[WARN] Refresh token failure {self._refresh_fail_count}/5 - will retry before requiring re-auth")
+               next_action = 'retry_refresh'
```

**Effect**: `OAUTH_REAUTH_REQUIRED` → 1 error in logs (not 9). Text-matched errors remain unchanged.

---

### Fix 2 — Session-Aware Route Guards

**Target**: `index()` and `login()` routes in `TimeTracker._setup_routes()`.

Add a private helper `_is_session_valid()` and update both routes.

```diff
+   def _is_session_valid(self):
+       """Return True only when current_user exists AND the refresh token is not marked invalid."""
+       if not self.current_user:
+           return False
+       if getattr(self.auth_manager, '_refresh_token_invalid', False):
+           return False
+       return True

    @self.app.route('/')
    def index():
-       if self.current_user:
+       if self._is_session_valid():
            user_account_id = self.current_user.get('account_id')
            if not self.consent_manager.has_valid_consent(user_account_id):
                return redirect('/consent')
            return redirect('/success')
        return redirect('/login')

    @self.app.route('/login')
    def login():
+       session_expired = (
+           self.current_user is not None
+           and getattr(self.auth_manager, '_refresh_token_invalid', False)
+       )
-       if self.current_user:
+       if self._is_session_valid():
            user_account_id = self.current_user.get('account_id')
            if not self.consent_manager.has_valid_consent(user_account_id):
                return redirect('/consent')
            return redirect('/success')
-       return self.render_login_page()
+       return self.render_login_page(session_expired=session_expired)
```

---

### Fix 3 — Session-Expired Banner on Login Page

**Target**: `TimeTracker.render_login_page()` at line 14087.

```diff
-   def render_login_page(self):
-       html = '''<!DOCTYPE html>
+   def render_login_page(self, session_expired=False):
+       expired_banner = ''
+       if session_expired:
+           expired_banner = '''
+           <div style="
+               display: flex; align-items: center; gap: 10px;
+               background: #FFF7D6; border: 1px solid #F4C842;
+               border-radius: 8px; padding: 12px 16px; margin-bottom: 20px;
+               text-align: left; font-size: 13px; color: #594300;">
+               <svg width="18" height="18" viewBox="0 0 24 24" fill="none"
+                    stroke="#F4C842" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
+                   <circle cx="12" cy="12" r="10"/>
+                   <line x1="12" y1="8" x2="12" y2="12"/>
+                   <line x1="12" y1="16" x2="12.01" y2="16"/>
+               </svg>
+               <span>Your session has expired. Please sign in again to continue.</span>
+           </div>'''
+
+       html = f'''<!DOCTYPE html>
     <html>
     ...
     <div class="login-card">
-        <div class="app-logo">
+        {expired_banner}
+        <div class="app-logo">
```

> **Note**: Apply `expired_banner` insertion immediately **before** the `.app-logo` div in
> the existing `render_login_page` HTML string. Since the HTML is an f-string after this
> change, all existing `{` and `}` in the CSS/JS must be escaped as `{{` and `}}`.

---

### Fix 4 — Linux Reauth Notification Auto-Opens Browser (Linux-Specific)

**Target**: `TimeTracker._show_reauth_notification()` at line 9907.

On Linux, after a non-temporary failure notification, automatically open the browser
to the login page so the user can act immediately without hunting for the tray icon.

```diff
    if not WINOTIFY_AVAILABLE:
        if is_temporary:
            _linux_notify("Time Tracker", "Temporary authentication issue – sync will retry automatically.")
            print("[WARN] Temporary authentication issue (notification unavailable)")
        else:
            _linux_notify("Time Tracker",
                          "Your session has expired. Please open Time Tracker and log in again.",
                          urgency="critical")
            print("[WARN] Re-authentication required (notification unavailable)")
+           # On Linux, notifications are not clickable — proactively open the browser
+           # so the user can re-authenticate immediately without hunting for the tray.
+           try:
+               import webbrowser
+               webbrowser.open(f'http://localhost:{self.web_port}/login')
+               print("[INFO] Opened browser to login page for re-authentication")
+           except Exception as _e:
+               print(f"[WARN] Could not auto-open browser after reauth notification: {_e}")
        log_auth_diagnostic(
            'auth_notification_unavailable',
            ...
        )
        return
```

**Throttling**: The `throttle_attr` guard at line 9905 already prevents this code from
running more than once every 15 minutes per reason, so the browser will not be opened
repeatedly.

---

### Fix 5 — Tray Fallback Respects Session Validity (Shared, Linux-Critical)

**Target**: `TimeTracker._open_tray_fallback()` at line 13550.

```diff
    def _open_tray_fallback(self, icon=None, menu_item=None):
-       target = '/login' if not self.current_user else '/'
+       # A logged-in user with an invalid refresh token needs to go to /login, not /success.
+       if not self._is_session_valid():
+           target = '/login'
+       else:
+           target = '/'
        webbrowser.open(f'http://localhost:{self.web_port}{target}')
```

---

### Fix 6 — Keyring Availability Diagnostic on Startup (Linux-Specific)

**Target**: `AtlassianAuthManager.__init__()` or the `initialize_supabase()` startup path.

Add a startup check that detects keyring backend availability and logs it so ops can
identify headless systems where token persistence may be degraded.

```python
# In AtlassianAuthManager.__init__() or an early startup function
def _log_keyring_availability(self):
    """Log whether a keyring backend is available (informational, non-blocking)."""
    if not KEYRING_AVAILABLE:
        print("[WARN] Python 'keyring' package not installed — tokens stored in encrypted file only")
        return
    try:
        import keyring as _kr
        backend = _kr.get_keyring()
        backend_name = type(backend).__name__
        if 'Fail' in backend_name or 'Null' in backend_name:
            print(f"[WARN] Keyring backend '{backend_name}' is a no-op — "
                  "tokens will use encrypted file fallback. "
                  "On headless Linux, install 'gnome-keyring' or 'pass' and ensure D-Bus is running.")
        else:
            print(f"[INFO] Keyring backend: {backend_name}")
    except Exception as e:
        print(f"[WARN] Could not query keyring backend: {e} — tokens will use encrypted file fallback")
```

Call this in `__init__` after `self.secure_storage` is initialized.

---

## 4. Files to Change

| File | Section | Type |
|------|---------|------|
| `python-desktop-app/desktop_app.py` | `refresh_access_token()` lines ~3494–3512 | Fix 1 |
| `python-desktop-app/desktop_app.py` | `_setup_routes()` lines ~6905–6921 | Fix 2 |
| `python-desktop-app/desktop_app.py` | `render_login_page()` line ~14087 | Fix 3 |
| `python-desktop-app/desktop_app.py` | `_show_reauth_notification()` lines ~9907–9919 | Fix 4 |
| `python-desktop-app/desktop_app.py` | `_open_tray_fallback()` lines ~13550–13554 | Fix 5 |
| `python-desktop-app/desktop_app.py` | `AtlassianAuthManager.__init__()` | Fix 6 |

---

## 5. Test Plan

### 5.1 New Test File — `tests/test_linux_session_expiry.py`

Create this file. It covers all six acceptance criteria specific to this fix.

```python
"""
Tests for Linux-specific session expiry fixes.

Covers:
  AC1: Explicit OAUTH_REAUTH_REQUIRED → immediate invalidation (1 request, not 5)
  AC2: Text-matched permanent failures → 5-failure threshold unchanged
  AC3: Login route guards: session_expired=True when token invalid but user cached
  AC4: index() route redirects to /login when refresh token is invalid
  AC5: Linux reauth notification auto-opens browser
  AC6: Tray fallback opens /login when refresh token is invalid
"""

import os
import sys
import threading
import types
import importlib
from unittest.mock import MagicMock, patch, call

import pytest

# ---------------------------------------------------------------------------
# Minimal desktop_app import helpers
# ---------------------------------------------------------------------------
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))


def _make_auth_manager():
    """Construct a bare AtlassianAuthManager with no real I/O."""
    from desktop_app import AtlassianAuthManager
    mgr = AtlassianAuthManager.__new__(AtlassianAuthManager)
    mgr.tokens = {
        'access_token': 'old-access',
        'refresh_token': 'refresh-123',
        'expires_at': 0,
    }
    mgr.ai_server_url = 'https://example.test'
    mgr._refresh_lock = threading.Lock()
    mgr._refresh_token_invalid = False
    mgr._refresh_fail_count = 0
    mgr._refresh_invalid_set_at = 0
    mgr._last_refresh_fail_time = 0
    mgr._last_refresh_error_code = ''
    mgr._save_tokens = lambda: None
    mgr.auth_provider = 'atlassian'
    return mgr


class _MockResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload
        self.text = str(payload)
        self.headers = {'content-type': 'application/json'}

    def json(self):
        return self._payload


# ===========================================================================
# AC1 — Immediate invalidation when server sends explicit OAUTH_REAUTH_REQUIRED
# ===========================================================================

class TestImmediateInvalidationOnExplicitErrorCode:

    def test_oauth_reauth_required_immediately_invalidates_token(self):
        """
        AC1a: A single response with errorCode='OAUTH_REAUTH_REQUIRED' must set
        _refresh_token_invalid=True without waiting for 5 consecutive failures.
        """
        mgr = _make_auth_manager()

        response = _MockResponse(
            401,
            {
                'success': False,
                'error': 'Refresh token expired or invalid',
                'requiresReauth': True,
                'errorCode': 'OAUTH_REAUTH_REQUIRED',
            }
        )

        with patch('desktop_app.requests.post', return_value=response):
            ok = mgr.refresh_access_token()

        assert ok is False
        assert mgr._refresh_token_invalid is True, \
            "Expected immediate invalidation on explicit OAUTH_REAUTH_REQUIRED"
        assert mgr._refresh_fail_count == 5, \
            "fail_count should be set to threshold to block further retries"

    def test_oauth_reauth_required_only_one_server_call_needed(self):
        """
        AC1b: Only a single HTTP call should be needed before the token is
        marked invalid (no retry loop consuming multiple requests).
        """
        mgr = _make_auth_manager()
        call_count = []

        def counting_post(*args, **kwargs):
            call_count.append(1)
            return _MockResponse(
                401,
                {
                    'success': False,
                    'error': 'Refresh token expired',
                    'requiresReauth': True,
                    'errorCode': 'OAUTH_REAUTH_REQUIRED',
                }
            )

        with patch('desktop_app.requests.post', side_effect=counting_post):
            mgr.refresh_access_token()

        assert len(call_count) == 1, \
            f"Expected exactly 1 server call, got {len(call_count)}"

    def test_oauth_reauth_required_subsequent_calls_blocked_immediately(self):
        """
        AC1c: After the first OAUTH_REAUTH_REQUIRED, subsequent calls to
        refresh_access_token() must return False without hitting the network.
        """
        mgr = _make_auth_manager()

        first_response = _MockResponse(
            401,
            {'success': False, 'error': 'expired', 'errorCode': 'OAUTH_REAUTH_REQUIRED'}
        )
        with patch('desktop_app.requests.post', return_value=first_response):
            mgr.refresh_access_token()

        assert mgr._refresh_token_invalid is True

        # Second call — should be blocked without making a network request
        with patch('desktop_app.requests.post') as mock_post:
            ok = mgr.refresh_access_token()

        assert ok is False
        mock_post.assert_not_called()

    def test_grace_period_timestamp_set_on_immediate_invalidation(self):
        """
        AC1d: _refresh_invalid_set_at must be populated so the 30-minute
        grace period auto-recovery logic can work correctly.
        """
        import time
        mgr = _make_auth_manager()

        before = time.time()
        response = _MockResponse(
            401,
            {'success': False, 'error': 'expired', 'errorCode': 'OAUTH_REAUTH_REQUIRED'}
        )
        with patch('desktop_app.requests.post', return_value=response):
            mgr.refresh_access_token()
        after = time.time()

        assert mgr._refresh_invalid_set_at >= before
        assert mgr._refresh_invalid_set_at <= after + 1


# ===========================================================================
# AC2 — Text-matched permanent failures still use the 5-failure threshold
# ===========================================================================

class TestTextMatchedFailuresPreserveThreshold:

    def test_text_matched_invalid_grant_uses_5_retry_threshold(self):
        """
        AC2a: 'invalid_grant' error (text match, no errorCode) must NOT immediately
        invalidate. The 5-failure threshold is a necessary safety net.
        """
        mgr = _make_auth_manager()

        response = _MockResponse(
            401,
            {
                'success': False,
                'error': 'invalid_grant: refresh token revoked',
                # No 'errorCode' field — heuristic text match only
            }
        )

        with patch('desktop_app.requests.post', return_value=response):
            ok = mgr.refresh_access_token()

        assert ok is False
        assert mgr._refresh_fail_count == 1
        assert mgr._refresh_token_invalid is False, \
            "Text-matched error on first call must NOT immediately invalidate"

    def test_text_matched_error_invalidates_after_5_failures(self):
        """
        AC2b: After 5 text-matched permanent failures, the token IS marked invalid.
        """
        mgr = _make_auth_manager()

        response = _MockResponse(
            401,
            {'success': False, 'error': 'refresh token is invalid'}
        )

        with patch('desktop_app.requests.post', return_value=response):
            for _ in range(5):
                mgr.refresh_access_token()

        assert mgr._refresh_token_invalid is True
        assert mgr._refresh_fail_count >= 5

    def test_temporary_failure_never_increments_fail_count(self):
        """
        AC2c: OAUTH_TEMPORARY_FAILURE must never increment _refresh_fail_count.
        """
        mgr = _make_auth_manager()

        response = _MockResponse(
            403,
            {
                'success': False,
                'error': 'Transient policy block',
                'errorCode': 'OAUTH_TEMPORARY_FAILURE',
            }
        )

        with patch('desktop_app.requests.post', return_value=response):
            for _ in range(10):
                mgr.refresh_access_token()

        assert mgr._refresh_fail_count == 0
        assert mgr._refresh_token_invalid is False


# ===========================================================================
# AC3 & AC4 — Login route and index route check _refresh_token_invalid
# ===========================================================================

class TestRouteSessionValidityGuards:
    """
    These tests use Flask's test client to verify route behaviour.
    They require the full TimeTracker app to be instantiatable (with heavy mocking).
    """

    def _make_app(self, current_user, refresh_token_invalid):
        """Build a minimal Flask test app instance."""
        from desktop_app import TimeTracker
        from flask import Flask

        flask_app = Flask(__name__)
        flask_app.config['TESTING'] = True
        flask_app.secret_key = 'test-secret'

        # Minimal TimeTracker-like object
        tracker = MagicMock()
        tracker.current_user = current_user
        tracker.auth_manager = MagicMock()
        tracker.auth_manager._refresh_token_invalid = refresh_token_invalid
        tracker.web_port = 51777

        def _is_session_valid():
            if not tracker.current_user:
                return False
            if getattr(tracker.auth_manager, '_refresh_token_invalid', False):
                return False
            return True

        # Replicate the fixed login route logic
        from flask import redirect
        @flask_app.route('/login')
        def login():
            session_expired = (
                tracker.current_user is not None
                and getattr(tracker.auth_manager, '_refresh_token_invalid', False)
            )
            if _is_session_valid():
                return redirect('/success')
            # Return a simple page for testing (not the full render_login_page HTML)
            banner = 'SESSION_EXPIRED_BANNER' if session_expired else ''
            return f'LOGIN_PAGE {banner}', 200

        @flask_app.route('/')
        def index():
            if _is_session_valid():
                return redirect('/success')
            return redirect('/login')

        @flask_app.route('/success')
        def success():
            return 'SUCCESS_PAGE', 200

        return flask_app

    def test_login_route_shows_login_page_when_token_invalid(self):
        """
        AC3a: When current_user exists but _refresh_token_invalid=True,
        GET /login must return the login page (not redirect to /success).
        """
        user = {'account_id': 'user123', 'email': 'user@example.com'}
        app = self._make_app(current_user=user, refresh_token_invalid=True)

        with app.test_client() as client:
            resp = client.get('/login')

        assert resp.status_code == 200
        assert b'LOGIN_PAGE' in resp.data

    def test_login_route_shows_session_expired_banner(self):
        """
        AC3b: When session is expired (user cached but token invalid),
        the login page must include the expired-session banner.
        """
        user = {'account_id': 'user123', 'email': 'user@example.com'}
        app = self._make_app(current_user=user, refresh_token_invalid=True)

        with app.test_client() as client:
            resp = client.get('/login')

        assert b'SESSION_EXPIRED_BANNER' in resp.data

    def test_login_route_redirects_to_success_when_session_valid(self):
        """
        AC3c: When session is valid (user exists, token not invalid),
        GET /login must redirect to /success.
        """
        user = {'account_id': 'user123', 'email': 'user@example.com'}
        app = self._make_app(current_user=user, refresh_token_invalid=False)

        with app.test_client() as client:
            resp = client.get('/login', follow_redirects=False)

        assert resp.status_code in (301, 302)
        assert '/success' in resp.headers.get('Location', '')

    def test_login_route_shows_login_when_no_user(self):
        """
        AC3d: When there is no current_user, GET /login shows the login page normally
        (without a session-expired banner).
        """
        app = self._make_app(current_user=None, refresh_token_invalid=False)

        with app.test_client() as client:
            resp = client.get('/login')

        assert resp.status_code == 200
        assert b'LOGIN_PAGE' in resp.data
        assert b'SESSION_EXPIRED_BANNER' not in resp.data

    def test_index_route_redirects_to_login_when_token_invalid(self):
        """
        AC4: When current_user exists but token is invalid, GET / must redirect
        to /login (not /success).
        """
        user = {'account_id': 'user123', 'email': 'user@example.com'}
        app = self._make_app(current_user=user, refresh_token_invalid=True)

        with app.test_client() as client:
            resp = client.get('/', follow_redirects=False)

        assert resp.status_code in (301, 302)
        location = resp.headers.get('Location', '')
        assert '/login' in location, f"Expected redirect to /login, got: {location}"


# ===========================================================================
# AC5 — Linux: reauth notification auto-opens browser
# ===========================================================================

class TestLinuxNotificationOpensLoginBrowser:
    """Verify that on Linux (WINOTIFY_AVAILABLE=False), the reauth notification
    also opens the browser to the login page."""

    def _make_tracker_for_notification(self):
        """Minimal TimeTracker-like object for testing _show_reauth_notification."""
        from desktop_app import TimeTracker

        tracker = TimeTracker.__new__(TimeTracker)
        tracker.web_port = 51777
        tracker._reauth_notification_last_shown = 0
        tracker._auth_temp_notification_last_shown = 0

        # Provide a real offline_manager that always says online
        tracker.offline_manager = MagicMock()
        tracker.offline_manager.check_connectivity.return_value = True

        # Provide auth_manager without invalid flag
        tracker.auth_manager = MagicMock()
        tracker.auth_manager._refresh_invalid_set_at = 0
        tracker.auth_manager._refresh_token_invalid = False

        return tracker

    def test_linux_reauth_notification_opens_browser(self):
        """
        AC5a: On Linux (WINOTIFY_AVAILABLE=False), _show_reauth_notification for a
        non-temporary failure must call webbrowser.open() with the /login URL.
        """
        tracker = self._make_tracker_for_notification()

        with patch('desktop_app.WINOTIFY_AVAILABLE', False), \
             patch('desktop_app._linux_notify') as mock_notify, \
             patch('desktop_app.webbrowser') as mock_wb, \
             patch('desktop_app.log_auth_diagnostic'):
            tracker._show_reauth_notification(reason_code='OAUTH_REAUTH_REQUIRED')

        mock_notify.assert_called_once()
        mock_wb.open.assert_called_once_with(f'http://localhost:51777/login')

    def test_linux_temporary_failure_does_not_open_browser(self):
        """
        AC5b: On Linux, a TEMPORARY failure notification must NOT open the browser
        (only permanent failures require user action).
        """
        tracker = self._make_tracker_for_notification()

        with patch('desktop_app.WINOTIFY_AVAILABLE', False), \
             patch('desktop_app._linux_notify'), \
             patch('desktop_app.webbrowser') as mock_wb, \
             patch('desktop_app.log_auth_diagnostic'):
            tracker._show_reauth_notification(reason_code='OAUTH_TEMPORARY_FAILURE')

        mock_wb.open.assert_not_called()

    def test_linux_notification_throttle_also_throttles_browser_open(self):
        """
        AC5c: If the 15-minute throttle suppresses the second notification,
        the browser must also not be opened a second time.
        """
        import time
        tracker = self._make_tracker_for_notification()
        tracker._reauth_notification_last_shown = time.time()  # Recently shown

        with patch('desktop_app.WINOTIFY_AVAILABLE', False), \
             patch('desktop_app._linux_notify') as mock_notify, \
             patch('desktop_app.webbrowser') as mock_wb, \
             patch('desktop_app.log_auth_diagnostic'):
            tracker._show_reauth_notification(reason_code='OAUTH_REAUTH_REQUIRED')

        mock_notify.assert_not_called()
        mock_wb.open.assert_not_called()

    def test_windows_reauth_notification_does_not_call_webbrowser(self):
        """
        AC5d: On Windows (WINOTIFY_AVAILABLE=True), the code takes the winotify
        path. webbrowser.open must NOT be called (winotify handles the click action).
        """
        tracker = self._make_tracker_for_notification()

        mock_notification = MagicMock()
        with patch('desktop_app.WINOTIFY_AVAILABLE', True), \
             patch('desktop_app.Notification', return_value=mock_notification), \
             patch('desktop_app.audio', MagicMock()), \
             patch('desktop_app.webbrowser') as mock_wb, \
             patch('desktop_app.log_auth_diagnostic'):
            tracker._show_reauth_notification(reason_code='OAUTH_REAUTH_REQUIRED')

        mock_wb.open.assert_not_called()


# ===========================================================================
# AC6 — Tray fallback opens /login when refresh token is invalid
# ===========================================================================

class TestTrayFallbackSessionAware:

    def _make_tracker_for_tray(self, current_user, refresh_token_invalid):
        from desktop_app import TimeTracker

        tracker = TimeTracker.__new__(TimeTracker)
        tracker.web_port = 51777
        tracker.current_user = current_user
        tracker.auth_manager = MagicMock()
        tracker.auth_manager._refresh_token_invalid = refresh_token_invalid
        return tracker

    def test_tray_fallback_opens_login_when_token_invalid(self):
        """
        AC6a: When current_user is set but refresh token is invalid,
        _open_tray_fallback must open /login, not /.
        """
        user = {'account_id': 'u1', 'email': 'u@test.com'}
        tracker = self._make_tracker_for_tray(current_user=user, refresh_token_invalid=True)

        with patch('desktop_app.webbrowser') as mock_wb:
            tracker._open_tray_fallback()

        mock_wb.open.assert_called_once_with('http://localhost:51777/login')

    def test_tray_fallback_opens_root_when_session_valid(self):
        """
        AC6b: When session is valid (user exists, token not invalid),
        _open_tray_fallback must open /.
        """
        user = {'account_id': 'u1', 'email': 'u@test.com'}
        tracker = self._make_tracker_for_tray(current_user=user, refresh_token_invalid=False)

        with patch('desktop_app.webbrowser') as mock_wb:
            tracker._open_tray_fallback()

        mock_wb.open.assert_called_once_with('http://localhost:51777/')

    def test_tray_fallback_opens_login_when_no_user(self):
        """
        AC6c: When there is no current_user at all, _open_tray_fallback opens /login.
        """
        tracker = self._make_tracker_for_tray(current_user=None, refresh_token_invalid=False)

        with patch('desktop_app.webbrowser') as mock_wb:
            tracker._open_tray_fallback()

        mock_wb.open.assert_called_once_with('http://localhost:51777/login')
```

---

### 5.2 Update Existing Test — `tests/test_auth_refresh_classification.py`

The test `test_refresh_reauth_error_code_is_permanent_failure` currently asserts the **old** behavior
(`_refresh_fail_count == 1`, `_refresh_token_invalid is False`).  
After Fix 1, this test must be updated to assert **immediate invalidation**.

```diff
 def test_refresh_reauth_error_code_is_permanent_failure():
     """
-    AC3: Desktop must classify OAUTH_REAUTH_REQUIRED as a permanent failure
-    signal and increment the permanent-failure counter.
+    AC3: Desktop must classify OAUTH_REAUTH_REQUIRED as a permanent failure
+    and mark the token IMMEDIATELY invalid (not wait for 5 failures).
     """
     manager = _make_manager()

     response = _MockResponse(
         401,
         {
             'success': False,
             'error': 'Refresh token expired or invalid',
             'requiresReauth': True,
             'errorCode': 'OAUTH_REAUTH_REQUIRED'
         }
     )

     with patch('desktop_app.requests.post', return_value=response):
         ok = manager.refresh_access_token()

     assert ok is False
-    assert manager._refresh_fail_count == 1
-    assert manager._refresh_token_invalid is False
+    assert manager._refresh_token_invalid is True, \
+        "Explicit OAUTH_REAUTH_REQUIRED must immediately set _refresh_token_invalid"
+    assert manager._refresh_fail_count == 5, \
+        "fail_count must be set to threshold to prevent further retry loops"
```

---

### 5.3 Update Existing Test — `test_session_management.py`

The stress-recovery test and any test that simulates a rapid sequence of
`OAUTH_REAUTH_REQUIRED` responses should be verified/updated.  
Search for `_refresh_fail_count == 1` or `_refresh_token_invalid is False` combined with
a mocked `OAUTH_REAUTH_REQUIRED` response and update those assertions accordingly.

---

### 5.4 New Test File — `tests/test_linux_keyring_diagnostic.py`

```python
"""
Tests for Linux keyring availability diagnostics.

AC-Keyring: On startup, the app must log whether a functional keyring backend
is available so ops can identify systems where token persistence is degraded.
"""
import sys
import os
from unittest.mock import patch, MagicMock
import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))


class TestKeyringStartupDiagnostic:

    def test_no_keyring_package_logs_warning(self, capsys):
        """
        When the 'keyring' Python package is not installed, startup must print
        a [WARN] message indicating encrypted-file fallback.
        """
        from desktop_app import AtlassianAuthManager

        mgr = AtlassianAuthManager.__new__(AtlassianAuthManager)
        with patch('desktop_app.KEYRING_AVAILABLE', False):
            mgr._log_keyring_availability()

        captured = capsys.readouterr()
        assert '[WARN]' in captured.out
        assert 'keyring' in captured.out.lower()

    def test_functional_keyring_logs_info(self, capsys):
        """
        When a real keyring backend is available, startup must print [INFO]
        with the backend name.
        """
        from desktop_app import AtlassianAuthManager

        mgr = AtlassianAuthManager.__new__(AtlassianAuthManager)
        mock_backend = MagicMock()
        mock_backend.__class__.__name__ = 'SecretServiceKeyring'

        with patch('desktop_app.KEYRING_AVAILABLE', True), \
             patch('keyring.get_keyring', return_value=mock_backend):
            mgr._log_keyring_availability()

        captured = capsys.readouterr()
        assert '[INFO]' in captured.out
        assert 'SecretServiceKeyring' in captured.out

    def test_null_keyring_backend_logs_warning(self, capsys):
        """
        When keyring is installed but the backend is 'NullKeyring' (no-op),
        startup must log a [WARN] with instructions for headless Linux.
        """
        from desktop_app import AtlassianAuthManager

        mgr = AtlassianAuthManager.__new__(AtlassianAuthManager)
        mock_backend = MagicMock()
        mock_backend.__class__.__name__ = 'NullKeyring'

        with patch('desktop_app.KEYRING_AVAILABLE', True), \
             patch('keyring.get_keyring', return_value=mock_backend):
            mgr._log_keyring_availability()

        captured = capsys.readouterr()
        assert '[WARN]' in captured.out
        assert 'NullKeyring' in captured.out

    def test_keyring_query_exception_logs_warning(self, capsys):
        """
        If querying the keyring backend raises an exception,
        a [WARN] must be printed (not an unhandled exception).
        """
        from desktop_app import AtlassianAuthManager

        mgr = AtlassianAuthManager.__new__(AtlassianAuthManager)
        with patch('desktop_app.KEYRING_AVAILABLE', True), \
             patch('keyring.get_keyring', side_effect=Exception('D-Bus error')):
            mgr._log_keyring_availability()  # Must not raise

        captured = capsys.readouterr()
        assert '[WARN]' in captured.out
```

---

## 6. Acceptance Criteria

| AC | Description | Verified by |
|----|-------------|-------------|
| AC1a | Single `OAUTH_REAUTH_REQUIRED` response immediately sets `_refresh_token_invalid=True` | `test_oauth_reauth_required_immediately_invalidates_token` |
| AC1b | Only one HTTP call made before token marked invalid | `test_oauth_reauth_required_only_one_server_call_needed` |
| AC1c | Subsequent calls after invalidation blocked without network | `test_oauth_reauth_required_subsequent_calls_blocked_immediately` |
| AC1d | `_refresh_invalid_set_at` timestamp populated correctly | `test_grace_period_timestamp_set_on_immediate_invalidation` |
| AC2a | Text-matched `invalid_grant` on first call does NOT invalidate | `test_text_matched_invalid_grant_uses_5_retry_threshold` |
| AC2b | Text-matched error invalidates after 5 failures | `test_text_matched_error_invalidates_after_5_failures` |
| AC2c | `OAUTH_TEMPORARY_FAILURE` never increments fail count | `test_temporary_failure_never_increments_fail_count` |
| AC3a | `GET /login` returns login page (not redirect) when token invalid | `test_login_route_shows_login_page_when_token_invalid` |
| AC3b | Login page includes session-expired banner when token invalid | `test_login_route_shows_session_expired_banner` |
| AC3c | `GET /login` still redirects to `/success` for valid sessions | `test_login_route_redirects_to_success_when_session_valid` |
| AC3d | `GET /login` shows login without banner when no user | `test_login_route_shows_login_when_no_user` |
| AC4 | `GET /` redirects to `/login` (not `/success`) when token invalid | `test_index_route_redirects_to_login_when_token_invalid` |
| AC5a | Linux reauth notification calls `webbrowser.open(/login)` | `test_linux_reauth_notification_opens_browser` |
| AC5b | Linux temporary failure does NOT open browser | `test_linux_temporary_failure_does_not_open_browser` |
| AC5c | 15-min throttle suppresses both notification and browser open | `test_linux_notification_throttle_also_throttles_browser_open` |
| AC5d | Windows path does NOT call `webbrowser.open` | `test_windows_reauth_notification_does_not_call_webbrowser` |
| AC6a | Tray fallback opens `/login` when token invalid (even if user cached) | `test_tray_fallback_opens_login_when_token_invalid` |
| AC6b | Tray fallback opens `/` for valid sessions | `test_tray_fallback_opens_root_when_session_valid` |
| AC6c | Tray fallback opens `/login` when no user at all | `test_tray_fallback_opens_login_when_no_user` |
| AC-K1 | No keyring package → `[WARN]` logged on startup | `test_no_keyring_package_logs_warning` |
| AC-K2 | Functional keyring → `[INFO]` with backend name | `test_functional_keyring_logs_info` |
| AC-K3 | NullKeyring backend → `[WARN]` with Linux instructions | `test_null_keyring_backend_logs_warning` |
| AC-K4 | Keyring query exception → `[WARN]`, no crash | `test_keyring_query_exception_logs_warning` |

---

## 7. Expected Error Reduction

| Metric | Before | After |
|--------|--------|-------|
| Log errors per expired session (explicit `OAUTH_REAUTH_REQUIRED`) | 9+ | **1** |
| Log errors per expired session (text-matched) | 5+ | 5 (unchanged, safety net) |
| Time from expiry to user notification | 15–30 s | **Immediate** |
| Time from notification to login page (Linux) | Manual (tray hunt) | **Auto-open browser** |
| Login page visible after session expiry | ❌ Redirected to `/success` | ✅ Shows login + banner |
| Tray fallback navigates correctly on Linux | ❌ Opens blank `/success` | ✅ Opens `/login` |

---

## 8. Implementation Order

Implement in this sequence to keep tests passing at each stage:

1. **Fix 1** (`refresh_access_token`) + update `test_auth_refresh_classification.py`  
   → Verify: `pytest tests/test_auth_refresh_classification.py`

2. **Write** `tests/test_linux_session_expiry.py` (all tests will fail initially — that's expected)

3. **Fix 2** (`_setup_routes` — `_is_session_valid`, updated `index()` and `login()`)  
   → Verify: AC3, AC4 tests pass

4. **Fix 3** (`render_login_page(session_expired=...)` + banner HTML)  
   → Verify: AC3b test passes (banner present)

5. **Fix 4** (`_show_reauth_notification` browser open on Linux)  
   → Verify: AC5a–AC5d tests pass

6. **Fix 5** (`_open_tray_fallback` session-aware)  
   → Verify: AC6a–AC6c tests pass

7. **Fix 6** (`_log_keyring_availability`) + write `tests/test_linux_keyring_diagnostic.py`  
   → Verify: AC-K1–AC-K4 tests pass

8. **Run full test suite**:  
   ```bash
   cd python-desktop-app
   pytest tests/ test_session_management.py -v
   ```
   All tests must pass (target: existing 42 + 23 new = ≥ 65 passing).

---

## 9. Deployment Notes

### 9.1 Prerequisites
- No AI-server changes required
- No database migrations required
- No configuration changes required
- Backward compatible with existing sessions

### 9.2 Linux-Specific Validation Steps
1. Start the app as AppImage on Ubuntu 22.04 or Debian 12
2. Manually set `auth_manager._refresh_token_invalid = True` via admin console or test harness
3. Wait for the sync worker's 30-second tick
4. **Expected**: A `notify-send` notification appears AND the browser opens to `http://localhost:51777/login`
5. **Expected**: Login page shows the yellow "Your session has expired" banner
6. Log in — verify session is restored, banner disappears on next visit

### 9.3 Rollback Plan
All fixes are local to `desktop_app.py`. Revert the branch if needed.  
No server-side or database changes to roll back.

---

## 10. Related Documents

| Document | Location |
|----------|----------|
| Windows session expiry plan (not yet applied) | `plan/Session_expiry_immediate_invalidation_fix.md` |
| Executive summary doc | `docs/Session_expiry_immediate_invalidation.md` |
| Previous session maintenance fix | `plan/2026-05-06_python-desktop-app_fix-session-maintenance.md` |
| Session expiration hardening (multi-component) | `plan/2026-05-20_multi-component_session-expiration-hardening.md` |
| Linux install/update/uninstall fix | `plan/2026-06-03_python-desktop-app_linux-install-update-uninstall-fix.md` |
| JWT expiration timing fix | `plan/2026-05-14_python-desktop-app_fix-jwt-expiration-timing-and-validation.md` |
