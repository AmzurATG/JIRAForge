"""
Background poller that fetches pending description-quality nudges from the AI
server and schedules a popup on the main tkinter thread when results arrive.

- 5 minute interval when the user is foreground/active.
- 15 minute interval after `idle_threshold_seconds` of inactivity (defaults
  to 5 minutes).
- Honours the user's `popup_enabled` preference (cached on DqNudgePreferences).
"""

import logging
import threading
import time
from typing import Callable, List, Optional

import requests

from .auth_headers import get_dq_headers
from .url_resolver import resolve_ai_server_url

logger = logging.getLogger(__name__)

NUDGES_ENDPOINT = '/api/desktop/description-quality-nudges'
TRIGGER_ENDPOINT = '/api/desktop/description-quality-nudges/trigger'
SYNC_RECENT_UNASSIGNED_ENDPOINT = '/api/desktop/description-quality-nudges/sync-recent-unassigned'

FOREGROUND_POLL_INTERVAL = 30 * 60    # 30 minutes
IDLE_POLL_INTERVAL = 60 * 60          # 60 minutes
DEFAULT_IDLE_THRESHOLD = 5 * 60       # 5 minutes


class DqNudgePoller:
    """
    A daemon thread that polls the AI server and dispatches popup creation
    via the injected `on_nudges` callback (called on the poller thread —
    the callback is responsible for marshalling to the UI thread).
    """

    def __init__(
        self,
        auth_manager,
        on_nudges: Callable[[List[dict]], None],
        preferences=None,
        ai_server_url: Optional[str] = None,
        idle_seconds_provider: Optional[Callable[[], int]] = None,
        idle_threshold: int = DEFAULT_IDLE_THRESHOLD,
        clock: Callable[[], float] = time.time,
    ):
        self.auth_manager = auth_manager
        self.on_nudges = on_nudges
        self.preferences = preferences
        self.ai_server_url = resolve_ai_server_url(auth_manager=auth_manager, ai_server_url=ai_server_url)
        self._idle_seconds_provider = idle_seconds_provider or (lambda: 0)
        self._idle_threshold = idle_threshold
        self._clock = clock

        self._stop_event = threading.Event()
        self._thread: Optional[threading.Thread] = None

    # ------------------------------------------------------------------
    # Thread lifecycle
    # ------------------------------------------------------------------
    def start(self) -> None:
        if self._thread and self._thread.is_alive():
            return
        self._stop_event.clear()
        self._thread = threading.Thread(target=self._run, name='DqNudgePoller', daemon=True)
        self._thread.start()
        logger.info('[DqNudge.poller] Started')

    def stop(self) -> None:
        self._stop_event.set()
        logger.info('[DqNudge.poller] Stop requested')

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------
    def _current_interval(self) -> int:
        try:
            idle = int(self._idle_seconds_provider() or 0)
        except Exception:  # noqa: BLE001 - defensive
            idle = 0
        return IDLE_POLL_INTERVAL if idle >= self._idle_threshold else FOREGROUND_POLL_INTERVAL

    def _popup_enabled(self) -> bool:
        if not self.preferences:
            return True
        return bool(self.preferences.popup_enabled)

    def poll_once(self, timeout: float = 45.0) -> List[dict]:
        """
        Fetch pending nudges. Returns the list (possibly empty); logs and
        returns [] on transport errors. Safe to call from tests.
        """
        if not self._popup_enabled():
            return []

        headers = get_dq_headers(self.auth_manager, include_json=False)
        if not headers:
            logger.debug('[DqNudge.poller] No Supabase token; skipping poll')
            return []

        try:
            resp = requests.get(
                self.ai_server_url + NUDGES_ENDPOINT,
                headers={**headers, 'Accept': 'application/json'},
                timeout=timeout,
            )
        except requests.RequestException as exc:
            logger.warning('[DqNudge.poller] HTTP exception: %s', exc)
            return []

        if not (200 <= resp.status_code < 300):
            logger.warning('[DqNudge.poller] HTTP %s on poll', resp.status_code)
            return []

        try:
            data = resp.json() or {}
        except ValueError:
            logger.warning('[DqNudge.poller] Non-JSON response')
            return []

        return list(data.get('nudges') or [])

    def sync_recent_unassigned_once(
        self,
        timeout: float = 15.0,
        limit: int = 5,
        window_minutes: int = 30,
        force: bool = False,
    ) -> dict:
        """One-time startup sync: scan recent unassigned work and create DQ nudge rows."""
        headers = get_dq_headers(self.auth_manager)
        if not headers:
            logger.debug('[DqNudge.poller] No Supabase token; skipping recent-unassigned sync')
            return {'success': False, 'generated': 0, 'nudges': [], 'reason': 'missing-token'}

        try:
            resp = requests.post(
                self.ai_server_url + SYNC_RECENT_UNASSIGNED_ENDPOINT,
                headers={**headers, 'Accept': 'application/json'},
                json={
                    'windowMinutes': int(window_minutes),
                    'limit': int(limit),
                    'force': bool(force),
                },
                timeout=timeout,
            )
        except requests.RequestException as exc:
            logger.warning('[DqNudge.poller] Recent-unassigned sync HTTP exception: %s', exc)
            return {'success': False, 'generated': 0, 'nudges': [], 'reason': 'request-exception'}

        if not (200 <= resp.status_code < 300):
            logger.warning('[DqNudge.poller] Recent-unassigned sync HTTP %s', resp.status_code)
            return {
                'success': False,
                'generated': 0,
                'nudges': [],
                'reason': f'http-{resp.status_code}',
            }

        try:
            data = resp.json() or {}
            return {
                'success': bool(data.get('success')),
                'generated': int(data.get('generated') or 0),
                'candidates': int(data.get('candidates') or 0),
                'reason': data.get('reason') or None,
                'skippedCooldown': int(data.get('skippedCooldown') or 0),
                'nudges': list(data.get('nudges') or []),
            }
        except ValueError:
            logger.warning('[DqNudge.poller] Recent-unassigned sync non-JSON response')
            return {'success': False, 'generated': 0, 'nudges': [], 'reason': 'non-json'}

    def trigger_generation(self, timeout: float = 15.0, limit: int = 5, force: bool = True) -> dict:
        """Request server-side generation of desktop nudge rows for manual testing."""
        headers = get_dq_headers(self.auth_manager)
        if not headers:
            logger.debug('[DqNudge.poller] No Supabase token; skipping trigger')
            return {'success': False, 'generated': 0, 'reason': 'missing-token'}

        try:
            resp = requests.post(
                self.ai_server_url + TRIGGER_ENDPOINT,
                headers={**headers, 'Accept': 'application/json'},
                json={'limit': int(limit), 'force': bool(force)},
                timeout=timeout,
            )
        except requests.RequestException as exc:
            logger.warning('[DqNudge.poller] Trigger HTTP exception: %s', exc)
            return {'success': False, 'generated': 0, 'reason': 'request-exception'}

        if not (200 <= resp.status_code < 300):
            logger.warning('[DqNudge.poller] Trigger HTTP %s', resp.status_code)
            return {'success': False, 'generated': 0, 'reason': f'http-{resp.status_code}'}

        try:
            data = resp.json() or {}
            return {
                'success': bool(data.get('success')),
                'generated': int(data.get('generated') or 0),
                'candidates': int(data.get('candidates') or 0),
                'reason': data.get('reason') or None,
                'skippedCooldown': int(data.get('skippedCooldown') or 0)
            }
        except ValueError:
            logger.warning('[DqNudge.poller] Trigger non-JSON response')
            return {'success': False, 'generated': 0, 'reason': 'non-json'}

    def _run(self) -> None:
        # Stagger first poll since startup sync already handled the immediate run.
        interval = self._current_interval()
        if self._stop_event.wait(timeout=interval):
            return

        while not self._stop_event.is_set():
            try:
                # Trigger generation for in-progress tickets before polling
                trigger_resp = self.trigger_generation(timeout=30.0, force=True)
                if trigger_resp and trigger_resp.get('success'):
                    logger.debug('[DqNudge.poller] Triggered generation successfully')

                nudges = self.poll_once()
                if nudges:
                    try:
                        self.on_nudges(nudges)
                    except Exception as exc:  # noqa: BLE001 — callback is host code
                        logger.error('[DqNudge.poller] on_nudges raised: %s', exc, exc_info=True)
            except Exception as exc:  # noqa: BLE001 — never let the thread die
                logger.error('[DqNudge.poller] Poll cycle failed: %s', exc, exc_info=True)

            interval = self._current_interval()
            if self._stop_event.wait(timeout=interval):
                break

        logger.info('[DqNudge.poller] Stopped')
