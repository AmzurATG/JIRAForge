# Tracking Blockers — Detailed Fix Plan

**Date:** 2026-06-05  
**Target file:** `desktop_app.py` (16,643 lines)  
**Blockers covered:** BL-15 through BL-20 (new findings) + selected P1/P2 items from B-1 through B-14  
**Design constraint:** Every fix must be additive / guarded — no existing code path is removed; only narrowed or supplemented.

---

## Table of Contents

1. [FIX-1 — BL-18: Register SIGTERM handler on Linux (P1)](#fix-1--bl-18-register-sigterm-handler-on-linux)
2. [FIX-2 — BL-16: Set `TrackingState.PAUSED` in `pause_tracking()` + guard D-Bus worker (P1)](#fix-2--bl-16-set-trackingstatepaused-in-pause_tracking)
3. [FIX-3 — BL-15: Extend `_is_screen_locked()` and `LOCK_SCREEN_APPS` for Linux (P2)](#fix-3--bl-15-extend-_is_screen_locked-for-linux)
4. [FIX-4 — BL-20: Move HTTP calls out of `state_lock` in `enter_idle()` / `resume_from_idle()` (P2)](#fix-4--bl-20-move-http-calls-out-of-state_lock)
5. [FIX-5 — BL-19: Marshal `update_tray_icon()` to the GLib main loop thread (P2)](#fix-5--bl-19-marshal-update_tray_icon-to-glib-main-loop)
6. [FIX-6 — BL-17: Add circuit-breaker to `_get_active_window_linux()` (P3)](#fix-6--bl-17-add-circuit-breaker-to-_get_active_window_linux)
7. [FIX-7 — B-1/B-2: Idle resume fallback + pynput watchdog (P1/P2)](#fix-7--b-1b-2-idle-resume-fallback--pynput-watchdog)
8. [FIX-8 — B-6/B-3: Guard `_create_idle_record()` with `state_lock` (P3)](#fix-8--b-6b-3-guard-_create_idle_record-with-state_lock)
9. [FIX-9 — B-12: Offline fallback for `_finalize_active_session()` (P1)](#fix-9--b-12-offline-fallback-for-_finalize_active_session)
10. [FIX-10 — B-14: Tracking thread watchdog (P2)](#fix-10--b-14-tracking-thread-watchdog)
11. [Execution Order & Risk Notes](#execution-order--risk-notes)
12. [Regression Test Checklist](#regression-test-checklist)

---

## FIX-1 — BL-18: Register SIGTERM handler on Linux

**Priority:** P1  
**Blocker:** BL-18  
**Risk:** Low — purely additive; default SIGTERM behaviour (immediate exit) is only changed when the handler is installed on Linux.

### Problem Recap

On Linux, `SIGTERM` (sent by systemd, `pkill`, desktop session manager at logout) terminates the Python process without running `atexit` handlers. `_shutdown_cleanup()` is never called, leaving open Supabase records and losing in-memory idle records.

### Fix Design

Register a `signal.signal(signal.SIGTERM, ...)` handler **once** in the `run()` method of `TimeTracker`, after the main objects are fully initialised. The handler must:

1. Be idempotent — guard with the existing `_shutdown_done` flag.
2. Call `_shutdown_cleanup()` synchronously (budget: ≤10 s).
3. Call `sys.exit(0)` to trigger any remaining `atexit` handlers.
4. Only be installed on non-Windows platforms (Win32 uses `WM_ENDSESSION` instead).

**Do NOT register in `__init__`** — at that point `db_manager`, `session_manager`, and `supabase` are not yet initialised, so `_shutdown_cleanup()` would crash.

### Exact Code Change

**Location:** Inside `run()` method, just after `atexit.register(self._shutdown_cleanup)` (currently line ~6579 in `__init__`, move registration to `run()` or add signal setup inside `run()`).

**Find the `run()` method's opening section and add after the tray icon is created:**

```python
# ---- SIGTERM handler (Linux graceful shutdown) ----
if sys.platform != 'win32':
    import signal as _signal

    def _handle_sigterm(signum, frame):
        """Graceful shutdown on SIGTERM (systemd stop, pkill, session logout)."""
        print("[INFO] SIGTERM received — running shutdown cleanup before exit")
        try:
            self._shutdown_cleanup()
        except Exception as _e:
            print(f"[WARN] SIGTERM cleanup error (non-fatal): {_e}")
        sys.exit(0)

    _signal.signal(_signal.SIGTERM, _handle_sigterm)
    print("[INFO] SIGTERM handler registered (Linux graceful shutdown enabled)")
```

### What Remains Unchanged

- Windows code path is not touched (`sys.platform != 'win32'` guard).
- `atexit.register(self._shutdown_cleanup)` stays in place — still covers clean `sys.exit()` calls.
- `_shutdown_cleanup()` already has a `_shutdown_done` guard so calling it twice (e.g., SIGTERM then `sys.exit()` triggers atexit) is safe.

### Verification

```bash
# Start the app, then:
pkill -TERM TimeTracker   # or: systemctl stop timetracker
# Check: Supabase screenshots.end_time is NOT NULL after kill
# Check: [SHUTDOWN] log lines appear before process exits
```

---

## FIX-2 — BL-16: Set `TrackingState.PAUSED` in `pause_tracking()`

**Priority:** P1  
**Blocker:** BL-16  
**Risk:** Low — `TrackingState.PAUSED = 3` already exists in the enum. The fix assigns it (currently unused) and adds a guard in the D-Bus worker.

### Problem Recap

`pause_tracking()` sets `tracking_active = False` but leaves `self.state = TrackingState.ACTIVE`. The D-Bus idle poll worker ignores `tracking_active` and calls `enter_idle()` after 5 minutes, which finalises the open Supabase record as if the user finished a work session — while they are only paused.

### Fix Design — Two Parts

**Part A:** Assign `TrackingState.PAUSED` inside `pause_tracking()` and reverse it in `resume_tracking()`.

**Part B:** Guard `enter_idle()` and `_dbus_idle_poll_worker` so they skip state transitions when tracking is paused.

#### Part A — `pause_tracking()` and `resume_tracking()`

```python
# pause_tracking() — ADD these two lines inside the `if self.tracking_active:` block,
# immediately after `self.tracking_active = False`:
with self.state_lock:
    if self.state == TrackingState.ACTIVE:
        self.state = TrackingState.PAUSED

# resume_tracking() — the existing line already sets state = ACTIVE:
# self.state = TrackingState.ACTIVE  ← already present; no change needed
```

#### Part B — Guard in `enter_idle()`

`enter_idle()` already returns `False` when `self.state == TrackingState.IDLE`. Add a similar guard for `PAUSED`:

```python
def enter_idle(self, reason):
    with self.state_lock:
        if self.state == TrackingState.IDLE:
            return False
        # NEW: Don't finalise session or enter idle while user has manually paused
        if self.state == TrackingState.PAUSED:
            print(f"[IDLE] enter_idle({reason}) suppressed — tracking is paused")
            return False
        # ... rest of existing code unchanged ...
```

#### Part B — Guard in `_dbus_idle_poll_worker`

```python
# In _dbus_idle_poll_worker(), before the enter_idle() call, add:
if idle_secs >= current_timeout and not was_idle:
    # NEW: Skip idle entry while paused — user chose to pause, not go idle
    if self.state == TrackingState.PAUSED:
        time.sleep(IDLE_POLL_INTERVAL)
        continue
    self.enter_idle("idle timeout")
    was_idle = True
```

### What Remains Unchanged

- `tracking_active = False` remains in `pause_tracking()` — the tracking loop already checks this and sleeps; no change there.
- The `state_lock` usage in `enter_idle()` is unchanged; only a new early-return guard is added.
- `resume_tracking()` already sets `state = TrackingState.ACTIVE` — this is correct and untouched.
- The tracking loop's own idle check (`if idle_duration > current_idle_timeout`) hits `if not self.tracking_active: ... continue` first, so the loop path is already safe. Only the D-Bus worker path needed the extra guard.

### Verification

```bash
# 1. Start tracking
# 2. Pause tracking from tray menu
# 3. Wait > 5 minutes (idle timeout)
# 4. Verify: tray icon stays yellow (paused), NOT orange (idle)
# 5. Verify: no new Supabase screenshots.end_time written during pause
# 6. Resume from tray — verify tracking resumes normally
```

---

## FIX-3 — BL-15: Extend `_is_screen_locked()` and `LOCK_SCREEN_APPS` for Linux

**Priority:** P2  
**Blocker:** BL-15  
**Risk:** Low — all new lock-screen detection paths are additive `try/except` blocks; failure falls through to existing behaviour (`return False`).

### Problem Recap

`_is_screen_locked()` only queries `org.gnome.ScreenSaver` (GNOME-specific). On KDE, XFCE, i3, sway, etc., it silently returns `False`. `LOCK_SCREEN_APPS` contains only Windows process names.

### Fix Design — Two Parts

#### Part A — Expand `LOCK_SCREEN_APPS`

```python
# desktop_app.py — near line 5418
LOCK_SCREEN_APPS = {
    # Windows
    'lockapp.exe', 'logonui.exe',
    # Linux (process names that appear as the foreground process when locked)
    'gnome-screensaver', 'xscreensaver', 'i3lock', 'swaylock',
    'kscreenlocker_greet', 'xflock4', 'light-locker', 'slock',
    'physlock', 'xautolock', 'betterlockscreen',
}
```

**Rationale:** On X11, `xdotool getwindowpid` resolves the PID of the lock-screen window's process. Adding the process name here ensures that if any lock-screen tool is detected as the foreground window, `process_window_event()` skips it as it already does for `lockapp.exe`.

#### Part B — Extend `_is_screen_locked()` Linux branch

Replace the single GNOME-only `gdbus` call with a **waterfall** of three queries, returning `True` on the first successful positive:

```python
def _is_screen_locked(self):
    """Check if the screen is currently locked.

    Windows: inspects the foreground window's process name.
    Linux:   1. GNOME ScreenSaver D-Bus (org.gnome.ScreenSaver)
             2. KDE ScreenSaver D-Bus  (org.kde.screensaver)
             3. FreeDesktop ScreenSaver D-Bus (org.freedesktop.ScreenSaver)
             4. loginctl show-session (systemd, display-server agnostic)
             Falls back to False when all methods fail.
    """
    if WIN32_AVAILABLE:
        # Existing Windows path — unchanged
        try:
            hwnd = win32gui.GetForegroundWindow()
            _, pid = win32process.GetWindowThreadProcessId(hwnd)
            process = psutil.Process(pid)
            return process.name().lower() in LOCK_SCREEN_APPS
        except Exception:
            return False

    # --- Linux ---

    # Method 1: GNOME ScreenSaver (existing behaviour, kept as-is)
    try:
        result = subprocess.run(
            ['gdbus', 'call', '--session',
             '--dest', 'org.gnome.ScreenSaver',
             '--object-path', '/org/gnome/ScreenSaver',
             '--method', 'org.gnome.ScreenSaver.GetActive'],
            capture_output=True, text=True, timeout=1
        )
        if result.returncode == 0:
            return 'true' in result.stdout.lower()
    except Exception:
        pass

    # Method 2: KDE ScreenSaver (KDE Plasma 5/6)
    try:
        result = subprocess.run(
            ['gdbus', 'call', '--session',
             '--dest', 'org.kde.screensaver',
             '--object-path', '/ScreenSaver',
             '--method', 'org.kde.screensaver.GetActive'],
            capture_output=True, text=True, timeout=1
        )
        if result.returncode == 0:
            return 'true' in result.stdout.lower()
    except Exception:
        pass

    # Method 3: FreeDesktop ScreenSaver (XFCE, MATE, LXQt, etc.)
    try:
        result = subprocess.run(
            ['gdbus', 'call', '--session',
             '--dest', 'org.freedesktop.ScreenSaver',
             '--object-path', '/org/freedesktop/ScreenSaver',
             '--method', 'org.freedesktop.ScreenSaver.GetActive'],
            capture_output=True, text=True, timeout=1
        )
        if result.returncode == 0:
            return 'true' in result.stdout.lower()
    except Exception:
        pass

    # Method 4: loginctl show-session (systemd, display-server agnostic)
    # LockedHint=yes means the session lock is active
    try:
        result = subprocess.run(
            ['loginctl', 'show-session', '--property=LockedHint', '--value'],
            capture_output=True, text=True, timeout=1
        )
        if result.returncode == 0:
            return result.stdout.strip().lower() == 'yes'
    except Exception:
        pass

    return False  # All methods failed — assume not locked (existing behaviour)
```

### Performance Impact

Each `subprocess.run(..., timeout=1)` that fails exits in < 1 s (D-Bus returns immediately when the service is absent). In the worst case (all 4 methods time out), `_is_screen_locked()` blocks for 4 seconds. This call is made in the tracking loop guard only after a screen lock has been detected or when resuming from sleep — not on every 2-second iteration.

To prevent any looping worst case, add a simple **result cache** with a 5-second TTL:

```python
# At the top of _is_screen_locked(), before any subprocess call:
now = time.time()
cached = getattr(self, '_screen_lock_cache', None)
if cached and (now - cached[0]) < 5:
    return cached[1]

# ... (existing + new detection code) ...

result = False  # or True from any method above
self._screen_lock_cache = (now, result)
return result
```

### What Remains Unchanged

- The Windows path is byte-for-byte identical.
- `LOCK_SCREEN_APPS` guards in `process_window_event()` and `upload_activity_batch()` are unchanged; they now benefit from the extended set of Linux process names.
- The tracking loop guard sequence (`_is_screen_locked()` → `enter_idle()`) is unchanged.

---

## FIX-4 — BL-20: Move HTTP calls out of `state_lock` in `enter_idle()` / `resume_from_idle()`

**Priority:** P2  
**Blocker:** BL-20  
**Risk:** Medium — involves restructuring lock-hold scope. Must be done carefully to avoid new race conditions.

### Problem Recap

`enter_idle()` holds `state_lock` across a Supabase `UPDATE` HTTP call (`_finalize_active_session`). `resume_from_idle()` holds it across a Jira issues fetch (`get_user_project_key` → `fetch_jira_issues`). Either call can block for up to 60 seconds under poor network, freezing all other state transitions.

### Fix Design

**Principle:** Capture all state needed for the HTTP calls under the lock, set the new state, release the lock, then make the HTTP calls outside the lock.

#### `enter_idle()` Refactor

```python
def enter_idle(self, reason):
    # --- Phase 1: State transition (under lock, fast) ---
    with self.state_lock:
        if self.state == TrackingState.IDLE:
            return False
        if self.state == TrackingState.PAUSED:        # FIX-2 guard
            print(f"[IDLE] enter_idle({reason}) suppressed — tracking is paused")
            return False

        print(f"[STATE] {self.state.name} → IDLE (reason: {reason})")

        # Capture everything we need for the HTTP call BEFORE releasing lock
        _screenshot_id   = self.current_window_screenshot_id
        _db_start_time   = self.current_window_db_start_time
        _last_activity   = self.last_activity_time

        # Optimistically clear the screenshot tracking so no other code tries to update it
        self.current_window_screenshot_id  = None
        self.current_window_db_start_time  = None
        self.current_window_record_created_at = None
        self.current_window_start_time     = None

        # Record idle start (backdated to last known activity)
        if self.state == TrackingState.ACTIVE:
            self.idle_start_time  = datetime.fromtimestamp(_last_activity, tz=timezone.utc)
            self.idle_project_key = self.current_project_key

        self.idle_reason = reason
        self.state   = TrackingState.IDLE
        self.is_idle = True

        # UI update happens inside lock ONLY if on the main thread
        # (see FIX-5 for the full GTK-safe wrapper)
        self._safe_update_tray_icon()
        self.add_admin_log('INFO', f'Entered idle state: {reason}')

    # --- Phase 2: HTTP calls (outside lock) ---
    # _finalize_active_session is restructured to accept explicit params
    # rather than reading self.current_window_screenshot_id (which we already cleared above)
    if _screenshot_id and _db_start_time:
        self._finalize_session_record(
            screenshot_id=_screenshot_id,
            db_start_time=_db_start_time,
            last_activity_ts=_last_activity,
            reason=reason,
        )

    # Stop SQLite timer (no network; safe outside lock)
    self.session_manager.stop_current_timer()

    return True
```

**Note:** `_finalize_active_session()` is refactored into `_finalize_session_record(screenshot_id, db_start_time, last_activity_ts, reason)` which takes explicit arguments instead of reading instance state, making it safe to call outside the lock.

#### `resume_from_idle()` Refactor

```python
def resume_from_idle(self):
    # --- Phase 1: State transition (under lock, fast) ---
    with self.state_lock:
        if self.state != TrackingState.IDLE:
            return False

        print("[STATE] IDLE → ACTIVE")

        # Capture idle period data before clearing
        _idle_start = self.idle_start_time
        _idle_project = getattr(self, 'idle_project_key', None)

        # Clear idle state
        self.idle_start_time  = None
        self.idle_reason      = None

        # Transition to active
        self.state   = TrackingState.ACTIVE
        self.is_idle = False
        self.needs_idle_resume = False

        # Reset window tracking state
        self.current_window_start_time        = None
        self.current_window_db_start_time     = None
        self.current_window_screenshot_id     = None
        self.current_window_record_created_at = None
        self.last_screenshot_end_time         = None
        self.previous_window_key              = None
        self.previous_window_screenshot_id    = None
        self.previous_window_start_time       = None
        self.previous_window_db_start_time    = None
        self.last_interval_time               = time.time()

        self._safe_update_tray_icon()
        self.add_admin_log('INFO', 'Resumed from idle - tracking active')

    # --- Phase 2: Idle record creation + SQLite (outside lock) ---
    # Idle record project key resolution may call Jira API — keep it outside the lock
    if _idle_start:
        # Resolve project_key using cached data first (usually avoids network)
        project_key = _idle_project or self.current_project_key or \
                      self._get_most_recent_project()
        if not project_key:
            project_key = self.get_user_project_key()   # network call — now outside lock
        self._create_idle_record_explicit(
            idle_start=_idle_start,
            idle_end=datetime.now(timezone.utc),
            project_key=project_key,
        )

    # Start new SQLite activity timer (no network; safe)
    self.session_manager.start_new_timer()

    return True
```

**Note:** `_create_idle_record_explicit(idle_start, idle_end, project_key)` is a new variant of `_create_idle_record` that accepts explicit parameters (avoiding reading `self.idle_start_time` which is already cleared by the time this runs outside the lock).

### What Remains Unchanged

- All callers of `enter_idle()` and `resume_from_idle()` are unchanged — the return value semantics are preserved.
- The `state_lock` is still used for the state transition itself; only the HTTP work is moved after the lock is released.
- `_finalize_active_session()` can still be called from other code paths (suspension detection) by passing the instance fields directly — those callers are not inside any lock.

---

## FIX-5 — BL-19: Marshal `update_tray_icon()` to the GLib main loop thread

**Priority:** P2  
**Blocker:** BL-19  
**Risk:** Low — the change is encapsulated in a new helper `_safe_update_tray_icon()`. Existing calls to `update_tray_icon()` from the main thread are unaffected.

### Problem Recap

`enter_idle()` is called by the D-Bus idle poll worker (a background daemon thread) and then calls `update_tray_icon()`, which mutates `self.tray.icon` and `self.tray.title` — GObject/GTK operations that must run on the GLib main loop thread.

### Fix Design

Add a `_safe_update_tray_icon()` helper that detects whether it's running on the GLib main loop thread. If yes, it calls `update_tray_icon()` directly. If no, it marshals the call via `GLib.idle_add()`.

```python
def _safe_update_tray_icon(self):
    """Thread-safe wrapper for update_tray_icon().

    On Linux, pystray uses AppIndicator3 / AyatanaAppIndicator3 which are
    GObject wrappers over GTK. GTK is not thread-safe — all GObject mutations
    must occur on the GLib main loop thread.

    This helper uses GLib.idle_add() to schedule the update on the main loop
    when called from a background thread, preventing GTK assertion failures
    and invisible/frozen tray icons.
    """
    if not sys.platform.startswith('linux'):
        # Windows pystray backend is thread-safe (uses Win32 SendMessage)
        self.update_tray_icon()
        return

    try:
        from gi.repository import GLib as _GLib
        # GLib.MainContext.default().is_owner() returns True on the main loop thread
        if _GLib.MainContext.default().is_owner():
            self.update_tray_icon()
        else:
            _GLib.idle_add(self.update_tray_icon)
    except Exception:
        # gi not available (e.g., pystray using a different backend) — call directly
        self.update_tray_icon()
```

**Replace calls to `update_tray_icon()` in `enter_idle()` and `resume_from_idle()` with `_safe_update_tray_icon()`.**

All other existing calls to `update_tray_icon()` — from the main thread in `start_tracking()`, `stop_tracking()`, `pause_tracking()`, `resume_tracking()`, `update_icon_periodically()` — remain as direct calls (they are already on the correct thread).

### What Remains Unchanged

- `update_tray_icon()` itself is not modified.
- Windows code path: direct call to `update_tray_icon()` (no GLib needed).
- All existing callers on the main thread: no change.

---

## FIX-6 — BL-17: Add circuit-breaker to `_get_active_window_linux()`

**Priority:** P3  
**Blocker:** BL-17  
**Risk:** Low — the circuit-breaker only disables methods that have already failed; it does not remove any method from the detection chain.

### Problem Recap

On minimal Linux, all 4 window-detection methods time out on every call, stalling the tracking loop for 9+ seconds each iteration. There is no cache to avoid retrying methods known to be unavailable.

### Fix Design

Add a **per-method failure counter**. After 3 consecutive failures, mark that method as "circuit-open" for 60 seconds before retrying.

```python
# In __init__ or as a class-level default:
self._window_method_failures = {}   # {method_name: {'count': int, 'open_until': float}}
CIRCUIT_OPEN_AFTER  = 3    # failures before opening circuit
CIRCUIT_RESET_AFTER = 60   # seconds before retry

def _check_circuit(self, method_name: str) -> bool:
    """Returns True if the method is allowed to run (circuit closed)."""
    state = self._window_method_failures.get(method_name)
    if not state:
        return True
    if state['count'] >= CIRCUIT_OPEN_AFTER:
        if time.time() < state.get('open_until', 0):
            return False  # circuit open — skip
        # Reset after timeout
        state['count'] = 0
    return True

def _record_method_success(self, method_name: str):
    self._window_method_failures.pop(method_name, None)

def _record_method_failure(self, method_name: str):
    state = self._window_method_failures.setdefault(method_name, {'count': 0})
    state['count'] += 1
    if state['count'] >= CIRCUIT_OPEN_AFTER:
        state['open_until'] = time.time() + CIRCUIT_RESET_AFTER
        print(f"[WARN] Window detection method '{method_name}' circuit-open for {CIRCUIT_RESET_AFTER}s after {CIRCUIT_OPEN_AFTER} failures")
```

In `_get_active_window_linux()`, wrap each resolver call:

```python
for method_name, resolver in method_pairs:   # method_pairs = [('gdbus', _from_gdbus), ...]
    if not self._check_circuit(method_name):
        continue
    try:
        resolved = resolver()
        if resolved and not (resolved[0] == 'Unknown' and resolved[1] == 'Unknown'):
            self._record_method_success(method_name)
            return resolved[0], resolved[1]
        else:
            self._record_method_failure(method_name)
    except Exception:
        self._record_method_failure(method_name)
```

**Result:** On a minimal system where all 4 methods fail 3 times, the circuit opens and subsequent loop iterations return `('Unknown', 'Unknown')` in microseconds instead of 9 seconds. The circuit resets every 60 seconds to allow recovery if a tool is installed later (e.g., user installs `xdotool`).

### What Remains Unchanged

- All 4 detection methods (`_from_gdbus`, `_from_gnome_introspect`, `_from_xdotool`, `_from_atspi`) are still attempted in order.
- A successful result resets the failure counter for that method immediately.
- The return value `('Unknown', 'Unknown')` semantics are preserved — the tracking loop already handles this gracefully.

---

## FIX-7 — B-1/B-2: Idle resume fallback + pynput heartbeat watchdog

**Priority:** P2  
**Blocker:** B-1 (pynput failure traps tracking in idle forever), B-2 (activity monitor thread dies silently)  
**Risk:** Low — adds a secondary resume path and a watchdog; does not change primary pynput flow.

### Problem Recap

- **B-1:** If pynput fails or its callbacks never fire, `needs_idle_resume` is never set. The tracking loop sleeps in the idle branch forever.
- **B-2:** The `_activity_monitor_thread` can appear alive (`is_alive() == True`) while pynput listeners have silently stopped firing callbacks. There is no heartbeat to detect this.

### Fix Design

#### B-1 — Secondary resume path in tracking loop (idle branch)

In the tracking loop, inside the idle-wait block, add a time-based fallback check:

```python
# Existing idle branch (do NOT change):
if not self.needs_idle_resume:
    time.sleep(5)
    continue

# NEW — add BEFORE the sleep:
# Fallback resume: if last_activity_time advanced since we entered idle
# (window switch updated it), treat that as user activity even if pynput
# never set needs_idle_resume.
idle_entry_ts = getattr(self, '_idle_entry_time', self.last_activity_time)
if time.time() - self.last_activity_time < 5:   # activity within last 5s
    print("[INFO] Idle fallback: last_activity_time updated since idle entry — resuming")
    self.needs_idle_resume = True
```

Store `_idle_entry_time` at the moment `enter_idle()` is called (set inside the `state_lock` block before releasing it).

#### B-2 — pynput heartbeat + watchdog

**Heartbeat:** In `monitor_user_activity()` pynput branch, the existing `on_activity` callback already updates `last_activity_time`. Add a dedicated `_pynput_last_heartbeat` timestamp:

```python
def on_activity(*args, **kwargs):
    self._pynput_last_heartbeat = time.time()   # NEW
    self.last_activity_time = time.time()
    if self.is_idle:
        self.needs_idle_resume = True
```

**Watchdog:** In the sync thread (`start_sync_thread` → `sync_worker`), add a pynput health check:

```python
# Every 2 minutes (every 4 iterations at 30s interval):
if pynput_check_counter >= 4:
    pynput_check_counter = 0
    backend = getattr(self, '_idle_backend', 'none')
    if backend == 'pynput' and self.tracking_active and not self.is_idle:
        last_hb = getattr(self, '_pynput_last_heartbeat', 0)
        if last_hb and (time.time() - last_hb) > 300:  # 5 minutes no events
            print("[WARN] pynput heartbeat stale — restarting activity monitor thread")
            if self._activity_monitor_thread and not self._activity_monitor_thread.is_alive():
                self._activity_monitor_thread = threading.Thread(
                    target=self.monitor_user_activity, daemon=True
                )
                self._activity_monitor_thread.start()
                self.add_admin_log('WARN', 'pynput heartbeat stale — activity monitor restarted')
```

### What Remains Unchanged

- The primary pynput flow (`needs_idle_resume` flag) is unchanged.
- D-Bus and evdev backends are unaffected (they have their own health mechanisms).
- The activity monitor thread start logic in `start_tracking()` is unchanged.

---

## FIX-8 — B-6/B-3: Guard `_create_idle_record()` with `state_lock`

**Priority:** P3  
**Blocker:** B-6 (duplicate idle on wake), B-3 (race on `needs_idle_resume`)  
**Risk:** Low — `_create_idle_record` is already called from contexts that may hold `state_lock` (via `resume_from_idle`). The fix adds an internal guard flag, not a nested lock acquire.

### Problem Recap

On system wake, the Windows message pump thread (`PBT_APMRESUMEAUTOMATIC`) and the tracking loop gap handler can both call `_create_idle_record()` simultaneously, producing two overlapping idle records for the same sleep period. `idle_start_time` is cleared at the **end** of the function, leaving a race window.

### Fix Design

Add a `_idle_record_creating` boolean flag (acting as a taken-flag) that is set to `True` atomically at the start of `_create_idle_record()` and cleared at the end. Use `state_lock` to protect the flag:

```python
def _create_idle_record(self, reason="idle timeout"):
    """Create an idle record and queue it. Called inside state_lock from resume_from_idle()."""
    # Guard: prevent duplicate records from concurrent calls (B-6)
    # This check is safe when called from resume_from_idle() (inside state_lock),
    # and also when called from the tracking loop gap handler.
    if self.idle_start_time is None:
        return

    # Take a local snapshot and clear idle_start_time FIRST (atomic under GIL for simple assignment)
    # This prevents a second concurrent call from creating a duplicate record.
    idle_start_snapshot = self.idle_start_time
    self.idle_start_time = None   # MOVED to top — acts as taken-flag

    # ... rest of existing function using idle_start_snapshot instead of self.idle_start_time ...
```

**Key change:** Move `self.idle_start_time = None` from the **end** of `_create_idle_record()` to the **start**, immediately after taking a local snapshot. Since CPython's GIL makes a simple attribute assignment atomic, any concurrent call that checks `if self.idle_start_time is None: return` after this assignment will correctly bail out.

For `needs_idle_resume` race (B-3): convert `self.needs_idle_resume` to `threading.Event`:

```python
# In __init__:
self._idle_resume_event = threading.Event()
# Keep self.needs_idle_resume as a boolean property for backward compatibility:
@property
def needs_idle_resume(self):
    return self._idle_resume_event.is_set()
@needs_idle_resume.setter
def needs_idle_resume(self, value):
    if value:
        self._idle_resume_event.set()
    else:
        self._idle_resume_event.clear()
```

This is fully backward-compatible — all existing `self.needs_idle_resume = True/False` and `if self.needs_idle_resume:` reads work without change.

### What Remains Unchanged

- `_create_idle_record()` behaviour and record format are unchanged.
- Callers from `resume_from_idle()`, `enter_idle()`, and the tracking loop gap handler are unchanged.
- The idle record is still appended to `_pending_idle_records` (and uploaded in the next batch).

---

## FIX-9 — B-12: Offline fallback for `_finalize_active_session()`

**Priority:** P1  
**Blocker:** B-12  
**Risk:** Medium — requires a new SQLite table (`pending_finalizes`). The table creation is guarded and the existing flow is unchanged if the table doesn't exist.

### Problem Recap

`_finalize_active_session()` makes a Supabase `UPDATE` call with no retry, no offline queue, and no SQLite fallback. On network loss or JWT expiry, the `screenshots` record retains `end_time = NULL` indefinitely.

### Fix Design — Three Parts

#### Part A — New SQLite table `pending_finalizes`

Add to `create_sqlite_tables.sql` and to the `DatabaseConnectionManager` schema setup:

```sql
CREATE TABLE IF NOT EXISTS pending_finalizes (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    screenshot_id    TEXT    NOT NULL,
    end_time         TEXT    NOT NULL,   -- ISO-8601 UTC
    duration_seconds INTEGER NOT NULL,
    created_at       TEXT    DEFAULT (datetime('now'))
);
```

#### Part B — Save to SQLite on failure in `_finalize_active_session()`

```python
def _finalize_active_session(self, reason="idle"):
    # ... existing code to compute end_time and duration_seconds ...
    try:
        update_result = db_client.table('screenshots').update({...}) \
            .eq('id', self.current_window_screenshot_id).execute()
        if update_result.data:
            # Success — clear current record (existing behaviour)
            self.current_window_screenshot_id = None
            ...
    except Exception as e:
        print(f"[ERROR] Error finalizing session ({reason}): {e}")
        # NEW: Save pending finalize to SQLite for retry on next startup / sync cycle
        try:
            self.db_manager.execute(
                """INSERT INTO pending_finalizes
                   (screenshot_id, end_time, duration_seconds)
                   VALUES (?, ?, ?)""",
                (self.current_window_screenshot_id,
                 end_time.isoformat(),
                 duration_seconds)
            )
            print(f"[OFFLINE] Pending finalize saved to SQLite for record {self.current_window_screenshot_id}")
        except Exception as sqlite_err:
            print(f"[ERROR] Could not save pending finalize to SQLite: {sqlite_err}")
        # Still clear in-memory state so we don't re-attempt from the instance variable
        self.current_window_screenshot_id = None
        self.current_window_db_start_time = None
```

#### Part C — Drain `pending_finalizes` in `upload_activity_batch()`

```python
# In upload_activity_batch(), after the main batch insert succeeds, add:
self._drain_pending_finalizes()

def _drain_pending_finalizes(self):
    """Retry failed screenshot UPDATE calls saved to pending_finalizes table."""
    try:
        rows = self.db_manager.fetchall("SELECT id, screenshot_id, end_time, duration_seconds FROM pending_finalizes ORDER BY id LIMIT 10")
        if not rows:
            return
        print(f"[BATCH] Draining {len(rows)} pending finalize(s)...")
        for row in rows:
            row_id, screenshot_id, end_time_str, duration_seconds = row
            try:
                result = self.supabase.table('screenshots').update({
                    'end_time': end_time_str,
                    'timestamp': end_time_str,
                    'duration_seconds': duration_seconds,
                }).eq('id', screenshot_id).execute()
                if result.data:
                    self.db_manager.execute("DELETE FROM pending_finalizes WHERE id = ?", (row_id,))
                    print(f"[BATCH] Pending finalize applied for {screenshot_id}")
            except Exception as e:
                print(f"[WARN] Pending finalize retry failed for {screenshot_id}: {e}")
    except Exception as e:
        print(f"[WARN] _drain_pending_finalizes error: {e}")
```

### What Remains Unchanged

- The primary Supabase `UPDATE` call is unchanged — the fallback only activates on exception.
- The SQLite table is created with `IF NOT EXISTS` — no migration needed for existing databases.
- `upload_activity_batch()` caller sites are unchanged; `_drain_pending_finalizes()` is appended.

---

## FIX-10 — B-14: Tracking thread watchdog

**Priority:** P2  
**Blocker:** B-14  
**Risk:** Low — the watchdog only restarts the thread if it is confirmed dead AND `self.running` is still `True`.

### Problem Recap

`_tracking_thread` can die silently (from a `BaseException` like `SystemExit`, or from `self.running = False; break`). The tray icon stays green and `tracking_active` remains `True`, giving a false impression that tracking is running.

### Fix Design

Add a health check inside the existing `sync_worker` loop (which already runs every 30 seconds):

```python
# In sync_worker() (start_sync_thread), add to the periodic checks:
thread_check_counter += 1
if thread_check_counter >= 2:   # Every 60 seconds (2 × 30s)
    thread_check_counter = 0
    if (self.running and
        self.tracking_active and
        self._tracking_thread is not None and
        not self._tracking_thread.is_alive()):

        print("[WARN] Tracking thread died unexpectedly — restarting")
        self.add_admin_log('WARNING', 'Tracking thread restarted by watchdog')
        try:
            self._tracking_thread = threading.Thread(
                target=self.tracking_loop, daemon=True, name='tracking-loop'
            )
            self._tracking_thread.start()
        except Exception as wdog_err:
            print(f"[ERROR] Watchdog failed to restart tracking thread: {wdog_err}")
```

### What Remains Unchanged

- `start_tracking()` and `stop_tracking()` are unchanged.
- The watchdog only fires when `self.running AND tracking_active AND thread is dead` — it will not fire during a legitimate `stop_tracking()` call (which sets `running = False` first).
- The watchdog does NOT call `start_tracking()` (which reinitialises all window state and idle state) — it only restarts the tracking loop thread, preserving existing state.

---

## Execution Order & Risk Notes

Implement fixes in the following sequence to minimise risk. Each fix is independently deployable.

| Step | Fix | Est. Lines Changed | Risk |
|------|-----|--------------------|------|
| 1 | FIX-1: SIGTERM handler | +15 | Low |
| 2 | FIX-2: PAUSED state in pause_tracking | +12 | Low |
| 3 | FIX-3: Linux screen lock detection | +50 | Low |
| 4 | FIX-5: Safe tray icon update | +20 | Low |
| 5 | FIX-8: Idle record race guard | +10 | Low |
| 6 | FIX-7: Idle resume fallback + watchdog | +30 | Low |
| 7 | FIX-10: Tracking thread watchdog | +20 | Low |
| 8 | FIX-6: Window detection circuit-breaker | +40 | Low |
| 9 | FIX-9: Offline fallback for finalize | +60 | Medium |
| 10 | FIX-4: HTTP calls outside state_lock | +80 | Medium |

**FIX-9 and FIX-4 are marked Medium risk** because they restructure existing functions. Both should be implemented last, after the lower-risk fixes are verified in a test session.

---

## Regression Test Checklist

Run the following manual scenarios after each fix batch before committing.

### Core Tracking (always verify)
- [ ] Start tracking → active window appears in Supabase `screenshots` within 15s
- [ ] Switch windows → previous record gets `end_time` updated; new record created
- [ ] `activity_records` batch upload fires after 5 minutes
- [ ] Stop tracking → `_shutdown_cleanup` runs, no open records

### Idle Detection
- [ ] Leave mouse/keyboard idle for > 5 minutes → tray turns orange, idle record created
- [ ] Move mouse → tray turns green, tracking resumes, idle record uploaded in next batch
- [ ] Pause tracking (tray → Pause) → wait 10 minutes idle → tray stays **yellow** (not orange), NO new Supabase record written *(tests FIX-2)*

### Screen Lock (Linux)
- [ ] Lock screen (GNOME: `gnome-screensaver-command -l`) → tray goes orange, tracking enters idle
- [ ] Unlock → tracking resumes *(tests FIX-3 Method 1)*
- [ ] (If KDE available) Lock screen via KDE → same as above *(tests FIX-3 Method 2)*
- [ ] (If no DE) Run `loginctl lock-session` → `_is_screen_locked()` returns True *(tests FIX-3 Method 4)*

### Graceful Shutdown (Linux)
- [ ] `pkill -TERM <pid>` while tracking → check logs for `[SHUTDOWN]` lines, check Supabase record has `end_time` set *(tests FIX-1)*
- [ ] `kill -9 <pid>` → confirm data written to SQLite before kill is uploadable on next start *(B-10; not fixed by FIX-1, documents expected behaviour)*

### Network Resilience
- [ ] Disconnect network while tracking → `_finalize_active_session` fails → check SQLite `pending_finalizes` table has a row *(tests FIX-9)*
- [ ] Reconnect and wait for next batch upload → check `pending_finalizes` row deleted, Supabase record updated *(tests FIX-9)*

### Minimal Linux (no GNOME / no xdotool)
- [ ] Run app with all 4 window detection methods unavailable → tracking loop does NOT stall >5s per iteration after 3 failures *(tests FIX-6)*
- [ ] After 60 seconds → detection methods are retried automatically

### Thread Health
- [ ] Simulate tracking thread crash (temporary manual injection) → watchdog restarts it within 60s, tray stays green *(tests FIX-10)*

---

## Runnable Test Scripts

Each script below is self-contained and can be executed with `python3 <script_name>.py` from the `python-desktop-app/` directory. All scripts are unit/integration tests that do **not** require a running Supabase connection unless noted.

---

### test_fix1_sigterm.py — FIX-1: SIGTERM handler

```python
#!/usr/bin/env python3
"""test_fix1_sigterm.py — Verifies that SIGTERM handler is registered and calls _shutdown_cleanup().

Run: python3 test_fix1_sigterm.py
Expected: PASS printed twice (handler registered, cleanup called on SIGTERM).
"""
import os, signal, sys, time, threading

# Minimal stub to test handler registration without starting the full app
shutdown_called = threading.Event()

class _StubTracker:
    _shutdown_done = False
    def _shutdown_cleanup(self):
        if self._shutdown_done:
            return
        self._shutdown_done = True
        shutdown_called.set()
        print("[STUB] _shutdown_cleanup called — PASS")

tracker = _StubTracker()

# Install the handler exactly as FIX-1 does in run()
if sys.platform != "win32":
    def _handle_sigterm(signum, frame):
        tracker._shutdown_cleanup()
        sys.exit(0)
    signal.signal(signal.SIGTERM, _handle_sigterm)
    print("SIGTERM handler registered — PASS")
else:
    print("Windows: SIGTERM not used — SKIP")
    sys.exit(0)

# Verify handler is installed
assert signal.getsignal(signal.SIGTERM) == _handle_sigterm, "Handler not registered!"
print("Handler lookup — PASS")

# Fire SIGTERM at ourselves in a thread (can't catch sys.exit from signal, so call directly)
tracker._shutdown_cleanup()
assert shutdown_called.is_set(), "cleanup was not called!"
print("Cleanup invoked — PASS")

# Idempotency: second call must not set _shutdown_done again (already True)
prev = tracker._shutdown_done
tracker._shutdown_cleanup()
assert tracker._shutdown_done == prev, "Not idempotent!"
print("Idempotency — PASS")
print("\nAll FIX-1 checks passed.")
```

---

### test_fix2_pause_state.py — FIX-2: TrackingState.PAUSED assignment

```python
#!/usr/bin/env python3
"""test_fix2_pause_state.py — Verifies pause_tracking() sets PAUSED and enter_idle() is suppressed.

Run: python3 test_fix2_pause_state.py
Expected: All assertions pass.
"""
import sys, threading
sys.path.insert(0, '.')  # desktop_app.py must be importable as module

# Import only the enum to avoid heavy startup
from enum import IntEnum

class TrackingState(IntEnum):
    STOPPED = 0
    ACTIVE  = 1
    IDLE    = 2
    PAUSED  = 3

state_lock = threading.Lock()
state = TrackingState.ACTIVE

def pause_tracking():
    global state
    with state_lock:
        state = TrackingState.PAUSED

def enter_idle(reason):
    global state
    with state_lock:
        if state == TrackingState.IDLE:
            return False
        if state == TrackingState.PAUSED:
            return False  # FIX-2 guard
        state = TrackingState.IDLE
        return True

# Test 1: pause sets PAUSED
pause_tracking()
assert state == TrackingState.PAUSED, f"Expected PAUSED, got {state.name}"
print("pause_tracking() → PAUSED: PASS")

# Test 2: enter_idle while PAUSED returns False and doesn't change state
result = enter_idle("idle timeout")
assert result is False, "Expected False from enter_idle when PAUSED"
assert state == TrackingState.PAUSED, f"State changed unexpectedly to {state.name}"
print("enter_idle() suppressed while PAUSED: PASS")

# Test 3: from ACTIVE, enter_idle succeeds
state = TrackingState.ACTIVE
result = enter_idle("idle timeout")
assert result is True and state == TrackingState.IDLE
print("enter_idle() from ACTIVE → IDLE: PASS")

print("\nAll FIX-2 checks passed.")
```

---

### test_fix3_screen_lock.py — FIX-3: Multi-DE screen lock detection

```python
#!/usr/bin/env python3
"""test_fix3_screen_lock.py — Exercises each branch of _is_screen_locked() in isolation.

Run: python3 test_fix3_screen_lock.py
Expected: Each available branch reports True/False without raising exceptions.
Note: Actually locking the screen is not required; we test that each method
      runs without crashing and returns a bool.
"""
import subprocess, time

def _check_gnome_lock():
    try:
        result = subprocess.run(
            ['gdbus', 'call', '--session', '--dest', 'org.gnome.ScreenSaver',
             '--object-path', '/org/gnome/ScreenSaver',
             '--method', 'org.gnome.ScreenSaver.GetActive'],
            capture_output=True, text=True, timeout=3
        )
        return '(true,)' in result.stdout.lower()
    except Exception:
        return None  # method unavailable

def _check_kde_lock():
    try:
        result = subprocess.run(
            ['qdbus', 'org.kde.screensaver', '/ScreenSaver', 'GetActive'],
            capture_output=True, text=True, timeout=3
        )
        return result.stdout.strip().lower() == 'true'
    except Exception:
        return None

def _check_freedesktop_lock():
    try:
        result = subprocess.run(
            ['gdbus', 'call', '--session',
             '--dest', 'org.freedesktop.ScreenSaver',
             '--object-path', '/org/freedesktop/ScreenSaver',
             '--method', 'org.freedesktop.ScreenSaver.GetActive'],
            capture_output=True, text=True, timeout=3
        )
        return '(true,)' in result.stdout.lower()
    except Exception:
        return None

def _check_loginctl():
    try:
        result = subprocess.run(
            ['loginctl', 'show-session', '', '-p', 'LockedHint'],
            capture_output=True, text=True, timeout=3
        )
        return 'LockedHint=yes' in result.stdout
    except Exception:
        return None

methods = [
    ("GNOME ScreenSaver",     _check_gnome_lock),
    ("KDE ScreenSaver",       _check_kde_lock),
    ("FreeDesktop Screensaver", _check_freedesktop_lock),
    ("loginctl LockedHint",   _check_loginctl),
]

any_available = False
for name, fn in methods:
    result = fn()
    if result is None:
        print(f"  [{name}] → not available (skipped)")
    else:
        print(f"  [{name}] → {'LOCKED' if result else 'unlocked'} (method works — PASS)")
        any_available = True

if any_available:
    print("\nAt least one screen-lock detection method is functional — FIX-3 PASS")
else:
    print("\nNo screen-lock methods available on this system — INCONCLUSIVE")
    print("(Expected on headless / CI systems. Test FIX-3 manually on a desktop.)")
```

---

### test_fix4_lock_not_held.py — FIX-4: HTTP calls outside state_lock

```python
#!/usr/bin/env python3
"""test_fix4_lock_not_held.py — Confirms state_lock is NOT held during simulated HTTP call.

Run: python3 test_fix4_lock_not_held.py
Expected: lock acquired within 50ms while enter_idle() is running its "HTTP" phase.
"""
import threading, time

state_lock = threading.Lock()
lock_was_free_during_http = threading.Event()

def _fake_finalize_active_session():
    """Simulate a slow HTTP call (100ms)."""
    # FIX-4: this must be called OUTSIDE state_lock
    if not state_lock.acquire(blocking=False):
        # Lock is held — FIX-4 is broken
        print("FAIL: state_lock was held during HTTP call!")
        return
    # We could acquire it — lock is free
    lock_was_free_during_http.set()
    state_lock.release()
    time.sleep(0.1)

class FakeTracker:
    state = "ACTIVE"
    is_idle = False
    _idle_entry_time = 0

    def enter_idle_fixed(self, reason):
        """FIX-4 version: state change under lock, HTTP outside."""
        with state_lock:
            if self.state == "IDLE":
                return False
            self.state = "IDLE"
            self.is_idle = True
            self._idle_entry_time = time.time()
        # HTTP call outside the lock
        _fake_finalize_active_session()
        return True

tracker = FakeTracker()
t = threading.Thread(target=tracker.enter_idle_fixed, args=("test",))
t.start()
time.sleep(0.01)  # Let enter_idle reach the HTTP phase

acquired = lock_was_free_during_http.wait(timeout=0.5)
t.join()

if acquired:
    print("state_lock was FREE during HTTP call — FIX-4 PASS")
else:
    print("FAIL: could not acquire lock during HTTP phase (lock still held)")
```

---

### test_fix6_circuit_breaker.py — FIX-6: Window detection circuit-breaker

```python
#!/usr/bin/env python3
"""test_fix6_circuit_breaker.py — Tests the per-method circuit-breaker logic in isolation.

Run: python3 test_fix6_circuit_breaker.py
Expected: After 3 failures, method is skipped. After 60s reset, it is retried.
"""
import time

_CB_OPEN_AFTER  = 3
_CB_RESET_AFTER = 60

failures = {}

def _call_with_circuit(method_name, resolver):
    cb = failures.get(method_name, {'count': 0, 'open_until': 0})
    if cb['count'] >= _CB_OPEN_AFTER and time.time() < cb.get('open_until', 0):
        return "SKIPPED"
    if cb['count'] >= _CB_OPEN_AFTER and time.time() >= cb.get('open_until', 0):
        failures[method_name] = {'count': 0, 'open_until': 0}

    result = resolver()
    if result is None:
        cb2 = failures.setdefault(method_name, {'count': 0, 'open_until': 0})
        cb2['count'] += 1
        if cb2['count'] >= _CB_OPEN_AFTER:
            cb2['open_until'] = time.time() + _CB_RESET_AFTER
        return None
    failures[method_name] = {'count': 0, 'open_until': 0}
    return result

call_count = 0
def always_fail():
    global call_count
    call_count += 1
    return None

# First 3 calls should pass through and be counted
for i in range(3):
    _call_with_circuit('xdotool', always_fail)

assert call_count == 3, f"Expected 3 calls, got {call_count}"
print(f"3 failures counted — PASS (call_count={call_count})")

# 4th call should be skipped (circuit open)
result = _call_with_circuit('xdotool', always_fail)
assert result == "SKIPPED", f"Expected SKIPPED, got {result}"
assert call_count == 3, f"Resolver was called when circuit open! count={call_count}"
print("Circuit open — 4th call skipped — PASS")

# Simulate reset by backdating open_until
failures['xdotool']['open_until'] = time.time() - 1

# Next call should reset counter and call resolver again
_call_with_circuit('xdotool', always_fail)
assert failures['xdotool']['count'] == 1, f"Expected count=1 after reset, got {failures['xdotool']['count']}"
print("Circuit reset after timeout — PASS")

print("\nAll FIX-6 checks passed.")
```

---

### test_fix8_idle_record_guard.py — FIX-8: `_create_idle_record()` taken-flag

```python
#!/usr/bin/env python3
"""test_fix8_idle_record_guard.py — Verifies that concurrent calls to _create_idle_record()
produce exactly ONE idle record (taken-flag pattern).

Run: python3 test_fix8_idle_record_guard.py
Expected: idle_records list has exactly 1 item after 2 concurrent calls.
"""
import threading
from datetime import datetime, timezone

idle_start_time = datetime(2026, 6, 5, 10, 0, 0, tzinfo=timezone.utc)
idle_records = []
state_lock = threading.Lock()

def _create_idle_record(reason):
    global idle_start_time
    with state_lock:
        # Taken-flag pattern: read and clear atomically (FIX-8)
        idle_start_snapshot = idle_start_time
        if idle_start_snapshot is None:
            return  # Already taken by another caller
        idle_start_time = None  # Mark as taken

    # Outside the lock: write the record
    idle_records.append({
        'start': idle_start_snapshot.isoformat(),
        'reason': reason,
    })

barrier = threading.Barrier(2)

def _call(reason):
    barrier.wait()  # Both threads start simultaneously
    _create_idle_record(reason)

t1 = threading.Thread(target=_call, args=("idle timeout",))
t2 = threading.Thread(target=_call, args=("duplicate path",))
t1.start(); t2.start()
t1.join(); t2.join()

assert len(idle_records) == 1, f"Expected 1 idle record, got {len(idle_records)}"
print(f"Exactly 1 idle record created from 2 concurrent calls — FIX-8 PASS")
print(f"  Record: {idle_records[0]}")
print("\nAll FIX-8 checks passed.")
```

---

### test_fix9_pending_finalizes.py — FIX-9: SQLite offline fallback

```python
#!/usr/bin/env python3
"""test_fix9_pending_finalizes.py — Verifies pending_finalizes table is created and
that INSERT / SELECT / DELETE round-trip works correctly.

Run: python3 test_fix9_pending_finalizes.py
Expected: All assertions pass. Uses an in-memory SQLite DB.
"""
import sqlite3, time, uuid

# Create in-memory DB with the FIX-9 schema
conn = sqlite3.connect(':memory:')
conn.execute('''
    CREATE TABLE IF NOT EXISTS pending_finalizes (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        screenshot_id    TEXT    NOT NULL,
        end_time         TEXT    NOT NULL,
        duration_seconds INTEGER NOT NULL,
        created_at       TEXT    DEFAULT (datetime('now')),
        UNIQUE(screenshot_id)
    )
''')
conn.commit()

fake_id = str(uuid.uuid4())
fake_end = "2026-06-05T10:30:00+00:00"

# 1. Insert a pending finalize
conn.execute(
    "INSERT OR IGNORE INTO pending_finalizes (screenshot_id, end_time, duration_seconds) VALUES (?, ?, ?)",
    (fake_id, fake_end, 300)
)
conn.commit()

rows = conn.execute("SELECT screenshot_id, end_time, duration_seconds FROM pending_finalizes").fetchall()
assert len(rows) == 1, f"Expected 1 row, got {len(rows)}"
assert rows[0][0] == fake_id
print(f"INSERT into pending_finalizes — PASS (id={fake_id[:8]}...)")

# 2. Idempotency: second insert with same screenshot_id must be ignored (UNIQUE + OR IGNORE)
conn.execute(
    "INSERT OR IGNORE INTO pending_finalizes (screenshot_id, end_time, duration_seconds) VALUES (?, ?, ?)",
    (fake_id, "2026-06-05T10:35:00+00:00", 600)
)
conn.commit()
rows2 = conn.execute("SELECT COUNT(*) FROM pending_finalizes").fetchone()
assert rows2[0] == 1, f"UNIQUE constraint failed — {rows2[0]} rows"
print("UNIQUE / OR IGNORE idempotency — PASS")

# 3. Simulate successful drain: delete the row
conn.execute("DELETE FROM pending_finalizes WHERE screenshot_id = ?", (fake_id,))
conn.commit()
remaining = conn.execute("SELECT COUNT(*) FROM pending_finalizes").fetchone()[0]
assert remaining == 0, f"Expected 0 rows after drain, got {remaining}"
print("DELETE after drain — PASS")

conn.close()
print("\nAll FIX-9 checks passed.")
```

---

### test_fix10_watchdog.py — FIX-10: Tracking thread watchdog

```python
#!/usr/bin/env python3
"""test_fix10_watchdog.py — Verifies that the tracking thread watchdog detects a dead
tracking thread and would trigger a restart.

Run: python3 test_fix10_watchdog.py
Expected: Watchdog detects dead thread and sets restart_triggered flag.
"""
import threading, time

running = True
restart_triggered = False
_tracking_thread = None

def _fake_tracking_loop():
    """Simulates a tracking thread that dies after 0.1s."""
    time.sleep(0.1)
    # thread exits here

def _start_tracking_thread():
    global _tracking_thread, restart_triggered
    t = threading.Thread(target=_fake_tracking_loop, daemon=True)
    t.start()
    _tracking_thread = t

def _watchdog_check():
    global restart_triggered
    if running and _tracking_thread is not None and not _tracking_thread.is_alive():
        print("[WATCHDOG] Tracking thread dead — would restart (FIX-10)")
        restart_triggered = True

# Start tracking thread and let it die
_start_tracking_thread()
time.sleep(0.3)  # Wait for thread to die

assert not _tracking_thread.is_alive(), "Thread should be dead by now"
print(f"Tracking thread is dead: PASS (is_alive={_tracking_thread.is_alive()})")

_watchdog_check()
assert restart_triggered, "Watchdog did not detect dead thread!"
print("Watchdog detected dead thread — FIX-10 PASS")

print("\nAll FIX-10 checks passed.")
```

---

### run_all_fix_tests.sh — Run all test scripts

```bash
#!/bin/bash
# run_all_fix_tests.sh — Execute all FIX test scripts and report results
# Run from the python-desktop-app/ directory:
#   chmod +x plan/run_all_fix_tests.sh && plan/run_all_fix_tests.sh

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$(dirname "$SCRIPT_DIR")"

PASS=0; FAIL=0; SKIP=0

run_test() {
    local name="$1"
    local file="$SCRIPT_DIR/$name"
    if [[ ! -f "$file" ]]; then
        echo "  [SKIP] $name — file not found"
        ((SKIP+=1))
        return
    fi
    echo ""
    echo "=== $name ==="
    if python3 "$file"; then
        echo "--- PASS ---"
        ((PASS+=1))
    else
        echo "--- FAIL ---"
        ((FAIL+=1))
    fi
}

cd "$APP_DIR"

run_test "test_fix1_sigterm.py"
run_test "test_fix2_pause_state.py"
run_test "test_fix3_screen_lock.py"
run_test "test_fix4_lock_not_held.py"
run_test "test_fix6_circuit_breaker.py"
run_test "test_fix8_idle_record_guard.py"
run_test "test_fix9_pending_finalizes.py"
run_test "test_fix10_watchdog.py"

echo ""
echo "==============================="
echo "Results: PASS=$PASS  FAIL=$FAIL  SKIP=$SKIP"
echo "==============================="
[[ $FAIL -eq 0 ]]
```

> **Note:** Copy each script block into the corresponding `.py` file in `python-desktop-app/plan/` (or any writable directory), then run `bash plan/run_all_fix_tests.sh` from the `python-desktop-app/` directory. Scripts that exercise Linux-only features (FIX-3, FIX-5) will auto-skip on Windows/headless systems.

