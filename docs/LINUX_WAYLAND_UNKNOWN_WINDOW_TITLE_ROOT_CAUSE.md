# Root Cause Analysis: Unknown Window Titles on Linux (Wayland)

## Executive Summary

The TimeTracker desktop application is capturing window titles as "Unknown" for approximately **52% of activity records** for the Linux user (Yamuna Yogitha). This is caused by **Wayland session security isolation** which prevents all available window detection methods from accessing native Wayland window information.

---

## Environment Details

| Attribute | Value |
|-----------|-------|
| **Operating System** | Linux 6.17.0-35-generic (Ubuntu) |
| **Display Session** | Wayland (`session=wayland`, `WAYLAND_DISPLAY='wayland-0'`) |
| **Display Server** | GNOME (with XWayland compatibility layer) |
| **TimeTracker Version** | v1.0.4 |
| **App Format** | AppImage |

---

## Evidence from Logs

### 1. Activity Records Analysis

| Metric | Count | Percentage |
|--------|-------|------------|
| **Total batch samples logged** | 105 | 100% |
| **Successful window captures** | 50 | 47.6% |
| **"Unknown" window titles** | 55 | 52.4% |

### 2. Circuit-Breaker Failures (FIX-6)

The logs show **1,170 circuit-breaker warnings** indicating repeated failures of all window detection methods:

```
2026-06-09 09:29:27 - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-09 09:29:27 - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-09 09:42:57 - [WARN] FIX-6: Window detection method 'atspi' circuit-open for 60s
```

### 3. Successfully Captured Window Titles (Pattern)

The windows that ARE successfully captured are primarily **XWayland applications**:
- VS Code (Electron, runs via XWayland)
- Terminal/SSH sessions
- FortiClient (GTK app with XWayland fallback)

---

## Root Cause: Wayland Security Isolation

### Background: Wayland vs X11

Wayland is a modern display protocol designed with **security by isolation**. Unlike X11, Wayland:
- **Does NOT expose a global window list** to applications
- **Does NOT allow applications to query other windows' titles** (by design)
- **Prevents applications from capturing global input events** (keyboard/mouse)
- **Isolates applications from each other** for security reasons

### Impact on TimeTracker Window Detection Methods

The TimeTracker uses **4 fallback methods** for detecting the active window on Linux. All of them are failing or partially failing on this Wayland setup:

#### Method 1: `gdbus` (org.gnome.Shell.Eval) — **FAILING**
```
Circuit-breaker: OPEN
```

**Why it fails:**
- **GNOME 45+ disables `org.gnome.Shell.Eval` by default** (security hardening)
- The JavaScript eval interface was considered a security risk
- Users must manually enable "unsafe mode" via `gsettings` to use this method
- The command `gsettings set org.gnome.shell development-tools true` enables it, but it's discouraged

**Evidence:**
```log
[WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
```

#### Method 2: `gnome_introspect` (org.gnome.Shell.Introspect.GetWindows) — **FAILING**
```
Circuit-breaker: OPEN
```

**Why it fails:**
- This D-Bus API is available on GNOME 40+ without requiring unsafe mode
- It **should work**, but is failing on this system
- Possible causes:
  1. GNOME Shell extension/permission issue
  2. D-Bus session bus not accessible from AppImage sandbox
  3. Shell.Introspect interface version mismatch
  4. GNOME Shell internal error when processing the request

**Evidence:**
```log
[WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
```

#### Method 3: `atspi` (AT-SPI2 Accessibility Service) — **FAILING**
```
Circuit-breaker: OPEN
```

**Why it fails:**
- AT-SPI2 requires `python3-gi` (GObject Introspection bindings)
- The AppImage does **NOT bundle `python3-gi`** (too large/complex)
- The fallback spawns system `python3` with gi imports, but this requires:
  - `python3-gi` package installed on the host system
  - Accessibility service (at-spi2-core) running
  - Applications to support accessibility (Chrome/Firefox do, but not all apps)

