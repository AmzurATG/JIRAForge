"""AI server URL resolution helpers for DQ nudge modules."""

import os
from typing import Optional

PRODUCTION_AI_SERVER_URL = 'https://forgesync.amzur.com'


def _is_placeholder_url(value: Optional[str]) -> bool:
    if value is None:
        return False

    raw = str(value).strip().lower()
    if not raw:
        return False

    return (
        raw.startswith('http://your-ai-server-url')
        or raw.startswith('https://your-ai-server-url')
        or raw == 'your-ai-server-url'
        or 'your-ai-server-url' in raw
    )


def resolve_ai_server_url(auth_manager=None, ai_server_url: Optional[str] = None) -> str:
    """Resolve AI server URL with robust fallback order.

    Priority:
    1) Explicit ai_server_url argument
    2) auth_manager.ai_server_url (if present)
    3) AI_SERVER_URL environment variable (unless placeholder)
    4) Production default
    """
    if ai_server_url and not _is_placeholder_url(ai_server_url):
        return ai_server_url.rstrip('/')

    if auth_manager is not None:
        manager_url = getattr(auth_manager, 'ai_server_url', None)
        if manager_url and not _is_placeholder_url(manager_url):
            return str(manager_url).rstrip('/')

    env_url = os.environ.get('AI_SERVER_URL')
    if env_url and not _is_placeholder_url(env_url):
        return env_url.rstrip('/')

    return PRODUCTION_AI_SERVER_URL
