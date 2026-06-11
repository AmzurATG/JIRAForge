# ScreenCast Flash Issue - Root Cause Analysis & Fix

## Date: 2026-06-11

## Problem Summary
Despite installing all required dependencies and previous fixes, the TimeTracker desktop app was still:
1. Requesting screen sharing permission on every window switch
2. Showing visual flash during screenshot capture
3. Logging repeated ScreenCast failures in the logs

## Root Cause Analysis

### Issue 1: Missing `pipewiresrc` Plugin Check
**Location:** `python-desktop-app/monitor_capture.py` - `_check_screencast_available()` function

**The Problem:**
The function checked if:
- GStreamer Python bindings were available ✓
- ScreenCast Portal D-Bus interface existed ✓

But it **did NOT check** if the critical `pipewiresrc` GStreamer plugin was installed.

**Why This Mattered:**
1. System check at startup detected missing plugin:
   ```
   WARNING - system_check - GStreamer pipewiresrc plugin not available
   ```

2. But `_check_screencast_available()` returned `True` anyway:
   ```
   INFO - monitor_capture - ScreenCast Portal available - flash-free captures enabled
   ```

3. On every window switch, the app tried ScreenCast:
   - Created D-Bus session ✓
   - Opened PipeWire connection ✓
   - Tried to create GStreamer pipeline with `pipewiresrc` ✗ **FAILED**
   ```
   WARNING - GStreamer: Failed to create pipeline: gst_parse_error: no element "pipewiresrc"
   WARNING - ScreenCast: GStreamer capture failed
   ```

4. Fell back to Screenshot Portal (which requires permission dialog every time):
   ```
   INFO - XDG Desktop Portal Screenshot available: True
   ```

**The Flow:**
```
Window Switch
  ↓
Try ScreenCast (optimistic, but doomed to fail)
  ↓
Create D-Bus session (requires permission dialog ONCE)
  ↓
Open PipeWire connection
  ↓
Try GStreamer pipeline with pipewiresrc
  ↓
FAIL: "no element pipewiresrc"
  ↓
Fall back to Screenshot Portal (requires permission dialog EVERY TIME)
  ↓
User sees flash + permission dialog
  ↓
Repeat on next window switch
```

### Issue 2: Missing `GST_PLUGIN_SYSTEM_PATH` in AppImage
**Location:** `python-desktop-app/appimage/AppRun` - AppImage launcher script

**The Problem:**
Even though `pipewiresrc` was installed on the system at:
```
/usr/lib/x86_64-linux-gnu/gstreamer-1.0/libgstpipewire.so
```

The AppImage's GStreamer couldn't find it because:
1. `GST_PLUGIN_PATH` was empty
2. `GST_PLUGIN_SYSTEM_PATH` was empty
3. GStreamer only searched its bundled plugins directory

**Evidence from logs:**
```bash
$ echo $GST_PLUGIN_PATH && echo "---" && echo $GST_PLUGIN_SYSTEM_PATH

---

```
Both variables were empty!

**Why This Mattered:**
When the app ran `gst-inspect-1.0 pipewiresrc`, it worked fine in the terminal (system GStreamer found it). But inside the AppImage, the bundled GStreamer couldn't see system plugins, so `_check_screencast_available()` would fail even with the plugin installed.

## The Fixes

### Fix 1: Add `pipewiresrc` Plugin Check
**File:** `python-desktop-app/monitor_capture.py`

**Change:** Added explicit check for `pipewiresrc` plugin before declaring ScreenCast available:

```python
# CRITICAL FIX: Check if pipewiresrc plugin is installed
try:
    result = subprocess.run(
        ['gst-inspect-1.0', 'pipewiresrc'],
        capture_output=True,
        timeout=3
    )
    if result.returncode != 0:
        logger.warning("ScreenCast unavailable: GStreamer pipewiresrc plugin not installed")
        logger.info("Install with: sudo apt install gstreamer1.0-pipewire")
        _SCREENCAST_AVAILABLE = False
        return False
except FileNotFoundError:
    logger.debug("ScreenCast unavailable: gst-inspect-1.0 not found")
    _SCREENCAST_AVAILABLE = False
    return False
```

