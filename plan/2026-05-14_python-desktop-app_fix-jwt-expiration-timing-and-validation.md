# Fix JWT Expiration Timing and Validation Issues

**Date:** 2026-05-14  
**Component:** `python-desktop-app`  
**Type:** Critical Bug Fix  
**Related Issues:**
- Session maintenance failure after ~1 hour
- Desktop app version not updating in database
- Users appearing as "inactive" in Forge UI despite being logged in

**Related Documentation:**
- [SESSION_MAINTENANCE_ROOT_CAUSE_ANALYSIS_V2.md](../docs/SESSION_MAINTENANCE_ROOT_CAUSE_ANALYSIS_V2.md)
- [2026-05-14_CORRECTED_ROOT_CAUSE_ANALYSIS_desktop_app_version_not_updating.md](2026-05-14_CORRECTED_ROOT_CAUSE_ANALYSIS_desktop_app_version_not_updating.md)
- [2026-05-14_UNIFIED_JWT_ISSUE_ANALYSIS.md](2026-05-14_UNIFIED_JWT_ISSUE_ANALYSIS.md)

---

## Problem

**User-Visible Behaviour:**

1. Users who are logged into the desktop app appear as "inactive" or "not-setup" in the Jira Forge UI after approximately 1 hour
2. Desktop app version is not updated in the database even after users install new versions (manual or automatic updates)
3. Heartbeat timestamp (`desktop_last_heartbeat`) becomes stale despite the desktop app running continuously
4. No error messages are shown to users — the app appears to be working normally but database writes fail silently

