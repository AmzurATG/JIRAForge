"""
Session Tracker — Active Window Time Accumulator
==================================================

Monitors window changes and accumulates time per window in SQLite.
When a window switch occurs, the elapsed time since the last switch
is added to the previous window's total in the database.
"""

import time
import logging
from datetime import datetime, timezone

from .sqlite_manager import SQLiteManager

logger = logging.getLogger(__name__)


class SessionTracker:
    """Track active window sessions and accumulate time in SQLite."""

    def __init__(self, db_manager: SQLiteManager, idle_threshold: float = 120.0,
                 min_session_duration: float = 3.0):
        self.db = db_manager
        self.idle_threshold = idle_threshold
        self.min_session_duration = min_session_duration

        # Current window state
        self._current_title = None
        self._current_app = None
        self._last_switch_time = time.time()
        self._is_idle = False

    def on_window_change(self, title, app_name, ocr_text='',
                         ocr_method='', ocr_confidence=0.0,
                         classification=''):
        """Called when the active window changes.

        Calculates elapsed time for the previous window and upserts it
        into SQLite. Then sets the new window as current.
        """
        now = time.time()
        elapsed = now - self._last_switch_time

        # Record the previous window if it was active long enough
        if (self._current_title is not None
                and elapsed >= self.min_session_duration
                and not self._is_idle):
            self.db.upsert_session(
                window_title=self._current_title,
                application_name=self._current_app or '',
                elapsed_seconds=elapsed,
                ocr_text=ocr_text,
                ocr_method=ocr_method,
                ocr_confidence=ocr_confidence,
                classification=classification,
            )
            logger.debug(
                "Session +%.1fs for %s — %s",
                elapsed, self._current_app, (self._current_title or '')[:40]
            )

        # Update current window
        self._current_title = title
        self._current_app = app_name
        self._last_switch_time = now
        self._is_idle = False

    def on_idle_start(self):
        """Called when the user goes idle — flush current accumulated time."""
        if self._current_title is not None and not self._is_idle:
            elapsed = time.time() - self._last_switch_time
            if elapsed >= self.min_session_duration:
                self.db.upsert_session(
                    window_title=self._current_title,
                    application_name=self._current_app or '',
                    elapsed_seconds=elapsed,
                )
        self._is_idle = True

    def on_idle_resume(self):
        """Called when activity resumes from idle — reset the timer."""
        self._last_switch_time = time.time()
        self._is_idle = False

    def stop_current_timer(self):
        """Flush current session without clearing the window — useful before idle."""
        if self._current_title is not None and not self._is_idle:
            elapsed = time.time() - self._last_switch_time
            if elapsed >= self.min_session_duration:
                self.db.upsert_session(
                    window_title=self._current_title,
                    application_name=self._current_app or '',
                    elapsed_seconds=elapsed,
                )
        self._last_switch_time = time.time()

    def get_sessions_for_upload(self):
        """Return all accumulated sessions."""
        return self.db.get_all_sessions()

    def reset_after_upload(self):
        """Clear accumulated sessions after a successful upload."""
        self.db.clear_sessions()
        self._last_switch_time = time.time()
        logger.info("Session tracker reset after upload")
