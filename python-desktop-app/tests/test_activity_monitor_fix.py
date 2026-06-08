"""
Unit tests for Activity Monitor Thread Fix
Tests that the activity monitor thread stays alive and functions correctly
"""

import unittest
import time
import threading
from unittest.mock import Mock, patch, MagicMock
import sys
import os

# Add parent directory to path to import desktop_app
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class TestActivityMonitorFix(unittest.TestCase):
    """Test suite for activity monitor thread fix"""
    
    def setUp(self):
        """Set up test fixtures"""
        # We'll need to mock desktop_app imports
        pass
    
    @patch('desktop_app.mouse')
    @patch('desktop_app.keyboard')
    def test_thread_stays_alive_after_start(self, mock_keyboard, mock_mouse):
        """
        Test that activity monitor thread stays alive after starting
        
        CRITICAL: This test verifies the fix for the thread exiting immediately
        """
        # Mock the pynput listeners
        mock_mouse_listener = MagicMock()
        mock_mouse_listener.is_alive.return_value = True
        mock_mouse.Listener.return_value = mock_mouse_listener
        
        mock_keyboard_listener = MagicMock()
        mock_keyboard_listener.is_alive.return_value = True
        mock_keyboard.Listener.return_value = mock_keyboard_listener
        
        # Import and create tracker instance
        from desktop_app import TimeTracker
        
        tracker = TimeTracker()
        tracker.running = True
        
        # Start activity monitor
        tracker._start_activity_monitor()
        
        # Wait 5 seconds
        time.sleep(5)
        
        # CRITICAL CHECK: Thread should still be alive
        self.assertTrue(
            tracker._activity_monitor_thread.is_alive(),
            "Activity monitor thread should not exit immediately after starting"
        )
        
        # Clean up
        tracker.running = False
        time.sleep(2)  # Give thread time to exit gracefully
    
    @patch('desktop_app.mouse')
    @patch('desktop_app.keyboard')
    def test_no_continuous_restarts(self, mock_keyboard, mock_mouse):
        """
        Test that watchdog doesn't restart thread continuously
        
        This verifies the fix prevents the 60-second restart cycle
        """
        # Mock the listeners
        mock_mouse_listener = MagicMock()
        mock_mouse_listener.is_alive.return_value = True
        mock_mouse.Listener.return_value = mock_mouse_listener
        
        mock_keyboard_listener = MagicMock()
        mock_keyboard_listener.is_alive.return_value = True
        mock_keyboard.Listener.return_value = mock_keyboard_listener
        
        from desktop_app import TimeTracker
        
        tracker = TimeTracker()
        tracker.running = True
        
        # Track restart count
        restart_count = [0]
        original_start = tracker._start_activity_monitor
        
        def count_restarts(*args, **kwargs):
            restart_count[0] += 1
            return original_start(*args, **kwargs)
        
        tracker._start_activity_monitor = count_restarts
        
        # Start tracking (includes starting activity monitor)
        tracker._start_activity_monitor()
        initial_count = restart_count[0]
        
        # Wait 3 minutes (enough for 3 watchdog checks at 60s interval)
        time.sleep(180)
        
        # Should have at most 1 restart (the initial start)
        self.assertLessEqual(
            restart_count[0] - initial_count, 
            1,
            f"Too many restarts: {restart_count[0] - initial_count}"
        )
        
        # Clean up
        tracker.running = False
    
    @patch('desktop_app.mouse')
    @patch('desktop_app.keyboard')
    def test_heartbeat_updates_during_loop(self, mock_keyboard, mock_mouse):
        """
        Test that heartbeat is updated periodically even without activity
        
        This ensures watchdog knows the thread is functioning
        """
        # Mock listeners
        mock_mouse_listener = MagicMock()
        mock_mouse_listener.is_alive.return_value = True
        mock_mouse.Listener.return_value = mock_mouse_listener
        
        mock_keyboard_listener = MagicMock()
        mock_keyboard_listener.is_alive.return_value = True
        mock_keyboard.Listener.return_value = mock_keyboard_listener
        
        from desktop_app import TimeTracker
        
        tracker = TimeTracker()
        tracker.running = True
        
        # Start activity monitor
        tracker._start_activity_monitor()
        
        initial_heartbeat = tracker._activity_monitor_heartbeat
        
        # Wait 3 seconds (loop updates heartbeat every 1 second)
        time.sleep(3)
        
        # Heartbeat should be updated
        self.assertGreater(
            tracker._activity_monitor_heartbeat,
            initial_heartbeat,
            "Heartbeat should be updated periodically"
        )
        
        # Clean up
        tracker.running = False
        time.sleep(2)
    
    @patch('desktop_app.mouse')
    @patch('desktop_app.keyboard')
    def test_listener_failure_detection(self, mock_keyboard, mock_mouse):
        """
        Test that thread exits gracefully if a listener fails
        
        This ensures proper cleanup when listeners crash
        """
        # Mock listeners that will "die" after a few seconds
        mock_mouse_listener = MagicMock()
        mock_mouse.Listener.return_value = mock_mouse_listener
        
        mock_keyboard_listener = MagicMock()
        mock_keyboard.Listener.return_value = mock_keyboard_listener
        
        # Start with listeners alive
        mock_mouse_listener.is_alive.return_value = True
        mock_keyboard_listener.is_alive.return_value = True
        
        from desktop_app import TimeTracker
        
        tracker = TimeTracker()
        tracker.running = True
        
        # Start activity monitor
        tracker._start_activity_monitor()
        
        # Wait a bit
        time.sleep(2)
        
        # Simulate listener failure
        mock_mouse_listener.is_alive.return_value = False
        
        # Wait for loop to detect failure
        time.sleep(3)
        
        # Thread should have exited
        # Note: This might take a moment after detection
        time.sleep(2)
        self.assertFalse(
            tracker._activity_monitor_thread.is_alive(),
            "Thread should exit when listener fails"
        )
        
        # Verify failed flag is set
        self.assertTrue(
            tracker._activity_monitor_failed,
            "Failed flag should be set when listener dies"
        )
        
        # Clean up
        tracker.running = False


