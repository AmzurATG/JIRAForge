"""
Test Suite for Desktop App State Machine

Tests the thread-safe state machine that replaces the boolean is_idle flag.
These tests verify:
1. ACTIVE → IDLE transitions on sleep/lock
2. IDLE → ACTIVE transitions on wake/unlock
3. Idempotent state transitions (IDLE → IDLE rejected)
4. Thread safety (concurrent calls properly locked)
5. Session finalization on state changes

This file implements RED phase of TDD — tests will fail until TrackingState
enum and enter_idle()/resume_from_idle() methods are implemented.
"""

import pytest
from unittest.mock import Mock, patch, MagicMock
from datetime import datetime, timezone
import threading
import time

# This import will fail initially — expected (RED state)
# TrackingState enum and thread-safe methods don't exist yet
from desktop_app import TimeTracker, TrackingState


class TestStateTransitions:
    """Test basic state machine transitions."""
    
    def test_enter_idle_transitions_from_active(self):
        """AC1: State machine transitions ACTIVE → IDLE on sleep."""
        tracker = TimeTracker()
        tracker.state = TrackingState.ACTIVE
        tracker.current_window_screenshot_id = 'test-123'
        tracker.current_window_db_start_time = datetime.now(timezone.utc)
        tracker.last_activity_time = datetime.now(timezone.utc).timestamp()
        tracker.current_project_key = 'TEST-123'
        
        # Mock methods that would be called
        tracker._finalize_active_session = Mock()
        tracker.session_manager = Mock()
        tracker.update_tray_icon = Mock()
        
        result = tracker.enter_idle('system sleep')
        
        assert result is True, "Should return True when transitioning from ACTIVE"
        assert tracker.state == TrackingState.IDLE, "State should be IDLE"
        assert tracker.idle_start_time is not None, "idle_start_time should be set"
        assert tracker.idle_reason == 'system sleep', "idle_reason should be recorded"
        tracker._finalize_active_session.assert_called_once_with('system sleep')
        tracker.session_manager.stop_current_timer.assert_called_once()
        tracker.update_tray_icon.assert_called()
    
    def test_enter_idle_no_op_if_already_idle(self):
        """AC2: Idempotent — IDLE → IDLE is rejected without duplicating work."""
        tracker = TimeTracker()
        tracker.state = TrackingState.IDLE
        tracker.idle_start_time = datetime.now(timezone.utc)
        tracker.idle_reason = 'screen lock'
        
        # Mock methods — should NOT be called
        tracker._finalize_active_session = Mock()
        tracker.session_manager = Mock()
        
        result = tracker.enter_idle('system sleep')
        
        assert result is False, "Should return False when already IDLE"
        assert tracker.state == TrackingState.IDLE, "State should remain IDLE"
        assert tracker.idle_reason == 'screen lock', "Original idle reason preserved"
        tracker._finalize_active_session.assert_not_called()
        tracker.session_manager.stop_current_timer.assert_not_called()
    
    def test_resume_from_idle_resets_tracking_state(self):
        """AC3: Resume from idle resets all window tracking variables."""
        tracker = TimeTracker()
        tracker.state = TrackingState.IDLE
        tracker.idle_start_time = datetime.now(timezone.utc)
        tracker.idle_reason = 'system sleep'
        
        # Set values that should be cleared
        tracker.current_window_screenshot_id = 'old-123'
        tracker.current_window_db_start_time = datetime.now(timezone.utc)
        tracker.current_project_key = 'OLD-123'
        tracker.current_window_title = 'Old Window'
        
        # Mock methods
        tracker.session_manager = Mock()
        tracker.update_tray_icon = Mock()
        
        result = tracker.resume_from_idle()
        
        assert result is True, "Should return True when transitioning from IDLE"
        assert tracker.state == TrackingState.ACTIVE, "State should be ACTIVE"
        assert tracker.idle_start_time is None, "idle_start_time should be cleared"
        assert tracker.idle_reason is None, "idle_reason should be cleared"
        assert tracker.current_window_screenshot_id is None, "screenshot_id should be reset"
        assert tracker.current_window_db_start_time is None, "db_start_time should be reset"
        assert tracker.current_project_key is None, "project_key should be reset"
        assert tracker.current_window_title is None, "window_title should be reset"
        tracker.session_manager.start_new_timer.assert_called_once()
        tracker.update_tray_icon.assert_called()
    
    def test_resume_from_idle_no_op_if_already_active(self):
        """AC4: Idempotent — ACTIVE → ACTIVE is rejected without duplicating work."""
        tracker = TimeTracker()
        tracker.state = TrackingState.ACTIVE
        tracker.current_project_key = 'TEST-123'
        
        # Mock methods — should NOT be called
        tracker.session_manager = Mock()
        
        result = tracker.resume_from_idle()
        
        assert result is False, "Should return False when already ACTIVE"
        assert tracker.state == TrackingState.ACTIVE, "State should remain ACTIVE"
        assert tracker.current_project_key == 'TEST-123', "Tracking state preserved"
        tracker.session_manager.start_new_timer.assert_not_called()


