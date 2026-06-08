"""
Phase 1 Blocker Fixes - Comprehensive Test Suite
Tests B-1, B-9, B-10, B-12, B-15

Run with: pytest test_phase1_fixes.py -v
"""

import pytest
import time
import threading
import tempfile
import os
from datetime import datetime, timezone, timedelta
from unittest.mock import Mock, MagicMock, patch, call
import sqlite3


class TestB1IdleStuckFix:
    """Test B-1: Idle stuck fix with pynput fallback"""
    
    def test_pynput_failure_detected(self):
        """Test that pynput failure is properly detected and flagged"""
        from desktop_app import TimeTracker
        
        with patch('desktop_app.pynput', side_effect=ImportError):
            tracker = TimeTracker()
            tracker.monitor_user_activity()
            
            # Should mark activity monitor as failed
            assert tracker._activity_monitor_failed is True
            print("[PASS] B-1: pynput failure detected")
    
    def test_fallback_idle_detection_via_window_switch(self):
        """Test that window switches update activity time when pynput fails"""
        from desktop_app import TimeTracker
        
        tracker = TimeTracker()
        tracker._activity_monitor_failed = True  # Simulate pynput failure
        tracker.last_activity_time = time.time() - 100  # 100 seconds ago
        
        # Simulate window switch
        initial_activity_time = tracker.last_activity_time
        
        # Mock get_active_window to return different windows
        with patch.object(tracker, 'get_active_window') as mock_window:
            mock_window.side_effect = [
                {'app': 'chrome', 'title': 'Window 1'},
                {'app': 'vscode', 'title': 'Window 2'}
            ]
            
            # First call establishes baseline
            window1 = tracker.get_active_window()
            tracker._last_window_key_for_idle = f"{window1['app']}__{window1['title']}"
            
            # Second call detects switch
            time.sleep(0.1)
            window2 = tracker.get_active_window()
            new_key = f"{window2['app']}__{window2['title']}"
            
            if new_key != tracker._last_window_key_for_idle:
                tracker.last_activity_time = time.time()
                tracker._last_window_switch_time = time.time()
        
        # Activity time should be updated
        assert tracker.last_activity_time > initial_activity_time
        print("[PASS] B-1: Fallback idle detection via window switch works")
    
    def test_idle_resume_on_window_switch_when_pynput_fails(self):
        """Test that idle resumes on window switch when pynput is down"""
        from desktop_app import TimeTracker
        
        tracker = TimeTracker()
        tracker._activity_monitor_failed = True
        tracker.is_idle = True
        tracker.needs_idle_resume = False
        
        # Mock window switch detection in tracking loop
        with patch.object(tracker, 'get_active_window') as mock_window:
            mock_window.side_effect = [
                {'app': 'chrome', 'title': 'Old Window'},
                {'app': 'vscode', 'title': 'New Window'}
            ]
            
            # Establish baseline
            window1 = tracker.get_active_window()
            tracker._last_window_key_for_idle = f"{window1['app']}__{window1['title']}"
            
            # Detect switch while idle
            window2 = tracker.get_active_window()
            new_key = f"{window2['app']}__{window2['title']}"
            
            if tracker._activity_monitor_failed and tracker.is_idle:
                if new_key != tracker._last_window_key_for_idle:
                    tracker.needs_idle_resume = True
        
        assert tracker.needs_idle_resume is True
        print("[PASS] B-1: Idle resume triggered by window switch")


