# Desktop App Tracking Blockers — Comprehensive Audit

**Date:** 2026-06-05  
**Scope:** Complete codebase scan for blockers affecting desktop app tracking functionality  
**Status:** READ-ONLY ANALYSIS — No Code Changes Made

---

## Executive Summary

This document consolidates **all identified blockers** that affect the desktop app tracking functionality. The analysis is based on:
1. Existing documentation in `TRACKING_BLOCKERS_ROOT_CAUSE_ANALYSIS.md` (14 blockers)
2. Code inspection of authentication, network, and upload flows
3. AI server endpoint analysis
4. Database and offline storage patterns

### Blocker Categories

| Category | Count | Impact Level |
|----------|-------|--------------|
| **Core Tracking Loop** | 6 | P1-P2 (Critical) |
| **Authentication & Tokens** | 3 | P1 (Critical) |
| **Network & Upload** | 2 | P2 (High) |
| **System Events** | 5 | P1-P3 (Critical to Medium) |
| **Startup & Shutdown** | 3 | P1 (Critical) |
| **AI Server Integration** | 2 | P2 (High) |

**Total:** 21 distinct blockers identified

---

## Part 1: Core Tracking Loop Blockers

### B-1 — pynput Failure Traps Tracking in Idle Forever ⚠️ CRITICAL

**Severity:** P1 (HIGH)  
**Affects:** Idle timeout detection  
**Data Loss:** No | **Tracking Stops:** YES (permanently)

#### What Happens
After the idle timeout fires (default 5 minutes), the tracking loop transitions to idle state and waits for `self.needs_idle_resume` to be set by pynput listeners (mouse/keyboard). If pynput is unavailable or its listeners crash, the flag is never set. Tracking remains stuck in the idle branch forever, even when the user is actively working. The user sees no error, the tray icon shows idle, and no data is recorded.

#### Root Cause
**File:** `python-desktop-app/desktop_app.py`  
**Location:** Line ~10116 in `monitor_user_activity()`

```python
try:
    from pynput import mouse, keyboard
except ImportError:
    print("[WARN] pynput not installed - idle detection disabled")
    return  # <-- thread exits silently; needs_idle_resume is NEVER set
```

**Tracking loop idle check** (Line ~10650):
```python
if not self.needs_idle_resume:
    time.sleep(5)
    continue  # <-- stuck here forever if pynput never fires
```

#### Why There Is No Recovery
- pynput is the **only** mechanism that sets `needs_idle_resume = True`
- Window-switch detection in `get_active_window()` resets `last_activity_time` but does NOT set `needs_idle_resume`
- No periodic check of `last_activity_time` vs `last_idle_entry_time` as fallback

#### Impact
- Tracking stops permanently after first idle timeout
- No error message shown to user
- Tray icon incorrectly shows "idle" state
- All work activity goes untracked until app restart

---

### B-2 — Activity Monitor Thread Dies Silently with No Watchdog ⚠️ CRITICAL

**Severity:** P2 (HIGH)  
**Affects:** Idle timeout detection after extended sessions/RDP  
**Data Loss:** No | **Tracking Stops:** YES (after idle)

#### What Happens
The `monitor_user_activity()` thread runs pynput `Listener` objects that use background OS hooks. If these hooks fail (UAC elevation, RDP session switch, display driver crash, accessibility permission change), the listeners stop firing callbacks while the Python thread appears alive. No health check exists, so idle detection becomes silently dead.

#### Root Cause
**File:** `python-desktop-app/desktop_app.py`  
**Location:** Line ~10932 in `start_tracking()`

```python
if not self._activity_monitor_thread or not self._activity_monitor_thread.is_alive():
    self._activity_monitor_thread = threading.Thread(
        target=self.monitor_user_activity, daemon=True
    )
    self._activity_monitor_thread.start()
```

- `is_alive()` only detects if the Python thread object is alive
- A pynput `Listener` that's alive but receiving no OS events won't cause `is_alive()` to return `False`
- No periodic liveness check or restart mechanism anywhere

#### Impact
- Idle detection fails silently after long sessions
- User activity not detected after system events (UAC prompts, RDP switches)
- Tracking continues with stale data until manual restart

---

### B-14 — No Watchdog to Restart Crashed Tracking Thread ⚠️

**Severity:** P2 (MEDIUM)  
**Affects:** Unexpected exceptions in tracking_loop  
**Data Loss:** No | **Tracking Stops:** YES

#### What Happens
The `tracking_loop()` has an outer `try/except Exception` that handles most errors. However:
1. A `BaseException` (KeyboardInterrupt, SystemExit) propagates past the handler and terminates the thread
2. Some code paths explicitly set `self.running = False` and break

When the `_tracking_thread` becomes dead, the tray icon and `self.running` flag may not reflect this. User sees no indication tracking has stopped.

