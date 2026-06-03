# Idle Detection Fix Plan — Wayland / Display-Server Compatibility

**Date:** 2026-06-03  
**Affected file:** `python-desktop-app/desktop_app.py`  
**Error observed in logs:**
```
Activity monitoring not receiving events — idle detection may be broken on this display server
```

---

## 1. Root Cause Summary

### What currently happens

`monitor_user_activity()` starts `pynput` mouse and keyboard listeners, then spawns a
verification thread that sleeps 5 seconds and checks whether `_activity_listener_started`
has been set to `True` by an actual input event. If it hasn't, the error is logged.

### Why it fails on Wayland

`pynput` relies on **X11 hooks** (`XRecord` / `XGrabPointer` / `XGrabKeyboard`) to
intercept global input events. On a **Wayland** session those calls are routed to the
XWayland compatibility layer. When:

- XWayland is **not running**, or  
- The app was launched from a Wayland-native launcher (e.g., GNOME App Menu) without a
  valid `DISPLAY` env-var, or  
- The compositor explicitly blocks X11 global grabs (becoming common in GNOME 45+),

`pynput` starts without raising an exception but its callbacks **never fire**. This is
the "silent failure" that triggers the log error.

### Impact

| Consequence | Detail |
|-------------|--------|
| Idle detection disabled | `last_activity_time` is never updated by user input |
| Time over-counting | App keeps tracking even after user walks away |
| No idle records created | `activity_records` have no `is_idle=True` rows for idle periods |
| Idle suppression heuristic fires | The `time_since_last_shot < idle_timeout` guard in `tracking_loop` fires every cycle, resetting `last_activity_time` — so the app **never** enters idle even after hours of inactivity |

---

## 2. Fix Strategy — Multi-Tier Fallback

Replace the single `pynput`-only approach with a **priority chain** of idle-detection
backends. Each tier is tried in order; the first one that succeeds at runtime is used.

```
Tier 1 — D-Bus ScreenSaver (GetSessionIdleTime)
        Works on GNOME ≥ 3.x, KDE Plasma 5/6, LXQt — Wayland native
Tier 2 — org.gnome.Mutter.IdleMonitor (GNOME D-Bus)
        GNOME-specific; also Wayland native
Tier 3 — evdev raw input (/dev/input/event*)
        Reads from kernel input subsystem — display-server agnostic
        Requires user in `input` group (or udev rule)
Tier 4 — pynput (existing implementation)
        X11/XWayland — current behaviour; kept as fallback
```

---

## 3. Detailed Implementation Plan

### 3.1 New helper: `_detect_idle_backend()`

Add a method that probes each tier and returns an object/callable describing the chosen
backend. Called once at startup from `monitor_user_activity()`.

```
def _detect_idle_backend(self) -> str:
    Returns one of: 'dbus_screensaver' | 'gnome_mutter' | 'evdev' | 'pynput' | 'none'
```

**Probe logic:**
1. Try importing `dbus` (python-dbus) and calling
   `org.freedesktop.ScreenSaver.GetSessionIdleTime()` with a 1-second timeout.
2. If that fails, try `org.gnome.Mutter.IdleMonitor.GetIdletime()`.
3. If that fails, check whether any `/dev/input/event*` device is readable by the
   current user (`os.access`).
4. Fall back to `pynput`.

---

### 3.2 D-Bus ScreenSaver backend (Tier 1)

**How it works:**  
`org.freedesktop.ScreenSaver` exposes `GetSessionIdleTime()` which returns milliseconds
since last input — regardless of display server.

**Implementation:**

```python
def _poll_dbus_idle_time(self) -> int | None:
    """Returns idle milliseconds via D-Bus ScreenSaver, or None on failure."""
    try:
        import dbus
        bus = dbus.SessionBus()
        ss = bus.get_object('org.freedesktop.ScreenSaver',
                            '/org/freedesktop/ScreenSaver')
        iface = dbus.Interface(ss, 'org.freedesktop.ScreenSaver')
        return int(iface.GetSessionIdleTime())
    except Exception:
        return None
```

**Usage in tracking loop:**  
Poll every 10 seconds (configurable). If returned value ≥ `idle_timeout * 1000` ms,
call `enter_idle("idle timeout")`. When value drops below threshold after being high,
call `resume_from_idle()`.

