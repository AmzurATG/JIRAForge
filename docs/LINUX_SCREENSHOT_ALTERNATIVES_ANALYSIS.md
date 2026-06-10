# Linux Screenshot Capture: Wayland Flash Issue & Alternatives Analysis

**Document Version:** 1.0  
**Date:** 2026-06-10  
**Author:** Technical Analysis  
**Status:** Active Analysis

---

## Executive Summary

The current screenshot implementation on Linux GNOME/Wayland exhibits a visual "flash" effect during capture. This document provides a deep technical analysis of the root cause, evaluates alternative screenshot tools, and recommends solutions with long-term support (LTS) compatibility for Ubuntu's 2-year release cycle.

---

## Table of Contents

1. [Current Implementation Analysis](#1-current-implementation-analysis)
2. [Root Cause: The Flash Effect](#2-root-cause-the-flash-effect)
3. [Alternative Screenshot Tools Comparison](#3-alternative-screenshot-tools-comparison)
4. [Long-Term Support Evaluation](#4-long-term-support-evaluation)
5. [Recommended Implementation Strategy](#5-recommended-implementation-strategy)
6. [Implementation Guide](#6-implementation-guide)
7. [Risk Assessment](#7-risk-assessment)
8. [Conclusion](#8-conclusion)

---

## 1. Current Implementation Analysis

### 1.1 Current Screenshot Flow

The current implementation in `monitor_capture.py` uses a tiered fallback approach for Linux:

```
Wayland Session:
  1. GNOME Screenshot D-Bus (silent) → flash=false
  2. gnome-screenshot + event-sounds muted
  3. scrot (X11/XWayland fallback)
  4. Pillow XCB (last resort)

X11 Session:
  1. scrot
  2. Pillow XCB
```

### 1.2 Current Methods Implemented

| Method | Implementation | Flash Behavior |
|--------|---------------|----------------|
| `_capture_gnome_dbus_silent()` | D-Bus call with `flash=false` | **No flash** (when accessible) |
| `_capture_gnome_screenshot_muted()` | CLI binary + gsettings mute | **Flash occurs** (just sound muted) |
| `_capture_gnome_screenshot()` | CLI binary default | **Flash + sound** |
| scrot | X11 tool via XWayland | Black image on Wayland |
| Pillow XCB | Python XCB bindings | Black image on Wayland |

### 1.3 Current Code Location

**File:** `python-desktop-app/monitor_capture.py`  
**Key Functions:**
- `_capture_gnome_dbus_silent()` (lines 444-500)
- `_capture_gnome_screenshot_muted()` (lines 504-559)
- `_capture_linux()` (lines 562-640)

---

## 2. Root Cause: The Flash Effect

### 2.1 Technical Explanation

The "flash" effect on GNOME Wayland is caused by GNOME Shell's built-in screenshot animation:

1. **GNOME Shell Screenshot Animation**: When using `gnome-screenshot` binary, it triggers the GNOME Shell camera shutter animation (visual flash + sound).

2. **D-Bus `flash` Parameter**: The `org.gnome.Shell.Screenshot.Screenshot` D-Bus method accepts a `flash` boolean parameter:
   - `flash=true` (default): Shows visual animation + plays sound
   - `flash=false`: Silent capture, no animation

3. **GNOME 46+ Security Restrictions**: Starting with GNOME 46, direct D-Bus access to `org.gnome.Shell.Screenshot` may require permission portals, causing `flash=false` to be denied on newer systems.

### 2.2 Why Current Implementation May Still Flash

```
Scenario: GNOME 46+ (Ubuntu 24.04+)
1. _capture_gnome_dbus_silent() → DENIED (security restrictions)
2. Falls back to _capture_gnome_screenshot_muted()
3. This only mutes SOUND (gsettings event-sounds)
4. Visual FLASH still occurs (animation is separate from sound)
```

### 2.3 Wayland's Design Philosophy

Wayland's security model prevents X11-style screen capture by design:
- Applications cannot read pixels from other applications' windows
- Screenshot requires compositor cooperation via:
  - D-Bus APIs (GNOME Shell, KDE)
  - XDG Desktop Portal (standardized)
  - Compositor-specific tools (grim for wlroots)

---

## 3. Alternative Screenshot Tools Comparison

### 3.1 Full Comparison Matrix

| Tool | Wayland Support | Flash-Free | CLI | Python Integration | LTS Availability | Active Development |
|------|----------------|------------|-----|-------------------|------------------|-------------------|
| **grim** | ✅ Native | ✅ Yes | ✅ Yes | subprocess | Ubuntu 22.04+ | ✅ freedesktop.org |
| **gnome-screenshot D-Bus** | ✅ Native | ✅ flash=false | ❌ D-Bus | subprocess/dbus | All GNOME | ✅ GNOME maintained |
| **Flameshot** | ⚠️ Experimental | ⚠️ Depends | ✅ Yes | subprocess | Universe repo | ✅ 336 contributors |
| **scrot** | ❌ X11 only | ✅ Yes | ✅ Yes | subprocess | All versions | ✅ Maintained |
| **maim** | ❌ X11 only | ✅ Yes | ✅ Yes | subprocess | All versions | ⚠️ Moderate |
| **spectacle** | ✅ KDE only | ✅ Yes | ✅ Yes | subprocess | KDE systems | ✅ KDE maintained |
| **python-mss** | ❌ X11/XCB | ✅ Yes | N/A | ✅ Native | PyPI | ✅ v10.2.0 |
| **XDG Portal** | ✅ Standard | ✅ Yes | ❌ D-Bus | dbus-python | GNOME 41+ | ✅ freedesktop.org |
| **ImageMagick import** | ❌ X11 only | ✅ Yes | ✅ Yes | subprocess | All versions | ✅ Long-maintained |

### 3.2 Detailed Tool Analysis

#### 3.2.1 grim (Recommended for wlroots)

**Repository:** https://gitlab.freedesktop.org/emersion/grim  
**License:** MIT

**Pros:**
- Native Wayland support for wlroots compositors (Sway, Hyprland, etc.)
- No flash or sound effects
- Simple CLI interface
- Official freedesktop.org project
- Fast capture

**Cons:**
- Does NOT work on GNOME Wayland (requires wlroots)
- Requires `slurp` for region selection
- Not available in Ubuntu 20.04 repositories

**Installation:**
```bash
# Ubuntu 22.04+
sudo apt install grim slurp

# Usage
grim screenshot.png                    # Full screen
grim -g "$(slurp)" screenshot.png     # Region selection
```

**Verdict:** ❌ Not suitable for GNOME Wayland

#### 3.2.2 GNOME Screenshot D-Bus (Current Best for GNOME)

**Interface:** `org.gnome.Shell.Screenshot`

**Pros:**
- Native GNOME compositor integration
- `flash=false` parameter eliminates visual flash
- No external dependencies on GNOME systems
- Works with Wayland security model

**Cons:**
- GNOME 46+ may require portal permissions
- Only works on GNOME desktop environment

**Implementation:**
```python
subprocess.run([
    'gdbus', 'call', '--session',
    '--dest', 'org.gnome.Shell',
    '--object-path', '/org/gnome/Shell/Screenshot',
    '--method', 'org.gnome.Shell.Screenshot.Screenshot',
    'false',   # include_cursor
    'false',   # flash (THE KEY PARAMETER)
    filepath,
])
```

**Verdict:** ✅ Best for GNOME when D-Bus access is permitted

#### 3.2.3 XDG Desktop Portal (Future Standard)

**Interface:** `org.freedesktop.portal.Screenshot`  
**Specification:** https://flatpak.github.io/xdg-desktop-portal/

**Pros:**
- Desktop-environment agnostic
- Standardized by freedesktop.org
- Works across GNOME, KDE, wlroots
- Security-conscious (user consent built-in)

**Cons:**
- May require user interaction/consent dialog
- More complex implementation
- Not available on older systems (requires portal backend)

**D-Bus Method:**
```
org.freedesktop.portal.Screenshot.Screenshot (
    parent_window: s,
    options: a{sv}
)
```

**Implementation Consideration:**
The portal approach shows a consent dialog on first use. For automated time tracking, this may be disruptive. However, some backends (GNOME 44+) remember permissions.

**Verdict:** ⚠️ Good future option, but may require user consent

#### 3.2.4 Flameshot

**Repository:** https://github.com/flameshot-org/flameshot  
**License:** GPLv3  
**Stars:** 30.1k

**Pros:**
- Active community (336 contributors)
- Cross-platform (Linux, Windows, macOS)
- Rich feature set
- Available in Ubuntu repositories

**Cons:**
- "Experimental" Wayland support
- Requires D-Bus and system tray
- Heavy dependency (Qt6-based)
- May still trigger flash on some GNOME versions

**Installation:**
```bash
sudo apt install flameshot

# Headless capture
flameshot full -p /path/to/output.png
```

**Verdict:** ⚠️ Not ideal for background automated capture

#### 3.2.5 scrot (X11 Only)

**Repository:** https://github.com/resurrecting-open-source-projects/scrot  
**License:** MIT-like

**Pros:**
- Lightweight, minimal dependencies
- Fast capture
- Long history of maintenance
- Available everywhere

**Cons:**
- X11 only - produces BLACK images on pure Wayland
- Works via XWayland but captures XWayland root (black)

**Current Code Behavior:**
```python
# Already implemented - detects black images
if is_wayland:
    # scrot produces XWayland root which is black
    # Code detects and skips
```

**Verdict:** ❌ Not suitable for Wayland (already handled)

#### 3.2.6 python-mss

**Repository:** https://github.com/BoboTiG/python-mss  
**License:** MIT  
**Version:** 10.2.0

**Pros:**
- Pure Python, no external binaries
- Fast (uses ctypes)
- Cross-platform
- Good numpy/OpenCV integration

**Cons:**
- Uses XCB on Linux (X11 protocol)
- Does NOT work on pure Wayland
- Same black-screen issue as scrot

**Verdict:** ❌ Not suitable for Wayland

---

## 4. Long-Term Support Evaluation

### 4.1 Ubuntu LTS Release Cycle

Ubuntu releases LTS every **2 years** with **5 years standard support**:

| Version | Release Date | End of Standard Support | Display Server |
|---------|--------------|------------------------|----------------|
| Ubuntu 22.04 LTS | April 2022 | April 2027 | X11 default, Wayland optional |
| Ubuntu 24.04 LTS | April 2024 | April 2029 | **Wayland default** |
| Ubuntu 26.04 LTS | April 2026 (projected) | April 2031 | Wayland default |

### 4.2 GNOME Version Mapping

| Ubuntu LTS | GNOME Version | Screenshot D-Bus Behavior |
|------------|---------------|---------------------------|
| 22.04 | GNOME 42 | D-Bus `flash=false` works reliably |
| 24.04 | GNOME 46 | D-Bus may require portal permissions |
| 26.04 | GNOME 48+ (projected) | Portal-based approach recommended |

### 4.3 Tool Availability in Ubuntu Repositories

| Tool | 20.04 LTS | 22.04 LTS | 24.04 LTS |
|------|-----------|-----------|-----------|
| gnome-screenshot | ✅ | ✅ | ✅ |
| gdbus | ✅ (glib) | ✅ | ✅ |
| grim | ❌ | ✅ Universe | ✅ Universe |
| flameshot | ✅ | ✅ | ✅ |
| scrot | ✅ | ✅ | ✅ |
| xdg-desktop-portal | ✅ | ✅ | ✅ |

### 4.4 Wayland Adoption Timeline

```
2022 (Ubuntu 22.04): X11 default, Wayland session available
2024 (Ubuntu 24.04): Wayland default, X11 available
2026 (Ubuntu 26.04): Wayland primary, X11 deprecated but available
2028+: X11 likely minimal support
```

**Implication:** Solutions must prioritize Wayland-native approaches.

---

## 5. Recommended Implementation Strategy

### 5.1 Priority Order for Wayland Capture (Flash-Free)

```python
CAPTURE_PRIORITY = [
    # Priority 1: GNOME Shell D-Bus (flash=false)
    # - Native, flash-free, works on GNOME 42-45
    # - May fail on GNOME 46+ due to security
    "_capture_gnome_dbus_silent",
    
    # Priority 2: XDG Desktop Portal
    # - Standard API, works across DEs
    # - May show consent dialog once
    # - Future-proof approach
    "_capture_xdg_portal",
    
    # Priority 3: grim (for wlroots compositors)
    # - Flash-free, native Wayland
    # - Only works on Sway, Hyprland, etc.
    "_capture_grim",
    
    # Priority 4: GNOME Screenshot binary (MUTED)
    # - Fallback when D-Bus fails
    # - Mutes sound but VISUAL FLASH still occurs
    # - Last resort for GNOME
    "_capture_gnome_screenshot_muted",
    
    # Priority 5: scrot/Pillow XCB (X11 session only)
    # - Only if XDG_SESSION_TYPE != wayland
    "_capture_x11_fallback",
]
```

### 5.2 New Functions to Implement

#### 5.2.1 XDG Desktop Portal Screenshot

```python
def _capture_xdg_portal():
    """Capture via XDG Desktop Portal (standardized Wayland API).
    
    The portal approach is desktop-environment agnostic and works on
    GNOME, KDE, and wlroots compositors with appropriate portal backends.
    
    May show a one-time consent dialog on first use.
    
    Returns PIL.Image on success, None on failure.
    """
    try:
        import dbus
        bus = dbus.SessionBus()
        portal = bus.get_object(
            'org.freedesktop.portal.Desktop',
            '/org/freedesktop/portal/desktop'
        )
        screenshot_iface = dbus.Interface(
            portal, 
            'org.freedesktop.portal.Screenshot'
        )
        
        # Empty parent window, no options (non-interactive if possible)
        handle_path = screenshot_iface.Screenshot('', {})
        
        # The portal returns asynchronously via a Response signal
        # Implementation requires signal handling...
        
    except Exception as e:
        logger.debug(f"XDG Portal screenshot failed: {e}")
        return None
```

#### 5.2.2 grim for wlroots Compositors

```python
def _capture_grim():
    """Capture via grim (wlroots-native Wayland screenshot tool).
    
    grim is the standard screenshot tool for wlroots-based compositors
    (Sway, Hyprland, river, etc.). It does NOT work on GNOME or KDE.
    
    Returns PIL.Image on success, None on failure.
    """
    if not shutil.which('grim'):
        return None
    
    # Detect if running on wlroots compositor
    compositor = os.environ.get('XDG_CURRENT_DESKTOP', '').lower()
    wayland_compositor = os.environ.get('WAYLAND_DISPLAY', '')
    
    # grim only works on wlroots compositors
    wlroots_compositors = {'sway', 'hyprland', 'river', 'wayfire', 'dwl'}
    if compositor not in wlroots_compositors:
        # Check for Sway-specific env
        if 'SWAYSOCK' not in os.environ:
            logger.debug("grim: Not a wlroots compositor, skipping")
            return None
    
    fh, filepath = tempfile.mkstemp('.png')
    os.close(fh)
    
    try:
        result = subprocess.run(
            ['grim', filepath],
            capture_output=True,
            timeout=5,
            env=_clean_env_for_screenshot(),
        )
        if result.returncode == 0 and os.path.exists(filepath):
            im = _PILImage.open(filepath)
            im.load()
            # Validate not all-black
            import array as _array
            bands = im.split()
            if any(max(_array.array('B', b.tobytes())) > 0 for b in bands):
                logger.debug("Linux capture: grim (wlroots)")
                return im.copy()
        logger.debug(f"grim failed: {result.stderr.decode()[:200]}")
    except Exception as e:
        logger.debug(f"grim error: {e}")
    finally:
        try:
            os.unlink(filepath)
        except OSError:
            pass
    
    return None
```

### 5.3 Recommended Fallback Chain

```
┌─────────────────────────────────────────────────────────────────┐
│                    Screenshot Capture Flow                       │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │ Is Wayland Session?                                       │   │
│  └─────────────────────┬────────────────────────────────────┘   │
│                        │                                         │
│          ┌─────────────▼──────────────┐                         │
│          │         NO (X11)           │                         │
│          │  ┌──────────────────────┐  │                         │
│          │  │ 1. scrot             │  │                         │
│          │  │ 2. Pillow XCB        │  │                         │
│          │  └──────────────────────┘  │                         │
│          └────────────────────────────┘                         │
│                                                                  │
│          ┌─────────────▼──────────────┐                         │
│          │       YES (Wayland)        │                         │
│          └────────────────────────────┘                         │
│                        │                                         │
│  ┌─────────────────────▼─────────────────────────────────────┐  │
│  │ 1. GNOME D-Bus Screenshot (flash=false)                   │  │
│  │    └─ SUCCESS? → Return image (NO FLASH ✓)               │  │
│  └───────────────────────────────────────────────────────────┘  │
│                        │ FAIL                                    │
│  ┌─────────────────────▼─────────────────────────────────────┐  │
│  │ 2. grim (if wlroots compositor detected)                  │  │
│  │    └─ SUCCESS? → Return image (NO FLASH ✓)               │  │
│  └───────────────────────────────────────────────────────────┘  │
│                        │ FAIL                                    │
│  ┌─────────────────────▼─────────────────────────────────────┐  │
│  │ 3. XDG Desktop Portal (may show consent once)             │  │
│  │    └─ SUCCESS? → Return image (NO FLASH ✓)               │  │
│  └───────────────────────────────────────────────────────────┘  │
│                        │ FAIL                                    │
│  ┌─────────────────────▼─────────────────────────────────────┐  │
│  │ 4. gnome-screenshot --file (FALLBACK - MAY FLASH)        │  │
│  │    └─ Note: Visual flash occurs, only sound muted        │  │
│  └───────────────────────────────────────────────────────────┘  │
│                        │ FAIL                                    │
│  ┌─────────────────────▼─────────────────────────────────────┐  │
│  │ 5. Return None (skip capture this tick)                   │  │
│  └───────────────────────────────────────────────────────────┘  │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## 6. Implementation Guide

### 6.1 Phase 1: Improve D-Bus Detection (Quick Win)

**Objective:** Better detect when D-Bus `flash=false` is working.

```python
# Add to monitor_capture.py

_DBUS_SCREENSHOT_AVAILABLE = None  # None = untested, True/False = cached result

def _test_gnome_dbus_screenshot():
    """Test if GNOME D-Bus screenshot with flash=false is available.
    
    Called once at startup to cache the result.
    """
    global _DBUS_SCREENSHOT_AVAILABLE
    
    if _DBUS_SCREENSHOT_AVAILABLE is not None:
        return _DBUS_SCREENSHOT_AVAILABLE
    
    try:
        result = subprocess.run(
            ['gdbus', 'introspect', '--session',
             '--dest', 'org.gnome.Shell',
             '--object-path', '/org/gnome/Shell/Screenshot'],
            capture_output=True, timeout=2
        )
        _DBUS_SCREENSHOT_AVAILABLE = (
            result.returncode == 0 and 
            b'Screenshot' in result.stdout
        )
    except Exception:
        _DBUS_SCREENSHOT_AVAILABLE = False
    
    logger.info(f"GNOME D-Bus Screenshot available: {_DBUS_SCREENSHOT_AVAILABLE}")
    return _DBUS_SCREENSHOT_AVAILABLE
```

### 6.2 Phase 2: Add grim Support

**Objective:** Support wlroots compositors (Sway, Hyprland users).

See implementation in Section 5.2.2.

### 6.3 Phase 3: XDG Portal Integration (Future)

**Objective:** Standard, future-proof capture method.

**Complexity:** Medium-High (requires async D-Bus handling)

**Recommendation:** Defer to Phase 3 unless GNOME 46+ issues are widespread.

### 6.4 Environment Detection Enhancement

```python
def _detect_wayland_compositor():
    """Detect the specific Wayland compositor in use.
    
    Returns:
        dict with keys:
        - 'is_wayland': bool
        - 'compositor': str ('gnome', 'kde', 'sway', 'hyprland', 'unknown')
        - 'recommended_tool': str
    """
    is_wayland = bool(
        os.environ.get('WAYLAND_DISPLAY') or
        os.environ.get('XDG_SESSION_TYPE', '').lower() == 'wayland'
    )
    
    if not is_wayland:
        return {
            'is_wayland': False,
            'compositor': 'x11',
            'recommended_tool': 'scrot'
        }
    
    desktop = os.environ.get('XDG_CURRENT_DESKTOP', '').lower()
    session = os.environ.get('DESKTOP_SESSION', '').lower()
    
    if 'gnome' in desktop or 'gnome' in session:
        return {
            'is_wayland': True,
            'compositor': 'gnome',
            'recommended_tool': 'gnome-dbus'
        }
    
    if 'kde' in desktop or 'plasma' in desktop:
        return {
            'is_wayland': True,
            'compositor': 'kde',
            'recommended_tool': 'spectacle-dbus'
        }
    
    if 'sway' in desktop or 'SWAYSOCK' in os.environ:
        return {
            'is_wayland': True,
            'compositor': 'sway',
            'recommended_tool': 'grim'
        }
    
    if 'hyprland' in desktop or 'HYPRLAND_INSTANCE_SIGNATURE' in os.environ:
        return {
            'is_wayland': True,
            'compositor': 'hyprland',
            'recommended_tool': 'grim'
        }
    
    return {
        'is_wayland': True,
        'compositor': 'unknown',
        'recommended_tool': 'xdg-portal'
    }
```

---

## 7. Risk Assessment

### 7.1 Risk Matrix

| Risk | Probability | Impact | Mitigation |
|------|-------------|--------|------------|
| GNOME 46+ blocks D-Bus | Medium | High | Implement XDG Portal fallback |
| grim not installed | Low | Low | Graceful fallback to other methods |
| Portal shows consent dialog | Medium | Medium | Document for users; one-time |
| XDG Portal not available | Low | Medium | Keep gnome-screenshot fallback |
| Visual flash on fallback | Medium | Low | Acceptable for edge cases |

### 7.2 Compatibility Concerns

| Scenario | Current Behavior | After Changes |
|----------|------------------|---------------|
| Ubuntu 22.04 GNOME Wayland | D-Bus works (no flash) | Same (no change) |
| Ubuntu 24.04 GNOME Wayland | May flash if D-Bus blocked | Try portal before fallback |
| Fedora with Sway | Black image (scrot fallback) | grim captures correctly |
| Pure X11 session | scrot works | No change needed |

### 7.3 Dependency Management

**New Optional Dependencies:**
```
grim          - Optional, for wlroots compositors
slurp         - Optional, for region selection with grim
python-dbus   - Optional, for XDG Portal (may already be present)
```

**Recommendation:** Keep all as optional with graceful degradation.

---

## 8. Conclusion

### 8.1 Summary of Findings

1. **The flash issue** is caused by GNOME Shell's screenshot animation, NOT the sound.
2. **Current implementation** correctly uses `flash=false` via D-Bus, but falls back to the binary when D-Bus is restricted.
3. **GNOME 46+** introduces stricter security that may block direct D-Bus access.
4. **scrot and python-mss** do NOT work on Wayland (black images).
5. **grim** is excellent for wlroots but doesn't work on GNOME.
6. **XDG Desktop Portal** is the future-proof solution.

### 8.2 Recommended Actions

| Priority | Action | Effort | Impact |
|----------|--------|--------|--------|
| 1 | Add grim support for wlroots users | Low | Medium |
| 2 | Improve D-Bus availability detection | Low | Medium |
| 3 | Research XDG Portal async implementation | Medium | High |
| 4 | Add compositor detection logging | Low | Low |
| 5 | Document known flash scenarios | Low | Low |

### 8.3 Long-Term Recommendation

**For Ubuntu LTS compatibility (2-year cycle):**

1. **Ubuntu 22.04-24.04**: Continue using GNOME D-Bus `flash=false` as primary
2. **Ubuntu 24.04+**: Prepare XDG Portal implementation as D-Bus restrictions increase
3. **wlroots users**: Add grim support (small user base but growing)
4. **Accept fallback flash**: For edge cases where all silent methods fail

### 8.4 Code Change Summary

```diff
# monitor_capture.py changes

+ def _detect_wayland_compositor():
+     """Detect compositor for optimal tool selection."""
+     ...

+ def _capture_grim():
+     """grim capture for wlroots compositors."""
+     ...

+ def _capture_xdg_portal():
+     """XDG Portal capture (future implementation)."""
+     ...

  def _capture_linux():
-     # Current: D-Bus → gnome-screenshot-muted → scrot → Pillow
+     # New: D-Bus → grim (wlroots) → portal → gnome-screenshot → scrot
      ...
```

---

## Appendix A: Tool Installation Commands

```bash
# Ubuntu 22.04+ / Debian
sudo apt install grim slurp                    # wlroots screenshot
sudo apt install gnome-screenshot              # GNOME screenshot
sudo apt install scrot                         # X11 screenshot
sudo apt install flameshot                     # Cross-platform (Qt)

# Fedora
sudo dnf install grim slurp
sudo dnf install gnome-screenshot
sudo dnf install scrot
sudo dnf install flameshot

# Arch Linux
sudo pacman -S grim slurp
sudo pacman -S gnome-screenshot
sudo pacman -S scrot
sudo pacman -S flameshot
```

## Appendix B: Testing Commands

```bash
# Test D-Bus availability
gdbus introspect --session --dest org.gnome.Shell \
    --object-path /org/gnome/Shell/Screenshot

# Test D-Bus capture (silent)
gdbus call --session --dest org.gnome.Shell \
    --object-path /org/gnome/Shell/Screenshot \
    --method org.gnome.Shell.Screenshot.Screenshot \
    false false /tmp/test-screenshot.png

# Test grim
grim /tmp/test-grim.png

# Test XDG Portal availability
gdbus introspect --session --dest org.freedesktop.portal.Desktop \
    --object-path /org/freedesktop/portal/desktop
```

## Appendix C: Environment Variables for Testing

```bash
# Force X11 session (for testing)
export XDG_SESSION_TYPE=x11

# Force Wayland detection
export WAYLAND_DISPLAY=wayland-0
export XDG_SESSION_TYPE=wayland

# Simulate Sway
export SWAYSOCK=/run/user/1000/sway-ipc.sock
export XDG_CURRENT_DESKTOP=sway
```

---

**Document End**
