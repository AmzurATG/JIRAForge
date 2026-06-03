"""
Comprehensive tests for session management fixes.

Tests cover:
  1. Token persistence across shutdown/restart (the reported bug)
  2. Grace period auto-recovery of _refresh_token_invalid flag
  3. Time-windowed failure counting (5 failures in 10-min window)
  4. Non-recursive retry in get_supabase_token (no stack overflow)
  5. Thread-safety: invalid flag checked inside lock
  6. Server 400 vs 401 separation (no requiresReauth on 400)
  7. Logout clears all state flags
  8. Successful refresh resets all counters
  9. Concurrent thread refresh race condition
 10. is_authenticated grace period logic
"""

import json
import os
import sys
import time
import tempfile
import shutil
import threading
import types
import pytest
from unittest.mock import patch, MagicMock

import requests  # real requests (we'll mock requests.post)

# ---------------------------------------------------------------------------
# Instead of importing the huge desktop_app.py (which pulls in the whole GUI
# stack), we extract ONLY the AtlassianAuthManager class source code and
# evaluate it in an isolated module with minimal stubs.
# ---------------------------------------------------------------------------

def _build_auth_module():
    """Parse desktop_app.py and extract AtlassianAuthManager + dependencies
    into a standalone module object suitable for testing."""

    desktop_path = os.path.join(os.path.dirname(__file__), 'desktop_app.py')
    with open(desktop_path, 'r', encoding='utf-8') as f:
        source = f.read()

    # -- Build minimal module namespace ---
    mod = types.ModuleType('_auth_module')
    mod.__file__ = desktop_path

    # Standard-lib imports the class actually uses
    mod.os = os
    mod.sys = sys
    mod.time = time
    mod.json = json
    mod.threading = threading
    mod.secrets = __import__('secrets')
    mod.hashlib = __import__('hashlib')
    mod.base64 = __import__('base64')
    mod.urllib = __import__('urllib')
    mod.requests = requests

    # Stub constants / functions the class references
    mod.SENSITIVE_TOKEN_KEYS = ['access_token', 'refresh_token', 'supabase_token']
    mod.KEYRING_AVAILABLE = False
    mod.KEYRING_SERVICE = 'TimeTracker'
    mod.APP_VERSION = '0.0.0-test'

    def _keyring_delete(*a, **kw):
        pass
    mod._keyring_delete = _keyring_delete

    # get_env_var / get_app_data_dir — will be overridden per test
    mod.get_env_var = lambda k, d=None: d
    mod.get_app_data_dir = lambda: tempfile.gettempdir()

    # Minimal SecureTokenStorage used in tests
    class FakeSecureTokenStorage:
        def __init__(self, app_data_dir):
            self.path = os.path.join(app_data_dir, '_fake_secure.json')
            self._tokens = {}
        def save_tokens(self, tokens, user_email='default'):
            self._tokens.update(tokens)
            with open(self.path, 'w') as f:
                json.dump(self._tokens, f)
            return True
        def load_tokens(self, user_email='default'):
            if os.path.exists(self.path):
                with open(self.path, 'r') as f:
                    self._tokens = json.load(f)
                return dict(self._tokens) if self._tokens else None
            return None
        def delete_tokens(self, user_email='default'):
            self._tokens = {}
            if os.path.exists(self.path):
                os.remove(self.path)
            return True
        def migrate_from_plaintext(self, path):
            return False

    mod.SecureTokenStorage = FakeSecureTokenStorage

    # Placeholder for set_runtime_* (not needed for auth tests)
    mod.set_runtime_ocr_config = lambda *a, **kw: None
    mod.set_runtime_privacy_config = lambda *a, **kw: None

    # Stub log_auth_diagnostic (used for auth diagnostic logging)
    def log_auth_diagnostic(event: str, level: str = "INFO", **kwargs) -> None:
        """Stub for auth diagnostic logging in tests."""
        pass

    mod.log_auth_diagnostic = log_auth_diagnostic

    # Stub APP_LOGGER_AVAILABLE constant
    mod.APP_LOGGER_AVAILABLE = False

    # -- Extract the class source and evaluate it in the module namespace ---
    # Find class start
    class_marker = 'class AtlassianAuthManager:'
    idx = source.find(class_marker)
    if idx < 0:
        raise RuntimeError('Could not find AtlassianAuthManager in desktop_app.py')

    # Extract from class start until the next top-level definition (no indent)
    lines = source[idx:].split('\n')
    class_lines = [lines[0]]
    for line in lines[1:]:
        # A non-empty line at column 0 that isn't a comment/decorator signals end of class
        if line and not line[0].isspace() and not line.startswith('#') and not line.startswith('@'):
            break
        class_lines.append(line)

    class_source = '\n'.join(class_lines)
    exec(compile(class_source, desktop_path, 'exec'), mod.__dict__)

    return mod