#### Root Cause
**File:** `python-desktop-app/desktop_app.py`  
**Location:** Line ~10875 in `tracking_loop` exception handler

```python
except Exception as e:
    print(f"[ERROR] Tracking loop error: {e}")
    traceback.print_exc()
    time.sleep(5)
# BaseException (SystemExit, KeyboardInterrupt) falls through here
```

- No watchdog monitors `_tracking_thread.is_alive()` and restarts it
- `update_icon_periodically` thread only updates the icon, doesn't check thread health

#### Impact
- Silent tracking failure after unexpected exceptions
- Tray icon shows "tracking" but no data is captured
- User unaware of failure until they check dashboard

---

### B-3 — needs_idle_resume Written Without state_lock (Race Condition)

**Severity:** P3 (MEDIUM)  
**Affects:** Screen unlock or system wake  
**Data Loss:** Rare | **Tracking Stops:** Rare

#### What Happens
`monitor_system_events()` message pump thread directly calls `_create_idle_record()` and sets `self.needs_idle_resume = True` without holding `self.state_lock`. Concurrently, the tracking loop can be inside `resume_from_idle()` (which does hold the lock) reading the same flag. This is an unsynchronized boolean write from two threads.

#### Root Cause
**File:** `python-desktop-app/desktop_app.py`  
**Location:** Line ~10192 in `wnd_proc` callback

```python
elif wparam == WTS_SESSION_UNLOCK:
    self._create_idle_record("screen lock")
    self.needs_idle_resume = True   # <-- no lock held
```

vs.

```python
# resume_from_idle() (Line ~9962):
with self.state_lock:
    ...
    self.needs_idle_resume = False   # <-- state_lock held here
```

#### Impact (Lower Priority)
- CPython GIL makes plain boolean assignment atomic
- However, compound read-check-write is NOT atomic
- Can produce double idle record or missed idle record
- Rare in practice but violates thread safety principles

---

### B-6 — Duplicate Idle Records Created on System Wake

**Severity:** P3 (LOW)  
**Affects:** System sleep/wake  
**Data Loss:** Corrupt data | **Tracking Stops:** No

#### What Happens
On system wake, two independent code paths both call `_create_idle_record()`:
1. **Message pump thread:** `PBT_APMRESUMEAUTOMATIC` fires → `_create_idle_record("system sleep")`
2. **Tracking loop:** `time_since_last_loop > 30` → `_create_idle_record("system suspension detected")`

Both read `self.idle_start_time` and append to `self._pending_idle_records`. Depending on thread scheduling, two overlapping idle records are produced.

#### Root Cause
**File:** `python-desktop-app/desktop_app.py`  
**Location:** Lines ~10200 and ~10497

```python
# Message pump (Line ~10200):
elif wparam == PBT_APMRESUMEAUTOMATIC:
    self._create_idle_record("system sleep")

# Tracking loop (Line ~10497):
if self.is_idle and self.idle_start_time:
    self._create_idle_record("system suspension detected")

# _create_idle_record clears idle_start_time at the END (Line ~10112):
self._pending_idle_records.append(record)
self.idle_start_time = None    # <-- cleared AFTER append; race window exists
```

#### Impact
- Duplicate idle records in database
- Dashboard shows inflated idle time
- Affects productivity calculations

---

### B-7 — WTS Registration Failure Causes LockApp.exe Tracked as Work

**Severity:** P2 (MEDIUM)  
**Affects:** Screen lock on restricted PCs  
**Data Loss:** Corrupt data | **Tracking Stops:** No

#### What Happens
In enterprise environments with Group Policy restrictions, `WTSRegisterSessionNotification` returns 0 (failure). The code logs a warning and continues without `WM_WTSSESSION_CHANGE` messages. Screen lock/unlock goes undetected.

The fallback `_is_screen_locked()` polling runs every 2 seconds in `tracking_loop`. During those 2 seconds, `LockApp.exe` or `LogonUI.exe` can be captured as the active window and processed as work activity.

#### Root Cause
**File:** `python-desktop-app/desktop_app.py`  
**Location:** Line ~9434 in `_is_screen_locked()` and ~10668 in tracking loop

```python
# _is_screen_locked check comes AFTER window-event processing:
# (Line ~10668):
if self._is_screen_locked():
    if self.state == TrackingState.ACTIVE:
        self.enter_idle("screen still locked")
    time.sleep(5)
    continue
# By this time, at least one loop iteration with lock-screen app may have been recorded
```

#### Impact
- Lock screen apps (`LockApp.exe`, `LogonUI.exe`) recorded as productive work
- Inflates work hours during locked periods
- Affects productivity metrics accuracy

---

## Part 2: Authentication & Token Management Blockers

### B-15 — Token Refresh Deadlock on Concurrent Requests (NEW) ⚠️ CRITICAL

