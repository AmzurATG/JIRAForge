"""Unit tests for _dbus_idle_poll_worker().

Tests the poll loop's state machine: enter_idle / needs_idle_resume transitions.

Run with:  pytest tests/test_dbus_poll_worker.py -v
"""
import sys
import os
import time
import threading
import unittest
from unittest.mock import MagicMock, patch, call


# ---------------------------------------------------------------------------
# Minimal stub app
# ---------------------------------------------------------------------------

class _FakeApp:
    def __init__(self):
        self.idle_timeout = 300
        self.tracking_settings = {}
        self.running = True
        self.is_idle = False
        self.needs_idle_resume = False
        self.last_activity_time = time.time()
        self._enter_idle_calls = []
        self._resume_calls = []

    def enter_idle(self, reason):
        self._enter_idle_calls.append(reason)
        self.is_idle = True

    def resume_from_idle(self):
        self._resume_calls.append(True)
        self.is_idle = False
        return True

    def add_admin_log(self, level, msg):
        pass


def _attach_worker(app):
    src_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if src_dir not in sys.path:
        sys.path.insert(0, src_dir)

    for mod in ['tkinter', 'pystray', 'PIL', 'PIL.Image', 'pynput',
                'pynput.mouse', 'pynput.keyboard', 'cv2', 'numpy',
                'pytesseract', 'easyocr', 'supabase', 'postgrest',
                'cryptography', 'cryptography.fernet']:
        if mod not in sys.modules:
            sys.modules[mod] = MagicMock()

    import desktop_app as da
    setattr(type(app), '_dbus_idle_poll_worker', da.TimeTracker._dbus_idle_poll_worker)
    return app


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestDbusPollWorker(unittest.TestCase):

    def setUp(self):
        self.app = _attach_worker(_FakeApp())

    def _run_worker_cycles(self, poll_values, timeout=3):
        """Run the worker thread with a sequence of poll return values, then stop it."""
        iter_values = iter(poll_values)

        def poll_fn():
            try:
                return next(iter_values)
            except StopIteration:
                self.app.running = False
                return None

        with patch.dict(os.environ, {'IDLE_POLL_INTERVAL': '0'}):
            t = threading.Thread(target=self.app._dbus_idle_poll_worker,
                                 args=(poll_fn,), daemon=True)
            t.start()
            t.join(timeout=timeout)
        self.app.running = False

    # --- enter_idle called when threshold exceeded ---

    def test_enter_idle_called_when_threshold_exceeded(self):
        # idle_ms > 300 000 ms (300 seconds == idle_timeout)
        self._run_worker_cycles([310_000] + [None])
        self.assertEqual(len(self.app._enter_idle_calls), 1)
        self.assertEqual(self.app._enter_idle_calls[0], "idle timeout")

    # --- enter_idle NOT called twice (was_idle guard) ---

    def test_enter_idle_not_called_twice(self):
        # Two consecutive polls both above threshold
        self._run_worker_cycles([310_000, 320_000] + [None])
        self.assertEqual(len(self.app._enter_idle_calls), 1,
                         "enter_idle should only fire once while already idle")

    # --- needs_idle_resume set when activity resumes ---

    def test_needs_idle_resume_set_when_activity_resumes(self):
        # First poll: above threshold (enter idle), second: below (resume)
        self.app.is_idle = False   # start active
        self._run_worker_cycles([310_000, 5_000] + [None])
        self.assertTrue(self.app.needs_idle_resume,
                        "needs_idle_resume should be True after activity resumes")

    # --- last_activity_time updated during normal activity ---

    def test_last_activity_time_updated_during_normal_activity(self):
        before = time.time()
        # 5 seconds idle (below 300s threshold)
        self._run_worker_cycles([5_000] + [None])
        # last_activity_time should be approximately now - 5
        expected = time.time() - 5
        self.assertAlmostEqual(self.app.last_activity_time, expected, delta=2,
                               msg="last_activity_time should reflect current idle duration")

    # --- worker exits cleanly when running is False ---

    def test_worker_exits_cleanly_when_running_false(self):
        def poll_fn():
            return 1_000   # always below threshold

        self.app.running = True
        with patch.dict(os.environ, {'IDLE_POLL_INTERVAL': '0'}):
            t = threading.Thread(target=self.app._dbus_idle_poll_worker,
                                 args=(poll_fn,), daemon=True)
            t.start()
            time.sleep(0.05)
            self.app.running = False
            t.join(timeout=5)
        self.assertFalse(t.is_alive(), "Worker thread should exit when self.running is False")

    # --- poll returning None does not crash ---

    def test_none_poll_result_does_not_raise(self):
        # All poll results are None (D-Bus unavailable)
        try:
            self._run_worker_cycles([None, None, None])
        except Exception as e:
            self.fail(f"Worker raised an exception on None poll results: {e}")


if __name__ == '__main__':
    unittest.main()
