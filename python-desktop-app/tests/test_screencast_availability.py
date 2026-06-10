#!/usr/bin/env python3
"""
Test 1: Verify ScreenCast Portal is available
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from monitor_capture import _check_screencast_available

def test_availability():
    print("="*70)
    print("Test 1: ScreenCast Portal Availability Check")
    print("="*70)
    print()
    print("Testing ScreenCast Portal availability...")
    print()
    
    available = _check_screencast_available()
    
    if available:
        print("✅ PASS: ScreenCast Portal is available")
        print()
        print("This means:")
        print("  • Flash-free screenshots are possible")
        print("  • GStreamer bindings are installed")
        print("  • PipeWire ScreenCast portal is accessible")
        print()
        return 0
    else:
        print("❌ FAIL: ScreenCast Portal not available")
        print()
        print("This system may not support ScreenCast.")
        print("Check:")
        print("  • Is GStreamer installed? (python3-gst-1.0)")
        print("  • Is PipeWire running?")
        print("  • Is xdg-desktop-portal installed?")
        print()
        return 1

if __name__ == '__main__':
    sys.exit(test_availability())
