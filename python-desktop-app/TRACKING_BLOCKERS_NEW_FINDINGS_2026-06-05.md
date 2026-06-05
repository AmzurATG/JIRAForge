# New Tracking Blockers — Root Cause Analysis (2026-06-05)

**App Version:** Current HEAD  
**File Analysed:** `desktop_app.py` (16,643 lines)  
**Date:** 2026-06-05  
**Scope:** Fresh deep-dive scan covering Linux-specific tracking gaps and cross-cutting blockers not in the existing `TRACKING_BLOCKERS_ROOT_CAUSE_ANALYSIS.md`.  
**Method:** Static code analysis — no code changes made.

> **Note:** Blockers B-1 through B-14 are documented in `TRACKING_BLOCKERS_ROOT_CAUSE_ANALYSIS.md`.  
> This file documents **NEW** blockers (BL-15 through BL-20) found in the current HEAD.

---

## Table of Contents

1. [BL-15 — Linux screen lock detection is GNOME-only; silent failure on KDE/XFCE/all other DEs](#bl-15--linux-screen-lock-detection-is-gnome-only)
2. [BL-16 — `pause_tracking()` leaves `self.state = ACTIVE`; D-Bus idle worker finalizes session while paused](#bl-16--pause_tracking-leaves-selfstate--active)
3. [BL-17 — `_get_active_window_linux()` can stall the tracking loop for 8+ seconds on minimal Linux](#bl-17--_get_active_window_linux-can-stall-the-tracking-loop)
4. [BL-18 — No `SIGTERM` handler on Linux; systemd stop / user logout bypasses `atexit`](#bl-18--no-sigterm-handler-on-linux)
5. [BL-19 — `enter_idle()` and `resume_from_idle()` call `update_tray_icon()` from a background D-Bus thread; GTK is not thread-safe](#bl-19--update_tray_icon-called-from-background-dbus-thread)
6. [BL-20 — `state_lock` held while making HTTP calls inside `enter_idle()` and `resume_from_idle()`; all concurrent state transitions blocked](#bl-20--state_lock-held-during-http-calls)
7. [Priority Matrix](#priority-matrix)

---

## BL-15 — Linux screen lock detection is GNOME-only

**Severity:** HIGH  
**Platform:** Linux (non-GNOME desktops — KDE Plasma, XFCE, MATE, Cinnamon, i3, sway, etc.)  
**Scenario:** Screen lock while tracking is active

### What Happens

`_is_screen_locked()` queries the `org.gnome.ScreenSaver` D-Bus interface. This interface is only implemented by `gnome-screensaver` / GNOME Shell. On KDE Plasma the service is `org.kde.screensaver`; on XFCE it is `org.xfce.ScreenSaver`; on standalone compositors (i3lock, swaylock) there is no standardised D-Bus screensaver interface at all.

When the `gdbus call` fails (non-zero return code) on a non-GNOME desktop, the `except Exception` catch silently swallows the error and the function returns `False` — meaning "screen is not locked." The tracking loop then continues to call `get_active_window()` and `process_window_event()` as if the user is active, recording time against whatever window is behind the lock screen.

Additionally, `LOCK_SCREEN_APPS` (the process-name blocklist) contains only Windows names:

```python
# desktop_app.py line 5418
LOCK_SCREEN_APPS = {'lockapp.exe', 'logonui.exe'}
```

No Linux lock-screen process names (`gnome-screensaver`, `xscreensaver`, `i3lock`, `swaylock`, `kscreenlocker_greet`, etc.) are in this set. So the `process_window_event()` guard inside `upload_activity_batch()` (line 10317) also provides no protection on Linux.

### Root Cause — Code Location

`_is_screen_locked()` — Linux branch (lines 11047–11063):

```python
# Only queries GNOME; all other DEs silently return False
try:
    result = subprocess.run(
        ['gdbus', 'call', '--session',
         '--dest', 'org.gnome.ScreenSaver',        # <-- GNOME-only D-Bus name
         '--object-path', '/org/gnome/ScreenSaver',
         '--method', 'org.gnome.ScreenSaver.GetActive'],
        capture_output=True, text=True, timeout=1
    )
    if result.returncode == 0:
        return 'true' in result.stdout.lower()
except Exception:
    pass
return False  # <-- returns False on ANY non-GNOME desktop; screen lock is never detected
```

`LOCK_SCREEN_APPS` (line 5418):

```python
LOCK_SCREEN_APPS = {'lockapp.exe', 'logonui.exe'}   # Windows only — no Linux entries
```

### Why There Is No Recovery

- The idle timeout (`idle_threshold_seconds`, default 5 minutes) does not fire during a screen lock because `last_activity_time` is updated on every window switch, and the lock screen window switches ARE recorded.
- `monitor_system_events()` (Windows-only, guarded by `if WIN32_AVAILABLE`) never starts on Linux, so no D-Bus lock/unlock signal is received from that path.
- The result is that when a Linux user locks their screen, the tracker sees continued "activity" and records time against the lock screen window for the entire locked period.

### Affected Scenarios

- Any Linux system running KDE Plasma, XFCE, MATE, Cinnamon, i3, sway, or any non-GNOME environment.
- GNOME users with a broken or absent `gnome-screensaver` D-Bus service.

---

## BL-16 — `pause_tracking()` leaves `self.state = ACTIVE`

**Severity:** HIGH  
**Platform:** All (most visible on Linux where D-Bus backend is used)  
**Scenario:** User manually pauses tracking via the tray menu; idle timeout fires while paused

### What Happens

`pause_tracking()` sets `self.tracking_active = False` but does **not** update `self.state`. The `TrackingState.PAUSED` enum value exists (line 6388) but is **never assigned** anywhere in the codebase.

After `pause_tracking()`, the tracking loop enters its paused branch (`if not self.tracking_active: time.sleep(1); continue`) and stops processing. However, the D-Bus idle poll worker (`_dbus_idle_poll_worker`) runs on a separate daemon thread that does NOT check `self.tracking_active`. When idle timeout fires (5 minutes of no system input):

1. D-Bus worker calls `self.enter_idle("idle timeout")` directly.
2. `enter_idle()` acquires `self.state_lock`.
3. `self.state` is still `TrackingState.ACTIVE` → the condition `if self.state == TrackingState.ACTIVE:` is **True**.
4. `_finalize_active_session("idle timeout")` is called: the open Supabase `screenshots` record is closed with `end_time = last_activity_time` and `duration_seconds` is committed.
5. `session_manager.stop_current_timer()` is called: the SQLite activity timer is stopped.
6. `self.state` is set to `TrackingState.IDLE`.

When the user later resumes via `resume_tracking()`, it forces `self.state = TrackingState.ACTIVE` and resets all window tracking state. The previously finalized screenshot record in Supabase is correct by accident (it was finalized at the moment the user paused), but the intent of the pause is violated — session finalization should only occur when the user is actually done with a task, not when they step away while paused.

### Root Cause — Code Location

`pause_tracking()` (lines 13112–13135): sets `tracking_active = False` but does NOT set `self.state`:

```python
def pause_tracking(self, duration_minutes=None):
    if self.tracking_active:
        self.tracking_active = False       # <-- tracking_active set to False
        self.pause_start_time = time.time()
        # ...
        # self.state is NEVER updated to TrackingState.PAUSED
```

`TrackingState.PAUSED = 3` is defined at line 6388 but assigned nowhere.

`_dbus_idle_poll_worker()` (lines ~12080–12110) — does not check `self.tracking_active`:

```python
while self.running:
    idle_ms = poll_fn()
    idle_secs = idle_ms / 1000.0
    if idle_secs >= current_timeout and not was_idle:
        self.enter_idle("idle timeout")    # <-- called regardless of tracking_active
        was_idle = True
```

`enter_idle()` (line 11784): proceeds to finalize because `self.state == TrackingState.ACTIVE`:

```python
with self.state_lock:
    if self.state == TrackingState.IDLE:
        return False  # already idle
    if self.state == TrackingState.ACTIVE:
        self._finalize_active_session(reason)  # <-- fires while user is merely paused
        self.session_manager.stop_current_timer()
```

### Why the Tracking Loop Does Not Prevent This

The tracking_loop's own idle timeout path also bypasses the paused check:

```python
# Idle timeout (tracking_loop, ~line 12820):
idle_duration = time.time() - self.last_activity_time
if idle_duration > current_idle_timeout:
    if self.state == TrackingState.ACTIVE:
        self.enter_idle("idle timeout")    # <-- same problem from tracking_loop path
```

The `if not self.tracking_active: time.sleep(1); continue` guard (line 12737) short-circuits BEFORE the idle check, so the tracking loop itself does not call `enter_idle()` while paused. Only the D-Bus worker (which runs independently) triggers this incorrectly.

---

## BL-17 — `_get_active_window_linux()` can stall the tracking loop

**Severity:** MEDIUM  
**Platform:** Linux — minimal installs (no GNOME, no xdotool, no python3-gi)  
**Scenario:** Every tracking loop iteration on a system where all 4 detection methods fail

### What Happens

`_get_active_window_linux()` tries four methods in sequence, each invoking a subprocess with a 1–2 second timeout:

| Method | Tool | Timeout |
|--------|------|---------|
| `_from_gdbus` (Wayland primary / X11 fallback) | `gdbus` → `org.gnome.Shell.Eval` | 2s |
| `_from_gnome_introspect` | `gdbus` → `org.gnome.Shell.Introspect.GetWindows` | 2s |
| `_from_xdotool` | `xdotool getactivewindow` + 2 follow-up calls | 3 × 1s = 3s |
| `_from_atspi` (in-process, then subprocess) | `python3 -c <AT-SPI2 code>` | 2s |

On a minimal Debian/Ubuntu install without GNOME Shell, `xdotool`, or `python3-gi`, **all four methods time out**. The total blocking time is ≥ 9 seconds per call.

`get_active_window()` is called on **every iteration** of the tracking loop (line 12875). The loop's sleep is `time.sleep(min(2, min_screenshot_interval))` — i.e., 2 seconds. With a 9-second stall added per iteration, the effective tracking loop frequency drops from 0.5 Hz to ~0.1 Hz (one check every 11 seconds). Window switches that last < 11 seconds are completely missed.

### Root Cause — Code Location

`_get_active_window_linux()` (lines 11064–11306) — no early exit or result caching when all methods fail:

```python
methods = (
    (_from_gdbus, _from_gnome_introspect, _from_xdotool, _from_atspi)
    if is_wayland
    else (_from_xdotool, _from_gdbus, _from_gnome_introspect, _from_atspi)
)
for resolver in methods:
    resolved = resolver()               # each can block for 1–2s
    if resolved:
        ...
        return title, app_name
# Falls through if all fail — but NO caching of "nothing works" result
return 'Unknown', 'Unknown'
```

Each method spawns 1–3 subprocesses with no shared circuit-breaker to skip all subprocess methods after repeated failures. On the next tracking loop iteration (2 seconds later), all 4 methods are attempted again.

### Why There Is No Recovery

- There is no `_active_window_method_failed` flag or exponential back-off to skip methods known to be unavailable on this system.
- `get_active_window()` is called unconditionally before the screenshot decision on every loop iteration (line 12875).
- The result `('Unknown', 'Unknown')` is treated as a valid (if uninformative) response — it is NOT used to skip future detection attempts.

---

## BL-18 — No `SIGTERM` handler on Linux

**Severity:** HIGH  
**Platform:** Linux only  
**Scenario:** Normal process termination via systemd (`systemctl stop`), user logout, desktop session end, or `pkill TimeTracker`

### What Happens

On Linux, the standard graceful termination signal is `SIGTERM` (signal 15). This is sent by:
- `systemctl stop <service>` (if running as a service)
- The desktop session manager at logout (GNOME Session, KDE session, etc.)
- `pkill TimeTracker` / `kill <pid>` (without `-9`)

Python's default `SIGTERM` disposition terminates the interpreter **immediately without calling `atexit` handlers**.

The consequences are identical to B-10 (atexit skipped on abrupt kill):
1. The open `screenshots` record retains `end_time = NULL` and `duration_seconds = NULL` in Supabase indefinitely.
2. All records in `self._pending_idle_records` (Python memory) are lost.
3. The SQLite `active_sessions` table has an unclosed row.
4. Any SQLite queue data accumulated since the last batch upload (up to 5 minutes) is NOT uploaded.

**Unlike B-10 (which covers unrecoverable scenarios — SIGKILL, power cut, BSOD), SIGTERM is a recoverable scenario.** A signal handler CAN be registered to intercept SIGTERM and call `_shutdown_cleanup()` before exiting. This is the standard Linux practice, but it is not implemented.

### Root Cause — Code Location

No `signal.signal(signal.SIGTERM, ...)` call exists anywhere in `desktop_app.py`:

```python
# grep result: 0 matches for signal.signal(
# Only occurrence of "SIGTERM" in the file is in comments:
# line 1147: "terminate_old_version() would send SIGTERM to that parent..."
# line 1227: "# First, try graceful termination (SIGTERM)"
# line 4735: "...by a SIGTERM that arrived while _save_consent was mid-write..."
```

`_shutdown_cleanup()` is registered only via `atexit` (line ~6579):

```python
atexit.register(self._shutdown_cleanup)
```

`atexit` handlers are invoked on clean Python exit (`sys.exit()`, normal script completion, unhandled exception) — **not** on `SIGTERM`.

### Why the B-9 / B-10 Fixes Do Not Cover This

- B-9 (missing `WM_ENDSESSION` handler) covers Windows OS shutdown — irrelevant on Linux.
- B-10 covers `SIGKILL` and power loss — both are truly uninterceptable. `SIGTERM` IS interceptable.
- The 30-second loop-gap fallback in `tracking_loop` (suspension detection) does not help here because the process is terminated, not suspended.

---

## BL-19 — `update_tray_icon()` called from background D-Bus thread

**Severity:** MEDIUM  
**Platform:** Linux only  
**Scenario:** Idle timeout detected by the D-Bus poll worker while tracking is active

### What Happens

`enter_idle()` and `resume_from_idle()` both call `self.update_tray_icon()` at the end of their `state_lock` block. When either function is triggered by the D-Bus idle poll worker (`_dbus_idle_poll_worker`, a daemon thread), `update_tray_icon()` runs on that background thread.

`update_tray_icon()` directly mutates the pystray `Icon` object:

```python
# lines 13471, 13473
self.tray.icon = new_icon          # <-- GTK operation: sets AppIndicator icon
self.tray.title = "TimeTracker - Idle (No Activity Detected)"  # <-- GTK operation
```

On Linux, pystray uses the `AppIndicator3` or `AyatanaAppIndicator3` backend. Both back-ends are GObject wrappers over GTK. GTK is **not thread-safe** — all GObject/GTK mutations must occur on the **GLib main loop thread** (the thread running `Gtk.main()` or the GLib event loop).

Calling `self.tray.icon = new_icon` from a background thread produces:

- `GLib-GObject-WARNING **: gsignal.c: signal 'changed' is invalid for instance ...` logged to stderr
- `Gdk-CRITICAL **: ...` assertion failures
- In rare cases: GTK segfault (abort) or invisible/frozen tray icon

The tray icon may appear stuck in the last valid state or disappear entirely, giving the user no visual feedback that tracking entered or resumed from idle.

### Root Cause — Code Location

`enter_idle()` (lines 11818–11819), called from `_dbus_idle_poll_worker` thread:

```python
with self.state_lock:
    ...
    self.state = TrackingState.IDLE
    self.is_idle = True
    self.update_tray_icon()    # <-- GTK mutation from non-main thread
    self.add_admin_log(...)
    return True
```

`resume_from_idle()` (lines 11857–11858), same issue:

```python
with self.state_lock:
    ...
    self.state = TrackingState.ACTIVE
    self.is_idle = False
    self.needs_idle_resume = False
    self.session_manager.start_new_timer()
    self.update_tray_icon()    # <-- GTK mutation from non-main thread
```

`_dbus_idle_poll_worker()` — the caller (lines ~12080–12096):

```python
# Runs on daemon thread 'idle-dbus-dbus_screensaver'
if idle_secs >= current_timeout and not was_idle:
    self.enter_idle("idle timeout")    # triggers update_tray_icon() on THIS thread
    was_idle = True
elif idle_secs < current_timeout and was_idle:
    self.needs_idle_resume = True      # triggers resume path in tracking_loop
    was_idle = False
```

Note: when `needs_idle_resume = True`, the tracking_loop (main thread) calls `resume_from_idle()`, so that path is safe. The unsafe path is the `enter_idle()` call directly from the D-Bus thread.

### Why GTK Thread Safety Matters Here

pystray's `_appindicator.py` calls `AppIndicator.set_icon_full()` synchronously when `self.tray.icon` is assigned. This is a direct GTK/GObject call with no `GLib.idle_add()` marshalling to the main loop. Calling it from a background thread violates GTK's threading model.

---

## BL-20 — `state_lock` held during HTTP calls in `enter_idle()` and `resume_from_idle()`

**Severity:** MEDIUM  
**Platform:** All  
**Scenario:** Network latency, Supabase timeout, or stale Jira issues cache during idle state transitions

### What Happens

Both `enter_idle()` and `resume_from_idle()` hold `self.state_lock` for the **entire duration** of their execution, which includes HTTP network calls:

**`enter_idle()` → `_finalize_active_session()`:**
```python
with self.state_lock:
    ...
    self._finalize_active_session(reason)   # makes a Supabase UPDATE HTTP call
    self.session_manager.stop_current_timer()
    ...
    self.state = TrackingState.IDLE
```

`_finalize_active_session()` (line 11748) does:
```python
update_result = db_client.table('screenshots').update({...}) \
    .eq('id', self.current_window_screenshot_id).execute()
```

This is a blocking HTTP call. On a 200ms network, this adds 200ms to the lock hold. On a congested or offline network with timeout, this adds up to **60 seconds** (default `httpx` timeout).

**`resume_from_idle()` → `_create_idle_record()` → `get_user_project_key()`:**
```python
with self.state_lock:
    ...
    self._create_idle_record("idle timeout")  # may trigger Jira API call
    ...
    self.session_manager.start_new_timer()
    ...
    self.state = TrackingState.ACTIVE
```

`_create_idle_record()` (line 11943) calls:
```python
project_key = getattr(self, 'idle_project_key', None) or \
              self.current_project_key or \
              self.get_user_project_key()   # <-- may call fetch_jira_issues() HTTP request
```

`get_user_project_key()` calls `fetch_jira_issues()` if the cache is stale — a Jira Cloud REST API call that can take 2–10 seconds.

### Root Cause — Code Location

`enter_idle()` — `state_lock` hold includes `_finalize_active_session()` network call (line ~11784–11820):

```python
with self.state_lock:          # lock acquired
    ...
    self._finalize_active_session(reason)   # HTTP call inside lock
    self.session_manager.stop_current_timer()
    self.idle_start_time = ...
    self.idle_reason = reason
    self.state = TrackingState.IDLE
    self.is_idle = True
    self.update_tray_icon()
    ...
# lock released here
```

`resume_from_idle()` — `state_lock` hold includes `_create_idle_record()` which may hit Jira API (lines ~11823–11870):

```python
with self.state_lock:          # lock acquired
    ...
    self._create_idle_record("idle timeout")   # may call Jira API inside lock
    self.idle_start_time = None
    ...
    self.state = TrackingState.ACTIVE
    ...
    self.update_tray_icon()
# lock released here
```

### Impact on Other Threads

While `state_lock` is held for the duration of a slow HTTP call:

1. **The D-Bus idle poll worker** (trying to call `enter_idle()` or checking `self.state` indirectly) blocks at `with self.state_lock:` for the full duration.
2. **The tracking loop** (trying to call `resume_from_idle()` in response to `needs_idle_resume`) blocks at `with self.state_lock:`.
3. **Window switch detection** in `get_active_window()` is NOT blocked (it doesn't hold `state_lock`), but the downstream `enter_idle()`/`resume_from_idle()` calls triggered by that switch ARE blocked.

If the Supabase call in `_finalize_active_session()` times out (60 seconds), `state_lock` is held for 60 seconds. During this time, no state transition can occur. The user's window switch that triggered the resume from idle is delayed by 60 seconds — the tracking loop is effectively frozen for that duration.

---

## Priority Matrix

| ID | Blocker | Scenario | Data Loss? | Tracking Stops? | Platform | Priority |
|----|---------|----------|-----------|-----------------|----------|----------|
| BL-18 | No SIGTERM handler | systemd stop / logout | YES | YES | Linux | **P1** |
| BL-16 | pause_tracking leaves state=ACTIVE | Idle fires while paused | Possible | No | All | **P1** |
| BL-15 | Screen lock detection GNOME-only | Screen locked on KDE/XFCE | Corrupt data | No | Linux non-GNOME | **P2** |
| BL-20 | state_lock held during HTTP calls | Slow network / Jira API | No | Partially (frozen) | All | **P2** |
| BL-19 | update_tray_icon from D-Bus thread | Idle timeout on Linux | No | No (tray broken) | Linux | **P2** |
| BL-17 | _get_active_window_linux stalls loop | Minimal Linux install | No | Degraded (0.1 Hz) | Linux | **P3** |

---

## Cross-Reference with Existing Blockers

| New ID | Related to | Key Distinction |
|--------|-----------|-----------------|
| BL-15 | B-8 (`_is_screen_locked` always False) | B-8 covers "no Win32" — BL-15 is specifically Linux non-GNOME where Win32 is irrelevant but D-Bus lock detection also fails |
| BL-16 | B-3 (race on `needs_idle_resume`) | B-3 is a data-race on a boolean; BL-16 is a state-machine design bug where PAUSED is never set |
| BL-17 | B-2 (activity monitor thread dies silently) | B-2 is about pynput listener dying; BL-17 is about subprocess blocking in the tracking loop |
| BL-18 | B-9 (no WM_ENDSESSION on Windows), B-10 (atexit skipped) | B-9/B-10 are Windows; BL-18 is Linux-specific and SIGTERM IS interceptable (unlike SIGKILL in B-10) |
| BL-19 | B-3 (cross-thread writes) | B-3 is about `needs_idle_resume` bool; BL-19 is about GTK UI mutations from wrong thread |
| BL-20 | B-12 (no offline fallback in `_finalize_active_session`) | B-12 is about missing retry; BL-20 is about lock contention while waiting for the same call |
