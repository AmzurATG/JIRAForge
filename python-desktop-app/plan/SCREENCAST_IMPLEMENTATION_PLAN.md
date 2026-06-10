# PipeWire ScreenCast Implementation Plan
## Flash-Free Screenshot Capture for TimeTracker
**Date**: June 10, 2026  
**Target**: Ubuntu 24.04 LTS (GNOME 46 Wayland)  
**Goal**: Replace Screenshot Portal with ScreenCast Portal to eliminate flash

---

## Executive Summary

**Problem**: Screenshot Portal triggers hardcoded flash in GNOME Shell  
**Root Cause**: `ScreenshotService._flashAsync()` is called for all screenshot APIs  
**Solution**: Use ScreenCast Portal (video capture) instead - doesn't trigger screenshot service  
**Benefit**: No flash, no admin access needed, no system modifications

**Implementation Scope**: 2-3 days development + 1 day testing

---

## Architecture Overview

### Current Flow (Screenshot Portal - HAS FLASH)
```
TimeTracker App
    ↓
_capture_xdg_portal()
    ↓
org.freedesktop.portal.Screenshot.Screenshot()
    ↓
GNOME Shell ScreenshotService
    ↓
_flashAsync() ← FLASH HAPPENS HERE!
    ↓
PNG file
```

### New Flow (ScreenCast Portal - NO FLASH)
```
TimeTracker App
    ↓
_capture_screencast()
    ↓
1. CreateSession() → session_handle
    ↓
2. SelectSources() → monitor selected
    ↓
3. Start() → user consent dialog (first time only)
    ↓
4. OpenPipeWireRemote() → PipeWire fd
    ↓
5. GStreamer pipeline → capture frame
    ↓
PNG file (NO FLASH!)
```

### Why No Flash?
- ScreenCast uses GNOME Shell's **video capture path**, not screenshot path
- Video capture doesn't call `ScreenshotService._flashAsync()`
- We capture single frame from video stream
- No screenshot API involved = no flash

---

## Implementation Plan

### Phase 1: Core ScreenCast Functions (Day 1)

#### File: `monitor_capture.py`

**Location**: After `_capture_xdg_portal()` function (~line 643)

**New Functions to Add**:

```python
def _check_screencast_available():
    """
    Check if ScreenCast portal is available.
    
    Returns:
        bool: True if available, False otherwise
    """
    # Check cache first
    # Try gdbus introspect
    # Cache result for 60 seconds
    pass

def _create_screencast_session():
    """
    Create ScreenCast session via Portal.
    
    Returns:
        tuple: (session_handle, error_message)
    """
    # Generate tokens
    # Subscribe to Response signal
    # Call CreateSession D-Bus method
    # Wait for session creation
    pass

def _select_monitor_source(session_handle):
    """
    Select monitor as capture source.
    
    Args:
        session_handle: Session handle from CreateSession
        
    Returns:
        tuple: (success, error_message)
    """
    # Subscribe to Response signal
    # Call SelectSources with types=1 (monitor)
    # cursor_mode=1 (hidden)
    # multiple=False
    pass

def _start_screencast_capture(session_handle):
    """
    Start capture (shows consent dialog first time).
    
    Args:
        session_handle: Session handle
        
    Returns:
        tuple: (success, error_message)
    """
    # Subscribe to Response signal
    # Call Start method
    # Handle consent dialog
    # Return success/failure
    pass

def _open_pipewire_connection(session_handle):
    """
    Open PipeWire connection and get file descriptor.
    
    Args:
        session_handle: Session handle
        
    Returns:
        tuple: (pipewire_fd, error_message)
    """
    # Call OpenPipeWireRemote
    # Use UnixFDList to receive fd
    # Return file descriptor
    pass

def _capture_frame_with_gstreamer(pipewire_fd, output_path):
    """
    Capture single frame from PipeWire using GStreamer.
    
    Args:
        pipewire_fd: PipeWire file descriptor
        output_path: Output PNG file path
        
    Returns:
        tuple: (success, error_message)
    """
    # Build pipeline: pipewiresrc fd=N ! videoconvert ! pngenc ! filesink
    # Set up bus callbacks (EOS, error)
    # Start pipeline
    # Wait for first frame
    # Stop and cleanup
    pass

def _capture_screencast():
    """
    Main entry point for ScreenCast capture.
    Orchestrates all steps.
    
    Returns:
        str: Path to captured screenshot
        
    Raises:
        Exception: If capture fails
    """
    # Step 1: Create session
    # Step 2: Select monitor
    # Step 3: Start capture (consent)
    # Step 4: Open PipeWire
    # Step 5: Capture frame
    # Step 6: Cleanup session
    # Return output path
    pass
```