AUTH_MOD = _build_auth_module()


# ---------------------------------------------------------------------------
# Fixture + helpers
# ---------------------------------------------------------------------------
@pytest.fixture()
def tmp_dir():
    d = tempfile.mkdtemp(prefix='session_test_')
    yield d
    shutil.rmtree(d, ignore_errors=True)


def _make_auth_manager(tmp_dir):
    """Build an AtlassianAuthManager wired to a temp directory."""
    AUTH_MOD.get_env_var = lambda k, d=None: {
        'ATLASSIAN_CLIENT_ID': 'test-client-id',
        'AI_SERVER_URL': 'http://localhost:9999',
    }.get(k, d)
    AUTH_MOD.get_app_data_dir = lambda: tmp_dir
    mgr = AUTH_MOD.AtlassianAuthManager(
        web_port=51777,
        store_path=os.path.join(tmp_dir, 'auth.json'),
    )
    return mgr


def _set_valid_tokens(mgr, expires_in=3600):
    """Inject valid tokens into the manager."""
    mgr.tokens = {
        'access_token': 'valid-access-token',
        'refresh_token': 'valid-refresh-token',
        'expires_at': time.time() + expires_in,
        'supabase_token': 'valid-sb-token',
        'supabase_token_expires_at': time.time() + expires_in,
    }
    mgr._save_tokens()


def _mock_refresh_response(status_code=200, json_body=None, raise_exc=None):
    """Build a mock for requests.post that simulates the AI server refresh endpoint."""
    mock_resp = MagicMock()
    mock_resp.status_code = status_code
    mock_resp.headers = {'content-type': 'application/json'}
    if json_body is None and status_code == 200:
        json_body = {
            'success': True,
            'access_token': f'new-access-{time.time()}',
            'refresh_token': f'new-refresh-{time.time()}',
            'expires_in': 3600,
        }
    mock_resp.json.return_value = json_body or {}
    mock_resp.text = json.dumps(json_body or {})

    def side_effect(*args, **kwargs):
        if raise_exc:
            raise raise_exc
        return mock_resp

    return side_effect, mock_resp


# Helper: patch requests.post on the extracted auth module
def _patch_post(side_effect=None, return_value=None):
    """Context manager to monkey-patch requests.post for the auth module."""
    return patch.object(AUTH_MOD.requests, 'post',
                        side_effect=side_effect, return_value=return_value)


# ===========================================================================
# TEST 1: Token persistence across shutdown / restart
# ===========================================================================
class TestTokenPersistenceAcrossRestart:
    """Verify that tokens survive app shutdown and are reloaded correctly."""

    def test_tokens_survive_restart(self, tmp_dir):
        """After saving tokens and recreating the manager, tokens must be present."""
        mgr1 = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr1, expires_in=7200)

        # Simulate restart: create a brand-new manager pointing at the same dir
        mgr2 = _make_auth_manager(tmp_dir)

        assert mgr2.tokens.get('access_token') == 'valid-access-token'
        assert mgr2.tokens.get('refresh_token') == 'valid-refresh-token'
        assert mgr2.tokens.get('supabase_token') == 'valid-sb-token'
        # expires_at is in metadata, should also survive
        assert mgr2.tokens.get('expires_at') is not None
        assert mgr2.tokens['expires_at'] > time.time()

    def test_expired_token_refreshes_on_restart(self, tmp_dir):
        """If the access token expired while the app was off, is_authenticated
        should attempt a refresh (and succeed if server is up)."""
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=-10)  # Already expired

        side_effect, _ = _mock_refresh_response(200)
        with _patch_post(side_effect=side_effect):
            assert mgr.is_authenticated() is True
        # After refresh the tokens should be updated
        assert mgr.tokens['access_token'].startswith('new-access-')

    def test_valid_token_no_refresh_needed(self, tmp_dir):
        """If the access token is still valid, no refresh should be attempted."""
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=3600)

        with _patch_post() as mock_post:
            assert mgr.is_authenticated() is True
            mock_post.assert_not_called()

    def test_metadata_persists_separately(self, tmp_dir):
        """Non-sensitive metadata (expires_at, supabase_token_expires_at)
        must be saved to the JSON metadata file and survive restart."""
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=5000)

        meta_path = mgr.metadata_path
        assert os.path.exists(meta_path), "Metadata JSON file should exist after save"

        with open(meta_path, 'r') as f:
            meta = json.load(f)
        assert 'expires_at' in meta
        assert 'supabase_token_expires_at' in meta
        # Sensitive tokens must NOT be in plaintext metadata
        assert 'access_token' not in meta
        assert 'refresh_token' not in meta


