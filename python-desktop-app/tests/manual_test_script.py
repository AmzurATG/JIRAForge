"""
Manual Test Script for Activity Monitor Fix
Quick validation steps to verify the fix works
"""

import time
from datetime import datetime


def print_header(title):
    """Print a formatted header"""
    print("\n" + "="*70)
    print(f"  {title}")
    print("="*70 + "\n")


def test_1_fresh_install():
    """Test 1: Fresh Install Scenario"""
    print_header("TEST 1: Fresh Install Scenario")
    
    print("📋 STEPS:")
    print("1. Stop TimeTracker if running")
    print("2. Delete all app data:")
    print("   - C:\\Users\\<username>\\AppData\\Local\\TimeTracker\\")
    print("3. Run TimeTracker.exe")
    print("4. Complete OAuth login")
    print("5. Check system tray icon")
    print()
    
    input("Complete the steps above, then press Enter...")
    
    print("\n❓ VERIFICATION:")
    response = input("Is the tray icon GREEN (not orange)? (y/n): ").strip().lower()
    
    if response == 'y':
        print("✅ PASS: Icon is green after fresh install")
        return True
    else:
        print("❌ FAIL: Icon is orange (stuck in idle)")
        return False


def test_2_no_restart_warnings():
    """Test 2: No Continuous Restart Warnings"""
    print_header("TEST 2: No Continuous Restart Warnings")
    
    print("📋 STEPS:")
    print("1. Open log file at:")
    print("   C:\\Users\\<username>\\AppData\\Local\\TimeTracker\\logs\\timetracker.log")
    print("2. Clear the file or note the current line count")
    print("3. Let the app run for 5 minutes")
    print("4. Check logs for 'Activity monitor thread is dead' warnings")
    print()
    
    input("Press Enter to start 5-minute timer...")
    
    print("\n⏳ Waiting 5 minutes...")
    for i in range(300):
        remaining = 300 - i
        mins = remaining // 60
        secs = remaining % 60
        print(f"\rTime remaining: {mins:02d}:{secs:02d}", end='')
        time.sleep(1)
    
    print("\n")
    
    print("\n❓ VERIFICATION:")
    print("Check the log file for:")
    print('  "[WARN] Activity monitor thread is dead — restarting"')
    print()
    
    response = input("How many times did this message appear? (enter number): ").strip()
    
    try:
        count = int(response)
        if count <= 1:
            print(f"✅ PASS: Only {count} restart(s) (acceptable)")
            return True
        else:
            print(f"❌ FAIL: {count} restarts (indicates bug)")
            return False
    except ValueError:
        print("⚠️  Invalid input")
        return False


def test_3_idle_timeout_resume():
    """Test 3: Idle Timeout and Resume"""
    print_header("TEST 3: Idle Timeout and Resume")
    
    print("📋 STEPS:")
    print("1. Ensure TimeTracker is running with green icon")
    print("2. Don't touch keyboard or mouse for 6 minutes")
    print("3. Icon should turn ORANGE")
    print("4. Move mouse")
    print("5. Icon should turn GREEN within 5 seconds")
    print()
    
    response = input("Start test? (y/n): ").strip().lower()
    if response != 'y':
        print("⏭️  Skipped")
        return None
    
    print("\n⏳ Phase 1: Going idle (6 minutes)")
    print("❗ DO NOT TOUCH KEYBOARD OR MOUSE!")
    print()
    
    for i in range(360):
        remaining = 360 - i
        mins = remaining // 60
        secs = remaining % 60
        print(f"\rTime remaining: {mins:02d}:{secs:02d}", end='')
        time.sleep(1)
    
    print("\n")
    
    print("\n❓ VERIFICATION (Phase 1):")
    response = input("Is the icon ORANGE now? (y/n): ").strip().lower()
    
    if response != 'y':
        print("❌ FAIL: Icon did not turn orange (idle detection broken)")
        return False
    
    print("\n⏳ Phase 2: Resuming from idle")
    print("✋ Move your mouse or press a key NOW!")
    print()
    
    input("Press Enter after you've moved the mouse...")
    
    print("\n❓ VERIFICATION (Phase 2):")
    response = input("Did icon turn GREEN within 5 seconds? (y/n): ").strip().lower()
    
    if response == 'y':
        print("✅ PASS: Idle timeout and resume work correctly")
        return True
    else:
        print("❌ FAIL: Icon did not resume to green (stuck in idle)")
        return False