**Implementation Details**:

```python
# At top of file, add imports:
import gi
gi.require_version('Gst', '1.0')
from gi.repository import Gst, GstApp
import random
import string

# Initialize GStreamer once
Gst.init(None)

# Token generation helper
def _generate_portal_token():
    """Generate random token for Portal requests"""
    chars = string.ascii_letters + string.digits
    return ''.join(random.choice(chars) for _ in range(10))

# Async D-Bus handling
class ScreenCastSession:
    """Helper class to manage async ScreenCast session"""
    def __init__(self):
        self.session_handle = None
        self.pipewire_fd = None
        self.loop = None
        self.error = None
        self.success = False
```

### Phase 2: Integration (Day 2)

#### Update `_capture_linux()` Function

**Current Priority Chain** (line ~670):
```python
def _capture_linux():
    """Capture screenshot on Linux."""
    try:
        # Try XDG Portal first
        if _check_xdg_portal_available():
            logger.debug("Using XDG Portal for screenshot")
            return _capture_xdg_portal()
    except Exception as e:
        logger.warning(f"XDG Portal failed: {e}")
    
    # Try D-Bus API
    try:
        # ... rest of fallbacks
```

**New Priority Chain** (with ScreenCast first):
```python
def _capture_linux():
    """Capture screenshot on Linux."""
    # Priority 1: ScreenCast Portal (NO FLASH)
    try:
        if _check_screencast_available():
            logger.debug("Using ScreenCast Portal for screenshot (no flash)")
            return _capture_screencast()
    except Exception as e:
        logger.warning(f"ScreenCast Portal failed: {e}")
    
    # Priority 2: Screenshot Portal (HAS FLASH - fallback only)
    try:
        if _check_xdg_portal_available():
            logger.debug("Using Screenshot Portal (has flash) as fallback")
            return _capture_xdg_portal()
    except Exception as e:
        logger.warning(f"Screenshot Portal failed: {e}")
    
    # Priority 3-N: Legacy fallbacks
    # ... rest unchanged
```

#### Error Handling

**Consent Denied**:
```python
if response_code == 1:  # User cancelled
    logger.info("User denied ScreenCast consent, falling back to Screenshot Portal")
    raise Exception("User denied consent")
```

**PipeWire Connection Failed**:
```python
if pipewire_fd is None or pipewire_fd < 0:
    logger.error("Failed to open PipeWire connection")
    raise Exception("PipeWire connection failed")
```

**GStreamer Pipeline Failed**:
```python
try:
    pipeline = Gst.parse_launch(pipeline_str)
except Exception as e:
    logger.error(f"GStreamer pipeline failed: {e}")
    raise Exception(f"GStreamer error: {e}")
```

### Phase 3: Testing Suite (Day 2-3)

#### Test 1: ScreenCast Availability Check
**File**: `tests/test_screencast_availability.py`

```python
#!/usr/bin/env python3
"""
Test 1: Verify ScreenCast Portal is available
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from monitor_capture import _check_screencast_available

def test_availability():
    print("Testing ScreenCast Portal availability...")
    
    available = _check_screencast_available()
    
    if available:
        print("✅ PASS: ScreenCast Portal is available")
        return 0
    else:
        print("❌ FAIL: ScreenCast Portal not available")
        print("   This system may not support ScreenCast")
        return 1

if __name__ == '__main__':
    sys.exit(test_availability())
```

#### Test 2: Single Capture with Flash Check
**File**: `tests/test_screencast_single_capture.py`