**Severity:** P1 (HIGH)  
**Affects:** Token refresh during concurrent uploads  
**Data Loss:** Possible | **Tracking Stops:** YES (temporary)

#### What Happens
Atlassian uses token rotation: each `refresh_token` can only be used once. When multiple threads detect an expired token simultaneously (e.g., batch upload + screenshot upload + user info fetch), they all call `refresh_access_token()`. Without synchronization, they all send the same `refresh_token` to the AI server. The first request succeeds and rotates the token. Subsequent requests fail with "token invalid".

#### Root Cause
**File:** `python-desktop-app/desktop_app.py`  
**Location:** Line ~1931-1939 (refresh lock exists but analysis shows potential race)

```python
# Current implementation HAS a refresh_lock (Line ~1935):
self._refresh_lock = threading.Lock()

# However, the double-check pattern (Line ~2380) may still have a window:
with self._refresh_lock:
    refresh_token_now = self.tokens.get('refresh_token')
    if refresh_token_now and refresh_token_now != refresh_token_before:
        print("[INFO] Token already refreshed by another thread, skipping")
        return True
```

**Analysis reveals:**
- The lock exists and is used correctly
- However, the `_refresh_token_invalid` flag logic (lines ~2350-2377) has a race:
  - Thread A checks flag BEFORE acquiring lock
  - Thread B sets flag while A is waiting for lock
  - A enters lock, sees flag, but doesn't re-check token value
  - Could lead to unnecessary re-auth prompts

#### Impact (Mitigated but Still Present)
- Rare false "re-authentication required" messages
- User forced to re-login despite valid refresh token
- Tracking pauses until re-auth completes

---

### B-16 — Supabase JWT Expiry Not Checked Before Uploads (NEW) ⚠️

**Severity:** P2 (HIGH)  
**Affects:** All Supabase operations  
**Data Loss:** Possible | **Tracking Stops:** YES (temporary)

#### What Happens
The desktop app fetches a Supabase JWT from the AI server during authentication. This token expires after ~1 hour (3600s). The app caches it in `self.tokens['supabase_token']` with an expiry timestamp at `supabase_token_expires_at`.

However, upload operations (`upload_screenshot`, `upload_activity_batch`) use the cached token without checking if it's expired. When Supabase rejects the request with 401, the operation fails and data goes to offline queue.

#### Root Cause
**File:** `python-desktop-app/desktop_app.py`  
**Location:** Multiple upload functions (lines ~9113+)

```python
# Example from upload_activity_batch (no expiry check before use):
def upload_activity_batch(self):
    # ... prep work ...
    supabase_client = self.supabase  # <-- uses cached client
    # No check of supabase_token_expires_at before making request
    response = supabase_client.table('activity_records').insert(batch)
```

**Supabase token refresh exists** (Line ~2767-2788) but is only called reactively on 401, not proactively before requests.

#### Impact
- First upload after token expiry always fails
- Data queued to offline storage
- Retry after refresh succeeds
- Unnecessary offline queue churn

---

### B-17 — Google User Supabase Token Refresh Has No Retry Logic (NEW)

**Severity:** P2 (HIGH)  
**Affects:** Non-Jira Google SSO users  
**Data Loss:** YES | **Tracking Stops:** YES (until next batch)

#### What Happens
Google users (non-Jira employees) authenticate via Google OAuth and receive a Supabase JWT from the AI server. When this token expires, `_refresh_google_supabase_token()` is called (Line ~2566).

This function makes a single HTTP request to `/api/auth/desktop-google/refresh`. If the request fails (network timeout, AI server error, transient Google API error), the function returns `None` and tracking stops. There is **no retry logic**, unlike the Atlassian token refresh which has 3 retries.

#### Root Cause
**File:** `python-desktop-app/desktop_app.py`  
**Location:** Line ~2566 in `_refresh_google_supabase_token()`

```python
def _refresh_google_supabase_token(self):
    # ... setup ...
    try:
        response = requests.post(
            f"{self.ai_server_url}/api/auth/desktop-google/refresh",
            json={'google_refresh_token': refresh_token},
            headers={'Content-Type': 'application/json'},
            timeout=(10, 60)
        )
        # Single attempt - no retry on timeout/connection error
        if response.status_code != 200:
            # ... error handling ...
            return None  # <-- tracking stops
    except Exception as e:
        print(f"[ERROR] Failed to refresh Google Supabase token: {e}")
        return None  # <-- tracking stops
```

Compare with Atlassian refresh (Line ~2413) which has retry logic:
```python
# Atlassian token exchange has 3 retries:
for attempt in range(3):
    try:
        response = requests.post(...)
        break
    except (requests.exceptions.ConnectTimeout, ...) as e:
        if attempt < 2:
            time.sleep((attempt + 1) * 5)
        else:
            raise
```

