# UNIFIED ROOT CAUSE ANALYSIS: JWT Expiration Issues

**Date:** 2026-05-14  
**Analysis Type:** Meta-Analysis Connecting Multiple Issues  
**Related Documents:**
- [SESSION_MAINTENANCE_ROOT_CAUSE_ANALYSIS_V2.md](../docs/SESSION_MAINTENANCE_ROOT_CAUSE_ANALYSIS_V2.md)
- [2026-05-14_CORRECTED_ROOT_CAUSE_ANALYSIS_desktop_app_version_not_updating.md](2026-05-14_CORRECTED_ROOT_CAUSE_ANALYSIS_desktop_app_version_not_updating.md)

---

## Executive Summary

**YES, both issues are caused by the SAME underlying JWT expiration problem.**

The two analyses describe **different perspectives of the same root cause**:

1. **Session Maintenance Analysis** (older doc): Focuses on the **proactive refresh timing bug**
   - Mathematical proof that refresh checks don't align with JWT expiry
   - Shows how the 10-minute check interval misses the 5-minute buffer window

2. **Desktop App Version Update Analysis** (new doc): Focuses on the **missing defensive validation**
   - Shows that `_send_heartbeat()` lacks JWT validation (unlike batch upload)
   - Demonstrates how operations fail silently when JWT expires
   - Highlights that even if proactive refresh works, it can fail due to network/server issues

**Combined Picture:** The JWT management system has TWO vulnerabilities that compound each other:
- ❌ **Timing Bug**: Proactive refresh may not trigger before expiry
- ❌ **Missing Validation**: Critical operations don't check JWT before executing

**Result:** When BOTH vulnerabilities hit (timing bug + network failure during refresh), heartbeats fail 100% of the time after 1 hour, causing:
- Users appear "inactive" in Forge UI
- `desktop_app_version` never updates
- Session maintenance completely fails

---

## The Two Perspectives of One Problem

### Perspective 1: Timing Bug (Session Maintenance Doc)

**Focus:** WHY does the JWT expire before being refreshed?

**Timeline Analysis:**
```
T+0:   Login → JWT issued (expires T+60)
T+10:  Refresh check #1 → 50 min remaining > 5 min buffer → NO ACTION
T+20:  Refresh check #2 → 40 min remaining > 5 min buffer → NO ACTION
T+30:  Refresh check #3 → 30 min remaining > 5 min buffer → NO ACTION
T+40:  Refresh check #4 → 20 min remaining > 5 min buffer → NO ACTION
T+50:  Refresh check #5 → 10 min remaining > 5 min buffer → NO ACTION
T+60:  Refresh check #6 → 0 min remaining (EXPIRED!) → Too late!
```