**Packages needed:**  
`python-dbus` (already installed in most GNOME/KDE environments).  
Fallback if `import dbus` fails.

---

### 3.3 GNOME Mutter IdleMonitor backend (Tier 2)

**How it works:**  
`org.gnome.Mutter.IdleMonitor` is a GNOME-specific D-Bus service that reports idle time
without X11.

```python
def _poll_gnome_mutter_idle(self) -> int | None:
    try:
        import dbus
        bus = dbus.SessionBus()
        obj = bus.get_object('org.gnome.Mutter.IdleMonitor',
                             '/org/gnome/Mutter/IdleMonitor/Core')
        iface = dbus.Interface(obj, 'org.gnome.Mutter.IdleMonitor')
        return int(iface.GetIdletime())   # milliseconds
    except Exception:
        return None
```

Same polling logic as Tier 1.

---

### 3.4 evdev raw-input backend (Tier 3)

**How it works:**  
Reads raw Linux input events from `/dev/input/event*` kernel devices. These exist at the
OS level, completely independent of X11 or Wayland. Any keypress, mouse move, or touch
event updates `last_activity_time`.

**Requirements:**  
- User must be in `input` group: `sudo usermod -aG input $USER`  
- Or add a udev rule granting read access to the app user.

**Implementation outline:**

```python
def _start_evdev_listener(self, on_activity_callback):
    """Start a background thread reading from all /dev/input/event* devices."""
    import glob, select, struct
    INPUT_EVENT_SIZE = struct.calcsize('llHHI')   # timeval + type + code + value

    def reader():
        devices = glob.glob('/dev/input/event*')
        fds = []
        for path in devices:
            try:
                fds.append(open(path, 'rb'))
            except PermissionError:
                pass   # Skip devices we can't read

        if not fds:
            print('[WARN] evdev: no /dev/input/event* devices accessible — check group membership')
            return

        print(f'[OK] evdev: monitoring {len(fds)} input devices')
        while self.running:
            r, _, _ = select.select(fds, [], [], 1.0)
            for f in r:
                try:
                    data = f.read(INPUT_EVENT_SIZE)
                    if data:
                        on_activity_callback()
                except Exception:
                    pass   # Device may have been unplugged

        for f in fds:
            f.close()

    t = threading.Thread(target=reader, daemon=True)
    t.start()
    return t
```

No third-party libraries needed. Uses only stdlib `struct`, `select`, `glob`.

---

### 3.5 Changes to `monitor_user_activity()`

Replace the current monolithic function with a dispatcher:

```
1. Call _detect_idle_backend() → backend_name
2. Log which backend was selected
3. Dispatch to appropriate start function:
   - 'dbus_screensaver' → start polling thread (_poll_dbus_idle_time every 10s)
   - 'gnome_mutter'     → start polling thread (_poll_gnome_mutter_idle every 10s)
   - 'evdev'            → _start_evdev_listener(on_activity)
   - 'pynput'           → existing pynput listener code (unchanged)
4. Keep the 5-second verify thread ONLY for pynput backend (where silent failures
   can occur). D-Bus/evdev backends are self-verifying.
5. Store backend name in self._idle_backend for diagnostics.
```

---

### 3.6 Changes to `get_activity_monitoring_status()`

Add new fields:

```python
'idle_backend': getattr(self, '_idle_backend', 'unknown'),
'dbus_available': ...   # bool
'evdev_devices_accessible': ...  # count of readable /dev/input/event* files
```

---

### 3.7 Changes to `show_diagnostic_info()`

Include `idle_backend` in the output so users and support can immediately see which
detection method is active.

---

### 3.8 Idle timeout polling loop (for D-Bus tiers)

For D-Bus backends, idle detection is **poll-based** rather than event-based. A separate
daemon thread polls every `IDLE_POLL_INTERVAL` seconds (default: 10s):

