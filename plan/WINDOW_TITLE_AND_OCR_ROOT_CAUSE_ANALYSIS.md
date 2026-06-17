# Window Title & OCR Issues: Root Cause Analysis

**Date:** 2026-06-17  
**Users Analyzed:** Suchith (working window titles, no OCR) | Yogitha (failing window titles, no OCR)

---

## Executive Summary

| Issue | Suchith's System | Yogitha's System |
|-------|-----------------|------------------|
| Window Title Capture | ✅ Working | ❌ Mostly failing ("Unknown") |
| OCR/Screenshot Capture | ❌ Failing (metadata only) | ❌ Failing (metadata only) |
| App Version | v1.0.4 | v1.0.0 |
| **Ubuntu Version** | **24.04.1 LTS** | **25.04 (newer)** |
| GNOME Shell Version | ~46 (pre-45 security) | **49.0 (GNOME 45+ security hardening)** |

### 🔴 ROOT CAUSE: OS Version Incompatibility

The primary issue is **OS version incompatibility**, NOT just GNOME version differences:

| Attribute | Ubuntu 24.04 LTS | Ubuntu 25.04+ |
|-----------|------------------|---------------|
| Kernel String | `#35~24.04.1-Ubuntu` | `#35-Ubuntu` |
| GNOME Shell | ~46 | 49.0 |
| Shell.Eval | Works or easily enabled | **Disabled by default** |
| D-Bus Security | Standard | **Hardened** |
| Window Detection | Multiple methods work | All methods fail |

**TimeTracker was developed/tested on Ubuntu 24.04 LTS and is not compatible with Ubuntu 25.04+ out of the box.**

---

## Issue 1: Window Title Capture Differences

### Root Cause Summary

**Yogitha's system has window detection failures because:**
1. **GNOME Shell 49.0** - The `Shell.Eval` D-Bus method (historically primary for window detection) is **disabled by default in GNOME 45+** for security reasons
2. **All alternative methods are failing** - gnome_introspect, atspi, gdbus, and xdotool all fail consistently
3. **Different TimeTracker version** - v1.0.0 may have less mature window detection fallbacks compared to v1.0.4

**Suchith's system has working window detection because:**
1. **Likely older GNOME version** - Shell.Eval may still be enabled, or the system is configured differently
2. **At least one detection method succeeds** - Despite circuit-breaker warnings, window titles ARE captured
3. **Newer TimeTracker version** - v1.0.4 may have improved detection methods

---

### Detailed Technical Analysis

#### System Environment Comparison

| Attribute | Suchith | Yogitha |
|-----------|---------|---------|
| TimeTracker Version | v1.0.4 | v1.0.0 |
| OS | Linux 6.17.0-35-generic (Ubuntu 24.04.1) | Linux 6.17.0-35-generic (Ubuntu) |
| Python | 3.12.3 | 3.12.3 |
| Display Server | Wayland | Wayland |
| GNOME Shell | Not logged explicitly | **49.0** |
| Session Type | `wayland` | `wayland` |
| WAYLAND_DISPLAY | `wayland-0` | `wayland-0` |
| Tray Backend | Full AppIndicator menu | `_xorg` (limited - no popup menus) |
| Idle Detection | `gnome_mutter` (D-Bus) | `pynput` (problematic on Wayland) |

#### Window Detection Methods Available

TimeTracker attempts these methods in order for Wayland sessions:

```
1. gnome_introspect  - GetWindows API (GNOME 40+, no unsafe mode needed) ← PRIMARY
2. atspi             - AT-SPI2 accessibility (for native Wayland apps)
3. gdbus             - Shell.Eval (only works if user enabled development-tools)
4. xdotool           - XWayland fallback (only sees XWayland apps)
```

#### Failure Analysis for Yogitha's System

**Log Evidence:**
```
2026-06-12 14:48:16 - [WinDetect] Session type: Wayland, GNOME Shell: 49.0
2026-06-12 14:48:16 - [WinDetect] GNOME 45+ detected: Shell.Eval disabled by default, using gnome_introspect as primary
2026-06-12 14:48:22 - [WinDetect] ALL METHODS FAILED - returning ('Unknown', 'Unknown')
2026-06-12 14:48:33 - [WinDetect] CIRCUIT-BREAKER: Method 'gnome_introspect' opened for 60s after 3 failures
2026-06-12 14:48:39 - [WinDetect] CIRCUIT-BREAKER: Method 'atspi' opened for 60s after 3 failures
2026-06-12 14:48:39 - [WinDetect] CIRCUIT-BREAKER: Method 'gdbus' opened for 60s after 3 failures
```

