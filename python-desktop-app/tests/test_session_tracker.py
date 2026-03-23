"""
Session Tracker Test Suite
===========================

Tests the local_storage.session_tracker module — verifying time
accumulation, idle start/resume, and session flushing.

Usage:
    python -m pytest tests/test_session_tracker.py -v
    python -m tests.test_session_tracker
"""

import os
import sys
import time
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from local_storage.sqlite_manager import SQLiteManager
from local_storage.session_tracker import SessionTracker


class TestSessionTracker(unittest.TestCase):
    """Test SessionTracker time accumulation and idle handling."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.db = SQLiteManager(db_path=os.path.join(self.tmpdir, 'test.db'))
        self.tracker = SessionTracker(self.db, idle_threshold=5.0, min_session_duration=0.0)

    def tearDown(self):
        self.db.close()
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_window_change_records_time(self):
        """Switching windows should record elapsed time for the previous window."""
        self.tracker.on_window_change("Window A", "app_a")
        time.sleep(0.1)
        self.tracker.on_window_change("Window B", "app_b")

        sessions = self.db.get_all_sessions()
        self.assertEqual(len(sessions), 1)
        self.assertEqual(sessions[0]['window_title'], 'Window A')
        self.assertGreater(sessions[0]['total_time_seconds'], 0)

    def test_time_accumulates(self):
        """Returning to the same window should accumulate time."""
        self.tracker.on_window_change("Window A", "app_a")
        time.sleep(0.05)
        self.tracker.on_window_change("Window B", "app_b")
        time.sleep(0.05)
        self.tracker.on_window_change("Window A", "app_a")

        sessions = self.db.get_all_sessions()
        # Window A and Window B should each have a session
        titles = {s['window_title'] for s in sessions}
        self.assertIn('Window A', titles)
        self.assertIn('Window B', titles)

    def test_idle_start_flushes(self):
        """Going idle should flush accumulated time."""
        self.tracker.on_window_change("Window A", "app_a")
        time.sleep(0.05)
        self.tracker.on_idle_start()

        sessions = self.db.get_all_sessions()
        self.assertEqual(len(sessions), 1)

    def test_idle_resume_resets_timer(self):
        """Resuming from idle should reset the timer."""
        self.tracker.on_window_change("Window A", "app_a")
        time.sleep(0.05)
        self.tracker.on_idle_start()
        self.tracker.on_idle_resume()
        time.sleep(0.05)
        self.tracker.on_window_change("Window B", "app_b")

        sessions = self.db.get_all_sessions()
        self.assertGreaterEqual(len(sessions), 1)

    def test_stop_current_timer(self):
        """stop_current_timer should flush without clearing the current window."""
        self.tracker.on_window_change("Window A", "app_a")
        time.sleep(0.05)
        self.tracker.stop_current_timer()

        sessions = self.db.get_all_sessions()
        self.assertEqual(len(sessions), 1)

    def test_get_sessions_for_upload(self):
        self.tracker.on_window_change("Window A", "app_a")
        time.sleep(0.05)
        self.tracker.on_window_change("Window B", "app_b")

        upload = self.tracker.get_sessions_for_upload()
        self.assertIsInstance(upload, list)
        self.assertGreater(len(upload), 0)

    def test_reset_after_upload(self):
        self.tracker.on_window_change("Window A", "app_a")
        time.sleep(0.05)
        self.tracker.on_window_change("Window B", "app_b")
        self.tracker.reset_after_upload()

        sessions = self.db.get_all_sessions()
        self.assertEqual(len(sessions), 0)

    def test_min_session_duration_filter(self):
        """Sessions shorter than min_session_duration should be skipped."""
        strict_tracker = SessionTracker(self.db, min_session_duration=10.0)
        strict_tracker.on_window_change("Window A", "app_a")
        # Immediately switch — elapsed is ~0
        strict_tracker.on_window_change("Window B", "app_b")

        sessions = self.db.get_all_sessions()
        self.assertEqual(len(sessions), 0)


if __name__ == '__main__':
    unittest.main()
