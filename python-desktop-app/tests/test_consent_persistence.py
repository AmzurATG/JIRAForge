#!/usr/bin/env python3
"""
Test: Verify consent dialog only shows ONCE
"""

import sys
import os
import time
import logging

logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from monitor_capture import _capture_screencast

def test_consent_persistence():
    print("="*70)
    print("Test: Consent Dialog Persistence")
    print("="*70)
    print()
    print("This test captures 3 screenshots to verify consent is only")
    print("asked ONCE, then reused for subsequent captures.")
    print()
    print("WATCH CAREFULLY:")
    print("  - First capture: You should see consent dialog -> Click 'Share'")
    print("  - Second capture: NO dialog (reuses session)")
    print("  - Third capture: NO dialog (reuses session)")
    print()
    input("Press Enter to start test...")
    
    for i in range(1, 4):
        print(f"\n[Capture {i}/3] Starting in 2 seconds...")
        time.sleep(2)
        
        try:
            result = _capture_screencast()
            
            if result:
                print(f"  ✅ Success: {result.size}")
            else:
                print(f"  ❌ Failed")
                return 1
                
        except Exception as e:
            print(f"  ❌ Error: {e}")
            return 1
    
    print()
    print("="*70)
    print("TEST COMPLETE")
    print("="*70)
    print()
    print("❓ How many times did you see the consent dialog?")
    print("   (Expected: 1 - only on first capture)")
    print()
    
    response = input("Number of consent dialogs seen: ").strip()
    
    try:
        count = int(response)
        if count == 1:
            print()
            print("✅ PASS: Consent dialog shown only once!")
            print("   Session is being reused correctly.")
            print("   Future captures will be silent (no dialogs).")
            return 0
        else:
            print()
            print(f"❌ FAIL: Consent dialog shown {count} times")
            print("   Expected: 1 (first capture only)")
            print("   Session caching may not be working.")
            return 1
    except ValueError:
        print("Invalid input")
        return 1

if __name__ == '__main__':
    sys.exit(test_consent_persistence())