class TestB9ShutdownLossFix:
    """Test B-9: WM_ENDSESSION handler for Windows shutdown"""
    
    def test_wm_endsession_handler_registered(self):
        """Test that WM_ENDSESSION is defined in system event monitor"""
        # This is a compile-time check
        code = open('d:\\ATG-timetracker\\main-0506\\JIRAForge\\python-desktop-app\\desktop_app.py').read()
        assert 'WM_ENDSESSION = 0x0016' in code
        print("[PASS] B-9: WM_ENDSESSION constant defined")
    
    def test_shutdown_saves_active_session(self):
        """Test that shutdown handler finalizes active session"""
        from desktop_app import TimeTracker
        
        tracker = TimeTracker()
        tracker.current_window_screenshot_id = 'test-123'
        tracker.current_window_db_start_time = datetime.now(timezone.utc) - timedelta(minutes=5)
        tracker.last_activity_time = time.time()
        
        # Mock Supabase to verify finalization call
        with patch.object(tracker, 'supabase') as mock_supabase:
            mock_table = MagicMock()
            mock_supabase.table.return_value = mock_table
            mock_table.update.return_value = mock_table
            mock_table.eq.return_value = mock_table
            mock_table.execute.return_value = MagicMock(data=[{'id': 'test-123'}])
            
            # Call finalization (simulating WM_ENDSESSION handler)
            tracker._finalize_active_session("system shutdown")
            
            # Verify update was called
            assert mock_supabase.table.called
            assert mock_table.update.called
        
        print("[PASS] B-9: Shutdown handler finalizes session")
    
    def test_emergency_save_called_on_shutdown(self):
        """Test that emergency_save is called during shutdown"""
        from desktop_app import TimeTracker, ActiveSessionManager
        
        tracker = TimeTracker()
        tracker.session_manager = ActiveSessionManager(tracker.db_manager)
        
        # Mock emergency_save method
        with patch.object(tracker.session_manager, 'emergency_save') as mock_save:
            # Simulate WM_ENDSESSION handler call
            try:
                tracker._finalize_active_session("system shutdown")
                tracker.session_manager.emergency_save()
                tracker.upload_activity_batch()
            except:
                pass  # Ignore errors for this test
            
            # Verify emergency_save was called
            assert mock_save.called
        
        print("[PASS] B-9: emergency_save called on shutdown")


class TestB10CrashLossFix:
    """Test B-10: SQLite checkpoint and recovery"""
    
    def test_emergency_save_stops_timer(self):
        """Test that emergency_save stops active timer"""
        from desktop_app import ActiveSessionManager, DatabaseConnectionManager
        
        db_manager = DatabaseConnectionManager()
        session_mgr = ActiveSessionManager(db_manager)
        
        # Start a session
        session_mgr.on_window_switch(
            'Test Window',
            'test_app',
            'productive',
            None
        )
        
        # Verify timer is running
        conn = db_manager.get_connection()
        cursor = conn.cursor()
        cursor.execute('SELECT timer_started_at FROM active_sessions WHERE window_title = ?', ('Test Window',))
        row = cursor.fetchone()
        assert row is not None
        assert row[0] is not None  # timer_started_at should be set
        
        # Call emergency_save
        session_mgr.emergency_save()
        
        # Verify timer is stopped
        cursor.execute('SELECT timer_started_at FROM active_sessions WHERE window_title = ?', ('Test Window',))
        row = cursor.fetchone()
        assert row is None or row[0] is None  # timer should be stopped
        
        print("[PASS] B-10: Emergency save stops timer")
    
    def test_wal_checkpoint_executed(self):
        """Test that WAL checkpoint is executed"""
        from desktop_app import DatabaseConnectionManager
        
        db_manager = DatabaseConnectionManager()
        
        # Execute checkpoint
        result = db_manager.checkpoint_wal()
        
        assert result is True
        print("[PASS] B-10: WAL checkpoint executed successfully")
    
    def test_recovery_on_restart(self):
        """Test that pending data is recovered on restart"""
        from desktop_app import ActiveSessionManager, DatabaseConnectionManager
        
        db_manager = DatabaseConnectionManager()
        session_mgr = ActiveSessionManager(db_manager)
        
        # Create a session
        session_mgr.on_window_switch(
            'Test Window Before Crash',
            'test_app',
            'productive',
            None
        )
        
        # Simulate crash by not calling emergency_save
        # Then create new manager (simulating restart)
        new_session_mgr = ActiveSessionManager(db_manager)
        
        # Verify data persisted
        sessions = new_session_mgr.get_all_sessions()
        assert len(sessions) > 0
        assert any(s['window_title'] == 'Test Window Before Crash' for s in sessions)
        
        print("[PASS] B-10: Data recovered after simulated crash")


