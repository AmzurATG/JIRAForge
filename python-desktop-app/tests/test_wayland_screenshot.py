"""
Tests for wayland_screenshot.py — Wayland ScreenCast Portal screenshot capture.

These tests verify the module structure, fallback logic, and token management
without requiring an actual Wayland session (mocks D-Bus / GStreamer).
"""

import os
import sys
import json
import tempfile
import unittest
from unittest.mock import patch, MagicMock

# Ensure the parent package is importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))


class TestWaylandModuleImport(unittest.TestCase):
    """Verify the wayland_screenshot module can be imported."""

    def test_module_importable(self):
        """Module should import without error even when GI is unavailable."""
        import wayland_screenshot
        self.assertTrue(hasattr(wayland_screenshot, 'capture_screenshot'))
        self.assertTrue(hasattr(wayland_screenshot, 'reset_session'))

    def test_public_functions_callable(self):
        """Public functions should be callable."""
        import wayland_screenshot as ws
        self.assertTrue(callable(ws.capture_screenshot))
        self.assertTrue(callable(ws.reset_session))

    def test_session_state_exists(self):
        """Module-level _session dict should exist with expected keys."""
        import wayland_screenshot as ws
        self.assertIn('initialized', ws._session)
        self.assertIn('pipewire_fd', ws._session)
        self.assertIn('restore_token', ws._session)
        self.assertIn('lock', ws._session)


class TestRestoreToken(unittest.TestCase):
    """Test ScreenCast Portal restore-token persistence."""

    def setUp(self):
        self.tmpdir = tempfile.mkdtemp()
        self.token_file = os.path.join(self.tmpdir, '.screencast_token')

    def tearDown(self):
        import shutil
        shutil.rmtree(self.tmpdir, ignore_errors=True)

    def test_save_and_load_token(self):
        """Restore token should be persisted to disk and reloaded."""
        import wayland_screenshot as ws

        # Patch the token path and dir
        with patch.object(ws, '_TOKEN_FILE', self.token_file), \
             patch.object(ws, '_TOKEN_DIR', self.tmpdir):
            ws._save_restore_token('test-token-abc123')
            self.assertTrue(os.path.isfile(self.token_file))

            with open(self.token_file) as f:
                data = json.load(f)
            self.assertEqual(data.get('token'), 'test-token-abc123')

            loaded = ws._load_restore_token()
            self.assertEqual(loaded, 'test-token-abc123')

    def test_load_missing_token_returns_none(self):
        """Loading when no token file exists should return None."""
        import wayland_screenshot as ws
        with patch.object(ws, '_TOKEN_FILE', os.path.join(self.tmpdir, 'nonexistent')):
            result = ws._load_restore_token()
            self.assertIsNone(result)

    def test_load_corrupt_token_returns_none(self):
        """Loading a corrupt token file should return None gracefully."""
        import wayland_screenshot as ws
        with open(self.token_file, 'w') as f:
            f.write('not-json!!')
        with patch.object(ws, '_TOKEN_FILE', self.token_file):
            result = ws._load_restore_token()
            self.assertIsNone(result)


class TestCaptureScreenshotFallback(unittest.TestCase):
    """Test that capture_screenshot handles errors gracefully."""

    def test_returns_none_on_init_failure(self):
        """When portal init fails, capture should return None."""
        import wayland_screenshot as ws

        original_init = ws._session['initialized']
        ws._session['initialized'] = False
        try:
            with patch.object(ws, '_init_screencast_session', side_effect=RuntimeError('No portal')):
                result = ws.capture_screenshot()
                self.assertIsNone(result)
        finally:
            ws._session['initialized'] = original_init

    def test_returns_none_on_capture_failure(self):
        """When frame capture fails, it should return None and reset session."""
        import wayland_screenshot as ws

        ws._session['initialized'] = True
        try:
            with patch.object(ws, '_capture_frame', side_effect=RuntimeError('Pipeline failure')):
                result = ws.capture_screenshot()
                self.assertIsNone(result)
                # Session should be reset
                self.assertFalse(ws._session['initialized'])
        finally:
            ws._session['initialized'] = False


class TestResetSession(unittest.TestCase):
    """Test the reset_session function."""

    def test_reset_clears_state(self):
        """reset_session should clear all session state."""
        import wayland_screenshot as ws
        ws._session['initialized'] = True
        ws._session['pipewire_fd'] = 42
        ws._session['pipewire_node_id'] = 99
        ws._session['session_handle'] = '/org/test'

        ws.reset_session()

        self.assertFalse(ws._session['initialized'])
        self.assertIsNone(ws._session['pipewire_fd'])
        self.assertIsNone(ws._session['pipewire_node_id'])
        self.assertIsNone(ws._session['session_handle'])


class TestGIImportGuard(unittest.TestCase):
    """Test that GI imports are properly guarded."""

    def test_gi_available_flag_exists(self):
        """_GI_AVAILABLE should be defined."""
        import wayland_screenshot as ws
        self.assertIsInstance(ws._GI_AVAILABLE, bool)

    def test_ensure_gi_callable(self):
        """_ensure_gi() should be callable."""
        import wayland_screenshot as ws
        self.assertTrue(callable(ws._ensure_gi))


if __name__ == '__main__':
    unittest.main()
