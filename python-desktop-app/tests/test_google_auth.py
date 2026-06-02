"""
Tests for the non-Jira Google SSO desktop flow.

Covers:
  - handle_google_callback: success stores provider + tokens, bad-state rejection,
    server-error propagation.
  - Google Supabase-JWT refresh path (_refresh_google_supabase_token, and that
    get_supabase_token() routes to it when auth_provider == 'google').
  - Jira-only TimeTracker methods no-op for Google users.

Run: cd python-desktop-app && python -m pytest tests/test_google_auth.py -v
"""

import os
import sys
from unittest.mock import MagicMock, patch

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import desktop_app
from desktop_app import TimeTracker, AtlassianAuthManager


def _resp(status=200, payload=None):
    r = MagicMock()
    r.status_code = status
    r.headers = {'content-type': 'application/json'}
    r.json.return_value = payload or {}
    return r


@pytest.fixture
def auth_mgr():
    """AtlassianAuthManager with heavy __init__ skipped; only the bits the
    Google methods touch are set."""
    with patch.object(AtlassianAuthManager, '__init__', return_value=None):
        am = AtlassianAuthManager()
        am.ai_server_url = 'http://localhost:3001'
        am.google_client_id = 'gcid'
        am.google_authorization_url = 'https://accounts.google.com/o/oauth2/v2/auth'
        am.google_redirect_uri = 'http://127.0.0.1:51777/auth/google/callback'
        am.tokens = {}
        am.auth_provider = 'atlassian'
        am._save_tokens = MagicMock()
        return am


@pytest.fixture
def tracker():
    """TimeTracker with heavy __init__ skipped; a Google auth_manager attached."""
    with patch.object(TimeTracker, '__init__', return_value=None):
        t = TimeTracker()
        t.auth_manager = MagicMock()
        t.auth_manager.auth_provider = 'google'
        return t


class TestGoogleCallback:
    def test_success_stores_provider_and_tokens(self, auth_mgr):
        auth_mgr.tokens['google_oauth_state'] = 'state123'
        auth_mgr.tokens['google_code_verifier'] = 'verifier123'
        payload = {
            'success': True, 'supabase_token': 'sb-tok', 'expires_in': 3600,
            'google_refresh_token': 'g-refresh',
            'supabase_url': 'https://x.supabase.co', 'supabase_anon_key': 'anon',
            'user': {'id': 'u1', 'organization_id': 'o1', 'email': 'a@amzur.com', 'display_name': 'A'},
        }
        with patch('desktop_app.requests.post', return_value=_resp(200, payload)) as post:
            result = auth_mgr.handle_google_callback('code123', 'state123')

        assert auth_mgr.auth_provider == 'google'
        assert auth_mgr.tokens['auth_provider'] == 'google'
        assert auth_mgr.tokens['supabase_token'] == 'sb-tok'
        assert auth_mgr.tokens['google_refresh_token'] == 'g-refresh'
        assert auth_mgr.tokens['exchange_user_id'] == 'u1'
        assert auth_mgr.tokens['exchange_organization_id'] == 'o1'
        assert 'google_code_verifier' not in auth_mgr.tokens  # single-use, dropped
        # forwarded the PKCE verifier to the desktop-google endpoint
        assert post.call_args.kwargs['json']['code_verifier'] == 'verifier123'
        assert result['user']['id'] == 'u1'

    def test_rejects_bad_state(self, auth_mgr):
        auth_mgr.tokens['google_oauth_state'] = 'state123'
        auth_mgr.tokens['google_code_verifier'] = 'v'
        with pytest.raises(ValueError):
            auth_mgr.handle_google_callback('code', 'WRONG')

    def test_raises_on_server_error(self, auth_mgr):
        auth_mgr.tokens['google_oauth_state'] = 's'
        auth_mgr.tokens['google_code_verifier'] = 'v'
        with patch('desktop_app.requests.post', return_value=_resp(403, {'error': 'domain not allowed'})):
            with pytest.raises(Exception):
                auth_mgr.handle_google_callback('code', 's')