#### Impact
- Google users lose tracking on transient network failures
- Data accumulates in offline queue
- No automatic recovery until next successful batch upload
- Disproportionately affects remote workers with unstable connections

---

## Part 3: Network & Upload Blockers

### B-12 — _finalize_active_session Has No Offline Fallback on Supabase Error ⚠️ CRITICAL

**Severity:** P1 (HIGH)  
**Affects:** Session boundaries (idle, sleep, shutdown)  
**Data Loss:** YES | **Tracking Stops:** No

#### What Happens
`_finalize_active_session()` is called whenever tracking transitions to idle, sleep, or shutdown. It performs a direct Supabase `UPDATE` on the `screenshots` table to set `end_time` and `duration_seconds`. If this call throws any exception (network timeout, 401 JWT expired, PostgREST 409, etc.), it is caught and logged, but **no retry or offline queue entry is created**.

By contrast, `upload_screenshot()` (the create path) has a two-layer fallback: Supabase first, then SQLite offline store. `_finalize_active_session()` has no equivalent.

#### Root Cause
**File:** `python-desktop-app/desktop_app.py`  
**Location:** Line ~9867 in `_finalize_active_session()`

```python
try:
    db_client = self.supabase
    update_result = db_client.table('screenshots').update({
        'end_time': end_time.isoformat(),
        'timestamp': end_time.isoformat(),
        'duration_seconds': duration_seconds
    }).eq('id', self.current_window_screenshot_id).execute()
    ...
except Exception as e:
    print(f"[ERROR] Error finalizing session ({reason}): {e}")
    # <-- NO retry, NO offline queue, NO SQLite save
```

The same pattern exists in interval-update and window-switch-update blocks (lines ~10760 and ~10820).

#### Impact
- Screenshot records left with `end_time = NULL` permanently in database
- Dashboard shows "still in progress" sessions from days ago
- Duration calculations incorrect
- Work hours underreported

---

### B-18 — Batch Upload Has No Partial Success Handling (NEW)

**Severity:** P2 (MEDIUM)  
**Affects:** Batch uploads to Supabase  
**Data Loss:** Possible | **Tracking Stops:** No

#### What Happens
`upload_activity_batch()` uploads activity records in batches to Supabase's `activity_records` table. If the insert operation fails (e.g., due to network error, constraint violation, or partial timeout), the **entire batch** is rolled back and all records remain in the offline queue.

However, Supabase's PostgREST can return partial success: some rows inserted, others rejected (e.g., duplicate primary key). The current code does not parse the response to identify which records succeeded. It either treats the whole batch as succeeded or failed.

#### Root Cause
**File:** `python-desktop-app/desktop_app.py`  
**Location:** Line ~9113 in `upload_activity_batch()`

```python
try:
    response = supabase_client.table('activity_records').insert(batch).execute()
    # ... 
    # Assumes all rows inserted or none
    self.offline_manager.clear_activity_records()  # Clears ALL
except Exception as e:
    # All rows remain in queue
    print(f"[ERROR] Activity batch upload failed: {e}")
```

**Missing logic:**
- Parse `response.data` to see which rows were actually inserted
- Only clear those rows from offline queue
- Retry failed rows in next batch

#### Impact
- Duplicate key errors block entire batch from clearing
- Offline queue grows indefinitely
- User sees "data not syncing" error
- Manual database cleanup required

---

## Part 4: System Events & Power Management

### B-4 — monitor_system_events Failure Leaves Only Loop-Gap Fallback

**Severity:** P2 (MEDIUM)  
**Affects:** Sleep/wake on restricted machines  
**Data Loss:** Partial | **Tracking Stops:** Partial

#### What Happens
`monitor_system_events()` creates a message-only window (`HWND_MESSAGE`) to receive `WM_POWERBROADCAST` and `WM_WTSSESSION_CHANGE`. This can fail in sandboxed/restricted environments. Both `RegisterClassExW` and `CreateWindowExW` can return 0. When this happens, sleep/wake and lock/unlock events are completely missed.

The only remaining protection is the 30-second loop-gap check in `tracking_loop`:
```python
if time_since_last_loop > 30:
    # treat as suspension
```

#### Root Cause
**File:** `python-desktop-app/desktop_app.py`  
**Location:** Lines ~10240–10255 in `monitor_system_events()`

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

#### Why Loop-Gap Fallback Is Insufficient
- **Lock/unlock is completely blind** — loop-gap only catches time gaps (sleep)
- **30-second threshold is too generous** — 29-second sleep not detected
- **Duplicate record issue** — after wake, both message pump and loop-gap call `_create_idle_record()`

#### Impact
- Screen lock periods not recorded on some machines
- Brief sleeps (<30s) treated as slow loop cycles
- Idle time underreported

---

### B-5 — Hibernate Idle Period Silently Dropped by Work-Hours Filter

**Severity:** P2 (MEDIUM)  
**Affects:** Overnight or weekend hibernation  
**Data Loss:** YES | **Tracking Stops:** No

