"""
Background poller that fetches pending description-quality nudges from the AI
server and schedules a popup on the main tkinter thread when results arrive.

- 5 minute interval when the user is foreground/active.
- 15 minute interval after `idle_threshold_seconds` of inactivity (defaults
  to 5 minutes).
- Honours the user's `popup_enabled` preference (cached on DqNudgePreferences).
"""

import logging
import os
import threading
import time
from typing import Callable, List, Optional

import requests

logger = logging.getLogger(__name__)

DEFAULT_AI_SERVER_URL = os.environ.get('AI_SERVER_URL', 'https://forgesync.amzur.com')
NUDGES_ENDPOINT = '/api/desktop/description-quality-nudges'

FOREGROUND_POLL_INTERVAL = 5 * 60     # 5 minutes
IDLE_POLL_INTERVAL = 15 * 60          # 15 minutes
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
        self.ai_server_url = ai_server_url or DEFAULT_AI_SERVER_URL
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

    def poll_once(self, timeout: float = 10.0) -> List[dict]:
        """
        Fetch pending nudges. Returns the list (possibly empty); logs and
        returns [] on transport errors. Safe to call from tests.
        """
        if not self._popup_enabled():
            return []

        token = self.auth_manager.get_supabase_token()
        if not token:
            logger.debug('[DqNudge.poller] No Supabase token; skipping poll')
            return []

        try:
            resp = requests.get(
                self.ai_server_url + NUDGES_ENDPOINT,
                headers={'Authorization': f'Bearer {token}', 'Accept': 'application/json'},
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

    def _run(self) -> None:
        # Stagger first poll by a few seconds so we don't compete with app boot.
        if self._stop_event.wait(timeout=5):
            return

        while not self._stop_event.is_set():
            try:
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