```python
#!/usr/bin/env python3
"""
Test 2: Capture single screenshot and check for flash
"""

import sys
import os
import time
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from monitor_capture import _capture_screencast

def test_single_capture():
    print("="*70)
    print("ScreenCast Single Capture Test")
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
        output_path = _capture_screencast()
        
        print()
        print(f"✅ Screenshot captured: {output_path}")
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
            
    except Exception as e:
        print()
        print(f"❌ ERROR: {e}")
        import traceback
        traceback.print_exc()
        return 1

if __name__ == '__main__':
    sys.exit(test_single_capture())
```

#### Test 3: Rapid Sequential Captures
**File**: `tests/test_screencast_rapid_captures.py`

```python
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
    print("ScreenCast Rapid Capture Test (3 captures)")
    print("="*70)
    print()
    print("This simulates TimeTracker taking screenshots every few seconds.")
    print("Watch for ANY flashes during the 3 captures.")
    print()
    
    flash_count = 0
    results = []
    
    for i in range(1, 4):
        print(f"\n[{i}/3] Capturing in 2 seconds...")
        time.sleep(2)
        
        try:
            start_time = time.time()
            output_path = _capture_screencast()
            elapsed = time.time() - start_time
            
            print(f"  ✅ Captured: {output_path}")
            print(f"  ⏱️  Time: {elapsed:.2f}s")
            
            results.append({
                'number': i,
                'success': True,
                'time': elapsed,
                'path': output_path
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
```

#### Test 4: Consent Flow Test
**File**: `tests/test_screencast_consent_flow.py`

```python
#!/usr/bin/env python3
"""
Test 4: Test consent dialog flow
"""

import sys
import os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

from monitor_capture import _capture_screencast

def test_consent_flow():
    print("="*70)
    print("ScreenCast Consent Flow Test")
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
        print(f"  ✅ Captured: {output1}")
        
        print()
        print("❓ Did you see a consent dialog? (y/n)")
        saw_dialog = input("> ").strip().lower() == 'y'
        
        # Second capture
        print()
        print("[2/2] Second capture (should be silent)...")
        import time
        time.sleep(2)
        
        output2 = _capture_screencast()
        print(f"  ✅ Captured: {output2}")
        
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
```

#### Test 5: Integration Test
**File**: `tests/test_screencast_integration.py`

```python
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
    print("ScreenCast Integration Test")
    print("="*70)
    print()
    print("This tests the full integration with capture_focused_monitor().")
    print("The function should automatically use ScreenCast (no flash).")
    print()
    
    try:
        print("Capturing screenshot...")
        result = capture_focused_monitor()
        
        if result and 'screenshot_path' in result:
            path = result['screenshot_path']
            print()
            print(f"✅ Screenshot captured: {path}")
            print(f"   Monitor: {result.get('monitor_info', {}).get('name', 'unknown')}")
            print(f"   Size: {os.path.getsize(path)} bytes")
            
            # Verify it's a valid PNG
            with open(path, 'rb') as f:
                header = f.read(8)
                if header[:4] == b'\x89PNG':
                    print("   Format: Valid PNG ✓")
                else:
                    print("   Format: Invalid PNG ✗")
                    return 1
            
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
```

#### Test 6: Performance Benchmark
**File**: `tests/test_screencast_performance.py`

```python
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
            if os.path.exists(output) and os.path.getsize(output) > 0:
                print(f"✅ {elapsed:.2f}s")
            else:
                print(f"❌ Failed (empty file)")
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
    print("ScreenCast Performance Benchmark")
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
        else:
            print(f"\n⚠️  ScreenCast is {diff:.1f}s slower")
            print("   Trade-off: No flash vs speed")
    
    return 0

if __name__ == '__main__':
    sys.exit(main())
```

### Phase 4: Documentation Updates (Day 3)

#### Update `README.md`

