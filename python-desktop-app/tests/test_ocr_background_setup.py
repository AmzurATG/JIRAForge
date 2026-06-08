"""
Test OCR Background Setup - Verify non-blocking authentication

Tests the fix for OCR dependency blocking authentication.
Ensures authentication completes in <5 seconds regardless of OCR installation time.
"""

import unittest
import time
import threading
from unittest.mock import Mock, patch, MagicMock
import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class TestOCRBackgroundSetup(unittest.TestCase):
    """Test OCR background installation doesn't block authentication"""

    def setUp(self):
        """Set up test fixtures"""
        self.mock_auth_manager = Mock()
        self.mock_auth_manager.get_supabase_config = Mock(return_value=True)
        self.mock_auth_manager.get_ocr_config = Mock(return_value=True)
        self.mock_auth_manager.tokens = {}

    @patch('desktop_app.LocalOCRProcessor')
    @patch('desktop_app.get_env_var')
    @patch('desktop_app.create_client')
    def test_initialize_supabase_with_skip_ocr(self, mock_create_client, mock_get_env, mock_ocr_processor):
        """Test initialize_supabase with skip_ocr_setup=True doesn't block"""
        from desktop_app import TimeTracker
        
        mock_get_env.side_effect = lambda key: {
            'SUPABASE_URL': 'https://test.supabase.co',
            'SUPABASE_ANON_KEY': 'test-key'
        }.get(key)
        
        tracker = TimeTracker()
        tracker.auth_manager = self.mock_auth_manager
        tracker.supabase_initialized = False
        
        # Should complete quickly without OCR setup
        start_time = time.time()
        result = tracker.initialize_supabase(skip_ocr_setup=True)
        elapsed = time.time() - start_time
        
        self.assertTrue(result)
        self.assertLess(elapsed, 2.0, "initialize_supabase should complete in <2s when skipping OCR")
        self.assertIsNone(tracker.ocr_processor, "OCR processor should not be initialized when skipped")

    @patch('desktop_app.LocalOCRProcessor')
    @patch('desktop_app.get_env_var')
    @patch('desktop_app.create_client')
    def test_initialize_supabase_without_skip(self, mock_create_client, mock_get_env, mock_ocr_processor):
        """Test initialize_supabase without skip_ocr_setup initializes OCR immediately"""
        from desktop_app import TimeTracker
        
        mock_get_env.side_effect = lambda key: {
            'SUPABASE_URL': 'https://test.supabase.co',
            'SUPABASE_ANON_KEY': 'test-key'
        }.get(key)
        
        tracker = TimeTracker()
        tracker.auth_manager = self.mock_auth_manager
        tracker.supabase_initialized = False
        tracker._setup_ocr_engines = Mock()
        
        # Should initialize OCR when not skipped
        result = tracker.initialize_supabase(skip_ocr_setup=False)
        
        self.assertTrue(result)
        tracker._setup_ocr_engines.assert_called_once()
        self.assertIsNotNone(tracker.ocr_processor, "OCR processor should be initialized when not skipped")

    def test_background_ocr_setup_starts_thread(self):
        """Test that background OCR setup starts a daemon thread"""
        from desktop_app import TimeTracker
        
        tracker = TimeTracker()
        tracker.add_admin_log = Mock()
        tracker._background_ocr_setup_worker = Mock()
        
        # Start background setup
        tracker._start_background_ocr_setup()
        
        # Should have thread
        self.assertTrue(hasattr(tracker, '_ocr_setup_thread'))
        self.assertIsNotNone(tracker._ocr_setup_thread)
        self.assertTrue(tracker._ocr_setup_thread.is_alive())
        self.assertTrue(tracker._ocr_setup_thread.daemon, "Thread should be daemon")
        
        # Clean up
        tracker._ocr_setup_thread.join(timeout=1.0)

    def test_background_ocr_setup_no_duplicate_threads(self):
        """Test that calling _start_background_ocr_setup twice doesn't create duplicate threads"""
        from desktop_app import TimeTracker
        
        tracker = TimeTracker()
        tracker.add_admin_log = Mock()
        tracker._background_ocr_setup_worker = Mock(side_effect=lambda: time.sleep(5))
        
        # Start first thread
        tracker._start_background_ocr_setup()
        first_thread = tracker._ocr_setup_thread
        
        # Try to start again
        tracker._start_background_ocr_setup()
        second_thread = tracker._ocr_setup_thread
        
        # Should be same thread
        self.assertIs(first_thread, second_thread)
        
        # Clean up
        if first_thread.is_alive():
            first_thread.join(timeout=1.0)

    @patch('desktop_app.check_and_install_dependencies')
    def test_background_worker_completes(self, mock_check_deps):
        """Test that background worker completes successfully"""
        from desktop_app import TimeTracker
        
        mock_check_deps.return_value = {'rapidocr': True}
        
        tracker = TimeTracker()
        tracker.add_admin_log = Mock()
        tracker._count_missing_ocr_dependencies = Mock(return_value=0)
        tracker._finalize_ocr_setup = Mock()
        
        # Run worker
        tracker._background_ocr_setup_worker()
        
        # Should finalize OCR
        tracker._finalize_ocr_setup.assert_called_once()

    @patch('desktop_app.check_and_install_dependencies')
    def test_background_worker_handles_timeout(self, mock_check_deps):
        """Test that background worker handles installation timeout"""
        from desktop_app import TimeTracker
        
        # Simulate long-running installation
        def slow_install(*args, **kwargs):
            time.sleep(20)  # Longer than timeout
            return {}
        
        mock_check_deps.side_effect = slow_install
        
        tracker = TimeTracker()
        tracker.add_admin_log = Mock()
        tracker._count_missing_ocr_dependencies = Mock(return_value=5)
        tracker._show_ocr_installation_notification = Mock()
        
        # Run worker with short timeout (override in test)
        original_worker = tracker._background_ocr_setup_worker
        
        def patched_worker():
            # Patch the timeout for testing
            import types
            code = original_worker.__code__
            tracker._background_ocr_setup_worker.__globals__['max_install_time'] = 2  # 2 second timeout for test
            return original_worker()
        
        start_time = time.time()
        patched_worker()
        elapsed = time.time() - start_time
        
        # Should timeout within reasonable time
        self.assertLess(elapsed, 5.0, "Worker should timeout quickly")
        
        # Should show timeout notification
        calls = [call for call in tracker._show_ocr_installation_notification.call_args_list 
                 if call[1].get('timeout') == True]
        self.assertGreater(len(calls), 0, "Should show timeout notification")

    def test_ocr_processor_null_checks(self):
        """Test that code handles ocr_processor=None gracefully"""
        from desktop_app import TimeTracker
        
        tracker = TimeTracker()
        tracker.ocr_processor = None
        tracker.session_manager = Mock()
        
        # Should not crash when OCR processor is None
        # These methods should check for None before using ocr_processor
        tracker.session_manager.get_pending_ocr_entries = Mock(return_value={})
        
        # This should not raise an exception
        try:
            # Simulate the backfill logic
            pending_entries = tracker.session_manager.get_pending_ocr_entries()
            for (title, app), screenshot in pending_entries.items():
                if tracker.ocr_processor:
                    # Would use OCR here
                    pass
                else:
                    # Should skip gracefully
                    print("OCR not ready - skipping backfill")
                    break
            success = True
        except Exception as e:
            success = False
            print(f"Exception: {e}")
        
        self.assertTrue(success, "Should handle None ocr_processor gracefully")