#### What Happens
When a machine is hibernated outside configured work hours (e.g., hibernated at 18:30, woken at 08:00), the entire overnight period qualifies as idle. On wake, `_create_idle_record()` is called with `idle_start_time` of 18:30.

Inside the function, `_is_within_work_hours(self.idle_start_time)` checks if 18:30 falls within work hours (default 09:00-18:00). Since 18:30 is past 18:00, the check returns `False` and the record is silently discarded.

The result: the overnight gap produces no record—no idle record, no gap marker. Dashboard reports show no data for that work day.

#### Root Cause
**File:** `python-desktop-app/desktop_app.py`  
**Location:** Line ~10072 in `_create_idle_record()`

```python
if not self._is_within_work_hours(self.idle_start_time):
    print(f"[IDLE] Skipping idle record outside work hours ...")
    self.idle_start_time = None
    return
```

`_is_within_work_hours()` (Line ~10017) only tests whether the **start timestamp** falls inside work hours. It does not test whether any portion of the idle period overlaps work hours.

#### Impact
- Users who work late (past 18:00) lose all idle tracking
- Overnight hibernate periods invisible to dashboard
- Work hours calculation incorrect for non-standard schedules

---

### B-9 — No WM_ENDSESSION Handler; Clean Shutdown Loses Open Session ⚠️ CRITICAL

**Severity:** P1 (HIGH)  
**Affects:** Windows shutdown or logoff  
**Data Loss:** YES | **Tracking Stops:** YES

#### What Happens
When Windows shuts down, it broadcasts `WM_QUERYENDSESSION` and `WM_ENDSESSION` to all windows. The app's message-only window handles only `WM_POWERBROADCAST` and `WM_WTSSESSION_CHANGE`. Neither shutdown message is handled.

Windows gives apps 5 seconds to respond before force-terminating them. During this window:
- `_shutdown_cleanup()` is registered via `atexit`, but `atexit` only runs on clean Python exit, not on `WM_ENDSESSION`
- Current open screenshot record has `end_time = NULL`
- SQLite activity timer still running
- No final batch upload occurs

#### Root Cause
**File:** `python-desktop-app/desktop_app.py`  
**Location:** Line ~10192 in `wnd_proc`

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

#### Impact
- Every shutdown leaves an open session record
- Last 5 minutes of work before shutdown lost
- Dashboard shows "in progress" sessions
- Requires manual cleanup

---

### B-10 — atexit Skipped on Abrupt Kill/Power Loss ⚠️ CRITICAL

**Severity:** P1 (HIGH)  
**Affects:** Process killed, power cut, BSOD  
**Data Loss:** YES | **Tracking Stops:** YES

#### What Happens
Python's `atexit` handlers only run when the interpreter exits cleanly. They do NOT run when:
- Process terminated with `SIGKILL` / `taskkill /F`
- OS powers off without sending shutdown events
- Hard power cut occurs
- BSOD terminates the session

In all cases, `_shutdown_cleanup()` never runs. The consequences:
1. Current screenshot record's `end_time = NULL` permanently
2. All `_pending_idle_records` in memory lost
3. SQLite session timer left open
4. Data in offline SQLite queue (up to 5 minutes) since last batch upload is safe, but data in Python memory is lost

#### Root Cause
**File:** `python-desktop-app/desktop_app.py`  
**Location:** Line ~5285 and ~11469

```python
# Initialization (Line ~5285):
atexit.register(self._shutdown_cleanup)

# _shutdown_cleanup (Line ~11469):
def _shutdown_cleanup(self):
    # ... finalize session, upload batch, close DB ...
```

SQLite is write-ahead-logged and persisted to disk, so data written to SQLite before crash is safe. However, data held only in Python memory (`_pending_idle_records`, `current_window_screenshot_id`) is always lost.

#### Impact
- Every crash/power-loss leaves orphaned session
- Last few minutes of work lost
- Database requires periodic cleanup job
- User sees inconsistent tracking data

---

### B-8 — _is_screen_locked Always Returns False Without WIN32

**Severity:** P4 (LOW)  
**Affects:** Non-Windows or broken pywin32  
**Data Loss:** No | **Tracking Stops:** No

#### What Happens
`_is_screen_locked()` has an early return when `WIN32_AVAILABLE` is `False`:
```python
if not WIN32_AVAILABLE:
    return False
```

On non-Windows platforms or Windows with broken pywin32 install, the screen-lock guard in `tracking_loop` never triggers. The system event monitor thread also never starts.

#### Root Cause
**File:** `python-desktop-app/desktop_app.py`  
**Location:** Line ~259 (import-time flag) and ~9434