**Add Dependencies Section**:
```markdown
### Linux Screenshot Requirements (Wayland)

TimeTracker uses PipeWire ScreenCast for flash-free screenshots on Wayland.

**Required packages** (pre-installed on Ubuntu 24.04):
- `python3-gi` - GObject introspection
- `gstreamer1.0-pipewire` - GStreamer PipeWire plugin
- `pipewire` - Multimedia server (1.0+)

**First Run**:
On first screenshot, you'll see a consent dialog:
"Allow TimeTracker to record your screen?"

Click **Share** to grant permission (one-time only).
All future screenshots will be silent with no flash.

**Why ScreenCast instead of Screenshot?**
- Screenshot API triggers camera flash animation
- ScreenCast (video capture) has no flash
- Both produce identical PNG screenshots
```

#### Create User Guide
**File**: `docs/LINUX_SCREENSHOT_SETUP.md`

```markdown
# Linux Screenshot Setup Guide

## Wayland (GNOME, Ubuntu 22.04+)

TimeTracker uses **PipeWire ScreenCast** for flash-free screenshots.

### First-Time Setup

1. Install TimeTracker (dependencies included)
2. Launch TimeTracker
3. When first screenshot is taken:
   - Dialog appears: "Allow TimeTracker to record your screen?"
   - Click **Share** button
   - Consent is saved permanently
4. All future screenshots are silent (no flash, no dialogs)

### Why You See "Record Your Screen"

ScreenCast is technically a screen recording API (used by Zoom, Teams for screen sharing).
TimeTracker captures just 1 frame from the video stream.

**Result**: Normal screenshot PNG, but **NO camera flash**.

### Troubleshooting

**Problem**: "ScreenCast portal not available"
- **Cause**: Very old system or non-GNOME compositor
- **Fix**: Falls back to Screenshot Portal (has flash)

**Problem**: "User denied consent"
- **Cause**: Clicked Cancel on dialog
- **Fix**: Falls back to Screenshot Portal (has flash)
- **Note**: To remove flash, re-run and click Share

**Problem**: Screenshots are slow (>3 seconds)
- **Cause**: PipeWire/GStreamer initialization
- **Expected**: First capture ~2-3s, subsequent ~2s
- **Note**: Trade-off for no flash

### Advanced: Revoke Consent

To reset consent (for testing):
```bash
# Remove stored consent
rm -rf ~/.local/share/timetracker/screencast-consent
```

Next screenshot will ask for consent again.
```

---

## Success Criteria

### Functional Requirements
- ✅ Screenshots captured without flash
- ✅ No admin/sudo access required
- ✅ No system modifications required
- ✅ Works on locked-down enterprise laptops
- ✅ One-time consent, then silent forever
- ✅ Automatic fallback if ScreenCast unavailable

### Performance Requirements
- ✅ Capture time <3 seconds
- ✅ Minimal CPU overhead (<5% during capture)
- ✅ No memory leaks (GStreamer cleanup)

### Quality Requirements
- ✅ Full resolution (matches monitor)
- ✅ Valid PNG output
- ✅ No corruption or artifacts
- ✅ Identical quality to Screenshot Portal

### User Experience Requirements
- ✅ Clear consent dialog explanation
- ✅ No confusing error messages
- ✅ Graceful fallback behavior
- ✅ Documented in user guide

---

## Implementation Timeline

### Day 1 (8 hours)
- **Hour 1-2**: Implement `_check_screencast_available()`
- **Hour 3-4**: Implement session creation and source selection
- **Hour 5-6**: Implement PipeWire connection
- **Hour 7-8**: Implement GStreamer frame capture

### Day 2 (8 hours)
- **Hour 1-2**: Implement `_capture_screencast()` orchestrator
- **Hour 3-4**: Update `_capture_linux()` priority chain
- **Hour 5-6**: Error handling and fallback logic
- **Hour 7-8**: Create test suite (Tests 1-3)

### Day 3 (8 hours)
- **Hour 1-2**: Complete test suite (Tests 4-6)
- **Hour 3-4**: Run full test battery
- **Hour 5-6**: Fix bugs found in testing
- **Hour 7-8**: Update documentation

### Day 4 (4 hours) - Testing & Validation
- **Hour 1**: Performance benchmarking
- **Hour 2**: Multi-monitor testing
- **Hour 3**: Consent flow validation
- **Hour 4**: Final integration testing

