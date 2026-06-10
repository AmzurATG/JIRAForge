#!/usr/bin/env python3
"""
Test 5: Full integration test with capture_focused_monitor()
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from monitor_capture import capture_focused_monitor

def test_integration():
    print("="*70)
    print("Test 5: ScreenCast Integration Test")
    print("="*70)
    print()
    print("This tests the full integration with capture_focused_monitor().")
    print("The function should automatically use ScreenCast (no flash).")
    print()
    
    try:
        print("Capturing screenshot...")
        result = capture_focused_monitor()
        
        if result:
            print()
            print(f"✅ Screenshot captured successfully")
            
            # Try to get image dimensions
            try:
                width, height = result.size
                print(f"   Size: {width}x{height}")
                print(f"   Mode: {result.mode}")
            except:
                pass
            
            # Verify it's a valid image
            try:
                result.verify()
                print("   Format: Valid image ✓")
            except:
                print("   Format: Could not verify")
            
            print()
            print("❓ Did you see a flash? (y/n)")
            response = input("> ").strip().lower()
            
            if response == 'y':
                print()
                print("❌ FAIL: Flash was visible")
                return 1
            else:
                print()
                print("✅ PASS: Integration working with no flash!")
                return 0
        else:
            print("❌ FAIL: No screenshot returned")
            return 1
            
    except Exception as e:
        print()
        print(f"❌ ERROR: {e}")
        import traceback
        traceback.print_exc()
        return 1

if __name__ == '__main__':
    sys.exit(test_integration())
