# Wayland Window Detection Fix Plan

**Date:** 2026-06-11  
**Status:** ✅ IMPLEMENTED  
**Priority:** P0 (Critical - 52% of activity records affected)  
**Estimated Effort:** 5-7 days total

---

## Implementation Status

### ✅ Phase 1: Fix gnome_introspect Method - COMPLETED
- Added interface availability check before calling GetWindows
- Increased timeout from 2s to 5s for large window lists
- Added Flatpak sandbox-app-id detection
- Enhanced regex parsing with larger lookahead (600 chars)

### ✅ Phase 2: Enhanced AT-SPI2 Support - COMPLETED  
- Added AT-SPI2 D-Bus service check
- Added `/usr/bin/python3` fallback (critical for AppImage/venv)
- Improved filtering of non-window apps (gnome-shell, ibus-daemon, etc.)

### ✅ Phase 3: Add Diagnostics Command - COMPLETED
- Added `--diagnose-wayland` CLI option
- Reports all detection methods status
- Shows GNOME version and recommendations

### ✅ Phase 4: Testing - COMPLETED
- Both test scripts working correctly
- AT-SPI2 fallback verified on GNOME 46

---

## Critical Finding: GNOME 46 Security Restriction

**GetWindows API is BLOCKED on GNOME 46:**
```
Error: GDBus.Error:org.freedesktop.DBus.Error.AccessDenied: GetWindows is not allowed
```

This means on GNOME 46+, the **AT-SPI2 method** is the primary working detection method.

**Method availability on GNOME 46 (Ubuntu 24.04):**
| Method | Status | Notes |
|--------|--------|-------|
| gnome_introspect | ❌ BLOCKED | AccessDenied by security policy |
| atspi | ✅ WORKS | Via `/usr/bin/python3` fallback |
| gdbus (Shell.Eval) | ⚠️ DISABLED | User must enable manually |
| xdotool | ✅ WORKS | XWayland apps only |

---

## Table of Contents

