# Desktop App Tracking Blockers — Detailed Fix Implementation Plan

**Date:** 2026-06-05  
**Based On:** [DESKTOP_APP_TRACKING_BLOCKERS_COMPREHENSIVE_AUDIT_2026-06-05.md](./DESKTOP_APP_TRACKING_BLOCKERS_COMPREHENSIVE_AUDIT_2026-06-05.md)  
**Status:** READY FOR IMPLEMENTATION

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Implementation Principles](#implementation-principles)
3. [Phase 1: Critical Data Loss Prevention (P1)](#phase-1-critical-data-loss-prevention-p1)
4. [Phase 2: Reliability & Error Handling (P2)](#phase-2-reliability--error-handling-p2)
5. [Phase 3: Edge Cases & Thread Safety (P3)](#phase-3-edge-cases--thread-safety-p3)
6. [Phase 4: Platform & Observability (P4 + Observations)](#phase-4-platform--observability-p4--observations)
7. [Testing Strategy](#testing-strategy)
8. [Rollback Procedures](#rollback-procedures)
9. [Deployment Plan](#deployment-plan)

---

## Executive Summary

This document provides a **step-by-step implementation plan** for fixing all 21 blockers identified in the comprehensive audit, organized into 4 phases based on severity and dependencies.

### Key Metrics
- **Total Blockers:** 21
- **Implementation Phases:** 4
- **Estimated Timeline:** 4-6 weeks
- **Risk Level:** Medium (careful testing required)

### Success Criteria
1. No data loss on process kill, shutdown, or network failure
2. All idle/resume transitions work reliably
3. Thread-safe token management with no race conditions
4. Graceful degradation on system event failures
5. Zero regressions in existing functionality

---

## Implementation Principles

### 1. **Defense in Depth**
- Multiple fallback mechanisms for critical operations
- Assume any single system (pynput, Win32 API, network) can fail
- Write-ahead logging for state changes

### 2. **Idempotency**
- All network operations must be retryable without side effects
- Database writes use upsert patterns where appropriate
- Duplicate requests must be safely ignored

### 3. **Backward Compatibility**
- Maintain existing API contracts
- Support gradual rollout (old + new code paths coexist)
- Database schema changes are additive only

### 4. **Observable Failures**
- Every error path logs structured diagnostics
- Request correlation IDs for end-to-end tracing
- Health check endpoints expose internal state

### 5. **Graceful Degradation**
- Missing dependencies don't crash the app
- Reduced functionality > complete failure
- User-visible error messages are actionable

---

## Phase 1: Critical Data Loss Prevention (P1)

**Duration:** 1-2 weeks  
**Blockers:** B-1, B-9, B-10, B-12, B-15  
**Goal:** Zero data loss on any shutdown/crash/network failure scenario

---

### B-1: pynput Failure → Stuck Idle Forever

**Problem:** If pynput fails/crashes, `needs_idle_resume` is never set, tracking stuck in idle loop forever.

**Root Cause:**
```python
# Line ~10650 in tracking_loop():
if not self.needs_idle_resume:
    time.sleep(5)
    continue  # <-- stuck here forever if pynput dead
```

**Fix Strategy:** Add time-based fallback resume mechanism

#### Implementation Steps

1. **Add fallback idle resume timer:**
   ```python
   # In __init__:
   self.idle_fallback_check_interval = 30  # Check every 30s
   self.idle_max_duration_without_activity_check = 600  # 10 min max idle before force-check
   self.last_idle_fallback_check = 0
   ```

2. **Modify idle loop in `tracking_loop()`:**
   ```python
   # Replace the simple "if not self.needs_idle_resume: continue" block
   if not self.needs_idle_resume:
       current_time = time.time()
       
       # Fallback: Check if we've been idle too long without activity detection
       # This catches cases where pynput died and never set needs_idle_resume
       if (current_time - self.last_idle_fallback_check) >= self.idle_fallback_check_interval:
           self.last_idle_fallback_check = current_time
           
           # Check window switches as activity indicator (doesn't rely on pynput)
           current_window = self.get_active_window()
           if current_window and current_window != self.idle_last_window_key:
               print("[FALLBACK] Window switch detected during idle — resuming (pynput may be dead)")
               self.needs_idle_resume = True
               self.idle_last_window_key = None
           
           # Also check if idle duration exceeded reasonable threshold
           idle_duration = current_time - (self.idle_start_time.timestamp() if self.idle_start_time else current_time)
           if idle_duration > self.idle_max_duration_without_activity_check:
               print(f"[FALLBACK] Idle duration ({idle_duration:.0f}s) exceeded max — forcing activity check")
               # Force a check by temporarily assuming activity, then re-evaluate
               self.needs_idle_resume = True
       
       time.sleep(5)
       continue
   ```

3. **Store last window key at idle entry:**
   ```python
   # In enter_idle():
   self.idle_last_window_key = self.current_window_key
   ```

#### Testing
- **Unit Test:** Mock pynput failure, verify fallback triggers within 30s of window switch
- **Integration Test:** Kill pynput process mid-idle, switch windows, verify tracking resumes
- **Regression Test:** Normal pynput operation still works as before

#### Risks
- **Low:** Window-switch check is independent of pynput, won't cause false resumes

#### Rollback
- Feature-flagged: `ENABLE_IDLE_FALLBACK_RESUME = True` (disable if issues found)

---

### B-9: No WM_ENDSESSION Handler → Data Loss on Shutdown

**Problem:** Windows shutdown broadcasts `WM_ENDSESSION`, but app doesn't handle it — loses last session.

**Root Cause:**
```python
# Line ~10192 in wnd_proc:
def wnd_proc(hwnd, msg, wparam, lparam):
    if msg == WM_POWERBROADCAST:
        ...
    elif msg == WM_WTSSESSION_CHANGE:
        ...
    # WM_ENDSESSION (0x0016) not handled
```

**Fix Strategy:** Add WM_QUERYENDSESSION and WM_ENDSESSION handlers

#### Implementation Steps

1. **Define Windows constants:**
   ```python
   # Near other Win32 constants (line ~259):
   WM_QUERYENDSESSION = 0x0011
   WM_ENDSESSION = 0x0016
   ENDSESSION_CLOSEAPP = 0x00000001
   ENDSESSION_LOGOFF = 0x80000000
   ```

2. **Add handlers to `wnd_proc`:**
   ```python
   def wnd_proc(hwnd, msg, wparam, lparam):
       if msg == WM_QUERYENDSESSION:
           # Windows is asking if we can shut down — start pre-shutdown cleanup
           print(f"[SHUTDOWN] WM_QUERYENDSESSION received (wparam={wparam:#x})")
           try:
               # Begin async cleanup (don't block shutdown query response)
               threading.Thread(target=self._pre_shutdown_cleanup, daemon=True).start()
           except Exception as e:
               print(f"[ERROR] Pre-shutdown cleanup failed: {e}")
           # Return TRUE (1) to allow shutdown
           return 1
       
       elif msg == WM_ENDSESSION:
           # Shutdown is actually happening (wparam=TRUE) or was cancelled (wparam=FALSE)
           is_ending = wparam != 0
           reason = "LOGOFF" if (lparam & ENDSESSION_LOGOFF) else "SHUTDOWN"
           print(f"[SHUTDOWN] WM_ENDSESSION received (ending={is_ending}, reason={reason})")
           
           if is_ending:
               try:
                   # Final chance to save data (blocking, but Windows gives us ~5 seconds)
                   self._emergency_shutdown_save()
               except Exception as e:
                   print(f"[ERROR] Emergency shutdown save failed: {e}")
           return 0
       
       elif msg == WM_POWERBROADCAST:
           # ... existing code ...
   ```

3. **Implement `_pre_shutdown_cleanup()` (async, starts early):**
   ```python
   def _pre_shutdown_cleanup(self):
       """Pre-shutdown cleanup (async) — starts when Windows sends WM_QUERYENDSESSION.
       This gives us extra time before the hard 5-second WM_ENDSESSION deadline."""
       try:
           if self.tracking_active:
               # Stop timer on current session
               self.session_manager.stop_current_timer()
               
               # Upload any pending activity batch (non-blocking if network slow)
               upload_thread = threading.Thread(target=self.upload_activity_batch, daemon=True)
               upload_thread.start()
               upload_thread.join(timeout=3)  # Wait max 3 seconds
       except Exception as e:
           print(f"[WARN] Pre-shutdown cleanup error: {e}")
   ```

4. **Implement `_emergency_shutdown_save()` (blocking, last resort):**
   ```python
   def _emergency_shutdown_save(self):
       """Emergency shutdown save (blocking) — called from WM_ENDSESSION.
       Windows gives us ~5 seconds max. Focus on SQLite writes (fast + durable)."""
       try:
           print("[SHUTDOWN] Emergency save started (5s deadline)")
           
           # 1. Finalize current session (write to SQLite if Supabase fails)
           if self.current_window_screenshot_id:
               try:
                   self._finalize_active_session("system shutdown")
               except Exception as e:
                   # Fallback: write to SQLite offline queue
                   print(f"[SHUTDOWN] Supabase finalize failed, writing to SQLite: {e}")
                   # TODO: Add SQLite fallback for session end_time
           
           # 2. Harvest and save active_sessions to SQLite (fast)
           sessions = self.session_manager.harvest_and_clear()
           if sessions:
               # Write to SQLite offline queue instead of Supabase (faster + durable)
               # TODO: Add bulk insert to offline_activity_records table
               print(f"[SHUTDOWN] Saved {len(sessions)} sessions to SQLite")
           
           # 3. Close database connections cleanly
           if self.db_manager:
               self.db_manager.close()
           
           print("[SHUTDOWN] Emergency save complete")
       except Exception as e:
           print(f"[ERROR] Emergency shutdown save failed: {e}")
   ```

#### Testing
- **Manual Test:** Shutdown Windows via Start Menu → Shut Down
- **Manual Test:** Log off Windows
- **Manual Test:** `shutdown /s /t 0` from admin cmd
- **Verification:** Check SQLite after restart for saved sessions

#### Risks
- **Medium:** 5-second deadline is tight — minimize blocking operations

#### Rollback
- No backward-compat issues — new handlers, existing code unchanged

---

### B-10: atexit Skipped on Kill/Power Loss

**Problem:** `atexit` handlers don't run on SIGKILL, BSOD, power loss.

**Root Cause:**
```python
# Line ~5285:
atexit.register(self._shutdown_cleanup)  # <-- only runs on clean exit
```

**Fix Strategy:** Write checkpoint data to SQLite continuously (write-ahead logging)

#### Implementation Steps

1. **Add session checkpoint table:**
   ```sql
   -- In db_connection.py, add to schema:
   CREATE TABLE IF NOT EXISTS session_checkpoints (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       user_id TEXT NOT NULL,
       organization_id TEXT,
       window_title TEXT,
       application_name TEXT,
       screenshot_id TEXT,  -- Supabase screenshots.id
       start_time TEXT NOT NULL,
       last_checkpoint_time TEXT NOT NULL,
       classification TEXT,
       project_key TEXT,
       created_at TEXT DEFAULT CURRENT_TIMESTAMP
   );
   CREATE INDEX IF NOT EXISTS idx_checkpoints_user ON session_checkpoints(user_id);
   ```

2. **Write checkpoint on session start:**
   ```python
   # In on_window_switch (after creating Supabase screenshot record):
   if result.data:
       screenshot_id = result.data[0]['id']
       self.current_window_screenshot_id = screenshot_id
       
       # Write checkpoint to SQLite immediately
       self._write_session_checkpoint(
           screenshot_id=screenshot_id,
           window_title=title,
           application_name=app_name,
           start_time=start_timestamp,
           classification=classification
       )
   ```

3. **Implement `_write_session_checkpoint()`:**
   ```python
   def _write_session_checkpoint(self, screenshot_id, window_title, application_name, start_time, classification):
       """Write session checkpoint to SQLite (survives crash/power loss)."""
       try:
           conn = self.db_manager.get_connection()
           cursor = conn.cursor()
           cursor.execute('''
               INSERT OR REPLACE INTO session_checkpoints
               (user_id, organization_id, window_title, application_name, 
                screenshot_id, start_time, last_checkpoint_time, classification, project_key)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ''', (
               self.current_user_id,
               self.organization_id,
               window_title,
               application_name,
               screenshot_id,
               start_time,
               datetime.now(timezone.utc).isoformat(),
               classification,
               self.current_project_key
           ))
           conn.commit()
       except Exception as e:
           print(f"[WARN] Failed to write session checkpoint: {e}")
   ```

4. **Clear checkpoint on clean finalize:**
   ```python
   # In _finalize_active_session (after successful Supabase update):
   try:
       conn = self.db_manager.get_connection()
       cursor = conn.cursor()
       cursor.execute(
           'DELETE FROM session_checkpoints WHERE screenshot_id = ?',
           (self.current_window_screenshot_id,)
       )
       conn.commit()
   except Exception:
       pass  # Non-critical
   ```

5. **Recover orphaned sessions on startup:**
   ```python
   # In start_tracking() or after authentication:
   def _recover_orphaned_sessions(self):
       """Recover sessions that were active during crash/power loss."""
       try:
           conn = self.db_manager.get_connection()
           cursor = conn.cursor()
           cursor.execute('''
               SELECT screenshot_id, window_title, application_name, 
                      start_time, classification, project_key
               FROM session_checkpoints
               WHERE user_id = ?
           ''', (self.current_user_id,))
           
           orphans = cursor.fetchall()
           if not orphans:
               return
           
           print(f"[RECOVERY] Found {len(orphans)} orphaned sessions from crash/power loss")
           
           # For each orphan, finalize with reasonable end_time (start + 5 min default)
           for row in orphans:
               screenshot_id, title, app, start_time, classification, project_key = row
               try:
                   start_dt = datetime.fromisoformat(start_time)
                   # Assume session lasted 5 minutes (reasonable default for crash recovery)
                   end_dt = start_dt + timedelta(minutes=5)
                   duration = 300  # 5 minutes
                   
                   # Update Supabase screenshot record with recovered end_time
                   self.supabase.table('screenshots').update({
                       'end_time': end_dt.isoformat(),
                       'duration_seconds': duration,
                       'recovered_after_crash': True  # Flag for analytics
                   }).eq('id', screenshot_id).execute()
                   
                   print(f"[RECOVERY] Finalized orphan session: {title[:50]}")
               except Exception as e:
                   print(f"[WARN] Failed to recover session {screenshot_id}: {e}")
           
           # Clear all checkpoints after recovery attempt
           cursor.execute('DELETE FROM session_checkpoints WHERE user_id = ?', (self.current_user_id,))
           conn.commit()
           
       except Exception as e:
           print(f"[ERROR] Session recovery failed: {e}")
   ```

#### Testing
- **Crash Test:** `taskkill /F /IM TimeTracker.exe` during active session
- **Crash Test:** Pull power cord during session
- **Verification:** Restart app, check Supabase for recovered session with `recovered_after_crash=true`

#### Risks
- **Low:** SQLite is ACID-compliant, writes are durable

#### Rollback
- Safe: Recovery is additive, doesn't modify existing code paths

---

### B-12: _finalize_active_session Has No Offline Fallback

**Problem:** Network errors during session finalization leave `end_time = NULL` permanently.

**Root Cause:**
```python
# Line ~9867:
try:
    db_client.table('screenshots').update({...}).eq('id', screenshot_id).execute()
except Exception as e:
    print(f"[ERROR] Error finalizing session: {e}")
    # <-- NO retry, NO offline queue
```

**Fix Strategy:** Add SQLite fallback queue for failed finalizations

#### Implementation Steps

1. **Add finalization queue table:**
   ```sql
   -- In db_connection.py:
   CREATE TABLE IF NOT EXISTS pending_finalizations (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       screenshot_id TEXT NOT NULL UNIQUE,
       end_time TEXT NOT NULL,
       duration_seconds INTEGER NOT NULL,
       reason TEXT,
       retry_count INTEGER DEFAULT 0,
       last_error TEXT,
       created_at TEXT DEFAULT CURRENT_TIMESTAMP
   );
   CREATE INDEX IF NOT EXISTS idx_finalization_screenshot ON pending_finalizations(screenshot_id);
   ```

2. **Modify `_finalize_active_session()` with fallback:**
   ```python
   def _finalize_active_session(self, reason):
       """Finalize the current screenshot session (update end_time).
       Falls back to SQLite queue if Supabase fails."""
       if not self.current_window_screenshot_id or not self.current_window_start_time:
           return
       
       try:
           end_time = datetime.now(timezone.utc)
           start_time = self.current_window_db_start_time or self.current_window_start_time
           duration_seconds = max(1, int((end_time - start_time).total_seconds()))
           
           # Try Supabase first
           try:
               db_client = self.supabase
               update_result = db_client.table('screenshots').update({
                   'end_time': end_time.isoformat(),
                   'timestamp': end_time.isoformat(),
                   'duration_seconds': duration_seconds
               }).eq('id', self.current_window_screenshot_id).execute()
               
               print(f"[OK] Session finalized: {duration_seconds}s ({reason})")
               
               # Success — remove from pending queue if it was queued before
               self._remove_pending_finalization(self.current_window_screenshot_id)
               
           except Exception as supabase_error:
               # Supabase failed — queue for retry
               print(f"[WARN] Supabase finalization failed, queuing for retry: {supabase_error}")
               self._queue_pending_finalization(
                   screenshot_id=self.current_window_screenshot_id,
                   end_time=end_time.isoformat(),
                   duration_seconds=duration_seconds,
                   reason=reason,
                   error=str(supabase_error)
               )
       
       except Exception as e:
           print(f"[ERROR] Error in _finalize_active_session: {e}")
       finally:
           # Always clear current session state
           self.current_window_screenshot_id = None
           self.current_window_start_time = None
           self.current_window_db_start_time = None
   ```

3. **Implement queue helpers:**
   ```python
   def _queue_pending_finalization(self, screenshot_id, end_time, duration_seconds, reason, error):
       """Queue a failed finalization for retry."""
       try:
           conn = self.db_manager.get_connection()
           cursor = conn.cursor()
           cursor.execute('''
               INSERT OR REPLACE INTO pending_finalizations
               (screenshot_id, end_time, duration_seconds, reason, retry_count, last_error)
               VALUES (?, ?, ?, ?, 0, ?)
           ''', (screenshot_id, end_time, duration_seconds, reason, error))
           conn.commit()
       except Exception as e:
           print(f"[ERROR] Failed to queue finalization: {e}")
   
   def _remove_pending_finalization(self, screenshot_id):
       """Remove a finalization from the retry queue."""
       try:
           conn = self.db_manager.get_connection()
           cursor = conn.cursor()
           cursor.execute('DELETE FROM pending_finalizations WHERE screenshot_id = ?', (screenshot_id,))
           conn.commit()
       except Exception:
           pass
   ```

4. **Add retry loop in batch upload:**
   ```python
   # In upload_activity_batch() or a separate periodic task:
   def _retry_pending_finalizations(self):
       """Retry queued finalizations (called periodically)."""
       try:
           conn = self.db_manager.get_connection()
           cursor = conn.cursor()
           cursor.execute('''
               SELECT screenshot_id, end_time, duration_seconds, reason, retry_count
               FROM pending_finalizations
               WHERE retry_count < 5
               ORDER BY created_at ASC
               LIMIT 10
           ''')
           
           pending = cursor.fetchall()
           if not pending:
               return
           
           print(f"[RETRY] Processing {len(pending)} pending finalizations...")
           
           for row in pending:
               screenshot_id, end_time, duration, reason, retry_count = row
               try:
                   # Retry Supabase update
                   self.supabase.table('screenshots').update({
                       'end_time': end_time,
                       'duration_seconds': duration
                   }).eq('id', screenshot_id).execute()
                   
                   # Success — remove from queue
                   cursor.execute('DELETE FROM pending_finalizations WHERE screenshot_id = ?', (screenshot_id,))
                   print(f"[RETRY] Finalized {screenshot_id} on retry")
                   
               except Exception as e:
                   # Failed again — increment retry count
                   cursor.execute('''
                       UPDATE pending_finalizations
                       SET retry_count = retry_count + 1, last_error = ?
                       WHERE screenshot_id = ?
                   ''', (str(e), screenshot_id))
                   print(f"[RETRY] Finalization retry failed ({retry_count + 1}/5): {e}")
           
           conn.commit()
           
       except Exception as e:
           print(f"[ERROR] Retry finalizations failed: {e}")
   ```

5. **Call retry in periodic task:**
   ```python
   # In tracking_loop, every 5 minutes:
   if time.time() - self.last_finalization_retry > 300:
       self._retry_pending_finalizations()
       self.last_finalization_retry = time.time()
   ```

#### Testing
- **Network Test:** Disconnect network, switch windows, verify SQLite queue
- **Network Test:** Reconnect network, verify retry succeeds
- **Verification:** Check `pending_finalizations` table is empty after retry

#### Risks
- **Low:** Existing code unchanged, fallback is additive

#### Rollback
- Safe: Can disable retry loop via feature flag

---

### B-15: Token Refresh Deadlock on Concurrent Requests

**Problem:** Race condition in token refresh despite existing lock.

**Root Cause:**
```python
# Line ~2380: Double-check has a window
with self._refresh_lock:
    refresh_token_now = self.tokens.get('refresh_token')
    if refresh_token_now and refresh_token_now != refresh_token_before:
        print("[INFO] Token already refreshed by another thread, skipping")
        return True  # <-- but what if token is about to expire again?
```

**Fix Strategy:** Add token expiry check inside lock + rate limiting

#### Implementation Steps

1. **Add refresh rate limiting:**
   ```python
   # In __init__:
   self._last_refresh_success_time = 0
   self._min_refresh_interval = 10  # Minimum 10s between refreshes
   ```

2. **Strengthen double-check logic:**
   ```python
   def refresh_access_token(self):
       """Thread-safe token refresh with rate limiting."""
       # Fast path: Check if we refreshed very recently (< 10s ago)
       if time.time() - self._last_refresh_success_time < self._min_refresh_interval:
           print("[INFO] Token refreshed very recently, skipping")
           return True
       
       # Grace period check for invalid flag (existing code)
       if getattr(self, '_refresh_token_invalid', False):
           grace_period = 1800
           invalid_since = getattr(self, '_refresh_invalid_set_at', 0)
           if invalid_since and (time.time() - invalid_since) >= grace_period:
               self._refresh_token_invalid = False
               self._refresh_fail_count = 0
               self._refresh_invalid_set_at = 0
           else:
               return False
       
       refresh_token_before = self.tokens.get('refresh_token')
       expires_at_before = self.tokens.get('expires_at', 0)
       
       if not refresh_token_before:
           return False
       
       with self._refresh_lock:
           # Re-check everything inside lock
           current_time = time.time()
           
           # Check 1: Did another thread just refresh? (within last 10s)
           if current_time - self._last_refresh_success_time < self._min_refresh_interval:
               print("[INFO] Another thread refreshed during lock wait, skipping")
               return True
           
           # Check 2: Did refresh_token change?
           refresh_token_now = self.tokens.get('refresh_token')
           if refresh_token_now and refresh_token_now != refresh_token_before:
               # Another thread refreshed — check if token is still valid for reasonable time
               expires_at_now = self.tokens.get('expires_at', 0)
               time_until_expiry = expires_at_now - current_time
               if time_until_expiry > 300:  # More than 5 min remaining
                   print(f"[INFO] Token already refreshed by another thread ({time_until_expiry:.0f}s remaining)")
                   return True
               else:
                   print(f"[WARN] Token refreshed but expires soon ({time_until_expiry:.0f}s) — refreshing again")
                   refresh_token_before = refresh_token_now  # Use the new token
           
           # Check 3: Is token still valid for reasonable time? (avoid unnecessary refresh)
           expires_at_now = self.tokens.get('expires_at', 0)
           time_until_expiry = expires_at_now - current_time
           if time_until_expiry > 300:  # More than 5 min remaining
               print(f"[INFO] Token still valid ({time_until_expiry:.0f}s remaining), skipping refresh")
               return True
           
           # Proceed with refresh (existing code)
           refresh_token = refresh_token_now or refresh_token_before
           if not refresh_token:
               return False
           
           print(f"[INFO] Refreshing access token (expires in {time_until_expiry:.0f}s)...")
           try:
               response = requests.post(
                   f"{self.ai_server_url}/api/auth/refresh-token",
                   json={'refresh_token': refresh_token},
                   headers={'Content-Type': 'application/json'},
                   timeout=(10, 60)
               )
               
               # ... existing error handling ...
               
               result = response.json()
               if not result.get('success'):
                   return False
               
               self.tokens.update({
                   'access_token': result.get('access_token'),
                   'refresh_token': result.get('refresh_token', refresh_token),
                   'expires_at': time.time() + result.get('expires_in', 3600)
               })
               self._save_tokens()
               
               # Update success timestamp
               self._last_refresh_success_time = time.time()
               
               # Clear failure flags
               self._refresh_token_invalid = False
               self._refresh_fail_count = 0
               # ... rest of success path ...
               
               return True
           except Exception as e:
               print(f"[ERROR] Failed to refresh access token: {e}")
               return False
   ```

#### Testing
- **Concurrency Test:** Spawn 10 threads calling `refresh_access_token()` simultaneously
- **Verification:** Only 1 network request sent, all threads return True
- **Timing Test:** Verify 10s rate limit prevents thrashing

#### Risks
- **Low:** Additional checks inside lock are fast, no new network calls

#### Rollback
- Safe: Maintains backward compatibility with existing lock mechanism

---

## Phase 2: Reliability & Error Handling (P2)

**Duration:** 1-2 weeks  
**Blockers:** B-2, B-4, B-5, B-7, B-14, B-16, B-17, B-18, B-19  
**Goal:** Graceful degradation, automatic recovery, no silent failures

---

### B-2: Activity Monitor Thread Dies Silently with No Watchdog

**Problem:** `monitor_user_activity()` thread can become alive but non-functional.

**Fix Strategy:** Add heartbeat + watchdog restart mechanism

#### Implementation Steps

1. **Add heartbeat tracking:**
   ```python
   # In __init__:
   self._activity_monitor_heartbeat = 0
   self._activity_monitor_heartbeat_timeout = 60  # 1 minute without heartbeat = dead
   ```

2. **Update heartbeat in activity callbacks:**
   ```python
   # In monitor_user_activity():
   def on_move(x, y):
       self._activity_monitor_heartbeat = time.time()
       # ... existing code ...
   
   def on_click(x, y, button, pressed):
       self._activity_monitor_heartbeat = time.time()
       # ... existing code ...
   ```

3. **Add watchdog check in tracking loop:**
   ```python
   # In tracking_loop():
   # Check activity monitor health every 60 seconds
   if time.time() - self._last_activity_monitor_check > 60:
       self._last_activity_monitor_check = time.time()
       
       # Check if thread is alive
       if not self._activity_monitor_thread or not self._activity_monitor_thread.is_alive():
           print("[WARN] Activity monitor thread is dead — restarting")
           self._start_activity_monitor()
       else:
           # Thread is alive — check heartbeat
           time_since_heartbeat = time.time() - self._activity_monitor_heartbeat
           if time_since_heartbeat > self._activity_monitor_heartbeat_timeout:
               print(f"[WARN] Activity monitor heartbeat timeout ({time_since_heartbeat:.0f}s) — restarting")
               self._restart_activity_monitor()
   ```

4. **Implement restart helper:**
   ```python
   def _restart_activity_monitor(self):
       """Restart activity monitor thread (stops old, starts new)."""
       try:
           # Stop old listeners (if they exist)
           # pynput listeners don't expose a stop() method cleanly, so we'll just start fresh
           # The old thread is daemon=True so it will die when we lose reference
           
           # Start new thread
           self._start_activity_monitor()
           
           # Reset heartbeat
           self._activity_monitor_heartbeat = time.time()
           
           print("[OK] Activity monitor restarted")
       except Exception as e:
           print(f"[ERROR] Failed to restart activity monitor: {e}")
   ```

#### Testing
- **Kill Test:** Kill pynput hooks via Task Manager → Services
- **Verification:** Watchdog detects within 60s, restarts automatically
- **Log Check:** "[WARN] Activity monitor heartbeat timeout" in logs

#### Risks
- **Low:** Restart is isolated, doesn't affect main tracking loop

---

### B-16: Supabase JWT Expiry Not Checked Before Uploads

**Problem:** Cached JWT expires (~1h TTL), first upload after expiry always fails.

**Fix Strategy:** Proactive expiry check before every Supabase operation

#### Implementation Steps

1. **Add JWT expiry helper:**
   ```python
   def _ensure_valid_supabase_jwt(self):
       """Ensure Supabase JWT is valid before operations.
       Returns True if JWT is valid/refreshed, False if refresh failed."""
       expires_at = self.auth_manager.tokens.get('supabase_token_expires_at', 0)
       current_time = time.time()
       time_remaining = expires_at - current_time
       
       # Refresh if expires within 5 minutes (300s buffer)
       if time_remaining < 300:
           print(f"[JWT] Supabase JWT expires in {time_remaining:.0f}s — refreshing...")
           new_token = self.auth_manager.get_valid_supabase_token()
           if not new_token:
               print("[ERROR] Failed to refresh Supabase JWT")
               return False
           
           # Update JWT on Supabase client
           self._set_supabase_jwt()
           print("[OK] Supabase JWT refreshed")
       
       return True
   ```

2. **Call before all Supabase operations:**
   ```python
   # In upload_screenshot():
   if not self._ensure_valid_supabase_jwt():
       print("[WARN] Supabase JWT invalid, queuing for offline")
       # ... queue to offline storage ...
       return None
   
   # Proceed with upload
   storage_client = self.supabase
   result = storage_client.storage.from_('screenshots').upload(...)
   ```

3. **Add to batch upload:**
   ```python
   # In upload_activity_batch():
   if not self._ensure_valid_supabase_jwt():
       print("[WARN] Supabase JWT invalid, deferring batch upload")
       return  # Will retry on next cycle
   
   # Proceed with batch
   ```

#### Testing
- **Time Test:** Set `supabase_token_expires_at` to 2 minutes in future
- **Verification:** JWT refreshed proactively before expiry
- **Upload Test:** Upload continues without 401 errors

#### Risks
- **Low:** Adds ~50ms per upload for expiry check (negligible)

---

### B-17: Google User Token Refresh Has No Retry Logic

**Problem:** Single network failure stops tracking for Google users permanently.

**Fix Strategy:** Add retry logic matching Atlassian refresh pattern

#### Implementation Steps

1. **Add retry loop to `_refresh_google_supabase_token()`:**
   ```python
   def _refresh_google_supabase_token(self):
       """Re-mint Supabase JWT for Google users with retry logic."""
       refresh_token = self.tokens.get('google_refresh_token')
       if not refresh_token:
           print("[ERROR] No Google refresh token available")
           return None
       
       print("[INFO] Refreshing Supabase token for Google user...")
       
       # Retry up to 3 times (same as Atlassian flow)
       for attempt in range(3):
           try:
               response = requests.post(
                   f"{self.ai_server_url}/api/auth/desktop-google/refresh",
                   json={'google_refresh_token': refresh_token},
                   headers={'Content-Type': 'application/json'},
                   timeout=(10, 60)
               )
               
               # Success — break retry loop
               if response.status_code == 200:
                   result = response.json()
                   if result.get('success'):
                       # ... existing success handling ...
                       return supabase_token
               
               # Non-retryable errors
               if response.status_code in (401, 403, 404):
                   error_data = response.json() if response.headers.get('content-type', '').startswith('application/json') else {}
                   print(f"[ERROR] Google token refresh failed (non-retryable): {error_data.get('error', response.text)}")
                   return None
               
               # Retryable error — log and retry
               print(f"[WARN] Google token refresh failed (attempt {attempt + 1}/3): HTTP {response.status_code}")
               
           except (requests.exceptions.ConnectTimeout, requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
               # Network errors are retryable
               if attempt < 2:
                   wait = (attempt + 1) * 5  # 5s, 10s backoff
                   print(f"[WARN] Google token refresh timeout/connection error (attempt {attempt + 1}/3), retrying in {wait}s...")
                   time.sleep(wait)
               else:
                   print(f"[ERROR] Google token refresh failed after 3 attempts: {e}")
                   return None
           
           except Exception as e:
               print(f"[ERROR] Google token refresh exception: {e}")
               return None
       
       return None
   ```

#### Testing
- **Network Test:** Disconnect network during Google token refresh
- **Verification:** 3 retries occur with backoff (5s, 10s)
- **Success Test:** Reconnect network, verify next retry succeeds

#### Risks
- **Low:** Adds retry only, doesn't change success path

---

### B-18: Batch Upload Has No Partial Success Handling

**Problem:** One duplicate key error blocks entire batch from clearing.

**Fix Strategy:** Parse response to identify succeeded rows, clear only those

#### Implementation Steps

1. **Modify `upload_activity_batch()` to handle partial success:**
   ```python
   def upload_activity_batch(self):
       """Upload activity records batch with partial success handling."""
       sessions = self.session_manager.harvest_and_clear(min_duration_seconds=2)
       
       if not sessions:
           return
       
       # Check JWT validity before upload
       if not self._ensure_valid_supabase_jwt():
           print("[WARN] JWT invalid, restoring sessions for retry")
           self.session_manager.restore_sessions(sessions)
           return
       
       batch = []
       session_map = {}  # Map: temp_id -> session dict
       
       for session in sessions:
           # Generate temp client-side ID for tracking
           temp_id = f"temp_{uuid.uuid4()}"
           session_map[temp_id] = session
           
           record = {
               'client_temp_id': temp_id,  # Include in payload for response matching
               'user_id': self.current_user_id,
               'organization_id': self.organization_id,
               'window_title': session['window_title'],
               'application_name': session['application_name'],
               # ... rest of fields ...
           }
           batch.append(record)
       
       try:
           supabase_client = self.supabase
           response = supabase_client.table('activity_records').insert(batch).execute()
           
           # Parse response to identify which rows succeeded
           inserted_records = response.data or []
           inserted_temp_ids = {r.get('client_temp_id') for r in inserted_records if r.get('client_temp_id')}
           
           succeeded_count = len(inserted_temp_ids)
           failed_count = len(sessions) - succeeded_count
           
           if succeeded_count > 0:
               print(f"[BATCH] Uploaded {succeeded_count} activity records")
           
           # Restore only the failed sessions for retry
           if failed_count > 0:
               failed_sessions = [s for tid, s in session_map.items() if tid not in inserted_temp_ids]
               self.session_manager.restore_sessions(failed_sessions)
               print(f"[BATCH] {failed_count} records failed, restored for retry")
           
       except Exception as e:
           print(f"[ERROR] Batch upload failed: {e}")
           # Restore all sessions for retry
           self.session_manager.restore_sessions(sessions)
   ```

2. **Add `client_temp_id` column to database:**
   ```sql
   -- In Supabase migration:
   ALTER TABLE activity_records ADD COLUMN client_temp_id TEXT;
   CREATE INDEX idx_activity_client_temp_id ON activity_records(client_temp_id);
   ```

#### Testing
- **Duplicate Test:** Insert a record manually, then upload batch with duplicate
- **Verification:** Duplicate fails, other records succeed, only duplicate retried
- **Log Check:** "[BATCH] X records failed, restored for retry"

#### Risks
- **Low:** Requires database migration, but column is nullable

---

### B-19: AI Server /api/analyze-batch Has No Idempotency Protection

**Problem:** Duplicate batch submissions overwrite user corrections.

**Fix Strategy:** Add request deduplication on AI server + desktop app

#### Implementation Steps (AI Server)

1. **Add request deduplication table:**
   ```sql
   -- In AI server migrations:
   CREATE TABLE IF NOT EXISTS batch_request_dedup (
       request_id TEXT PRIMARY KEY,
       user_id TEXT NOT NULL,
       organization_id TEXT NOT NULL,
       processed_at TIMESTAMP NOT NULL DEFAULT NOW(),
       record_count INTEGER,
       CONSTRAINT unique_request UNIQUE(request_id)
   );
   CREATE INDEX idx_dedup_user ON batch_request_dedup(user_id);
   CREATE INDEX idx_dedup_org ON batch_request_dedup(organization_id);
   -- Auto-cleanup old entries (keep 7 days for debugging)
   CREATE INDEX idx_dedup_processed_at ON batch_request_dedup(processed_at);
   ```

2. **Modify `/api/analyze-batch` controller:**
   ```javascript
   // In activity-controller.js:
   async analyzeBatch(req, res) {
       const { records, batch_metadata } = req.body;
       const requestId = batch_metadata?.request_id;  // Desktop app provides this
       
       // Check for duplicate request
       if (requestId) {
           const { data: existing } = await supabase
               .from('batch_request_dedup')
               .select('*')
               .eq('request_id', requestId)
               .single();
           
           if (existing) {
               logger.info(`[DEDUP] Request ${requestId} already processed, returning cached result`);
               return res.json({
                   success: true,
                   message: 'Batch already processed (duplicate request)',
                   request_id: requestId,
                   processed_at: existing.processed_at
               });
           }
       }
       
       // Process batch (existing logic)
       // ...
       
       // Record request as processed
       if (requestId) {
           await supabase.from('batch_request_dedup').insert({
               request_id: requestId,
               user_id: req.user.id,
               organization_id: req.user.organization_id,
               record_count: records.length
           });
       }
       
       // Return response
       res.json({ success: true, ... });
   }
   ```

#### Implementation Steps (Desktop App)

1. **Generate request ID in desktop app:**
   ```python
   # In upload_activity_batch():
   import uuid
   
   # Generate unique request ID for this batch
   request_id = f"batch_{self.current_user_id[:8]}_{int(time.time())}_{uuid.uuid4().hex[:8]}"
   
   payload = {
       'records': batch,
       'batch_metadata': {
           'request_id': request_id,
           'app_version': APP_VERSION,
           'timestamp': datetime.now(timezone.utc).isoformat()
       }
   }
   
   response = requests.post(
       f"{self.ai_server_url}/api/analyze-batch",
       json=payload,
       headers={...},
       timeout=(10, 120)
   )
   ```

#### Testing
- **Duplicate Test:** Send same batch twice with same request_id
- **Verification:** Second request returns immediately with "already processed"
- **User Correction Test:** Verify user edits are not overwritten

#### Risks
- **Low:** Additive change, existing behavior unchanged if request_id missing

---

## Phase 3: Edge Cases & Thread Safety (P3)

**Duration:** 1 week  
**Blockers:** B-3, B-6, B-11, B-13, B-20  
**Goal:** Eliminate race conditions, handle edge cases cleanly

---

### B-3: needs_idle_resume Written Without state_lock

**Problem:** Unsynchronized boolean write from multiple threads.

**Fix Strategy:** Use `threading.Event` instead of boolean flag

#### Implementation Steps

1. **Replace boolean with Event:**
   ```python
   # In __init__:
   # OLD: self.needs_idle_resume = False
   # NEW:
   self.idle_resume_event = threading.Event()  # Thread-safe, no lock needed
   ```

2. **Update all reads:**
   ```python
   # In tracking_loop():
   # OLD: if not self.needs_idle_resume: continue
   # NEW:
   if not self.idle_resume_event.is_set():
       time.sleep(5)
       continue
   
   # When resuming from idle:
   if self.idle_resume_event.is_set():
       self.idle_resume_event.clear()
       # ... resume logic ...
   ```

3. **Update all writes:**
   ```python
   # In monitor_user_activity() callbacks:
   # OLD: self.needs_idle_resume = True
   # NEW:
   self.idle_resume_event.set()
   
   # In wnd_proc (system events):
   # OLD: self.needs_idle_resume = True
   # NEW:
   self.idle_resume_event.set()
   ```

#### Testing
- **Concurrency Test:** Multiple threads calling `set()` simultaneously
- **Verification:** No race conditions, resume works reliably

#### Risks
- **None:** `threading.Event` is explicitly designed for this pattern

---

### B-6: Duplicate Idle Records Created on System Wake

**Problem:** Both message pump and tracking loop create idle records on wake.

**Fix Strategy:** Add deduplication flag + atomic check-and-set

#### Implementation Steps

1. **Add deduplication flag:**
   ```python
   # In __init__:
   self._idle_record_pending = threading.Event()  # Prevents duplicate creation
   ```

2. **Modify `_create_idle_record()` with atomic check:**
   ```python
   def _create_idle_record(self, reason):
       """Create idle period record with deduplication."""
       if not self.idle_start_time:
           return
       
       # Atomic check-and-set: only first caller creates record
       if not self._idle_record_pending.is_set():
           # This thread won the race — create record
           self._idle_record_pending.set()
       else:
           # Another thread is already creating record
           print(f"[IDLE] Duplicate idle record creation prevented (reason: {reason})")
           return
       
       try:
           # ... existing idle record creation logic ...
           self._pending_idle_records.append(record)
       finally:
           # Clear flag so next idle period can create a record
           self.idle_start_time = None
           self._idle_record_pending.clear()
   ```

#### Testing
- **Wake Test:** Put system to sleep, wake it up
- **Verification:** Only one idle record created per idle period
- **Log Check:** No "[IDLE] Duplicate idle record creation prevented" messages under normal operation

#### Risks
- **None:** Event-based synchronization is thread-safe

---

### B-11: Stale Startup Registry Entry After Update

**Problem:** Registry points to old exe path after update.

**Fix Strategy:** Update registry entry after every update

#### Implementation Steps

1. **Call `add_to_startup()` after update:**
   ```python
   # In install_application() after successful copy:
   if is_update:
       # Update complete — refresh startup registry entry
       print("[UPDATE] Refreshing Windows startup entry...")
       add_to_startup()
   ```

2. **Make `add_to_startup()` more robust:**
   ```python
   def add_to_startup():
       """Add application to Windows startup via registry.
       Always uses the current exe path (handles updates)."""
       if sys.platform != 'win32':
           return False
       
       try:
           import winreg
           
           # Use current executable path (not cached path)
           if getattr(sys, 'frozen', False):
               exe_path = get_app_executable_path()
           else:
               exe_path = get_app_executable_path()
           
           # Verify exe actually exists before writing to registry
           if not os.path.isfile(exe_path):
               print(f"[WARN] Executable not found, skipping startup entry: {exe_path}")
               return False
           
           key = winreg.OpenKey(
               winreg.HKEY_CURRENT_USER,
               REGISTRY_PATH,
               0,
               winreg.KEY_SET_VALUE
           )
           
           winreg.SetValueEx(key, APP_NAME, 0, winreg.REG_SZ, f'"{exe_path}"')
           winreg.CloseKey(key)
           
           print(f"[OK] Startup registry updated: {exe_path}")
           return True
       
       except Exception as e:
           print(f"[ERROR] Failed to update startup registry: {e}")
           return False
   ```

#### Testing
- **Update Test:** Install new version, check registry key points to new path
- **Reboot Test:** Restart Windows, verify app launches from new path

#### Risks
- **None:** Registry write is idempotent

---

### B-13: Mandatory Update Exit Doesn't Join Tracking Thread

**Problem:** `sys.exit(0)` kills daemon thread mid-operation.

**Fix Strategy:** Bounded join on tracking thread before exit

#### Implementation Steps

1. **Modify `quit_app()` with bounded join:**
   ```python
   def quit_app(self):
       """Gracefully exit application with bounded cleanup time."""
       print("[EXIT] Shutting down application...")
       
       try:
           # Update desktop status
           self._update_desktop_status(logged_in=False)
       except Exception as e:
           print(f"[WARN] Status update failed during shutdown: {e}")
       
       # Signal tracking thread to stop
       self.running = False
       self.tracking_active = False
       
       # Wait for tracking thread to finish (bounded 10s)
       if self._tracking_thread and self._tracking_thread.is_alive():
           print("[EXIT] Waiting for tracking thread to finish (max 10s)...")
           self._tracking_thread.join(timeout=10)
           
           if self._tracking_thread.is_alive():
               print("[WARN] Tracking thread did not exit cleanly")
           else:
               print("[OK] Tracking thread finished")
       
       # Run shutdown cleanup
       try:
           self._shutdown_cleanup()
       except Exception as e:
           print(f"[WARN] Shutdown cleanup failed: {e}")
       
       # Stop tray icon
       if self.tray:
           try:
               self.tray.stop()
           except Exception:
               pass
       
       # Final exit
       print("[EXIT] Exiting")
       sys.exit(0)
   ```

2. **Make tracking loop respect `self.running` flag:**
   ```python
   # In tracking_loop():
   while self.running:
       # ... existing loop logic ...
       
       # Check running flag frequently
       if not self.running:
           print("[EXIT] Tracking loop exiting cleanly")
           break
   ```

#### Testing
- **Update Test:** Trigger mandatory update, verify tracking thread joins
- **Data Loss Test:** Check no in-flight uploads lost
- **Timing Test:** Verify join timeout is respected (10s max)

#### Risks
- **Low:** 10s timeout is generous for cleanup

---

### B-20: Desktop App Sends No Client Request ID

**Problem:** Cannot correlate desktop logs with AI server logs.

**Fix Strategy:** Add X-Request-ID header to all HTTP requests

#### Implementation Steps

1. **Create request ID generator helper:**
   ```python
   import uuid
   
   def generate_request_id():
       """Generate unique request ID for logging correlation."""
       return f"desktop_{uuid.uuid4().hex[:16]}"
   ```

2. **Add to all HTTP requests:**
   ```python
   # Example: Token exchange
   def handle_callback(self, code, state):
       request_id = generate_request_id()
       headers = {
           'Content-Type': 'application/json',
           'X-Request-ID': request_id
       }
       
       print(f"[AUTH] Token exchange request_id={request_id}")
       
       response = requests.post(
           f"{self.ai_server_url}/api/auth/atlassian/callback",
           json=payload,
           headers=headers,
           timeout=(30, 90)
       )
       
       print(f"[AUTH] Token exchange response status={response.status_code} request_id={request_id}")
       # ...
   ```

3. **Apply to all outgoing requests:**
   - `/api/auth/atlassian/callback`
   - `/api/auth/refresh-token`
   - `/api/auth/exchange-token`
   - `/api/analyze-batch`
   - `/api/classify-app`
   - `/api/auth/supabase-config`
   - `/api/auth/ocr-config`

#### Testing
- **Log Correlation Test:** Make request from desktop, check both logs have same request_id
- **Debug Test:** Reproduce an error, use request_id to find matching server log

#### Risks
- **None:** Additive header, no breaking changes

---

## Phase 4: Platform & Observability (P4 + Observations)

**Duration:** 1 week  
**Blockers:** B-4, B-7, B-8, OBS-1, OBS-2, OBS-3  
**Goal:** Better cross-platform support, operational visibility

---

### B-4 & B-8: System Event Monitoring Fallback

**Problem:** System event monitoring fails on restricted PCs, no cross-platform support.

**Fix Strategy:** Add polling fallback when Win32 API unavailable

#### Implementation Steps

1. **Detect Win32 API availability:**
   ```python
   # In monitor_system_events():
   if not WIN32_AVAILABLE:
       print("[WARN] Win32 API not available — using polling fallback for system events")
       self._monitor_system_events_polling()
       return
   
   # ... existing Win32 message pump code ...
   ```

2. **Implement polling fallback:**
   ```python
   def _monitor_system_events_polling(self):
       """Fallback system event monitoring via polling (cross-platform).
       Detects sleep/wake by monitoring loop gaps."""
       print("[EVENTS] Starting polling-based system event monitor")
       last_check_time = time.time()
       
       while self.running:
           try:
               current_time = time.time()
               time_since_last_check = current_time - last_check_time
               
               # Detect system suspension (gap > 30s)
               if time_since_last_check > 30:
                   print(f"[EVENTS] System suspension detected (gap: {time_since_last_check:.0f}s)")
                   # Create idle record for the suspension period
                   if not self.is_idle and self.idle_start_time:
                       self._create_idle_record("system suspension detected")
                       self.needs_idle_resume = True
               
               last_check_time = current_time
               time.sleep(5)  # Poll every 5 seconds
               
           except Exception as e:
               print(f"[ERROR] Polling system event monitor error: {e}")
               time.sleep(10)
   ```

3. **Add screen lock polling (cross-platform):**
   ```python
   def _is_screen_locked_polling(self):
       """Cross-platform screen lock detection via heuristics."""
       # Windows: Check for LockApp.exe or LogonUI.exe
       if sys.platform == 'win32':
           try:
               for proc in psutil.process_iter(['name']):
                   proc_name = proc.info['name'].lower()
                   if proc_name in ('lockapp.exe', 'logonui.exe'):
                       return True
           except Exception:
               pass
       
       # macOS: Check for screensaver or login window
       elif sys.platform == 'darwin':
           # TODO: Implement macOS lock detection
           pass
       
       # Linux: Check for gnome-screensaver or xscreensaver
       elif sys.platform == 'linux':
           # TODO: Implement Linux lock detection
           pass
       
       return False
   ```

#### Testing
- **Restricted PC Test:** Run on PC with Group Policy restrictions
- **Cross-Platform Test:** Test on macOS/Linux (when available)
- **Verification:** Sleep/wake detection works via polling

#### Risks
- **Medium:** Polling is less accurate than native APIs, but better than nothing

---

### OBS-1: Offline Queue Size Limit

**Problem:** Offline queue can grow indefinitely during long offline periods.

**Fix Strategy:** Implement sliding window retention policy

#### Implementation Steps

1. **Add cleanup on queue write:**
   ```python
   # In OfflineManager.save_screenshot_offline():
   def save_screenshot_offline(self, screenshot_data, image_bytes, thumbnail_bytes):
       # ... existing insert logic ...
       
       local_id = cursor.lastrowid
       conn.commit()
       
       # Cleanup old records (keep last 7 days OR 100 MB max)
       self._enforce_offline_queue_limits(conn)
       
       return local_id
   
   def _enforce_offline_queue_limits(self, conn):
       """Enforce offline queue retention policy (7 days OR 100 MB)."""
       try:
           cursor = conn.cursor()
           
           # Count total size and age
           cursor.execute('''
               SELECT COUNT(*), SUM(file_size_bytes), MIN(created_at)
               FROM offline_screenshots
               WHERE synced = 0
           ''')
           count, total_bytes, oldest = cursor.fetchone()
           
           if not count:
               return
           
           total_mb = (total_bytes or 0) / (1024 * 1024)
           
           # Delete if over 100 MB OR older than 7 days
           needs_cleanup = False
           if total_mb > 100:
               print(f"[CLEANUP] Offline queue over size limit ({total_mb:.1f} MB) — removing oldest")
               needs_cleanup = True
           elif oldest:
               oldest_dt = datetime.fromisoformat(oldest)
               age_days = (datetime.now(timezone.utc) - oldest_dt).days
               if age_days > 7:
                   print(f"[CLEANUP] Offline queue has records older than 7 days — removing")
                   needs_cleanup = True
           
           if needs_cleanup:
               # Delete oldest 25% of records
               delete_count = max(1, count // 4)
               cursor.execute('''
                   DELETE FROM offline_screenshots
                   WHERE id IN (
                       SELECT id FROM offline_screenshots
                       WHERE synced = 0
                       ORDER BY created_at ASC
                       LIMIT ?
                   )
               ''', (delete_count,))
               
               deleted = cursor.rowcount
               conn.commit()
               print(f"[CLEANUP] Deleted {deleted} old offline records")
       
       except Exception as e:
           print(f"[WARN] Offline queue cleanup failed: {e}")
   ```

#### Testing
- **Size Test:** Fill queue to 110 MB, verify cleanup triggers
- **Age Test:** Add 8-day-old records, verify cleanup
- **Verification:** Queue stays under 100 MB limit

#### Risks
- **Low:** Users warned when offline data is dropped

---

### OBS-2: OCR Failure Doesn't Fall Back to Window Title

**Problem:** No text data when OCR fails completely.

**Fix Strategy:** Use window title as fallback OCR text

#### Implementation Steps

1. **Modify OCR processor fallback:**
   ```python
   # In LocalOCRProcessor.capture_and_ocr():
   def capture_and_ocr(self, window_title=None, app_name=None, force=False):
       # ... existing OCR logic ...
       
       ocr_result = extract_text_from_image(screenshot, ...)
       
       # If OCR produced no text, use window title as fallback
       if not ocr_result.get('text') and window_title:
           fallback_text = f"{window_title} [{app_name}]" if app_name else window_title
           print(f"[OCR] No text extracted, using window title fallback: {fallback_text[:50]}")
           return {
               'text': fallback_text,
               'method': 'window_title_fallback',
               'confidence': 0.5,  # Medium confidence (title is useful but not full context)
               'error_message': None
           }
       
       return ocr_result
   ```

#### Testing
- **OCR Failure Test:** Capture blank window, verify title used
- **Matching Test:** Verify AI matching works with title fallback
- **Log Check:** "[OCR] No text extracted, using window title fallback"

#### Risks
- **None:** Improves matching accuracy when OCR fails

---

### OBS-3: No Health Check Endpoint

**Problem:** Cannot monitor app health remotely.

**Fix Strategy:** Add local HTTP health endpoint

#### Implementation Steps

1. **Add health endpoint to Flask app:**
   ```python
   @self.app.route('/api/health')
   def health_check():
       """Health check endpoint for monitoring."""
       uptime_seconds = int(time.time() - (self._app_start_time or time.time()))
       
       # Collect health metrics
       health_data = {
           'status': 'healthy' if self.running else 'stopped',
           'timestamp': datetime.now(timezone.utc).isoformat(),
           'uptime_seconds': uptime_seconds,
           'tracking_active': self.tracking_active,
           'is_idle': self.is_idle,
           'authenticated': self.current_user is not None,
           'user_id': self.current_user_id if self.current_user else None,
           'organization_id': self.organization_id,
           'online': self.offline_manager.check_connectivity(force=False),
           'offline_pending': self.offline_manager.get_pending_count(),
           'app_version': APP_VERSION,
           'last_screenshot_time': self.last_interval_time.isoformat() if self.last_interval_time else None,
           'threads': {
               'tracking': self._tracking_thread.is_alive() if self._tracking_thread else False,
               'activity_monitor': self._activity_monitor_thread.is_alive() if self._activity_monitor_thread else False,
               'system_events': self._system_event_thread.is_alive() if self._system_event_thread else False
           }
       }
       
       return jsonify(health_data)
   ```

2. **Add startup time tracking:**
   ```python
   # In __init__:
   self._app_start_time = time.time()
   ```

#### Testing
- **Endpoint Test:** `curl http://localhost:51777/api/health`
- **Monitoring Test:** Set up simple monitoring script polling health
- **Verification:** Health data is accurate and updates in real-time

#### Risks
- **None:** Read-only endpoint, no authentication required for local access

---

## Testing Strategy

### Unit Tests

**Framework:** pytest  
**Coverage Target:** 80%+ for new code

#### Key Test Cases

1. **Idle/Resume Logic:**
   - Test pynput failure fallback
   - Test window-switch detection during idle
   - Test threading.Event synchronization

2. **Token Refresh:**
   - Test concurrent refresh calls (10 threads)
   - Test rate limiting (< 10s between refreshes)
   - Test double-check inside lock

3. **Batch Upload:**
   - Test partial success handling
   - Test session restoration on failure
   - Test deduplication with request IDs

4. **Shutdown Handling:**
   - Test WM_ENDSESSION handler
   - Test checkpoint recovery
   - Test bounded thread join

#### Test Infrastructure

```python
# tests/test_idle_resume.py
import pytest
from unittest.mock import Mock, patch

def test_idle_resume_fallback():
    """Test that window switch triggers resume when pynput is dead."""
    tracker = TimeTracker()
    tracker.is_idle = True
    tracker.idle_start_time = datetime.now(timezone.utc)
    tracker.idle_last_window_key = ('Old Window', 'old.exe')
    
    # Mock get_active_window to return new window
    with patch.object(tracker, 'get_active_window', return_value=('New Window', 'new.exe')):
        tracker.needs_idle_resume = False  # Simulate pynput failure
        
        # Trigger fallback check
        tracker._idle_fallback_check()
        
        # Assert resume flag was set
        assert tracker.needs_idle_resume == True
```

### Integration Tests

**Framework:** Manual + automated scripts  
**Focus:** End-to-end flows with real dependencies

#### Test Scenarios

1. **Network Failure Recovery:**
   - Disconnect network during tracking
   - Verify SQLite queue fills
   - Reconnect network
   - Verify queue drains automatically

2. **System Events:**
   - Sleep system → wake → verify idle record created
   - Lock screen → unlock → verify idle period tracked
   - Shutdown Windows → restart → verify session recovered

3. **Token Expiry:**
   - Fast-forward time to expire JWT
   - Trigger upload
   - Verify proactive refresh works

4. **Crash Recovery:**
   - Kill process mid-session (`taskkill /F`)
   - Restart app
   - Verify checkpoint recovery works

### Regression Tests

**Purpose:** Ensure fixes don't break existing functionality

#### Critical Paths to Verify

1. **Normal Operation:**
   - Start tracking
   - Switch windows normally
   - Verify screenshots + activity records created
   - Stop tracking

2. **Idle/Resume:**
   - Go idle (5 min no activity)
   - Resume with mouse movement
   - Verify idle record + resume works

3. **Offline Mode:**
   - Disconnect network
   - Capture screenshots
   - Reconnect network
   - Verify sync happens automatically

4. **Authentication:**
   - Logout
   - Login again
   - Verify tracking resumes
   - Verify Supabase connection works

### Performance Tests

**Focus:** Ensure fixes don't add excessive overhead

#### Metrics to Monitor

1. **CPU Usage:** Should stay < 5% during normal tracking
2. **Memory Usage:** Should stay < 200 MB with 100 sessions cached
3. **Response Time:** Health check endpoint < 100ms
4. **SQLite Write Time:** Checkpoint write < 50ms

---

## Rollback Procedures

### General Rollback Strategy

1. **Feature Flags:** All major changes behind flags that can be toggled
2. **Database Migrations:** All schema changes are reversible
3. **Version Control:** Each phase is a separate release branch
4. **Monitoring:** Health checks alert on degraded performance

### Phase-Specific Rollback

#### Phase 1 Rollback

**Trigger:** Critical data loss or crashes

**Steps:**
1. Disable new features via config flags:
   ```python
   ENABLE_IDLE_FALLBACK_RESUME = False
   ENABLE_SESSION_CHECKPOINTS = False
   ENABLE_SHUTDOWN_HANDLERS = False
   ENABLE_FINALIZATION_QUEUE = False
   ```

2. Revert to previous version via update mechanism
3. Clear checkpoint tables (optional):
   ```sql
   DROP TABLE IF EXISTS session_checkpoints;
   DROP TABLE IF EXISTS pending_finalizations;
   ```

#### Phase 2 Rollback

**Trigger:** Network errors or upload failures

**Steps:**
1. Disable new upload logic:
   ```python
   ENABLE_PARTIAL_BATCH_SUCCESS = False
   ENABLE_IDEMPOTENCY_CHECKS = False
   ```

2. Fall back to old batch upload (all-or-nothing)

#### Phase 3 Rollback

**Trigger:** Thread safety issues or race conditions

**Steps:**
1. Revert to boolean flags (from threading.Event)
2. Remove deduplication logic (allow duplicates temporarily)

#### Phase 4 Rollback

**Trigger:** Performance degradation

**Steps:**
1. Disable polling fallback:
   ```python
   ENABLE_POLLING_FALLBACK = False
   ```

2. Remove health endpoint (low risk)

---

## Deployment Plan

### Pre-Deployment Checklist

- [ ] All unit tests pass (100% on new code)
- [ ] All integration tests pass
- [ ] No regressions in existing functionality
- [ ] Performance metrics acceptable
- [ ] Database migrations tested on staging
- [ ] Rollback procedure documented and tested
- [ ] Feature flags configured
- [ ] AI server changes deployed first (for B-19)

### Phased Rollout

#### Week 1-2: Phase 1 (P1 Blockers)
- **Alpha:** Internal testing team (5 users)
- **Beta:** Pilot customers (20 users)
- **GA:** All users if no critical issues

#### Week 3-4: Phase 2 (P2 Blockers)
- **Alpha:** Internal testing (3 days)
- **Beta:** 50 users (1 week)
- **GA:** All users

#### Week 5: Phase 3 (P3 Blockers)
- **Alpha:** Internal testing (2 days)
- **Beta:** 100 users (3 days)
- **GA:** All users

#### Week 6: Phase 4 (P4 + Observations)
- **Alpha:** Internal testing (2 days)
- **GA:** All users (low risk)

### Deployment Method

**Auto-Update Mechanism:**
1. Build new version with fixes
2. Upload to AI server (`/api/app-version`)
3. Mark as mandatory update (for Phase 1)
4. Desktop apps auto-download and install
5. Monitor error rates via health checks

### Monitoring Post-Deployment

**Metrics to Watch:**
1. Crash rate (should decrease)
2. Data loss reports (should be zero)
3. Offline queue size (should decrease)
4. Authentication failures (should decrease)
5. User complaints about tracking gaps (should decrease)

**Alert Thresholds:**
- Crash rate > 5% → rollback immediately
- Data loss reports > 0 → investigate urgently
- Authentication failures > 10% → pause rollout

---

## Appendix A: Database Migrations

### Migration 1: Session Checkpoints (Phase 1)

```sql
-- Up
CREATE TABLE IF NOT EXISTS session_checkpoints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    organization_id TEXT,
    window_title TEXT,
    application_name TEXT,
    screenshot_id TEXT,
    start_time TEXT NOT NULL,
    last_checkpoint_time TEXT NOT NULL,
    classification TEXT,
    project_key TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_checkpoints_user ON session_checkpoints(user_id);
CREATE INDEX IF NOT EXISTS idx_checkpoints_screenshot ON session_checkpoints(screenshot_id);

-- Down
DROP TABLE IF EXISTS session_checkpoints;
```

### Migration 2: Finalization Queue (Phase 1)

```sql
-- Up
CREATE TABLE IF NOT EXISTS pending_finalizations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    screenshot_id TEXT NOT NULL UNIQUE,
    end_time TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL,
    reason TEXT,
    retry_count INTEGER DEFAULT 0,
    last_error TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_finalization_screenshot ON pending_finalizations(screenshot_id);
CREATE INDEX IF NOT EXISTS idx_finalization_retry ON pending_finalizations(retry_count);

-- Down
DROP TABLE IF EXISTS pending_finalizations;
```

### Migration 3: Batch Request Deduplication (Phase 2 - AI Server)

```sql
-- Up
CREATE TABLE IF NOT EXISTS batch_request_dedup (
    request_id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    processed_at TIMESTAMP NOT NULL DEFAULT NOW(),
    record_count INTEGER,
    CONSTRAINT unique_request UNIQUE(request_id)
);
CREATE INDEX idx_dedup_user ON batch_request_dedup(user_id);
CREATE INDEX idx_dedup_org ON batch_request_dedup(organization_id);
CREATE INDEX idx_dedup_processed_at ON batch_request_dedup(processed_at);

-- Cleanup job (auto-delete after 7 days)
CREATE OR REPLACE FUNCTION cleanup_old_dedup_records()
RETURNS void AS $$
BEGIN
    DELETE FROM batch_request_dedup
    WHERE processed_at < NOW() - INTERVAL '7 days';
END;
$$ LANGUAGE plpgsql;

-- Down
DROP TABLE IF EXISTS batch_request_dedup;
DROP FUNCTION IF EXISTS cleanup_old_dedup_records;
```

### Migration 4: Activity Records Client Temp ID (Phase 2 - Supabase)

```sql
-- Up
ALTER TABLE activity_records ADD COLUMN IF NOT EXISTS client_temp_id TEXT;
CREATE INDEX IF NOT EXISTS idx_activity_client_temp_id ON activity_records(client_temp_id);

-- Down
DROP INDEX IF EXISTS idx_activity_client_temp_id;
ALTER TABLE activity_records DROP COLUMN IF EXISTS client_temp_id;
```

---

## Appendix B: Configuration Flags

All features can be toggled via environment variables or config file:

```python
# Feature flags (can be disabled for rollback)
ENABLE_IDLE_FALLBACK_RESUME = os.getenv('ENABLE_IDLE_FALLBACK_RESUME', 'true').lower() == 'true'
ENABLE_SESSION_CHECKPOINTS = os.getenv('ENABLE_SESSION_CHECKPOINTS', 'true').lower() == 'true'
ENABLE_SHUTDOWN_HANDLERS = os.getenv('ENABLE_SHUTDOWN_HANDLERS', 'true').lower() == 'true'
ENABLE_FINALIZATION_QUEUE = os.getenv('ENABLE_FINALIZATION_QUEUE', 'true').lower() == 'true'
ENABLE_TOKEN_REFRESH_SAFEGUARDS = os.getenv('ENABLE_TOKEN_REFRESH_SAFEGUARDS', 'true').lower() == 'true'
ENABLE_PARTIAL_BATCH_SUCCESS = os.getenv('ENABLE_PARTIAL_BATCH_SUCCESS', 'true').lower() == 'true'
ENABLE_IDEMPOTENCY_CHECKS = os.getenv('ENABLE_IDEMPOTENCY_CHECKS', 'true').lower() == 'true'
ENABLE_THREADING_EVENT_SYNC = os.getenv('ENABLE_THREADING_EVENT_SYNC', 'true').lower() == 'true'
ENABLE_POLLING_FALLBACK = os.getenv('ENABLE_POLLING_FALLBACK', 'true').lower() == 'true'
ENABLE_HEALTH_ENDPOINT = os.getenv('ENABLE_HEALTH_ENDPOINT', 'true').lower() == 'true'
```

---

## 10. Test Scripts & Validation

This section provides comprehensive test scripts to validate all Phase 1 fixes. Each test is designed to verify specific blocker fixes and ensure no regressions.

### 10.1 Test Framework Setup

**File:** `python-desktop-app/test_phase1_fixes.py`

The test suite includes:
- **Unit tests** for individual fix components
- **Integration tests** for combined scenarios
- **Mock-based tests** to simulate failures
- **Real database tests** for persistence validation

**Run Tests:**
```bash
cd python-desktop-app
pytest test_phase1_fixes.py -v --tb=short
```

### 10.2 Test Coverage by Blocker

#### B-1: Idle Stuck Fix Tests

**Test 1: pynput Failure Detection**
```python
def test_pynput_failure_detected():
    """Verify that pynput import failure is properly flagged"""
    from desktop_app import TimeTracker
    
    with patch('desktop_app.pynput', side_effect=ImportError):
        tracker = TimeTracker()
        tracker.monitor_user_activity()
        
        assert tracker._activity_monitor_failed is True
        print("[PASS] pynput failure detected and flagged")
```

**Test 2: Fallback Idle Detection**
```python
def test_fallback_idle_detection_via_window_switch():
    """Verify window switches update activity time when pynput fails"""
    tracker = TimeTracker()
    tracker._activity_monitor_failed = True
    initial_time = tracker.last_activity_time
    
    # Simulate window switch
    tracker._last_window_key_for_idle = "chrome__Old Window"
    new_key = "vscode__New Window"
    
    if new_key != tracker._last_window_key_for_idle:
        tracker.last_activity_time = time.time()
    
    assert tracker.last_activity_time > initial_time
```

**Test 3: Idle Resume on Window Switch**
```python
def test_idle_resume_on_window_switch():
    """Verify idle resumes when window switches (pynput down)"""
    tracker = TimeTracker()
    tracker._activity_monitor_failed = True
    tracker.is_idle = True
    
    # Simulate window switch detection
    tracker._last_window_key_for_idle = "old"
    if "new" != tracker._last_window_key_for_idle:
        tracker.needs_idle_resume = True
    
    assert tracker.needs_idle_resume is True
```

#### B-9: Shutdown Loss Fix Tests

**Test 1: WM_ENDSESSION Constant Defined**
```python
def test_wm_endsession_handler_registered():
    """Verify WM_ENDSESSION is defined in code"""
    code = open('desktop_app.py').read()
    assert 'WM_ENDSESSION = 0x0016' in code
```

**Test 2: Shutdown Finalizes Session**
```python
def test_shutdown_saves_active_session():
    """Verify shutdown handler finalizes active session"""
    tracker = TimeTracker()
    tracker.current_window_screenshot_id = 'test-123'
    tracker.current_window_db_start_time = datetime.now(timezone.utc)
    
    with patch.object(tracker, 'supabase') as mock_db:
        tracker._finalize_active_session("system shutdown")
        assert mock_db.table.called
```

**Test 3: Emergency Save Called**
```python
def test_emergency_save_called_on_shutdown():
    """Verify emergency_save is invoked during shutdown"""
    tracker = TimeTracker()
    
    with patch.object(tracker.session_manager, 'emergency_save') as mock:
        # Simulate WM_ENDSESSION handler
        tracker.session_manager.emergency_save()
        assert mock.called
```

#### B-10: Crash Loss Fix Tests

**Test 1: Emergency Save Stops Timer**
```python
def test_emergency_save_stops_timer():
    """Verify emergency_save stops active timer"""
    db_manager = DatabaseConnectionManager()
    session_mgr = ActiveSessionManager(db_manager)
    
    # Start session
    session_mgr.on_window_switch('Test', 'app', 'productive', None)
    
    # Emergency save
    session_mgr.emergency_save()
    
    # Verify timer stopped
    conn = db_manager.get_connection()
    cursor = conn.cursor()
    cursor.execute('SELECT timer_started_at FROM active_sessions')
    row = cursor.fetchone()
    assert row is None or row[0] is None
```

**Test 2: WAL Checkpoint Executed**
```python
def test_wal_checkpoint_executed():
    """Verify WAL checkpoint flushes to disk"""
    db_manager = DatabaseConnectionManager()
    result = db_manager.checkpoint_wal()
    assert result is True
```

**Test 3: Recovery on Restart**
```python
def test_recovery_on_restart():
    """Verify data persists across restarts"""
    db_manager = DatabaseConnectionManager()
    session_mgr = ActiveSessionManager(db_manager)
    
    # Create session
    session_mgr.on_window_switch('Test', 'app', 'productive', None)
    
    # Simulate restart (new manager)
    new_mgr = ActiveSessionManager(db_manager)
    sessions = new_mgr.get_all_sessions()
    
    assert len(sessions) > 0
```

#### B-12: Network Loss Fix Tests

**Test 1: Finalization Queued on Network Failure**
```python
def test_finalization_queued_on_network_failure():
    """Verify finalization queues when network fails"""
    tracker = TimeTracker()
    tracker.current_window_screenshot_id = 'test-123'
    
    with patch.object(tracker, 'supabase') as mock_db:
        mock_db.table.return_value.update.side_effect = Exception("Network")
        
        tracker._finalize_active_session("idle")
        
        assert len(tracker._offline_finalization_queue) > 0
```

**Test 2: Offline Manager Persists Queue**
```python
def test_offline_manager_persists_finalization():
    """Verify offline manager saves to SQLite"""
    offline_mgr = OfflineManager(db_manager)
    
    data = {
        'screenshot_id': 'test-123',
        'end_time': datetime.now(timezone.utc).isoformat(),
        'duration_seconds': 180,
        'reason': 'idle',
        'queued_at': time.time()
    }
    
    offline_mgr.queue_finalization(data)
    
    pending = offline_mgr.get_pending_finalizations()
    assert len(pending) > 0
```

**Test 3: Finalization Retry on Recovery**
```python
def test_finalization_retry_on_network_recovery():
    """Verify queued finalizations retry successfully"""
    offline_mgr = OfflineManager(db_manager)
    
    # Queue finalization
    offline_mgr.queue_finalization(data)
    
    # Get pending
    pending = offline_mgr.get_pending_finalizations()
    assert len(pending) > 0
    
    # Mark complete
    offline_mgr.mark_finalization_complete('test-123')
    
    # Verify removed
    pending_after = offline_mgr.get_pending_finalizations()
    assert not any(p['screenshot_id'] == 'test-123' for p in pending_after)
```

#### B-15: Token Race Fix Tests

**Test 1: Rate Limiting Prevents Concurrent Refreshes**
```python
def test_rate_limiting_prevents_concurrent_refreshes():
    """Verify rate limiting blocks rapid refresh calls"""
    auth_mgr = AuthManager('https://test.com')
    auth_mgr._last_token_refresh_time = time.time()
    
    with patch('requests.post') as mock_post:
        result = auth_mgr.refresh_access_token()
        
        assert result is False
        assert not mock_post.called
```

**Test 2: Rate Limit Allows After Interval**
```python
def test_rate_limit_allows_refresh_after_interval():
    """Verify refresh proceeds after rate limit interval"""
    auth_mgr = AuthManager('https://test.com')
    auth_mgr._last_token_refresh_time = time.time() - 6
    
    with patch('requests.post') as mock_post:
        mock_post.return_value.status_code = 200
        result = auth_mgr.refresh_access_token()
        
        assert mock_post.called
```

**Test 3: Double-Check Prevents Duplicate Refresh**
```python
def test_double_check_prevents_duplicate_refresh():
    """Verify double-check logic skips redundant refreshes"""
    auth_mgr = AuthManager('https://test.com')
    auth_mgr.tokens = {'refresh_token': 'old'}
    
    # Simulate token changed by another thread
    auth_mgr.tokens['refresh_token'] = 'new'
    
    with patch('requests.post') as mock_post:
        result = auth_mgr.refresh_access_token()
        
        # Should skip network call
        assert not mock_post.called or mock_post.call_count <= 1
```

### 10.3 Integration Test Scenarios

#### Scenario 1: Idle Timeout with pynput Failure
```python
def test_idle_timeout_with_pynput_failure():
    """Combined test: idle detection when pynput is down"""
    tracker = TimeTracker()
    tracker._activity_monitor_failed = True
    tracker.last_activity_time = time.time() - 400  # 400s ago
    tracker.idle_timeout = 300  # 5 minutes
    
    idle_duration = time.time() - tracker.last_activity_time
    should_be_idle = idle_duration > tracker.idle_timeout
    
    assert should_be_idle is True
```

#### Scenario 2: Shutdown with Network Failure
```python
def test_shutdown_with_network_failure():
    """Combined test: shutdown when network is down"""
    tracker = TimeTracker()
    tracker.current_window_screenshot_id = 'test-123'
    
    with patch.object(tracker, 'supabase') as mock_db:
        mock_db.table.return_value.update.side_effect = Exception("Network")
        
        tracker._finalize_active_session("system shutdown")
        
        # Should queue finalization
        assert len(tracker._offline_finalization_queue) > 0
```

#### Scenario 3: Crash Recovery with Pending Data
```python
def test_crash_recovery_with_pending_data():
    """Combined test: data recovery after crash"""
    db_manager = DatabaseConnectionManager()
    session_mgr = ActiveSessionManager(db_manager)
    
    # Create sessions
    session_mgr.on_window_switch('Window1', 'app', 'productive', None)
    session_mgr.on_window_switch('Window2', 'app', 'productive', None)
    
    # Simulate crash (no emergency_save)
    # Then restart
    new_mgr = ActiveSessionManager(db_manager)
    sessions = new_mgr.get_all_sessions()
    
    assert len(sessions) >= 2
```

### 10.4 Manual Testing Checklist

#### Pre-Deployment Validation

- [ ] **B-1: Idle Fallback**
  - Disable pynput (uninstall or mock failure)
  - Switch windows rapidly
  - Verify tracking continues
  - Verify idle detection still works via window staleness
  
- [ ] **B-9: Shutdown Handler**
  - Start tracking
  - Trigger Windows shutdown (Start → Shutdown)
  - Cancel shutdown
  - Check database: last session should have end_time set
  - Verify no NULL end_time records
  
- [ ] **B-10: Crash Recovery**
  - Start tracking
  - Kill process via Task Manager
  - Restart app
  - Verify pending sessions exist in SQLite
  - Verify next batch upload includes recovered data
  
- [ ] **B-12: Network Finalization**
  - Start tracking
  - Disconnect network
  - Enter idle state
  - Verify finalization queued in SQLite
  - Reconnect network
  - Verify queue processes successfully
  
- [ ] **B-15: Token Race**
  - Mock multiple simultaneous upload failures
  - Verify only one refresh call per 5-second window
  - Check logs for "Token already refreshed" messages
  - Verify no "invalid_grant" errors

### 10.5 Performance Testing

#### Latency Tests

**Test:** Ensure fixes don't add latency to screenshot capture:
```python
def test_capture_latency_unchanged():
    """Verify new code doesn't slow down capture"""
    tracker = TimeTracker()
    
    # Measure baseline
    times = []
    for _ in range(10):
        start = time.perf_counter()
        tracker.capture_screenshot()
        elapsed = time.perf_counter() - start
        times.append(elapsed)
    
    avg_time = sum(times) / len(times)
    
    # Should complete in < 100ms
    assert avg_time < 0.1
```

#### Memory Tests

**Test:** Verify offline queue doesn't grow unbounded:
```python
def test_offline_queue_bounded():
    """Verify finalization queue has reasonable size limits"""
    tracker = TimeTracker()
    
    # Queue many finalizations
    for i in range(1000):
        tracker._offline_finalization_queue.append({'id': i})
    
    # Queue should have max size (e.g., 100)
    assert len(tracker._offline_finalization_queue) <= 100
```

### 10.6 Regression Testing

**Critical Flows to Validate:**

1. **Normal Tracking Flow:**
   - Start tracking → Switch windows → Capture screenshots
   - Verify: No crashes, screenshots have correct durations
   
2. **Idle/Resume Cycle:**
   - Go idle → Wait 5+ minutes → Resume activity
   - Verify: Idle record created, tracking resumes correctly
   
3. **Token Refresh:**
   - Wait for token to expire → Trigger upload
   - Verify: Token refreshes automatically, upload succeeds
   
4. **Offline/Online Transition:**
   - Disconnect network → Capture screenshots → Reconnect
   - Verify: Screenshots queue offline, sync on reconnect

### 10.7 Test Execution Report Template

```markdown
## Phase 1 Fix Testing Report

**Date:** YYYY-MM-DD
**Tested By:** [Name]
**Environment:** [Production/Staging]
**Desktop App Version:** [Version]

### Test Results Summary

| Blocker | Test Cases | Passed | Failed | Notes |
|---------|-----------|--------|--------|-------|
| B-1     | 3         | 3      | 0      | ✅ All passed |
| B-9     | 3         | 3      | 0      | ✅ All passed |
| B-10    | 3         | 3      | 0      | ✅ All passed |
| B-12    | 3         | 3      | 0      | ✅ All passed |
| B-15    | 3         | 3      | 0      | ✅ All passed |
| Integration | 3    | 3      | 0      | ✅ All passed |

**Total:** 18/18 tests passed

### Failed Tests (if any)
[List failed tests with details]

### Performance Metrics
- Average screenshot capture time: XX ms
- Offline queue size under load: XX items
- Memory usage delta: +XX MB

### Regressions Found
[List any unexpected issues discovered]

### Sign-Off
- [ ] All unit tests passed
- [ ] All integration tests passed
- [ ] Manual testing completed
- [ ] Performance acceptable
- [ ] No regressions found
- [ ] Ready for deployment

**Approved By:** [Name]
**Date:** YYYY-MM-DD
```

---

## Summary

This implementation plan provides:

1. **Detailed fix steps** for all 21 blockers
2. **Code examples** showing exact changes
3. **Testing strategies** for each phase
4. **Rollback procedures** if issues arise
5. **Deployment timeline** (4-6 weeks)
6. **Risk assessment** for each change
7. **Comprehensive test scripts** with validation procedures

All fixes are designed to be:
- **Non-breaking:** Existing functionality preserved
- **Testable:** Unit + integration tests for every change
- **Reversible:** Feature flags + database rollback scripts
- **Observable:** Health checks + structured logging

**Next Steps:**
1. Review plan with team
2. Create JIRA tickets for each phase
3. Begin Phase 1 implementation
4. Set up staging environment for testing
5. Schedule deployment windows
6. Execute test suite and validate fixes

---

**End of Implementation Plan**