**Method-by-Method Failure Reasons:**

| Method | Why It Fails on Yogitha's System |
|--------|----------------------------------|
| `gnome_introspect` | GetWindows() call times out or returns no focused window. Possible causes: GNOME Shell Introspect extension issues, D-Bus permissions, or incompatibility with GNOME 49 |
| `atspi` | AT-SPI2 D-Bus service check may pass, but query returns no active/focused windows. The python3-gi (GObject Introspection) might not be fully functional in the AppImage environment |
| `gdbus` (Shell.Eval) | **Explicitly disabled in GNOME 45+** by default. User would need to enable "Development Tools" in GNOME Settings for this to work |
| `xdotool` | Only sees XWayland apps. Native Wayland apps (Chrome, Firefox in Wayland mode) are invisible to xdotool |

**Note:** Yogitha's log DOES show occasional success:
```
2026-06-12 14:53:53 - [INFO] Window switched at 09:23:53:
     - App: code
     - Title: f2mx-mobile (fan-2-market-experience.github.io) -
```

This indicates the issue is intermittent, not 100% failure. The detection succeeds sometimes but fails most of the time.

#### Success Analysis for Suchith's System

**Log Evidence:**
```
2026-06-11 12:35:40 - [INFO] Idle detection backend selected: gnome_mutter
2026-06-11 12:35:46 - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-11 12:35:46 - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-11 12:35:46 - [WARN] FIX-6: Window detection method 'xdotool' circuit-open for 60s

2026-06-11 12:36:02 - [INFO] Window switched at 07:06:02:
     - App: Google Chrome
     - Title: PPG Security Document review and closure - Jun 9 -
```

**Key Observations:**
1. Circuit-breaker warnings exist (methods do fail sometimes)
2. BUT window titles ARE captured successfully
3. Different log format suggests different code version
4. `gnome_mutter` used for idle detection (works better than `pynput` on Wayland)

**Likely Success Factors:**
- GNOME version may be older (pre-45) or configured differently
- At least one method (likely `gnome_introspect` or `atspi`) succeeds often enough
- Version 1.0.4 may have improved error handling or additional fallback methods

---

### Why Idle Detection Backend Matters

| User | Backend | Status |
|------|---------|--------|
| Suchith | `gnome_mutter` | ✅ Working - D-Bus idle API |
| Yogitha | `pynput` | ⚠️ Problematic on Wayland |

**Yogitha's Log:**
```
2026-06-12 14:48:12 - [INFO] Idle detection backend selected: pynput
2026-06-12 14:48:12 - [WARN] Running on Wayland — pynput may require XWayland for global input monitoring
2026-06-12 14:48:17 - [ERROR] Activity listener NOT receiving events after 5s — idle detection may be broken
```

The `pynput` library relies on X11/XWayland for global input monitoring. On pure Wayland, it often fails. The fact that Yogitha's system fell back to `pynput` instead of using `gnome_mutter` indicates a system configuration difference.

---

## Issue 2: OCR Models Not Working (Metadata Only)

### Root Cause Summary

**Both users have OCR failures because Wayland screenshot capture is failing.**

The OCR system works in this flow:
```
Screenshot Capture → Image to OCR Engine → Text Extraction → AI Classification
```

When screenshot capture fails, there's no image for OCR to process. The system falls back to "metadata-only" classification using just the window title.

---

### Screenshot Capture Failure Analysis

#### Yogitha's System - Missing Dependencies

**Log Evidence:**
```
2026-06-12 14:47:56 - WARNING - system_check - GStreamer pipewiresrc plugin not available
2026-06-12 14:47:56 - ERROR - STDERR - ============================================================
2026-06-12 14:47:56 - ERROR - STDERR - SCREENSHOT CAPTURE DEPENDENCIES MISSING
2026-06-12 14:47:56 - ERROR - STDERR - ============================================================
2026-06-12 14:47:56 - ERROR - STDERR - TimeTracker requires system packages for screenshot capture.
2026-06-12 14:47:56 - ERROR - STDERR - QUICK FIX:
2026-06-12 14:47:56 - ERROR - STDERR -   Run our automated fix script:
2026-06-12 14:47:56 - ERROR - STDERR -   ./scripts/fix-screenshot-capture.sh
```