1. [Problem Summary](#1-problem-summary)
2. [Root Cause Analysis](#2-root-cause-analysis)
3. [Solution Architecture](#3-solution-architecture)
4. [Implementation Plan](#4-implementation-plan)
5. [Code Changes](#5-code-changes)
6. [Test Plan](#6-test-plan)
7. [Rollout Strategy](#7-rollout-strategy)
8. [Success Metrics](#8-success-metrics)

---

## 1. Problem Summary

### Current State
- **52% of activity records** have "Unknown" window titles on Wayland
- All 4 window detection methods are failing or partially failing
- Circuit-breaker is triggering for `gdbus`, `gnome_introspect`, and `atspi` methods
- Only `xdotool` works, but only for XWayland apps (not native Wayland)

### Impact
- Inaccurate time tracking attribution
- Poor productivity classification
- AI matching to Jira tickets fails when window title is "Unknown"
- User experience degradation on Linux (Ubuntu 22.04+ with GNOME 45+)

---

## 2. Root Cause Analysis

### Method Failure Breakdown

| Method | Failure Reason | Fix Complexity |
|--------|---------------|----------------|
| `gdbus` (Shell.Eval) | GNOME 45+ disables by default | Medium (user config) |
| `gnome_introspect` | Parsing/timeout issues | Low (code fix) |
| `atspi` | `python3-gi` not in AppImage | Medium (bundling) |
| `xdotool` | Only sees XWayland apps | N/A (limitation) |

### Key Insight
The `gnome_introspect` method (Shell.Introspect.GetWindows) should work on GNOME 40+ without unsafe mode, but it's failing. **This is our primary fix target.**

---

## 3. Solution Architecture

### Detection Method Priority (After Fix)

```
┌─────────────────────────────────────────────────────────────────┐
│                    WAYLAND SESSION DETECTED                     │
└─────────────────────────────────────────────────────────────────┘
                                │
                                ▼
┌─────────────────────────────────────────────────────────────────┐
│  Method 1: gnome_introspect (GetWindows) ◄── PRIMARY FIX       │
│  - Available GNOME 40+, no unsafe mode needed                   │
│  - Correctly tracks native Wayland + XWayland apps              │
│  - Browser tab switches visible in window.title                 │
└─────────────────────────────────────────────────────────────────┘
                    │ Success? ───────────────────► Return result
                    │ Fail
                    ▼
┌─────────────────────────────────────────────────────────────────┐
│  Method 2: atspi (AT-SPI2 Accessibility)                        │
│  - Works for Chrome, Firefox (native Wayland)                   │
│  - Requires python3-gi on host OR bundled in AppImage           │
└─────────────────────────────────────────────────────────────────┘
                    │ Success? ───────────────────► Return result
                    │ Fail
                    ▼
┌─────────────────────────────────────────────────────────────────┐
│  Method 3: gdbus (Shell.Eval) - if user enables unsafe mode     │
│  - User must: gsettings set org.gnome.shell development-tools   │
└─────────────────────────────────────────────────────────────────┘
                    │ Success? ───────────────────► Return result
                    │ Fail
                    ▼
┌─────────────────────────────────────────────────────────────────┐
│  Method 4: xdotool (XWayland fallback)                          │
│  - Only works for apps running via XWayland                     │
│  - Returns stale window for native Wayland apps                 │
└─────────────────────────────────────────────────────────────────┘
                    │ Success? ───────────────────► Return result
                    │ Fail
                    ▼
┌─────────────────────────────────────────────────────────────────┐
│  Return ('Unknown', 'Unknown') + LOG WARNING                    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 4. Implementation Plan

### Phase 1: Fix gnome_introspect Method (P0 - 2 days)

#### Task 1.1: Add Robust Error Handling & Logging
- Add detailed error logging to identify exact failure point
- Capture `stderr` from gdbus calls
- Log GNOME Shell version for diagnostics

#### Task 1.2: Fix Regex Parsing
- The current regex may fail on certain GNOME versions
- Handle edge cases: empty titles, special characters, long window lists

#### Task 1.3: Increase Timeout & Add Retry
- Current timeout: 2s (may be too short for large window lists)
- Add single retry on timeout
- Cache successful method to prefer it next time

#### Task 1.4: Add Version Detection
- Detect GNOME Shell version
- Use appropriate API based on version

---

### Phase 2: Enhance AT-SPI2 Support (P1 - 2 days)

#### Task 2.1: Improve Host Detection
- Check if `python3-gi` is available on host system
- Auto-install prompt for missing dependencies

#### Task 2.2: Add System Python Fallback
- If bundled Python lacks gi, spawn system Python
- Already partially implemented, needs testing

#### Task 2.3: Bundle Minimal GI Bindings (Optional)
- Investigate if minimal gi/Atspi can be bundled in AppImage
- May increase AppImage size by ~5-10MB

---

### Phase 3: Add User Guidance & Diagnostics (P2 - 1 day)

#### Task 3.1: Add Diagnostic Command
- `python desktop_app.py --diagnose-wayland`
- Tests all methods and reports which work/fail

#### Task 3.2: Add User Notification
- Show one-time notification when all methods fail
- Link to documentation with fix instructions

#### Task 3.3: Update Documentation
- Create user-facing guide for Wayland setup
- Add troubleshooting section

---

### Phase 4: Testing & Validation (P0 - 2 days)

#### Task 4.1: Create Test Scripts
- Test each detection method individually
- Test full detection flow
- Test on GNOME 45+, KDE Plasma, wlroots

#### Task 4.2: Manual Testing Matrix
- Ubuntu 22.04 (GNOME 42)
- Ubuntu 24.04 (GNOME 46)
- Fedora 40 (GNOME 46)
- KDE Plasma 6

---

## 5. Code Changes

### 5.1 File: `desktop_app.py`

#### Change 1: Enhanced `_from_gnome_introspect()` with Better Error Handling

```python
def _from_gnome_introspect():
    """GNOME Shell Introspect API - works on GNOME 40+ without unsafe mode.
    
    This is the preferred method for Wayland as it:
    - Doesn't require Shell.Eval (disabled in GNOME 45+)
    - Correctly reports native Wayland window focus
    - Updates on browser tab switches
    
    Returns (title, app_id) or None on failure.
    """
    try:
        # First, verify the interface is available
        check_result = subprocess.run(
            ['gdbus', 'introspect', '--session',
             '--dest', 'org.gnome.Shell',
             '--object-path', '/org/gnome/Shell/Introspect'],
            capture_output=True, text=True, timeout=2
        )
        
        if check_result.returncode != 0:
            logger.debug(f"Introspect interface not available: {check_result.stderr[:200]}")
            return None
        
        if 'GetWindows' not in check_result.stdout:
            logger.debug("GetWindows method not found in Introspect interface")
            return None
        
        # Call GetWindows
        result = subprocess.run(
            ['gdbus', 'call', '--session',
             '--dest', 'org.gnome.Shell',
             '--object-path', '/org/gnome/Shell/Introspect',
             '--method', 'org.gnome.Shell.Introspect.GetWindows'],
            capture_output=True, text=True, timeout=5  # Increased timeout
        )
        
        if result.returncode != 0:
            logger.warning(f"GetWindows call failed: rc={result.returncode}, "
                          f"stderr={result.stderr[:200]}")
            return None
        
        if not result.stdout:
            logger.debug("GetWindows returned empty output")
            return None
        
        stdout = result.stdout
        logger.debug(f"GetWindows raw output length: {len(stdout)} chars")
        
        # Parse the output - look for focused window
        import re as _re
        
        # Find all windows with their properties
        # Pattern: 'title': <'Window Title'>, ... 'has-focus': <true>
        for title_match in _re.finditer(r"'title':\s*<\s*'([^']*)'\s*>", stdout):
            title = title_match.group(1)
            
            # Look ahead for has-focus within same window block (500 chars)
            ahead_start = title_match.end()
            lookahead = stdout[ahead_start:ahead_start + 500]
            
            focus_match = _re.search(r"'has-focus':\s*<\s*(true|false)\s*>", lookahead)
            if focus_match and focus_match.group(1) == 'true':
                # Found the focused window - extract app info
                block = stdout[title_match.start():ahead_start + 500]
                
                # Try app-id first (native Wayland apps)
                app_match = _re.search(r"'app-id':\s*<\s*'([^']*)'\s*>", block)
                app_id = app_match.group(1) if app_match else ''
                
                # Fall back to wm-class (XWayland apps)
                if not app_id:
                    wm_match = _re.search(r"'wm-class':\s*<\s*'([^']*)'\s*>", block)
                    app_id = wm_match.group(1) if wm_match else 'Unknown'
                
                if title:
                    logger.debug(f"Introspect found focused window: '{title}' / '{app_id}'")
                    return title, app_id or 'Unknown'
        
        logger.debug("No focused window found in GetWindows output")
        return None
        
    except subprocess.TimeoutExpired:
        logger.warning("GetWindows timed out after 5s")
        return None
    except FileNotFoundError:
        logger.debug("gdbus not found")
        return None
    except Exception as e:
        logger.warning(f"gnome_introspect error: {e}")
        return None
```

#### Change 2: Add GNOME Version Detection

```python
def _get_gnome_shell_version():
    """Detect GNOME Shell version for API compatibility decisions.
    
    Returns tuple (major, minor) or None if not GNOME.
    """
    try:
        result = subprocess.run(
            ['gnome-shell', '--version'],
            capture_output=True, text=True, timeout=2
        )
        if result.returncode == 0:
            # Output: "GNOME Shell 45.2" or "GNOME Shell 46.0"
            import re
            match = re.search(r'(\d+)\.(\d+)', result.stdout)
            if match:
                return int(match.group(1)), int(match.group(2))
    except Exception:
        pass
    return None
```

#### Change 3: Enhanced Method Selection with Circuit Breaker

```python
class WindowDetectionCircuitBreaker:
    """Circuit breaker for window detection methods.
    
    Tracks failures per method and temporarily disables methods that
    are consistently failing to avoid wasting time on broken methods.
    """
    
    def __init__(self):
        self._failures = {}  # method_name -> failure_count
        self._last_failure_time = {}  # method_name -> timestamp
        self._disabled_until = {}  # method_name -> timestamp
        self._success_count = {}  # method_name -> count
        
        # Configuration
        self.failure_threshold = 3  # Failures before circuit opens
        self.cooldown_seconds = 60  # How long to disable failed method
        self.reset_after_success = 2  # Successes to reset failure count
    
    def is_enabled(self, method_name):
        """Check if a method is currently enabled."""
        if method_name in self._disabled_until:
            if time.time() < self._disabled_until[method_name]:
                return False
            else:
                # Cooldown expired, re-enable
                del self._disabled_until[method_name]
                self._failures[method_name] = 0
        return True
    
    def record_success(self, method_name):
        """Record a successful call."""
        self._success_count[method_name] = self._success_count.get(method_name, 0) + 1
        if self._success_count.get(method_name, 0) >= self.reset_after_success:
            self._failures[method_name] = 0
    
    def record_failure(self, method_name):
        """Record a failed call and potentially disable the method."""
        self._failures[method_name] = self._failures.get(method_name, 0) + 1
        self._last_failure_time[method_name] = time.time()
        self._success_count[method_name] = 0
        
        if self._failures[method_name] >= self.failure_threshold:
            self._disabled_until[method_name] = time.time() + self.cooldown_seconds
            logger.warning(f"Window detection method '{method_name}' disabled for "
                          f"{self.cooldown_seconds}s after {self._failures[method_name]} failures")
    
    def get_status(self):
        """Get current status of all methods for diagnostics."""
        return {
            'failures': dict(self._failures),
            'disabled_until': {k: v - time.time() for k, v in self._disabled_until.items() 
                              if v > time.time()},
            'success_count': dict(self._success_count)
        }
```

### 5.2 New File: `tests/test_wayland_window_detection.py`

See [Section 6: Test Plan](#6-test-plan) for complete test script.

---

## 6. Test Plan

### 6.1 Unit Tests

Create file: `python-desktop-app/tests/test_wayland_window_detection.py`

```python
#!/usr/bin/env python3
"""
Wayland Window Detection Test Suite

Tests all window detection methods on Linux/Wayland.
Run with: python -m pytest tests/test_wayland_window_detection.py -v
Or standalone: python tests/test_wayland_window_detection.py
"""

import os
import sys
import subprocess
import time
import json
import re
from datetime import datetime

# Add parent directory to path for imports
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


class WaylandWindowDetectionTests:
    """Test suite for Wayland window detection methods."""
    
    def __init__(self):
        self.results = []
        self.is_wayland = self._detect_wayland()
        self.gnome_version = self._get_gnome_version()
        
    def _detect_wayland(self):
        """Check if running on Wayland."""
        return bool(
            os.environ.get('WAYLAND_DISPLAY') or
            os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland'
        )
    
    def _get_gnome_version(self):
        """Get GNOME Shell version."""
        try:
            result = subprocess.run(
                ['gnome-shell', '--version'],
                capture_output=True, text=True, timeout=2
            )
            if result.returncode == 0:
                match = re.search(r'(\d+)\.(\d+)', result.stdout)
                if match:
                    return f"{match.group(1)}.{match.group(2)}"
        except Exception:
            pass
        return "N/A"
    
    def _log_result(self, test_name, passed, details=""):
        """Log test result."""
        status = "✅ PASS" if passed else "❌ FAIL"
        self.results.append({
            'test': test_name,
            'passed': passed,
            'details': details,
            'timestamp': datetime.now().isoformat()
        })
        print(f"{status}: {test_name}")
        if details:
            print(f"       {details}")
    
    # =========================================================================
    # Test: Environment Detection
    # =========================================================================
    
    def test_environment_detection(self):
        """Test that we correctly detect Wayland vs X11."""
        print("\n" + "=" * 60)
        print("TEST: Environment Detection")
        print("=" * 60)
        
        wayland_display = os.environ.get('WAYLAND_DISPLAY', '')
        x11_display = os.environ.get('DISPLAY', '')
        session_type = os.environ.get('XDG_SESSION_TYPE', '')
        
        print(f"  WAYLAND_DISPLAY: '{wayland_display}'")
        print(f"  DISPLAY: '{x11_display}'")
        print(f"  XDG_SESSION_TYPE: '{session_type}'")
        print(f"  GNOME Shell Version: {self.gnome_version}")
        print(f"  Detected as Wayland: {self.is_wayland}")
        
        self._log_result(
            "Environment Detection",
            True,
            f"Wayland={self.is_wayland}, GNOME={self.gnome_version}"
        )
        return True
    
    # =========================================================================
    # Test: GNOME Introspect API Availability
    # =========================================================================
    
    def test_introspect_api_available(self):
        """Test if GNOME Shell Introspect D-Bus interface is available."""
        print("\n" + "=" * 60)
        print("TEST: GNOME Introspect API Availability")
        print("=" * 60)
        
        try:
            result = subprocess.run(
                ['gdbus', 'introspect', '--session',
                 '--dest', 'org.gnome.Shell',
                 '--object-path', '/org/gnome/Shell/Introspect'],
                capture_output=True, text=True, timeout=3
            )
            
            api_available = result.returncode == 0
            has_getwindows = 'GetWindows' in result.stdout if api_available else False
            
            print(f"  D-Bus introspect return code: {result.returncode}")
            print(f"  Introspect interface available: {api_available}")
            print(f"  GetWindows method available: {has_getwindows}")
            
            if result.stderr:
                print(f"  stderr: {result.stderr[:200]}")
            
            self._log_result(
                "Introspect API Available",
                api_available and has_getwindows,
                f"Interface={api_available}, GetWindows={has_getwindows}"
            )
            return api_available and has_getwindows
            
        except FileNotFoundError:
            self._log_result("Introspect API Available", False, "gdbus not found")
            return False
        except subprocess.TimeoutExpired:
            self._log_result("Introspect API Available", False, "Timeout")
            return False
        except Exception as e:
            self._log_result("Introspect API Available", False, str(e))
            return False
    
    # =========================================================================
    # Test: GNOME Introspect GetWindows Call
    # =========================================================================
    
    def test_introspect_getwindows(self):
        """Test calling GetWindows and parsing the response."""
        print("\n" + "=" * 60)
        print("TEST: Introspect GetWindows Call")
        print("=" * 60)
        
        try:
            result = subprocess.run(
                ['gdbus', 'call', '--session',
                 '--dest', 'org.gnome.Shell',
                 '--object-path', '/org/gnome/Shell/Introspect',
                 '--method', 'org.gnome.Shell.Introspect.GetWindows'],
                capture_output=True, text=True, timeout=5
            )
            
            print(f"  Return code: {result.returncode}")
            print(f"  Output length: {len(result.stdout)} chars")
            
            if result.returncode != 0:
                print(f"  stderr: {result.stderr[:300]}")
                self._log_result("GetWindows Call", False, f"rc={result.returncode}")
                return False
            
            # Try to find focused window
            stdout = result.stdout
            focused_title = None
            focused_app = None
            
            for title_match in re.finditer(r"'title':\s*<\s*'([^']*)'\s*>", stdout):
                title = title_match.group(1)
                ahead_start = title_match.end()
                lookahead = stdout[ahead_start:ahead_start + 500]
                
                focus_match = re.search(r"'has-focus':\s*<\s*(true|false)\s*>", lookahead)
                if focus_match and focus_match.group(1) == 'true':
                    focused_title = title
                    block = stdout[title_match.start():ahead_start + 500]
                    app_match = re.search(r"'app-id':\s*<\s*'([^']*)'\s*>", block)
                    focused_app = app_match.group(1) if app_match else 'Unknown'
                    break
            
            print(f"  Focused window title: '{focused_title}'")
            print(f"  Focused app: '{focused_app}'")
            
            passed = focused_title is not None
            self._log_result(
                "GetWindows Call",
                passed,
                f"Title='{focused_title}', App='{focused_app}'"
            )
            return passed
            
        except subprocess.TimeoutExpired:
            self._log_result("GetWindows Call", False, "Timeout after 5s")
            return False
        except Exception as e:
            self._log_result("GetWindows Call", False, str(e))
            return False
    
    # =========================================================================
    # Test: Shell.Eval API (Requires unsafe mode)
    # =========================================================================
    
    def test_shell_eval(self):
        """Test GNOME Shell.Eval API (disabled by default in GNOME 45+)."""
        print("\n" + "=" * 60)
        print("TEST: Shell.Eval API")
        print("=" * 60)
        
        try:
            result = subprocess.run(
                ['gdbus', 'call', '--session',
                 '--dest', 'org.gnome.Shell',
                 '--object-path', '/org/gnome/Shell',
                 '--method', 'org.gnome.Shell.Eval',
                 "let w=global.display.focus_window;"
                 "w?(w.title+'|||'+(w.gtk_application_id||w.wm_class||'Unknown'))"
                 ":'Unknown|||Unknown'"],
                capture_output=True, text=True, timeout=2
            )
            
            print(f"  Return code: {result.returncode}")
            
            if result.returncode != 0:
                print(f"  ⚠️  Shell.Eval is likely disabled (GNOME 45+ default)")
                print(f"  To enable: gsettings set org.gnome.shell development-tools true")
                self._log_result("Shell.Eval", False, "Disabled (expected on GNOME 45+)")
                return False
            
            # Parse response: (true, 'Title|||AppName')
            match = re.search(r"\(true,\s*'([^']*)'\)", result.stdout)
            if match:
                raw = match.group(1)
                if '|||' in raw:
                    title, app = raw.split('|||', 1)
                    print(f"  Focused title: '{title}'")
                    print(f"  Focused app: '{app}'")
                    self._log_result("Shell.Eval", True, f"Title='{title}'")
                    return True
            
            print(f"  Could not parse response: {result.stdout[:200]}")
            self._log_result("Shell.Eval", False, "Parse error")
            return False
            
        except subprocess.TimeoutExpired:
            self._log_result("Shell.Eval", False, "Timeout")
            return False
        except Exception as e:
            self._log_result("Shell.Eval", False, str(e))
            return False
    
    # =========================================================================
    # Test: AT-SPI2 Accessibility API
    # =========================================================================
    
    def test_atspi(self):
        """Test AT-SPI2 accessibility-based window detection."""
        print("\n" + "=" * 60)
        print("TEST: AT-SPI2 Accessibility API")
        print("=" * 60)
        
        # Check if AT-SPI2 service is running
        try:
            result = subprocess.run(
                ['gdbus', 'call', '--session',
                 '--dest', 'org.a11y.Bus',
                 '--object-path', '/org/a11y/bus',
                 '--method', 'org.a11y.Bus.GetAddress'],
                capture_output=True, text=True, timeout=2
            )
            atspi_running = result.returncode == 0
            print(f"  AT-SPI2 bus available: {atspi_running}")
        except Exception:
            atspi_running = False
            print(f"  AT-SPI2 bus available: False")
        
        # Try in-process gi import
        gi_available = False
        try:
            import gi
            gi.require_version('Atspi', '2.0')
            from gi.repository import Atspi
            gi_available = True
            print(f"  python3-gi + Atspi available: True (in-process)")
        except (ImportError, ValueError) as e:
            print(f"  python3-gi + Atspi available: False ({e})")
        
        # Try system Python fallback
        system_gi_available = False
        if not gi_available:
            try:
                code = (
                    "import gi\n"
                    "gi.require_version('Atspi','2.0')\n"
                    "from gi.repository import Atspi\n"
                    "print('OK')"
                )
                result = subprocess.run(
                    ['python3', '-c', code],
                    capture_output=True, text=True, timeout=3
                )
                system_gi_available = result.returncode == 0 and 'OK' in result.stdout
                print(f"  System python3 gi available: {system_gi_available}")
            except Exception:
                print(f"  System python3 gi available: False")
        
        # Try to get focused window via AT-SPI
        focused_window = None
        if gi_available:
            try:
                import gi
                gi.require_version('Atspi', '2.0')
                from gi.repository import Atspi
                Atspi.init()
                desktop = Atspi.get_desktop(0)
                ACTIVE = Atspi.StateType.ACTIVE
                
                for i in range(desktop.get_child_count()):
                    app = desktop.get_child_at_index(i)
                    if not app or app.get_name() == 'gnome-shell':
                        continue
                    for j in range(app.get_child_count()):
                        win = app.get_child_at_index(j)
                        if win and win.get_state_set().contains(ACTIVE):
                            focused_window = (win.get_name(), app.get_name())
                            break
                    if focused_window:
                        break
                        
            except Exception as e:
                print(f"  AT-SPI query error: {e}")
        
        if focused_window:
            print(f"  Focused window: '{focused_window[0]}' / '{focused_window[1]}'")
        else:
            print(f"  Focused window: Not found")
        
        passed = gi_available or system_gi_available
        self._log_result(
            "AT-SPI2",
            passed,
            f"gi={gi_available}, system={system_gi_available}, focused={focused_window is not None}"
        )
        return passed
    
    # =========================================================================
    # Test: xdotool (X11/XWayland fallback)
    # =========================================================================
    
    def test_xdotool(self):
        """Test xdotool for XWayland window detection."""
        print("\n" + "=" * 60)
        print("TEST: xdotool (XWayland fallback)")
        print("=" * 60)
        
        try:
            # Get active window ID
            wid_result = subprocess.run(
                ['xdotool', 'getactivewindow'],
                capture_output=True, text=True, timeout=2
            )
            
            if wid_result.returncode != 0:
                print(f"  xdotool getactivewindow failed (no XWayland window focused?)")
                self._log_result("xdotool", False, "No active XWayland window")
                return False
            
            wid = wid_result.stdout.strip()
            print(f"  Active window ID: {wid}")
            
            # Get window name
            name_result = subprocess.run(
                ['xdotool', 'getwindowname', wid],
                capture_output=True, text=True, timeout=2
            )
            title = name_result.stdout.strip() if name_result.returncode == 0 else 'Unknown'
            print(f"  Window title: '{title}'")
            
            # Get window PID and process name
            try:
                pid_result = subprocess.run(
                    ['xdotool', 'getwindowpid', wid],
                    capture_output=True, text=True, timeout=2
                )
                if pid_result.returncode == 0:
                    pid = pid_result.stdout.strip()
                    import psutil
                    proc = psutil.Process(int(pid))
                    app_name = proc.name()
                    print(f"  Process: {app_name} (PID: {pid})")
                else:
                    app_name = 'Unknown'
            except Exception as e:
                app_name = 'Unknown'
                print(f"  Process: Unknown ({e})")
            
            passed = title and title != 'Unknown'
            self._log_result("xdotool", passed, f"Title='{title}', App='{app_name}'")
            return passed
            
        except FileNotFoundError:
            print(f"  xdotool not installed")
            self._log_result("xdotool", False, "Not installed")
            return False
        except subprocess.TimeoutExpired:
            self._log_result("xdotool", False, "Timeout")
            return False
        except Exception as e:
            self._log_result("xdotool", False, str(e))
            return False
    
    # =========================================================================
    # Test: Full Detection Flow
    # =========================================================================
    
    def test_full_detection_flow(self):
        """Test the complete window detection flow as used in the app."""
        print("\n" + "=" * 60)
        print("TEST: Full Detection Flow (App Logic)")
        print("=" * 60)
        
        result = None
        method_used = None
        
        # Method order for Wayland: introspect -> atspi -> gdbus -> xdotool
        methods = [
            ('gnome_introspect', self._try_introspect),
            ('atspi', self._try_atspi),
            ('gdbus', self._try_gdbus),
            ('xdotool', self._try_xdotool),
        ]
        
        for method_name, method_func in methods:
            print(f"  Trying {method_name}...")
            try:
                result = method_func()
                if result and result[0] and result[0] != 'Unknown':
                    method_used = method_name
                    print(f"  ✓ {method_name} succeeded: {result}")
                    break
                else:
                    print(f"  ✗ {method_name} returned: {result}")
            except Exception as e:
                print(f"  ✗ {method_name} error: {e}")
        
        if not result or result[0] == 'Unknown':
            result = ('Unknown', 'Unknown')
        
        print(f"\n  Final result: {result}")
        print(f"  Method used: {method_used or 'None (all failed)'}")
        
        passed = result[0] != 'Unknown'
        self._log_result(
            "Full Detection Flow",
            passed,
            f"Method={method_used}, Title='{result[0]}'"
        )
        return passed
    
    def _try_introspect(self):
        """Try gnome_introspect method."""
        result = subprocess.run(
            ['gdbus', 'call', '--session',
             '--dest', 'org.gnome.Shell',
             '--object-path', '/org/gnome/Shell/Introspect',
             '--method', 'org.gnome.Shell.Introspect.GetWindows'],
            capture_output=True, text=True, timeout=5
        )
        if result.returncode != 0:
            return None
        
        stdout = result.stdout
        for m in re.finditer(r"'title':\s*<\s*'([^']*)'\s*>", stdout):
            title = m.group(1)
            lookahead = stdout[m.end():m.end() + 500]
            if "'has-focus': <true>" in lookahead:
                block = stdout[m.start():m.end() + 500]
                app_m = re.search(r"'app-id':\s*<\s*'([^']*)'\s*>", block)
                return (title, app_m.group(1) if app_m else 'Unknown')
        return None
    
    def _try_atspi(self):
        """Try AT-SPI method."""
        try:
            import gi
            gi.require_version('Atspi', '2.0')
            from gi.repository import Atspi
            Atspi.init()
            desktop = Atspi.get_desktop(0)
            ACTIVE = Atspi.StateType.ACTIVE
            for i in range(desktop.get_child_count()):
                app = desktop.get_child_at_index(i)
                if not app or app.get_name() == 'gnome-shell':
                    continue
                for j in range(app.get_child_count()):
                    win = app.get_child_at_index(j)
                    if win and win.get_state_set().contains(ACTIVE):
                        return (win.get_name() or 'Unknown', app.get_name() or 'Unknown')
        except Exception:
            pass
        return None
    
    def _try_gdbus(self):
        """Try Shell.Eval method."""
        result = subprocess.run(
            ['gdbus', 'call', '--session',
             '--dest', 'org.gnome.Shell',
             '--object-path', '/org/gnome/Shell',
             '--method', 'org.gnome.Shell.Eval',
             "let w=global.display.focus_window;w?(w.title+'|||'+w.wm_class):'|||'"],
            capture_output=True, text=True, timeout=2
        )
        if result.returncode == 0:
            m = re.search(r"\(true,\s*'([^']*)'\)", result.stdout)
            if m and '|||' in m.group(1):
                parts = m.group(1).split('|||')
                return (parts[0] or 'Unknown', parts[1] or 'Unknown')
        return None
    
    def _try_xdotool(self):
        """Try xdotool method."""
        wid = subprocess.run(['xdotool', 'getactivewindow'],
                            capture_output=True, text=True, timeout=1)
        if wid.returncode != 0:
            return None
        wid = wid.stdout.strip()
        
        name = subprocess.run(['xdotool', 'getwindowname', wid],
                             capture_output=True, text=True, timeout=1)
        title = name.stdout.strip() if name.returncode == 0 else 'Unknown'
        return (title, 'Unknown')
    
    # =========================================================================
    # Run All Tests
    # =========================================================================
    
    def run_all(self):
        """Run all tests and print summary."""
        print("\n" + "=" * 60)
        print("WAYLAND WINDOW DETECTION TEST SUITE")
        print("=" * 60)
        print(f"Started at: {datetime.now().isoformat()}")
        
        # Run tests
        self.test_environment_detection()
        self.test_introspect_api_available()
        self.test_introspect_getwindows()
        self.test_shell_eval()
        self.test_atspi()
        self.test_xdotool()
        self.test_full_detection_flow()
        
        # Print summary
        print("\n" + "=" * 60)
        print("TEST SUMMARY")
        print("=" * 60)
        
        passed = sum(1 for r in self.results if r['passed'])
        total = len(self.results)
        
        for r in self.results:
            status = "✅" if r['passed'] else "❌"
            print(f"  {status} {r['test']}: {r['details']}")
        
        print(f"\n  Total: {passed}/{total} tests passed")
        
        # Recommendations
        print("\n" + "=" * 60)
        print("RECOMMENDATIONS")
        print("=" * 60)
        
        introspect_ok = any(r['test'] == 'GetWindows Call' and r['passed'] for r in self.results)
        atspi_ok = any(r['test'] == 'AT-SPI2' and r['passed'] for r in self.results)
        gdbus_ok = any(r['test'] == 'Shell.Eval' and r['passed'] for r in self.results)
        
        if introspect_ok:
            print("  ✓ gnome_introspect is working - this is the preferred method")
        else:
            print("  ⚠ gnome_introspect is NOT working - investigate GetWindows parsing")
        
        if atspi_ok:
            print("  ✓ AT-SPI2 is available as fallback")
        else:
            print("  ⚠ AT-SPI2 not available - install: sudo apt install python3-gi gir1.2-atspi-2.0")
        
        if not gdbus_ok:
            print("  ℹ Shell.Eval disabled (normal for GNOME 45+)")
            print("    To enable: gsettings set org.gnome.shell development-tools true")
        
        return passed == total
    
    def save_results(self, filepath=None):
        """Save results to JSON file."""
        if filepath is None:
            filepath = f"wayland_test_results_{datetime.now().strftime('%Y%m%d_%H%M%S')}.json"
        
        with open(filepath, 'w') as f:
            json.dump({
                'timestamp': datetime.now().isoformat(),
                'environment': {
                    'is_wayland': self.is_wayland,
                    'gnome_version': self.gnome_version,
                    'wayland_display': os.environ.get('WAYLAND_DISPLAY', ''),
                    'xdg_session_type': os.environ.get('XDG_SESSION_TYPE', ''),
                },
                'results': self.results
            }, f, indent=2)
        
        print(f"\nResults saved to: {filepath}")


def main():
    """Run tests."""
    tests = WaylandWindowDetectionTests()
    tests.run_all()
    tests.save_results()


if __name__ == '__main__':
    main()
```

### 6.2 Integration Test Script

Create file: `python-desktop-app/tests/test_wayland_integration.sh`

```bash
#!/bin/bash
# Integration test for Wayland window detection
# Run this script while using different applications to verify detection

set -e

echo "=============================================="
echo "Wayland Window Detection Integration Test"
echo "=============================================="
echo ""

# Check if on Wayland
if [ -z "$WAYLAND_DISPLAY" ]; then
    echo "WARNING: Not running on Wayland (WAYLAND_DISPLAY not set)"
    echo "This test is designed for Wayland sessions"
    echo ""
fi

# Check GNOME version
GNOME_VERSION=$(gnome-shell --version 2>/dev/null | grep -oP '\d+\.\d+' || echo "N/A")
echo "GNOME Shell Version: $GNOME_VERSION"
echo ""

# Test 1: Introspect API
echo "Test 1: GNOME Shell Introspect API"
echo "-----------------------------------"
if gdbus introspect --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Introspect 2>/dev/null | grep -q GetWindows; then
    echo "✓ Introspect API available"
    
    # Get windows
    WINDOWS=$(gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Introspect --method org.gnome.Shell.Introspect.GetWindows 2>&1)
    
    if [ $? -eq 0 ]; then
        echo "✓ GetWindows call succeeded"
        # Check for focused window
        if echo "$WINDOWS" | grep -q "'has-focus': <true>"; then
            echo "✓ Focused window found in response"
        else
            echo "⚠ No focused window found (try clicking on a window)"
        fi
    else
        echo "✗ GetWindows call failed"
        echo "  Error: $WINDOWS"
    fi
else
    echo "✗ Introspect API not available"
fi
echo ""

# Test 2: Shell.Eval (may be disabled)
echo "Test 2: GNOME Shell.Eval API"
echo "----------------------------"
EVAL_RESULT=$(gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "global.display.focus_window?.title || 'none'" 2>&1)

if echo "$EVAL_RESULT" | grep -q "(true,"; then
    echo "✓ Shell.Eval is enabled"
    TITLE=$(echo "$EVAL_RESULT" | grep -oP "'\K[^']+")
    echo "  Focused window: $TITLE"
else
    echo "⚠ Shell.Eval is disabled (expected on GNOME 45+)"
    echo "  To enable: gsettings set org.gnome.shell development-tools true"
fi
echo ""

# Test 3: AT-SPI2
echo "Test 3: AT-SPI2 Accessibility"
echo "-----------------------------"
if python3 -c "import gi; gi.require_version('Atspi', '2.0'); from gi.repository import Atspi; print('OK')" 2>/dev/null; then
    echo "✓ AT-SPI2 Python bindings available"
else
    echo "✗ AT-SPI2 not available"
    echo "  Install: sudo apt install python3-gi gir1.2-atspi-2.0"
fi
echo ""

# Test 4: xdotool
echo "Test 4: xdotool (XWayland)"
echo "--------------------------"
if command -v xdotool &>/dev/null; then
    WID=$(xdotool getactivewindow 2>/dev/null)
    if [ -n "$WID" ]; then
        TITLE=$(xdotool getwindowname "$WID" 2>/dev/null || echo "Unknown")
        echo "✓ xdotool found active XWayland window"
        echo "  Window ID: $WID"
        echo "  Title: $TITLE"
    else
        echo "⚠ xdotool: No active XWayland window (focused app may be native Wayland)"
    fi
else
    echo "✗ xdotool not installed"
    echo "  Install: sudo apt install xdotool"
fi
echo ""

# Summary
echo "=============================================="
echo "Summary"
echo "=============================================="
echo "For best Wayland support, ensure:"
echo "  1. GNOME Shell Introspect works (primary method)"
echo "  2. AT-SPI2 is available (fallback for native apps)"
echo "  3. xdotool installed (fallback for XWayland apps)"
echo ""
echo "Run the Python test suite for detailed diagnostics:"
echo "  python tests/test_wayland_window_detection.py"
```

---

## 7. Rollout Strategy

### Stage 1: Development (Week 1)
- Implement gnome_introspect fixes
- Add detailed logging
- Create test scripts
- Test on development machines

### Stage 2: Internal Testing (Week 2)
- Deploy to internal Linux users
- Collect logs from multiple GNOME versions
- Verify circuit breaker behavior
- Test AppImage packaging

### Stage 3: Beta Release (Week 3)
- Release to subset of Linux users
- Monitor "Unknown" window percentage
- Gather feedback on user notifications

### Stage 4: General Release (Week 4)
- Full rollout to all Linux users
- Update documentation
- Monitor success metrics

---

## 8. Success Metrics

### Primary Metrics

| Metric | Current | Target | Measurement |
|--------|---------|--------|-------------|
| "Unknown" window percentage | 52% | < 10% | Supabase activity_records |
| gnome_introspect success rate | 0% | > 80% | App telemetry |
| Circuit breaker trigger rate | High | < 5% | App logs |

### Secondary Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| User complaints | < 5/week | Support tickets |
| Diagnostic command usage | Tracked | App telemetry |
| Documentation visits | Tracked | Analytics |

---

## Appendix A: Test Environment Setup

### Ubuntu 22.04 (GNOME 42)
```bash
# Install dependencies
sudo apt update
sudo apt install -y python3-gi gir1.2-atspi-2.0 xdotool gdbus

# Verify GNOME version
gnome-shell --version
```

### Ubuntu 24.04 (GNOME 46)
```bash
# Same as above, GNOME 46 has Introspect improvements
sudo apt install -y python3-gi gir1.2-atspi-2.0 xdotool
```

### Fedora 40 (GNOME 46)
```bash
sudo dnf install -y python3-gobject at-spi2-core xdotool
```

---

## Appendix B: Debugging Commands

```bash
# Check D-Bus session
echo $DBUS_SESSION_BUS_ADDRESS

# List GNOME Shell D-Bus interfaces
gdbus introspect --session --dest org.gnome.Shell --object-path /org/gnome/Shell

# Monitor window changes (useful for debugging)
dbus-monitor --session "interface='org.gnome.Shell.Introspect'"

# Check AT-SPI2 service
systemctl --user status at-spi-dbus-bus.service

# Enable accessibility (required for some apps)
gsettings set org.gnome.desktop.interface toolkit-accessibility true

# Check current focus via GNOME
gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell/Introspect --method org.gnome.Shell.Introspect.GetWindows | grep -A5 "has-focus"
```

---

*Document created: 2026-06-11*  
*Last updated: 2026-06-11*
