"""Unit tests for _start_evdev_listener().

Tests raw kernel input device reading (display-server agnostic).

Run with:  pytest tests/test_evdev_listener.py -v
"""
import sys
import os
import io
import struct
import time
import threading
import unittest
from unittest.mock import MagicMock, patch, mock_open


# ---------------------------------------------------------------------------
# Minimal stub app
# ---------------------------------------------------------------------------

class _FakeApp:
    def __init__(self):
        self.running = True
        self._activity_listener_started = False
        self._activity_calls = []

    def add_admin_log(self, level, msg):
        pass


def _attach_listener(app):
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
    setattr(type(app), '_start_evdev_listener', da.TimeTracker._start_evdev_listener)
    return app


def _make_event_bytes():
    """Return a valid struct input_event (16 bytes on most Linux systems)."""
    return struct.pack('llHHI', int(time.time()), 0, 1, 30, 1)  # EV_KEY, KEY_A, pressed


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestEvdevListener(unittest.TestCase):

    def setUp(self):
        self.app = _attach_listener(_FakeApp())

    def tearDown(self):
        # Ensure any lingering evdev reader threads from this test stop cleanly
        self.app.running = False
        time.sleep(0.05)

    def _stop_after(self, seconds=0.2):
        """Stop the app after a short delay to let threads terminate."""
        def stopper():
            time.sleep(seconds)
            self.app.running = False
        threading.Thread(target=stopper, daemon=True).start()

    # --- callback fired when event data available ---

    def test_on_activity_called_when_event_received(self):
        event_data = _make_event_bytes()
        called = []

        def callback(*_):
            called.append(True)
            self.app.running = False   # stop after first event

        fake_file = MagicMock()
        fake_file.__enter__ = lambda s: s
        fake_file.__exit__ = MagicMock(return_value=False)
        fake_file.read.return_value = event_data
        fake_file.fileno.return_value = 10   # needed for select

        import select as _select
        with patch('glob.glob', return_value=['/dev/input/event0']), \
             patch('os.access', return_value=True), \
             patch('builtins.open', return_value=fake_file), \
             patch('select.select', return_value=([fake_file], [], [])):
            t = self.app._start_evdev_listener(callback)
            if t:
                t.join(timeout=3)

        self.assertTrue(len(called) > 0, "on_activity callback should have been called")

    # --- no crash when no devices accessible ---

    def test_no_crash_when_no_devices_accessible(self):
        with patch('glob.glob', return_value=['/dev/input/event0']), \
             patch('os.access', return_value=True), \
             patch('builtins.open', side_effect=PermissionError("denied")):
            try:
                result = self.app._start_evdev_listener(lambda: None)
            except Exception as e:
                self.fail(f"_start_evdev_listener raised unexpectedly: {e}")

        # Returns None when no readable devices
        self.assertIsNone(result)

    # --- skip unreadable devices, continue with readable ---

    def test_skip_unreadable_continue_with_readable(self):
        called = []
        event_data = _make_event_bytes()

        def callback():
            called.append(True)
            self.app.running = False

        good_file = MagicMock()
        good_file.read.return_value = event_data
        good_file.fileno.return_value = 11

        open_calls = {'n': 0}

        def selective_open(path, *args, **kwargs):
            open_calls['n'] += 1
            if 'event0' in path:
                raise PermissionError("denied")
            return good_file

        import select as _select
        with patch('glob.glob', return_value=['/dev/input/event0', '/dev/input/event1']), \
             patch('os.access', return_value=True), \
             patch('builtins.open', side_effect=selective_open), \
             patch('select.select', return_value=([good_file], [], [])):
            t = self.app._start_evdev_listener(callback)
            if t:
                t.join(timeout=3)

        self.assertTrue(len(called) > 0, "Callback should have fired for the readable device")

    # --- thread exits cleanly when running is False ---

    def test_thread_exits_cleanly_on_running_false(self):
        fake_file = MagicMock()
        fake_file.fileno.return_value = 12   # must be int for select

        def callback():
            pass   # don't stop running — let the stopper do it

        self._stop_after(0.15)

        # Patch select.select to return empty ready-list so the loop spins without I/O
        with patch('glob.glob', return_value=['/dev/input/event0']), \
             patch('os.access', return_value=True), \
             patch('builtins.open', return_value=fake_file), \
             patch('select.select', return_value=([], [], [])):
            t = self.app._start_evdev_listener(callback)
            if t:
                t.join(timeout=5)

        if t:
            self.assertFalse(t.is_alive(), "evdev listener thread should exit when self.running is False")

    # --- _activity_listener_started set to True after first open ---

    def test_listener_started_flag_set(self):
        fake_file = MagicMock()
        fake_file.fileno.return_value = 20

        with patch('glob.glob', return_value=['/dev/input/event0']), \
             patch('os.access', return_value=True), \
             patch('builtins.open', return_value=fake_file), \
             patch('select.select', return_value=([], [], [])):
            # Just check the flag is set during start
            self.app._start_evdev_listener(lambda: None)

        self.assertTrue(self.app._activity_listener_started,
                        "_activity_listener_started should be True when devices are accessible")


if __name__ == '__main__':
    unittest.main()
