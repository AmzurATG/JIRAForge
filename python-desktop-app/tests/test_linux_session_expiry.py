"""
Tests for Linux-specific session expiry fixes.

Covers:
  AC1: Explicit OAUTH_REAUTH_REQUIRED → immediate invalidation (1 request, not 5)
  AC2: Text-matched permanent failures → 5-failure threshold unchanged
  AC3: Login route guards: session_expired=True when token invalid but user cached
  AC4: index() route redirects to /login when refresh token is invalid
  AC5: Linux reauth notification auto-opens browser
  AC6: Tray fallback opens /login when refresh token is invalid

Reference: plan/2026-06-04_python-desktop-app_linux-session-expiry-fix.md
"""

import os
import sys
import threading
import time
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

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
            "fail_count should be set to 5 to block further retries"

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

    def test_oauth_reauth_required_subsequent_calls_blocked_without_network(self):
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

        # Second call — must not hit the network
        with patch('desktop_app.requests.post') as mock_post:
            ok = mgr.refresh_access_token()

        assert ok is False
        mock_post.assert_not_called()

    def test_grace_period_timestamp_set_on_immediate_invalidation(self):
        """
        AC1d: _refresh_invalid_set_at must be populated so the 30-minute
        grace period auto-recovery logic can work correctly.
        """
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

# ===========================================================================
# AC3 & AC4 — _is_session_valid() and render_login_page() banner
# ===========================================================================
# NOTE: Flask is mocked by conftest.py (heavy-stub approach) so we cannot use
# Flask's test client directly. Instead we test the individual helper methods
# and the HTML output of render_login_page() which capture the same logic.

class TestRouteSessionValidityGuards:

    def _make_tracker(self, current_user, refresh_token_invalid):
        from desktop_app import TimeTracker
        tracker = TimeTracker.__new__(TimeTracker)
        tracker.current_user = current_user
        tracker.auth_manager = MagicMock()
        tracker.auth_manager._refresh_token_invalid = refresh_token_invalid
        return tracker

    # --- _is_session_valid() unit tests ---

    def test_session_valid_when_user_and_token_ok(self):
        """AC3c precondition: _is_session_valid() returns True for a live session."""
        user = {'account_id': 'user123', 'email': 'user@example.com'}
        tracker = self._make_tracker(current_user=user, refresh_token_invalid=False)
        assert tracker._is_session_valid() is True

    def test_session_invalid_when_token_flag_set(self):
        """AC3a precondition: _is_session_valid() returns False when token is invalid."""
        user = {'account_id': 'user123', 'email': 'user@example.com'}
        tracker = self._make_tracker(current_user=user, refresh_token_invalid=True)
        assert tracker._is_session_valid() is False

    def test_session_invalid_when_no_user(self):
        """AC3d precondition: _is_session_valid() returns False when there is no user."""
        tracker = self._make_tracker(current_user=None, refresh_token_invalid=False)
        assert tracker._is_session_valid() is False

    def test_session_invalid_when_no_user_and_flag_set(self):
        """_is_session_valid() returns False when both user is None and flag is set."""
        tracker = self._make_tracker(current_user=None, refresh_token_invalid=True)
        assert tracker._is_session_valid() is False

    # --- render_login_page() banner tests ---

    def test_login_route_shows_session_expired_banner(self):
        """
        AC3b: render_login_page(session_expired=True) must include the
        session-expired banner content in the returned HTML.
        """
        from desktop_app import TimeTracker
        tracker = TimeTracker.__new__(TimeTracker)
        html = tracker.render_login_page(session_expired=True)
        assert 'session has expired' in html.lower() or 'SESSION_EXPIRED' in html, \
            "Expected session-expired banner text in login page HTML"
        assert 'login-card' in html, "login-card container must still be present"

    def test_login_route_no_banner_when_not_expired(self):
        """
        AC3d: render_login_page(session_expired=False) must NOT include the
        session-expired banner.
        """
        from desktop_app import TimeTracker
        tracker = TimeTracker.__new__(TimeTracker)
        html = tracker.render_login_page(session_expired=False)
        # Banner contains the amber background color — absence proves it's not shown
        assert 'FFF7D6' not in html, \
            "No session-expired banner expected when session_expired=False"

    def test_render_login_page_default_no_banner(self):
        """render_login_page() with no argument defaults to no banner (backward compat)."""
        from desktop_app import TimeTracker
        tracker = TimeTracker.__new__(TimeTracker)
        html = tracker.render_login_page()
        assert 'FFF7D6' not in html

    def test_login_route_banner_contains_sign_in_prompt(self):
        """Banner text must tell the user to sign in again."""
        from desktop_app import TimeTracker
        tracker = TimeTracker.__new__(TimeTracker)
        html = tracker.render_login_page(session_expired=True)
        assert 'sign in' in html.lower() or 'log in' in html.lower(), \
            "Banner must prompt the user to sign in"

    def test_index_route_uses_is_session_valid(self):
        """
        AC4: When token is invalid (user cached but _refresh_token_invalid=True),
        _is_session_valid() returns False — meaning the index route will redirect
        to /login (not /success).
        """
        user = {'account_id': 'user123', 'email': 'user@example.com'}
        tracker = self._make_tracker(current_user=user, refresh_token_invalid=True)
        # The route calls _is_session_valid() — verify it returns False so the
        # route code takes the redirect-to-login branch.
        assert tracker._is_session_valid() is False, \
            "_is_session_valid() must return False so index() redirects to /login"


