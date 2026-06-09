"""
Tests for refresh failure classification hardening.

Reference:
plan/2026-05-20_multi-component_session-expiration-hardening.md
"""

import os
import sys
import threading
from unittest.mock import MagicMock, patch

# Add parent directory to path for desktop_app imports
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

from desktop_app import AtlassianAuthManager


class _MockResponse:
    def __init__(self, status_code, payload):
        self.status_code = status_code
        self._payload = payload
        self.text = str(payload)
        self.headers = {'content-type': 'application/json'}

    def json(self):
        return self._payload


def _make_manager():
    manager = AtlassianAuthManager.__new__(AtlassianAuthManager)
    manager.tokens = {
        'access_token': 'old-access',
        'refresh_token': 'refresh-123',
        'expires_at': 0,
    }
    manager.ai_server_url = 'https://example.test'
    manager._refresh_lock = threading.Lock()
    manager._refresh_token_invalid = False
    manager._refresh_fail_count = 0
    manager._refresh_invalid_set_at = 0
    manager._last_refresh_fail_time = 0
    manager._last_refresh_error_code = ''
    manager._last_token_refresh_time = 0
    manager._token_refresh_min_interval = 5
    manager._save_tokens = lambda: None
    return manager


def test_refresh_initializes_missing_rate_limit_state_on_legacy_instance():
    """
    Legacy/partially-initialized AtlassianAuthManager instances must not crash
    refresh_access_token() with AttributeError for missing rate-limit fields.
    """
    manager = AtlassianAuthManager.__new__(AtlassianAuthManager)
    manager.tokens = {
        'access_token': 'old-access',
        'refresh_token': 'refresh-123',
        'expires_at': 0,
    }
    manager.ai_server_url = 'https://example.test'
    manager._refresh_lock = threading.Lock()
    manager._refresh_token_invalid = False
    manager._refresh_fail_count = 0
    manager._refresh_invalid_set_at = 0
    manager._last_refresh_fail_time = 0
    manager._last_refresh_error_code = ''
    manager._save_tokens = lambda: None

    response = _MockResponse(503, {'success': False, 'error': 'temporary outage'})

    with patch('desktop_app.requests.post', return_value=response):
        ok = manager.refresh_access_token()

    assert ok is False
    assert hasattr(manager, '_last_token_refresh_time')
    assert hasattr(manager, '_token_refresh_min_interval')


def test_refresh_403_temporary_failure_does_not_mark_invalid():
    """
    AC4: Desktop must not mark refresh token permanently invalid solely because
    the refresh endpoint returned HTTP 403 with temporary failure semantics.
    """
    manager = _make_manager()

    response = _MockResponse(
        403,
        {
            'success': False,
            'error': 'Token refresh failed: transient policy block',
            'errorCode': 'OAUTH_TEMPORARY_FAILURE'
        }
    )

    with patch('desktop_app.requests.post', return_value=response):
        ok = manager.refresh_access_token()

    assert ok is False
    assert manager._refresh_fail_count == 0
    assert manager._refresh_token_invalid is False


