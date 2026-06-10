#!/usr/bin/env python3
"""
Test the updated monitor_capture.py with XDG Portal support.

This script tests the capture_focused_monitor() function to verify:
1. XDG Portal is tried first on Wayland
2. Screenshot is captured without flash
3. Image is not black
"""

import sys
import os

# Add parent directory to path to import monitor_capture
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import monitor_capture
import logging

# Enable debug logging to see which method is used
logging.basicConfig(level=logging.DEBUG, format='%(levelname)s: %(message)s')

print("=" * 60)
print("TESTING MONITOR CAPTURE WITH XDG PORTAL")
print("=" * 60)
print()

print("🔍 Step 1: Checking XDG Portal availability...")
portal_available = monitor_capture._check_xdg_portal_available()
print(f"   Result: {'✅ Available' if portal_available else '❌ Not available'}")
print()

print("📸 Step 2: Attempting screenshot capture...")
print("   (Watch for flash - there should be NONE if portal works)")
print()

try:
    image = monitor_capture.capture_focused_monitor()
    
    if image is None:
        print("❌ FAILED: No image captured")
        print("   Check the debug logs above for details")
        sys.exit(1)
    
    print(f"✅ SUCCESS: Image captured ({image.width}x{image.height})")
    print()
    
    # Validate image is not all black
    import array
    bands = image.split()
    max_values = [max(array.array('B', b.tobytes())) for b in bands]
    
    print("🎨 Step 3: Validating image content...")
    print(f"   Max pixel values per channel: R={max_values[0]}, G={max_values[1]}, B={max_values[2]}")
    
    if all(v == 0 for v in max_values):
        print("   ❌ FAILED: Image is all black")
        sys.exit(1)
    else:
        print("   ✅ Image contains actual content")
    
    print()
    print("=" * 60)
    print("✅ ALL TESTS PASSED")
    print("=" * 60)
    print()
    print("CAPTURED METHOD: Check the DEBUG log above to see which method was used")
    print("  - Should say 'XDG Desktop Portal' for flash-free capture")
    print()
    
    # Save test image
    test_output = "/tmp/test_screenshot.png"
    image.save(test_output)
    print(f"📁 Test image saved to: {test_output}")
    print()
    
except Exception as e:
    print(f"❌ EXCEPTION: {e}")
    import traceback
    traceback.print_exc()
    sys.exit(1)