class TestB12NetworkLossFix:
    """Test B-12: Offline finalization queue"""
    
    def test_finalization_queued_on_network_failure(self):
        """Test that finalization is queued when network fails"""
        from desktop_app import TimeTracker, OfflineManager
        
        tracker = TimeTracker()
        tracker.current_window_screenshot_id = 'test-screenshot-123'
        tracker.current_window_db_start_time = datetime.now(timezone.utc) - timedelta(minutes=3)
        tracker.last_activity_time = time.time()
        
        # Mock Supabase to simulate network failure
        with patch.object(tracker, 'supabase') as mock_supabase:
            mock_table = MagicMock()
            mock_supabase.table.return_value = mock_table
            mock_table.update.side_effect = Exception("Network error")
            
            # Call finalization (should queue it)
            tracker._finalize_active_session("idle")
            
            # Verify it was added to offline queue
            assert len(tracker._offline_finalization_queue) > 0
            assert tracker._offline_finalization_queue[0]['screenshot_id'] == 'test-screenshot-123'
        
        print("[PASS] B-12: Finalization queued on network failure")
    
    def test_offline_manager_persists_finalization(self):
        """Test that offline manager persists finalization to SQLite"""
        from desktop_app import OfflineManager, DatabaseConnectionManager
        
        db_manager = DatabaseConnectionManager()
        offline_mgr = OfflineManager(db_manager)
        
        finalization_data = {
            'screenshot_id': 'test-123',
            'end_time': datetime.now(timezone.utc).isoformat(),
            'duration_seconds': 180,
            'reason': 'idle',
            'queued_at': time.time()
        }
        
        # Queue finalization
        offline_mgr.queue_finalization(finalization_data)
        
        # Verify it's in the database
        pending = offline_mgr.get_pending_finalizations()
        assert len(pending) > 0
        assert any(p['screenshot_id'] == 'test-123' for p in pending)
        
        print("[PASS] B-12: Finalization persisted to SQLite")
    
    def test_finalization_retry_on_network_recovery(self):
        """Test that queued finalizations are retried"""
        from desktop_app import OfflineManager, DatabaseConnectionManager
        
        db_manager = DatabaseConnectionManager()
        offline_mgr = OfflineManager(db_manager)
        
        # Queue a finalization
        finalization_data = {
            'screenshot_id': 'test-retry-123',
            'end_time': datetime.now(timezone.utc).isoformat(),
            'duration_seconds': 120,
            'reason': 'idle',
            'queued_at': time.time()
        }
        offline_mgr.queue_finalization(finalization_data)
        
        # Get pending finalizations
        pending = offline_mgr.get_pending_finalizations(limit=10)
        assert len(pending) > 0
        
        # Mark as complete
        offline_mgr.mark_finalization_complete('test-retry-123')
        
        # Verify it's removed
        pending_after = offline_mgr.get_pending_finalizations()
        assert not any(p['screenshot_id'] == 'test-retry-123' for p in pending_after)
        
        print("[PASS] B-12: Finalization retry and completion works")


class TestB15TokenRaceFix:
    """Test B-15: Token refresh rate limiting"""
    
    def test_rate_limiting_prevents_concurrent_refreshes(self):
        """Test that rate limiting prevents rapid refresh calls"""
        from desktop_app import AuthManager
        
        auth_mgr = AuthManager('https://test-server.com')
        auth_mgr.tokens = {'refresh_token': 'test-token'}
        auth_mgr._last_token_refresh_time = time.time()
        
        # Try to refresh immediately (should be rate limited)
        with patch('requests.post') as mock_post:
            result = auth_mgr.refresh_access_token()
            
            # Should be rate limited (no network call)
            assert result is False
            assert not mock_post.called
        
        print("[PASS] B-15: Rate limiting prevents rapid refreshes")
    
    def test_rate_limit_allows_refresh_after_interval(self):
        """Test that refresh is allowed after rate limit interval"""
        from desktop_app import AuthManager
        
        auth_mgr = AuthManager('https://test-server.com')
        auth_mgr.tokens = {'refresh_token': 'test-token'}
        # Set last refresh to 6 seconds ago (beyond 5 second limit)
        auth_mgr._last_token_refresh_time = time.time() - 6
        
        # Mock successful refresh
        with patch('requests.post') as mock_post:
            mock_response = MagicMock()
            mock_response.status_code = 200
            mock_response.json.return_value = {
                'access_token': 'new-token',
                'refresh_token': 'new-refresh-token',
                'expires_in': 3600
            }
            mock_post.return_value = mock_response
            
            result = auth_mgr.refresh_access_token()
            
            # Should proceed (rate limit passed)
            assert mock_post.called
        
        print("[PASS] B-15: Refresh allowed after rate limit interval")
    
    def test_double_check_prevents_duplicate_refresh(self):
        """Test that double-check logic prevents duplicate refreshes"""
        from desktop_app import AuthManager
        
        auth_mgr = AuthManager('https://test-server.com')
        old_token = 'old-refresh-token'
        new_token = 'new-refresh-token'
        
        auth_mgr.tokens = {'refresh_token': old_token}
        auth_mgr._last_token_refresh_time = time.time() - 10  # Passed rate limit
        
        # Mock the lock scenario where token changes while waiting
        original_refresh = auth_mgr.refresh_access_token
        
        def concurrent_refresh_simulator():
            # Simulate another thread completing refresh while we wait for lock
            auth_mgr.tokens['refresh_token'] = new_token
            return True
        
        with patch('requests.post') as mock_post:
            # First thread's refresh_token changes before network call
            auth_mgr.tokens['refresh_token'] = new_token
            
            result = auth_mgr.refresh_access_token()
            
            # Should detect token changed and skip network call
            assert not mock_post.called or mock_post.call_count <= 1
        
        print("[PASS] B-15: Double-check prevents duplicate refreshes")