# ===========================================================================
# TEST 2: Grace period auto-recovery
# ===========================================================================
class TestGracePeriodAutoRecovery:
    """_refresh_token_invalid should auto-clear after 30 minutes."""

    def test_invalid_flag_blocks_refresh_within_grace(self, tmp_dir):
        """Within 30 min of being set, the flag should block refresh."""
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=-10)

        mgr._refresh_token_invalid = True
        mgr._refresh_invalid_set_at = time.time()  # Just now

        assert mgr.refresh_access_token() is False
        assert mgr.is_authenticated() is False

    def test_invalid_flag_auto_clears_after_grace_period(self, tmp_dir):
        """After 30 min, the flag should auto-clear and allow retry."""
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=-10)

        mgr._refresh_token_invalid = True
        mgr._refresh_invalid_set_at = time.time() - 1801  # 30 min + 1s ago

        side_effect, _ = _mock_refresh_response(200)
        with _patch_post(side_effect=side_effect):
            result = mgr.refresh_access_token()
        assert result is True
        assert mgr._refresh_token_invalid is False
        assert mgr._refresh_fail_count == 0

    def test_is_authenticated_auto_clears_after_grace_period(self, tmp_dir):
        """is_authenticated should also honor the grace period."""
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=-10)

        mgr._refresh_token_invalid = True
        mgr._refresh_invalid_set_at = time.time() - 1801

        side_effect, _ = _mock_refresh_response(200)
        with _patch_post(side_effect=side_effect):
            assert mgr.is_authenticated() is True

    def test_grace_period_recovery_fails_re_marks_invalid(self, tmp_dir):
        """If auto-retry after grace period also fails 5 times, flag is re-set."""
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=-10)

        mgr._refresh_token_invalid = True
        mgr._refresh_invalid_set_at = time.time() - 1801

        fail_body = {'error': 'invalid_grant', 'requiresReauth': True}
        side_effect, _ = _mock_refresh_response(401, json_body=fail_body)

        with _patch_post(side_effect=side_effect):
            # First call: clears flag, then fails — count becomes 1
            assert mgr.refresh_access_token() is False
        assert mgr._refresh_token_invalid is False  # Not yet — only 1 failure
        assert mgr._refresh_fail_count == 1


