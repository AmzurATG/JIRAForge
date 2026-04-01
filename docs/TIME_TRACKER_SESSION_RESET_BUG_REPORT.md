# Time Tracker Session Reset — Bug Report & Fix Plan

**Date:** April 1, 2026  
**Severity:** Critical  
**Component:** Desktop App → Batch Upload Pipeline (`python-desktop-app/desktop_app.py`)  
**Affected Feature:** Time Analytics Dashboard (Time Spent Today / Week / Month)

---

## Symptom Summary

| Symptom | Description |
|---------|-------------|
| Session indicator turns red | Tracking session stops/resets without user action |
| Dashboard shows 0s | Time Spent Today / Week / Month all display "0s" despite active work |
| Hours not captured | Logged hours are silently lost between the desktop app and Supabase |
| Automatic stop | Time tracking stops automatically without explicit user pause/stop |

---

## Architecture Overview

Understanding the data flow is essential to diagnosing where data is lost:

```
Desktop App (Python)                    Supabase                     Jira Dashboard
┌──────────────────────┐          ┌──────────────────┐         ┌──────────────────┐
│ tracking_loop()      │          │                  │         │                  │
│   ↓ every ~2s        │          │                  │         │                  │
│ process_window_event │          │                  │         │                  │
│   ↓                  │          │                  │         │                  │
│ session_manager      │  every   │ activity_records │ query   │ SummaryCards.js  │
│ .on_window_switch()  │  5 min   │     table        │ ──────► │ "Time Spent      │
│   ↓                  │ ───────► │                  │         │  Today: 0s"      │
│ SQLite               │  batch   │ daily_time_      │         │                  │
│ active_sessions      │  upload  │ summary view     │         │                  │
│                      │          │                  │         │                  │
└──────────────────────┘          └──────────────────┘         └──────────────────┘
```

**Key points:**
- The desktop app accumulates time per `(window_title, application_name)` pair in a local SQLite `active_sessions` table.
- Every 5 minutes, `upload_activity_batch()` harvests all sessions from SQLite, inserts them into Supabase `activity_records`, then clears local SQLite.
- The Jira dashboard (Forge app) reads from `daily_time_summary` (a Supabase view over `activity_records`) to display time totals.

---

## Bug Details

### BUG-1: Verification Failure Does Not Prevent Local Data Deletion (CRITICAL)

**File:** `python-desktop-app/desktop_app.py`  
**Location:** Lines 7217–7233 (`upload_activity_batch` method)

**Description:**  
After inserting records into Supabase, the code runs a verification query to confirm the records exist. However, when verification finds **0 records** (indicating a possible RLS policy or database trigger silently removed them), the code only logs a warning and proceeds to delete all local data.

**Code (current):**
```python
# Verify records actually exist in the database
try:
    verify = self.supabase_service.table('activity_records') \
        .select('id') \
        .eq('user_id', self.current_user_id) \
        .eq('batch_timestamp', batch_timestamp) \
        .execute()
    verified_count = len(verify.data) if verify.data else 0
    print(f"[BATCH] Verification: {verified_count}/{len(records)} records confirmed in database")
    if verified_count == 0:
        print(f"[WARN] Insert returned data but verification found 0 records — possible RLS or trigger issue")
except Exception as ve:
    print(f"[WARN] Verification query failed: {ve}")

# Success — clear local sessions and reset batch timer
self.session_manager.clear_all()          # ← LOCAL DATA DELETED REGARDLESS
self.current_window_key = None
```

**Impact:**
- Local session data is permanently deleted even though it never persisted in Supabase.
- Dashboard queries Supabase, finds nothing → displays **0s**.
- This is the **most likely primary cause** of the reported issue.

**Root Cause:**  
The verification result is logged but not acted upon. The `clear_all()` call is unconditional within the `if result.data:` block.

---

### BUG-2: Race Condition Between Session Harvest and Clear (HIGH)

**File:** `python-desktop-app/desktop_app.py`  
**Location:** Lines 7049–7231 (`upload_activity_batch` method) and lines 3711–3920 (`ActiveSessionManager` class)

**Description:**  
`get_all_sessions()` and `clear_all()` are separate operations, each acquiring and releasing the session manager's lock independently. Between these two calls, the tracking thread (running on a separate daemon thread every ~2s) can call `on_window_switch()`, inserting new sessions into SQLite. Those new sessions are then deleted by `clear_all()` without ever being uploaded.

