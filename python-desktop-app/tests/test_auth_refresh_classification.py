"""
Tests for refresh failure classification hardening.

Reference:
plan/2026-05-20_multi-component_session-expiration-hardening.md
"""

import os
import sys
import threading
import time
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
    # B-15 rate-limit fields — must mirror AtlassianAuthManager.__init__, which is
    # bypassed here via __new__. (Their absence is exactly the production bug:
    # "'AtlassianAuthManager' object has no attribute '_last_token_refresh_time'".)
    manager._last_token_refresh_time = 0
    manager._token_refresh_min_interval = 5
    manager._save_tokens = lambda: None
    # Phase 0 fields (mirror __init__): permanent dead-token flag + network gate.
    # The gate is stubbed True so classification tests never touch real sockets;
    # the network-gate tests below override it / exercise the real method.
    manager._refresh_invalid_permanent = False
    manager._wait_for_network = lambda *a, **k: True
    # These tests target the LEGACY rotation path: mark custody migration as
    # already attempted so refresh_access_token doesn't add a migrate-custody
    # POST (the custody flow has its own suite: test_token_custody_client.py).
    manager._custody_migration_attempted = True
    return manager


# ---------------------------------------------------------------------------
# Regression (Fix 1): the B-15 rate-limit fields must be initialized on
# AtlassianAuthManager itself. They were only set on the TimeTracker class,
# which broke every token refresh after restart/expiry with
# "'AtlassianAuthManager' object has no attribute '_last_token_refresh_time'".
# ---------------------------------------------------------------------------
def test_init_sets_rate_limit_attributes(tmp_path):
    with patch('desktop_app.get_app_data_dir', return_value=str(tmp_path)), \
         patch('desktop_app.SecureTokenStorage'), \
         patch.object(AtlassianAuthManager, '_migrate_from_plaintext', lambda self: None), \
         patch.object(AtlassianAuthManager, '_load_tokens', lambda self: {}):
        mgr = AtlassianAuthManager(web_port=51777)
    assert hasattr(mgr, '_last_token_refresh_time'), "rate-limit field missing from __init__"
    assert hasattr(mgr, '_token_refresh_min_interval')
    assert mgr._token_refresh_min_interval == 5


# ---------------------------------------------------------------------------
# Regression (Fix 2): a MISSING access_token must attempt a refresh (and so
# reach the OAUTH_REAUTH_REQUIRED path) instead of silently dead-ending.
# ---------------------------------------------------------------------------
def test_missing_access_token_triggers_refresh():
    mgr = _make_manager()
    mgr.auth_provider = 'atlassian'
    mgr.tokens['access_token'] = None
    calls = {'n': 0}
    def fake_refresh():
        calls['n'] += 1
        return False  # no valid refresh token
    mgr.refresh_access_token = fake_refresh
    result = mgr.get_supabase_token()
    assert calls['n'] == 1, "missing access_token must attempt refresh_access_token()"
    assert result is None


def test_missing_access_token_self_heals_when_refresh_succeeds():
    mgr = _make_manager()
    mgr.auth_provider = 'atlassian'
    mgr.tokens['access_token'] = None
    def fake_refresh():
        mgr.tokens['access_token'] = 'new-access'
        return True
    mgr.refresh_access_token = fake_refresh
    resp = _MockResponse(200, {'success': True, 'supabase_token': 'sb-tok', 'expires_in': 3600, 'user': {}})
    with patch('desktop_app.requests.post', return_value=resp):
        result = mgr.get_supabase_token()
    assert result == 'sb-tok', "should self-heal via refresh when access_token was missing"


def test_is_authenticated_tries_refresh_when_access_token_missing():
    mgr = _make_manager()
    mgr.auth_provider = 'atlassian'
    mgr.tokens['access_token'] = None
    def fake_refresh():
        mgr.tokens['access_token'] = 'new-access'
        return True
    mgr.refresh_access_token = fake_refresh
    assert mgr.is_authenticated() is True


# ---------------------------------------------------------------------------
# Regression (Fix 3): the 1.4.5 storm signature — server returns
# OAUTH_TEMPORARY_FAILURE but the text says the refresh token is invalid (dead).
# Dead-token TEXT must override the (wrong) temporary label -> permanent ->
# stop retrying. Previously this was treated as temporary -> infinite retry.
# ---------------------------------------------------------------------------
def test_temporary_label_with_dead_token_text_is_permanent():
    manager = _make_manager()
    response = _MockResponse(403, {
        'success': False,
        'error': 'Token refresh failed: refresh_token is invalid',
        'errorCode': 'OAUTH_TEMPORARY_FAILURE',
    })
    with patch('desktop_app.requests.post', return_value=response):
        ok = manager.refresh_access_token()
    assert ok is False
    # Permanent classification increments the fail counter; the temporary path never does.
    # (Before the fix this stayed 0 forever -> the storm.)
    assert manager._refresh_fail_count == 1, "dead-token text must be classified permanent, not temporary"