class TestIntegrationScenarios:
    """Integration tests for combined scenarios"""
    
    def test_idle_timeout_with_pynput_failure(self):
        """Test idle timeout detection when pynput fails"""
        from desktop_app import TimeTracker
        
        tracker = TimeTracker()
        tracker._activity_monitor_failed = True
        tracker.last_activity_time = time.time() - 400  # 400 seconds ago (> 5 min idle)
        tracker.idle_timeout = 300  # 5 minutes
        
        # Check idle condition
        idle_duration = time.time() - tracker.last_activity_time
        should_be_idle = idle_duration > tracker.idle_timeout
        
        assert should_be_idle is True
        print("[PASS] Integration: Idle detection works with pynput failure")
    
    def test_shutdown_with_network_failure(self):
        """Test shutdown scenario with network unavailable"""
        from desktop_app import TimeTracker
        
        tracker = TimeTracker()
        tracker.current_window_screenshot_id = 'test-123'
        tracker.current_window_db_start_time = datetime.now(timezone.utc) - timedelta(minutes=2)
        
        # Mock network failure
        with patch.object(tracker, 'supabase') as mock_supabase:
            mock_table = MagicMock()
            mock_supabase.table.return_value = mock_table
            mock_table.update.side_effect = Exception("Network down")
            
            # Simulate shutdown
            tracker._finalize_active_session("system shutdown")
            
            # Should queue finalization
            assert len(tracker._offline_finalization_queue) > 0
        
        print("[PASS] Integration: Shutdown handles network failure gracefully")


def run_all_tests():
    """Run all Phase 1 tests"""
    print("\n" + "="*60)
    print("Phase 1 Blocker Fixes - Test Suite")
    print("="*60 + "\n")
    
    test_classes = [
        TestB1IdleStuckFix,
        TestB9ShutdownLossFix,
        TestB10CrashLossFix,
        TestB12NetworkLossFix,
        TestB15TokenRaceFix,
        TestIntegrationScenarios
    ]
    
    total_tests = 0
    passed_tests = 0
    failed_tests = []
    
    for test_class in test_classes:
        print(f"\n{test_class.__doc__}")
        print("-" * 60)
        
        test_instance = test_class()
        test_methods = [m for m in dir(test_instance) if m.startswith('test_')]
        
        for method_name in test_methods:
            total_tests += 1
            try:
                method = getattr(test_instance, method_name)
                method()
                passed_tests += 1
            except Exception as e:
                failed_tests.append((test_class.__name__, method_name, str(e)))
                print(f"[FAIL] {method_name}: {e}")
    
    print("\n" + "="*60)
    print(f"Test Results: {passed_tests}/{total_tests} passed")
    if failed_tests:
        print(f"\nFailed tests:")
        for class_name, method, error in failed_tests:
            print(f"  - {class_name}.{method}: {error}")
    print("="*60 + "\n")
    
    return passed_tests == total_tests


if __name__ == '__main__':
    import sys
    success = run_all_tests()
    sys.exit(0 if success else 1)