**Sequence diagram showing the race:**
```
Thread: Batch Upload              Thread: Tracking Loop
────────────────────              ─────────────────────
stop_current_timer()
  [lock acquire/release]
get_all_sessions()
  [lock acquire/release]
  → returns sessions A, B, C
                                  on_window_switch()
                                    [lock acquire/release]
                                    → inserts session D into SQLite
... build records, upload ...
clear_all()
  [lock acquire/release]
  → DELETE FROM active_sessions
  → Session D is DELETED without
    ever being uploaded!
```

**Impact:**
- Any activity recorded during the upload window (network latency + processing) is silently lost.
- With slow network or large batches, this window can be several seconds.

**Root Cause:**  
Classic TOCTOU (Time-Of-Check-Time-Of-Use) race condition. The read and delete should be atomic (performed under a single lock).

---

### BUG-3: `current_window_key = None` Reset Creates Tracking Gap (MEDIUM)

**File:** `python-desktop-app/desktop_app.py`  
**Location:** Lines 7232 and 7078

**Description:**  
After every successful batch upload (and also after noise-filter clears), `current_window_key` is set to `None`. This forces the next iteration of `tracking_loop()` to treat the currently active window as "new," creating a fresh session with `first_seen = now`. Any time accumulated between the batch upload and the next tracking loop iteration is lost.

**Code (current):**
```python
self.session_manager.clear_all()
self.current_window_key = None  # Force re-detection so next loop iteration creates a fresh session
```

**Impact:**
- Every 5 minutes (at each batch boundary), there is a small but guaranteed time gap where work is not tracked.
- Over an 8-hour workday, this compounds to approximately 4–8 minutes of lost time (depending on loop timing).
- The session indicator may briefly flash or reset, appearing as if tracking stopped.

**Root Cause:**  
Setting `current_window_key = None` was intended to trigger re-detection, but it creates an unnecessary discontinuity. The tracking loop could instead naturally pick up the current window state.

---

### BUG-4: System Suspension Resets State Without Uploading (MEDIUM)

**File:** `python-desktop-app/desktop_app.py`  
**Location:** Lines 8459–8479 (`tracking_loop` method — suspension detection block)

**Description:**  
When a >30-second loop gap is detected (indicating the system went to sleep, hibernated, or the lid was closed), all tracking state variables are reset without triggering a batch upload first. The local SQLite sessions survive but the current session timer is stopped and `current_window_key` is reset, creating a tracking gap.

**Code (current):**
```python
if time_since_last_loop > 30:
    self._finalize_active_session("system suspension detected")
    self.session_manager.stop_current_timer()
    # Reset ALL tracking state
    self.is_idle = False
    self.needs_idle_resume = False
    self.current_window_start_time = None
    self.current_window_db_start_time = None
    self.current_window_screenshot_id = None
    self.current_window_record_created_at = None
    self.last_screenshot_end_time = None
    self.previous_window_key = None
    self.previous_window_screenshot_id = None
    self.previous_window_start_time = None
    self.previous_window_db_start_time = None
    self.current_window_key = None
    self.last_interval_time = current_loop_time
    self.last_activity_time = current_loop_time
```

**Impact:**
- After system resume, tracking starts fresh. Time accumulated before sleep is safe in SQLite but won't be uploaded until the next 5-minute batch cycle.
- If the user was actively working, the session indicator turns red (session appears stopped) until the tracking loop detects the current window again.
- If the batch upload fails on the next cycle (BUG-1), the pre-sleep data is also lost.

**Root Cause:**  
No forced batch upload on suspension detection. The code correctly stops the timer but doesn't ensure accumulated data is persisted to Supabase before resetting state.

---

### BUG-5: Idle Records Lost on Early Return (MEDIUM)

**File:** `python-desktop-app/desktop_app.py`  
**Location:** Lines 7086–7105 and 7192

**Description:**  
`_pending_idle_records` is cleared (line 7192) during record-building, before the subsequent validation checks for `supabase_service`, `service_key`, and `current_user_id`. If any of those checks fail and the function returns early, the idle records have already been removed from the pending list and are permanently lost.

