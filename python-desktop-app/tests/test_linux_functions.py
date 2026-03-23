"""
Linux Functions Test Suite
===========================

Tests the desktop_app_linux.py module: single-instance lock, XDG paths,
autostart .desktop file, active window tracking, idle detection, notifications,
and screenshot capture.

Usage:
    python -m pytest tests/test_linux_functions.py -v
    python -m tests.test_linux_functions
"""

import os
import sys
import tempfile
import unittest
from unittest.mock import patch, MagicMock

# Ensure the parent directory is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


class TestSingleInstanceLock(unittest.TestCase):
    """Test fcntl-based single instance lock."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.lock_path = os.path.join(self.tmpdir, '.lock')

    def tearDown(self):
        # Make sure we release any lock before cleanup
        try:
            from desktop_app_linux import release_single_instance_lock_linux
            release_single_instance_lock_linux()
        except Exception:
            pass
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    @unittest.skipUnless(sys.platform.startswith('linux'), "Linux only")
    def test_acquire_lock_succeeds(self):
        from desktop_app_linux import acquire_single_instance_lock_linux
        result = acquire_single_instance_lock_linux(self.lock_path)
        self.assertTrue(result)
        self.assertTrue(os.path.exists(self.lock_path))

    @unittest.skipUnless(sys.platform.startswith('linux'), "Linux only")
    def test_lock_contains_pid(self):
        from desktop_app_linux import acquire_single_instance_lock_linux
        acquire_single_instance_lock_linux(self.lock_path)
        with open(self.lock_path, 'r') as f:
            content = f.read().strip()
        self.assertEqual(content, str(os.getpid()))

    @unittest.skipUnless(sys.platform.startswith('linux'), "Linux only")
    def test_release_lock(self):
        from desktop_app_linux import (
            acquire_single_instance_lock_linux,
            release_single_instance_lock_linux,
        )
        acquire_single_instance_lock_linux(self.lock_path)
        release_single_instance_lock_linux()
        # After release, another acquire should succeed
        result = acquire_single_instance_lock_linux(self.lock_path)
        self.assertTrue(result)
        release_single_instance_lock_linux()

    @unittest.skipUnless(sys.platform.startswith('linux'), "Linux only")
    def test_double_acquire_fails(self):
        """Second acquire in same process should fail (non-blocking)."""
        import fcntl
        from desktop_app_linux import acquire_single_instance_lock_linux

        # Acquire via a raw fd first
        lock_fd = open(self.lock_path, 'w')
        fcntl.flock(lock_fd.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)

        # Now the module's acquire should fail
        result = acquire_single_instance_lock_linux(self.lock_path)
        self.assertFalse(result)

        # Cleanup
        fcntl.flock(lock_fd.fileno(), fcntl.LOCK_UN)
        lock_fd.close()


class TestAppDataDir(unittest.TestCase):
    """Test XDG-compliant app data directory."""

    @unittest.skipUnless(sys.platform.startswith('linux'), "Linux only")
    def test_default_path(self):
        from desktop_app_linux import get_app_data_dir_linux
        with patch.dict(os.environ, {}, clear=False):
            # Remove XDG_DATA_HOME if set
            env = os.environ.copy()
            env.pop('XDG_DATA_HOME', None)
            with patch.dict(os.environ, env, clear=True):
                result = get_app_data_dir_linux()
                self.assertTrue(result.endswith('timetracker'))
                self.assertIn('.local/share', result)

    @unittest.skipUnless(sys.platform.startswith('linux'), "Linux only")
    def test_xdg_data_home_respected(self):
        from desktop_app_linux import get_app_data_dir_linux
        tmpdir = tempfile.mkdtemp()
        try:
            with patch.dict(os.environ, {'XDG_DATA_HOME': tmpdir}):
                result = get_app_data_dir_linux()
                self.assertEqual(result, os.path.join(tmpdir, 'timetracker'))
                self.assertTrue(os.path.isdir(result))
        finally:
            import shutil
            shutil.rmtree(tmpdir, ignore_errors=True)

    @unittest.skipUnless(sys.platform.startswith('linux'), "Linux only")
    def test_directory_created_automatically(self):
        from desktop_app_linux import get_app_data_dir_linux
        tmpdir = tempfile.mkdtemp()
        import shutil
        shutil.rmtree(tmpdir)  # Remove it so get_app_data_dir_linux creates it
        try:
            with patch.dict(os.environ, {'XDG_DATA_HOME': tmpdir}):
                result = get_app_data_dir_linux()
                self.assertTrue(os.path.isdir(result))
        finally:
            shutil.rmtree(tmpdir, ignore_errors=True)


class TestAutostart(unittest.TestCase):
    """Test XDG autostart .desktop file operations."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    @unittest.skipUnless(sys.platform.startswith('linux'), "Linux only")
    def test_add_to_startup_creates_desktop_file(self):
        from desktop_app_linux import add_to_startup_linux
        with patch.dict(os.environ, {'XDG_CONFIG_HOME': self.tmpdir}):
            result = add_to_startup_linux("TestApp", "/usr/bin/testapp")
            self.assertTrue(result)
            desktop_path = os.path.join(self.tmpdir, 'autostart', 'timetracker.desktop')
            self.assertTrue(os.path.isfile(desktop_path))

    @unittest.skipUnless(sys.platform.startswith('linux'), "Linux only")
    def test_desktop_file_content(self):
        from desktop_app_linux import add_to_startup_linux
        with patch.dict(os.environ, {'XDG_CONFIG_HOME': self.tmpdir}):
            add_to_startup_linux("TestApp", "/usr/bin/testapp")
            desktop_path = os.path.join(self.tmpdir, 'autostart', 'timetracker.desktop')
            with open(desktop_path, 'r') as f:
                content = f.read()
            self.assertIn('[Desktop Entry]', content)
            self.assertIn('Name=TestApp', content)
            self.assertIn('Exec=/usr/bin/testapp', content)
            self.assertIn('Type=Application', content)

    @unittest.skipUnless(sys.platform.startswith('linux'), "Linux only")
    def test_remove_from_startup(self):
        from desktop_app_linux import add_to_startup_linux, remove_from_startup_linux
        with patch.dict(os.environ, {'XDG_CONFIG_HOME': self.tmpdir}):
            add_to_startup_linux("TestApp", "/usr/bin/testapp")
            result = remove_from_startup_linux()
            self.assertTrue(result)
            desktop_path = os.path.join(self.tmpdir, 'autostart', 'timetracker.desktop')
            self.assertFalse(os.path.exists(desktop_path))

    @unittest.skipUnless(sys.platform.startswith('linux'), "Linux only")
    def test_is_in_startup(self):
        from desktop_app_linux import (
            add_to_startup_linux, is_in_startup_linux, remove_from_startup_linux
        )
        with patch.dict(os.environ, {'XDG_CONFIG_HOME': self.tmpdir}):
            self.assertFalse(is_in_startup_linux())
            add_to_startup_linux("TestApp", "/usr/bin/testapp")
            self.assertTrue(is_in_startup_linux())
            remove_from_startup_linux()
            self.assertFalse(is_in_startup_linux())


