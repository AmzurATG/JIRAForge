# Tracking Blockers — Root Cause Analysis

**App Version:** 1.4.5  
**File Analysed:** `desktop_app.py`  
**Date:** 2026-05-27  
**Scope:** All scenarios where tracking silently stops, fails to resume, or loses data after idle time, system restart, system shutdown, sleep/hibernate, or screen lock.

---

## Table of Contents

1. [B-1 — pynput failure traps tracking in idle forever](#b-1--pynput-failure-traps-tracking-in-idle-forever)
2. [B-2 — Activity monitor thread dies silently with no watchdog](#b-2--activity-monitor-thread-dies-silently-with-no-watchdog)
3. [B-3 — needs_idle_resume written without state_lock (race condition)](#b-3--needs_idle_resume-written-without-state_lock-race-condition)
4. [B-4 — monitor_system_events failure leaves only loop-gap fallback](#b-4--monitor_system_events-failure-leaves-only-loop-gap-fallback)
5. [B-5 — Hibernate idle period silently dropped by work-hours filter](#b-5--hibernate-idle-period-silently-dropped-by-work-hours-filter)
6. [B-6 — Duplicate idle records created on system wake](#b-6--duplicate-idle-records-created-on-system-wake)
7. [B-7 — WTS registration failure causes LockApp.exe tracked as work](#b-7--wts-registration-failure-causes-lockappexe-tracked-as-work)
8. [B-8 — _is_screen_locked always returns False without WIN32](#b-8--_is_screen_locked-always-returns-false-without-win32)
9. [B-9 — No WM_ENDSESSION handler; clean shutdown data loss](#b-9--no-wm_endsession-handler-clean-shutdown-data-loss)
10. [B-10 — atexit skipped on abrupt kill/power loss](#b-10--atexit-skipped-on-abrupt-killpower-loss)
11. [B-11 — Stale startup registry entry prevents auto-launch after reboot](#b-11--stale-startup-registry-entry-prevents-auto-launch-after-reboot)
12. [B-12 — _finalize_active_session has no offline fallback on Supabase error](#b-12--_finalize_active_session-has-no-offline-fallback-on-supabase-error)
13. [B-13 — Mandatory update exit does not join the tracking thread](#b-13--mandatory-update-exit-does-not-join-the-tracking-thread)
14. [B-14 — No watchdog to restart a crashed tracking thread](#b-14--no-watchdog-to-restart-a-crashed-tracking-thread)

---

## B-1 — pynput failure traps tracking in idle forever

**Severity:** HIGH  
**Scenario:** Idle timeout detection

### What Happens
After the idle timeout fires (`idle_threshold_seconds`, default 5 min), the tracking loop transitions to idle state and then waits for `self.needs_idle_resume` to be set by pynput. If pynput is unavailable or its listeners crash, `needs_idle_resume` is never set to `True`. Tracking remains permanently stuck in the idle branch of the loop, even when the user is actively working. The user sees no error, the tray icon shows idle, and no data is recorded.

### Root Cause — Code Location
`monitor_user_activity()` (line ~10116):
```python
try:
    from pynput import mouse, keyboard
except ImportError:
    print("[WARN] pynput not installed - idle detection disabled")
    return  # <-- thread exits silently; needs_idle_resume is NEVER set
```

`on_activity()` inside the same function (line ~10125):
```python
def on_activity(*args, **kwargs):
    self.last_activity_time = time.time()
    if self.is_idle:
        self.needs_idle_resume = True  # <-- only pynput sets this
```

`tracking_loop()` idle resume check (line ~10650):
```python
if not self.needs_idle_resume:
    time.sleep(5)
    continue  # <-- stuck here forever if pynput never fires
```

### Why There Is No Recovery
- pynput is the **only** mechanism that sets `needs_idle_resume = True` after an idle timeout.
- Window-switch detection in `get_active_window()` does reset `last_activity_time`, but it does **not** set `needs_idle_resume`. So even switching windows while idle does not break out of the stuck state.
- There is no periodic check of `last_activity_time` vs `last_idle_entry_time` that could serve as a fallback resume path.

### Fix Direction
Add a secondary resume path inside the idle branch of `tracking_loop`: if `last_activity_time` has advanced since entering idle (i.e., pynput did fire but `needs_idle_resume` was not set), treat that as a resume trigger. Also restart the pynput listeners if they die (see B-2).

---

## B-2 — Activity monitor thread dies silently with no watchdog

**Severity:** HIGH  
**Scenario:** Idle timeout detection — after extended sessions, RDP reconnect, or UAC prompt

### What Happens
`monitor_user_activity()` runs on a daemon thread. The pynput `Listener` objects use a background OS hook. If the hook fails (e.g., after a UAC elevation prompt, RDP session switch, display driver crash, or accessibility permission change), the pynput listeners stop firing callbacks while the thread itself appears alive to Python. There is no health check on this thread, so idle detection becomes silently dead.

### Root Cause — Code Location
`start_tracking()` (line ~10932):
```python
if not self._activity_monitor_thread or not self._activity_monitor_thread.is_alive():
    self._activity_monitor_thread = threading.Thread(
        target=self.monitor_user_activity, daemon=True
    )
    self._activity_monitor_thread.start()
```

The `is_alive()` check only detects if the Python thread object is alive. A pynput `Listener` that is alive but receiving no OS events will not cause `is_alive()` to return `False`. There is no periodic liveness check or restart anywhere in the codebase.

`monitor_user_activity()` — thread body exits cleanly on ImportError but has no exception handler around `mouse_listener.start()` / `keyboard_listener.start()`. If those raise (e.g., OS hook failure), the exception propagates, the thread dies, but `_activity_monitor_thread.is_alive()` returns `False` only after the thread terminates.

### Why There Is No Recovery
- `tracking_loop` checks `self.needs_idle_resume` but never verifies the health of the thread that is supposed to set it.
- Even if the thread dies (returns `False` from `is_alive()`), the tracking loop has no code to restart it.

### Fix Direction
Add a periodic heartbeat: pynput `on_activity` should update a `last_pynput_heartbeat` timestamp. In the tracking loop, if more than N minutes have passed since the last heartbeat AND the machine is not in idle, restart the activity monitor thread. Wrap `mouse_listener.start()` and `keyboard_listener.start()` in try/except with a retry loop.

---

## B-3 — needs_idle_resume written without state_lock (race condition)

**Severity:** MEDIUM  
**Scenario:** Screen unlock or system wake

### What Happens
`monitor_system_events()` runs the Windows message pump on a dedicated daemon thread. When `WTS_SESSION_UNLOCK` or `PBT_APMRESUMEAUTOMATIC` fires, the message pump thread directly calls `_create_idle_record()` and sets `self.needs_idle_resume = True` — both without holding `self.state_lock`. Concurrently, the main tracking loop can be inside `resume_from_idle()` (which does hold `state_lock`) and reading `self.needs_idle_resume`. This is an unsynchronised boolean write from two threads.

### Root Cause — Code Location
`monitor_system_events()` — `wnd_proc` callback (line ~10192):
```python
elif wparam == WTS_SESSION_UNLOCK:
    self._create_idle_record("screen lock")
    self.needs_idle_resume = True   # <-- no lock held
```

`resume_from_idle()` (line ~9962):
```python
with self.state_lock:
    ...
    self.needs_idle_resume = False   # <-- state_lock held here
```

`tracking_loop` resume check (line ~10648):
```python
if self.needs_idle_resume:
    if self.resume_from_idle():
        ...
    self.needs_idle_resume = False   # <-- no lock held
```

### Why It Matters
In CPython the GIL makes plain boolean assignment effectively atomic for the assignment itself. However, the compound read-check-write sequence `if self.is_idle: self.needs_idle_resume = True` is **not** atomic. Additionally, `_create_idle_record` is called from the message pump thread while state fields like `self.idle_start_time` can be mutated from the tracking loop thread. This can produce a double idle record or a missed idle record.

### Fix Direction
Protect `self.needs_idle_resume` reads and writes with `state_lock`, or convert it to a `threading.Event`. Move the `_create_idle_record` call inside the tracking loop (triggered by the event) so it only executes on the tracking thread.

---

## B-4 — monitor_system_events failure leaves only loop-gap fallback

**Severity:** MEDIUM  
**Scenario:** System sleep/wake on machines where the message-only window cannot be created

### What Happens
`monitor_system_events()` tries to create a message-only window (`HWND_MESSAGE`) to receive `WM_POWERBROADCAST` and `WM_WTSSESSION_CHANGE`. This can fail in two stages: (a) `RegisterClassExW` returns 0 (fails in restricted/sandboxed environments), (b) `CreateWindowExW` returns 0. Both stages log a warning and return early. When this happens, sleep/wake and lock/unlock events are completely missed by the system event thread.

The only remaining protection is the 30-second loop-gap check in `tracking_loop`:
```python
if time_since_last_loop > 30:
    # treat as suspension
```

### Root Cause — Code Location
`monitor_system_events()` failure paths (lines ~10240–10255):
```python
atom = user32.RegisterClassExW(ctypes.byref(wc))
if not atom:
    print("[ERROR] Failed to register window class ...")
    return   # <-- no fallback installed

hwnd = user32.CreateWindowExW(...)
if not hwnd:
    print("[ERROR] Failed to create message-only window ...")
    return   # <-- no fallback installed
```

The top-level `except Exception` at line ~10280 catches everything else and also just returns:
```python
except Exception as e:
    print(f"[WARN] System event monitoring failed to start: {e}")
    print("[INFO] Idle detection will still work via activity timeout")
```

### Why the Loop-Gap Fallback Is Insufficient
- **Lock/unlock is completely blind** — the loop-gap check only catches time gaps (sleep). A screen lock with no sleep produces no gap in the loop timer.
- The **30-second threshold** is generous: a laptop that sleeps for 29 seconds (e.g., closing lid briefly) is not detected and the loop treats it as a slow cycle, not a suspension.
- After wake, the loop-gap path calls `resume_from_idle()` unconditionally without checking whether the system event thread also fired, which creates the B-6 double-record issue.

### Fix Direction
After the `CreateWindowExW` failure, fall back to polling `GetSystemPowerStatus` and checking the session state via `WTSQuerySessionInformationW`. Set up a `_system_events_available` flag so `tracking_loop` can use a more aggressive polling interval for screen-lock detection when the message pump is unavailable.

---

## B-5 — Hibernate idle period silently dropped by work-hours filter

**Severity:** MEDIUM  
**Scenario:** Machine put into hibernate overnight or over a weekend

### What Happens
When a machine is hibernated outside configured work hours (e.g., hibernated at 18:30, woken at 08:00), the entire overnight period qualifies as idle. On wake, `_create_idle_record()` is called. Inside it, `_is_within_work_hours(self.idle_start_time)` is evaluated against the idle **start** time (18:30). Since 18:30 is at or just past the `work_hours_end` of 18:00, the check returns `False` and the record is silently discarded:

```python
if not self._is_within_work_hours(self.idle_start_time):
    print(f"[IDLE] Skipping idle record outside work hours ...")
    self.idle_start_time = None
    return
```

The result is that the overnight gap produces no record of any kind — no idle record, no gap marker. Dashboard reports show no data for that work day, which can look like untracked work time.

### Root Cause — Code Location
`_create_idle_record()` (line ~10072):
```python
if not self._is_within_work_hours(self.idle_start_time):
    print(f"[IDLE] Skipping idle record outside work hours ...")
    self.idle_start_time = None
    return
```

`_is_within_work_hours()` (line ~10017) only tests whether the **start timestamp** of the idle period falls inside work hours. It does not test whether any portion of the idle period overlaps work hours.

### Why It Matters
The user was presumably at work from 09:00–18:30, then went home. When they arrive the next morning (08:00), the idle record start time (18:30) fails the work-hours check and is dropped. However, the **end** time (08:00 next day) also fails. The whole period vanishes. If this is a recurring pattern, the user's reported tracked time is consistently low by the duration of their end-of-day wind-down.

### Fix Direction
Change `_create_idle_record` to clip the idle window to the intersection with work hours, rather than dropping the whole record. If `idle_start_time` is outside work hours but `idle_end_time` (now) is within work hours, create a record covering only the in-hours portion. If neither endpoint is within hours, drop the record (current behaviour).

---

## B-6 — Duplicate idle records created on system wake

**Severity:** LOW  
**Scenario:** System sleep/wake

### What Happens
On system wake, two independent code paths can both call `_create_idle_record()` for the same sleep period:

1. **Message pump thread** — `PBT_APMRESUMEAUTOMATIC` fires → `_create_idle_record("system sleep")`
2. **Tracking loop** — `time_since_last_loop > 30` → `_create_idle_record("system suspension detected")`

Both calls read `self.idle_start_time` and append to `self._pending_idle_records`. Whichever runs second also reads a non-None `idle_start_time` (because the first call sets it to None only at the very end, after computing the record). Depending on thread scheduling, two overlapping idle records for the same period are produced and both get uploaded to `activity_records`.

### Root Cause — Code Location
`monitor_system_events()` — `wnd_proc` on `PBT_APMRESUMEAUTOMATIC` (line ~10200):
```python
elif wparam == PBT_APMRESUMEAUTOMATIC:
    self._create_idle_record("system sleep")
    self.needs_idle_resume = True
```

`tracking_loop` loop-gap handler (line ~10497):
```python
if self.is_idle and self.idle_start_time:
    self._create_idle_record("system suspension detected")
```

`_create_idle_record()` — `idle_start_time` cleared at the very end (line ~10112):
```python
self._pending_idle_records.append(record)
self.idle_start_time = None    # <-- cleared AFTER append; race window exists
```

### Fix Direction
Guard `_create_idle_record` with `state_lock`. Check `self.idle_start_time is None` at entry under the lock, and set it to `None` at the **start** (not the end) of the function to act as a taken-flag. Alternatively, set a `_idle_record_pending` boolean under the lock before calling `_create_idle_record` and clear it after, so only one caller proceeds.

---

## B-7 — WTS registration failure causes LockApp.exe tracked as work

**Severity:** MEDIUM  
**Scenario:** Screen lock on machines where WTSRegisterSessionNotification is restricted

### What Happens
In enterprise environments with Group Policy restrictions, or when `wtsapi32.WTSRegisterSessionNotification` returns 0 (failure), the code logs a warning and continues:
```python
if not wtsapi32.WTSRegisterSessionNotification(hwnd, NOTIFY_FOR_THIS_SESSION):
    print("[WARN] WTSRegisterSessionNotification failed — lock/unlock detection disabled")
    print("[INFO] Sleep/wake detection is still active")
```
`WM_WTSSESSION_CHANGE` messages are then never received. Screen lock and unlock go undetected by the system event thread.

The fallback is `_is_screen_locked()` in `tracking_loop`, which inspects the foreground process name:
```python
hwnd = win32gui.GetForegroundWindow()
_, pid = win32process.GetWindowThreadProcessId(hwnd)
process = psutil.Process(pid)
return process.name().lower() in LOCK_SCREEN_APPS
```
This polling runs every **2 seconds** (the tracking loop sleep interval). During those 2 seconds, `LockApp.exe` or `LogonUI.exe` can be captured as the active window and `process_window_event()` is called with it, creating an activity record for a lock-screen process.

### Root Cause — Code Location
`_is_screen_locked()` (line ~9434) is only checked **after** `get_active_window()` and `process_window_event()` in the tracking loop. By the time the lock is detected, at least one loop iteration of lock-screen activity may have already been recorded.

`tracking_loop` screen-lock guard (line ~10668):
```python
if self._is_screen_locked():
    if self.state == TrackingState.ACTIVE:
        self.enter_idle("screen still locked")
    time.sleep(5)
    continue
```
This guard comes **after** the window-event processing block, not before.

### Fix Direction
Move the `_is_screen_locked()` check to the **top** of the main tracking block, before `get_active_window()` is called. This ensures that no lock-screen process is ever passed to `process_window_event()`. Additionally, add `LockApp.exe` and `LogonUI.exe` to the `should_skip_screenshot()` classification list as a secondary defence.

---

## B-8 — _is_screen_locked always returns False without WIN32

**Severity:** LOW  
**Scenario:** Non-Windows builds or machines where win32gui/pywin32 fails to import

### What Happens
`_is_screen_locked()` has an early return when `WIN32_AVAILABLE` is `False`:
```python
def _is_screen_locked(self):
    if not WIN32_AVAILABLE:
        return False
```
On non-Windows platforms (or Windows with a broken pywin32 install), `WIN32_AVAILABLE` is `False`. The screen-lock guard in `tracking_loop` then never triggers, meaning screen-lock events are completely invisible. The system event monitor thread also never starts (it guards with `if WIN32_AVAILABLE`), so there is no compensating mechanism.

### Root Cause — Code Location
`WIN32_AVAILABLE` is set at import time (line ~259):
```python
try:
    import win32con
    ...
    WIN32_AVAILABLE = True
except ImportError:
    WIN32_AVAILABLE = False
```

All screen-lock detection paths (both polling and event-based) are gated on this flag with no fallback for cross-platform or broken-import scenarios.

### Fix Direction
For non-Windows, screen-lock detection should use the platform-appropriate API (e.g., `loginctl show-session` on Linux systemd, `CGSessionCopyCurrentDictionary` on macOS). For a broken pywin32 install on Windows, log a clear error and suggest reinstallation. For completely unsupported platforms, document that screen-lock detection is not available.

---

## B-9 — No WM_ENDSESSION handler; clean shutdown loses open session

**Severity:** HIGH  
**Scenario:** Windows system shutdown or user logoff initiated from the Start menu

### What Happens
When Windows shuts down, it broadcasts `WM_QUERYENDSESSION` and then `WM_ENDSESSION` to all top-level windows. The app's message-only window (`monitor_system_events`) handles only `WM_POWERBROADCAST` and `WM_WTSSESSION_CHANGE`. Neither `WM_QUERYENDSESSION` nor `WM_ENDSESSION` is handled.

Windows typically gives applications 5 seconds to respond to `WM_ENDSESSION` before force-terminating them (configurable via `HungAppTimeout` registry key, default 5 s). During this window:
- `_shutdown_cleanup()` is registered via `atexit`, but `atexit` is only called on clean Python exit — not on `WM_ENDSESSION` unless the Python process explicitly calls `sys.exit()` in response.
- The current open screenshot record has `end_time = NULL` and `duration_seconds = NULL` in Supabase.
- The SQLite activity timer is still running.
- No final batch upload occurs.

### Root Cause — Code Location
`monitor_system_events()` — `wnd_proc` does not handle `WM_ENDSESSION` (line ~10192):
```python
def wnd_proc(hwnd, msg, wparam, lparam):
    if msg == WM_POWERBROADCAST:
        ...
    elif msg == WM_WTSSESSION_CHANGE:
        ...
    # WM_QUERYENDSESSION = 0x0011 — not handled
    # WM_ENDSESSION      = 0x0016 — not handled
    return user32.DefWindowProcW(hwnd, msg, wparam, lparam)
```

`_shutdown_cleanup()` (line ~11469) exists and does the right thing (flush sessions, upload batch, close DB) but is only reachable via `atexit`, which Python only calls on clean exit — not when the OS force-terminates the process.

### Fix Direction
Add `WM_QUERYENDSESSION = 0x0011` and `WM_ENDSESSION = 0x0016` to the `wnd_proc` message handler. On `WM_ENDSESSION` with `wparam == 1` (session is ending), call `_finalize_active_session()`, `upload_activity_batch()`, and `_shutdown_cleanup()` synchronously within the 5-second budget. Return `0` from `DefWindowProcW` for `WM_QUERYENDSESSION` to grant permission to proceed.

---

## B-10 — atexit skipped on abrupt kill/power loss

**Severity:** HIGH  
**Scenario:** Process killed via Task Manager, power cut, BSOD, forced system shutdown

### What Happens
Python's `atexit` handlers run only when the interpreter exits cleanly — via `sys.exit()`, reaching the end of the main script, or an unhandled exception that terminates the interpreter. They do **not** run when:
- The process is terminated with `SIGKILL` / `taskkill /F`
- The OS powers off without sending shutdown events
- A hard power cut occurs
- A BSOD terminates the session

In all of these cases, the `_shutdown_cleanup()` registered at line 5285 never runs. The consequences are:
1. The current screenshot record's `end_time` and `duration_seconds` remain `NULL` in Supabase indefinitely.
2. All `_pending_idle_records` in memory are lost.
3. The SQLite session timer is left open — `active_sessions` table has an unclosed row.
4. Any data in the offline SQLite queue that was accumulated since the last batch upload (up to 5 minutes, `batch_upload_interval = 300`) is lost.

### Root Cause — Code Location
`__init__` (line ~5285):
```python
atexit.register(self._shutdown_cleanup)
```

`_shutdown_cleanup()` (line ~11469):
```python
def _shutdown_cleanup(self):
    if getattr(self, '_shutdown_done', False):
        return
    self._shutdown_done = True
    ...
    self.upload_activity_batch()
    ...
    self.db_manager.close_all()
```

`upload_activity_batch()` uploads from `_pending_idle_records` and the SQLite queue to Supabase. Since SQLite is write-ahead-logged and persisted to disk, **data written to SQLite before the crash is safe**. However, data held only in Python memory (`_pending_idle_records`, the current open screenshot record ID) is always lost.

### Fix Direction
1. **Write screenshot record state to SQLite immediately after creation**, not just in memory. Store `current_window_screenshot_id`, `current_window_db_start_time`, and `last_screenshot_end_time` as a small "checkpoint" row in SQLite after each `upload_screenshot()` call.
2. **On startup**, check for an unfinished checkpoint row and send a `PATCH` to Supabase to close it with `end_time = now()`. This makes crash recovery automatic.
3. Append `_pending_idle_records` to SQLite immediately on creation (inside `_create_idle_record`) rather than holding them in a Python list.

---

## B-11 — Stale startup registry entry prevents auto-launch after reboot

**Severity:** MEDIUM  
**Scenario:** App reinstalled to a different path, or exe moved after installation

### What Happens
`add_to_startup()` writes the current exe path to the Windows registry:
```
HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run
TimeTracker = "C:\Users\<user>\AppData\Local\TimeTracker\TimeTracker.exe"
```
The path is validated at the time of writing. However, if the app is subsequently updated via the auto-update mechanism and the new exe is installed to a slightly different path (e.g., versioned sub-folder), the registry entry is not updated unless `add_to_startup()` is called again. The old path no longer exists, so Windows silently skips the entry at boot, and the tracker never starts.

### Root Cause — Code Location
`add_to_startup()` (line ~1674) is called only in `run()` during startup:
```python
if getattr(sys, 'frozen', False):
    add_to_startup()
```
The auto-update path (`update_manager.apply_update()`) does **not** call `add_to_startup()` after replacing the exe. If the new exe lands in a different path, the registry entry points to the old (deleted) exe.

`add_to_startup()` itself validates the target path at write time:
```python
if installed_exe and os.path.isfile(installed_exe):
    exe_path = installed_exe
else:
    exe_path = get_app_executable_path()
```
But this check runs against `get_installed_exe_path()` which returns a fixed path. If the update changes that path, the fallback `get_app_executable_path()` points to the currently running (old) exe, which is then deleted by the update.

### Fix Direction
Call `add_to_startup()` at the **end** of the update apply step, not just on first launch. Pass the new exe path explicitly rather than calling `get_installed_exe_path()` from `add_to_startup()`. Add a startup validation step: on launch, compare the current exe path against the registry entry and rewrite the entry if they differ.

---

## B-12 — _finalize_active_session has no offline fallback on Supabase error

**Severity:** HIGH  
**Scenario:** Network loss, Supabase JWT expiry, or PostgREST error at session boundary (idle, sleep, shutdown)

### What Happens
`_finalize_active_session()` is the critical path called whenever tracking transitions to idle, sleep, or shutdown. It does a direct Supabase `UPDATE` on the `screenshots` table:
```python
update_result = db_client.table('screenshots').update({
    'end_time': end_time.isoformat(),
    'timestamp': end_time.isoformat(),
    'duration_seconds': duration_seconds
}).eq('id', self.current_window_screenshot_id).execute()
```

If this call throws any exception (network timeout, 401 JWT expired, PostgREST 409, etc.), it is caught by the bare `except Exception as e:` and logged, then execution continues. The screenshot record in Supabase retains `end_time = NULL` and `duration_seconds = NULL` permanently — there is no retry, no offline queue entry, and no local record of the pending update.

By contrast, `upload_screenshot()` (the create path) has a two-layer fallback: first Supabase, then SQLite offline store. `_finalize_active_session()` has no equivalent.

### Root Cause — Code Location
`_finalize_active_session()` (line ~9867):
```python
try:
    db_client = self.supabase
    update_result = db_client.table('screenshots').update({...})
        .eq('id', self.current_window_screenshot_id).execute()
    ...
except Exception as e:
    print(f"[ERROR] Error finalizing session ({reason}): {e}")
    # <-- NO retry, NO offline queue, NO SQLite save
```

The same pattern exists in the interval-update and window-switch-update blocks inside `tracking_loop` (lines ~10760 and ~10820), which also call `db_client.table('screenshots').update(...)` with only a bare `except` catch and no recovery.

### Fix Direction
On exception in `_finalize_active_session()`, save a pending-finalize record to SQLite:
```python
self.offline_manager.save_pending_finalize(
    record_id=self.current_window_screenshot_id,
    end_time=end_time,
    duration_seconds=duration_seconds
)
```
On app startup and in the sync thread, drain any pending-finalize records by retrying the Supabase `UPDATE`. The SQLite schema needs a new `pending_finalizes` table with columns: `screenshot_id`, `end_time`, `duration_seconds`, `created_at`.

---

## B-13 — Mandatory update exit does not join the tracking thread

**Severity:** LOW  
**Scenario:** Mandatory app update downloaded and ready to install

### What Happens
`_enforce_mandatory_update_pause()` (line ~5429) sets `self.tracking_active = False` and `self._mandatory_update_enforced = True`, which pauses data capture. When the user confirms the update via the tray menu, `update_manager.apply_update()` runs on a daemon thread (line ~6415). `apply_update()` eventually calls `quit_app()` → `_shutdown_cleanup()` → `sys.exit(0)`.

At the point of `sys.exit(0)`, the tracking thread (`_tracking_thread`) may still be in mid-operation: sleeping in the paused branch (`time.sleep(1)`) or executing a batch upload that was triggered just before the pause. Because the tracking thread is a `daemon=True` thread, Python kills it immediately when `sys.exit()` is called, without waiting for it to reach a clean state.

### Root Cause — Code Location
`quit_app()` (line ~11568):
```python
def quit_app(self):
    self._update_desktop_status(logged_in=False)
    self._shutdown_cleanup()
    self.stop_tracking()     # sets self.running = False
    if self.tray:
        self.tray.stop()
    sys.exit(0)
```

`stop_tracking()` (line ~11018):
```python
def stop_tracking(self):
    self.running = False
    self.tracking_active = False
    ...
```

After `self.running = False`, `stop_tracking()` returns immediately without joining `_tracking_thread`. The thread may still be executing `upload_activity_batch()` or `_finalize_active_session()`. `sys.exit(0)` then terminates the process while the upload is in-flight.

### Fix Direction
After `self.running = False`, add a bounded join:
```python
if self._tracking_thread and self._tracking_thread.is_alive():
    self._tracking_thread.join(timeout=10)  # max 10s grace period
```
Place this join in `stop_tracking()` or in `quit_app()` before `sys.exit(0)`.

---

## B-14 — No watchdog to restart a crashed tracking thread

**Severity:** MEDIUM  
**Scenario:** Unexpected exception in tracking_loop that breaks the while loop

### What Happens
`tracking_loop()` has an outer `while self.running:` loop with an inner `try/except Exception` that logs the error and sleeps 5 seconds before retrying. This handles most transient errors. However, there are two ways the loop can exit without `self.running` being set to `False`:

1. A `BaseException` (e.g., `KeyboardInterrupt`, `SystemExit`) propagates past the `except Exception` handler and terminates the thread.
2. A call inside the loop explicitly sets `self.running = False` and breaks (e.g., the shutdown-signal check at line ~10533: `self.running = False; self.quit_app(); break`).

In both cases, the `_tracking_thread` becomes dead. The tray icon and `self.running` flag may not reflect this. The user sees no indication that tracking has stopped; the tray icon remains green (active), and `tracking_active` is still `True`.

### Root Cause — Code Location
`start_tracking()` (line ~10928):
```python
self._tracking_thread = threading.Thread(target=self.tracking_loop, daemon=True)
self._tracking_thread.start()
```

There is no watchdog thread that monitors `_tracking_thread.is_alive()` and restarts it.

`tracking_loop` — outer exception swallows `Exception` only (line ~10875):
```python
except Exception as e:
    print(f"[ERROR] Tracking loop error: {e}")
    traceback.print_exc()
    time.sleep(5)
# BaseException (SystemExit, KeyboardInterrupt) falls through here
```

The periodic tray icon update thread (`update_icon_periodically`) only calls `update_tray_icon()` — it does not check thread health or update the state to reflect a dead tracking thread.

### Fix Direction
Add a watchdog inside `update_icon_periodically` (or a dedicated thread):
```python
if self.running and self._tracking_thread and not self._tracking_thread.is_alive():
    print("[WARN] Tracking thread died unexpectedly — restarting")
    self._tracking_thread = threading.Thread(target=self.tracking_loop, daemon=True)
    self._tracking_thread.start()
    self.add_admin_log('WARNING', 'Tracking thread restarted by watchdog')
```
Also update `tracking_loop` to catch `BaseException`, perform cleanup, and re-raise only `SystemExit`/`KeyboardInterrupt`.

---

## Priority Matrix

| ID | Blocker | Scenario | Data Loss? | Tracking Stops? | Priority |
|----|---------|----------|-----------|-----------------|----------|
| B-1 | pynput failure → stuck idle | Idle timeout | No | YES (permanently) | P1 |
| B-9 | No WM_ENDSESSION handler | OS shutdown | YES | YES | P1 |
| B-10 | atexit not called on kill | Power loss / kill | YES | YES | P1 |
| B-12 | _finalize_active_session no offline fallback | Network loss | YES | No | P1 |
| B-2 | Activity monitor thread dies | Long session / RDP | No | YES (after idle) | P2 |
| B-4 | monitor_system_events fails | Sleep on restricted PC | Partial | Partial | P2 |
| B-5 | Hibernate idle dropped by work-hours | Overnight hibernate | YES | No | P2 |
| B-7 | WTS failure → LockApp tracked as work | Corporate GPO | Corrupt data | No | P2 |
| B-14 | No tracking thread watchdog | Unexpected crash | No | YES | P2 |
| B-3 | needs_idle_resume race | Screen unlock / wake | Rare | Rare | P3 |
| B-6 | Duplicate idle on wake | Sleep/wake | Corrupt data | No | P3 |
| B-11 | Stale startup registry | Post-update reboot | No | YES (on reboot) | P3 |
| B-13 | No thread join before exit | Mandatory update | Possible | YES | P3 |
| B-8 | _is_screen_locked false on non-Win32 | Non-Windows / bad pywin32 | No | No | P4 |

---

## Affected Code Sections (Quick Reference)

| Line Range | Function | Blockers |
|------------|----------|---------|
| 9867–9916 | `_finalize_active_session` | B-12 |
| 9911–9960 | `enter_idle` | B-3 |
| 9962–10016 | `resume_from_idle` | B-3 |
| 10017–10057 | `_is_within_work_hours` | B-5 |
| 10060–10113 | `_create_idle_record` | B-5, B-6 |
| 10116–10148 | `monitor_user_activity` | B-1, B-2 |
| 10151–10280 | `monitor_system_events` | B-3, B-4, B-6, B-7, B-9 |
| 10440–10880 | `tracking_loop` | B-1, B-4, B-6, B-14 |
| 10884–10965 | `start_tracking` | B-2 |
| 11018–11030 | `stop_tracking` | B-13 |
| 11429–11445 | `_enforce_mandatory_update_pause` | B-13 |
| 11469–11495 | `_shutdown_cleanup` | B-9, B-10 |
| 11568–11580 | `quit_app` | B-13 |
| 1674–1730 | `add_to_startup` | B-11 |
| 5285 | `atexit.register` | B-10 |
| 9434–9445 | `_is_screen_locked` | B-7, B-8 |
