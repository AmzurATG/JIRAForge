"""
Thin HTTP wrapper to acknowledge description-quality nudges on the AI server.

The auth manager (passed in) supplies the Supabase JWT via get_supabase_token().
Atlassian token fallback is handled by the server-side desktop-auth middleware.
"""

import logging
from typing import Iterable, List, Optional

import requests

from .auth_headers import get_dq_headers
from .url_resolver import resolve_ai_server_url

logger = logging.getLogger(__name__)

ACK_ENDPOINT = '/api/desktop/description-quality-nudges/ack'

VALID_ACTIONS = {'viewed', 'opened-in-jira', 'dismissed', 'snoozed'}


def acknowledge_nudges(
    auth_manager,
    nudge_ids: Iterable[int],
    action: str,
    snooze_until: Optional[str] = None,
    ai_server_url: Optional[str] = None,
    timeout: float = 10.0,
) -> bool:
    """
    POST /api/desktop/description-quality-nudges/ack.

    Returns True on 2xx, False otherwise. Never raises.
    """
    ids: List[int] = [int(n) for n in nudge_ids]
    if not ids:
        return False
    if action not in VALID_ACTIONS:
        logger.warning('[DqNudge.ack] Invalid action: %s', action)
        return False
    if action == 'snoozed' and not snooze_until:
        logger.warning('[DqNudge.ack] snoozed action requires snooze_until')
        return False

    headers = get_dq_headers(auth_manager)
    if not headers:
        logger.warning('[DqNudge.ack] No Supabase token; skipping ack')
        return False

    url = resolve_ai_server_url(auth_manager=auth_manager, ai_server_url=ai_server_url) + ACK_ENDPOINT
    body = {'nudgeIds': ids, 'action': action}
    if snooze_until:
        body['snoozeUntil'] = snooze_until

    try:
        response = requests.post(
            url,
            json=body,
            headers=headers,
            timeout=timeout,
        )
        if 200 <= response.status_code < 300:
            return True
        logger.warning('[DqNudge.ack] HTTP %s on ack: %s', response.status_code, response.text[:200])
        return False
    except requests.RequestException as exc:
        logger.warning('[DqNudge.ack] Request failed: %s', exc)
        return False
