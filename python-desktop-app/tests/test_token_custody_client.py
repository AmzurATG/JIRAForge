"""
Tests for the desktop side of server-side token custody (Phase 3).

Reference: plan/2026-06-12_auth_server-side-token-custody.md

After login (or once per run for upgraded installs) the desktop hands its
rotating refresh token to the AI server via /api/auth/migrate-custody and
receives a long-lived, revocable device session token. From then on it never
performs OAuth rotation itself — it exchanges the device token for fresh
access tokens at /api/auth/access-token. Laptop sleep can no longer kill a
session, because nothing single-use ever travels over the laptop's network.
"""

import os
import sys
import threading
import time
from unittest.mock import MagicMock, patch

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


def _make_manager(tokens=None):
    manager = AtlassianAuthManager.__new__(AtlassianAuthManager)
    manager.tokens = tokens if tokens is not None else {
        'access_token': 'old-access',
        'refresh_token': 'refresh-123',
        'expires_at': 0,
    }
    manager.ai_server_url = 'https://example.test'
    manager.auth_provider = 'atlassian'
    manager._refresh_lock = threading.Lock()
    manager._refresh_token_invalid = False
    manager._refresh_invalid_permanent = False
    manager._refresh_fail_count = 0
    manager._refresh_invalid_set_at = 0
    manager._last_refresh_fail_time = 0
    manager._last_refresh_error_code = ''
    manager._last_token_refresh_time = 0
    manager._token_refresh_min_interval = 5
    manager._custody_migration_attempted = False
    manager._save_tokens = lambda: None
    manager._wait_for_network = lambda *a, **k: True
    return manager


# ---------------------------------------------------------------------------
# Device-token refresh path
# ---------------------------------------------------------------------------

def test_refresh_uses_access_token_endpoint_when_device_token_present():
    mgr = _make_manager({
        'access_token': 'stale-access',
        'device_token': 'device-abc',
        'refresh_token': 'leftover-refresh',
        'expires_at': 0,
    })
    response = _MockResponse(200, {
        'success': True,
        'access_token': 'fresh-access',
        'expires_at': '2099-01-01T00:00:00+00:00',
    })
    with patch('desktop_app.requests.post', return_value=response) as post:
        ok = mgr.refresh_access_token()

    assert ok is True
    assert mgr.tokens['access_token'] == 'fresh-access'
    called_url = post.call_args[0][0]
    assert called_url.endswith('/api/auth/access-token')
    sent = post.call_args[1].get('json') or post.call_args[0][1]
    assert sent == {'device_token': 'device-abc'}


def test_first_successful_device_refresh_drops_legacy_refresh_token():
    """The leftover refresh token is a rollback bridge only until custody is
    proven working; after the first successful device refresh the server has
    rotated, making the local copy worthless — it must be removed."""
    mgr = _make_manager({
        'access_token': 'stale-access',
        'device_token': 'device-abc',
        'refresh_token': 'leftover-refresh',
        'expires_at': 0,
    })
    response = _MockResponse(200, {
        'success': True,
        'access_token': 'fresh-access',
        'expires_at': '2099-01-01T00:00:00+00:00',
    })
    with patch('desktop_app.requests.post', return_value=response):
        mgr.refresh_access_token()
    assert 'refresh_token' not in mgr.tokens


def test_device_session_invalid_is_permanent_reauth():
    mgr = _make_manager({
        'access_token': 'stale-access',
        'device_token': 'revoked-device',
        'expires_at': 0,
    })
    response = _MockResponse(401, {
        'success': False,
        'error': 'Device session invalid, revoked, or expired. Please log in again.',
        'errorCode': 'DEVICE_SESSION_INVALID',
        'requiresReauth': True,
    })
    with patch('desktop_app.requests.post', return_value=response):
        ok = mgr.refresh_access_token()

    assert ok is False
    assert mgr._refresh_token_invalid is True
    assert mgr._refresh_invalid_permanent is True


def test_dead_server_credential_is_permanent_reauth():
    mgr = _make_manager({
        'access_token': 'stale-access',
        'device_token': 'device-abc',
        'expires_at': 0,
    })
    response = _MockResponse(401, {
        'success': False,
        'error': 'Stored credential is no longer valid. Please log in again.',
        'errorCode': 'OAUTH_REAUTH_REQUIRED',
        'requiresReauth': True,
    })
    with patch('desktop_app.requests.post', return_value=response):
        ok = mgr.refresh_access_token()

    assert ok is False
    assert mgr._refresh_token_invalid is True
    assert mgr._refresh_invalid_permanent is True


