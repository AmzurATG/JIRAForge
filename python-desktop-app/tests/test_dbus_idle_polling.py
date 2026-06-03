"""Unit tests for _poll_dbus_idle_time() and _poll_gnome_mutter_idle().

Run with:  pytest tests/test_dbus_idle_polling.py -v
"""
import sys
import os
import unittest
from unittest.mock import MagicMock, patch


# ---------------------------------------------------------------------------
# Minimal stub app with methods under test
# ---------------------------------------------------------------------------

class _FakeApp:
    idle_timeout = 300
    tracking_settings = {}
    running = True

    def add_admin_log(self, level, msg):
        pass


def _attach_methods(app):
    src_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if src_dir not in sys.path:
        sys.path.insert(0, src_dir)

    heavy = [
        'tkinter', 'pystray', 'PIL', 'PIL.Image', 'PIL.ImageDraw', 'PIL.ImageFont',
        'pynput', 'pynput.mouse', 'pynput.keyboard',
        'cv2', 'numpy', 'pytesseract', 'easyocr',
        'supabase', 'postgrest', 'cryptography', 'cryptography.fernet',
    ]
    for mod in heavy:
        if mod not in sys.modules:
            sys.modules[mod] = MagicMock()

    import desktop_app as da
    for name in ('_poll_dbus_idle_time', '_poll_gnome_mutter_idle'):
        setattr(type(app), name, getattr(da.TimeTracker, name))
    return app


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestPollDbusIdleTime(unittest.TestCase):

    def setUp(self):
        self.app = _attach_methods(_FakeApp())

    def test_returns_int_on_success(self):
        mock_iface = MagicMock()
        mock_iface.GetSessionIdleTime.return_value = 30000

        with patch.dict(sys.modules, {'dbus': MagicMock()}):
            import dbus as _dbus
            _dbus.Interface.return_value = mock_iface

            result = self.app._poll_dbus_idle_time()

        self.assertEqual(result, 30000)

    def test_returns_none_on_dbus_exception(self):
        with patch.dict(sys.modules, {'dbus': MagicMock()}):
            import dbus as _dbus
            _dbus.SessionBus.side_effect = Exception("DBus error")

            result = self.app._poll_dbus_idle_time()

        self.assertIsNone(result)

    def test_returns_none_when_dbus_not_installed(self):
        import builtins
        real_import = builtins.__import__

        def no_dbus(name, *args, **kwargs):
            if name == 'dbus':
                raise ImportError("no dbus")
            return real_import(name, *args, **kwargs)

        with patch('builtins.__import__', side_effect=no_dbus):
            result = self.app._poll_dbus_idle_time()

        self.assertIsNone(result)

    def test_returns_none_on_get_session_idle_time_error(self):
        mock_iface = MagicMock()
        mock_iface.GetSessionIdleTime.side_effect = RuntimeError("method not found")

        with patch.dict(sys.modules, {'dbus': MagicMock()}):
            import dbus as _dbus
            _dbus.Interface.return_value = mock_iface

            result = self.app._poll_dbus_idle_time()

        self.assertIsNone(result)


class TestPollGnomeMutterIdle(unittest.TestCase):

    def setUp(self):
        self.app = _attach_methods(_FakeApp())

    def test_returns_int_on_success(self):
        mock_iface = MagicMock()
        mock_iface.GetIdletime.return_value = 15000

        with patch.dict(sys.modules, {'dbus': MagicMock()}):
            import dbus as _dbus
            _dbus.Interface.return_value = mock_iface

            result = self.app._poll_gnome_mutter_idle()

        self.assertEqual(result, 15000)

    def test_returns_none_on_exception(self):
        with patch.dict(sys.modules, {'dbus': MagicMock()}):
            import dbus as _dbus
            _dbus.SessionBus.side_effect = RuntimeError("no mutter")

            result = self.app._poll_gnome_mutter_idle()

        self.assertIsNone(result)

    def test_returns_none_when_dbus_not_installed(self):
        import builtins
        real_import = builtins.__import__

        def no_dbus(name, *args, **kwargs):
            if name == 'dbus':
                raise ImportError("no dbus")
            return real_import(name, *args, **kwargs)

        with patch('builtins.__import__', side_effect=no_dbus):
            result = self.app._poll_gnome_mutter_idle()

        self.assertIsNone(result)

    def test_returns_none_on_get_idletime_error(self):
        mock_iface = MagicMock()
        mock_iface.GetIdletime.side_effect = Exception("interface error")

        with patch.dict(sys.modules, {'dbus': MagicMock()}):
            import dbus as _dbus
            _dbus.Interface.return_value = mock_iface

            result = self.app._poll_gnome_mutter_idle()

        self.assertIsNone(result)


if __name__ == '__main__':
    unittest.main()