def test_refresh_reauth_error_code_is_permanent_failure():
    """
    AC3: Desktop must classify OAUTH_REAUTH_REQUIRED as a permanent failure
    and mark the token invalid IMMEDIATELY (not after 5 failures).
    
    Updated: OAUTH_REAUTH_REQUIRED now triggers immediate invalidation to prevent
    the log-flood of repeated "refresh_token is invalid" errors.
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
    # OAUTH_REAUTH_REQUIRED now causes IMMEDIATE invalidation (not waiting for 5 failures)
    assert manager._refresh_fail_count == 5  # Set to threshold to prevent further retries
    assert manager._refresh_token_invalid is True


def test_refresh_text_match_underscore_phrasing_is_permanent():
    """
    Fallback path (no errorCode in body): Atlassian's exact wording
    'refresh_token is invalid' (underscore) must be classified permanent.
    The previous list only had the space variant and missed this.
    """
    manager = _make_manager()

    response = _MockResponse(
        403,
        {
            'success': False,
            'error': 'Token refresh failed: refresh_token is invalid'
            # NOTE: deliberately no 'errorCode' — exercises the text-match branch
        }
    )

    with patch('desktop_app.requests.post', return_value=response):
        ok = manager.refresh_access_token()

    assert ok is False
    assert manager._refresh_fail_count == 1  # permanent → counter incremented


def test_refresh_text_match_unauthorized_client_is_permanent():
    """
    Fallback path: Atlassian's 'unauthorized_client' error code in the body text
    (no explicit errorCode field) must be classified permanent.
    """
    manager = _make_manager()

    response = _MockResponse(
        403,
        {
            'success': False,
            'error': 'Token refresh failed: unauthorized_client'
        }
    )

    with patch('desktop_app.requests.post', return_value=response):
        ok = manager.refresh_access_token()

    assert ok is False
    assert manager._refresh_fail_count == 1


def test_refresh_text_match_globally_revoked_is_permanent():
    """Fallback path: 'Token was globally revoked' must be classified permanent."""
    manager = _make_manager()

    response = _MockResponse(
        403,
        {
            'success': False,
            'error': 'Token refresh failed: Token was globally revoked'
        }
    )

    with patch('desktop_app.requests.post', return_value=response):
        ok = manager.refresh_access_token()

    assert ok is False
    assert manager._refresh_fail_count == 1


def test_refresh_failure_logs_root_cause_details():
    """
    Auth expiration diagnostics must include machine-readable root cause context
    in the desktop log file so support can distinguish reauth vs temporary failure.
    """
    manager = _make_manager()
    mock_logger = MagicMock()

    response = _MockResponse(
        401,
        {
            'success': False,
            'error': 'Refresh token expired or invalid',
            'requiresReauth': True,
            'errorCode': 'OAUTH_REAUTH_REQUIRED'
        }
    )

    with patch('desktop_app.APP_LOGGER_AVAILABLE', True), \
         patch('desktop_app.get_logger', return_value=mock_logger), \
         patch('desktop_app.requests.post', return_value=response):
        ok = manager.refresh_access_token()

    assert ok is False

    warning_messages = [str(call.args[0]) for call in mock_logger.warning.call_args_list if call.args]
    assert any('token_refresh_failed' in msg for msg in warning_messages)
    assert any('http_status=401' in msg for msg in warning_messages)
    assert any('error_code=OAUTH_REAUTH_REQUIRED' in msg for msg in warning_messages)
    assert any('permanent_failure=True' in msg for msg in warning_messages)


def test_oauth_reauth_required_immediately_invalidates_token():
    """
    When server returns OAUTH_REAUTH_REQUIRED, the refresh token must be
    marked invalid IMMEDIATELY on the first failure, not after 5 retries.
    
    This prevents the log-flood of ~9 identical "refresh_token is invalid"
    errors that occurs when is_authenticated() and other callers each retry
    multiple times before the 5-failure threshold is reached.
    """
    manager = _make_manager()

    response = _MockResponse(
        401,
        {
            'success': False,
            'error': 'Refresh token expired, revoked, or rotated out. User must re-authenticate.',
            'requiresReauth': True,
            'errorCode': 'OAUTH_REAUTH_REQUIRED'
        }
    )

    with patch('desktop_app.requests.post', return_value=response):
        # First call should fail and immediately mark token invalid
        ok = manager.refresh_access_token()

    assert ok is False
    # Key assertion: token should be marked invalid after FIRST failure, not 5th
    assert manager._refresh_token_invalid is True
    assert manager._refresh_fail_count == 5  # Set to threshold to prevent further retries


def test_non_explicit_permanent_failure_uses_5_retry_threshold():
    """
    When permanent failure is detected via text matching (not explicit errorCode),
    the 5-failure threshold should still apply as a safety net.
    """
    manager = _make_manager()

    # Simulate older server response without explicit errorCode
    response = _MockResponse(
        400,
        {
            'success': False,
            'error': 'Token refresh failed: refresh_token is invalid'
            # Note: no 'errorCode' field - fallback text matching will be used
        }
    )

    with patch('desktop_app.requests.post', return_value=response):
        # First call should fail but NOT immediately invalidate
        ok = manager.refresh_access_token()

    assert ok is False
    # Token should NOT be marked invalid yet - need 5 failures for text-matched permanent errors
    assert manager._refresh_token_invalid is False
    assert manager._refresh_fail_count == 1