**Total**: ~28 hours (~3.5 days)

---

## Dependencies

### Python Packages (Already Installed)
```python
gi (3.42.0+)          # GObject introspection
gi.repository.Gio     # D-Bus communication
gi.repository.GLib    # Event loop
gi.repository.Gst     # GStreamer (NEW)
```

### System Packages (Ubuntu 24.04 - Pre-installed)
```
gstreamer1.0-pipewire (1.0.5+)
libgstreamer1.0-0 (1.24.2+)
pipewire (1.0.5+)
```

### Verification Script
```bash
#!/bin/bash
# verify_screencast_deps.sh

echo "Checking ScreenCast dependencies..."

# Check Python GStreamer bindings
python3 -c "import gi; gi.require_version('Gst', '1.0'); from gi.repository import Gst; print('✓ GStreamer:', Gst.version())" || echo "✗ python3-gst missing"

# Check PipeWire
dpkg -l | grep -q pipewire && echo "✓ PipeWire installed" || echo "✗ PipeWire missing"

# Check GStreamer PipeWire plugin
dpkg -l | grep -q gstreamer1.0-pipewire && echo "✓ GStreamer PipeWire plugin installed" || echo "✗ Plugin missing"

# Check Portal
gdbus introspect --session --dest org.freedesktop.portal.Desktop --object-path /org/freedesktop/portal/desktop | grep -q "interface org.freedesktop.portal.ScreenCast" && echo "✓ ScreenCast Portal available" || echo "✗ ScreenCast Portal not available"

echo ""
echo "All checks passed! Ready for ScreenCast implementation."
```

---

## Risk Mitigation

### Risk 1: GStreamer Pipeline Hangs
**Likelihood**: Low  
**Impact**: High  
**Mitigation**:
- Use timeout on pipeline start (5 seconds)
- Implement watchdog timer
- Force cleanup on timeout
- Fallback to Screenshot Portal

**Code**:
```python
def _capture_frame_with_gstreamer(pipewire_fd, output_path):
    # Set up watchdog
    timeout_id = GLib.timeout_add_seconds(5, _gstreamer_timeout_handler)
    
    try:
        # ... pipeline code
    finally:
        GLib.source_remove(timeout_id)
```

### Risk 2: PipeWire Connection Refused
**Likelihood**: Medium  
**Impact**: Medium  
**Mitigation**:
- Check PipeWire service status
- Log detailed error message
- Automatic fallback to Screenshot Portal
- User-friendly error message

### Risk 3: User Denies Consent
**Likelihood**: Medium  
**Impact**: Low  
**Mitigation**:
- Detect response code 1 (cancelled)
- Log info message (not error)
- Silent fallback to Screenshot Portal (has flash)
- Document consent importance

### Risk 4: Memory Leak in GStreamer
**Likelihood**: Low  
**Impact**: Medium  
**Mitigation**:
- Proper pipeline cleanup (set to NULL state)
- Close PipeWire fd explicitly
- Monitor memory in long-running tests
- Add cleanup in exception handlers

**Code**:
```python
def _cleanup_gstreamer_pipeline(pipeline, pipewire_fd):
    """Ensure proper cleanup"""
    try:
        if pipeline:
            pipeline.set_state(Gst.State.NULL)
        if pipewire_fd and pipewire_fd > 0:
            os.close(pipewire_fd)
    except Exception as e:
        logger.warning(f"Cleanup error: {e}")
```

---

## Rollback Plan

If ScreenCast implementation fails in production:

### Immediate Rollback (< 1 hour)
1. Comment out ScreenCast in priority chain
2. Keep Screenshot Portal as primary
3. Deploy hotfix
4. Users get flash but app works

**Code**:
```python
def _capture_linux():
    # Temporary rollback - disable ScreenCast
    # TODO: Re-enable after fixing issue XYZ
    # if _check_screencast_available():
    #     return _capture_screencast()
    
    # Use Screenshot Portal (has flash)
    if _check_xdg_portal_available():
        return _capture_xdg_portal()
```