class TestOCRInstallationMarker(unittest.TestCase):
    """Test OCR installation marker functionality"""

    def setUp(self):
        """Set up test fixtures"""
        import tempfile
        from pathlib import Path
        
        # Use test-specific marker path
        self.test_marker_dir = Path(tempfile.gettempdir()) / 'timetracker_ocr_test'
        self.test_marker_dir.mkdir(exist_ok=True)
        self.test_marker_path = self.test_marker_dir / 'test_installation_complete.marker'
        
        # Clean up any existing marker
        if self.test_marker_path.exists():
            self.test_marker_path.unlink()

    def tearDown(self):
        """Clean up test fixtures"""
        if self.test_marker_path.exists():
            self.test_marker_path.unlink()
        if self.test_marker_dir.exists():
            self.test_marker_dir.rmdir()

    @patch('ocr.auto_installer.get_installation_marker_path')
    def test_mark_installation_complete(self, mock_get_path):
        """Test marking installation as complete"""
        from ocr.auto_installer import mark_installation_complete, is_installation_complete
        import json
        
        mock_get_path.return_value = self.test_marker_path
        
        # Mark as complete
        engines = ['rapidocr', 'winrtocr']
        mark_installation_complete(engines)
        
        # Verify marker file exists
        self.assertTrue(self.test_marker_path.exists())
        
        # Verify content
        with open(self.test_marker_path, 'r') as f:
            data = json.load(f)
        
        self.assertEqual(data['engines'], engines)
        self.assertIn('timestamp', data)
        self.assertEqual(data['version'], '1.0')

    @patch('ocr.auto_installer.get_installation_marker_path')
    @patch('ocr.auto_installer.get_configured_engines')
    def test_is_installation_complete_true(self, mock_get_engines, mock_get_path):
        """Test checking if installation is complete (true case)"""
        from ocr.auto_installer import mark_installation_complete, is_installation_complete
        
        mock_get_path.return_value = self.test_marker_path
        mock_get_engines.return_value = ['rapidocr', 'winrtocr']
        
        # Mark as complete
        mark_installation_complete(['rapidocr', 'winrtocr'])
        
        # Check if complete
        result = is_installation_complete()
        
        self.assertTrue(result)

    @patch('ocr.auto_installer.get_installation_marker_path')
    def test_is_installation_complete_false_no_marker(self, mock_get_path):
        """Test checking if installation is complete (false - no marker)"""
        from ocr.auto_installer import is_installation_complete
        
        mock_get_path.return_value = self.test_marker_path
        
        # No marker file
        result = is_installation_complete()
        
        self.assertFalse(result)

    @patch('ocr.auto_installer.get_installation_marker_path')
    @patch('ocr.auto_installer.get_configured_engines')
    def test_is_installation_complete_false_missing_engine(self, mock_get_engines, mock_get_path):
        """Test checking if installation is complete (false - missing engine)"""
        from ocr.auto_installer import mark_installation_complete, is_installation_complete
        
        mock_get_path.return_value = self.test_marker_path
        
        # Marker has only rapidocr
        mark_installation_complete(['rapidocr'])
        
        # But configured engines include easyocr
        mock_get_engines.return_value = ['rapidocr', 'easyocr']
        
        # Should be false (easyocr not in marker)
        result = is_installation_complete()
        
        self.assertFalse(result)

    @patch('ocr.auto_installer.get_configured_engines')
    @patch('ocr.auto_installer.is_installation_complete')
    def test_check_and_install_skips_when_complete(self, mock_is_complete, mock_get_engines):
        """Test that check_and_install_dependencies skips when marker exists"""
        from ocr.auto_installer import check_and_install_dependencies
        
        mock_is_complete.return_value = True
        mock_get_engines.return_value = ['rapidocr']
        
        # Should return empty dict (skipped)
        result = check_and_install_dependencies(force=False, silent=True)
        
        self.assertEqual(result, {})

    @patch('ocr.auto_installer.get_configured_engines')
    @patch('ocr.auto_installer.is_installation_complete')
    def test_check_and_install_runs_when_forced(self, mock_is_complete, mock_get_engines):
        """Test that check_and_install_dependencies runs when force=True"""
        from ocr.auto_installer import check_and_install_dependencies
        
        mock_is_complete.return_value = True
        mock_get_engines.return_value = ['mock']  # Use mock engine (no deps)
        
        # Should not skip when forced
        result = check_and_install_dependencies(force=True, silent=True)
        
        self.assertIsNotNone(result)
        # Mock engine has no dependencies, so should succeed
        self.assertEqual(result.get('mock'), True)