```python
def _dbus_idle_poll_worker(self, poll_fn):
    """Worker thread for D-Bus idle polling (Tier 1 and 2)."""
    POLL_INTERVAL = 10   # seconds
    was_idle = False

    while self.running:
        idle_ms = poll_fn()
        if idle_ms is None:
            # D-Bus call failed — sleep and retry
            time.sleep(POLL_INTERVAL)
            continue

        idle_secs = idle_ms / 1000.0
        current_timeout = self.tracking_settings.get('idle_threshold_seconds', self.idle_timeout)

        if idle_secs >= current_timeout and not was_idle:
            # Just crossed threshold — enter idle
            print(f"[IDLE] D-Bus idle time {idle_secs:.0f}s ≥ timeout {current_timeout}s — entering idle")
            self.enter_idle("idle timeout")
            was_idle = True

        elif idle_secs < current_timeout and was_idle:
            # Activity resumed — update last_activity_time and trigger resume
            self.last_activity_time = time.time()
            self.needs_idle_resume = True
            was_idle = False
            print(f"[IDLE] D-Bus activity detected (idle reset to {idle_secs:.0f}s)")

        elif idle_secs < current_timeout:
            # Normal activity — keep last_activity_time fresh
            self.last_activity_time = time.time() - idle_secs

        time.sleep(POLL_INTERVAL)
```

---

### 3.9 `udev` rule (optional, included in AppImage)

For the evdev backend, ship a udev rule to avoid needing `input` group membership:

```
# /etc/udev/rules.d/99-jiraforge-input.rules
KERNEL=="event*", SUBSYSTEM=="input", TAG+="uaccess"
```

`TAG+="uaccess"` grants access to the currently active user session automatically
(systemd/logind feature). Include the rule file in the AppImage and document install.

---

## 4. Files to Modify

| File | Change |
|------|--------|
| `desktop_app.py` | Add `_detect_idle_backend()`, `_poll_dbus_idle_time()`, `_poll_gnome_mutter_idle()`, `_start_evdev_listener()`, `_dbus_idle_poll_worker()`; refactor `monitor_user_activity()`, update `get_activity_monitoring_status()`, `show_diagnostic_info()` |
| `requirements.txt` | Add `dbus-python>=1.3.2` as optional dependency with `# Wayland idle detection` comment |
| `IDLE_DETECTION_GUIDE.md` | Update with new backends, group membership instructions, troubleshooting table |

**No new files created** (plan file only, implementation goes into existing files).

---

## 5. Test Scripts

### 5.1 `tests/test_idle_backend_detection.py`

Unit tests for `_detect_idle_backend()`:

```
- test_backend_probe_returns_valid_string
    → Asserts return value is one of the four valid backend names
- test_dbus_backend_selected_when_available
    → Mock dbus.SessionBus to succeed; assert 'dbus_screensaver' returned
- test_gnome_mutter_selected_when_screensaver_unavailable
    → Mock ScreenSaver to fail, Mutter to succeed; assert 'gnome_mutter' returned
- test_evdev_selected_when_dbus_unavailable
    → Mock both D-Bus tiers to fail, /dev/input/event* accessible; assert 'evdev'
- test_pynput_fallback_when_all_fail
    → Mock all tiers to fail; assert 'pynput' returned
- test_none_returned_when_pynput_also_missing
    → Mock pynput ImportError; assert 'none' returned
```

### 5.2 `tests/test_dbus_idle_polling.py`

Tests for `_poll_dbus_idle_time()` and `_poll_gnome_mutter_idle()`:

```
- test_poll_returns_int_on_success
    → Mock dbus call returning 30000; assert return is 30
- test_poll_returns_none_on_dbus_exception
    → Mock dbus to raise dbus.DBusException; assert return is None
- test_poll_returns_none_when_dbus_not_installed
    → Mock ImportError on `import dbus`; assert return is None
- test_gnome_mutter_poll_returns_none_on_error
    → Same shape for Mutter tier
```

### 5.3 `tests/test_dbus_poll_worker.py`

Integration-style tests for `_dbus_idle_poll_worker()`:

```
- test_enter_idle_called_when_threshold_exceeded
    → Simulate poll_fn returning (idle_timeout + 1) * 1000 ms
    → Assert self.enter_idle called with "idle timeout"
- test_enter_idle_not_called_twice
    → Simulate poll_fn returning high value across two poll cycles
    → Assert enter_idle called exactly once (was_idle guard)
- test_needs_idle_resume_set_when_activity_resumes
    → Simulate high → low transition
    → Assert self.needs_idle_resume = True and self.last_activity_time updated
- test_last_activity_time_updated_during_normal_activity
    → Simulate idle_secs = 5 (below threshold)
    → Assert last_activity_time ≈ time.time() - 5
- test_worker_exits_cleanly_when_running_false
    → Set self.running = False; assert thread terminates within 15s
```