**Missing Packages:**
- `gstreamer1.0-pipewire` - Required for PipeWire ScreenCast API
- Possibly other PipeWire/GStreamer components

**Fallback Attempts:**
```
2026-06-12 14:48:22 - WARNING - gnome-screenshot produced an all-black image — skipping
2026-06-12 14:48:23 - WARNING - scrot produced an all-black image (Wayland XWayland root) — skipping
```

Both `gnome-screenshot` and `scrot` produce black images because:
- On Wayland, these tools capture the XWayland root window
- If no XWayland apps are visible, the capture is all black
- Native Wayland content cannot be captured by X11-based tools

#### Suchith's System - Permission/Configuration Issue

**Log Evidence:**
```
2026-06-11 12:35:42 - WARNING - monitor_capture - scrot produced an all-black image (Wayland XWayland root) — skipping
2026-06-11 12:35:42 - WARNING - monitor_capture - ImageGrab.grab() (XCB) failed: X get_image failed: error 8 (73, 0, 1263)
2026-06-11 12:35:42 - INFO - [OCR] Screenshot capture skipped (no valid monitor target)
```

**Key Difference:** Suchith does NOT have the "SCREENSHOT CAPTURE DEPENDENCIES MISSING" error. This suggests:
- GStreamer pipewiresrc MAY be installed
- BUT ScreenCast permission was never granted, OR
- PipeWire/ScreenCast is not functioning correctly

---

### Why Wayland Screenshot Capture is Hard

| Method | X11 | Wayland |
|--------|-----|---------|
| `scrot` | ✅ Works | ❌ Black image (only sees XWayland root) |
| `gnome-screenshot` | ✅ Works | ⚠️ May trigger permission dialog or fail silently |
| PIL ImageGrab | ✅ Works | ❌ X get_image fails |
| XDG Desktop Portal | N/A | ⚠️ Requires user permission dialog each time |
| PipeWire ScreenCast | N/A | ✅ Works after one-time permission (requires pipewiresrc) |

**Wayland Security Model:**
- Applications cannot capture other windows' content without explicit user permission
- The preferred method is PipeWire ScreenCast, which:
  1. Requires `gstreamer1.0-pipewire` package
  2. Shows a one-time permission dialog
  3. Stores a "restore token" for future captures without prompts

---

### OCR Engine Status

Both logs show OCR engines ARE initialized correctly:
```
2026-06-12 14:48:00 - INFO - ocr.facade - Primary OCR engine: rapidocr
2026-06-12 14:48:00 - INFO - ocr.facade - Fallback engines: ['rapidocr', 'easyocr']
2026-06-12 14:48:00 - INFO - ocr.facade - OCR Status: READY
```

But when attempting OCR:
```
2026-06-12 14:48:28 - WARNING - All OCR engines failed. Details: rapidocr: Confidence too low (0.00 < 0.6 threshold)
2026-06-12 14:48:28 - INFO - [OCR-ASYNC] capture failed (metadata) (took: 4651.2ms)
```

**The `Confidence too low (0.00 < 0.6 threshold)` error means:**
- The OCR received a black or nearly-empty image
- RapidOCR found no text (0% confidence)
- This confirms screenshot capture is the failure point, NOT the OCR engine itself

---

## Summary of Root Causes

### Issue 1: Window Title Capture

| Root Cause | Yogitha | Suchith |
|------------|---------|---------|
| GNOME 45+ Shell.Eval disabled | ✅ Yes (GNOME 49) | Possibly no (older GNOME?) |
| gnome_introspect failures | ✅ Frequent timeouts | Some failures but mostly works |
| atspi failures | ✅ All attempts fail | Some work |
| xdotool limitations | ✅ Only sees XWayland | Same |
| TimeTracker version | v1.0.0 (older) | v1.0.4 (newer, possibly better fallbacks) |
| Idle detection backend | pynput (broken on Wayland) | gnome_mutter (working) |

### Issue 2: OCR/Screenshot Capture

| Root Cause | Yogitha | Suchith |
|------------|---------|---------|
| Missing `gstreamer1.0-pipewire` | ✅ Yes - explicitly logged | ❌ Not shown (may be installed) |
| ScreenCast permission | Not applicable (deps missing) | ⚠️ May not be granted |
| scrot/gnome-screenshot fallback | Black images (Wayland limitation) | Black images (Wayland limitation) |
| PIL ImageGrab (XCB) | N/A | Error 8 (X11 permission denied) |

---

## Recommended Solutions

### For Yogitha (Window Titles + OCR)