def test_4_activity_tracking():
    """Test 4: Activity Tracking Works"""
    print_header("TEST 4: Activity Tracking Works")
    
    print("📋 STEPS:")
    print("1. Ensure TimeTracker is running with green icon")
    print("2. Use your computer normally for 15 minutes")
    print("3. Check logs for activity records")
    print()
    
    response = input("Have you been using the app for at least 15 minutes? (y/n): ").strip().lower()
    
    if response != 'y':
        print("⏭️  Come back after 15 minutes of use")
        return None
    
    print("\n❓ VERIFICATION:")
    print("Open log file and look for messages like:")
    print('  "Screenshot uploaded and saved to database"')
    print('  "Batch uploaded: X activity records"')
    print()
    
    response = input("Did you find activity tracking messages? (y/n): ").strip().lower()
    
    if response == 'y':
        print("✅ PASS: Activity is being tracked")
        return True
    else:
        print("❌ FAIL: No activity tracking (data loss)")
        return False


def test_5_long_running_session():
    """Test 5: Long-Running Session"""
    print_header("TEST 5: Long-Running Session (4+ Hours)")
    
    print("📋 STEPS:")
    print("1. Let TimeTracker run for at least 4 hours")
    print("2. Use computer normally during this time")
    print("3. Check logs periodically")
    print()
    
    print("⏰ This test requires 4+ hours")
    response = input("Has the app been running for 4+ hours? (y/n): ").strip().lower()
    
    if response != 'y':
        print("⏭️  Run this test later")
        return None
    
    print("\n❓ VERIFICATION:")
    print("Check logs for:")
    print('  1. No continuous "thread is dead" warnings')
    print('  2. Activity records still being uploaded')
    print('  3. No crashes or freezes')
    print()
    
    q1 = input("No continuous restart warnings? (y/n): ").strip().lower()
    q2 = input("Activity still being tracked? (y/n): ").strip().lower()
    q3 = input("No crashes or freezes? (y/n): ").strip().lower()
    
    if q1 == 'y' and q2 == 'y' and q3 == 'y':
        print("✅ PASS: Long-running session stable")
        return True
    else:
        print("❌ FAIL: Issues detected in long-running session")
        return False


def main():
    """Run all manual tests"""
    print("="*70)
    print("  Activity Monitor Fix - Manual Test Suite")
    print("="*70)
    print()
    print("This script will guide you through manual testing steps")
    print("to verify the activity monitor fix works correctly.")
    print()
    
    input("Press Enter to begin...")
    
    results = []
    
    # Run tests
    results.append(("Fresh Install", test_1_fresh_install()))
    results.append(("No Restart Warnings", test_2_no_restart_warnings()))
    results.append(("Idle Timeout/Resume", test_3_idle_timeout_resume()))
    results.append(("Activity Tracking", test_4_activity_tracking()))
    results.append(("Long-Running Session", test_5_long_running_session()))
    
    # Print summary
    print_header("TEST SUMMARY")
    
    passed = 0
    failed = 0
    skipped = 0
    
    for name, result in results:
        if result is True:
            print(f"✅ {name}: PASSED")
            passed += 1
        elif result is False:
            print(f"❌ {name}: FAILED")
            failed += 1
        else:
            print(f"⏭️  {name}: SKIPPED")
            skipped += 1
    
    print()
    print(f"Total: {len(results)} tests")
    print(f"Passed: {passed}")
    print(f"Failed: {failed}")
    print(f"Skipped: {skipped}")
    print()
    
    if failed == 0 and passed > 0:
        print("🎉 ALL TESTS PASSED! 🎉")
        print("\nThe activity monitor fix is working correctly.")
    elif failed > 0:
        print("⚠️  SOME TESTS FAILED")
        print("\nPlease review the failures and check the implementation.")
    else:
        print("ℹ️  No tests completed")
    
    print("\n" + "="*70)


if __name__ == '__main__':
    main()
