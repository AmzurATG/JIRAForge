# Fix: LockApp.exe Tracked as Active Work Time Overnight

## Context

The time-tracking desktop agent records `LockApp.exe` (Windows lock screen) as an active work session spanning the entire overnight period (~1:20 AM to ~10:56 AM = 8h 31m). This inflates "Time Spent Today" from the actual ~1h 8m to ~8h 45m and renders a continuous green bar on the timeline from 1am to 11am.

**Root cause chain:** When the PC briefly wakes from sleep at ~1:20 AM (Windows Update, etc.), the suspension detection handler at line 9286 resets `is_idle = False` and `last_activity_time = now` without checking if the screen is still locked. The next loop iteration picks up `LockApp.exe` as a "new window" and starts a SQLite session timer. The PC goes back to sleep but the timer's `timer_started_at` timestamp sits there until the user unlocks at ~10:56 AM, accumulating ~9.5 hours of wall-clock time.

---

## Fixes (3 layers of defense)

### Fix 1: Prevent LockApp sessions from starting (Primary — Desktop App)

**File:** `python-desktop-app/desktop_app.py`

#### 1a. Add a lock-screen app constant (~line 3496, near BROWSER_PROCESSES)

```python
LOCK_SCREEN_APPS = {'lockapp.exe', 'logonui.exe'}
```

#### 1b. Add `_is_screen_locked()` helper (new method, near `get_active_window` ~line 8380)

```python
def _is_screen_locked(self):
    """Check if the screen is currently locked by inspecting the foreground window."""
    try:
        hwnd = win32gui.GetForegroundWindow()
        _, pid = win32process.GetWindowThreadProcessId(hwnd)
        process = psutil.Process(pid)
        return process.name().lower() in LOCK_SCREEN_APPS
    except Exception:
        return False
```

#### 1c. Guard the suspension detection handler (lines 9286-9321)

At line 9305, before resetting `is_idle = False`, add a lock-state check:

```python
# After uploading and finalizing, check if screen is still locked
if self._is_screen_locked():
    # Screen is still locked — stay in idle mode, don't start tracking LockApp
    self.is_idle = True
    self.idle_start_time = datetime.fromtimestamp(self.last_activity_time, tz=timezone.utc)
    self.idle_project_key = self.current_project_key
    last_loop_time = current_loop_time
    continue
# Only set is_idle = False if screen is actually unlocked
self.is_idle = False
self.needs_idle_resume = False
# ... rest of existing reset code ...
```

#### 1d. Guard the main tracking loop (line 9479, after idle resume)

After the idle resume block at line 9476, before `get_active_window()` is called, add:

```python
# Skip tracking if screen is locked (e.g., PC woke briefly from sleep)
if self._is_screen_locked():
    if not self.is_idle:
        self._finalize_active_session("screen still locked")
        self.session_manager.stop_current_timer()
        self.idle_start_time = datetime.fromtimestamp(self.last_activity_time, tz=timezone.utc)
        self.idle_project_key = self.current_project_key
        self.is_idle = True
        self.update_tray_icon()
    time.sleep(5)
    continue
```

#### 1e. Guard `process_window_event` (line 8036, at the top)

Early return if the app is a lock screen app — don't even create a session:

```python
# Never track lock screen apps as active sessions
if app_name.lower() in LOCK_SCREEN_APPS:
    print(f"[SKIP] Lock screen app detected: {app_name}")
    return
```

---

### Fix 2: Mark lock-screen records as idle in upload path (Defense — Desktop App)

**File:** `python-desktop-app/desktop_app.py`

#### 2a. Add `is_idle` to the record dict (line 7725)

In the record dict built at line 7725, detect lock screen apps and set `is_idle`:

```python
app_name_lower = s.get('application_name', '').lower()
is_lock_screen = app_name_lower in LOCK_SCREEN_APPS

record = {
    # ... existing fields ...
    'is_idle': is_lock_screen,  # Mark lock screen apps as idle
    'classification': 'idle' if is_lock_screen else classification,
    # ... rest of existing fields ...
}
```

Also set `status` to `'analyzed'` for lock screen records (they don't need AI analysis):

```python
if is_lock_screen:
    status = 'analyzed'
```

---

### Fix 3: Exclude idle records from summary views (Defense — SQL)

**File:** New migration `supabase/migrations/20260417_exclude_idle_from_summaries.sql`

Recreate the `daily_time_summary`, `weekly_time_summary`, and `monthly_time_summary` views with an additional filter on the activity_records subquery:

```sql
WHERE act.status IN ('pending', 'processing', 'analyzed')
  AND act.work_date IS NOT NULL
  AND COALESCE(act.is_idle, false) = false        -- NEW: exclude idle records
  AND act.application_name NOT IN ('LockApp.exe', 'LogonUI.exe')  -- NEW: exclude lock screen
```

The views need to be dropped and recreated (same pattern as `20260323_fix_summary_view_filters.sql`).

---

## Files modified

| File | Change |
|------|--------|
| `python-desktop-app/desktop_app.py` | Add `LOCK_SCREEN_APPS` constant, `_is_screen_locked()` helper, guards in suspension handler + main loop + `process_window_event`, `is_idle` in upload record dict |
| `supabase/migrations/20260417_exclude_idle_from_summaries.sql` | New migration: recreate summary views with idle exclusion filter |

## Files NOT modified (no changes needed)

| File | Reason |
|------|--------|
| `forge-app/src/services/analytics/teamAnalyticsService.js` | Already correctly splits records by `is_idle` at line 766 — will work once DB data is correct |
| `ai-server/src/services/clustering-service.js` | Already has `SYSTEM_APPS` list with `'lockapp'` — used for clustering, not for this bug |
| `ai-server/src/controllers/forge-proxy-controller.js` | The activity query at line 1006 filters `classification IN ['productive', 'unknown']` which already excludes `non_productive` — not the source of the timeline bug |

---

## Verification

1. **Unit test the `_is_screen_locked()` helper** — mock `GetForegroundWindow` to return LockApp.exe and verify it returns True
2. **Test the suspension handler** — simulate a system wake while screen is locked and verify `is_idle` stays True
3. **Test `process_window_event`** — pass `LockApp.exe` as app_name and verify it returns early without creating a session
4. **Test the upload path** — create a mock session with `application_name: 'LockApp.exe'` and verify the uploaded record has `is_idle: true` and `classification: 'idle'`
5. **Apply the SQL migration** and query `daily_time_summary` — verify LockApp records are excluded from totals
6. **End-to-end**: Lock the PC, wait, unlock, and check the timeline — should show idle gap, not a work bar