### 5.4 `tests/test_evdev_listener.py`

Tests for `_start_evdev_listener()`:

```
- test_on_activity_called_when_event_data_available
    → Mock open('/dev/input/event0') to return binary struct data
    → Assert on_activity_callback called
- test_no_crash_when_no_devices_accessible
    → Mock glob to return list; all open() raise PermissionError
    → Assert thread starts and terminates without exception (log warn expected)
- test_skip_unreadable_devices_continue_with_readable
    → Mock mixed: one PermissionError device, one readable device
    → Assert callback fires for the readable device
- test_closed_cleanly_on_running_false
    → Set self.running = False; assert file handles closed
```

### 5.5 `tests/test_activity_monitoring_status.py`

Tests for updated `get_activity_monitoring_status()`:

```
- test_status_includes_idle_backend_key
    → Set self._idle_backend = 'dbus_screensaver'; assert key present in return dict
- test_status_includes_evdev_devices_accessible_count
    → Mock readable /dev/input/event*; assert count > 0
- test_status_returns_unknown_when_backend_not_set
    → Ensure default value 'unknown' returned when _idle_backend not set
```

### 5.6 `tests/test_monitor_user_activity_dispatch.py`

End-to-end dispatch tests for refactored `monitor_user_activity()`:

```
- test_dbus_backend_thread_started_on_wayland
    → Simulate Wayland env vars, mock _detect_idle_backend → 'dbus_screensaver'
    → Assert _dbus_idle_poll_worker thread started; pynput NOT started
- test_pynput_started_on_x11
    → Simulate X11 env vars, mock _detect_idle_backend → 'pynput'
    → Assert pynput Listener.start() called
- test_verify_thread_only_started_for_pynput
    → Assert verify_listener thread NOT started for dbus_screensaver backend
    → Assert verify_listener thread IS started for pynput backend
- test_error_logged_when_backend_is_none
    → Mock _detect_idle_backend → 'none'
    → Assert add_admin_log called with ERROR and helpful message
```

### 5.7 Manual smoke-test script: `test_idle_detection_wayland.py`

Standalone script that can be run directly on the target machine to verify the fix
without starting the full app:

```python
#!/usr/bin/env python3
"""
Smoke-test: idle detection backend probe and live idle-time reading.
Run from the desktop (requires display session):
    python3 test_idle_detection_wayland.py
"""
import os, sys, time

# --- 1. Print environment ---
print("=== Environment ===")
print(f"XDG_SESSION_TYPE  : {os.environ.get('XDG_SESSION_TYPE', 'not set')}")
print(f"WAYLAND_DISPLAY   : {os.environ.get('WAYLAND_DISPLAY', 'not set')}")
print(f"DISPLAY           : {os.environ.get('DISPLAY', 'not set')}")

# --- 2. Test D-Bus ScreenSaver ---
print("\n=== Tier 1: D-Bus ScreenSaver ===")
try:
    import dbus
    bus = dbus.SessionBus()
    ss = bus.get_object('org.freedesktop.ScreenSaver', '/org/freedesktop/ScreenSaver')
    iface = dbus.Interface(ss, 'org.freedesktop.ScreenSaver')
    idle_ms = int(iface.GetSessionIdleTime())
    print(f"[PASS] GetSessionIdleTime() = {idle_ms} ms ({idle_ms/1000:.1f}s)")
except Exception as e:
    print(f"[FAIL] {e}")

# --- 3. Test GNOME Mutter ---
print("\n=== Tier 2: GNOME Mutter IdleMonitor ===")
try:
    import dbus
    bus = dbus.SessionBus()
    obj = bus.get_object('org.gnome.Mutter.IdleMonitor',
                         '/org/gnome/Mutter/IdleMonitor/Core')
    iface = dbus.Interface(obj, 'org.gnome.Mutter.IdleMonitor')
    idle_ms = int(iface.GetIdletime())
    print(f"[PASS] GetIdletime() = {idle_ms} ms ({idle_ms/1000:.1f}s)")
except Exception as e:
    print(f"[FAIL] {e}")

# --- 4. Test evdev ---
print("\n=== Tier 3: evdev /dev/input/event* ===")
import glob
devices = glob.glob('/dev/input/event*')
readable = [d for d in devices if os.access(d, os.R_OK)]
print(f"Total devices : {len(devices)}")
print(f"Readable      : {len(readable)}")
if readable:
    print(f"[PASS] evdev backend usable — {readable[:3]} ...")
else:
    print(f"[FAIL] No readable devices. Add user to 'input' group:")
    print(f"       sudo usermod -aG input $USER && newgrp input")

# --- 5. Test pynput ---
print("\n=== Tier 4: pynput ===")
try:
    from pynput import mouse
    received = []
    listener = mouse.Listener(on_move=lambda x, y: received.append(True))
    listener.start()
    time.sleep(3)
    listener.stop()
    if received:
        print("[PASS] pynput received mouse events")
    else:
        print("[WARN] pynput started but received NO events in 3s — likely Wayland without XWayland")
except ImportError:
    print("[FAIL] pynput not installed")
except Exception as e:
    print(f"[FAIL] {e}")

print("\n=== Summary ===")
print("Run this script on the target machine to identify which backend is available.")
print("The fix will auto-select the best backend at runtime.")
```

