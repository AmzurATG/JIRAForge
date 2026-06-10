#!/usr/bin/env python3
"""
Test 2: Capture single screenshot and check for flash
"""

import sys
import os
import time
import logging

# Enable debug logging BEFORE importing monitor_capture
logging.basicConfig(level=logging.DEBUG, format='%(levelname)s: %(message)s')

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from monitor_capture import _capture_screencast

def test_single_capture():
    print("="*70)
    print("Test 2: ScreenCast Single Capture Test")
    print("="*70)
    print()
    print("This test will capture ONE screenshot using ScreenCast.")
    print()
    print("IMPORTANT:")
    print("  - First run: You'll see consent dialog - click 'Share'")
    print("  - Watch carefully for flash")
    print()
    print("Starting capture in 3 seconds...")
    time.sleep(3)
    
    try:
        print("Calling _capture_screencast()...")
        output = _capture_screencast()
        
        print(f"DEBUG: output = {output}")
        print(f"DEBUG: type = {type(output)}")
        
        if output:
            print()
            print(f"✅ Screenshot captured successfully")
            print(f"   Size: {output.size}")
            print(f"   Mode: {output.mode}")
            print()
            print("❓ Did you see a camera flash? (y/n)")
            
            response = input("> ").strip().lower()
            
            if response == 'y':
                print()
                print("❌ FAIL: Flash was visible")
                print("   ScreenCast should NOT show flash")
                return 1
            else:
                print()
                print("✅ PASS: No flash observed!")
                print("   ScreenCast working as expected")
                return 0
        else:
            print()
            print("❌ FAIL: Screenshot capture returned None")
            print("   Check logs above for details")
            return 1
            
    except Exception as e:
        print()
        print(f"❌ ERROR: {e}")
        import traceback
        traceback.print_exc()
        return 1

if __name__ == '__main__':
    sys.exit(test_single_capture())