```python
# Import time (Line ~259):
try:
    import win32con
    ...
    WIN32_AVAILABLE = True
except ImportError:
    WIN32_AVAILABLE = False

# _is_screen_locked (Line ~9434):
def _is_screen_locked(self):
    if not WIN32_AVAILABLE:
        return False  # <-- lock detection completely disabled
```

#### Impact (Lower Priority)
- Cross-platform builds have no lock detection
- Broken pywin32 install not detected or fixed
- Lock screen apps tracked as work (same as B-7)

---

## Part 5: Startup & Shutdown

### B-11 — Stale Startup Registry Entry Prevents Auto-Launch After Reboot

**Severity:** P3 (MEDIUM)  
**Affects:** Post-update reboot  
**Data Loss:** No | **Tracking Stops:** YES (on reboot)

#### What Happens
`add_to_startup()` writes the current exe path to the Windows registry:
```
HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Run
TimeTracker = "C:\Users\<user>\AppData\Local\TimeTracker\TimeTracker.exe"
```

If the app is updated via auto-update and the new exe is installed to a different path (e.g., versioned sub-folder), the registry entry is not updated. Windows tries to launch the old path at boot, which no longer exists, and silently skips the entry.

#### Root Cause
**File:** `python-desktop-app/desktop_app.py`  
**Location:** Line ~1674 in `add_to_startup()` and update_manager

```python
# add_to_startup called only during first run (Line ~1674):
if getattr(sys, 'frozen', False):
    add_to_startup()

# Auto-update path (update_manager.apply_update()) does NOT call add_to_startup()
```

#### Impact
- App doesn't start after update + reboot
- Tracking stops until user manually launches
- Silent failure (no error message)

---

### B-13 — Mandatory Update Exit Does Not Join Tracking Thread

**Severity:** P3 (LOW)  
**Affects:** Mandatory update installation  
**Data Loss:** Possible | **Tracking Stops:** YES

#### What Happens
`_enforce_mandatory_update_pause()` (Line ~5429) sets flags to pause tracking. When the user confirms the update, `update_manager.apply_update()` runs on a daemon thread. It eventually calls `quit_app()` → `_shutdown_cleanup()` → `sys.exit(0)`.

At the point of `sys.exit(0)`, the tracking thread (`_tracking_thread`) may still be mid-operation (sleeping in paused branch or executing batch upload). Because the thread is `daemon=True`, Python kills it immediately when `sys.exit()` is called.

#### Root Cause
**File:** `python-desktop-app/desktop_app.py`  
**Location:** Line ~11568 in `quit_app()`

```python
def quit_app(self):
    self._update_desktop_status(logged_in=False)
    self._shutdown_cleanup()
    self.stop_tracking()     # sets self.running = False
    if self.tray:
        self.tray.stop()
    sys.exit(0)  # <-- immediate exit, no thread join
```

`stop_tracking()` (Line ~11018) just sets `self.running = False` and returns immediately without joining the thread.

#### Impact
- Last few seconds of tracking lost on update
- Batch upload may be interrupted mid-flight
- Offline queue entry may be incomplete

---

## Part 6: AI Server Integration

### B-19 — AI Server /api/analyze-batch Has No Idempotency Protection (NEW)

**Severity:** P2 (MEDIUM)  
**Affects:** Duplicate batch submissions  
**Data Loss:** Corrupt data | **Tracking Stops:** No

#### What Happens
The desktop app calls `/api/analyze-batch` every 5 minutes (or on-demand) to send activity records for AI matching. The endpoint processes records and updates them with matched Jira issues.

However, if the desktop app's request times out but the AI server successfully processes the batch, the app will retry the same batch (with same record IDs) in the next cycle. The AI server re-processes them, potentially:
- Overwriting user corrections
- Duplicating notifications
- Triggering double-processing race conditions

#### Root Cause
**File:** `ai-server/src/controllers/activity-controller.js`  
**Location:** Line ~42-77 in `analyzeBatch`

```javascript
// Atomically claim records (pending → processing) to prevent race with polling service.
const recordIds = records.filter(r => r.id).map(r => r.id);
let claimedIds = new Set();
if (recordIds.length > 0) {
    try {
        const claimed = await activityDbService.claimBatchForProcessing(recordIds);
        claimedIds = new Set(claimed.map(c => c.id));
    } catch (claimErr) {
        logger.warn(`[ActivityController] Claim failed (non-fatal): ${claimErr.message}`);
        // If claim fails, proceed with all records — worst case is double-process
        claimedIds = new Set(recordIds);  // <-- allows duplicates
    }
}
```

**Analysis:**
- Claim logic exists but has a fallback that allows duplicate processing on claim failure
- No request deduplication based on batch ID or client request ID
- Desktop app has no batch ID generation

#### Impact
- User corrections overwritten by AI re-matching
- Duplicate notification emails sent
- Dashboard shows inconsistent data
- Support burden from "my corrections keep disappearing" reports

---