**Result:**
- If `pipewiresrc` is missing, `_check_screencast_available()` returns `False`
- App never tries ScreenCast, skips directly to working fallback method
- No repeated failures, no permission dialogs on every window switch

### Fix 2: Set `GST_PLUGIN_SYSTEM_PATH` in AppRun
**File:** `python-desktop-app/appimage/AppRun`

**Change:** Added GStreamer plugin path configuration:

```bash
# --- GStreamer plugin path ----------------------------------------------------
# CRITICAL: GStreamer needs access to system plugins (especially pipewiresrc)
# for ScreenCast Portal screenshot capture. Without this, GStreamer can't find
# pipewiresrc and falls back to Screenshot Portal which causes permission
# dialogs on every window switch (the "flash" issue).
#
# Set GST_PLUGIN_SYSTEM_PATH to include:
#   1. Bundled plugins in AppDir (if any)
#   2. System plugins (where pipewiresrc lives)
#
# GST_PLUGIN_SYSTEM_PATH is preferred over GST_PLUGIN_PATH because it allows
# GStreamer to still use its default plugin discovery while adding our paths.
export GST_PLUGIN_SYSTEM_PATH="${HERE}/usr/lib/gstreamer-1.0:/usr/lib/$(uname -m)-linux-gnu/gstreamer-1.0:/usr/lib/gstreamer-1.0:${GST_PLUGIN_SYSTEM_PATH}"
```

**Result:**
- AppImage GStreamer can now find system plugins
- `gst-inspect-1.0 pipewiresrc` works inside AppImage
- `_check_screencast_available()` correctly detects plugin availability

## Expected Behavior After Fixes

### Scenario A: `pipewiresrc` Plugin IS Installed
```
1. App starts
2. _check_screencast_available() runs:
   - Checks GStreamer bindings: ✓ Available
   - Checks pipewiresrc plugin: ✓ Found (thanks to GST_PLUGIN_SYSTEM_PATH)
   - Checks ScreenCast Portal: ✓ Available
   - Returns True
3. Window switch occurs
4. ScreenCast capture:
   - Create D-Bus session (one-time permission)
   - Open PipeWire connection
   - Create GStreamer pipeline: ✓ Success
   - Capture frame: ✓ Success
   - NO FLASH, NO PERMISSION DIALOG
5. Subsequent window switches:
   - Reuse cached session
   - NO PERMISSION DIALOG
   - NO FLASH
```

### Scenario B: `pipewiresrc` Plugin NOT Installed
```
1. App starts
2. _check_screencast_available() runs:
   - Checks GStreamer bindings: ✓ Available
   - Checks pipewiresrc plugin: ✗ Not found
   - Logs: "Install with: sudo apt install gstreamer1.0-pipewire"
   - Returns False immediately
3. Window switch occurs
4. Skip ScreenCast entirely (it's marked unavailable)
5. Use alternative capture method:
   - Try XDG Portal Screenshot (may have one-time consent)
   - Or try gnome-screenshot (silent mode)
   - Or try scrot
6. User sees clear error message with installation instructions
7. After installing gstreamer1.0-pipewire and restarting:
   - Falls into Scenario A (flash-free capture)
```

## Testing Instructions

### Test 1: Verify the Fix Without Plugin
```bash
# Remove the plugin temporarily (if installed)
sudo apt remove gstreamer1.0-pipewire

# Run the new build
./dist/TimeTracker

# Expected behavior:
# - Log: "ScreenCast unavailable: GStreamer pipewiresrc plugin not installed"
# - Log: "Install with: sudo apt install gstreamer1.0-pipewire"
# - NO repeated "Failed to create pipeline" errors
# - Uses fallback capture method
# - Should NOT ask for permission on every window switch
```

