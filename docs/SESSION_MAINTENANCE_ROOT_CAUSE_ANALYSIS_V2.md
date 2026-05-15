# Session Maintenance Failure - Root Cause Analysis V2

**Date**: 2026-05-14  
**Severity**: 🔴 CRITICAL  
**Status**: Identified - Implementation Fix Required  
**Related Docs**: 
- [plan/2026-05-06_python-desktop-app_fix-session-maintenance.md](../plan/2026-05-06_python-desktop-app_fix-session-maintenance.md)
- [python-desktop-app/tests/test_session_maintenance.py](../python-desktop-app/tests/test_session_maintenance.py)

---

## Executive Summary

**Problem**: Users report that session maintenance is not working despite previous fixes. Sessions appear to be lost after ~1 hour, causing users to show as "not-setup" or "inactive" in the Forge UI even though the desktop app remains logged in.

**Root Cause**: **JWT Token Expiration Timing Bug** - The Supabase JWT expires after 1 hour (3600s), but the proactive token refresh mechanism checks every 10 minutes with a 5-minute buffer. This creates a timing gap where the JWT expires before the refresh logic can detect it needs renewal.

**Impact**: 
- Users appear as "not logged in" in Jira Forge UI after ~1 hour
- Heartbeat updates fail silently due to expired JWT blocking RLS policies
- `desktop_last_heartbeat` becomes stale, triggering "inactive" status
- Data sync operations may fail intermittently when JWT is expired

---

## Technical Deep Dive

### Previous Fixes (May 6, 2026)

The following fixes were successfully implemented per the spec:

