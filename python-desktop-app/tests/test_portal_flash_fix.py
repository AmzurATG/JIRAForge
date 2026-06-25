#!/usr/bin/env python3
"""
Test XDG Portal Flash Fix

This script tests that screenshot capture is flash-free using the XDG Portal.
Run this and watch your screen - there should be NO FLASH.
"""

import sys
import os
import time

# Add parent directory to path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import monitor_capture
import logging

logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')

def main():
    print("=" * 70)
    print("XDG PORTAL FLASH FIX TEST")
    print("=" * 70)
    print()
    print("This test will capture 3 screenshots in sequence.")
    print("Watch your screen carefully - there should be NO FLASH at all.")
    print()
    print("If you see a permission dialog on the first capture, click Allow.")
    print("Subsequent captures should be completely silent (no dialog, no flash).")
    print()
    input("Press Enter to start the test...")
    print()

    success_count = 0
    for i in range(1, 4):
        print(f"[{i}/3] Capturing screenshot...")
        print("      👀 WATCH FOR FLASH...")
        
        start_time = time.time()
        img = monitor_capture.capture_focused_monitor()
        elapsed = time.time() - start_time
        
        if img:
            print(f"      ✅ SUCCESS: {img.width}x{img.height} in {elapsed:.2f}s")
            success_count += 1
        else:
            print(f"      ❌ FAILED")
        
        if i < 3:
            print()
            time.sleep(1)

    print()
    print("=" * 70)
    print("TEST COMPLETE")
    print("=" * 70)
    print()
    print(f"Captured: {success_count}/3 screenshots")
    print()

    if success_count == 3:
        print("✅ ALL CAPTURES SUCCESSFUL")
        print()
        print("❓ Did you see any flash?")
        print("   - If NO flash → Fix is working! 🎉")
        print("   - If flash occurred → Issue remains")
    else:
        print("⚠️  Some captures failed - check the logs above")
    print()

if __name__ == '__main__':
    main()