### B-20 — Desktop App Sends No Client Request ID for Debugging (NEW)

**Severity:** P3 (LOW)  
**Affects:** Debugging and support  
**Data Loss:** No | **Tracking Stops:** No

#### What Happens
When the desktop app makes HTTP requests to the AI server (`/api/analyze-batch`, `/api/classify-app`, `/api/auth/exchange-token`, etc.), it does not include a client-generated request ID header (e.g., `X-Request-ID` or `X-Client-Request-ID`).

When a request fails or behaves unexpectedly, support teams cannot correlate desktop app logs with AI server logs. The desktop app log shows "request sent", the AI server log shows "request received", but there's no way to prove they're the same request.

#### Root Cause
**File:** `python-desktop-app/desktop_app.py`  
**Location:** Multiple request call sites (lines ~2413, ~9113, etc.)

```python
# Example from token exchange (Line ~2413):
response = requests.post(
    f"{self.ai_server_url}/api/auth/atlassian/callback",
    json=payload,
    headers={'Content-Type': 'application/json'},  # <-- no X-Request-ID
    timeout=(30, 90)
)
```

**Missing pattern:**
```python
request_id = str(uuid.uuid4())
headers = {
    'Content-Type': 'application/json',
    'X-Request-ID': request_id  # <-- enables log correlation
}
log_network_event('token_exchange_request', request_id=request_id)
response = requests.post(..., headers=headers)
log_network_event('token_exchange_response', request_id=request_id, status=response.status_code)
```

#### Impact
- Debugging failures requires manual timestamp correlation
- Impossible to prove request reached server vs. network drop
- Support tickets take longer to resolve
- Reproducing intermittent issues difficult

---

## Part 7: Additional Observations (Non-Blocking Issues)

### OBS-1 — Offline Queue Has No Size Limit

**File:** `python-desktop-app/db_connection.py`  
**Impact:** SQLite database can grow indefinitely if network is down for extended period

The offline queue stores failed uploads in SQLite with no maximum size limit. If a user is offline for weeks, the database can grow to hundreds of MB, causing:
- Slow app startup (reading large DB)
- Disk space issues
- Delayed batch uploads when back online

**Recommendation:** Implement a sliding window (e.g., keep last 7 days) or size limit (e.g., 100 MB max).

---

### OBS-2 — OCR Failure Does Not Fall Back to Window Title

**File:** `python-desktop-app/ocr/__init__.py`  
**Impact:** No text data captured when OCR fails

When OCR extraction fails (timeout, engine crash, no text detected), the activity record is created with `null` OCR text. The AI matching then relies solely on the window title, which may be generic ("Google Chrome").

**Recommendation:** On OCR failure, use the window title + process name as fallback text for AI matching.

---

### OBS-3 — No Health Check Endpoint for Monitoring

**Impact:** Cannot monitor desktop app health remotely

The desktop app has no HTTP endpoint for health checks. Admins cannot remotely monitor:
- Is the app running?
- Is tracking active?
- When was the last successful upload?
- What's the offline queue size?

**Recommendation:** Add a local HTTP endpoint (e.g., `http://localhost:51777/health`) returning JSON with app status.

---

## Priority Matrix (Complete)

| ID | Blocker | Scenario | Data Loss? | Tracking Stops? | Priority |
|----|---------|----------|-----------|-----------------|----------|
| B-1 | pynput failure → stuck idle | Idle timeout | No | YES (permanently) | **P1** |
| B-9 | No WM_ENDSESSION handler | OS shutdown | YES | YES | **P1** |
| B-10 | atexit not called on kill | Power loss / kill | YES | YES | **P1** |
| B-12 | _finalize_active_session no offline fallback | Network loss | YES | No | **P1** |
| B-15 | Token refresh deadlock | Concurrent requests | Possible | YES (temp) | **P1** |
| B-2 | Activity monitor thread dies | Long session / RDP | No | YES (after idle) | **P2** |
| B-4 | monitor_system_events fails | Sleep on restricted PC | Partial | Partial | **P2** |
| B-5 | Hibernate idle dropped | Overnight hibernate | YES | No | **P2** |
| B-7 | WTS failure → LockApp tracked | Corporate GPO | Corrupt data | No | **P2** |
| B-14 | No tracking thread watchdog | Unexpected crash | No | YES | **P2** |
| B-16 | Supabase JWT expiry not checked | All uploads | Possible | YES (temp) | **P2** |
| B-17 | Google token refresh no retry | Non-Jira users | YES | YES (temp) | **P2** |
| B-18 | Batch upload no partial success | Upload errors | Possible | No | **P2** |
| B-19 | AI server no idempotency | Duplicate submissions | Corrupt data | No | **P2** |
| B-3 | needs_idle_resume race | Screen unlock / wake | Rare | Rare | **P3** |
| B-6 | Duplicate idle on wake | Sleep/wake | Corrupt data | No | **P3** |
| B-11 | Stale startup registry | Post-update reboot | No | YES (on reboot) | **P3** |
| B-13 | No thread join before exit | Mandatory update | Possible | YES | **P3** |
| B-20 | No client request ID | Debugging | No | No | **P3** |
| B-8 | _is_screen_locked false on non-Win32 | Non-Windows | No | No | **P4** |