**Code flow (current):**
```python
# Line 7192 — idle records consumed here
idle_records = list(self._pending_idle_records)
self._pending_idle_records.clear()          # ← Cleared BEFORE upload attempt

# Lines 7086-7105 — these checks happen BEFORE line 7192 in the code,
# but if the function reaches line 7192 and then fails at insert...
# the idle records are gone.

# Line 7203 — if insert throws an exception
result = self.supabase_service.table('activity_records').insert(records).execute()
# ← Exception here → idle records already cleared, never uploaded
```

**Impact:**
- Idle time tracking records (breaks, lunch, etc.) can be silently lost.
- This affects the accuracy of total work-hour calculations on the dashboard.

**Root Cause:**  
Consuming the pending list before confirming the upload succeeded.

---

### BUG-6: Noise Filter Clear Deletes Concurrent Sessions (LOW)

**File:** `python-desktop-app/desktop_app.py`  
**Location:** Lines 7072–7078

**Description:**  
When all harvested sessions are under 5 seconds (classified as "noise"), `clear_all()` is called. However, between `get_all_sessions()` and `clear_all()`, the tracking thread may have added new, legitimate sessions that exceed 5 seconds. These are deleted without check.

**Code (current):**
```python
if not sessions:  # After filtering < 5s
    if self._pending_idle_records:
        print("[BATCH] All work sessions were noise — but idle records exist, continuing")
    else:
        print("[BATCH] All sessions were noise — nothing to upload")
        self.session_manager.clear_all()          # ← Deletes ALL including new valid sessions
        self.current_window_key = None
        self.last_batch_upload_time = time.time()
        return
```

**Impact:**  
Similar to BUG-2 but confined to the noise-filter path. Less frequent but still causes data loss.

---

## Fix Plan

### Fix 1: Guard `clear_all()` on Verification Success (BUG-1)

**Priority:** P0 — Must Fix  
**Risk:** Low  
**Change scope:** ~10 lines in `upload_activity_batch()`

**Solution:** Only clear local sessions when verified count matches (or is close to) the expected count. If verification fails or finds 0 records, keep local data for retry on the next batch cycle.

```python
# BEFORE (current):
if verified_count == 0:
    print(f"[WARN] Insert returned data but verification found 0 records")
# falls through to clear_all()

# AFTER (fixed):
if verified_count == 0:
    print(f"[ERROR] Records not found in database — keeping local data for retry")
    self.last_batch_upload_time = time.time()
    return  # Do NOT clear local sessions

# Also handle verification query failure:
except Exception as ve:
    print(f"[ERROR] Verification query failed: {ve} — keeping local data for retry")
    self.last_batch_upload_time = time.time()
    return  # Do NOT clear local sessions
```

---

### Fix 2: Atomic Harvest-and-Clear in Session Manager (BUG-2, BUG-6)

**Priority:** P0 — Must Fix  
**Risk:** Low  
**Change scope:** New method in `ActiveSessionManager`, update caller in `upload_activity_batch()`

**Solution:** Add a `harvest_and_clear()` method that performs both operations under a single lock, then returns only the harvested sessions. New sessions arriving after the lock is acquired will correctly be stored in a fresh table.

```python
# New method in ActiveSessionManager:
def harvest_and_clear(self, min_duration_seconds=0):
    """Atomically harvest all sessions and clear the table.
    
    Returns only sessions with total_time_seconds >= min_duration_seconds.
    Sessions below the threshold are also deleted (noise).
    New sessions written after this call will be stored normally.
    """
    with self._lock:
        conn = sqlite3.connect(self.db_path)
        cursor = conn.cursor()
        cursor.execute('SELECT * FROM active_sessions')
        columns = [desc[0] for desc in cursor.description]
        rows = cursor.fetchall()
        cursor.execute('DELETE FROM active_sessions')
        conn.commit()
        conn.close()
        self._current_key = None
        all_sessions = [dict(zip(columns, row)) for row in rows]
        if min_duration_seconds > 0:
            return [s for s in all_sessions 
                    if (s.get('total_time_seconds') or 0) >= min_duration_seconds]
        return all_sessions
```

**Update caller:**
```python
# BEFORE:
self.session_manager.stop_current_timer()
sessions = self.session_manager.get_all_sessions()
# ... filter noise ...
# ... upload ...
self.session_manager.clear_all()

# AFTER:
self.session_manager.stop_current_timer()
sessions = self.session_manager.harvest_and_clear(min_duration_seconds=5)
# ... upload ...
# If upload fails → re-insert sessions back to SQLite (see Fix 1)
```