class TestThreadSafety:
    """Test thread safety of state transitions."""
    
    def test_state_transitions_are_thread_safe(self):
        """AC5: Concurrent calls to enter_idle() use locking — only one succeeds."""
        tracker = TimeTracker()
        tracker.state = TrackingState.ACTIVE
        
        # Mock finalization to add delay
        tracker._finalize_active_session = Mock(side_effect=lambda reason: time.sleep(0.01))
        tracker.session_manager = Mock()
        tracker.update_tray_icon = Mock()
        
        results = []
        
        def call_enter_idle():
            result = tracker.enter_idle('concurrent test')
            results.append(result)
        
        # Launch 5 threads concurrently trying to enter idle
        threads = [threading.Thread(target=call_enter_idle) for _ in range(5)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        
        # Only ONE thread should successfully transition
        assert sum(results) == 1, f"Expected exactly 1 True result, got {sum(results)}"
        assert tracker.state == TrackingState.IDLE, "Final state should be IDLE"
        # _finalize_active_session should be called exactly once
        assert tracker._finalize_active_session.call_count == 1, \
            f"Expected 1 finalization call, got {tracker._finalize_active_session.call_count}"


class TestSessionFinalization:
    """Test session finalization during state transitions."""
    
    def test_enter_idle_finalizes_session(self):
        """AC6: Entering idle finalizes the active session with idle reason."""
        tracker = TimeTracker()
        tracker.state = TrackingState.ACTIVE
        tracker.current_window_screenshot_id = 'test-456'
        tracker.current_window_db_start_time = datetime.now(timezone.utc)
        tracker.last_activity_time = datetime.now(timezone.utc).timestamp()
        
        # Mock finalization
        tracker._finalize_active_session = Mock()
        tracker.session_manager = Mock()
        tracker.update_tray_icon = Mock()
        
        tracker.enter_idle('user lock screen')
        
        # Verify finalization was called with correct reason
        tracker._finalize_active_session.assert_called_once_with('user lock screen')
        # Verify timer was stopped
        tracker.session_manager.stop_current_timer.assert_called_once()
    
    def test_enter_idle_from_stopped_initializes_idle_state(self):
        """AC7: Entering idle from STOPPED state initializes idle tracking."""
        tracker = TimeTracker()
        tracker.state = TrackingState.STOPPED
        
        # Mock methods
        tracker._finalize_active_session = Mock()
        tracker.session_manager = Mock()
        tracker.update_tray_icon = Mock()
        
        result = tracker.enter_idle('system sleep')
        
        assert result is True, "Should allow STOPPED → IDLE transition"
        assert tracker.state == TrackingState.IDLE, "State should be IDLE"
        assert tracker.idle_start_time is not None, "idle_start_time should be set"
        # Should NOT finalize (nothing was active)
        tracker._finalize_active_session.assert_not_called()
        tracker.session_manager.stop_current_timer.assert_not_called()


class TestActiveSessionManagerStartNewTimer:
    """Regression tests for ActiveSessionManager.start_new_timer."""

    def test_start_new_timer_resets_current_key(self):
        """start_new_timer() must clear _current_key on a real instance.

        This guards against the AttributeError regression where the method
        was called by resume_from_idle() but never existed on the class.
        Tests that mock session_manager cannot catch this — only a test
        against the real class can.
        """
        from desktop_app import ActiveSessionManager
        from unittest.mock import MagicMock
        mgr = ActiveSessionManager(db_manager=MagicMock())
        mgr._current_key = ("some title", "some.exe")
        mgr.start_new_timer()
        assert mgr._current_key is None

    def test_start_new_timer_idempotent_when_already_none(self):
        """Calling start_new_timer() when _current_key is already None is a safe no-op."""
        from desktop_app import ActiveSessionManager
        from unittest.mock import MagicMock
        mgr = ActiveSessionManager(db_manager=MagicMock())
        mgr._current_key = None
        mgr.start_new_timer()  # must not raise
        assert mgr._current_key is None


class TestEdgeCases:
    """Test edge cases and error conditions."""
    
    def test_state_lock_exists(self):
        """Verify TimeTracker has a threading.Lock for state transitions."""
        tracker = TimeTracker()
        assert hasattr(tracker, 'state_lock'), "TimeTracker should have state_lock attribute"
        # threading.Lock() returns a lock object; check it has lock methods
        assert hasattr(tracker.state_lock, 'acquire'), "state_lock should have acquire method"
        assert hasattr(tracker.state_lock, 'release'), "state_lock should have release method"
        assert callable(tracker.state_lock.acquire), "acquire should be callable"
        assert callable(tracker.state_lock.release), "release should be callable"
    
    def test_tracking_state_enum_values(self):
        """Verify TrackingState enum has required values."""
        assert hasattr(TrackingState, 'STOPPED'), "TrackingState should have STOPPED"
        assert hasattr(TrackingState, 'ACTIVE'), "TrackingState should have ACTIVE"
        assert hasattr(TrackingState, 'IDLE'), "TrackingState should have IDLE"
        assert hasattr(TrackingState, 'PAUSED'), "TrackingState should have PAUSED"
    
    def test_idle_start_time_is_datetime(self):
        """Verify idle_start_time is stored as datetime object for compatibility with _create_idle_record."""
        tracker = TimeTracker()
        tracker.state = TrackingState.ACTIVE
        tracker._finalize_active_session = Mock()
        tracker.session_manager = Mock()
        tracker.update_tray_icon = Mock()
        
        tracker.enter_idle('test')
        
        assert isinstance(tracker.idle_start_time, datetime), \
            "idle_start_time should be datetime object"
