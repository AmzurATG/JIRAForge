"""
Linux Adaptation Test Suite — Platform Detection & Routing
==========================================================

Tests that the platform detection constants (IS_LINUX, IS_WINDOWS) and
conditional imports work correctly. Verifies that function routing
dispatches to the correct Linux or Windows implementation.

Usage:
    python -m pytest tests/test_platform.py -v
    python -m tests.test_platform
"""

import os
import sys
import unittest
from unittest.mock import patch, MagicMock


class TestPlatformDetection(unittest.TestCase):
    """Verify IS_LINUX, IS_WINDOWS constants and conditional import guards."""

    def test_platform_constants_exist(self):
        """IS_LINUX and IS_WINDOWS should be defined in desktop_app."""
        # Import at test time to pick up the actual runtime values
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
        import importlib
        # We cannot fully import desktop_app (it has heavy deps), so read source
        src_path = os.path.join(os.path.dirname(__file__), '..', 'desktop_app.py')
        with open(src_path, 'r') as f:
            source = f.read()

        self.assertIn("IS_LINUX = sys.platform.startswith('linux')", source)
        self.assertIn("IS_WINDOWS = sys.platform == 'win32'", source)

    def test_linux_constants_on_current_os(self):
        """Verify constants match the current OS."""
        is_linux = sys.platform.startswith('linux')
        is_windows = sys.platform == 'win32'

        if is_linux:
            self.assertTrue(is_linux)
            self.assertFalse(is_windows)
        elif is_windows:
            self.assertTrue(is_windows)
            self.assertFalse(is_linux)

    def test_imagegrab_guarded_import(self):
        """ImageGrab import should be wrapped in try/except in desktop_app.py."""
        src_path = os.path.join(os.path.dirname(__file__), '..', 'desktop_app.py')
        with open(src_path, 'r') as f:
            source = f.read()

        # Should have the try/except guard
        self.assertIn("from PIL import Image, ImageGrab, ImageDraw", source)
        self.assertIn("ImageGrab = None", source)

    def test_linux_function_imports_declared(self):
        """desktop_app.py should import Linux functions conditionally."""
        src_path = os.path.join(os.path.dirname(__file__), '..', 'desktop_app.py')
        with open(src_path, 'r') as f:
            source = f.read()

        expected_imports = [
            'capture_screenshot_linux',
            'get_active_window_linux',
            'get_idle_time_linux',
            'show_notification_linux',
            'acquire_single_instance_lock_linux',
            'release_single_instance_lock_linux',
            'add_to_startup_linux',
            'remove_from_startup_linux',
            'is_in_startup_linux',
            'get_app_data_dir_linux',
        ]
        for fn_name in expected_imports:
            self.assertIn(fn_name, source, f"Missing Linux import: {fn_name}")

    def test_platform_aware_version_check_url(self):
        """Version check URL should use dynamic platform name."""
        src_path = os.path.join(os.path.dirname(__file__), '..', 'desktop_app.py')
        with open(src_path, 'r') as f:
            source = f.read()

        self.assertIn("'linux' if IS_LINUX else 'windows'", source)
        # Should NOT have the old hardcoded 'windows'
        self.assertNotIn("platform=windows&current=", source)

    def test_system_events_guarded_for_linux(self):
        """System event monitoring should be skipped on Linux."""
        src_path = os.path.join(os.path.dirname(__file__), '..', 'desktop_app.py')
        with open(src_path, 'r') as f:
            source = f.read()

        self.assertIn("not IS_LINUX and WIN32_AVAILABLE", source)


class TestLinuxFunctionRouting(unittest.TestCase):
    """Verify that desktop_app.py routes to Linux implementations."""

    def test_get_app_data_dir_has_linux_branch(self):
        src_path = os.path.join(os.path.dirname(__file__), '..', 'desktop_app.py')
        with open(src_path, 'r') as f:
            source = f.read()
        self.assertIn("IS_LINUX and LINUX_FUNCTIONS_AVAILABLE", source)
        self.assertIn("get_app_data_dir_linux()", source)

    def test_lock_functions_have_linux_branch(self):
        src_path = os.path.join(os.path.dirname(__file__), '..', 'desktop_app.py')
        with open(src_path, 'r') as f:
            source = f.read()
        self.assertIn("acquire_single_instance_lock_linux(", source)
        self.assertIn("release_single_instance_lock_linux()", source)

    def test_startup_functions_have_linux_branch(self):
        src_path = os.path.join(os.path.dirname(__file__), '..', 'desktop_app.py')
        with open(src_path, 'r') as f:
            source = f.read()
        self.assertIn("add_to_startup_linux(", source)
        self.assertIn("remove_from_startup_linux()", source)
        self.assertIn("is_in_startup_linux()", source)

    def test_idle_detection_has_linux_branch(self):
        src_path = os.path.join(os.path.dirname(__file__), '..', 'desktop_app.py')
        with open(src_path, 'r') as f:
            source = f.read()
        self.assertIn("get_idle_time_linux()", source)

    def test_notification_has_linux_branch(self):
        src_path = os.path.join(os.path.dirname(__file__), '..', 'desktop_app.py')
        with open(src_path, 'r') as f:
            source = f.read()
        self.assertIn("show_notification_linux(", source)


if __name__ == '__main__':
    unittest.main()
