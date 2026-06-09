"""Authentication helpers for desktop DQ nudge HTTP calls."""

import time
from typing import Optional


def _access_token_expiring(tokens: dict) -> bool:
    now = time.time()
    for key in ('access_token_expires_at', 'token_expires_at', 'expires_at'):
        try:
            expires_at = float(tokens.get(key) or 0)
        except Exception:
            expires_at = 0
        if expires_at > 0:
            return now >= (expires_at - 300)
    return False


def get_dq_bearer_token(auth_manager) -> Optional[str]:
    """
    Prefer the live Atlassian access token for Jira users so the AI server can
    make real-time Jira calls. Fall back to the cached/refreshable Supabase JWT
    for Google users or when no Atlassian token is available.
    """
    auth_provider = getattr(auth_manager, 'auth_provider', None)
    tokens = getattr(auth_manager, 'tokens', {}) or {}

    if auth_provider != 'google':
        access_token = tokens.get('access_token')
        should_refresh = not access_token or _access_token_expiring(tokens)
        if should_refresh:
            refresh = getattr(auth_manager, 'refresh_access_token', None)
            if callable(refresh):
                try:
                    if refresh():
                        tokens = getattr(auth_manager, 'tokens', {}) or {}
                        access_token = tokens.get('access_token')
                except Exception:
                    access_token = None
        if access_token:
            return access_token

    get_valid_supabase = getattr(auth_manager, 'get_valid_supabase_token', None)
    if callable(get_valid_supabase):
        return get_valid_supabase()

    get_supabase = getattr(auth_manager, 'get_supabase_token', None)
    if callable(get_supabase):
        return get_supabase()

    return None


def get_dq_headers(auth_manager, include_json: bool = True) -> Optional[dict]:
    token = get_dq_bearer_token(auth_manager)
    if not token:
        return None
    headers = {'Authorization': f'Bearer {token}'}
    if include_json:
        headers['Content-Type'] = 'application/json'
    return headers
