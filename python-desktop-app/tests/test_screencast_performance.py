#!/usr/bin/env python3
"""
Test 6: Performance benchmark
"""

import sys
import os
import time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from monitor_capture import _capture_screencast, _capture_xdg_portal

def benchmark_method(method_name, capture_func, iterations=5):
    """Benchmark a capture method"""
    print(f"\n{method_name}:")
    print("-" * 40)
    
    times = []
    
    for i in range(iterations):
        print(f"  [{i+1}/{iterations}] ", end='', flush=True)
        
        try:
            start = time.time()
            output = capture_func()
            elapsed = time.time() - start
            times.append(elapsed)
            
            # Verify output
            if output:
                print(f"✅ {elapsed:.2f}s")
            else:
                print(f"❌ Failed (returned None)")
        except Exception as e:
            print(f"❌ Error: {e}")
    
    if times:
        avg = sum(times) / len(times)
        min_time = min(times)
        max_time = max(times)
        
        print(f"\n  Results:")
        print(f"    Average: {avg:.2f}s")
        print(f"    Min:     {min_time:.2f}s")
        print(f"    Max:     {max_time:.2f}s")
        
        return avg
    else:
        return None

def main():
    print("="*70)
    print("Test 6: ScreenCast Performance Benchmark")
    print("="*70)
    print()
    print("This test compares ScreenCast vs Screenshot Portal performance.")
    print("Running 5 captures for each method...")
    
    # Warm up
    print("\nWarm-up capture...")
    try:
        _capture_screencast()
        print("  ✅ Warm-up complete")
    except Exception as e:
        print(f"  ⚠️  Warm-up failed: {e}")
    
    # Benchmark ScreenCast
    screencast_avg = benchmark_method(
        "ScreenCast Portal (NO FLASH)",
        _capture_screencast,
        iterations=5
    )
    
    # Benchmark Screenshot Portal
    screenshot_avg = benchmark_method(
        "Screenshot Portal (HAS FLASH)",
        _capture_xdg_portal,
        iterations=5
    )
    
    # Summary
    print()
    print("="*70)
    print("SUMMARY")
    print("="*70)
    
    if screencast_avg and screenshot_avg:
        diff = screencast_avg - screenshot_avg
        print(f"ScreenCast:  {screencast_avg:.2f}s (NO flash)")
        print(f"Screenshot:  {screenshot_avg:.2f}s (HAS flash)")
        print(f"Difference:  {diff:+.2f}s")
        
        if diff < 1.0:
            print(f"\n✅ ScreenCast overhead acceptable (<1s)")
            print("   Trade-off worth it for NO flash")
        else:
            print(f"\n⚠️  ScreenCast is {diff:.1f}s slower")
            print("   Trade-off: No flash vs speed")
            print("   For continuous time tracker, NO flash is critical")
    
    return 0

if __name__ == '__main__':
    sys.exit(main())