def test_temporary_server_failure_is_not_permanent():
    mgr = _make_manager({
        'access_token': 'stale-access',
        'device_token': 'device-abc',
        'expires_at': 0,
    })
    response = _MockResponse(503, {
        'success': False,
        'error': 'Network failure during rotation',
        'errorCode': 'OAUTH_TEMPORARY_FAILURE',
    })
    with patch('desktop_app.requests.post', return_value=response):
        ok = mgr.refresh_access_token()

    assert ok is False
    assert mgr._refresh_token_invalid is False
    assert mgr._refresh_fail_count == 0


# ---------------------------------------------------------------------------
# Custody migration (login + first run after upgrade)
# ---------------------------------------------------------------------------

def test_migrate_to_custody_stores_device_token_and_keeps_bridge():
    mgr = _make_manager()
    response = _MockResponse(200, {
        'success': True,
        'device_token': 'new-device-token',
        'device_token_expires_at': '2026-12-09T00:00:00+00:00',
    })
    with patch('desktop_app.requests.post', return_value=response) as post:
        ok = mgr.migrate_to_custody()

    assert ok is True
    assert mgr.tokens['device_token'] == 'new-device-token'
    # The refresh token stays as a rollback bridge until the first successful
    # device refresh (the server has not rotated yet at this point).
    assert mgr.tokens.get('refresh_token') == 'refresh-123'
    called_url = post.call_args[0][0]
    assert called_url.endswith('/api/auth/migrate-custody')
    sent = post.call_args[1].get('json') or post.call_args[0][1]
    assert sent['refresh_token'] == 'refresh-123'
    assert sent['atlassian_token'] == 'old-access'


def test_migrate_to_custody_404_keeps_legacy_flow():
    """Old server without the custody endpoints: desktop must keep the legacy
    refresh flow working untouched (safe mixed-version rollout)."""
    mgr = _make_manager()
    response = _MockResponse(404, {'error': 'Not found'})
    with patch('desktop_app.requests.post', return_value=response):
        ok = mgr.migrate_to_custody()

    assert ok is False
    assert 'device_token' not in mgr.tokens
    assert mgr.tokens.get('refresh_token') == 'refresh-123'


def test_refresh_attempts_migration_once_for_upgraded_installs():
    """An upgraded install (refresh token, no device token) must hand over
    custody on its next refresh — without a re-login — then refresh via the
    device token."""
    mgr = _make_manager()  # refresh-123 present, no device_token

    def fake_post(url, *args, **kwargs):
        if url.endswith('/api/auth/migrate-custody'):
            return _MockResponse(200, {
                'success': True,
                'device_token': 'migrated-device-token',
                'device_token_expires_at': '2026-12-09T00:00:00+00:00',
            })
        if url.endswith('/api/auth/access-token'):
            return _MockResponse(200, {
                'success': True,
                'access_token': 'fresh-access',
                'expires_at': '2099-01-01T00:00:00+00:00',
            })
        raise AssertionError(f'unexpected POST {url}')

    with patch('desktop_app.requests.post', side_effect=fake_post):
        ok = mgr.refresh_access_token()

    assert ok is True
    assert mgr.tokens['device_token'] == 'migrated-device-token'
    assert mgr.tokens['access_token'] == 'fresh-access'
    assert mgr._custody_migration_attempted is True


def test_failed_migration_falls_back_to_legacy_refresh():
    mgr = _make_manager()

    def fake_post(url, *args, **kwargs):
        if url.endswith('/api/auth/migrate-custody'):
            return _MockResponse(404, {'error': 'Not found'})
        if url.endswith('/api/auth/refresh-token'):
            return _MockResponse(200, {
                'success': True,
                'access_token': 'legacy-access',
                'refresh_token': 'rotated-refresh',
                'expires_in': 3600,
            })
        raise AssertionError(f'unexpected POST {url}')

    with patch('desktop_app.requests.post', side_effect=fake_post):
        ok = mgr.refresh_access_token()

    assert ok is True
    assert mgr.tokens['access_token'] == 'legacy-access'
    assert mgr.tokens['refresh_token'] == 'rotated-refresh'
    # Migration is attempted at most once per process run.
    assert mgr._custody_migration_attempted is True


def test_migration_not_reattempted_within_same_run():
    mgr = _make_manager()
    mgr._custody_migration_attempted = True

    def fake_post(url, *args, **kwargs):
        if url.endswith('/api/auth/migrate-custody'):
            raise AssertionError('migration must not be retried within the same run')
        if url.endswith('/api/auth/refresh-token'):
            return _MockResponse(200, {
                'success': True,
                'access_token': 'legacy-access',
                'refresh_token': 'rotated-refresh',
                'expires_in': 3600,
            })
        raise AssertionError(f'unexpected POST {url}')

    with patch('desktop_app.requests.post', side_effect=fake_post):
        ok = mgr.refresh_access_token()
    assert ok is True
