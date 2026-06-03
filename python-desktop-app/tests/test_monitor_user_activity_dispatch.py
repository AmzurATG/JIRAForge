"""Integration-style dispatch tests for refactored monitor_user_activity().

Verifies that the correct backend thread is started for each environment.

Run with:  pytest tests/test_monitor_user_activity_dispatch.py -v
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
        self._activity_listener_started = False
        self._activity_listener_error = None
        self._idle_backend = None
        self._admin_logs = []
        self._enter_idle_calls = []

    def add_admin_log(self, level, msg):
        self._admin_logs.append((level, msg))

    def enter_idle(self, reason):
        self._enter_idle_calls.append(reason)
        self.is_idle = True

    def _poll_dbus_idle_time(self):
        return 1000   # 1 second idle — well below threshold

    def _poll_gnome_mutter_idle(self):
        return 1000

    def _dbus_idle_poll_worker(self, poll_fn):
        # Stub: just set a flag and return immediately
        self._dbus_worker_called = True
        return

    def _start_evdev_listener(self, callback):
        self._evdev_called = True
        self._activity_listener_started = True
        return MagicMock()

    def _detect_idle_backend(self):
        return self._forced_backend


def _attach_monitor(app):
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
    setattr(type(app), 'monitor_user_activity', da.TimeTracker.monitor_user_activity)
    return app


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestMonitorUserActivityDispatch(unittest.TestCase):

    def setUp(self):
        self.app = _attach_monitor(_FakeApp())
        self.app._dbus_worker_called = False
        self.app._evdev_called = False

    # --- D-Bus screensaver backend ---

    def test_dbus_worker_thread_started_for_dbus_screensaver(self):
        self.app._forced_backend = 'dbus_screensaver'
        started_threads = []
        real_thread_init = threading.Thread.__init__

        def patched_start(t_self):
            started_threads.append(getattr(t_self, 'name', ''))
            # Don't actually start — just record

        with patch.object(threading.Thread, 'start', patched_start), \
             patch.dict(os.environ, {'XDG_SESSION_TYPE': 'wayland'}):
            self.app.monitor_user_activity()

        dbus_threads = [n for n in started_threads if 'dbus' in n or 'idle' in n]
        self.assertTrue(len(dbus_threads) > 0 or self.app._dbus_worker_called,
                        "D-Bus poll thread should have been started")

    def test_listener_started_flag_set_for_dbus_backend(self):
        self.app._forced_backend = 'dbus_screensaver'
        with patch.object(threading.Thread, 'start', lambda s: None), \
             patch.dict(os.environ, {'XDG_SESSION_TYPE': 'wayland'}):
            self.app.monitor_user_activity()
        self.assertTrue(self.app._activity_listener_started,
                        "listener_started should be True for D-Bus backend")

    # --- evdev backend ---

    def test_evdev_listener_started_for_evdev_backend(self):
        self.app._forced_backend = 'evdev'
        with patch.dict(os.environ, {'XDG_SESSION_TYPE': 'wayland'}):
            self.app.monitor_user_activity()
        self.assertTrue(self.app._evdev_called,
                        "_start_evdev_listener should have been called for evdev backend")

    # --- pynput backend: verify thread started ---

    def test_verify_thread_started_for_pynput(self):
        self.app._forced_backend = 'pynput'
        thread_names = []

        def mock_start(t_self):
            thread_names.append(getattr(t_self, 'name', ''))

        mock_mouse = MagicMock()
        mock_keyboard = MagicMock()

        with patch('pynput.mouse.Listener', return_value=MagicMock()), \
             patch('pynput.keyboard.Listener', return_value=MagicMock()), \
             patch.object(threading.Thread, 'start', mock_start), \
             patch.dict(os.environ, {'XDG_SESSION_TYPE': 'x11'}):
            self.app.monitor_user_activity()

        verify_threads = [n for n in thread_names if 'verify' in n or 'pynput' in n]
        # The verify thread should be present (named 'pynput-verify')
        self.assertTrue(any('pynput-verify' in n or 'verify' in n for n in thread_names),
                        f"pynput verify thread not found in started threads: {thread_names}")

    # --- pynput backend: no verify thread for D-Bus ---

    def test_no_verify_thread_for_dbus_backend(self):
        self.app._forced_backend = 'dbus_screensaver'
        thread_names = []

        def mock_start(t_self):
            thread_names.append(getattr(t_self, 'name', ''))

        with patch.object(threading.Thread, 'start', mock_start), \
             patch.dict(os.environ, {'XDG_SESSION_TYPE': 'wayland'}):
            self.app.monitor_user_activity()

        self.assertFalse(any('verify' in n or 'pynput-verify' in n for n in thread_names),
                         f"verify thread should NOT be started for D-Bus backend: {thread_names}")

    # --- none backend: error logged ---

    def test_error_logged_when_no_backend_available(self):
        self.app._forced_backend = 'none'
        with patch.dict(os.environ, {'XDG_SESSION_TYPE': 'wayland'}):
            self.app.monitor_user_activity()

        error_logs = [msg for level, msg in self.app._admin_logs if level == 'ERROR']
        self.assertTrue(len(error_logs) > 0,
                        "An ERROR admin log should be recorded when no backend is available")

    # --- idle_backend attribute is set ---

    def test_idle_backend_attribute_set(self):
        for backend in ('dbus_screensaver', 'gnome_mutter', 'evdev', 'none'):
            self.app._forced_backend = backend
            self.app._idle_backend = None
            with patch.object(threading.Thread, 'start', lambda s: None), \
                 patch.dict(os.environ, {'XDG_SESSION_TYPE': 'wayland'}):
                self.app.monitor_user_activity()
            self.assertEqual(self.app._idle_backend, backend,
                             f"_idle_backend should be '{backend}', got '{self.app._idle_backend}'")


if __name__ == '__main__':
    unittest.main()