def test_storm_signature_marks_invalid_after_threshold():
    """Enough dead-token failures (mislabeled temporary) must mark the token invalid
    so retries stop and re-auth is surfaced — i.e. the storm ends."""
    manager = _make_manager()
    manager._token_refresh_min_interval = 0  # disable rate-limit for this loop
    response = _MockResponse(403, {
        'success': False,
        'error': 'Token refresh failed: refresh_token is invalid',
        'errorCode': 'OAUTH_TEMPORARY_FAILURE',
    })
    with patch('desktop_app.requests.post', return_value=response):
        for _ in range(5):
            manager.refresh_access_token()
    assert manager._refresh_token_invalid is True, "5 dead-token failures must mark token invalid (stop the storm)"


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


# ---------------------------------------------------------------------------
# Phase 0 (plan/2026-06-12_auth_server-side-token-custody.md): network gate.
# A refresh must never transmit the single-use rotating token into a network
# that is still coming up after sleep — that is how the rotated replacement
# gets lost in transit and the session dies permanently (2026-06-12 incident).
# ---------------------------------------------------------------------------
def test_wait_for_network_true_when_reachable():
    manager = AtlassianAuthManager.__new__(AtlassianAuthManager)
    manager.ai_server_url = 'https://example.test'
    mock_sock = MagicMock()  # connect() succeeds silently
    with patch('desktop_app.socket.socket', return_value=mock_sock):
        assert AtlassianAuthManager._wait_for_network(manager, timeout_seconds=2) is True
    assert mock_sock.connect.called


def test_wait_for_network_false_when_unreachable():
    manager = AtlassianAuthManager.__new__(AtlassianAuthManager)
    manager.ai_server_url = 'https://example.test'
    mock_sock = MagicMock()
    mock_sock.connect.side_effect = OSError('network is down')
    with patch('desktop_app.socket.socket', return_value=mock_sock):
        assert AtlassianAuthManager._wait_for_network(
            manager, timeout_seconds=0.3, poll_interval=0.1
        ) is False


def test_refresh_deferred_when_network_down_is_not_a_failure():
    """No network → the refresh token must NOT be transmitted, and the deferral
    must NOT count toward the failure threshold or invalid flag."""
    manager = _make_manager()
    manager._wait_for_network = lambda *a, **k: False
    post = MagicMock()
    with patch('desktop_app.requests.post', post):
        ok = manager.refresh_access_token()
    assert ok is False
    assert post.call_count == 0, "refresh token must never be sent while network is down"
    assert manager._refresh_fail_count == 0
    assert manager._refresh_token_invalid is False


# ---------------------------------------------------------------------------
# Phase 0: server-confirmed dead token (OAUTH_REAUTH_REQUIRED) must be
# PERMANENT — the 30-min grace must not auto-clear it and re-notify forever.
# Only a fresh login (or a successful refresh) recovers.
# ---------------------------------------------------------------------------
def test_explicit_reauth_sets_permanent_flag():
    manager = _make_manager()
    response = _MockResponse(401, {
        'success': False,
        'error': 'Refresh token expired, revoked, or rotated out. User must re-authenticate.',
        'requiresReauth': True,
        'errorCode': 'OAUTH_REAUTH_REQUIRED'
    })
    with patch('desktop_app.requests.post', return_value=response):
        ok = manager.refresh_access_token()
    assert ok is False
    assert manager._refresh_token_invalid is True
    assert manager._refresh_invalid_permanent is True


def test_permanent_flag_blocks_retry_even_after_grace_expiry():
    manager = _make_manager()
    manager._refresh_token_invalid = True
    manager._refresh_invalid_permanent = True
    manager._refresh_invalid_set_at = time.time() - 3600  # far past the 30-min grace
    post = MagicMock()
    with patch('desktop_app.requests.post', post):
        ok = manager.refresh_access_token()
    assert ok is False
    assert post.call_count == 0, "a server-confirmed dead token must never be retried"
    assert manager._refresh_token_invalid is True


def test_nonpermanent_flag_still_autoclears_after_grace():
    """Regression guard: the grace auto-clear must keep working for
    text-matched (non-explicit) failures — transient outages must self-heal."""
    manager = _make_manager()
    manager._refresh_token_invalid = True
    manager._refresh_invalid_permanent = False
    manager._refresh_invalid_set_at = time.time() - 3600
    response = _MockResponse(200, {
        'success': True,
        'access_token': 'new-access',
        'refresh_token': 'new-refresh',
        'expires_in': 3600
    })
    with patch('desktop_app.requests.post', return_value=response) as post:
        ok = manager.refresh_access_token()
    assert ok is True
    assert post.call_count == 1
    assert manager._refresh_token_invalid is False
    assert manager._refresh_invalid_permanent is False
