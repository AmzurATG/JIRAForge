"""Unit tests for the updated get_activity_monitoring_status().

Verifies the new fields: idle_backend, dbus_available, evdev_devices_accessible.

Run with:  pytest tests/test_activity_monitoring_status.py -v
"""
import sys
import os
import time
import unittest
from unittest.mock import MagicMock, patch


# ---------------------------------------------------------------------------
# Minimal stub app
# ---------------------------------------------------------------------------

class _FakeApp:
    def __init__(self):
        self.idle_timeout = 300
        self.tracking_settings = {}
        self.running = True
        self.is_idle = False
        self.last_activity_time = time.time()
        self._activity_listener_started = False
        self._activity_listener_error = None
        self._idle_backend = 'dbus_screensaver'

    def add_admin_log(self, level, msg):
        pass


def _attach_status(app):
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
    setattr(type(app), 'get_activity_monitoring_status',
            da.TimeTracker.get_activity_monitoring_status)
    return app


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestActivityMonitoringStatus(unittest.TestCase):

    def setUp(self):
        self.app = _attach_status(_FakeApp())

    # --- idle_backend key present ---

    def test_status_includes_idle_backend_key(self):
        self.app._idle_backend = 'dbus_screensaver'
        with patch('subprocess.run', return_value=MagicMock(returncode=1)), \
             patch('glob.glob', return_value=[]), \
             patch.dict(sys.modules, {'dbus': MagicMock()}):
            status = self.app.get_activity_monitoring_status()
        self.assertIn('idle_backend', status)
        self.assertEqual(status['idle_backend'], 'dbus_screensaver')

    # --- evdev_devices_accessible count ---

    def test_status_reports_evdev_device_count(self):
        with patch('subprocess.run', return_value=MagicMock(returncode=1)), \
             patch('glob.glob', return_value=['/dev/input/event0', '/dev/input/event1']), \
             patch('os.access', return_value=True):
            status = self.app.get_activity_monitoring_status()
        self.assertEqual(status['evdev_devices_accessible'], 2)

    def test_status_reports_zero_evdev_when_none_accessible(self):
        with patch('subprocess.run', return_value=MagicMock(returncode=1)), \
             patch('glob.glob', return_value=['/dev/input/event0']), \
             patch('os.access', return_value=False):
            status = self.app.get_activity_monitoring_status()
        self.assertEqual(status['evdev_devices_accessible'], 0)

    # --- dbus_available field ---

    def test_status_reports_dbus_available_true(self):
        with patch('subprocess.run', return_value=MagicMock(returncode=1)), \
             patch('glob.glob', return_value=[]), \
             patch.dict(sys.modules, {'dbus': MagicMock()}):
            status = self.app.get_activity_monitoring_status()
        self.assertIn('dbus_available', status)

    # --- idle_backend defaults to 'unknown' when not set ---

    def test_status_returns_unknown_when_backend_not_set(self):
        # Remove _idle_backend attribute
        if hasattr(self.app, '_idle_backend'):
            del self.app._idle_backend

        with patch('subprocess.run', return_value=MagicMock(returncode=1)), \
             patch('glob.glob', return_value=[]):
            status = self.app.get_activity_monitoring_status()
        self.assertEqual(status['idle_backend'], 'unknown')

    # --- existing fields still present ---

    def test_existing_fields_still_present(self):
        required_keys = [
            'pynput_available', 'listener_started', 'listener_error',
            'last_activity_ago_seconds', 'is_idle', 'display_server',
            'wayland_display', 'xwayland_running',
        ]
        with patch('subprocess.run', return_value=MagicMock(returncode=1)), \
             patch('glob.glob', return_value=[]):
            status = self.app.get_activity_monitoring_status()
        for key in required_keys:
            self.assertIn(key, status, f"Expected key '{key}' missing from status dict")


if __name__ == '__main__':
    unittest.main()