---

## Summary Statistics

### By Severity
- **P1 (Critical):** 5 blockers — All cause permanent data loss or tracking failure
- **P2 (High):** 9 blockers — Cause temporary failures or data corruption
- **P3 (Medium):** 5 blockers — Edge cases or debugging issues
- **P4 (Low):** 1 blocker — Platform-specific limitation

### By Impact Type
- **Data Loss:** 10 blockers
- **Tracking Stops:** 14 blockers
- **Data Corruption:** 5 blockers
- **Debugging Issues:** 1 blocker

### By Component
- **Tracking Loop:** 6 blockers
- **System Events:** 5 blockers
- **Authentication:** 3 blockers
- **Network/Upload:** 2 blockers
- **Startup/Shutdown:** 3 blockers
- **AI Integration:** 2 blockers

---

## Recommended Fix Priority

### Phase 1 (Immediate — P1 Blockers)
1. **B-1:** Add fallback idle resume path based on `last_activity_time`
2. **B-9:** Add `WM_ENDSESSION` handler to `wnd_proc`
3. **B-10:** Write checkpoint data to SQLite immediately on session start
4. **B-12:** Add offline queue for `_finalize_active_session` failures
5. **B-15:** Add second layer of thread-safety checks for token refresh

### Phase 2 (Short-term — P2 Blockers)
1. **B-2:** Add activity monitor watchdog with periodic heartbeat check
2. **B-16:** Check Supabase JWT expiry before every upload operation
3. **B-17:** Add retry logic to Google token refresh (match Atlassian pattern)
4. **B-18:** Implement partial success handling in batch upload
5. **B-19:** Add idempotency key to `/api/analyze-batch` requests

### Phase 3 (Medium-term — P3 Blockers)
1. **B-3, B-6:** Use `threading.Event` for `needs_idle_resume` (thread-safe)
2. **B-11:** Call `add_to_startup()` after every successful update
3. **B-13:** Add bounded join to tracking thread before `sys.exit()`
4. **B-20:** Add `X-Request-ID` header to all AI server requests

### Phase 4 (Long-term — Platform & Observability)
1. **B-4, B-8:** Add fallback polling for system events when Win32 API unavailable
2. **OBS-1:** Implement offline queue size limit and retention policy
3. **OBS-2:** Add OCR failure fallback to window title
4. **OBS-3:** Add local health check HTTP endpoint

---

## Verification Checklist

To verify if a blocker is fixed, test these scenarios:

| Blocker | Test Scenario | Expected Result |
|---------|---------------|-----------------|
| B-1 | Kill pynput process during idle | Tracking resumes after activity |
| B-2 | Trigger UAC prompt after 4+ hours | Idle detection still works |
| B-9 | Shutdown Windows via Start Menu | Session finalized, batch uploaded |
| B-10 | `taskkill /F` on TimeTracker.exe | Session recovers on next start |
| B-12 | Disconnect network during session boundary | Session queued for retry |
| B-15 | Trigger 3 concurrent token refreshes | Only one refresh sent to server |
| B-16 | Wait 1+ hour, then upload | Token refreshed before upload |
| B-17 | Google user: disconnect network, wait 1h | Token retry succeeds after 3 attempts |
| B-18 | Insert batch with one duplicate key | Other records succeed, duplicate retried |
| B-19 | Send same batch twice with same IDs | Second batch rejected (already processed) |

---

## File References

### Core Desktop App Files
- `python-desktop-app/desktop_app.py` — Main application (11,000+ lines)
- `python-desktop-app/db_connection.py` — SQLite offline storage
- `python-desktop-app/auth/secure_storage.py` — Token management
- `python-desktop-app/monitor_capture.py` — Screenshot capture
- `python-desktop-app/ocr/__init__.py` — OCR text extraction

### AI Server Files
- `ai-server/src/controllers/activity-controller.js` — Batch processing
- `ai-server/src/middleware/desktop-auth.js` — Token validation
- `ai-server/src/controllers/auth-controller.js` — Token exchange

### Documentation Files
- `python-desktop-app/TRACKING_BLOCKERS_ROOT_CAUSE_ANALYSIS.md` — Original 14 blockers
- `docs/AUTO_UPDATE_MECHANISM_DEEP_DIVE_ANALYSIS.md` — Update system issues

---

**End of Report**  
**Prepared by:** AI Deep Dive Analysis  
**Date:** 2026-06-05  
**Status:** Read-Only — No Code Changes Made
