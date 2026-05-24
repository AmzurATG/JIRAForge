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
    manager._save_tokens = lambda: None
    return manager


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
    signal and increment the permanent-failure counter.
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
    assert manager._refresh_fail_count == 1
    assert manager._refresh_token_invalid is False


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