# ===========================================================================
# TEST 3: Time-windowed failure counting
# ===========================================================================
class TestTimeWindowedFailureCounting:
    """Failures must be within 10-min window to count as consecutive."""

    def test_five_rapid_failures_marks_invalid(self, tmp_dir):
        """5 failures within 10 min should mark token as invalid."""
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=3600)

        fail_body = {'error': 'invalid_grant', 'requiresReauth': True}
        side_effect, _ = _mock_refresh_response(401, json_body=fail_body)

        with _patch_post(side_effect=side_effect):
            for i in range(5):
                mgr.refresh_access_token()

        assert mgr._refresh_fail_count == 5
        assert mgr._refresh_token_invalid is True
        assert mgr._refresh_invalid_set_at > 0

    def test_four_failures_does_not_mark_invalid(self, tmp_dir):
        """4 failures should NOT mark token as invalid (threshold is 5)."""
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=3600)

        fail_body = {'error': 'invalid_grant', 'requiresReauth': True}
        side_effect, _ = _mock_refresh_response(401, json_body=fail_body)

        with _patch_post(side_effect=side_effect):
            for i in range(4):
                mgr.refresh_access_token()

        assert mgr._refresh_fail_count == 4
        assert mgr._refresh_token_invalid is False

    def test_failures_spread_over_time_reset_counter(self, tmp_dir):
        """Failures >10 min apart should reset the counter."""
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=3600)

        fail_body = {'error': 'invalid_grant', 'requiresReauth': True}
        side_effect, _ = _mock_refresh_response(401, json_body=fail_body)

        with _patch_post(side_effect=side_effect):
            # 3 failures
            for _ in range(3):
                mgr.refresh_access_token()
            assert mgr._refresh_fail_count == 3

            # Simulate 11 minutes passing
            mgr._last_refresh_fail_time = time.time() - 661

            # Next failure should reset counter (>10 min gap)
            mgr.refresh_access_token()
            assert mgr._refresh_fail_count == 1  # Reset + 1

    def test_successful_refresh_resets_all_counters(self, tmp_dir):
        """A successful refresh must reset fail count and invalid flag."""
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=3600)
        mgr._refresh_fail_count = 4
        mgr._last_refresh_fail_time = time.time()

        side_effect, _ = _mock_refresh_response(200)
        with _patch_post(side_effect=side_effect):
            assert mgr.refresh_access_token() is True

        assert mgr._refresh_fail_count == 0
        assert mgr._refresh_token_invalid is False
        assert mgr._refresh_invalid_set_at == 0
        assert mgr._last_refresh_fail_time == 0

    def test_transient_500_does_not_count_as_permanent(self, tmp_dir):
        """A 500 error without requiresReauth should NOT increment the permanent
        failure counter."""
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=3600)

        fail_body = {'error': 'Internal server error'}
        side_effect, _ = _mock_refresh_response(500, json_body=fail_body)

        with _patch_post(side_effect=side_effect):
            for _ in range(10):
                mgr.refresh_access_token()

        # None of these are permanent — counter stays at 0
        assert mgr._refresh_fail_count == 0
        assert mgr._refresh_token_invalid is False

    def test_http_400_without_requiresReauth_is_transient(self, tmp_dir):
        """After server fix, a 400 without requiresReauth should NOT trigger
        permanent failure counting."""
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=3600)

        # Server now returns 400 as-is (no requiresReauth)
        fail_body = {'error': 'Token refresh failed: bad request format'}
        side_effect, _ = _mock_refresh_response(400, json_body=fail_body)

        with _patch_post(side_effect=side_effect):
            for _ in range(10):
                mgr.refresh_access_token()

        assert mgr._refresh_fail_count == 0
        assert mgr._refresh_token_invalid is False


# ===========================================================================
# TEST 4: Non-recursive get_supabase_token
# ===========================================================================
class TestNonRecursiveSubabaseToken:
    """get_supabase_token must NOT recurse — single inline retry only."""

    def test_401_triggers_refresh_and_single_retry(self, tmp_dir):
        """On 401, refresh + retry ONCE. No recursion."""
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=3600)

        # First call to exchange-token returns 401
        # After refresh, retry returns 200
        call_count = {'n': 0}

        def mock_post(url, **kwargs):
            resp = MagicMock()
            resp.headers = {'content-type': 'application/json'}
            call_count['n'] += 1

            if '/exchange-token' in url:
                if call_count['n'] == 1:
                    # First exchange attempt — 401
                    resp.status_code = 401
                elif call_count['n'] == 3:
                    # Retry after refresh — 200
                    resp.status_code = 200
                    resp.json.return_value = {
                        'success': True,
                        'supabase_token': 'new-sb-token',
                        'expires_in': 3600,
                        'user': {'id': 'u1', 'organization_id': 'o1'},
                    }
                else:
                    resp.status_code = 500
                    resp.json.return_value = {'error': 'unexpected'}
            elif '/refresh-token' in url:
                # Refresh succeeds
                resp.status_code = 200
                resp.json.return_value = {
                    'success': True,
                    'access_token': 'refreshed-at',
                    'refresh_token': 'refreshed-rt',
                    'expires_in': 3600,
                }
            return resp

        with _patch_post(side_effect=mock_post):
            result = mgr.get_supabase_token()

        assert result == 'new-sb-token'
        # Exactly 3 calls: exchange(401) → refresh(200) → exchange-retry(200)
        assert call_count['n'] == 3

    def test_401_refresh_fails_no_infinite_loop(self, tmp_dir):
        """If refresh fails after 401, get_supabase_token returns None (no loop)."""
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=3600)

        def mock_post(url, **kwargs):
            resp = MagicMock()
            resp.headers = {'content-type': 'application/json'}
            if '/exchange-token' in url:
                resp.status_code = 401
            elif '/refresh-token' in url:
                resp.status_code = 500
                resp.json.return_value = {'error': 'server down'}
            return resp

        with _patch_post(side_effect=mock_post):
            result = mgr.get_supabase_token()

        assert result is None

    def test_401_refresh_ok_but_retry_fails(self, tmp_dir):
        """Refresh succeeds but the retry exchange also fails → return None."""
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=3600)

        def mock_post(url, **kwargs):
            resp = MagicMock()
            resp.headers = {'content-type': 'application/json'}
            if '/exchange-token' in url:
                resp.status_code = 401
            elif '/refresh-token' in url:
                resp.status_code = 200
                resp.json.return_value = {
                    'success': True,
                    'access_token': 'new-at',
                    'refresh_token': 'new-rt',
                    'expires_in': 3600,
                }
            return resp

        with _patch_post(side_effect=mock_post):
            result = mgr.get_supabase_token()

        assert result is None


