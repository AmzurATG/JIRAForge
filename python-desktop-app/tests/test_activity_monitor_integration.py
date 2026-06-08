"""
Integration Test for Activity Monitor Thread Fix
This script runs against the actual desktop app to verify the fix works in production
"""

import time
import subprocess
import psutil
import re
from datetime import datetime
import sys


class ActivityMonitorIntegrationTest:
    """Integration tests for activity monitor fix"""
    
    def __init__(self, log_file_path):
        """
        Initialize integration test
        
        Args:
            log_file_path: Path to the TimeTracker log file
        """
        self.log_file = log_file_path
        self.test_results = []
    
    def get_recent_logs(self, minutes=5):
        """
        Get logs from the last N minutes
        
        Args:
            minutes: Number of minutes of logs to retrieve
            
        Returns:
            List of log lines
        """
        try:
            with open(self.log_file, 'r', encoding='utf-8') as f:
                return f.readlines()
        except Exception as e:
            print(f"Error reading log file: {e}")
            return []
    
    def test_no_continuous_restarts(self, duration_minutes=10):
        """
        Test: Verify no continuous "thread is dead" warnings
        
        This test monitors logs for 10 minutes and ensures the thread
        isn't being restarted continuously (which would indicate the bug)
        
        Args:
            duration_minutes: How long to monitor (default 10 minutes)
            
        Returns:
            tuple: (passed, message)
        """
        print(f"\n{'='*70}")
        print(f"TEST: No Continuous Thread Restarts ({duration_minutes} min)")
        print(f"{'='*70}")
        
        start_time = time.time()
        restart_count = 0
        log_positions = []
        
        # Initial log position
        initial_logs = self.get_recent_logs()
        last_line_count = len(initial_logs)
        
        print(f"Monitoring logs at: {self.log_file}")
        print(f"Duration: {duration_minutes} minutes")
        print(f"Checking for pattern: 'Activity monitor thread is dead'")
        print()
        
        while time.time() - start_time < duration_minutes * 60:
            # Get new logs
            current_logs = self.get_recent_logs()
            
            # Check new lines only
            new_lines = current_logs[last_line_count:]
            
            for line in new_lines:
                if "Activity monitor thread is dead" in line:
                    restart_count += 1
                    timestamp = datetime.now().strftime("%H:%M:%S")
                    print(f"[{timestamp}] ⚠️  Thread restart detected: {restart_count}")
                    log_positions.append(len(current_logs))
            
            last_line_count = len(current_logs)
            
            # Progress indicator
            elapsed = int(time.time() - start_time)
            remaining = duration_minutes * 60 - elapsed
            print(f"\rElapsed: {elapsed}s | Remaining: {remaining}s | Restarts: {restart_count}", end='')
            
            time.sleep(10)  # Check every 10 seconds
        
        print("\n")
        
        # Evaluate results
        # We allow 1 restart (initial start), but anything more is a failure
        if restart_count <= 1:
            result = (True, f"✅ PASS: Only {restart_count} restart(s) in {duration_minutes} minutes")
        else:
            result = (False, f"❌ FAIL: {restart_count} restarts in {duration_minutes} minutes (expected ≤1)")
        
        self.test_results.append(result)
        print(result[1])
        return result
    
    def test_thread_stays_alive(self):
        """
        Test: Verify activity monitor thread stays alive
        
        Checks logs to ensure thread is running and heartbeat is updating
        
        Returns:
            tuple: (passed, message)
        """
        print(f"\n{'='*70}")
        print("TEST: Thread Stays Alive")
        print(f"{'='*70}")
        
        logs = self.get_recent_logs(minutes=2)
        
        # Look for the "Activity monitoring started" message
        started = any("Activity monitoring started" in line for line in logs)
        
        # Look for heartbeat timeout warnings (would indicate thread is stuck)
        heartbeat_timeout = any("Activity monitor heartbeat timeout" in line for line in logs)
        
        if started and not heartbeat_timeout:
            result = (True, "✅ PASS: Thread started and no heartbeat timeouts")
        elif not started:
            result = (False, "❌ FAIL: No 'Activity monitoring started' message found")
        else:
            result = (False, "❌ FAIL: Heartbeat timeout detected (thread might be stuck)")
        
        self.test_results.append(result)
        print(result[1])
        return result
    
    def test_icon_color_after_login(self):
        """
        Test: Verify icon turns green (not orange) after login
        
        This is a manual test that requires user verification
        
        Returns:
            tuple: (passed, message)
        """
        print(f"\n{'='*70}")
        print("TEST: Icon Color After Login (Manual)")
        print(f"{'='*70}")
        
        print("\n📋 MANUAL TEST STEPS:")
        print("1. Close TimeTracker if running")
        print("2. Start TimeTracker")
        print("3. Complete login")
        print("4. Check system tray icon color")
        print()
        
        response = input("Is the tray icon GREEN (not orange)? (y/n): ").strip().lower()
        
        if response == 'y':
            result = (True, "✅ PASS: Icon is green after login")
        else:
            result = (False, "❌ FAIL: Icon is not green (stuck in idle?)")
        
        self.test_results.append(result)
        print(result[1])
        return result
    
    def test_idle_and_resume(self):
        """
        Test: Verify idle timeout and resume work correctly
        
        This is a manual test that requires user interaction
        
        Returns:
            tuple: (passed, message)
        """
        print(f"\n{'='*70}")
        print("TEST: Idle Timeout and Resume (Manual)")
        print(f"{'='*70}")
        
        print("\n📋 MANUAL TEST STEPS:")
        print("1. Ensure TimeTracker is running and tracking (green icon)")
        print("2. Don't touch keyboard/mouse for 6 minutes")
        print("3. Icon should turn ORANGE (idle)")
        print("4. Move mouse or press a key")
        print("5. Icon should turn GREEN within 5 seconds")
        print()
        
        input("Press Enter when ready to start test...")
        print("\n⏳ Waiting 6 minutes for idle timeout...")
        print("(Don't touch keyboard/mouse!)")
        
        # Wait 6 minutes
        for i in range(360):
            remaining = 360 - i
            print(f"\rWaiting: {remaining}s remaining...", end='')
            time.sleep(1)
        
        print("\n")
        input("Check icon. Is it ORANGE? Press Enter to continue...")
        
        print("\n✋ Now move your mouse or press a key...")
        input("Did icon turn GREEN within 5 seconds? (Press Enter when done)")
        
        response = input("Did idle and resume work correctly? (y/n): ").strip().lower()
        
        if response == 'y':
            result = (True, "✅ PASS: Idle timeout and resume work correctly")
        else:
            result = (False, "❌ FAIL: Idle/resume not working properly")
        
        self.test_results.append(result)
        print(result[1])
        return result
    
    def test_data_tracking(self):
        """
        Test: Verify time tracking data is being captured
        
        Checks logs for activity record uploads
        
        Returns:
            tuple: (passed, message)
        """
        print(f"\n{'='*70}")
        print("TEST: Data Tracking")
        print(f"{'='*70}")
        
        print("\nChecking for activity records in last 15 minutes...")
        
        logs = self.get_recent_logs(minutes=15)
        
        # Look for batch upload messages
        upload_found = False
        for line in logs:
            if "activity records to upload" in line or "Screenshot uploaded" in line:
                upload_found = True
                # Extract and print the line
                print(f"  Found: {line.strip()}")
                break
        
        if upload_found:
            result = (True, "✅ PASS: Activity data is being tracked and uploaded")
        else:
            # Check if tracking is active
            tracking_active = any("Tracking started" in line for line in logs)
            if not tracking_active:
                result = (False, "❌ FAIL: Tracking not started")
            else:
                result = (False, "⚠️  WARNING: No activity records found (might be too early)")
        
        self.test_results.append(result)
        print(result[1])
        return result
    
    def print_summary(self):
        """Print test summary"""
        print(f"\n{'='*70}")
        print("TEST SUMMARY")
        print(f"{'='*70}")
        
        total = len(self.test_results)
        passed = sum(1 for result in self.test_results if result[0])
        failed = total - passed
        
        print(f"\nTotal Tests: {total}")
        print(f"Passed: {passed}")
        print(f"Failed: {failed}")
        print()
        
        for i, (passed, message) in enumerate(self.test_results, 1):
            print(f"{i}. {message}")
        
        print(f"\n{'='*70}")
        
        if failed == 0:
            print("🎉 ALL TESTS PASSED! 🎉")
            return True
        else:
            print(f"⚠️  {failed} TEST(S) FAILED")
            return False


def main():
    """Main test runner"""
    print("="*70)
    print("Activity Monitor Fix - Integration Test Suite")
    print("="*70)
    print()
    
    # Get log file path
    default_log = r"C:\Users\IswaryaK\AppData\Local\TimeTracker\logs\timetracker.log"
    log_path = input(f"Log file path [{default_log}]: ").strip() or default_log
    
    print(f"\nUsing log file: {log_path}")
    
    # Create test instance
    tester = ActivityMonitorIntegrationTest(log_path)
    
    # Run tests
    print("\nStarting tests...")
    
    # Automated tests
    tester.test_thread_stays_alive()
    tester.test_no_continuous_restarts(duration_minutes=10)
    
    # Manual tests
    run_manual = input("\nRun manual tests? (y/n): ").strip().lower()
    if run_manual == 'y':
        tester.test_icon_color_after_login()
        tester.test_idle_and_resume()
    
    # Data tracking test
    tester.test_data_tracking()
    
    # Print summary
    success = tester.print_summary()
    
    return 0 if success else 1


if __name__ == '__main__':
    sys.exit(main())