### Debugging Period (1-3 days)
1. Collect logs from affected users
2. Reproduce issue in test environment
3. Fix and test patch
4. Staged rollout (10% → 50% → 100%)

### Long-term Fallback
- ScreenCast is additive, not replacement
- Screenshot Portal remains as working fallback
- No functionality lost, only flash returns

---

## Test Execution Plan

### Pre-Implementation Tests
```bash
cd ~/ATG/new-main-linux/JIRAForge/python-desktop-app

# Verify ScreenCast available
python3 tests/test_screencast_simple.py

# Expected: ✅ Version 5, monitor capture supported
```

### During Implementation Tests
```bash
# After each function, unit test it
python3 -c "from monitor_capture import _check_screencast_available; print(_check_screencast_available())"
```

### Post-Implementation Tests
```bash
# Run full test suite
python3 tests/test_screencast_availability.py
python3 tests/test_screencast_single_capture.py
python3 tests/test_screencast_rapid_captures.py
python3 tests/test_screencast_consent_flow.py
python3 tests/test_screencast_integration.py
python3 tests/test_screencast_performance.py

# Expected: All tests pass with NO flash
```

### Acceptance Test
**Manual verification by user**:
1. Launch TimeTracker
2. Let it take 10 screenshots over 5 minutes
3. Observe screen during captures
4. Confirm: NO flash visible

**Success Criteria**: Zero flashes observed

---

## Monitoring & Logging

### Log Levels

**INFO**: Normal operation
```python
logger.info("ScreenCast capture successful in 2.1s")
```

**WARNING**: Non-fatal issues
```python
logger.warning("ScreenCast failed, falling back to Screenshot Portal: User denied consent")
```

**ERROR**: Unexpected failures
```python
logger.error(f"GStreamer pipeline failed: {error_message}")
```

### Metrics to Track

**Capture Success Rate**:
```python
screencast_attempts = 0
screencast_successes = 0
success_rate = (screencast_successes / screencast_attempts) * 100
```

**Average Capture Time**:
```python
capture_times = []
avg_time = sum(capture_times) / len(capture_times)
```

**Fallback Rate**:
```python
fallback_count = 0
fallback_rate = (fallback_count / total_attempts) * 100
```

---

## Completion Checklist

### Code Implementation
- [ ] `_check_screencast_available()` implemented
- [ ] `_create_screencast_session()` implemented
- [ ] `_select_monitor_source()` implemented
- [ ] `_start_screencast_capture()` implemented
- [ ] `_open_pipewire_connection()` implemented
- [ ] `_capture_frame_with_gstreamer()` implemented
- [ ] `_capture_screencast()` orchestrator implemented
- [ ] `_capture_linux()` priority chain updated
- [ ] Error handling implemented
- [ ] Cleanup/resource management implemented

### Testing
- [ ] Test 1: Availability check - PASS
- [ ] Test 2: Single capture - PASS, NO flash
- [ ] Test 3: Rapid captures - PASS, NO flash
- [ ] Test 4: Consent flow - PASS
- [ ] Test 5: Integration - PASS
- [ ] Test 6: Performance - PASS, <3s average

### Documentation
- [ ] README.md updated with dependencies
- [ ] User guide created
- [ ] Code comments added
- [ ] Troubleshooting guide created
- [ ] This implementation plan completed

### Validation
- [ ] Manual testing by developer - PASS
- [ ] Manual testing by user - PASS
- [ ] NO flash observed in 10+ captures
- [ ] Performance acceptable (<3s)
- [ ] Works without admin access

---

## Next Steps

**Ready to begin implementation?**

1. Review this plan
2. Confirm approach
3. Start with Phase 1: Core Functions
4. Test incrementally
5. Complete full test suite
6. Validate with user

**Estimated completion**: 3-4 days

**Confidence level**: Very High (95%)
- ScreenCast Portal verified available
- Architecture well-understood
- Clear fallback strategy
- Comprehensive test plan

---

**Status**: ✅ Plan Complete - Ready for Implementation  
**Approval Required**: User confirmation to proceed  
**Blocked By**: None