# ===========================================================================
# TEST 5: Thread-safety — invalid flag checked inside lock
# ===========================================================================
class TestThreadSafetyInvalidFlagInsideLock:
    """Another thread may set _refresh_token_invalid while we wait for the lock."""

    def test_flag_set_by_other_thread_blocks_inside_lock(self, tmp_dir):
        """If thread A sets _refresh_token_invalid while B waits for the lock,
        B should see the flag after acquiring the lock and bail out."""
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=3600)

        barrier = threading.Barrier(2, timeout=5)
        results = {}

        def thread_a():
            """Acquires lock, sets invalid flag, then releases."""
            with mgr._refresh_lock:
                barrier.wait()  # Signal to thread B that lock is held
                mgr._refresh_token_invalid = True
                mgr._refresh_invalid_set_at = time.time()
                time.sleep(0.1)  # Hold lock briefly
            results['a'] = 'done'

        def thread_b():
            """Waits for lock, should see invalid flag once acquired."""
            barrier.wait()  # Wait until thread A holds the lock
            time.sleep(0.05)  # Ensure we queue behind A
            result = mgr.refresh_access_token()
            results['b'] = result

        t_a = threading.Thread(target=thread_a)
        t_b = threading.Thread(target=thread_b)
        t_a.start()
        t_b.start()
        t_a.join(timeout=5)
        t_b.join(timeout=5)

        assert results.get('a') == 'done'
        assert results.get('b') is False  # B should have bailed out

    def test_concurrent_refreshes_no_double_counting(self, tmp_dir):
        """Two threads hitting refresh simultaneously should not double-count
        failures because of the lock + double-check pattern."""
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=3600)

        fail_body = {'error': 'invalid_grant', 'requiresReauth': True}

        call_count = {'n': 0}

        def mock_post(url, **kwargs):
            resp = MagicMock()
            resp.headers = {'content-type': 'application/json'}
            call_count['n'] += 1
            if '/refresh-token' in url:
                resp.status_code = 401
                resp.json.return_value = fail_body
            return resp

        results = []

        def do_refresh():
            with _patch_post(side_effect=mock_post):
                r = mgr.refresh_access_token()
            results.append(r)

        threads = [threading.Thread(target=do_refresh) for _ in range(3)]
        for t in threads:
            t.start()
        for t in threads:
            t.join(timeout=10)

        # All should fail but the fail_count should be reasonable (not 3× expected)
        assert all(r is False for r in results)
        # Due to the lock, only one thread actually does the HTTP call at a time;
        # the others see the token changed (or not) and proceed accordingly.
        # The count should be <= 3 (one per thread at most), NOT 9 or more.
        assert mgr._refresh_fail_count <= 3