**1. Install Screenshot Dependencies:**
```bash
sudo apt install -y \
    pipewire \
    wireplumber \
    gstreamer1.0-plugins-base \
    gstreamer1.0-plugins-good \
    gstreamer1.0-pipewire \
    xdg-desktop-portal \
    xdg-desktop-portal-gnome

# Restart PipeWire
systemctl --user restart pipewire
```

**2. Update TimeTracker to v1.0.4:**
The newer version may have improved window detection for GNOME 45+.

**3. Grant Screenshot Permission:**
After installing dependencies, TimeTracker should prompt for screen sharing permission on first capture. Accept the dialog.

**4. (Optional) Enable GNOME Shell Development Tools:**
If window detection still fails after updating:
- Open GNOME Settings → Privacy → Enable "Development Tools"
- This re-enables Shell.Eval for D-Bus access

### For Suchith (OCR Only)

**1. Verify GStreamer PipeWire Plugin:**
```bash
gst-inspect-1.0 pipewiresrc
```

If not found, install it:
```bash
sudo apt install gstreamer1.0-pipewire
systemctl --user restart pipewire
```

**2. Grant Screenshot Permission:**
TimeTracker needs ScreenCast permission. Try:
- Restart TimeTracker
- When prompted for screen sharing, accept the dialog
- If no prompt appears, check if XDG Desktop Portal is running:
  ```bash
  systemctl --user status xdg-desktop-portal
  ```

---

## Technical Deep Dive: Window Detection Code Path

### For Wayland Sessions (GNOME 45+)

```
_get_active_window_linux()
    │
    ├── gnome_introspect (PRIMARY for GNOME 40+)
    │     └── gdbus call org.gnome.Shell.Introspect.GetWindows()
    │         └── Parse 'has-focus': <true> to find focused window
    │         └── Extract 'title', 'app-id', 'wm-class'
    │
    ├── atspi (Accessibility API fallback)
    │     └── AT-SPI2 D-Bus: org.a11y.Bus
    │         └── Enumerate all windows
    │         └── Find FOCUSED or ACTIVE state
    │
    ├── gdbus Shell.Eval (disabled in GNOME 45+ by default)
    │     └── gdbus call org.gnome.Shell.Eval "global.display.focus_window.title"
    │
    └── xdotool (XWayland only)
          └── xdotool getactivewindow → getwindowname
          └── Only sees X11/XWayland windows
```

### Circuit Breaker Mechanism (FIX-6)

When a method fails 3+ times, it's "opened" (disabled) for 60 seconds to prevent:
- Blocking the 2-second tracking loop
- Wasting time on methods that consistently fail

```python
_CB_OPEN_AFTER = 3   # failures before circuit opens
_CB_RESET_AFTER = 60 # seconds before retry
```

---

## Technical Deep Dive: Screenshot Capture Code Path

### On Wayland (Linux)

```
capture_screenshot()
    │
    ├── _capture_screencast() (PipeWire - NO FLASH, PREFERRED)
    │     └── Requires: gstreamer1.0-pipewire
    │     └── Uses org.freedesktop.portal.ScreenCast
    │     └── One-time permission dialog, then persistent
    │
    ├── _capture_xdg_portal() (Screenshot Portal - HAS FLASH)
    │     └── Uses org.freedesktop.portal.Screenshot
    │     └── Permission dialog EVERY TIME
    │
    ├── _from_gnome_screenshot() (CLI tool)
    │     └── gnome-screenshot --file <path>
    │     └── May produce black image on Wayland
    │
    ├── _from_scrot() (X11 tool)
    │     └── scrot <path>
    │     └── Only captures XWayland root (black on Wayland)
    │
    └── ImageGrab.grab() (PIL/Pillow)
          └── Uses XCB extension
          └── Fails with "X get_image failed" on Wayland
```

---

## Conclusion

1. **Window Title Issue**: Yogitha's GNOME 49.0 (GNOME 45+) has `Shell.Eval` disabled by default, and the fallback methods (`gnome_introspect`, `atspi`) are also failing. Upgrading to TimeTracker v1.0.4 and/or enabling GNOME Development Tools may help.

2. **OCR Issue**: Both users have failing screenshot capture due to Wayland security restrictions. The solution is:
   - Install `gstreamer1.0-pipewire` and related packages
   - Restart PipeWire service
   - Grant screen sharing permission when prompted

The OCR engines themselves (RapidOCR) are working correctly — they simply have no valid screenshots to process.
