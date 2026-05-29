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


class TestJiraGuardsNoOpForGoogle:
    def test_get_jira_cloud_id_returns_none(self, tracker):
        assert tracker.get_jira_cloud_id() is None

    def test_fetch_jira_issues_returns_empty(self, tracker):
        assert tracker.fetch_jira_issues() == []

    def test_fetch_jira_projects_returns_empty(self, tracker):
        assert tracker.fetch_jira_projects() == []

    def test_update_current_project_returns_false(self, tracker):
        assert tracker.update_current_project() is False