# ===========================================================================
# AC5 — Linux: reauth notification auto-opens browser
# ===========================================================================

class TestLinuxNotificationOpensLoginBrowser:
    """Verify that on Linux (WINOTIFY_AVAILABLE=False), the reauth notification
    also opens the browser to the login page."""

    def _make_tracker(self):
        """Build minimal TimeTracker-like object for _show_reauth_notification."""
        from desktop_app import TimeTracker
        tracker = TimeTracker.__new__(TimeTracker)
        tracker.web_port = 51777
        tracker._reauth_notification_last_shown = 0
        tracker._auth_temp_notification_last_shown = 0
        tracker.offline_manager = MagicMock()
        tracker.offline_manager.check_connectivity.return_value = True
        tracker.auth_manager = MagicMock()
        tracker.auth_manager._refresh_invalid_set_at = 0
        tracker.auth_manager._refresh_token_invalid = False
        return tracker

    def test_linux_reauth_notification_opens_browser(self):
        """
        AC5a: On Linux (WINOTIFY_AVAILABLE=False), a non-temporary reauth
        failure must call webbrowser.open() pointing to /login.
        """
        tracker = self._make_tracker()

        with patch('desktop_app.WINOTIFY_AVAILABLE', False), \
             patch('desktop_app._linux_notify') as mock_notify, \
             patch('desktop_app.webbrowser') as mock_wb, \
             patch('desktop_app.log_auth_diagnostic'):
            tracker._show_reauth_notification(reason_code='OAUTH_REAUTH_REQUIRED')

        mock_notify.assert_called_once()
        mock_wb.open.assert_called_once_with('http://localhost:51777/login')

    def test_linux_temporary_failure_does_not_open_browser(self):
        """
        AC5b: A TEMPORARY failure notification must NOT open the browser
        (only permanent failures require immediate user action).
        """
        tracker = self._make_tracker()

        with patch('desktop_app.WINOTIFY_AVAILABLE', False), \
             patch('desktop_app._linux_notify'), \
             patch('desktop_app.webbrowser') as mock_wb, \
             patch('desktop_app.log_auth_diagnostic'):
            tracker._show_reauth_notification(reason_code='OAUTH_TEMPORARY_FAILURE')

        mock_wb.open.assert_not_called()

    def test_linux_notification_throttle_suppresses_browser_open(self):
        """
        AC5c: When the 15-minute throttle suppresses a second notification,
        the browser must also not be opened again.
        """
        tracker = self._make_tracker()
        tracker._reauth_notification_last_shown = time.time()  # Just shown

        with patch('desktop_app.WINOTIFY_AVAILABLE', False), \
             patch('desktop_app._linux_notify') as mock_notify, \
             patch('desktop_app.webbrowser') as mock_wb, \
             patch('desktop_app.log_auth_diagnostic'):
            tracker._show_reauth_notification(reason_code='OAUTH_REAUTH_REQUIRED')

        mock_notify.assert_not_called()
        mock_wb.open.assert_not_called()

    def test_windows_reauth_notification_does_not_open_browser(self):
        """
        AC5d: On Windows (WINOTIFY_AVAILABLE=True), the winotify path is taken.
        webbrowser.open must NOT be called from this path.
        Note: Notification and audio may not be real module attributes on Linux
        (winotify not installed), so create=True is used.
        """
        tracker = self._make_tracker()

        mock_notification = MagicMock()
        with patch('desktop_app.WINOTIFY_AVAILABLE', True), \
             patch('desktop_app.Notification', return_value=mock_notification, create=True), \
             patch('desktop_app.audio', MagicMock(), create=True), \
             patch('desktop_app.webbrowser') as mock_wb, \
             patch('desktop_app.log_auth_diagnostic'):
            tracker._show_reauth_notification(reason_code='OAUTH_REAUTH_REQUIRED')

        mock_wb.open.assert_not_called()


# ===========================================================================
# AC6 — Tray fallback opens /login when refresh token is invalid
# ===========================================================================

class TestTrayFallbackSessionAware:

    def _make_tracker(self, current_user, refresh_token_invalid):
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
        tracker = self._make_tracker(current_user=user, refresh_token_invalid=True)

        with patch('desktop_app.webbrowser') as mock_wb:
            tracker._open_tray_fallback()

        mock_wb.open.assert_called_once_with('http://localhost:51777/login')

    def test_tray_fallback_opens_root_when_session_valid(self):
        """
        AC6b: When session is valid (user exists, token not invalid),
        _open_tray_fallback must open /.
        """
        user = {'account_id': 'u1', 'email': 'u@test.com'}
        tracker = self._make_tracker(current_user=user, refresh_token_invalid=False)

        with patch('desktop_app.webbrowser') as mock_wb:
            tracker._open_tray_fallback()

        mock_wb.open.assert_called_once_with('http://localhost:51777/')

    def test_tray_fallback_opens_login_when_no_user(self):
        """
        AC6c: When there is no current_user at all, _open_tray_fallback opens /login.
        """
        tracker = self._make_tracker(current_user=None, refresh_token_invalid=False)

        with patch('desktop_app.webbrowser') as mock_wb:
            tracker._open_tray_fallback()

        mock_wb.open.assert_called_once_with('http://localhost:51777/login')