---

### Fix 3: Remove `current_window_key = None` After Batch Clear (BUG-3)

**Priority:** P1 — Should Fix  
**Risk:** Very Low  
**Change scope:** Delete 1 line (2 locations)

**Solution:** Remove the `current_window_key = None` assignment after `clear_all()` / `harvest_and_clear()`. The tracking loop naturally detects the current window on each iteration. Setting the key to `None` creates an unnecessary gap.

```python
# BEFORE:
self.session_manager.clear_all()
self.current_window_key = None  # ← Remove this line

# AFTER:
self.session_manager.clear_all()
# Tracking loop will naturally detect the current window on next iteration
```

> **Note:** This line also appears on line 7078 (noise filter path). Remove from both locations.

---

### Fix 4: Trigger Batch Upload on System Suspension (BUG-4)

**Priority:** P1 — Should Fix  
**Risk:** Low  
**Change scope:** ~5 lines in `tracking_loop()` suspension detection block

**Solution:** Before resetting tracking state on suspension detection, trigger an immediate batch upload to persist any accumulated data.

```python
# BEFORE:
if time_since_last_loop > 30:
    self._finalize_active_session("system suspension detected")
    self.session_manager.stop_current_timer()
    # Reset ALL tracking state...

# AFTER:
if time_since_last_loop > 30:
    self._finalize_active_session("system suspension detected")
    self.session_manager.stop_current_timer()
    # Upload accumulated data before resetting state
    try:
        self.upload_activity_batch()
    except Exception as e:
        print(f"[WARN] Suspension batch upload failed: {e} — data remains in SQLite")
    # Reset ALL tracking state...
```

---

### Fix 5: Defer Idle Record Consumption Until Upload Succeeds (BUG-5)

**Priority:** P2 — Nice to Fix  
**Risk:** Very Low  
**Change scope:** Move `_pending_idle_records.clear()` to after confirmed upload

**Solution:** Instead of clearing idle records before the insert, only clear them after the insert is verified.

```python
# BEFORE:
idle_records = list(self._pending_idle_records)
self._pending_idle_records.clear()   # ← Too early
for idle_rec in idle_records:
    records.append(idle_rec)
# ... insert might fail ...

# AFTER:
idle_records = list(self._pending_idle_records)
# Don't clear yet — clear only after successful upload
for idle_rec in idle_records:
    records.append(idle_rec)
# ... after successful insert and verification ...
self._pending_idle_records.clear()   # ← Safe: upload confirmed
```

---

## Fix Summary

| Fix | Bug(s) | Priority | Risk | Lines Changed |
|-----|--------|----------|------|---------------|
| Fix 1: Guard clear on verification | BUG-1 | P0 | Low | ~10 |
| Fix 2: Atomic harvest-and-clear | BUG-2, BUG-6 | P0 | Low | ~25 (new method) + ~10 (caller) |
| Fix 3: Remove `current_window_key = None` | BUG-3 | P1 | Very Low | -2 lines |
| Fix 4: Batch upload on suspension | BUG-4 | P1 | Low | ~5 |
| Fix 5: Defer idle record clear | BUG-5 | P2 | Very Low | ~3 (move) |

**Total estimated change:** ~55 lines modified in 1 file (`desktop_app.py`)

---

## Testing Recommendations

1. **Verification failure test:** Temporarily misconfigure the Supabase RLS policy to reject inserts. Verify that local sessions are retained and re-uploaded on the next batch cycle.

2. **Race condition test:** Add a deliberate `time.sleep(5)` between `get_all_sessions()` and `clear_all()` (before the fix). Rapidly switch windows during those 5 seconds. Verify sessions are not lost after applying Fix 2.

3. **Suspension test:** Put the machine to sleep for 1 minute, then resume. Verify that:
   - Pre-sleep sessions are uploaded (Fix 4).
   - Post-resume tracking restarts without indicator turning red.

4. **Noise filter test:** Rapidly switch windows (all < 5s durations), then immediately start focused work on one window. Verify the focused session is not cleared by the noise filter.

5. **Dashboard accuracy test:** Run tracking for 1 hour. Compare the local SQLite `total_time_seconds` sums against the Supabase `daily_time_summary` values. They should match within ±10 seconds.
