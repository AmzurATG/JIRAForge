"""
Tests for platform_hooks and the monitor_capture provider seam.

Spec: linux-desktop-app/plan/2026-09-29_linux-desktop-app_phase1-foundation.md (AC 1-3)
"""

import os
import sys
import unittest
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import platform_hooks
import monitor_capture


class _FakeProvider:
    def __init__(self, image=None, raises=None):
        self.image = image
        self.raises = raises
        self.calls = 0

    def capture_focused_monitor(self):
        self.calls += 1
        if self.raises:
            raise self.raises
        return self.image

    def get_capture_status(self):
        return {'status': 'ok'}


class TestRegistry(unittest.TestCase):
    """AC 1: register / get / clear."""

    def tearDown(self):
        platform_hooks.clear()

    def test_no_provider_by_default(self):
        platform_hooks.clear()
        self.assertIsNone(platform_hooks.get())

    def test_register_and_get(self):
        provider = _FakeProvider()
        platform_hooks.register(provider)
        self.assertIs(platform_hooks.get(), provider)

    def test_clear(self):
        platform_hooks.register(_FakeProvider())
        platform_hooks.clear()
        self.assertIsNone(platform_hooks.get())


class TestCaptureDelegation(unittest.TestCase):
    """AC 2: a registered provider owns capture."""

    def tearDown(self):
        platform_hooks.clear()

    def test_returns_provider_image(self):
        image = MagicMock()
        provider = _FakeProvider(image=image)
        platform_hooks.register(provider)
        self.assertIs(monitor_capture.capture_focused_monitor(), image)
        self.assertEqual(provider.calls, 1)

    def test_provider_none_is_returned(self):
        platform_hooks.register(_FakeProvider(image=None))
        self.assertIsNone(monitor_capture.capture_focused_monitor())

    def test_provider_exception_becomes_none(self):
        platform_hooks.register(_FakeProvider(raises=RuntimeError('boom')))
        self.assertIsNone(monitor_capture.capture_focused_monitor())

    def test_get_capture_status_from_provider(self):
        platform_hooks.register(_FakeProvider())
        self.assertEqual(monitor_capture.get_capture_status(), {'status': 'ok'})

    def test_get_capture_status_without_provider(self):
        platform_hooks.clear()
        self.assertIsNone(monitor_capture.get_capture_status())


class TestNonWindowsWithoutProvider(unittest.TestCase):
    """AC 3: no bare ImageGrab passthrough on non-Windows."""

    def setUp(self):
        platform_hooks.clear()

    @patch('monitor_capture._WIN32_AVAILABLE', False)
    @patch('monitor_capture.ImageGrab')
    def test_never_grabs_and_skips(self, mock_grab):
        before = monitor_capture.get_capture_stats()['tier3_skipped']
        result = monitor_capture.capture_focused_monitor()
        self.assertIsNone(result)
        mock_grab.grab.assert_not_called()
        self.assertEqual(monitor_capture.get_capture_stats()['tier3_skipped'], before + 1)


if __name__ == '__main__':
    unittest.main()
