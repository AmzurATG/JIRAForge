"""
Local + remote preference mirror for the description-quality nudge feature.

The server (`description_quality_nudge_preferences` table) is the source of
truth. This module reads/writes the popup_enabled flag — bell_enabled is set
from the Forge settings UI and not relevant to the desktop popup itself.
"""

import logging
import os
from typing import Optional

import requests

logger = logging.getLogger(__name__)

DEFAULT_AI_SERVER_URL = os.environ.get('AI_SERVER_URL', 'https://forgesync.amzur.com')
PREFS_ENDPOINT = '/api/desktop/preferences/dq-nudges'


class DqNudgePreferences:
    """
    Caches the latest prefs in-memory; refresh() pulls from the server.
    """

    def __init__(self, auth_manager, ai_server_url: Optional[str] = None):
        self.auth_manager = auth_manager
        self.ai_server_url = ai_server_url or DEFAULT_AI_SERVER_URL
        # Defaults: both channels opt-in.
        self.bell_enabled = True
        self.popup_enabled = True

    def _headers(self) -> Optional[dict]:
        token = self.auth_manager.get_supabase_token()
        if not token:
            return None
        return {'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'}

    def refresh(self, timeout: float = 10.0) -> bool:
        headers = self._headers()
        if not headers:
            return False
        try:
            resp = requests.get(self.ai_server_url + PREFS_ENDPOINT, headers=headers, timeout=timeout)
            if not (200 <= resp.status_code < 300):
                logger.warning('[DqNudge.prefs] HTTP %s on GET', resp.status_code)
                return False
            data = resp.json() or {}
            prefs = data.get('preferences') or {}
            self.bell_enabled = bool(prefs.get('bellEnabled', True))
            self.popup_enabled = bool(prefs.get('popupEnabled', True))
            return True
        except requests.RequestException as exc:
            logger.warning('[DqNudge.prefs] refresh failed: %s', exc)
            return False

    def set_popup_enabled(self, enabled: bool, timeout: float = 10.0) -> bool:
        headers = self._headers()
        if not headers:
            return False
        try:
            resp = requests.put(
                self.ai_server_url + PREFS_ENDPOINT,
                json={'popupEnabled': bool(enabled)},
                headers=headers,
                timeout=timeout,
            )
            if 200 <= resp.status_code < 300:
                self.popup_enabled = bool(enabled)
                return True
            logger.warning('[DqNudge.prefs] HTTP %s on PUT', resp.status_code)
            return False
        except requests.RequestException as exc:
            logger.warning('[DqNudge.prefs] PUT failed: %s', exc)
            return False