1. ✅ **Fail-fast on JWT setup failure** ([desktop_app.py:5274-5277](../python-desktop-app/desktop_app.py#L5274-L5277))
   - `initialize_supabase()` now returns `False` if JWT setup fails
   - Prevents silent continuation in broken auth state

2. ✅ **Retry logic with exponential backoff** ([desktop_app.py:2361-2388](../python-desktop-app/desktop_app.py#L2361-L2388))
   - 3 retry attempts with 3s, 6s backoff
   - Network diagnostics during retries
   - Structured logging

3. ✅ **Desktop status update returns boolean** ([desktop_app.py:6412-6450](../python-desktop-app/desktop_app.py#L6412-L6450))
   - Method now returns `True`/`False`
   - Detects RLS blocks (empty result.data)
   - Proper error handling

4. ✅ **Verify write success after login** ([desktop_app.py:5422-5436](../python-desktop-app/desktop_app.py#L5422-L5436))
   - OAuth callback checks return value
   - Shows error message and calls diagnostics on failure

**These fixes addressed the INITIAL authentication flow but did NOT address JWT expiration during long-running sessions.**

---

## The NEW Root Cause: JWT Expiration Timing Bug

### JWT Lifecycle

1. **JWT Creation**: When user logs in, AI server mints JWT with 1-hour (3600s) expiry ([auth-controller.js:642](../ai-server/src/controllers/auth-controller.js#L642))
   ```javascript
   const expiresIn = 3600; // 1 hour
   ```

2. **JWT Storage**: Desktop app stores JWT in `tokens['supabase_token']` with expiry timestamp

3. **JWT Usage**: All Supabase operations use this JWT for RLS authentication via `auth.uid()`

4. **JWT Expiration**: After 3600 seconds, JWT is invalid and `auth.uid()` returns NULL, causing RLS to block all writes

### Proactive Refresh Mechanism

The desktop app has a background thread (`sync_worker`) that should refresh the JWT before expiry ([desktop_app.py:9907-9915](../python-desktop-app/desktop_app.py#L9907-L9915)):

```python
token_refresh_interval = 20  # Check every 20 iterations
# ... in loop (30s sleep per iteration):
if token_refresh_counter >= token_refresh_interval:  # Every 10 minutes
    sb_expires_at = self.auth_manager.tokens.get('supabase_token_expires_at', 0)
    if sb_expires_at and time.time() > (sb_expires_at - 300):  # 5-min buffer
        self._set_supabase_jwt()  # Refresh JWT
```

**Key Parameters**:
- Check interval: `20 iterations × 30s = 600s = 10 minutes`
- Refresh buffer: `300s = 5 minutes`
- JWT expiry: `3600s = 60 minutes`

### The Timing Bug

**Timeline of Events**:

| Time (min) | Event | JWT Remaining | Refresh Check Result |
|------------|-------|---------------|---------------------|
| 0 | User logs in | 60 min | - |
| 10 | Token refresh check #1 | 50 min | 50 min > 5 min buffer → NO REFRESH |
| 20 | Token refresh check #2 | 40 min | 40 min > 5 min buffer → NO REFRESH |
| 30 | Token refresh check #3 | 30 min | 30 min > 5 min buffer → NO REFRESH |
| 40 | Token refresh check #4 | 20 min | 20 min > 5 min buffer → NO REFRESH |
| 50 | Token refresh check #5 | 10 min | 10 min > 5 min buffer → NO REFRESH |
| 55 | **(Critical Window)** | **5 min** | **No check scheduled!** |
| 60 | Token refresh check #6 | **0 min (EXPIRED)** | Attempts refresh but JWT already expired! |

**The Bug**: The refresh check at 60 minutes detects that refresh is needed (`0 < 5` min buffer), but by this time the JWT has already expired. When `_set_supabase_jwt()` is called, it attempts to call `/api/auth/exchange-token` using the Atlassian token, but if there are network delays or if the Supabase client is already marked as having an expired JWT, subsequent operations fail.

### Why Heartbeats Fail

1. **Heartbeat Interval**: Sent every 4 hours ([desktop_app.py:9863](../python-desktop-app/desktop_app.py#L9863))
   ```python
   heartbeat_interval = 480  # 480 iterations × 30s = 4 hours
   ```

2. **First Heartbeat**: Sent immediately on login → ✅ SUCCESS (JWT is fresh)

3. **Second Heartbeat**: Sent at 4-hour mark
   - By this time, JWT has expired 3 times (at 1hr, 2hr, 3hr)
   - Refresh mechanism SHOULD have renewed it, but timing bug means JWT might be expired when heartbeat is sent
   - If JWT is expired, `auth.uid()` returns NULL
   - RLS policy blocks the write (no matching row WHERE `supabase_user_id = auth.uid()`)
   - Exception is caught and logged as warning ([desktop_app.py:6471](../python-desktop-app/desktop_app.py#L6471))
   - `desktop_last_heartbeat` remains at 4+ hours old

4. **Forge UI Check**: Checks if heartbeat is within 3 hours ([userResolvers.js:138](../forge-app/src/resolvers/userResolvers.js#L138))
   - `desktop_last_heartbeat` is 4+ hours old → FAILS
   - Returns status `'not-setup'` or `'inactive'`

### Why Data Sync Sometimes Works

Data sync operations (`upload_activity_batch`, `sync_offline_data`) happen more frequently (every 30s when tracking is active). Each sync operation:

1. Uses the Supabase client (which has the JWT)
2. If the JWT is expired, the operation fails
3. On the NEXT iteration (30s later), the refresh check might catch the expired JWT and refresh it
4. Subsequent syncs work until the next expiry

**This creates intermittent behavior**: Sometimes data syncs work (if they happen right after a successful JWT refresh), sometimes they fail (if they happen when JWT is expired).

---

## Verification Evidence

### Code References

1. **JWT Expiry Set to 1 Hour**:
   - File: [ai-server/src/controllers/auth-controller.js](../ai-server/src/controllers/auth-controller.js#L642)
   - Line 642: `const expiresIn = 3600; // 1 hour`

2. **Refresh Check Interval (10 Minutes)**:
   - File: [python-desktop-app/desktop_app.py](../python-desktop-app/desktop_app.py#L9865)
   - Line 9865: `token_refresh_interval = 20  # Check token expiry every 20 iterations (~10 min at 30s)`

3. **Refresh Buffer (5 Minutes)**:
   - File: [python-desktop-app/desktop_app.py](../python-desktop-app/desktop_app.py#L9909)
   - Line 9909: `if sb_expires_at and time.time() > (sb_expires_at - 300):`

4. **Heartbeat Interval (4 Hours)**:
   - File: [python-desktop-app/desktop_app.py](../python-desktop-app/desktop_app.py#L9863)
   - Line 9863: `heartbeat_interval = 480  # Send heartbeat every 480 iterations (4 hours at 30s interval)`

5. **Heartbeat Does NOT Refresh JWT**:
   - File: [python-desktop-app/desktop_app.py](../python-desktop-app/desktop_app.py#L6453-6471)
   - The `_send_heartbeat()` method directly uses `self.supabase` client without checking/refreshing JWT

### Mathematical Proof

Given:
- JWT expires at time `T + 3600s`
- Refresh checks happen at `T + (600n)s` for `n = 0, 1, 2, ...`
- Refresh triggers when `current_time > expiry - 300`

At check n=5 (T + 3000s = 50 minutes):
- Condition: `(T + 3000) > (T + 3600 - 300)` = `3000 > 3300` = **FALSE**

At check n=6 (T + 3600s = 60 minutes):
- Condition: `(T + 3600) > (T + 3600 - 300)` = `3600 > 3300` = **TRUE**
- But JWT has already expired at exactly T + 3600s!

**The earliest the refresh can trigger is at the 60-minute mark, but by then the JWT has already expired.**

---

## Impact Assessment

### User Experience Impact

1. **Admin Panel Locked**: Users see "Download the Desktop App" message in Jira despite being logged in
2. **Inaccurate Status**: User status shows "inactive" in admin dashboard even when app is running
3. **Intermittent Sync Failures**: Screenshots and time tracking data may fail to upload when JWT is expired
4. **Confusion**: No visible error messages - users don't know authentication is broken

### Data Integrity Impact

1. **Heartbeat Staleness**: `desktop_last_heartbeat` can become hours out of date
2. **Missed Data**: Activity records accumulated during JWT expiry window may be lost if app crashes before retry
3. **Notification Failures**: Desktop notifications may not be delivered if the user appears "offline"

### Security Impact

1. **RLS Bypass Risk**: If operations fail-open instead of fail-closed, expired JWTs could potentially access wrong tenant's data (CRITICAL if present)
2. **Session Hijacking Window**: Expired JWTs should be rejected, but timing bugs could create brief windows where stale credentials are accepted

---

## Proposed Solution

### Option 1: Reduce Token Refresh Check Interval (RECOMMENDED)

**Change**: Reduce `token_refresh_interval` from 20 to 10 iterations (5 minutes instead of 10 minutes)

**File**: [python-desktop-app/desktop_app.py](../python-desktop-app/desktop_app.py#L9865)

**Change**:
```python
# BEFORE
token_refresh_interval = 20  # Check token expiry every 20 iterations (~10 min at 30s)

# AFTER
token_refresh_interval = 10  # Check token expiry every 10 iterations (~5 min at 30s)
```

**Timeline with Fix**:

| Time (min) | Event | JWT Remaining | Refresh Check Result |
|------------|-------|---------------|---------------------|
| 0 | User logs in | 60 min | - |
| 5 | Token refresh check #1 | 55 min | 55 min > 5 min → NO REFRESH |
| 10 | Token refresh check #2 | 50 min | 50 min > 5 min → NO REFRESH |
| 50 | Token refresh check #10 | 10 min | 10 min > 5 min → NO REFRESH |
| 55 | Token refresh check #11 | **5 min** | **5 min ≤ 5 min → REFRESH TRIGGERED** ✅ |
| 60 | JWT would have expired | - | Already refreshed, new JWT valid |

**Pros**:
- Minimal code change (single line)
- Catches expiry within buffer window
- No breaking changes
- Backward compatible

**Cons**:
- Slightly more frequent checks (doubles check frequency)
- Still has a theoretical 5-minute window if check is delayed

---

### Option 2: Refresh JWT Before Each Heartbeat

**Change**: Call `_set_supabase_jwt()` before sending heartbeat

**File**: [python-desktop-app/desktop_app.py](../python-desktop-app/desktop_app.py#L6453-6471)

**Change**:
```python
def _send_heartbeat(self):
    """Send heartbeat to Supabase to indicate app is still running"""
    if not self.current_user_id or self.current_user_id.startswith('anonymous_'):
        return

    try:
        # Ensure JWT is fresh before sending heartbeat
        if not self._set_supabase_jwt():
            print("[WARN] Could not refresh JWT before heartbeat - skipping")
            return

        client = self.supabase
        if not client:
            return

        client.table('users').update({
            'desktop_last_heartbeat': datetime.now(timezone.utc).isoformat(),
            'desktop_app_version': self.app_version
        }).eq('id', self.current_user_id).execute()

        print(f"[OK] Heartbeat sent (v{self.app_version})")

    except Exception as e:
        print(f"[WARN] Failed to send heartbeat: {e}")
```

**Pros**:
- Guarantees heartbeat always has fresh JWT
- No timing dependencies
- Explicit and clear intent

**Cons**:
- Extra API call every 4 hours
- Adds latency to heartbeat operation
- Duplicates refresh logic (already in sync_worker)

---

### Option 3: Increase JWT Expiry Time

**Change**: Increase JWT `expiresIn` from 3600s (1 hour) to 7200s (2 hours)

**File**: [ai-server/src/controllers/auth-controller.js](../ai-server/src/controllers/auth-controller.js#L642)

**Change**:
```javascript
// BEFORE
const expiresIn = 3600; // 1 hour

// AFTER
const expiresIn = 7200; // 2 hours
```

**Timeline with Fix**:

| Time (min) | Event | JWT Remaining | Refresh Check Result |
|------------|-------|---------------|---------------------|
| 0 | User logs in | 120 min | - |
| 10 | Token refresh check #1 | 110 min | 110 min > 5 min → NO REFRESH |
| 110 | Token refresh check #11 | 10 min | 10 min > 5 min → NO REFRESH |
| 115 | Token refresh check #12 | **5 min** | **5 min ≤ 5 min → REFRESH TRIGGERED** ✅ |
| 120 | JWT would have expired | - | Already refreshed |

**Pros**:
- Reduces frequency of JWT expiry issues
- Gives more time for refresh logic to catch expiry
- No change to refresh check interval

**Cons**:
- Longer-lived tokens are slightly less secure
- Doesn't fix the underlying timing bug (just makes it less likely to occur)
- Could still fail if checks are delayed by >10 minutes

---

### Option 4: COMBINATION (MOST ROBUST)

Implement **both** Option 1 and Option 2:
1. Reduce refresh check interval to 5 minutes (catches expiry sooner)
2. Refresh JWT before heartbeat (ensures critical operations always work)

**Pros**:
- Defense in depth: Two layers of protection
- Heartbeat guaranteed to work even if background refresh fails
- Minimal performance impact (heartbeat is only every 4 hours)

**Cons**:
- Slightly more complex
- Redundant refresh calls (but rare, so negligible impact)

---

## Recommended Action Plan

### Phase 1: Immediate Fix (Option 1)

1. **Reduce token refresh check interval to 5 minutes**
   - File: `python-desktop-app/desktop_app.py` line 9865
   - Change `token_refresh_interval = 20` to `token_refresh_interval = 10`
   - Test: Run desktop app for 2+ hours, verify JWT is refreshed before expiry

2. **Add structured logging around JWT refresh**
   - Log exact timestamps of JWT expiry and refresh attempts
   - Include remaining time until expiry in log messages

### Phase 2: Enhanced Robustness (Option 2)

3. **Add JWT refresh before heartbeat**
   - Modify `_send_heartbeat()` to call `_set_supabase_jwt()` first
   - Add error handling if refresh fails
   - Test: Manually expire JWT, verify heartbeat triggers refresh

4. **Add JWT refresh before critical operations**
   - Identify other critical operations (data sync, status updates)
   - Add JWT refresh checks before operations that MUST succeed

### Phase 3: Monitoring & Validation

5. **Add monitoring for JWT expiry failures**
   - Log when operations fail due to expired JWT
   - Track JWT refresh success/failure rate
   - Alert if JWT expires without successful refresh

6. **Add integration test**
   - File: `python-desktop-app/tests/integration/test_jwt_refresh_timing.py`
   - Test case: Mock JWT with 1-minute expiry, verify refresh happens within buffer

7. **Update documentation**
   - Document JWT lifecycle in architecture guide
   - Add troubleshooting section for JWT expiry issues
   - Update deployment guide with JWT expiry considerations

---

## Testing Checklist

- [ ] Unit test: JWT refresh triggered when within 5-minute buffer
- [ ] Unit test: JWT refresh NOT triggered when >5 minutes remaining
- [ ] Integration test: Desktop app runs for 2+ hours, JWT refreshes automatically
- [ ] Integration test: Heartbeat succeeds even after 4+ hours
- [ ] Manual test: Force JWT expiry, verify operations trigger refresh
- [ ] Manual test: Network failure during JWT refresh, verify retry logic works
- [ ] Regression test: Verify all existing session maintenance tests still pass

---

## Related Issues

- Initial session maintenance fix: [plan/2026-05-06_python-desktop-app_fix-session-maintenance.md](../plan/2026-05-06_python-desktop-app_fix-session-maintenance.md)
- JWT authentication architecture: [docs/AI_SERVER_CONNECTION_ARCHITECTURE.md](AI_SERVER_CONNECTION_ARCHITECTURE.md)
- RLS policy implementation: [supabase/migrations/20260401_drop_supabase_user_id_fk_and_backfill.sql](../supabase/migrations/20260401_drop_supabase_user_id_fk_and_backfill.sql)

---

## Conclusion

The session maintenance issue is caused by a **JWT expiration timing bug** where the proactive refresh mechanism checks every 10 minutes but the JWT expires every 60 minutes with a 5-minute buffer. This creates a timing gap where the JWT expires before the refresh check can detect it needs renewal.

The issue was not caught by the previous fixes because those fixes addressed the **initial authentication flow** but did not address **long-running session JWT expiration**.

**Recommended immediate fix**: Reduce token refresh check interval from 10 minutes to 5 minutes. This ensures the refresh check at the 55-minute mark (5 minutes before expiry) will detect the need for renewal and trigger a refresh before the JWT expires.

**Recommended long-term fix**: Implement Option 4 (combination approach) for defense in depth.
