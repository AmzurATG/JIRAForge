#!/usr/bin/env python3
"""
ScreenCast Test Suite Runner
Runs all tests and reports results
"""

import subprocess
import sys
import time

def run_test(test_name, test_file, auto_input=None):
    """Run a test and return result"""
    print("="*70)
    print(f"Running: {test_name}")
    print("="*70)
    
    try:
        if auto_input:
            # Run with automated input
            result = subprocess.run(
                ['python3', test_file],
                input=auto_input,
                text=True,
                capture_output=False,
                timeout=60
            )
        else:
            # Run interactively
            result = subprocess.run(
                ['python3', test_file],
                timeout=60
            )
        
        return result.returncode == 0
        
    except subprocess.TimeoutExpired:
        print("\n❌ Test timed out")
        return False
    except Exception as e:
        print(f"\n❌ Test failed with exception: {e}")
        return False

def main():
    print("""
╔══════════════════════════════════════════════════════════════════════╗
║                  ScreenCast Implementation Test Suite                 ║
║                     Flash-Free Screenshot Solution                    ║
╚══════════════════════════════════════════════════════════════════════╝
""")
    
    tests = []
    
    # Test 1: Availability (automated)
    print("\n📋 Test 1: Availability Check (automated)\n")
    result = run_test(
        "Test 1: ScreenCast Availability",
        "tests/test_screencast_availability.py"
    )
    tests.append(("Test 1: Availability", result))
    time.sleep(2)
    
    # Diagnostics (automated)
    print("\n🔧 GStreamer Diagnostics (automated)\n")
    result = run_test(
        "GStreamer Diagnostics",
        "tests/test_gstreamer_diagnostic.py"
    )
    tests.append(("GStreamer Diagnostics", result))
    time.sleep(2)
    
    # Test 5: Integration (needs user input for flash check)
    print("\n📋 Test 5: Integration Test\n")
    print("⚠️  This test will capture a screenshot.")
    print("    Watch carefully and answer if you saw a flash.\n")
    input("Press Enter to continue...")
    result = run_test(
        "Test 5: Integration Test",
        "tests/test_screencast_integration.py"
    )
    tests.append(("Test 5: Integration", result))
    
    # Summary
    print("\n")
    print("="*70)
    print("TEST SUITE SUMMARY")
    print("="*70)
    
    passed = sum(1 for _, result in tests if result)
    total = len(tests)
    
    for test_name, result in tests:
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"{status}  {test_name}")
    
    print()
    print(f"Total: {passed}/{total} tests passed")
    print()
    
    if passed == total:
        print("🎉 ALL TESTS PASSED!")
        print()
        print("ScreenCast implementation is working correctly:")
        print("  ✅ Portal available")
        print("  ✅ GStreamer configured")
        print("  ✅ Integration working")
        print()
        print("Next steps:")
        print("  1. Run manual flash verification tests")
        print("  2. Test rapid captures (simulates time tracker)")
        print("  3. Performance benchmark")
        print()
        return 0
    else:
        print("⚠️  Some tests failed. Check output above for details.")
        return 1

if __name__ == '__main__':
    sys.exit(main())