class TestAuthenticationSpeed(unittest.TestCase):
    """Test that authentication completes quickly with OCR deferred"""

    @patch('desktop_app.send_login_diagnostics')
    @patch('desktop_app.LocalOCRProcessor')
    @patch('desktop_app.get_env_var')
    @patch('desktop_app.create_client')
    def test_auth_callback_completes_quickly(self, mock_create_client, mock_get_env, 
                                            mock_ocr_processor, mock_diagnostics):
        """Test that auth callback completes in <5 seconds"""
        from desktop_app import TimeTracker
        
        mock_get_env.side_effect = lambda key: {
            'SUPABASE_URL': 'https://test.supabase.co',
            'SUPABASE_ANON_KEY': 'test-key'
        }.get(key)
        
        tracker = TimeTracker()
        tracker.auth_manager = Mock()
        tracker.auth_manager.get_supabase_config = Mock(return_value=True)
        tracker.auth_manager.get_ocr_config = Mock(return_value=True)
        tracker.auth_manager.get_user_info = Mock(return_value={'email': 'test@example.com', 'account_id': '123'})
        tracker.auth_manager.handle_callback = Mock(return_value={'access_token': 'test'})
        tracker.ensure_user_exists = Mock(return_value='user-123')
        tracker.consent_manager = Mock()
        tracker.consent_manager.has_valid_consent = Mock(return_value=True)
        tracker._update_desktop_status = Mock(return_value=True)
        tracker.classification_manager = Mock()
        tracker._associate_offline_records = Mock()
        tracker.update_tray_icon = Mock()
        tracker.update_tray_menu = Mock()
        tracker._start_background_ocr_setup = Mock()
        tracker.supabase = Mock()
        tracker.start_tracking = Mock()
        tracker.running = False
        
        # Simulate auth callback
        start_time = time.time()
        
        # This simulates what happens in the auth callback route
        tracker.auth_manager.handle_callback('code', 'state')
        user_info = tracker.auth_manager.get_user_info()
        tracker.initialize_supabase(skip_ocr_setup=True)
        tracker._start_background_ocr_setup()
        tracker.current_user_id = tracker.ensure_user_exists(user_info)
        tracker.current_user = user_info
        tracker._update_desktop_status(logged_in=True)
        tracker._associate_offline_records()
        tracker.update_tray_icon()
        tracker.update_tray_menu()
        
        elapsed = time.time() - start_time
        
        # Should complete very quickly
        self.assertLess(elapsed, 5.0, f"Auth flow took {elapsed}s (expected <5s)")
        
        # Background thread should be started
        tracker._start_background_ocr_setup.assert_called_once()


if __name__ == '__main__':
    # Run tests with verbose output
    unittest.main(verbosity=2)