**Evidence:**
```log
[WARN] FIX-6: Window detection method 'atspi' circuit-open for 60s
```

#### Method 4: `xdotool` (XWayland Fallback) — **PARTIALLY WORKING**
```
Circuit-breaker: NOT TRIGGERED (no logs)
```

**Why it's the only method that sometimes works:**
- `xdotool` uses X11 APIs (EWMH/ICCCM) to query the active window
- On Wayland, it can only see **XWayland windows** (X11 apps running in compatibility mode)
- Many modern apps (Chrome, Firefox, GNOME apps) run as **native Wayland** and are invisible to xdotool

**Why it returns "Unknown":**
- When a native Wayland window is focused, xdotool sees the **stale XWayland focus**
- If no XWayland window has ever been focused, `getactivewindow` returns an error
- The code handles this by returning `('Unknown', 'Unknown')`

**Evidence of partial success:**
```log
window_title='Login Successful - Google Chrome'  ← XWayland window
window_title='.env - demo_mco - yogi - Visual Studio Code'  ← VS Code (Electron/XWayland)
window_title='Unknown'  ← Native Wayland window was focused
```

---

## Additional Wayland-Related Issues

### 1. Input Monitoring Broken

```log
[WARN] Running on Wayland — pynput may require XWayland for global input monitoring
[ERROR] Activity listener NOT receiving events after 5s — idle detection may be broken
```

**Root Cause:** Wayland does not allow global input capture. `pynput` uses X11 APIs and can only see input events going to XWayland windows.

### 2. Screenshot Capture Affected

```log
[WARNING] scrot produced an all-black image (Wayland XWayland root) — skipping
```

**Root Cause:** XWayland's root window is black on Wayland (the compositor doesn't expose Wayland content to X11 clients).

---

## Why Some Window Titles ARE Captured

When the user switches to applications running under **XWayland** (not native Wayland), the `xdotool` method succeeds:

| Application | Captured? | Reason |
|-------------|-----------|--------|
| VS Code (Electron) | ✅ Yes | Runs via XWayland |
| Terminal (gnome-terminal or similar) | ✅ Sometimes | May run via XWayland depending on config |
| FortiClient | ✅ Yes | GTK app with XWayland fallback |
| Chrome (native Wayland) | ❌ No | Native Wayland mode |
| Firefox (native Wayland) | ❌ No | Native Wayland mode |
| GNOME Nautilus | ❌ No | Native Wayland |
| Any native GTK4/Qt6 app | ❌ No | Native Wayland |

---

## Summary of Failure Chain

```
┌──────────────────────────────────────────────────────────────────┐
│                    WAYLAND SESSION DETECTED                      │
│                  (WAYLAND_DISPLAY='wayland-0')                   │
└──────────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
┌──────────────────────────────────────────────────────────────────┐
│               WINDOW DETECTION METHOD ORDER                       │
│                    (Wayland: gdbus first)                        │
└──────────────────────────────────────────────────────────────────┘
                                 │
           ┌─────────────────────┼─────────────────────┐
           │                     │                     │
           ▼                     ▼                     ▼
    ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
    │    gdbus     │     │   introspect │     │    atspi     │
    │  Shell.Eval  │     │  GetWindows  │     │  AT-SPI2     │
    └──────────────┘     └──────────────┘     └──────────────┘
           │                     │                     │
           ▼                     ▼                     ▼
    ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
    │   GNOME 45+  │     │   D-Bus/     │     │  python3-gi  │
    │ Disables Eval│     │  Sandbox     │     │ Not in       │
    │  by Default  │     │  Issue?      │     │  AppImage    │
    └──────────────┘     └──────────────┘     └──────────────┘
           │                     │                     │
           ▼                     ▼                     ▼
    ┌──────────────────────────────────────────────────────────────┐
    │              ALL PRIMARY METHODS FAIL                        │
    │           → Circuit-breaker opens (60s cooldown)             │
    └──────────────────────────────────────────────────────────────┘
                                 │
                                 ▼
    ┌──────────────────────────────────────────────────────────────┐
    │                 FALLBACK: xdotool                            │
    │        (Only sees XWayland windows, not native Wayland)      │
    └──────────────────────────────────────────────────────────────┘
                                 │
           ┌─────────────────────┴─────────────────────┐
           │                                           │
           ▼                                           ▼
    ┌──────────────────────┐               ┌──────────────────────┐
    │ User is in XWayland  │               │ User is in native    │
    │ app (VS Code, etc.)  │               │ Wayland app          │
    └──────────────────────┘               └──────────────────────┘
           │                                           │
           ▼                                           ▼
    ┌──────────────────────┐               ┌──────────────────────┐
    │   ✅ Window title    │               │   ❌ Returns         │
    │      captured        │               │   'Unknown'          │
    └──────────────────────┘               └──────────────────────┘
```