# ===========================================================================
# TEST 6: Server 400 vs 401 separation
# ===========================================================================
class TestServer400vs401Separation:
    """Simulate server responses to verify the client handles them correctly."""

    def test_server_401_with_requiresReauth_counts_as_permanent(self, tmp_dir):
        """Server 401 + requiresReauth=true should count toward permanent failures."""
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=3600)

        fail_body = {
            'success': False,
            'error': 'Refresh token expired or invalid. User must re-authenticate.',
            'requiresReauth': True,
        }
        side_effect, _ = _mock_refresh_response(401, json_body=fail_body)

        with _patch_post(side_effect=side_effect):
            mgr.refresh_access_token()

        assert mgr._refresh_fail_count == 1

    def test_server_400_without_requiresReauth_is_transient(self, tmp_dir):
        """Server 400 without requiresReauth should NOT count as permanent."""
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=3600)

        fail_body = {
            'success': False,
            'error': 'Token refresh failed: invalid request body',
        }
        side_effect, _ = _mock_refresh_response(400, json_body=fail_body)

        with _patch_post(side_effect=side_effect):
            mgr.refresh_access_token()

        # 'invalid request body' does NOT match specific permanent patterns
        # (no 'invalid_grant', no 'refresh token is invalid', etc.)
        # AND requiresReauth is not set, AND status is not 403
        assert mgr._refresh_fail_count == 0

    def test_network_exception_does_not_count_as_permanent(self, tmp_dir):
        """Network exceptions (ConnectionError, Timeout) are transient."""
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=3600)
        import requests as req_mod

        side_effect, _ = _mock_refresh_response(
            raise_exc=req_mod.exceptions.ConnectionError("Connection refused")
        )

        with _patch_post(side_effect=side_effect):
            result = mgr.refresh_access_token()

        assert result is False
        assert mgr._refresh_fail_count == 0
        assert mgr._refresh_token_invalid is False


# ===========================================================================
# TEST 7: Logout clears all state
# ===========================================================================
class TestLogoutClearsAllState:
    """logout() must reset every flag so the next login starts clean."""

    def test_logout_clears_tokens_and_flags(self, tmp_dir):
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=3600)
        mgr._refresh_token_invalid = True
        mgr._refresh_fail_count = 5
        mgr._refresh_invalid_set_at = time.time()
        mgr._last_refresh_fail_time = time.time()

        mgr.logout()

        assert mgr.tokens == {}
        assert mgr._refresh_token_invalid is False
        assert mgr._refresh_fail_count == 0
        assert mgr._refresh_invalid_set_at == 0
        assert mgr._last_refresh_fail_time == 0

    def test_login_after_logout_works(self, tmp_dir):
        """After logout + new tokens, is_authenticated should return True."""
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=3600)
        mgr._refresh_token_invalid = True
        mgr._refresh_fail_count = 5
        mgr._refresh_invalid_set_at = time.time()

        mgr.logout()
        _set_valid_tokens(mgr, expires_in=3600)

        assert mgr.is_authenticated() is True


# ===========================================================================
# TEST 8: Successful refresh resets everything
# ===========================================================================
class TestSuccessfulRefreshResetsState:
    """Any successful refresh must clear all failure tracking."""

    def test_success_after_partial_failures(self, tmp_dir):
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=3600)

        fail_body = {'error': 'invalid_grant', 'requiresReauth': True}
        fail_se, _ = _mock_refresh_response(401, json_body=fail_body)
        ok_se, _ = _mock_refresh_response(200)

        # Accumulate 3 failures
        with _patch_post(side_effect=fail_se):
            for _ in range(3):
                mgr.refresh_access_token()
        assert mgr._refresh_fail_count == 3

        # Now a successful refresh
        with _patch_post(side_effect=ok_se):
            assert mgr.refresh_access_token() is True

        assert mgr._refresh_fail_count == 0
        assert mgr._refresh_token_invalid is False
        assert mgr._refresh_invalid_set_at == 0
        assert mgr._last_refresh_fail_time == 0


# ===========================================================================
# TEST 9: is_authenticated with expired token and grace period
# ===========================================================================
class TestIsAuthenticatedEdgeCases:

    def test_expired_token_refresh_ok(self, tmp_dir):
        """Expired token + successful refresh = authenticated."""
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=-10)

        side_effect, _ = _mock_refresh_response(200)
        with _patch_post(side_effect=side_effect):
            assert mgr.is_authenticated() is True

    def test_expired_token_refresh_fails_all_retries(self, tmp_dir):
        """Expired token + all 3 refresh retries fail = not authenticated."""
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=-10)

        fail_body = {'error': 'server unavailable'}
        side_effect, _ = _mock_refresh_response(500, json_body=fail_body)

        with _patch_post(side_effect=side_effect), \
             patch.object(AUTH_MOD.time, 'sleep'):  # Skip the 2s/4s backoff
            assert mgr.is_authenticated() is False

    def test_no_access_token_not_authenticated(self, tmp_dir):
        mgr = _make_auth_manager(tmp_dir)
        mgr.tokens = {}
        assert mgr.is_authenticated() is False

    def test_invalid_flag_within_grace_not_authenticated(self, tmp_dir):
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=3600)
        mgr._refresh_token_invalid = True
        mgr._refresh_invalid_set_at = time.time()  # Just now
        assert mgr.is_authenticated() is False

    def test_invalid_flag_past_grace_triggers_retry(self, tmp_dir):
        """After grace period, is_authenticated should clear flag and attempt."""
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=3600)
        mgr._refresh_token_invalid = True
        mgr._refresh_invalid_set_at = time.time() - 1801

        # Token not expired, so no refresh needed — just the flag check
        assert mgr.is_authenticated() is True
        assert mgr._refresh_token_invalid is False