class TestGoogleRefresh:
    def test_refresh_updates_supabase_token(self, auth_mgr):
        auth_mgr.tokens['google_refresh_token'] = 'g-refresh'
        with patch('desktop_app.requests.post', return_value=_resp(200, {'success': True, 'supabase_token': 'sb2', 'expires_in': 3600})):
            tok = auth_mgr._refresh_google_supabase_token()
        assert tok == 'sb2'
        assert auth_mgr.tokens['supabase_token'] == 'sb2'

    def test_refresh_returns_none_without_refresh_token(self, auth_mgr):
        assert auth_mgr._refresh_google_supabase_token() is None

    def test_get_supabase_token_routes_to_google_branch(self, auth_mgr):
        auth_mgr.auth_provider = 'google'
        auth_mgr.tokens['google_refresh_token'] = 'g-refresh'
        with patch('desktop_app.requests.post', return_value=_resp(200, {'success': True, 'supabase_token': 'sb3', 'expires_in': 3600})):
            assert auth_mgr.get_supabase_token() == 'sb3'


class TestSecureStorageKeySync:
    def test_secure_storage_persists_google_refresh_token(self):
        """Regression guard for the keyring/encrypted load path: every key
        desktop_app marks sensitive must be in secure_storage's list too, or it
        is saved but never loaded back on restart (Google sessions would lose the
        refresh token and stop uploading after the cached JWT expires)."""
        from auth import secure_storage as ss
        assert 'google_refresh_token' in ss.SENSITIVE_TOKEN_KEYS
        assert set(desktop_app.SENSITIVE_TOKEN_KEYS) <= set(ss.SENSITIVE_TOKEN_KEYS)


class TestAuthHeadersByProvider:
    """_get_auth_headers must send the right credential per login type so the AI
    server's desktop-auth middleware accepts the caller (e.g. /api/classify-app).
    Google users have no Atlassian token, so they must send their Supabase JWT."""

    def test_google_user_sends_supabase_jwt(self, tracker):
        tracker.auth_manager.auth_provider = 'google'
        tracker.auth_manager.get_valid_supabase_token.return_value = 'sb-jwt-123'
        headers = tracker._get_auth_headers()
        assert headers['Authorization'] == 'Bearer sb-jwt-123'
        tracker.auth_manager.get_valid_supabase_token.assert_called_once()

    def test_atlassian_user_sends_access_token(self, tracker):
        tracker.auth_manager.auth_provider = 'atlassian'
        tracker.auth_manager.tokens = {'access_token': 'atl-token-456'}
        headers = tracker._get_auth_headers()
        assert headers['Authorization'] == 'Bearer atl-token-456'
        tracker.auth_manager.get_valid_supabase_token.assert_not_called()


class TestGoogleSessionPersistsAcrossRestart:
    """A Google session must survive a restart/reboot without re-login.

    Root cause being guarded: the local user cache was only written on the
    Atlassian path, and startup restore called Atlassian /me (which returns None
    for Google users) then logged out. These tests pin the fix:
      - login caches the Google user (auth_provider='google'),
      - the cache round-trips auth_provider,
      - startup restores the Google session from cache instead of re-prompting.
    """

    def test_save_cached_user_info_persists_google_provider(self, tracker, tmp_path):
        tracker.organization_id = 'org-1'
        tracker._get_user_cache_path = MagicMock(return_value=str(tmp_path / 'user_cache.json'))
        google_user = {
            'account_id': 'u-1', 'email': 'a@amzur.com',
            'name': 'A', 'auth_provider': 'google',
        }

        tracker._save_cached_user_info(google_user, 'u-1')
        restored = tracker._load_cached_user_info()

        assert restored['auth_provider'] == 'google'
        assert restored['user_id'] == 'u-1'
        assert restored['organization_id'] == 'org-1'
        assert restored['email'] == 'a@amzur.com'

    def test_cache_defaults_to_atlassian_when_provider_absent(self, tracker, tmp_path):
        """Atlassian /me dicts have no auth_provider key — must default, not crash."""
        tracker.organization_id = 'org-2'
        tracker._get_user_cache_path = MagicMock(return_value=str(tmp_path / 'user_cache.json'))
        atlassian_user = {'account_id': 'acc-9', 'email': 'j@corp.com', 'name': 'J'}

        tracker._save_cached_user_info(atlassian_user, 'u-9')
        restored = tracker._load_cached_user_info()

        assert restored['auth_provider'] == 'atlassian'


class TestJiraGuardsNoOpForGoogle:
    def test_get_jira_cloud_id_returns_none(self, tracker):
        assert tracker.get_jira_cloud_id() is None

    def test_fetch_jira_issues_returns_empty(self, tracker):
        assert tracker.fetch_jira_issues() == []

    def test_fetch_jira_projects_returns_empty(self, tracker):
        assert tracker.fetch_jira_projects() == []

    def test_update_current_project_returns_false(self, tracker):
        assert tracker.update_current_project() is False
