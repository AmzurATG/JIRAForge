"""Unit tests for _detect_idle_backend() — idle detection backend probe.

Run with:  pytest tests/test_idle_backend_detection.py -v
"""
import sys
import os
import types
import importlib
import unittest
from unittest.mock import MagicMock, patch, PropertyMock

# ---------------------------------------------------------------------------
# Minimal stub so we can import just the methods we care about without
# needing a fully initialised TimeTracker application.
# ---------------------------------------------------------------------------

class _FakeApp:
    """Thin stub that exposes only the methods under test."""

    idle_timeout = 300
    tracking_settings = {}
    running = True

    def add_admin_log(self, level, msg):
        pass


def _inject_method(cls, name, fn):
    import types as _t
    setattr(cls, name, _t.MethodType(fn, cls))


# Import ONLY the three methods from the real module without running the app.
# We do this by importing the module text and exec-ing just the class body we need.
# The cleanest approach on a very large file is to monkey-patch the class after import.

def _build_app_under_test():
    """Return a _FakeApp instance with the real idle-backend methods attached."""
    # Locate and import the real module
    src_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    if src_dir not in sys.path:
        sys.path.insert(0, src_dir)

    # We patch all GUI/heavy dependencies before importing
    heavy_mods = [
        'tkinter', 'pystray', 'PIL', 'PIL.Image', 'PIL.ImageDraw', 'PIL.ImageFont',
        'pynput', 'pynput.mouse', 'pynput.keyboard',
        'cv2', 'numpy', 'pytesseract', 'easyocr',
        'supabase', 'postgrest',
        'cryptography', 'cryptography.fernet',
    ]
    patches = {}
    for mod in heavy_mods:
        if mod not in sys.modules:
            sys.modules[mod] = MagicMock()

    # Import the real desktop_app module (side-effect free at module level)
    import desktop_app as da
    app = _FakeApp()
    # Attach the real unbound implementations
    for name in ('_detect_idle_backend', '_poll_dbus_idle_time',
                  '_poll_gnome_mutter_idle'):
        real_fn = getattr(da.TimeTracker, name)
        setattr(type(app), name, real_fn)
    return app


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------

class TestDetectIdleBackend(unittest.TestCase):

    def setUp(self):
        self.app = _build_app_under_test()

    # --- Valid return value ---

    def test_returns_valid_string(self):
        valid = {'dbus_screensaver', 'gnome_mutter', 'evdev', 'pynput', 'none'}
        with patch.object(type(self.app), '_detect_idle_backend',
                          wraps=self.app._detect_idle_backend):
            result = self.app._detect_idle_backend()
        self.assertIn(result, valid, f"Unexpected backend: {result!r}")

    # --- Tier 1: D-Bus ScreenSaver ---

    def test_dbus_screensaver_selected_when_available(self):
        mock_iface = MagicMock()
        mock_iface.GetSessionIdleTime.return_value = 1000

        with patch.dict(sys.modules, {'dbus': MagicMock()}):
            import dbus as _dbus
            _dbus.SessionBus.return_value.get_object.return_value = MagicMock()
            _dbus.Interface.return_value = mock_iface

            result = self.app._detect_idle_backend()

        self.assertEqual(result, 'dbus_screensaver')

    # --- Tier 2: GNOME Mutter ---

    def test_gnome_mutter_selected_when_screensaver_fails(self):
        mock_ss_iface = MagicMock()
        mock_ss_iface.GetSessionIdleTime.side_effect = Exception("no screensaver")
        mock_mutter_iface = MagicMock()
        mock_mutter_iface.GetIdletime.return_value = 2000

        call_count = {'n': 0}

        def fake_Interface(obj, iface_name):
            call_count['n'] += 1
            if 'ScreenSaver' in iface_name:
                return mock_ss_iface
            return mock_mutter_iface

        with patch.dict(sys.modules, {'dbus': MagicMock()}):
            import dbus as _dbus
            _dbus.Interface.side_effect = fake_Interface
            _dbus.SessionBus.return_value.get_object.return_value = MagicMock()

            result = self.app._detect_idle_backend()

        self.assertEqual(result, 'gnome_mutter')

    # --- Tier 3: evdev ---

    def test_evdev_selected_when_dbus_unavailable(self):
        # Make dbus import fail
        import builtins
        real_import = builtins.__import__

        def no_dbus(name, *args, **kwargs):
            if name == 'dbus':
                raise ImportError("no dbus")
            return real_import(name, *args, **kwargs)

        with patch('builtins.__import__', side_effect=no_dbus), \
             patch('glob.glob', return_value=['/dev/input/event0']), \
             patch('os.access', return_value=True):
            result = self.app._detect_idle_backend()

        self.assertEqual(result, 'evdev')

    # --- Tier 4: pynput ---

    def test_pynput_fallback_when_dbus_and_evdev_unavailable(self):
        import builtins
        real_import = builtins.__import__

        def no_dbus(name, *args, **kwargs):
            if name == 'dbus':
                raise ImportError("no dbus")
            return real_import(name, *args, **kwargs)

        with patch('builtins.__import__', side_effect=no_dbus), \
             patch('glob.glob', return_value=[]), \
             patch('os.access', return_value=False):
            # pynput IS available (already in sys.modules from setUp mock)
            result = self.app._detect_idle_backend()

        self.assertEqual(result, 'pynput')

    # --- Tier 'none' ---

    def test_none_when_all_tiers_unavailable(self):
        import builtins
        real_import = builtins.__import__

        def no_heavy(name, *args, **kwargs):
            if name in ('dbus', 'pynput'):
                raise ImportError(f"no {name}")
            return real_import(name, *args, **kwargs)

        with patch('builtins.__import__', side_effect=no_heavy), \
             patch('glob.glob', return_value=[]), \
             patch('os.access', return_value=False):
            result = self.app._detect_idle_backend()

        self.assertEqual(result, 'none')


if __name__ == '__main__':
    unittest.main()
