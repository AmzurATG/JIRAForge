#!/usr/bin/env python3
"""
Debug test for ScreenCast capture with verbose logging
"""

import sys
import os
import logging

# Set up logging to see what's happening
logging.basicConfig(
    level=logging.DEBUG,
    format='%(asctime)s - %(name)s - %(levelname)s - %(message)s'
)

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from monitor_capture import _capture_screencast, _check_screencast_available

def test_debug():
    print("="*70)
    print("ScreenCast Debug Test")
    print("="*70)
    print()
    
    # Check availability
    print("Step 1: Checking availability...")
    available = _check_screencast_available()
    print(f"Result: {available}")
    print()
    
    if not available:
        print("❌ ScreenCast not available, cannot continue")
        return 1
    
    # Try capture with full logging
    print("Step 2: Attempting capture...")
    print("(This will show all debug messages)")
    print()
    
    try:
        result = _capture_screencast()
        
        if result:
            print()
            print(f"✅ Capture successful!")
            print(f"   Type: {type(result)}")
            try:
                print(f"   Size: {result.size}")
                print(f"   Mode: {result.mode}")
            except:
                pass
            return 0
        else:
            print()
            print("❌ Capture returned None")
            print()
            print("Check the debug messages above for the failure point.")
            return 1
            
    except Exception as e:
        print()
        print(f"❌ Exception: {e}")
        import traceback
        traceback.print_exc()
        return 1

if __name__ == '__main__':
    sys.exit(test_debug())