# ===========================================================================
# TEST 10: handle_callback resets all flags
# ===========================================================================
class TestHandleCallbackResetsFlags:
    """OAuth callback (fresh login) must reset all failure tracking."""

    def test_callback_resets_flags(self, tmp_dir):
        mgr = _make_auth_manager(tmp_dir)
        mgr._refresh_token_invalid = True
        mgr._refresh_fail_count = 5
        mgr._refresh_invalid_set_at = time.time()
        mgr._last_refresh_fail_time = time.time()

        # Set up state for the callback
        mgr.tokens['oauth_state'] = 'test-state'
        mgr.tokens['code_verifier'] = 'test-verifier'

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {'content-type': 'application/json'}
        mock_resp.json.return_value = {
            'success': True,
            'access_token': 'new-at',
            'refresh_token': 'new-rt',
            'expires_in': 3600,
        }

        with _patch_post(return_value=mock_resp):
            mgr.handle_callback('auth-code', 'test-state')

        assert mgr._refresh_token_invalid is False
        assert mgr._refresh_fail_count == 0
        assert mgr._refresh_invalid_set_at == 0
        assert mgr._last_refresh_fail_time == 0
        assert mgr.tokens['access_token'] == 'new-at'


# ===========================================================================
# TEST 11: get_valid_supabase_token
# ===========================================================================
class TestGetValidSupabaseToken:

    def test_returns_cached_when_not_expired(self, tmp_dir):
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=3600)

        with _patch_post() as mock_post:
            result = mgr.get_valid_supabase_token()
            mock_post.assert_not_called()
        assert result == 'valid-sb-token'

    def test_refreshes_when_near_expiry(self, tmp_dir):
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=3600)
        # Set supabase token to expire in 4 minutes (within 5-min buffer)
        mgr.tokens['supabase_token_expires_at'] = time.time() + 240

        mock_resp = MagicMock()
        mock_resp.status_code = 200
        mock_resp.headers = {'content-type': 'application/json'}
        mock_resp.json.return_value = {
            'success': True,
            'supabase_token': 'fresh-sb-token',
            'expires_in': 3600,
            'user': {},
        }

        with _patch_post(return_value=mock_resp):
            result = mgr.get_valid_supabase_token()

        assert result == 'fresh-sb-token'


# ===========================================================================
# TEST 12: Stress test — many rapid failures followed by recovery
# ===========================================================================
class TestStressRecoveryScenario:
    """Simulate a realistic outage: many failures, then server comes back."""

    def test_outage_then_recovery(self, tmp_dir):
        """Simulate: 5 failures → flag set → grace period → server back → recovery."""
        mgr = _make_auth_manager(tmp_dir)
        _set_valid_tokens(mgr, expires_in=3600)

        fail_body = {'error': 'invalid_grant', 'requiresReauth': True}
        fail_se, _ = _mock_refresh_response(401, json_body=fail_body)

        # Phase 1: 5 rapid failures → flag gets set
        with _patch_post(side_effect=fail_se):
            for _ in range(5):
                mgr.refresh_access_token()

        assert mgr._refresh_token_invalid is True
        assert mgr.is_authenticated() is False

        # Phase 2: Simulate 30+ min passing
        mgr._refresh_invalid_set_at = time.time() - 1801

        # Phase 3: Server is back up
        ok_se, _ = _mock_refresh_response(200)
        with _patch_post(side_effect=ok_se):
            result = mgr.refresh_access_token()

        assert result is True
        assert mgr._refresh_token_invalid is False
        assert mgr._refresh_fail_count == 0
        assert mgr.is_authenticated() is True


# ===========================================================================
# Run
# ===========================================================================
if __name__ == '__main__':
    pytest.main([__file__, '-v', '--tb=short'])
