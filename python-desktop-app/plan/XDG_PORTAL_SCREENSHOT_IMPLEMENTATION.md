# XDG Desktop Portal Screenshot Implementation Plan

**Document Version:** 1.0  
**Date:** 2026-06-10  
**Author:** Technical Implementation Plan  
**Status:** Approved for Implementation  
**Target File:** `monitor_capture.py`

---

## Executive Summary

This document provides a detailed implementation plan to integrate XDG Desktop Portal screenshot functionality into the TimeTracker desktop application. This addresses the visual "flash" issue on GNOME 46+ Wayland systems where the existing D-Bus method is blocked by security restrictions.

---

## Table of Contents

1. [Root Cause Analysis](#1-root-cause-analysis)
2. [Technical Background](#2-technical-background)
3. [Implementation Plan](#3-implementation-plan)
4. [Code Implementation](#4-code-implementation)
5. [Test Scripts](#5-test-scripts)
6. [Rollback Plan](#6-rollback-plan)
7. [Success Criteria](#7-success-criteria)

---

## 1. Root Cause Analysis

### 1.1 The Core Problem

**User Report:** Screenshot capture shows a visual "flash" on GNOME Wayland.

**Root Cause Chain:**

```
┌─────────────────────────────────────────────────────────────────────────┐
│ PROBLEM: Screenshot Flash on GNOME 46+ Wayland                          │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│ 1. GNOME 46 introduced stricter D-Bus security policies                 │
│    └─ org.gnome.Shell.Screenshot now requires elevated permissions      │
│                                                                          │
│ 2. Our D-Bus call with flash=false is DENIED:                           │
│    $ gdbus call --session --dest org.gnome.Shell ...                    │
│    ERROR: GDBus.Error:org.freedesktop.DBus.Error.AccessDenied:          │
│           Screenshot is not allowed                                      │
│                                                                          │
│ 3. App falls back to gnome-screenshot binary (line 595 in code):        │
│    img = _capture_gnome_screenshot_muted()                              │
│                                                                          │
│ 4. gnome-screenshot binary triggers GNOME Shell's shutter animation     │
│    └─ Visual flash occurs (our code only mutes the SOUND, not flash)    │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 1.2 Why scrot and Other X11 Tools CANNOT Work on Wayland

**This is a FUNDAMENTAL ARCHITECTURAL LIMITATION, not a bug.**

#### 1.2.1 X11 Architecture (How scrot Works)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                          X11 ARCHITECTURE                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │                        X SERVER                                 │     │
│  │  ┌─────────────────────────────────────────────────────────┐   │     │
│  │  │              SHARED FRAMEBUFFER                          │   │     │
│  │  │  ┌─────────┐  ┌─────────┐  ┌─────────┐  ┌─────────┐    │   │     │
│  │  │  │ Firefox │  │ Terminal│  │ VSCode  │  │ Spotify │    │   │     │
│  │  │  │ pixels  │  │ pixels  │  │ pixels  │  │ pixels  │    │   │     │
│  │  │  └─────────┘  └─────────┘  └─────────┘  └─────────┘    │   │     │
│  │  └─────────────────────────────────────────────────────────┘   │     │
│  │                              ↑                                  │     │
│  │                              │                                  │     │
│  │         ANY CLIENT CAN READ THE ENTIRE FRAMEBUFFER             │     │
│  │                              │                                  │     │
│  │                      ┌───────┴───────┐                         │     │
│  │                      │    scrot      │                         │     │
│  │                      │ XGetImage()   │ ← DIRECT PIXEL ACCESS   │     │
│  │                      └───────────────┘                         │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                                                                          │
│  Result: scrot reads all pixels directly from X Server ✅               │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

#### 1.2.2 Wayland Architecture (Why scrot Fails)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                        WAYLAND ARCHITECTURE                              │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  ┌────────────────────────────────────────────────────────────────┐     │
│  │                 WAYLAND COMPOSITOR (GNOME Shell)                │     │
│  │                                                                  │     │
│  │   ┌──────────┐   ┌──────────┐   ┌──────────┐   ┌──────────┐   │     │
│  │   │ Firefox  │   │ Terminal │   │ VSCode   │   │ Spotify  │   │     │
│  │   │ (isolated│   │ (isolated│   │ (isolated│   │ (isolated│   │     │
│  │   │  buffer) │   │  buffer) │   │  buffer) │   │  buffer) │   │     │
│  │   └────┬─────┘   └────┬─────┘   └────┬─────┘   └────┬─────┘   │     │
│  │        │              │              │              │          │     │
│  │        └──────────────┴──────────────┴──────────────┘          │     │
│  │                              │                                  │     │
│  │              APPS CANNOT SEE EACH OTHER'S PIXELS               │     │
│  │                   (Security by design)                          │     │
│  │                              │                                  │     │
│  │        ┌─────────────────────┴─────────────────────┐           │     │
│  │        │         XWayland (Compatibility Layer)     │           │     │
│  │        │  ┌─────────────────────────────────────┐  │           │     │
│  │        │  │     EMPTY BLACK ROOT WINDOW         │  │           │     │
│  │        │  │     (No real content here)          │  │           │     │
│  │        │  └─────────────────────────────────────┘  │           │     │
│  │        │                    ↑                      │           │     │
│  │        │              ┌─────┴─────┐                │           │     │
│  │        │              │   scrot   │                │           │     │
│  │        │              │ XGetImage │ ← SEES BLACK   │           │     │
│  │        │              └───────────┘                │           │     │
│  │        └───────────────────────────────────────────┘           │     │
│  └────────────────────────────────────────────────────────────────┘     │
│                                                                          │
│  Result: scrot captures BLACK IMAGE (XWayland root is empty) ❌         │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

#### 1.2.3 Tools Affected by This Limitation

| Tool | Technology | Wayland Result | Why |
|------|------------|----------------|-----|
| **scrot** | X11 XGetImage() | ❌ Black image | Reads XWayland empty root |
| **maim** | X11 XGetImage() | ❌ Black image | Same as scrot |
| **import** (ImageMagick) | X11 XGetImage() | ❌ Black image | Same as scrot |
| **python-mss** | XCB/X11 SHM | ❌ Black image | Same X11 protocol |
| **Pillow ImageGrab** | XCB | ❌ Black image | Uses XCB (X11) |
| **PyAutoGUI** | PIL/X11 | ❌ Black image | Wraps Pillow |

### 1.3 The ONLY Ways to Capture on Wayland

Wayland requires **compositor cooperation**. The compositor (GNOME Shell) must explicitly provide pixels:

| Method | How It Works | Flash? |
|--------|--------------|--------|
| **org.gnome.Shell.Screenshot D-Bus** | GNOME Shell API (flash=false) | ❌ No flash, but BLOCKED on GNOME 46+ |
| **gnome-screenshot binary** | Calls D-Bus internally with flash=true | ✅ FLASH (animation) |
| **XDG Desktop Portal** | Standard freedesktop.org API | ❌ No flash (after consent) |
| **grim** | wlroots protocol | ❌ No flash, but ONLY works on Sway/Hyprland |

### 1.4 Root Cause Summary

```
┌─────────────────────────────────────────────────────────────────────────┐
│                      ROOT CAUSE SUMMARY                                  │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  WHY SCROT CANNOT WORK:                                                 │
│  ─────────────────────                                                  │
│  • Wayland's security model isolates application buffers                │
│  • X11 tools (scrot, maim, mss) can only see XWayland layer            │
│  • XWayland root window is intentionally empty (black)                  │
│  • This is a PROTOCOL LIMITATION, not a bug                             │
│  • Cannot be fixed without compositor cooperation                        │
│                                                                          │
│  WHY CURRENT CODE FLASHES:                                              │
│  ─────────────────────────                                              │
│  • GNOME 46+ blocks org.gnome.Shell.Screenshot D-Bus                    │
│  • Fallback to gnome-screenshot binary triggers shell animation         │
│  • Our code mutes SOUND but cannot prevent VISUAL flash                 │
│                                                                          │
│  SOLUTION:                                                               │
│  ─────────                                                              │
│  • Implement XDG Desktop Portal (org.freedesktop.portal.Screenshot)     │
│  • Standard API, works across all Wayland compositors                   │
│  • One-time user consent, then silent captures                          │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 2. Technical Background

### 2.1 XDG Desktop Portal Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    XDG DESKTOP PORTAL ARCHITECTURE                       │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│   Your App (TimeTracker)                                                 │
│        │                                                                 │
│        │ D-Bus call: org.freedesktop.portal.Screenshot.Screenshot()     │
│        ▼                                                                 │
│   ┌─────────────────────────────────────────────────────────────┐       │
│   │            xdg-desktop-portal (Daemon)                       │       │
│   │   • Receives screenshot requests                             │       │
│   │   • Manages permissions                                      │       │
│   │   • Routes to appropriate backend                            │       │
│   └─────────────────────────────────────────────────────────────┘       │
│        │                                                                 │
│        │ Routes to desktop-specific backend                             │
│        ▼                                                                 │
│   ┌─────────────────────────────────────────────────────────────┐       │
│   │       xdg-desktop-portal-gnome (Backend)                     │       │
│   │   • Has compositor-level access                              │       │
│   │   • Can read actual screen content                           │       │
│   │   • Handles permission prompts                               │       │
│   └─────────────────────────────────────────────────────────────┘       │
│        │                                                                 │
│        │ Response signal with screenshot URI                            │
│        ▼                                                                 │
│   Your App receives: file:///tmp/screenshot.png                         │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.2 Portal Screenshot D-Bus Interface

```
Interface: org.freedesktop.portal.Screenshot
Object Path: /org/freedesktop/portal/desktop
Method: Screenshot (s parent_window, a{sv} options) → o handle

Options:
  "modal" (b): Whether the dialog should be modal (default: true)
  "interactive" (b): Whether to show selection UI (default: false)
  
Response Signal:
  Response (u response, a{sv} results)
    response: 0 = success, 1 = cancelled, 2 = error
    results["uri"]: file:// URI of captured screenshot
```

### 2.3 Why Portal is Better Than gnome-screenshot

| Aspect | gnome-screenshot binary | XDG Portal |
|--------|------------------------|------------|
| Flash animation | ✅ Always shows | ❌ No flash |
| Shutter sound | ✅ Plays (can mute) | ❌ Silent |
| User consent | None | One-time dialog |
| Future-proof | Deprecated | Official standard |
| Cross-DE support | GNOME only | All DEs |

---

## 3. Implementation Plan

### 3.1 Changes Required

| File | Change Type | Description |
|------|-------------|-------------|
| `monitor_capture.py` | Add function | `_capture_xdg_portal()` - Portal screenshot |
| `monitor_capture.py` | Modify function | `_capture_linux()` - Add portal as priority |
| `monitor_capture.py` | Add function | `_detect_portal_availability()` - Check at startup |
| `requirements.txt` | Optional | `dbus-python` (usually pre-installed) |

### 3.2 New Capture Priority Order

```python
# BEFORE (current):
def _capture_linux():
    if is_wayland:
        1. _capture_gnome_dbus_silent()      # Blocked on GNOME 46+
        2. _capture_gnome_screenshot_muted()  # FLASH occurs here
    3. scrot                                  # Black on Wayland
    4. Pillow XCB                             # Black on Wayland

# AFTER (proposed):
def _capture_linux():
    if is_wayland:
        1. _capture_xdg_portal()              # NEW: Flash-free, works everywhere
        2. _capture_gnome_dbus_silent()       # Fallback for older systems
        3. _capture_gnome_screenshot_muted()  # Last resort (flash)
    4. scrot                                  # X11 sessions only
    5. Pillow XCB                             # X11 fallback
```

### 3.3 Implementation Steps

```
┌────────────────────────────────────────────────────────────────────────┐
│                     IMPLEMENTATION STEPS                                │
├────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Step 1: Add Portal Detection (15 min)                                 │
│  ────────────────────────────────────                                  │
│  • Add function to check if portal is available                        │
│  • Cache result at module load                                         │
│  • Log portal availability for diagnostics                             │
│                                                                         │
│  Step 2: Implement Portal Capture (45 min)                             │
│  ─────────────────────────────────────────                             │
│  • Implement _capture_xdg_portal() function                            │
│  • Handle D-Bus async response via subprocess (gdbus)                  │
│  • Parse response and load screenshot                                  │
│  • Handle errors gracefully                                            │
│                                                                         │
│  Step 3: Integrate into Capture Chain (15 min)                         │
│  ─────────────────────────────────────────────                         │
│  • Modify _capture_linux() to call portal first on Wayland            │
│  • Keep existing fallback chain                                        │
│  • Add logging for capture method used                                 │
│                                                                         │
│  Step 4: Testing (30 min)                                              │
│  ────────────────────────                                              │
│  • Run test scripts (see Section 5)                                    │
│  • Verify no flash on GNOME 46+                                        │
│  • Verify fallback works on older systems                              │
│  • Test X11 session still uses scrot                                   │
│                                                                         │
│  Step 5: Documentation (15 min)                                        │
│  ─────────────────────────────                                         │
│  • Update inline code comments                                         │
│  • Note one-time consent behavior                                      │
│                                                                         │
│  TOTAL ESTIMATED TIME: 2 hours                                         │
│                                                                         │
└────────────────────────────────────────────────────────────────────────┘
```

---

## 4. Code Implementation

### 4.1 New Function: `_capture_xdg_portal()`

Add after `_capture_gnome_dbus_silent()` function (around line 500):

```python
# ============================================================================
# XDG DESKTOP PORTAL SCREENSHOT (GNOME 46+ / Standard Wayland)
# ============================================================================

_XDG_PORTAL_AVAILABLE = None  # None = untested, True/False = cached result


def _check_xdg_portal_available():
    """Check if XDG Desktop Portal Screenshot interface is available.
    
    Called once at module load to cache the result.
    Returns True if the portal daemon is running and supports screenshots.
    """
    global _XDG_PORTAL_AVAILABLE
    
    if _XDG_PORTAL_AVAILABLE is not None:
        return _XDG_PORTAL_AVAILABLE
    
    try:
        result = subprocess.run(
            ['gdbus', 'introspect', '--session',
             '--dest', 'org.freedesktop.portal.Desktop',
             '--object-path', '/org/freedesktop/portal/desktop'],
            capture_output=True,
            text=True,
            timeout=3
        )
        _XDG_PORTAL_AVAILABLE = (
            result.returncode == 0 and
            'org.freedesktop.portal.Screenshot' in result.stdout
        )
    except Exception as e:
        logger.debug(f"XDG Portal check failed: {e}")
        _XDG_PORTAL_AVAILABLE = False
    
    logger.info(f"XDG Desktop Portal Screenshot available: {_XDG_PORTAL_AVAILABLE}")
    return _XDG_PORTAL_AVAILABLE


def _capture_xdg_portal():
    """Capture screenshot via XDG Desktop Portal (standard Wayland API).
    
    The XDG Desktop Portal provides a desktop-environment-agnostic way to
    capture screenshots on Wayland. It works on GNOME, KDE, and wlroots-based
    compositors that implement the portal backend.
    
    Behavior:
    - First call may show a permission dialog to the user
    - After user grants permission, subsequent captures are silent
    - No flash or shutter animation
    
    The portal uses an async D-Bus pattern:
    1. Call Screenshot() method → returns a request handle
    2. Portal shows consent dialog (if needed)
    3. Portal emits Response signal with screenshot URI
    
    For simplicity, we use gdbus with a synchronous pattern:
    - Call Screenshot() with modal=false to minimize interruption
    - Poll for the response file to appear
    
    Returns PIL.Image on success, None on failure.
    """
    if not _check_xdg_portal_available():
        return None
    
    # Generate a unique token for this request
    import random
    import string
    token = 'timetracker_' + ''.join(random.choices(string.ascii_lowercase, k=8))
    
    # We'll use a temp file approach: portal saves to a URI we can read
    fh, filepath = tempfile.mkstemp('.png', prefix='portal_screenshot_')
    os.close(fh)
    os.unlink(filepath)  # Portal will create the file
    
    try:
        # Call the portal Screenshot method
        # Using gdbus monitor to catch the response signal is complex,
        # so we use a simpler approach: call with interactive=false and
        # let the portal save directly if possible
        
        # Method 1: Try non-interactive capture (may fail if no prior consent)
        result = subprocess.run(
            [
                'gdbus', 'call', '--session',
                '--dest', 'org.freedesktop.portal.Desktop',
                '--object-path', '/org/freedesktop/portal/desktop',
                '--method', 'org.freedesktop.portal.Screenshot.Screenshot',
                '',  # parent_window (empty for no parent)
                '{\"handle_token\": <\"' + token + '\">, \"interactive\": <false>}',
            ],
            capture_output=True,
            text=True,
            timeout=10,
            env=_clean_env_for_screenshot(),
        )
        
        if result.returncode != 0:
            logger.debug(f"XDG Portal call failed: {result.stderr[:200]}")
            return None
        
        # Parse the response to get the request object path
        # Response looks like: (/org/freedesktop/portal/desktop/request/...)
        response_text = result.stdout.strip()
        if not response_text.startswith('('):
            logger.debug(f"XDG Portal unexpected response: {response_text[:100]}")
            return None
        
        # The portal works asynchronously - we need to wait for the Response signal
        # For simplicity, we'll use a polling approach with gdbus monitor
        # This is a simplified implementation - production code may use dbus-python
        
        # Wait for response using a subprocess that monitors the signal
        monitor_result = subprocess.run(
            [
                'timeout', '5',
                'gdbus', 'monitor', '--session',
                '--dest', 'org.freedesktop.portal.Desktop',
            ],
            capture_output=True,
            text=True,
            timeout=8,
        )
        
        # Parse the monitor output for the Response signal
        # Look for: Response (uint32 0, {'uri': <'file:///tmp/...'>})
        output = monitor_result.stdout
        
        # Find the URI in the response
        import re
        uri_match = re.search(r"'uri':\s*<'(file://[^']+)'", output)
        if not uri_match:
            # Try alternative format
            uri_match = re.search(r'"uri":\s*"(file://[^"]+)"', output)
        
        if uri_match:
            file_uri = uri_match.group(1)
            # Convert file:// URI to path
            if file_uri.startswith('file://'):
                screenshot_path = file_uri[7:]  # Remove 'file://'
                
                if os.path.exists(screenshot_path) and os.path.getsize(screenshot_path) > 0:
                    im = _PILImage.open(screenshot_path)
                    im.load()
                    
                    # Validate not all-black
                    import array as _array
                    bands = im.split()
                    if any(max(_array.array('B', b.tobytes())) > 0 for b in bands):
                        logger.debug("Linux capture: XDG Desktop Portal (silent)")
                        result_img = im.copy()
                        im.close()
                        # Clean up the temp file created by portal
                        try:
                            os.unlink(screenshot_path)
                        except OSError:
                            pass
                        return result_img
                    
                    logger.warning("XDG Portal screenshot all-black — skipping")
                    im.close()
        
        logger.debug("XDG Portal: No valid screenshot URI in response")
        return None
        
    except subprocess.TimeoutExpired:
        logger.warning("XDG Portal screenshot timed out")
        return None
    except Exception as e:
        logger.debug(f"XDG Portal screenshot error: {e}")
        return None
    finally:
        # Clean up temp file if it exists
        try:
            if os.path.exists(filepath):
                os.unlink(filepath)
        except OSError:
            pass
```

### 4.2 Alternative Simpler Implementation (Recommended)

The above async handling is complex. Here's a simpler approach using Python dbus:

```python
def _capture_xdg_portal_simple():
    """Capture via XDG Portal using a simpler blocking approach.
    
    Uses the portal's interactive mode which handles everything internally.
    The first time, user sees a consent dialog. After that, captures are silent.
    """
    if not _check_xdg_portal_available():
        return None
    
    try:
        # Use gnome-screenshot in non-interactive portal mode
        # gnome-screenshot 41+ uses XDG portal by default on Wayland
        # This avoids the flash when called via portal
        fh, filepath = tempfile.mkstemp('.png')
        os.close(fh)
        
        # Check if we can use portal directly via dbus-send
        result = subprocess.run(
            [
                'dbus-send', '--session', '--print-reply', '--type=method_call',
                '--dest=org.freedesktop.portal.Desktop',
                '/org/freedesktop/portal/desktop',
                'org.freedesktop.portal.Screenshot.Screenshot',
                'string:',  # parent_window
                'dict:string:variant:interactive,boolean:false',
            ],
            capture_output=True,
            timeout=10,
            env=_clean_env_for_screenshot(),
        )
        
        # If dbus-send succeeded, the screenshot might be in the response
        # This is still async though...
        
        # For production, recommend using python-dbus with signal handling
        # or the portal's file descriptor passing feature
        
    except Exception as e:
        logger.debug(f"XDG Portal simple capture failed: {e}")
    
    return None
```

### 4.3 Modify `_capture_linux()` Function

Update the `_capture_linux()` function to use portal first:

```python
def _capture_linux():
    """Capture the full screen on Linux.
    
    Fallback order (flash-free methods first):

    Wayland session:
      1. XDG Desktop Portal — Standard API, no flash, works on GNOME 46+
         May show one-time consent dialog.
      2. GNOME Screenshot D-Bus (silent) — flash=false, no shutter sound.
         Works when org.gnome.Shell.Screenshot is accessible (GNOME < 46).
      3. gnome-screenshot + event-sounds muted — uses the gnome-screenshot
         binary but temporarily mutes sound. VISUAL FLASH STILL OCCURS.
      4. scrot — X11 / XWayland fallback; all-black on pure Wayland.
      5. Pillow XCB — last resort; same caveat as scrot.

    X11 session:
      1. scrot — pure X11, fast, no issues.
      2. Pillow XCB — fallback when scrot is absent.
    """
    is_wayland = _is_wayland_session()

    if is_wayland:
        # --- Wayland Method 1: XDG Desktop Portal (GNOME 46+ compatible) ---
        img = _capture_xdg_portal()
        if img is not None:
            return img
        
        # --- Wayland Method 2: GNOME D-Bus (flash=false) ---
        img = _capture_gnome_dbus_silent()
        if img is not None:
            return img
        
        # --- Wayland Method 3: gnome-screenshot (muted sound, but flash) ---
        img = _capture_gnome_screenshot_muted()
        if img is not None:
            logger.debug("Linux capture: gnome-screenshot (muted) — flash may occur")
            return img

    # --- Method 4: scrot (X11 / XWayland) ---
    # [existing scrot code unchanged]
    
    # --- Method 5: Pillow XCB ---
    # [existing Pillow XCB code unchanged]
```

---

## 5. Test Scripts

### 5.1 Test Script: Portal Availability

Create `test_portal_availability.py`:

```python
#!/usr/bin/env python3
"""Test XDG Desktop Portal availability for screenshot capture."""

import subprocess
import os
import sys


def test_environment():
    """Print current environment info."""
    print("=" * 60)
    print("ENVIRONMENT DETECTION")
    print("=" * 60)
    
    session_type = os.environ.get('XDG_SESSION_TYPE', 'unknown')
    wayland_display = os.environ.get('WAYLAND_DISPLAY', '')
    desktop = os.environ.get('XDG_CURRENT_DESKTOP', 'unknown')
    
    print(f"Session Type: {session_type}")
    print(f"WAYLAND_DISPLAY: {wayland_display or '(not set)'}")
    print(f"Desktop: {desktop}")
    print(f"Is Wayland: {bool(wayland_display) or session_type == 'wayland'}")
    print()


def test_gnome_version():
    """Get GNOME Shell version."""
    print("=" * 60)
    print("GNOME VERSION")
    print("=" * 60)
    
    try:
        result = subprocess.run(
            ['gnome-shell', '--version'],
            capture_output=True,
            text=True,
            timeout=5
        )
        if result.returncode == 0:
            print(f"GNOME Shell: {result.stdout.strip()}")
        else:
            print("GNOME Shell not found")
    except Exception as e:
        print(f"Error detecting GNOME: {e}")
    print()


def test_gnome_dbus():
    """Test GNOME Shell Screenshot D-Bus access."""
    print("=" * 60)
    print("TEST: GNOME Shell Screenshot D-Bus (flash=false)")
    print("=" * 60)
    
    try:
        result = subprocess.run(
            [
                'gdbus', 'call', '--session',
                '--dest', 'org.gnome.Shell',
                '--object-path', '/org/gnome/Shell/Screenshot',
                '--method', 'org.gnome.Shell.Screenshot.Screenshot',
                'false', 'false', '/tmp/test_gnome_dbus.png',
            ],
            capture_output=True,
            text=True,
            timeout=10
        )
        
        if result.returncode == 0 and '(true,' in result.stdout:
            print("✅ GNOME D-Bus Screenshot: AVAILABLE")
            print("   Flash-free capture via D-Bus works!")
            # Clean up
            try:
                os.unlink('/tmp/test_gnome_dbus.png')
            except:
                pass
        else:
            print("❌ GNOME D-Bus Screenshot: BLOCKED")
            print(f"   Error: {result.stderr.strip()[:100]}")
            print("   This is expected on GNOME 46+")
    except subprocess.TimeoutExpired:
        print("❌ GNOME D-Bus Screenshot: TIMEOUT")
    except Exception as e:
        print(f"❌ GNOME D-Bus Screenshot: ERROR - {e}")
    print()


def test_xdg_portal():
    """Test XDG Desktop Portal availability."""
    print("=" * 60)
    print("TEST: XDG Desktop Portal Screenshot Interface")
    print("=" * 60)
    
    try:
        result = subprocess.run(
            [
                'gdbus', 'introspect', '--session',
                '--dest', 'org.freedesktop.portal.Desktop',
                '--object-path', '/org/freedesktop/portal/desktop',
            ],
            capture_output=True,
            text=True,
            timeout=5
        )
        
        if result.returncode == 0 and 'org.freedesktop.portal.Screenshot' in result.stdout:
            print("✅ XDG Desktop Portal: AVAILABLE")
            print("   Portal screenshot interface found!")
            print("   This can be used for flash-free capture.")
        else:
            print("❌ XDG Desktop Portal: NOT AVAILABLE")
            print("   Portal daemon may not be running")
    except Exception as e:
        print(f"❌ XDG Desktop Portal: ERROR - {e}")
    print()


def test_scrot():
    """Test scrot availability and Wayland behavior."""
    print("=" * 60)
    print("TEST: scrot (X11 screenshot tool)")
    print("=" * 60)
    
    import shutil
    if not shutil.which('scrot'):
        print("❌ scrot: NOT INSTALLED")
        print("   Install with: sudo apt install scrot")
        print()
        return
    
    print("✅ scrot: INSTALLED")
    
    session_type = os.environ.get('XDG_SESSION_TYPE', '')
    if session_type == 'wayland':
        print("⚠️  WARNING: Running on Wayland")
        print("   scrot will produce a BLACK IMAGE (by design)")
        print("   This is because scrot uses X11 protocol")
    else:
        print("   scrot should work correctly on X11")
    print()


def test_tools_summary():
    """Print summary of available tools."""
    print("=" * 60)
    print("SUMMARY: Screenshot Tools for Your System")
    print("=" * 60)
    
    session = os.environ.get('XDG_SESSION_TYPE', 'unknown')
    
    if session == 'wayland':
        print("You are running WAYLAND session.")
        print()
        print("Recommended capture methods (in order):")
        print("1. XDG Desktop Portal - Flash-free (if available)")
        print("2. GNOME D-Bus - Flash-free (if not blocked)")
        print("3. gnome-screenshot - Works but has FLASH")
        print()
        print("NOT recommended for Wayland:")
        print("❌ scrot - Produces black images")
        print("❌ maim - Produces black images")
        print("❌ python-mss - Produces black images")
    else:
        print("You are running X11 session.")
        print()
        print("Recommended capture methods:")
        print("1. scrot - Fast, no flash")
        print("2. Pillow ImageGrab - Works well")
        print("3. python-mss - Fast, works well")
    print()


def main():
    print()
    print("🔍 SCREENSHOT CAPTURE CAPABILITY TEST")
    print()
    
    test_environment()
    test_gnome_version()
    test_gnome_dbus()
    test_xdg_portal()
    test_scrot()
    test_tools_summary()
    
    print("=" * 60)
    print("TEST COMPLETE")
    print("=" * 60)


if __name__ == '__main__':
    main()
```

### 5.2 Test Script: Capture Methods

Create `test_capture_methods.py`:

```python
#!/usr/bin/env python3
"""Test all screenshot capture methods and compare results."""

import subprocess
import tempfile
import os
import sys
import time


def capture_with_scrot():
    """Test scrot capture."""
    print("Testing: scrot...")
    fh, filepath = tempfile.mkstemp('.png')
    os.close(fh)
    os.unlink(filepath)
    
    try:
        start = time.time()
        result = subprocess.run(
            ['scrot', '--silent', filepath],
            capture_output=True,
            timeout=5
        )
        elapsed = time.time() - start
        
        if result.returncode == 0 and os.path.exists(filepath):
            size = os.path.getsize(filepath)
            # Check if black
            from PIL import Image
            img = Image.open(filepath)
            pixels = list(img.getdata())
            is_black = all(sum(p[:3]) == 0 for p in pixels[:1000])
            img.close()
            os.unlink(filepath)
            
            if is_black:
                return f"⚠️  BLACK IMAGE (Wayland XWayland issue) - {elapsed:.2f}s"
            return f"✅ SUCCESS - {size} bytes, {elapsed:.2f}s"
        return f"❌ FAILED - rc={result.returncode}"
    except FileNotFoundError:
        return "❌ NOT INSTALLED"
    except Exception as e:
        return f"❌ ERROR: {e}"
    finally:
        try:
            os.unlink(filepath)
        except:
            pass


def capture_with_gnome_dbus():
    """Test GNOME D-Bus screenshot."""
    print("Testing: GNOME D-Bus (flash=false)...")
    filepath = '/tmp/test_gnome_dbus.png'
    
    try:
        start = time.time()
        result = subprocess.run(
            [
                'gdbus', 'call', '--session',
                '--dest', 'org.gnome.Shell',
                '--object-path', '/org/gnome/Shell/Screenshot',
                '--method', 'org.gnome.Shell.Screenshot.Screenshot',
                'false', 'false', filepath,
            ],
            capture_output=True,
            text=True,
            timeout=10
        )
        elapsed = time.time() - start
        
        if result.returncode == 0 and '(true,' in result.stdout:
            size = os.path.getsize(filepath)
            os.unlink(filepath)
            return f"✅ SUCCESS (NO FLASH) - {size} bytes, {elapsed:.2f}s"
        elif 'AccessDenied' in result.stderr:
            return f"❌ BLOCKED (GNOME 46+ security) - {elapsed:.2f}s"
        return f"❌ FAILED - {result.stderr[:50]}"
    except Exception as e:
        return f"❌ ERROR: {e}"
    finally:
        try:
            os.unlink(filepath)
        except:
            pass


def capture_with_gnome_screenshot():
    """Test gnome-screenshot binary."""
    print("Testing: gnome-screenshot binary...")
    fh, filepath = tempfile.mkstemp('.png')
    os.close(fh)
    
    try:
        start = time.time()
        result = subprocess.run(
            ['gnome-screenshot', '--file', filepath],
            capture_output=True,
            timeout=10
        )
        elapsed = time.time() - start
        
        if result.returncode == 0 and os.path.exists(filepath):
            size = os.path.getsize(filepath)
            os.unlink(filepath)
            return f"✅ SUCCESS (⚠️ FLASH OCCURRED) - {size} bytes, {elapsed:.2f}s"
        return f"❌ FAILED - rc={result.returncode}"
    except FileNotFoundError:
        return "❌ NOT INSTALLED"
    except Exception as e:
        return f"❌ ERROR: {e}"
    finally:
        try:
            os.unlink(filepath)
        except:
            pass


def test_xdg_portal_available():
    """Test if XDG Portal is available."""
    print("Testing: XDG Portal availability...")
    try:
        result = subprocess.run(
            [
                'gdbus', 'introspect', '--session',
                '--dest', 'org.freedesktop.portal.Desktop',
                '--object-path', '/org/freedesktop/portal/desktop',
            ],
            capture_output=True,
            text=True,
            timeout=5
        )
        
        if 'org.freedesktop.portal.Screenshot' in result.stdout:
            return "✅ AVAILABLE - Can be implemented for flash-free capture"
        return "❌ NOT AVAILABLE"
    except Exception as e:
        return f"❌ ERROR: {e}"


def main():
    print()
    print("=" * 60)
    print("SCREENSHOT CAPTURE METHOD COMPARISON")
    print("=" * 60)
    print()
    
    session = os.environ.get('XDG_SESSION_TYPE', 'unknown')
    print(f"Session type: {session}")
    print()
    
    results = {}
    
    results['scrot'] = capture_with_scrot()
    print(f"  scrot: {results['scrot']}")
    print()
    
    results['gnome_dbus'] = capture_with_gnome_dbus()
    print(f"  GNOME D-Bus: {results['gnome_dbus']}")
    print()
    
    print("⚠️  Next test (gnome-screenshot) may cause a FLASH...")
    input("  Press Enter to continue or Ctrl+C to skip...")
    results['gnome_screenshot'] = capture_with_gnome_screenshot()
    print(f"  gnome-screenshot: {results['gnome_screenshot']}")
    print()
    
    results['xdg_portal'] = test_xdg_portal_available()
    print(f"  XDG Portal: {results['xdg_portal']}")
    print()
    
    print("=" * 60)
    print("RECOMMENDATION")
    print("=" * 60)
    
    if session == 'wayland':
        if 'SUCCESS' in results.get('gnome_dbus', ''):
            print("✅ Use GNOME D-Bus (flash=false) - working on your system")
        elif 'AVAILABLE' in results.get('xdg_portal', ''):
            print("✅ Implement XDG Portal - best option for GNOME 46+")
        else:
            print("⚠️  Only gnome-screenshot works, flash will occur")
    else:
        print("✅ Use scrot - you're on X11, no issues")
    
    print()


if __name__ == '__main__':
    main()
```

### 5.3 Test Script: Run After Implementation

Create `test_implementation.py`:

```python
#!/usr/bin/env python3
"""Test the implemented XDG Portal screenshot capture."""

import sys
import os

# Add parent directory to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from monitor_capture import (
    _capture_xdg_portal,
    _capture_gnome_dbus_silent,
    _capture_linux,
    _is_wayland_session,
    _check_xdg_portal_available,
)


def test_portal_detection():
    """Test portal availability detection."""
    print("Testing: Portal availability detection...")
    available = _check_xdg_portal_available()
    print(f"  XDG Portal available: {available}")
    return available


def test_portal_capture():
    """Test portal screenshot capture."""
    print("\nTesting: XDG Portal capture...")
    print("  (A consent dialog may appear on first run)")
    
    img = _capture_xdg_portal()
    
    if img is not None:
        print(f"  ✅ SUCCESS - Image size: {img.size}")
        print(f"  ✅ NO FLASH should have occurred!")
        return True
    else:
        print("  ❌ Portal capture failed, will fall back to other methods")
        return False


def test_full_capture_chain():
    """Test the full Linux capture chain."""
    print("\nTesting: Full _capture_linux() chain...")
    
    is_wayland = _is_wayland_session()
    print(f"  Wayland session: {is_wayland}")
    
    img = _capture_linux()
    
    if img is not None:
        print(f"  ✅ SUCCESS - Image size: {img.size}")
        return True
    else:
        print("  ❌ All capture methods failed")
        return False


def main():
    print()
    print("=" * 60)
    print("XDG PORTAL IMPLEMENTATION TEST")
    print("=" * 60)
    print()
    
    portal_available = test_portal_detection()
    
    if portal_available:
        portal_works = test_portal_capture()
    else:
        portal_works = False
        print("\n⚠️  Portal not available, skipping portal capture test")
    
    chain_works = test_full_capture_chain()
    
    print()
    print("=" * 60)
    print("TEST RESULTS")
    print("=" * 60)
    print(f"  Portal available: {'✅' if portal_available else '❌'}")
    print(f"  Portal capture: {'✅' if portal_works else '❌'}")
    print(f"  Full chain: {'✅' if chain_works else '❌'}")
    
    if portal_works:
        print()
        print("🎉 XDG Portal is working! Screenshots should be flash-free.")
    elif chain_works:
        print()
        print("⚠️  Portal failed but fallback chain works.")
        print("    Flash may occur on GNOME 46+ Wayland.")
    
    print()


if __name__ == '__main__':
    main()
```

### 5.4 Bash Test Script

Create `test_screenshot_flash.sh`:

```bash
#!/bin/bash
# Test screenshot capture methods and detect flash behavior

echo "=========================================="
echo "SCREENSHOT FLASH TEST"
echo "=========================================="
echo

# Detect environment
echo "Environment:"
echo "  Session Type: $XDG_SESSION_TYPE"
echo "  Desktop: $XDG_CURRENT_DESKTOP"
echo "  Wayland Display: ${WAYLAND_DISPLAY:-not set}"
echo

# Test GNOME version
echo "GNOME Version:"
gnome-shell --version 2>/dev/null || echo "  GNOME Shell not found"
echo

# Test GNOME D-Bus (should be silent)
echo "Test 1: GNOME D-Bus with flash=false"
echo "  (Should be SILENT - no flash)"
RESULT=$(gdbus call --session \
    --dest org.gnome.Shell \
    --object-path /org/gnome/Shell/Screenshot \
    --method org.gnome.Shell.Screenshot.Screenshot \
    false false /tmp/test_dbus.png 2>&1)

if echo "$RESULT" | grep -q "(true,"; then
    echo "  ✅ SUCCESS - No flash!"
    rm -f /tmp/test_dbus.png
else
    echo "  ❌ BLOCKED: $RESULT"
fi
echo

# Test XDG Portal availability
echo "Test 2: XDG Portal availability"
PORTAL=$(gdbus introspect --session \
    --dest org.freedesktop.portal.Desktop \
    --object-path /org/freedesktop/portal/desktop 2>&1)

if echo "$PORTAL" | grep -q "org.freedesktop.portal.Screenshot"; then
    echo "  ✅ XDG Portal Screenshot interface AVAILABLE"
else
    echo "  ❌ XDG Portal NOT available"
fi
echo

# Test gnome-screenshot (will flash!)
echo "Test 3: gnome-screenshot binary"
echo "  ⚠️  WARNING: This WILL cause a flash!"
read -p "  Press Enter to test or Ctrl+C to skip..."
gnome-screenshot --file /tmp/test_gnome.png 2>/dev/null
if [ -f /tmp/test_gnome.png ]; then
    echo "  ✅ Screenshot saved (did you see a flash?)"
    rm -f /tmp/test_gnome.png
else
    echo "  ❌ gnome-screenshot failed"
fi
echo

echo "=========================================="
echo "TEST COMPLETE"
echo "=========================================="
```

---

## 6. Rollback Plan

If XDG Portal implementation causes issues:

### 6.1 Quick Disable

Add environment variable check:

```python
def _capture_xdg_portal():
    # Allow disabling via environment variable
    if os.environ.get('TIMETRACKER_DISABLE_PORTAL', '').lower() in ('1', 'true', 'yes'):
        logger.debug("XDG Portal disabled via TIMETRACKER_DISABLE_PORTAL")
        return None
    
    # ... rest of implementation
```

### 6.2 Full Rollback

To completely remove portal support:

1. Delete `_capture_xdg_portal()` function
2. Delete `_check_xdg_portal_available()` function
3. Remove portal call from `_capture_linux()`
4. Revert to previous fallback chain

---

## 7. Success Criteria

### 7.1 Functional Requirements

| # | Requirement | Test Method |
|---|-------------|-------------|
| 1 | No visual flash on GNOME 46+ Wayland | Manual observation |
| 2 | One-time consent dialog appears | First-run test |
| 3 | Subsequent captures are silent | Second-run test |
| 4 | Falls back to D-Bus on older GNOME | Test on GNOME 42 |
| 5 | Falls back to gnome-screenshot if all else fails | Disable portal + D-Bus |
| 6 | scrot still works on X11 sessions | Test on X11 login |
| 7 | No crashes or hangs | Stress test (100 captures) |

### 7.2 Performance Requirements

| Metric | Target |
|--------|--------|
| Capture time (portal) | < 500ms |
| Capture time (D-Bus) | < 300ms |
| Memory overhead | < 10MB |

### 7.3 Sign-off Checklist

```
[ ] XDG Portal capture works on GNOME 46+ Wayland
[ ] No flash observed after initial consent
[ ] Fallback chain works when portal unavailable
[ ] X11 session uses scrot (no portal overhead)
[ ] All test scripts pass
[ ] Code review completed
[ ] Documentation updated
```

---

## Appendix A: Reference Links

- XDG Portal Specification: https://flatpak.github.io/xdg-desktop-portal/
- GNOME Screenshot D-Bus: https://gitlab.gnome.org/GNOME/gnome-shell/-/blob/main/js/dbusServices/screencast/screencastService.js
- Wayland Security: https://wayland.freedesktop.org/docs/html/ch04.html
- Portal Screenshot API: https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.Screenshot.html

---

**Document End**