---

## Recommendations (To Be Implemented)

### Short-term Fixes

1. **Diagnose `gnome_introspect` failure**
   - Add verbose logging to capture the actual error from `gdbus call`
   - Check if Shell.Introspect interface is available on GNOME version in use
   - Test if running outside AppImage sandbox resolves the issue

2. **Consider bundling AT-SPI2 support in AppImage**
   - Bundle minimal `gi` bindings for Atspi
   - This would enable accessibility-based window tracking

3. **Add user notification for Wayland limitations**
   - Detect Wayland + all methods failing and show a user-visible warning
   - Suggest enabling GNOME unsafe mode if acceptable for their security posture

### Long-term Fixes

1. **Implement XDG Desktop Portal integration**
   - Use `org.freedesktop.portal.Desktop` for window listing (if supported)
   - This is the Wayland-native way to access window information

2. **Consider GNOME Shell Extension**
   - A dedicated GNOME Shell extension could expose window titles via D-Bus
   - This would work reliably on GNOME Wayland without requiring unsafe mode

3. **Hybrid approach**
   - For Wayland users, consider OCR-based app detection as primary method
   - Fall back to window title tracking when available

---

## Appendix: Key Log Entries

### Environment Detection
```log
2026-06-09 09:28:51 - monitor_capture - Display environment: Linux, session=wayland, DISPLAY=':0', WAYLAND_DISPLAY='wayland-0'
```

### Method Failures
```log
2026-06-09 09:29:27 - [WARN] FIX-6: Window detection method 'gdbus' circuit-open for 60s
2026-06-09 09:29:27 - [WARN] FIX-6: Window detection method 'gnome_introspect' circuit-open for 60s
2026-06-09 09:42:57 - [WARN] FIX-6: Window detection method 'atspi' circuit-open for 60s
```

### Input Monitoring Failure
```log
2026-06-09 09:29:19 - [WARN] Running on Wayland — pynput may require XWayland for global input monitoring
2026-06-09 09:29:24 - [ERROR] Activity listener NOT receiving events after 5s — idle detection may be broken
```

### Screenshot Failure
```log
2026-06-09 09:29:22 - [WARNING] scrot produced an all-black image (Wayland XWayland root) — skipping
```

---

## Conclusion

The "Unknown" window titles are a **fundamental limitation of Wayland's security model** combined with **GNOME 45+ disabling the Shell.Eval interface**. The only working method (`xdotool`) can only detect XWayland applications, leaving native Wayland applications untrackable.

This is not a bug in TimeTracker, but rather a compatibility challenge with modern Linux desktop security. The application needs enhanced Wayland-native APIs or user configuration to enable privileged access.

---

*Document generated: 2026-06-11*
*Logs analyzed: /home/yamunay/.local/share/TimeTracker/logs/timetracker.log (June 8-9, 2026)*