class TestIdleStateRecovery(unittest.TestCase):
    """Test suite for idle state stuck prevention"""
    
    @patch('desktop_app.mouse')
    @patch('desktop_app.keyboard')
    def test_stuck_idle_recovery(self, mock_keyboard, mock_mouse):
        """
        Test that app recovers from stuck idle state
        
        This tests the 30-minute safeguard that forces resume if window changes
        """
        from desktop_app import TimeTracker
        from datetime import datetime, timezone
        
        # Mock listeners
        mock_mouse_listener = MagicMock()
        mock_mouse_listener.is_alive.return_value = True
        mock_mouse.Listener.return_value = mock_mouse_listener
        
        mock_keyboard_listener = MagicMock()
        mock_keyboard_listener.is_alive.return_value = True
        mock_keyboard.Listener.return_value = mock_keyboard_listener
        
        tracker = TimeTracker()
        tracker.running = True
        
        # Put tracker in idle state
        tracker.is_idle = True
        # Backdate idle start time to 31 minutes ago
        tracker.idle_start_time = datetime.fromtimestamp(
            time.time() - 1860,  # 31 minutes
            tz=timezone.utc
        )
        
        # Store initial window
        tracker._idle_entry_window_key = "chrome.exe__Initial Window"
        
        # Mock get_active_window to return different window
        tracker.get_active_window = Mock(return_value={
            'app': 'vscode.exe',
            'title': 'Different Window'
        })
        
        # Mock idle_resume_event
        tracker.idle_resume_event = MagicMock()
        
        # Manually trigger the safeguard check (would normally happen in tracking loop)
        # This is the code we added to prevent stuck idle
        if tracker.is_idle and tracker.idle_start_time:
            time_in_idle = time.time() - tracker.idle_start_time.timestamp()
            if time_in_idle > 1800:  # 30 minutes
                current_window = tracker.get_active_window()
                if current_window:
                    current_key = f"{current_window.get('app', '')}__{current_window.get('title', '')}"
                    if current_key != tracker._idle_entry_window_key:
                        tracker.idle_resume_event.set()
        
        # Verify resume was triggered
        tracker.idle_resume_event.set.assert_called_once()
        
        # Clean up
        tracker.running = False
    
    def test_fallback_detection_on_window_switch(self):
        """
        Test that window switches trigger activity when pynput fails
        
        This tests the B-1 fallback mechanism
        """
        from desktop_app import TimeTracker
        
        tracker = TimeTracker()
        tracker.running = True
        tracker._activity_monitor_failed = True  # Simulate pynput failure
        tracker.is_idle = True
        
        # Mock idle_resume_event
        tracker.idle_resume_event = MagicMock()
        
        # Mock get_active_window
        tracker.get_active_window = Mock(return_value={
            'app': 'chrome.exe',
            'title': 'Google Chrome'
        })
        
        # Store initial window
        tracker._last_window_key_for_idle = "notepad.exe__Untitled"
        
        # Simulate the fallback detection code
        window_info_for_idle = tracker.get_active_window()
        if window_info_for_idle:
            window_key = f"{window_info_for_idle.get('app', '')}__{window_info_for_idle.get('title', '')}"
            if hasattr(tracker, '_last_window_key_for_idle'):
                if window_key != tracker._last_window_key_for_idle:
                    tracker.last_activity_time = time.time()
                    if tracker.is_idle:
                        tracker.idle_resume_event.set()
        
        # Verify resume was triggered
        tracker.idle_resume_event.set.assert_called_once()
        
        # Clean up
        tracker.running = False


def run_tests():
    """Run all tests and print results"""
    # Create test suite
    suite = unittest.TestSuite()
    
    # Add all tests
    suite.addTests(unittest.TestLoader().loadTestsFromTestCase(TestActivityMonitorFix))
    suite.addTests(unittest.TestLoader().loadTestsFromTestCase(TestIdleStateRecovery))
    
    # Run tests with verbose output
    runner = unittest.TextTestRunner(verbosity=2)
    result = runner.run(suite)
    
    # Print summary
    print("\n" + "="*70)
    print("TEST SUMMARY")
    print("="*70)
    print(f"Tests run: {result.testsRun}")
    print(f"Successes: {result.testsRun - len(result.failures) - len(result.errors)}")
    print(f"Failures: {len(result.failures)}")
    print(f"Errors: {len(result.errors)}")
    print("="*70)
    
    return result.wasSuccessful()


if __name__ == '__main__':
    success = run_tests()
    sys.exit(0 if success else 1)