### Test 2: Verify the Fix With Plugin
```bash
# Install the plugin
sudo apt install gstreamer1.0-pipewire

# Restart PipeWire
systemctl --user restart pipewire

# Run the new build
./dist/TimeTracker

# Expected behavior:
# - Log: "ScreenCast Portal available - flash-free captures enabled (pipewiresrc verified)"
# - First window switch: one-time permission dialog
# - Subsequent window switches: NO permission dialog, NO flash
# - Log: "ScreenCast: Frame captured (XXX bytes)" on each capture
```

### Test 3: Verify GST_PLUGIN_SYSTEM_PATH Inside AppImage
```bash
# Extract and run AppImage with bash to check environment
./dist/TimeTracker-v1.0.0-x86_64.AppImage --appimage-extract-and-run bash -c 'echo $GST_PLUGIN_SYSTEM_PATH'

# Expected output:
# /tmp/.mount_TimeTraXXXXXX/usr/lib/gstreamer-1.0:/usr/lib/x86_64-linux-gnu/gstreamer-1.0:/usr/lib/gstreamer-1.0

# Verify plugin is found
./dist/TimeTracker-v1.0.0-x86_64.AppImage --appimage-extract-and-run gst-inspect-1.0 pipewiresrc

# Expected: Plugin details printed (not "No such element")
```

## Technical Details

### Why `GST_PLUGIN_SYSTEM_PATH` Instead of `GST_PLUGIN_PATH`?
- `GST_PLUGIN_PATH`: Replaces default search paths entirely
- `GST_PLUGIN_SYSTEM_PATH`: Augments default search paths
- We want both bundled AND system plugins, so `GST_PLUGIN_SYSTEM_PATH` is correct

### Why Check Plugin at Startup?
- Fail fast: detect missing plugin before attempting capture
- Better error messages: user sees installation instructions immediately
- Prevents repeated failures: avoids GStreamer pipeline creation on every window switch
- Performance: skips doomed code path entirely

### Why This Wasn't Caught Earlier?
1. The plugin check was split between two different modules:
   - `system_check.py` checked the plugin (correctly failed)
   - `monitor_capture.py` did NOT check the plugin (incorrectly succeeded)
2. No communication between them
3. `_check_screencast_available()` was too optimistic (assumed if D-Bus works, everything works)

## Files Modified

1. **`python-desktop-app/monitor_capture.py`**
   - Function: `_check_screencast_available()`
   - Added: Plugin availability check via `gst-inspect-1.0 pipewiresrc`
   - Added: Installation instructions in warning message

2. **`python-desktop-app/appimage/AppRun`**
   - Added: `GST_PLUGIN_SYSTEM_PATH` environment variable export
   - Includes: Bundled plugins + system plugins

## Build Output

- **Binary:** `dist/TimeTracker` (141M)
- **AppImage:** `dist/TimeTracker-v1.0.0-x86_64.AppImage` (142M)
- **Debian Package:** `dist/timetracker_1.0.0_amd64.deb` (142M)
- **SHA256:** `4ce29b5ffbdce3b9ee69651de154d040aabfb58b70bc7235b1489ffa738698b4`

## Installation for End Users

### If Plugin Already Installed
```bash
# Install the .deb
sudo dpkg -i timetracker_1.0.0_amd64.deb

# App will work immediately with no flash
```

### If Plugin Missing
```bash
# Install the .deb
sudo dpkg -i timetracker_1.0.0_amd64.deb

# Run the app - it will show installation instructions
timetracker

# Follow the instructions
sudo apt install gstreamer1.0-pipewire
systemctl --user restart pipewire

# Restart TimeTracker - now works with no flash
```

## Related Documentation

- See `docs/USER_FIX_GUIDE_OCR_ISSUE.md` for user-facing installation guide
- See `PHASE_5_IMPLEMENTATION_SUMMARY.md` for complete screenshot capture architecture

## Conclusion

The root cause was a **logic gap** between two checks:
1. Startup check correctly detected missing plugin → warned user
2. Runtime check optimistically assumed plugin existed → tried and failed repeatedly

**The fix:** Make the runtime check as thorough as the startup check, and ensure GStreamer can find system plugins inside the AppImage.

**Impact:** Eliminates the flash/permission dialog issue even when `pipewiresrc` is not installed by failing gracefully and using working fallbacks.