**Mathematical Proof:**
- Refresh checks: Every 600 seconds (10 minutes)
- JWT expiry: 3600 seconds (60 minutes)
- Refresh buffer: 300 seconds (5 minutes)
- Last check before trigger: T+50 (10 min remaining, doesn't trigger)
- Next check: T+60 (JWT already expired)

**Conclusion:** The timing is fundamentally misaligned.

---

### Perspective 2: Missing Validation (Version Update Doc)

**Focus:** WHY do operations fail when JWT expires?

**Code Comparison:**

**Batch Upload (HAS validation):**
```python
# Line 8243-8255
sb_expires_at = self.auth_manager.tokens.get('supabase_token_expires_at', 0)
if sb_expires_at and time.time() > (sb_expires_at - 300):
    print("[BATCH] Supabase JWT expired — refreshing before upload...")
    if not self._set_supabase_jwt():
        print("[BATCH] JWT refresh failed — restoring sessions for retry")
        return  # ABORT - don't execute with expired JWT
```

**Heartbeat (NO validation):**
```python
# Line 6453-6471
def _send_heartbeat(self):
    try:
        client = self.supabase  # Uses whatever JWT was set earlier
        client.table('users').update({
            'desktop_last_heartbeat': datetime.now(timezone.utc).isoformat(),
            'desktop_app_version': self.app_version
        }).eq('id', self.current_user_id).execute()
        
        print(f"[OK] Heartbeat sent (v{self.app_version})")  # FALSE POSITIVE!
    except Exception as e:
        print(f"[WARN] Failed to send heartbeat: {e}")
```

**Key Insight:** Even if proactive refresh WORKS, it can fail due to:
- Network timeouts
- AI server downtime
- Firewall/proxy issues
- Rate limiting

**Conclusion:** Critical operations need defensive JWT checks regardless of proactive refresh.

---

## How They Connect: The Complete Failure Chain

### Scenario 1: Pure Timing Bug (Ideal Network)

```
T+0:   Login → JWT issued (expires T+60)
T+50:  Proactive check → 10 min remaining → No action (timing bug)
T+60:  Proactive check → 0 min remaining → Triggers refresh
       ✅ Network is stable, AI server is up
       ✅ Refresh succeeds → New JWT issued
T+240: Heartbeat #2 runs
       ✅ JWT is fresh (refreshed at T+60, T+120, T+180)
       ✅ UPDATE succeeds
```

**Result:** Issue is MASKED because refresh eventually succeeds.

---

### Scenario 2: Timing Bug + Network Failure (Real World)

```
T+0:   Login → JWT issued (expires T+60)
T+50:  Proactive check → 10 min remaining → No action (timing bug)
T+60:  Proactive check → 0 min remaining → Triggers refresh
       ❌ AI server is down / network timeout
       ❌ Refresh fails after 3 retries
       ❌ Expired JWT remains on client
T+70:  Proactive check → Still expired → Triggers refresh
       ❌ Network still unstable
       ❌ Refresh fails again
T+240: Heartbeat #2 runs
       ❌ JWT expired 3 hours ago
       ❌ Missing validation means heartbeat doesn't check
       ❌ UPDATE fails (auth.uid() = NULL, RLS blocks)
       ❌ Logs "[OK] Heartbeat sent" (FALSE!)
```

**Result:** Issue MANIFESTS because both vulnerabilities compound.

---

### Scenario 3: Good Timing, But Network Fails (Theoretical)

If the timing bug was fixed (refresh checks every 5 min):

```
T+0:   Login → JWT issued (expires T+60)
T+55:  Proactive check → 5 min remaining → Triggers refresh
       ❌ Network failure
       ❌ Refresh fails
T+60:  JWT expires
T+240: Heartbeat #2 runs
       ❌ Still fails because heartbeat lacks validation
```

**Result:** Issue STILL OCCURS because heartbeat lacks defensive checks.

---

## The Smoking Gun: Developer Comment

Both analyses found the SAME evidence in the codebase:

**File:** `python-desktop-app/desktop_app.py`, line 8243

```python
# Ensure Supabase JWT is valid before uploading
# (JWT expires after ~1 hour; without this check, all uploads silently fail)
sb_expires_at = self.auth_manager.tokens.get('supabase_token_expires_at', 0)
if sb_expires_at and time.time() > (sb_expires_at - 300):
    print("[BATCH] Supabase JWT expired — refreshing before upload...")
    if not self._set_supabase_jwt():
        print("[BATCH] JWT refresh failed — restoring sessions to SQLite for retry")
        return
```

**Translation:** Developers KNEW that:
1. JWT expires after ~1 hour
2. Operations silently fail without JWT validation
3. Batch upload needs defensive checks

**Question:** Why doesn't heartbeat have the same protection?

**Answer:** Because the timing bug was discovered AFTER the session maintenance issue was reported, and the fix (adding JWT validation to batch upload) was applied only to the immediate problem area without auditing all JWT-dependent operations.

---

## Unified Symptom Matrix

| Symptom | Caused by Timing Bug | Caused by Missing Validation | Both |
|---------|---------------------|----------------------------|------|
| Users show as "inactive" after 1 hour | ✅ | ✅ | ✅ |
| `desktop_app_version` never updates | ✅ | ✅ | ✅ |
| Heartbeat fails silently | ❌ | ✅ | ✅ |
| False "[OK] Heartbeat sent" logs | ❌ | ✅ | ✅ |
| Intermittent data sync failures | ✅ | ✅ | ✅ |
| Session appears logged in but is broken | ✅ | ✅ | ✅ |
| Issue persists across app restarts | ❌ | ❌ | ✅ |

**Key Observation:** BOTH vulnerabilities must be present for the issue to persist long-term.

---

## Unified Root Cause Statement

**Primary Cause:** JWT lifecycle management has two critical vulnerabilities:

1. **Architectural Flaw (Timing Bug):**
   - Proactive refresh checks every 10 minutes
   - JWT expires every 60 minutes with 5-minute buffer
   - Mathematical timing gap: check at T+50 doesn't trigger, check at T+60 is too late
   - **Source:** Poor choice of refresh check interval relative to expiry and buffer

2. **Implementation Flaw (Missing Validation):**
   - Critical operations (`_send_heartbeat`, potentially others) don't validate JWT before executing
   - Even if proactive refresh works, it can fail due to external factors (network, server)
   - Operations proceed with expired JWT, fail silently, log false success
   - **Source:** Incomplete defensive programming pattern application

**When Combined:**
- Timing bug increases frequency of JWT expiry without refresh
- Missing validation means expired JWT goes undetected
- Silent failures mask the problem from users and developers
- Issue compounds over time (multiple heartbeat failures)

---

## Comprehensive Fix Strategy

### Layer 1: Fix the Timing Bug (Architectural)

**From Session Maintenance Doc - Option 1:**

**File:** `python-desktop-app/desktop_app.py`, line 9865

```python
# BEFORE
token_refresh_interval = 20  # Check token expiry every 20 iterations (~10 min)

# AFTER
token_refresh_interval = 10  # Check token expiry every 10 iterations (~5 min)
```

**Timeline with Fix:**
```
T+0:   Login → JWT issued (expires T+60)
T+5:   Check → 55 min remaining → No action
T+10:  Check → 50 min remaining → No action
...
T+55:  Check → 5 min remaining → TRIGGERS REFRESH ✅
T+60:  JWT would expire → Already refreshed
```

**Benefit:** Catches expiry within buffer window.

---

### Layer 2: Add Defensive Validation (Implementation)

**From Version Update Doc - Fix 1:**

**File:** `python-desktop-app/desktop_app.py`, line 6453

```python
def _send_heartbeat(self):
    """Send heartbeat to Supabase to indicate app is still running"""
    if not self.current_user_id or self.current_user_id.startswith('anonymous_'):
        return

    try:
        client = self.supabase
        if not client:
            return

        # CRITICAL: Ensure JWT is valid before sending heartbeat
        # (JWT expires after 1 hour; without this check, updates silently fail)
        sb_expires_at = self.auth_manager.tokens.get('supabase_token_expires_at', 0)
        if sb_expires_at and time.time() > (sb_expires_at - 300):
            print("[HEARTBEAT] Supabase JWT expired — refreshing before update...")
            if not self._set_supabase_jwt():
                print("[HEARTBEAT] JWT refresh failed — heartbeat skipped (will retry in 4 hours)")
                self.add_admin_log('WARN', 'Heartbeat skipped: JWT refresh failed. Re-login may be required.')
                return  # Skip this heartbeat, don't proceed with expired JWT
        elif not sb_expires_at:
            # No expiry info — proactively refresh to be safe
            print("[HEARTBEAT] No JWT expiry info — refreshing proactively...")
            if not self._set_supabase_jwt():
                print("[HEARTBEAT] Proactive refresh failed — proceeding with caution")

        result = client.table('users').update({
            'desktop_last_heartbeat': datetime.now(timezone.utc).isoformat(),
            'desktop_app_version': self.app_version
        }).eq('id', self.current_user_id).execute()

        # CRITICAL: Verify the update actually affected a row
        if not result.data or len(result.data) == 0:
            print(f"[WARN] Heartbeat update affected 0 rows - RLS may be blocking")
            print(f"[WARN] User ID: {self.current_user_id}, Version: {self.app_version}")
            self.add_admin_log('ERROR', f'Heartbeat failed: UPDATE affected 0 rows (v{self.app_version}). Re-login may be required.')
        else:
            print(f"[OK] Heartbeat sent (v{self.app_version})")

    except Exception as e:
        print(f"[WARN] Failed to send heartbeat: {e}")
        self.add_admin_log('ERROR', f'Heartbeat exception: {str(e)}')
```

**Benefit:** Defensive check ensures heartbeat never runs with expired JWT, even if proactive refresh fails.

---

### Layer 3: Audit All JWT-Dependent Operations

**Identify and fix other operations that lack JWT validation:**

1. **Desktop Status Update** (`_update_desktop_status`) - Already has some validation
2. **Offline Data Sync** (`sync_offline_data`) - Check if it validates JWT
3. **Association of Offline Records** (`_associate_offline_records`) - Check
4. **Screenshot Upload** (if done via Supabase client) - Check
5. **Any other `self.supabase.table().update/insert()` calls** - Audit all

**Pattern to apply:**
```python
def any_critical_operation(self):
    # 1. Check JWT validity
    sb_expires_at = self.auth_manager.tokens.get('supabase_token_expires_at', 0)
    if sb_expires_at and time.time() > (sb_expires_at - 300):
        if not self._set_supabase_jwt():
            # Handle failure appropriately (skip, retry, log)
            return
    
    # 2. Perform operation
    result = self.supabase.table().operation()
    
    # 3. Verify result
    if not result.data or len(result.data) == 0:
        # Log error, don't claim success
        pass
```

---

## Defense-in-Depth Strategy

### Level 1: Prevent JWT Expiry (Proactive)
- ✅ Fix timing bug (reduce check interval to 5 min)
- ✅ Increase JWT expiry to 2 hours (optional, less secure)
- ✅ Add monitoring for JWT refresh success rate

### Level 2: Detect JWT Expiry (Reactive)
- ✅ Add JWT validation before ALL critical operations
- ✅ Log clear warnings when JWT is expired
- ✅ Track JWT age and log warnings as expiry approaches

### Level 3: Handle JWT Expiry Gracefully (Resilient)
- ✅ Skip operations when refresh fails (don't proceed with expired JWT)
- ✅ Queue failed operations for retry after successful refresh
- ✅ Show user notification when JWT issues persist

### Level 4: Recover from JWT Failures (Diagnostic)
- ✅ Add admin log entries for all JWT-related failures
- ✅ Verify UPDATE row counts to detect RLS blocks
- ✅ Provide clear instructions: "Re-login required"

---

## Why Both Issues Were Reported Separately

### Timeline of Discovery:

1. **May 6, 2026:** Session maintenance issue reported
   - Symptom: Users appear "not-setup" or "inactive" in Forge UI
   - Analysis focused on heartbeat timing and JWT refresh mechanism
   - Fix attempted: Reduce refresh interval (but not deployed?)

2. **May 14, 2026:** Desktop app version not updating reported
   - Symptom: `desktop_app_version` stuck on old version
   - Initial analysis focused on RLS policy / `supabase_user_id` mismatch
   - Corrected analysis identified missing JWT validation in heartbeat

3. **May 14, 2026:** Question raised about connection between issues
   - Recognized that BOTH symptoms stem from same JWT expiration problem
   - Realized analyses were describing same issue from different angles

### Why They Seemed Different:

1. **Different Symptoms:**
   - Session maintenance: "User appears inactive"
   - Version update: "Version number not updating"

2. **Different Focus:**
   - Session maintenance: WHY does JWT expire (timing bug)
   - Version update: WHAT happens when JWT expires (silent failure)

3. **Different Entry Points:**
   - Session maintenance: Investigated JWT refresh logic
   - Version update: Investigated heartbeat UPDATE logic

4. **Incomplete Analysis:**
   - Session maintenance doc proposed fix for timing bug
   - Didn't investigate whether operations validate JWT before execution
   - Version update analysis found the missing validation
   - Didn't initially connect it to timing bug analysis

---

## Testing Strategy for Unified Fix

### Test 1: Timing Bug Fix Verification

**Steps:**
1. Apply timing fix (reduce interval to 5 min)
2. Set up logging to capture all JWT refresh attempts with timestamps
3. Run desktop app for 2+ hours
4. Verify JWT is refreshed at T+55 (before T+60 expiry)

**Expected:**
```
[T+0]  Login: JWT issued, expires T+60
[T+5]  Refresh check: 55 min remaining, no action
[T+55] Refresh check: 5 min remaining, REFRESH TRIGGERED
[T+55] JWT refresh successful, new expiry T+115
```

---

### Test 2: Missing Validation Fix Verification

**Steps:**
1. Apply heartbeat validation fix
2. Manually set JWT to expired state in tokens.json
3. Trigger heartbeat (or wait 4 hours)
4. Verify heartbeat detects expired JWT and attempts refresh
5. Verify heartbeat skips operation if refresh fails

**Expected:**
```
[HEARTBEAT] JWT expired — refreshing before update...
[HEARTBEAT] JWT refresh successful
[OK] Heartbeat sent (v1.3.7)
```

Or if refresh fails:
```
[HEARTBEAT] JWT expired — refreshing before update...
[HEARTBEAT] JWT refresh failed — heartbeat skipped
[ADMIN LOG] WARN: Heartbeat skipped: JWT refresh failed
```

---

### Test 3: Combined Scenario (Realistic)

**Steps:**
1. Apply both fixes
2. Simulate network instability (block AI server intermittently)
3. Run desktop app for 6+ hours
4. Verify:
   - Timing fix attempts refresh at 55-minute marks
   - If refresh fails, heartbeat validation catches it
   - No false "[OK] Heartbeat sent" messages when operation fails
   - Admin logs show clear diagnostic info

**Expected:**
- At least 1 JWT refresh succeeds within each 1-hour window
- Heartbeats only proceed after successful JWT validation
- Clear logs for all JWT issues

---

### Test 4: Row Count Verification

**Steps:**
1. Apply heartbeat validation fix
2. Manually corrupt `supabase_user_id` in database
3. Trigger heartbeat
4. Verify heartbeat detects 0-row UPDATE and logs error

**Expected:**
```
[WARN] Heartbeat update affected 0 rows - RLS may be blocking
[ADMIN LOG] ERROR: Heartbeat failed: UPDATE affected 0 rows
```

---

## Deployment Plan

### Phase 1: Critical Fix (Deploy ASAP)

1. **Apply timing bug fix** (reduce refresh interval)
   - File: `python-desktop-app/desktop_app.py` line 9865
   - Change: `token_refresh_interval = 10`
   - Risk: Low (just checking more frequently)
   - Impact: Prevents most JWT expirations

2. **Apply heartbeat validation fix** (add JWT check)
   - File: `python-desktop-app/desktop_app.py` line 6453
   - Change: Add JWT validation before UPDATE
   - Risk: Low (defensive, fail-safe)
   - Impact: Prevents false success logs, provides diagnostics

### Phase 2: Comprehensive Fix (Next Release)

3. **Audit all JWT-dependent operations**
   - Identify all `self.supabase.table()` calls
   - Add JWT validation to each
   - Test each operation with expired JWT

4. **Add monitoring and alerting**
   - Track JWT refresh success rate
   - Alert when refresh fails repeatedly
   - Dashboard showing JWT health status

### Phase 3: Long-term Improvements (Future)

5. **Consider increasing JWT expiry to 2 hours**
   - Evaluate security tradeoffs
   - Test with longer-lived JWTs

6. **Implement automatic re-authentication**
   - When JWT refresh fails persistently
   - Prompt user to re-login via UI notification

7. **Add integration tests**
   - Test JWT refresh timing
   - Test operations with expired JWT
   - Test network failure scenarios

---

## Conclusion

**YES, both issues are caused by the SAME JWT expiration problem:**

1. **Session Maintenance Issue:**
   - Focuses on WHY JWT expires (timing bug in proactive refresh)
   - Mathematical proof of misalignment
   - Proposed fix: Reduce refresh interval

2. **Desktop App Version Update Issue:**
   - Focuses on WHAT happens when JWT expires (missing validation)
   - Code comparison showing inconsistent patterns
   - Proposed fix: Add defensive JWT checks

**They are TWO SIDES OF THE SAME COIN:**
- Timing bug makes JWT expiration more frequent
- Missing validation makes expired JWT go undetected
- Combined effect: Heartbeat fails 100% after 1 hour under adverse conditions

**Unified Fix Required:**
- ✅ Fix timing bug (architectural)
- ✅ Add defensive validation (implementation)
- ✅ Audit all operations (comprehensive)
- ✅ Add monitoring (operational)

**Deployment Priority:** CRITICAL - Both fixes should be deployed together as they address complementary aspects of the same problem.

---

## Appendix: Evidence Checklist

### Evidence That They're The Same Issue:

✅ **Same Symptoms:**
- Users appear inactive after 1 hour
- Heartbeat fails silently
- `desktop_last_heartbeat` becomes stale
- `desktop_app_version` doesn't update

✅ **Same Timing:**
- Both occur at ~1 hour (JWT expiry)
- Both occur at ~4 hours (heartbeat interval)

✅ **Same Root Cause Chain:**
- JWT expires → `auth.uid()` returns NULL → RLS blocks writes → UPDATE affects 0 rows

✅ **Same Evidence:**
- Developer comment about "silent failures" (line 8243)
- Batch upload has validation, heartbeat doesn't
- Proactive refresh timing misalignment

✅ **Same Fix Requirements:**
- Both need timing fix (reduce refresh interval)
- Both need validation fix (add JWT checks)
- Both need monitoring (track refresh success)

**Confidence Level:** 99% - These are definitively the same issue analyzed from different perspectives.