class TestActiveWindow(unittest.TestCase):
    """Test active window detection functions."""

    @unittest.skipUnless(sys.platform.startswith('linux'), "Linux only")
    def test_get_active_window_returns_dict(self):
        from desktop_app_linux import get_active_window_linux
        result = get_active_window_linux()
        self.assertIsInstance(result, dict)
        self.assertIn('title', result)
        self.assertIn('app', result)
        self.assertIn('window_key', result)
        self.assertIn('is_new_window', result)

    @unittest.skipUnless(sys.platform.startswith('linux'), "Linux only")
    def test_unknown_window_fallback(self):
        """If no display is available, should return unknown."""
        from desktop_app_linux import _unknown_window
        result = _unknown_window()
        self.assertEqual(result['title'], 'Unknown')
        self.assertEqual(result['app'], 'Unknown')
        self.assertEqual(result['window_key'], 'unknown')


class TestIdleDetection(unittest.TestCase):
    """Test idle time detection."""

    @unittest.skipUnless(sys.platform.startswith('linux'), "Linux only")
    def test_get_idle_time_returns_float(self):
        from desktop_app_linux import get_idle_time_linux
        result = get_idle_time_linux()
        self.assertIsInstance(result, float)
        self.assertGreaterEqual(result, 0.0)


class TestNotifications(unittest.TestCase):
    """Test Linux desktop notifications."""

    @unittest.skipUnless(sys.platform.startswith('linux'), "Linux only")
    def test_show_notification_with_notify_send(self):
        from desktop_app_linux import show_notification_linux
        import shutil
        if shutil.which('notify-send') is None:
            self.skipTest("notify-send not installed")
        # Should not raise
        result = show_notification_linux("Test", "Hello from test suite")
        self.assertTrue(result)

    @unittest.skipUnless(sys.platform.startswith('linux'), "Linux only")
    def test_show_notification_without_notify_send(self):
        from desktop_app_linux import show_notification_linux
        with patch('desktop_app_linux.shutil.which', return_value=None):
            result = show_notification_linux("Test", "No tool")
            self.assertFalse(result)


class TestScreenshotCapture(unittest.TestCase):
    """Test screenshot capture routing."""

    @unittest.skipUnless(sys.platform.startswith('linux'), "Linux only")
    def test_capture_screenshot_returns_image_or_raises(self):
        """Should return a PIL Image or raise RuntimeError if no tools available."""
        from desktop_app_linux import capture_screenshot_linux
        from PIL import Image
        try:
            result = capture_screenshot_linux()
            self.assertIsInstance(result, Image.Image)
        except RuntimeError as e:
            self.assertIn("No screenshot tool available", str(e))


if __name__ == '__main__':
    unittest.main()