---

## 6. Implementation Order

```
Step 1 — Write unit tests (5.1 → 5.6) — they will all FAIL initially (TDD)
Step 2 — Implement _detect_idle_backend()
Step 3 — Implement _poll_dbus_idle_time() and _poll_gnome_mutter_idle()
Step 4 — Implement _dbus_idle_poll_worker()
Step 5 — Implement _start_evdev_listener()
Step 6 — Refactor monitor_user_activity() to use dispatcher
Step 7 — Update get_activity_monitoring_status() and show_diagnostic_info()
Step 8 — Run unit tests — all should PASS
Step 9 — Run smoke-test script (5.7) on Wayland machine
Step 10 — Update IDLE_DETECTION_GUIDE.md and requirements.txt
```

---

## 7. Acceptance Criteria

| # | Criterion | How to verify |
|---|-----------|---------------|
| AC-1 | No error log on Wayland with GNOME (D-Bus available) | Run app on Wayland GNOME session; check logs |
| AC-2 | No error log on Wayland with KDE (D-Bus available) | Run app on KDE Plasma Wayland |
| AC-3 | Idle state entered after 5 min inactivity on Wayland | Walk away for 5+ min; confirm tray turns orange |
| AC-4 | Tracking resumes on first mouse/key event after idle | Return to keyboard; confirm tray turns green |
| AC-5 | `get_activity_monitoring_status()` reports correct backend | Call method; check `idle_backend` field |
| AC-6 | pynput path still works on X11 session | Run app on X11 GNOME; confirm existing behaviour unchanged |
| AC-7 | All 6 unit test files pass | `pytest tests/test_idle_*.py -v` |
| AC-8 | Smoke-test script shows [PASS] for at least one tier | `python3 test_idle_detection_wayland.py` on target machine |
| AC-9 | No regression in idle record creation | Idle records still appear in `activity_records` table |
| AC-10 | Error message replaced with informative backend message | No ERROR log; INFO log shows which backend is active |

---

## 8. Risks and Mitigations

| Risk | Mitigation |
|------|-----------|
| `dbus-python` not installed in bundled AppImage | Bundle `dbus-python` wheel; catch `ImportError` and fall through to next tier |
| evdev requires `input` group | Document clearly; ship udev rule; fall back gracefully with a single warn log |
| D-Bus session not available in some headless/CI environments | Catch `dbus.DBusException` and `NoSessionError`; fall through to next tier |
| Poll-based D-Bus adds 10s latency to idle detection | 10s overshoot is acceptable; make `IDLE_POLL_INTERVAL` configurable via env var |
| Mutter D-Bus interface may change between GNOME versions | Wrap in try/except; treat any failure as tier-not-available |
| evdev `select` loop may burn CPU on systems with many devices | Use 1s timeout on `select()`; only process first event per cycle |