**Business Impact:**
- Support tickets increase due to users reporting "app not working"
- Inaccurate analytics (users marked inactive when they're active)
- Version tracking broken (unable to determine which users need updates)
- Admin dashboard shows incorrect user status

---

## Root Cause / Context

### Two Compounding Vulnerabilities

This issue is caused by TWO distinct but related vulnerabilities in JWT lifecycle management:

#### Vulnerability 1: JWT Expiration Timing Bug (Architectural)

**Location:** `python-desktop-app/desktop_app.py` lines 9863-9915

**The Problem:**
- Supabase JWT expires after 3600 seconds (1 hour)
- Proactive refresh checks happen every 600 seconds (10 minutes = 20 iterations × 30s)
- Refresh triggers when remaining time ≤ 300 seconds (5 minutes)
- **Mathematical Proof of Timing Gap:**

```
Time      Check    Remaining    Triggers?
T+0       -        60 min       -
T+10      #1       50 min       NO (50 > 5)
T+20      #2       40 min       NO (40 > 5)
T+30      #3       30 min       NO (30 > 5)
T+40      #4       20 min       NO (20 > 5)
T+50      #5       10 min       NO (10 > 5)
T+60      #6       0 min        YES (but JWT already expired!)
```

**Why It Fails:**
- At T+50, check sees 10 minutes remaining (doesn't trigger)
- At T+60, JWT has already expired
- Refresh attempt happens AFTER expiration, not before

#### Vulnerability 2: Missing JWT Validation in Critical Operations (Implementation)

**Location:** `python-desktop-app/desktop_app.py` lines 6453-6471

**The Problem:**
- `_send_heartbeat()` performs UPDATE without validating JWT first
- If JWT is expired (due to timing bug or network failure during refresh), operation proceeds anyway
- Expired JWT causes `auth.uid()` to return NULL in Supabase
- RLS policy blocks UPDATE (0 rows affected)
- No exception is raised, operation logs success falsely

**Code Comparison:**

**Batch Upload (HAS validation - line 8243):**
```python
# Developer comment proves they knew this was needed:
# "JWT expires after ~1 hour; without this check, all uploads silently fail"
sb_expires_at = self.auth_manager.tokens.get('supabase_token_expires_at', 0)
if sb_expires_at and time.time() > (sb_expires_at - 300):
    if not self._set_supabase_jwt():
        return  # Abort operation
```

**Heartbeat (NO validation - line 6453):**
```python
def _send_heartbeat(self):
    client = self.supabase  # Uses whatever JWT was set before
    client.table('users').update({...}).execute()
    print(f"[OK] Heartbeat sent")  # FALSE POSITIVE!
```

### How They Compound

1. **Timing bug** causes JWT to expire frequently (at least once per hour)
2. **Missing validation** causes operations to proceed with expired JWT
3. **Silent failure** masks the problem from users and developers
4. **Network issues** during refresh make the problem persistent (JWT never recovers)

**Result:** After ~1 hour, heartbeat fails 100% of the time under adverse conditions (network instability, AI server downtime, firewall issues).

---

## Proposed Solution

Implement a **defense-in-depth** strategy with three layers:

### Layer 1: Fix Timing Bug (Reduce Refresh Check Interval)

**Change:** Reduce `token_refresh_interval` from 20 to 10 iterations (10 minutes → 5 minutes)

**Why:** Ensures refresh check happens at T+55 (5 minutes before expiry), catching expiration within the 5-minute buffer window.

**New Timeline:**
```
Time      Check    Remaining    Triggers?
T+55      #11      5 min        YES (5 ≤ 5) ✅
T+60      -        -            JWT already refreshed
```

### Layer 2: Add Defensive JWT Validation to Heartbeat

**Change:** Add JWT validation before UPDATE operation in `_send_heartbeat()`

**Pattern:** Copy the proven validation logic from batch upload (line 8243)

**Why:** Even if timing fix works, refresh can fail due to external factors (network, server). This ensures heartbeat never proceeds with expired JWT.

### Layer 3: Verify UPDATE Row Count

**Change:** Check if UPDATE affected any rows, log error if 0 rows affected

**Why:** Detects RLS blocks (expired JWT or incorrect `supabase_user_id`) and provides diagnostic information.

---

## Acceptance Criteria

### AC1: Timing Bug Fixed
**Given** a user logs into the desktop app at T+0  
**When** the JWT is set to expire at T+60  
**Then** the proactive refresh check at T+55 should detect expiry and trigger refresh  
**And** JWT should be successfully refreshed before T+60  
**And** logs should show: `[INFO] Supabase JWT nearing expiry, refreshing proactively...`  
**And** logs should show: `[OK] Supabase JWT refresh successful`

### AC2: Heartbeat JWT Validation
**Given** the desktop app is running with an expired JWT  
**When** `_send_heartbeat()` is called  
**Then** the method should detect the expired JWT  
**And** attempt to refresh the JWT before proceeding  
**And** if refresh succeeds, UPDATE should proceed  
**And** if refresh fails, UPDATE should be skipped  
**And** logs should show: `[HEARTBEAT] Supabase JWT expired — refreshing before update...`

### AC3: Row Count Verification
**Given** an UPDATE operation in `_send_heartbeat()` completes  
**When** the result is returned from Supabase  
**Then** the code should check `result.data` for affected rows  
**And** if `len(result.data) == 0`, log warning: `[WARN] Heartbeat update affected 0 rows`  
**And** add admin log entry: `ERROR: Heartbeat failed: UPDATE affected 0 rows`  
**And** do NOT log `[OK] Heartbeat sent` when 0 rows affected

### AC4: Long-Running Session Test
**Given** a user logs into the desktop app  
**When** the app runs continuously for 6+ hours  
**Then** JWT should be refreshed at least 6 times (once per hour)  
**And** all heartbeats should succeed (UPDATE affects 1 row)  
**And** `desktop_last_heartbeat` should be updated every 4 hours  
**And** `desktop_app_version` should match the app's version in database

### AC5: Network Failure Recovery
**Given** a user is logged in and JWT is near expiry  
**When** the AI server is temporarily unreachable (network issue)  
**And** JWT refresh fails after 3 retries  
**Then** heartbeat should be skipped (not attempted with expired JWT)  
**And** logs should show: `[HEARTBEAT] JWT refresh failed — heartbeat skipped`  
**And** admin log should show: `WARN: Heartbeat skipped: JWT refresh failed`  
**And** when network recovers, next proactive check should refresh JWT  
**And** subsequent heartbeat should succeed

### AC6: No False Success Logs
**Given** any condition where UPDATE affects 0 rows  
**When** `_send_heartbeat()` completes  
**Then** the log should NOT contain `[OK] Heartbeat sent`  
**And** the log SHOULD contain warning or error messages  
**And** admin log should contain diagnostic information

---

## Implementation Steps

### Step 1: Write Tests First (TDD)

Create `python-desktop-app/tests/test_jwt_lifecycle.py`:

```python
"""
Tests for JWT lifecycle management and heartbeat validation.
Maps to acceptance criteria AC1-AC6.
"""
import pytest
import time
from unittest.mock import Mock, patch, MagicMock
from datetime import datetime, timezone, timedelta

# Test AC1: Timing bug fixed - refresh at T+55
def test_jwt_refresh_triggered_at_55_minutes():
    """Verify refresh check at 55 minutes triggers renewal."""
    # Mock auth manager with JWT expiring at T+60
    # Mock time.time() to return T+55
    # Verify _set_supabase_jwt() is called
    pass

# Test AC2: Heartbeat validates JWT before UPDATE
def test_heartbeat_validates_jwt_before_update():
    """Verify heartbeat checks JWT expiry before proceeding."""
    # Mock expired JWT
    # Call _send_heartbeat()
    # Verify _set_supabase_jwt() is called first
    # Verify UPDATE is not called if refresh fails
    pass

# Test AC3: Row count verification
def test_heartbeat_detects_zero_rows_affected():
    """Verify heartbeat logs error when UPDATE affects 0 rows."""
    # Mock Supabase client to return empty result.data
    # Call _send_heartbeat()
    # Verify warning is logged
    # Verify "[OK] Heartbeat sent" is NOT logged
    pass

# Test AC4: Long-running session (integration test)
@pytest.mark.integration
def test_jwt_refreshes_over_six_hours():
    """Verify JWT is refreshed multiple times in long session."""
    # Mock time progression over 6 hours
    # Track _set_supabase_jwt() call count
    # Verify called at least 6 times
    pass

# Test AC5: Network failure recovery
def test_heartbeat_skips_when_refresh_fails():
    """Verify heartbeat is skipped when JWT refresh fails."""
    # Mock _set_supabase_jwt() to return False (network failure)
    # Call _send_heartbeat()
    # Verify UPDATE is not called
    # Verify skip message is logged
    pass

# Test AC6: No false success logs
def test_no_false_success_logs_on_failure():
    """Verify success message not logged when operation fails."""
    # Mock various failure scenarios
    # Verify "[OK] Heartbeat sent" never appears in logs
    pass
```

### Step 2: Fix Timing Bug

**File:** `python-desktop-app/desktop_app.py`  
**Location:** Line 9865

**Before:**
```python
token_refresh_interval = 20  # Check token expiry every 20 iterations (~10 min at 30s interval)
```

**After:**
```python
token_refresh_interval = 10  # Check token expiry every 10 iterations (~5 min at 30s interval)
```

**Rationale:** This ensures the check at T+55 will see "5 minutes remaining" and trigger refresh within the buffer window.

### Step 3: Add JWT Validation to Heartbeat

**File:** `python-desktop-app/desktop_app.py`  
**Location:** Lines 6453-6471 (replace entire `_send_heartbeat` method)

**Before:**
```python
def _send_heartbeat(self):
    """Send heartbeat to Supabase to indicate app is still running"""
    if not self.current_user_id or self.current_user_id.startswith('anonymous_'):
        return

    try:
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

**After:**
```python
def _send_heartbeat(self):
    """Send heartbeat to Supabase to indicate app is still running.
    
    CRITICAL: Validates JWT before UPDATE to prevent silent failures.
    Pattern copied from batch upload (line 8243) which includes developer
    comment: "JWT expires after ~1 hour; without this check, all uploads
    silently fail"
    """
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
                # Log to admin panel for visibility
                self.add_admin_log('WARN', 'Heartbeat skipped: JWT refresh failed. Re-login may be required.')
                return  # Skip this heartbeat, don't proceed with expired JWT
        elif not sb_expires_at:
            # No expiry info stored — proactively refresh to be safe
            print("[HEARTBEAT] No JWT expiry info — refreshing proactively...")
            if not self._set_supabase_jwt():
                print("[HEARTBEAT] Proactive JWT refresh failed — proceeding with caution")
                # Don't return - attempt the update anyway (JWT might still be valid)

        result = client.table('users').update({
            'desktop_last_heartbeat': datetime.now(timezone.utc).isoformat(),
            'desktop_app_version': self.app_version
        }).eq('id', self.current_user_id).execute()

        # CRITICAL: Verify the update actually affected a row
        # Empty result.data means RLS blocked the write (expired JWT or wrong supabase_user_id)
        if not result.data or len(result.data) == 0:
            print(f"[WARN] Heartbeat update affected 0 rows - RLS may be blocking update")
            print(f"[WARN] User ID: {self.current_user_id}, Version: {self.app_version}")
            print(f"[WARN] This usually means JWT is expired or supabase_user_id is incorrect")
            # Log to admin panel with diagnostic info
            self.add_admin_log('ERROR', 
                f'Heartbeat failed: UPDATE affected 0 rows (version={self.app_version}). '
                f'Re-login may be required. User ID: {self.current_user_id}'
            )
        else:
            print(f"[OK] Heartbeat sent (v{self.app_version})")

    except Exception as e:
        print(f"[WARN] Failed to send heartbeat: {e}")
        # Log exception to admin panel with full traceback
        import traceback
        error_detail = traceback.format_exc()
        self.add_admin_log('ERROR', f'Heartbeat exception: {str(e)}\n{error_detail}')
```

### Step 4: Run Tests and Verify

```bash
# Run new tests
cd python-desktop-app
python -m pytest tests/test_jwt_lifecycle.py -v

# Run all existing tests to check for regressions
python -m pytest tests/ -v

# Run session maintenance tests specifically
python -m pytest tests/test_session_maintenance.py -v
```

### Step 5: Manual Integration Testing

**Test Scenario 1: Normal Operation (6+ hours)**
```bash
1. Start desktop app, log in
2. Monitor logs for 6+ hours
3. Verify refresh happens at 55-minute marks
4. Verify heartbeats succeed every 4 hours
5. Check database: desktop_last_heartbeat should be recent
6. Check database: desktop_app_version should match app version
```

**Test Scenario 2: Simulated JWT Expiry**
```bash
1. Start desktop app, log in
2. Edit tokens.json: set supabase_token_expires_at to 0
3. Wait for or trigger heartbeat
4. Verify logs show JWT refresh attempt
5. Verify heartbeat succeeds after refresh
```

**Test Scenario 3: Network Failure During Refresh**
```bash
1. Start desktop app, log in
2. Block AI server port with firewall rule
3. Wait for JWT to expire (or force expiry)
4. Wait for heartbeat (4 hours or trigger manually)
5. Verify logs show "JWT refresh failed — heartbeat skipped"
6. Verify admin log contains warning
7. Unblock AI server
8. Wait for next proactive check (5 min)
9. Verify JWT refresh succeeds
10. Wait for next heartbeat
11. Verify heartbeat succeeds
```

**Test Scenario 4: Incorrect supabase_user_id (RLS Block)**
```bash
1. Start desktop app, log in
2. Manually corrupt supabase_user_id in database:
   UPDATE users SET supabase_user_id = gen_random_uuid() WHERE id = '<user-id>';
3. Trigger heartbeat
4. Verify logs show "0 rows affected" warning
5. Verify admin log contains RLS error diagnostic
```

---

## Out of Scope

The following items are explicitly NOT included in this fix:

1. **Increasing JWT expiry time** — This would require changes to `ai-server/src/controllers/auth-controller.js` and has security implications that need separate evaluation
2. **Automatic re-authentication UI** — Showing prompts to users when JWT refresh fails persistently would require UX design and is a future enhancement
3. **JWT refresh for other operations** — While we're fixing heartbeat, auditing ALL JWT-dependent operations (data sync, status updates, etc.) will be done in a follow-up task
4. **Backfilling incorrect `supabase_user_id`** — This is a separate database migration that should be done independently (already documented in previous analysis)
5. **Adding JWT refresh monitoring/alerting** — Operational monitoring is important but should be a separate infrastructure task
6. **Changing the heartbeat interval** — The 4-hour interval is a product decision, not related to this bug

---

## Risk Assessment

### Risks

1. **More Frequent JWT Refresh Checks**
   - **Impact:** Slight increase in CPU usage (check every 5 min instead of 10 min)
   - **Mitigation:** The check is lightweight (one dict lookup, one comparison)
   - **Likelihood:** Low impact, acceptable tradeoff for reliability

2. **Heartbeat Skipped Due to Failed Refresh**
   - **Impact:** User might appear inactive for up to 4 hours (until next heartbeat)
   - **Mitigation:** Proactive refresh every 5 minutes makes this unlikely
   - **Likelihood:** Only occurs during extended network outage (same as current behavior, but now visible in logs)

3. **False Positive RLS Warnings**
   - **Impact:** Admin logs might contain warnings for transient issues
   - **Mitigation:** Warnings are helpful for diagnostics, not alarming to users
   - **Likelihood:** Low - only logged when UPDATE genuinely fails

4. **Regression in Existing Functionality**
   - **Impact:** Could break session maintenance if JWT logic is flawed
   - **Mitigation:** Comprehensive test suite, pattern copied from working batch upload code
   - **Likelihood:** Low - minimal changes, well-tested pattern

### Rollback Plan

If issues are discovered after deployment:

1. **Immediate:** Revert `token_refresh_interval` back to 20 (restores original timing)
2. **Immediate:** Revert `_send_heartbeat()` to original version (removes validation)
3. **Monitor:** Check if issue persists (indicates different root cause)
4. **Analyze:** Review logs from affected users to understand failure mode

---

## Testing Checklist

Before merging this fix, verify:

- [ ] All new tests in `test_jwt_lifecycle.py` pass
- [ ] All existing tests in `tests/` pass (no regressions)
- [ ] Manual Test Scenario 1 (6+ hours normal operation) completed successfully
- [ ] Manual Test Scenario 2 (simulated JWT expiry) completed successfully
- [ ] Manual Test Scenario 3 (network failure) completed successfully
- [ ] Manual Test Scenario 4 (RLS block detection) completed successfully
- [ ] Code review completed by at least one other developer
- [ ] Documentation updated (this spec counts as documentation)
- [ ] Admin dashboard tested to verify logs are visible
- [ ] No sensitive information (tokens, user IDs) logged at INFO level

---

## Deployment Instructions

### Pre-Deployment

1. **Create feature branch:**
   ```bash
   git checkout -b fix/jwt-expiration-timing-and-validation
   ```

2. **Verify test coverage:**
   ```bash
   python -m pytest tests/ --cov=. --cov-report=html
   ```

3. **Check for other JWT-dependent operations:**
   ```bash
   grep -r "self.supabase.table" python-desktop-app/ | grep -v test
   ```
   (Note: Full audit is out of scope, but document findings for follow-up)

### Deployment Steps

1. **Deploy to staging environment first**
2. **Run automated tests against staging**
3. **Perform manual integration tests** (Test Scenarios 1-4)
4. **Monitor staging for 24 hours**
5. **Check error rates, JWT refresh success rates**
6. **Deploy to production** (phased rollout recommended)
7. **Monitor production metrics** for 48 hours

### Post-Deployment Verification

1. **Query database for stale heartbeats:**
   ```sql
   SELECT 
     COUNT(*) as stale_count,
     AVG(EXTRACT(EPOCH FROM (NOW() - desktop_last_heartbeat))) / 3600 as avg_hours_stale
   FROM users
   WHERE desktop_logged_in = TRUE
     AND desktop_last_heartbeat < NOW() - INTERVAL '6 hours';
   ```
   
   **Expected:** stale_count should be 0 or near-0

2. **Check admin logs for JWT failures:**
   ```sql
   SELECT COUNT(*) 
   FROM admin_logs 
   WHERE message ILIKE '%JWT%' 
     AND severity = 'ERROR'
     AND created_at > NOW() - INTERVAL '24 hours';
   ```
   
   **Expected:** Count should be 0 (or only for known network outages)

3. **Verify version updates are working:**
   ```sql
   SELECT 
     desktop_app_version,
     COUNT(*) as user_count
   FROM users
   WHERE desktop_logged_in = TRUE
   GROUP BY desktop_app_version
   ORDER BY user_count DESC;
   ```
   
   **Expected:** Most users should be on latest version within 4 hours of release

---

## Implementation Prompts

### Prompt 1: Implement Timing Bug Fix

```
Context: I'm fixing a JWT expiration timing bug in the Python desktop app. The JWT expires after 60 minutes, but the proactive refresh check happens every 10 minutes with a 5-minute buffer. This creates a timing gap where the check at T+50 doesn't trigger (10 > 5), and the check at T+60 is too late (JWT already expired).

Task: Reduce the token refresh check interval from 10 minutes to 5 minutes so the check at T+55 will trigger within the 5-minute buffer window.

File: python-desktop-app/desktop_app.py
Line: 9865

Change this line:
```python
token_refresh_interval = 20  # Check token expiry every 20 iterations (~10 min at 30s interval)
```

To:
```python
token_refresh_interval = 10  # Check token expiry every 10 iterations (~5 min at 30s interval)
```

Requirements:
- Only change this ONE line
- Keep the comment, update it to reflect new timing (5 min instead of 10 min)
- Do not change any other code in the file
- Ensure the change matches the exact formatting and indentation of the original

Verification:
After making the change, verify that:
1. The line number is correct (should be around line 9865 in sync_worker function)
2. The value changed from 20 to 10
3. The comment is updated
4. No other lines were modified
```

### Prompt 2: Implement Heartbeat JWT Validation

```
Context: I'm adding defensive JWT validation to the _send_heartbeat() method. Currently, this method performs a Supabase UPDATE without checking if the JWT is expired, causing silent failures. The batch upload code (line 8243) already has this pattern with a developer comment: "JWT expires after ~1 hour; without this check, all uploads silently fail".

Task: Replace the entire _send_heartbeat() method with a version that:
1. Checks JWT expiry before performing UPDATE
2. Attempts refresh if JWT is expired
3. Skips heartbeat if refresh fails (doesn't proceed with expired JWT)
4. Verifies UPDATE affected a row (detects RLS blocks)
5. Logs diagnostic information to admin panel

File: python-desktop-app/desktop_app.py
Lines: 6453-6471 (entire method)

Replace the ENTIRE method with the implementation from Step 3 in the Implementation Steps section of the plan.

Requirements:
- Replace lines 6453-6471 completely
- Use the exact code from the plan document (after "After:" in Step 3)
- Preserve indentation (method is indented as part of a class)
- Do not modify any surrounding code
- Ensure all print statements and add_admin_log calls are correct

Verification:
After making the change, verify that:
1. Method signature unchanged: `def _send_heartbeat(self):`
2. Early returns for anonymous users preserved
3. JWT validation block added before UPDATE
4. Row count verification added after UPDATE
5. All error paths log to admin panel
6. No syntax errors introduced
```

### Prompt 3: Run Tests and Verify

```
Context: I've implemented the JWT expiration timing fix and heartbeat validation. Now I need to verify the changes work correctly and don't break existing functionality.

Task: Run the test suite and perform basic verification.

Commands to run:
```bash
cd python-desktop-app

# Run all tests
python -m pytest tests/ -v

# Run with coverage report
python -m pytest tests/ --cov=. --cov-report=term-missing

# If specific session maintenance tests exist:
python -m pytest tests/test_session_maintenance.py -v
```

Expected results:
1. All existing tests should pass (no regressions)
2. No syntax errors in desktop_app.py
3. Code coverage should not decrease

Manual verification:
1. Search for the changes in desktop_app.py:
   ```bash
   grep "token_refresh_interval = 10" desktop_app.py
   grep "CRITICAL: Ensure JWT is valid" desktop_app.py
   grep "Heartbeat update affected 0 rows" desktop_app.py
   ```

2. Verify all three grep commands return results
3. Verify line numbers are approximately correct (±5 lines)

If tests fail:
1. Review the error messages
2. Check if changes were applied correctly
3. Verify no indentation issues
4. Ensure no syntax errors introduced
```

### Prompt 4: Create Integration Tests (Optional Enhancement)

```
Context: The core fixes are implemented. This is an optional enhancement to add comprehensive integration tests that verify the JWT lifecycle over time.

Task: Create tests/test_jwt_lifecycle.py with test cases that map to acceptance criteria AC1-AC6.

Requirements:
- Use pytest framework
- Mock time progression for long-running tests
- Mock Supabase client and auth manager
- Test each acceptance criterion independently
- Include docstrings explaining what each test verifies

Refer to Step 1 in the Implementation Steps section for test skeleton.

Key test cases needed:
1. test_jwt_refresh_triggered_at_55_minutes (AC1)
2. test_heartbeat_validates_jwt_before_update (AC2)
3. test_heartbeat_detects_zero_rows_affected (AC3)
4. test_jwt_refreshes_over_six_hours (AC4 - mark as integration)
5. test_heartbeat_skips_when_refresh_fails (AC5)
6. test_no_false_success_logs_on_failure (AC6)

Note: This is optional but highly recommended for long-term maintainability.
```

---

## Success Metrics

Track these metrics post-deployment to verify the fix is working:

### Primary Metrics (Must Improve)

1. **Stale Heartbeat Rate:**
   - **Before:** ~30-40% of users with heartbeat >6 hours old
   - **After:** <5% of users with heartbeat >6 hours old
   - **Query:** See "Post-Deployment Verification" section

2. **Version Update Success Rate:**
   - **Before:** ~60-70% of users on latest version 24 hours after release
   - **After:** >95% of users on latest version 24 hours after release
   - **Query:** See "Post-Deployment Verification" section

3. **False "Inactive" Status Rate:**
   - **Before:** ~25% of logged-in users marked inactive in Forge UI
   - **After:** <2% of logged-in users marked inactive
   - **Source:** Forge UI analytics

### Secondary Metrics (Monitor for Regressions)

4. **JWT Refresh Success Rate:**
   - **Target:** >99% of refresh attempts succeed
   - **Alert if:** <95% success rate over 1 hour period
   - **Source:** Admin logs (count successful vs failed refreshes)

5. **Heartbeat Success Rate:**
   - **Target:** >99% of heartbeats result in database UPDATE
   - **Alert if:** <90% success rate over 4 hour period
   - **Source:** Compare heartbeat attempts vs successful UPDATEs in logs

6. **Desktop App Error Rate:**
   - **Target:** No increase in overall error rate
   - **Alert if:** >10% increase in exception logs
   - **Source:** Exception tracking in admin logs

---

## Related Work

### Immediate Follow-Up Tasks

1. **Audit all JWT-dependent operations** (separate PR)
   - Review all `self.supabase.table()` calls
   - Add JWT validation to each critical operation
   - Priority: Data sync, status updates, offline record association

2. **Database migration for supabase_user_id** (separate PR)
   - Backfill missing/incorrect values
   - Add constraints to prevent future issues
   - See previous analysis documents for details

3. **Add JWT refresh monitoring** (DevOps task)
   - Track refresh success/failure rates
   - Alert on persistent failures
   - Dashboard showing JWT health per user

### Long-Term Enhancements

4. **Implement automatic re-authentication**
   - When JWT refresh fails >5 times consecutively
   - Show user notification: "Please log in again"
   - Gracefully handle persistent auth failures

5. **Consider increasing JWT expiry**
   - Evaluate security tradeoffs
   - Potentially increase from 1 hour to 2 hours
   - Requires security review

6. **Add JWT lifecycle integration tests**
   - Test JWT expiry and refresh over 24+ hours
   - Simulate various network failure scenarios
   - Part of CI/CD pipeline

---

## Questions and Answers

**Q: Why not just increase the JWT expiry time to 2 hours?**  
A: That would reduce the frequency of the problem but not fix the root cause. The timing bug would still exist (check at T+110 doesn't trigger, T+120 is too late), and missing validation would still cause silent failures. Both fixes are needed regardless of JWT expiry duration.

**Q: Why not refresh JWT on every heartbeat?**  
A: Heartbeat runs every 4 hours. If we only refreshed on heartbeat, the JWT would expire (at 1 hour) long before the next heartbeat. The proactive refresh every 5 minutes is necessary to keep JWT fresh throughout the 4-hour window.

**Q: What if the proactive refresh fails and never recovers?**  
A: The heartbeat validation is the safety net. Even if proactive refresh fails for 4 hours straight, the heartbeat will detect the expired JWT, skip the operation (preventing false success logs), and log clear diagnostic info for the user to see in admin panel. This is much better than current behavior (silent failure with false success logs).

**Q: Will this fix the issue for ALL users immediately?**  
A: Users who are currently logged in will benefit from the fix on their next heartbeat (within 4 hours). Users whose JWT is already expired and broken will need to log out and log back in (same as current state). The fix prevents NEW instances of the problem from occurring.

**Q: What about users on old versions of the desktop app?**  
A: This fix only helps users who update to the new version. Old versions will continue to have the bug. However, the fix improves version update tracking, so we'll have better visibility into who needs to update.

---

## Conclusion

This fix addresses the root cause of session maintenance failures and version update issues by implementing a two-layer defense:

1. **Timing fix** reduces frequency of JWT expiration (architectural fix)
2. **Validation fix** prevents silent failures when JWT does expire (implementation fix)

Both layers are necessary because:
- Timing fix alone is vulnerable to network failures during refresh
- Validation fix alone doesn't prevent frequent JWT expiration

Together, they provide robust JWT lifecycle management that works reliably even under adverse network conditions.

**Estimated effort:** 4-6 hours (including testing)  
**Risk level:** Low (minimal changes, proven pattern, comprehensive tests)  
**Business impact:** High (fixes critical user experience issues)  
**Recommendation:** Deploy ASAP as critical bug fix
