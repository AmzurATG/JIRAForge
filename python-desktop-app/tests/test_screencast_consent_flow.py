#!/usr/bin/env python3
"""
Test 4: Test consent dialog flow
"""

import sys
import os
import time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from monitor_capture import _capture_screencast

def test_consent_flow():
    print("="*70)
    print("Test 4: ScreenCast Consent Flow Test")
    print("="*70)
    print()
    print("This test verifies the consent dialog behavior.")
    print()
    print("Instructions:")
    print("  1. If you see consent dialog: Click 'Share'")
    print("  2. If no dialog appears: Consent already granted")
    print()
    input("Press Enter to start test...")
    
    # First capture
    print()
    print("[1/2] First capture (may show dialog)...")
    
    try:
        output1 = _capture_screencast()
        
        if output1:
            print(f"  ✅ Captured successfully")
            
            print()
            print("❓ Did you see a consent dialog? (y/n)")
            saw_dialog = input("> ").strip().lower() == 'y'
            
            # Second capture
            print()
            print("[2/2] Second capture (should be silent)...")
            time.sleep(2)
            
            output2 = _capture_screencast()
            
            if output2:
                print(f"  ✅ Captured successfully")
                
                print()
                print("❓ Did you see a consent dialog THIS time? (y/n)")
                saw_dialog_2 = input("> ").strip().lower() == 'y'
                
                # Results
                print()
                print("="*70)
                print("RESULTS")
                print("="*70)
                
                if not saw_dialog:
                    print("ℹ️  Consent was already granted (from previous test)")
                    print("✅ PASS: Both captures worked without new dialog")
                    return 0
                elif saw_dialog and not saw_dialog_2:
                    print("✅ PASS: Consent flow working correctly")
                    print("   - First capture: Dialog shown")
                    print("   - Second capture: Silent (consent remembered)")
                    return 0
                elif saw_dialog_2:
                    print("❌ FAIL: Dialog appeared on second capture")
                    print("   Consent should be persistent")
                    return 1
            else:
                print("  ❌ Second capture failed")
                return 1
        else:
            print("  ❌ First capture failed")
            return 1
            
    except Exception as e:
        print()
        print(f"❌ ERROR: {e}")
        
        if "denied consent" in str(e).lower():
            print()
            print("You clicked 'Cancel' on the consent dialog.")
            print("This is expected behavior - app should fallback to Screenshot Portal.")
            return 0
        else:
            import traceback
            traceback.print_exc()
            return 1

if __name__ == '__main__':
    sys.exit(test_consent_flow())
