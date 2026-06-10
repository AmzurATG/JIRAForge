#!/usr/bin/env python3
"""
Test 3: Test rapid sequential captures (simulates time tracker)
"""

import sys
import os
import time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from monitor_capture import _capture_screencast

def test_rapid_captures():
    print("="*70)
    print("Test 3: ScreenCast Rapid Capture Test (3 captures)")
    print("="*70)
    print()
    print("This simulates TimeTracker taking screenshots every few seconds.")
    print("Watch for ANY flashes during the 3 captures.")
    print()
    
    results = []
    
    for i in range(1, 4):
        print(f"\n[{i}/3] Capturing in 2 seconds...")
        time.sleep(2)
        
        try:
            start_time = time.time()
            output = _capture_screencast()
            elapsed = time.time() - start_time
            
            if output:
                print(f"  ✅ Captured successfully")
                print(f"  ⏱️  Time: {elapsed:.2f}s")
                
                results.append({
                    'number': i,
                    'success': True,
                    'time': elapsed
                })
            else:
                print(f"  ❌ Failed: returned None")
                results.append({
                    'number': i,
                    'success': False,
                    'error': 'Returned None'
                })
            
        except Exception as e:
            print(f"  ❌ Failed: {e}")
            results.append({
                'number': i,
                'success': False,
                'error': str(e)
            })
    
    # Summary
    print()
    print("="*70)
    print("RESULTS")
    print("="*70)
    
    successes = sum(1 for r in results if r.get('success'))
    print(f"Successful captures: {successes}/3")
    
    if successes > 0:
        times = [r['time'] for r in results if r.get('success')]
        avg_time = sum(times) / len(times)
        print(f"Average capture time: {avg_time:.2f}s")
    
    print()
    print("❓ How many flashes did you see? (0-3)")
    response = input("> ").strip()
    
    try:
        flash_count = int(response)
        if flash_count == 0:
            print()
            print("✅ PASS: No flashes observed!")
            print("   ScreenCast is working perfectly for rapid captures")
            return 0
        else:
            print()
            print(f"❌ FAIL: {flash_count} flash(es) observed")
            return 1
    except ValueError:
        print("Invalid input")
        return 1

if __name__ == '__main__':
    sys.exit(test_rapid_captures())
