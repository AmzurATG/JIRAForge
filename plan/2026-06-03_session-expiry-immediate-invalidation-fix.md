# Session Expiry Immediate Invalidation Fix

**Date**: 2026-06-03  
**Author**: AI Assistant  
**Status**: ✅ Implemented and Tested (42 tests pass)  
**Severity**: Medium  
**Components**: python-desktop-app (primary)  
**Related Issues**: Repeated "refresh_token is invalid" error bursts in production logs

---

## 1. Problem Statement

### 1.1 Observed Symptoms

Production logs from 2026-06-02 showed repeated bursts of identical errors:

```json
{"error":"unauthorized_client","error_description":"refresh_token is invalid","level":"error","message":"[Auth] Token refresh error:","service":"ai-analysis-server","timestamp":"2026-06-02 10:14:59"}
{"error":"unauthorized_client","error_description":"refresh_token is invalid","level":"error","message":"[Auth] Token refresh error:","service":"ai-analysis-server","timestamp":"2026-06-02 10:15:00"}
{"error":"unauthorized_client","error_description":"refresh_token is invalid","level":"error","message":"[Auth] Token refresh error:","service":"ai-analysis-server","timestamp":"2026-06-02 10:15:00"}
// ... (~9 identical errors within 1 second)
```

### 1.2 User-Reported Issues

1. **Error log floods**: 9+ identical errors per expired session
2. **Delayed re-auth prompt**: Users not immediately notified to re-authenticate
3. **Login page shows success**: When users tried to re-login, they saw the success page instead of the login page

### 1.3 Business Impact

- Unnecessary server load from repeated failed requests
- Increased log storage costs from error floods
- Poor user experience with delayed notifications
- Users unable to re-authenticate without manual intervention

---

## 2. Root Cause Analysis

### 2.1 Previous Fixes (Already Implemented)

The following fixes were already in place but insufficient:

| Layer | Component | Fix | Status |
|-------|-----------|-----|--------|
| Layer 2 | ai-server | Classify `unauthorized_client` and `invalid_grant` as permanent failures, return `OAUTH_REAUTH_REQUIRED` | ✅ Working |
| Layer 3 | desktop-app | Detect `OAUTH_REAUTH_REQUIRED` as permanent failure | ✅ Working |

### 2.2 Root Cause #1: Conservative Invalidation Threshold

**File**: `python-desktop-app/desktop_app.py` (lines 2474-2518)

**Problem**: Even when the server explicitly returned `OAUTH_REAUTH_REQUIRED`, the desktop app waited for **5 consecutive failures** before marking the token as invalid:

```python
# BEFORE (problematic code)
if is_permanent_failure:
    self._refresh_fail_count = getattr(self, '_refresh_fail_count', 0) + 1
    if self._refresh_fail_count >= 5:  # <-- Wait for 5 failures
        self._refresh_token_invalid = True
```

**Why 9 errors occurred**:
1. `is_authenticated()` has a retry loop: 3 attempts per call
2. Multiple callers invoke `is_authenticated()`: sync worker, proactive refresh, etc.
3. Result: 3 attempts × 3 callers = 9 requests before the 5-failure threshold is reached

### 2.3 Root Cause #2: Login Page Redirect Logic

**File**: `python-desktop-app/desktop_app.py` (lines 5862-5880)

**Problem**: The `/login` route only checked `self.current_user` (in-memory state), not whether the refresh token was invalid:

```python
# BEFORE (problematic code)
@self.app.route('/login')
def login():
    if self.current_user:  # <-- Only checks in-memory state
        return redirect('/success')
    return self.render_login_page()
```

When the session expired:
- `_refresh_token_invalid = True` (correctly set)
- `self.current_user` still had the cached user data
- Result: User redirected to `/success` instead of login page

---

## 3. Solution Design

### 3.1 Fix #1: Immediate Invalidation for Explicit Server Errors

**Principle**: When the server **explicitly** returns `errorCode: 'OAUTH_REAUTH_REQUIRED'`, mark the token invalid immediately. Reserve the 5-failure threshold for text-matched permanent failures (older servers, edge cases).

**Implementation**:

```python
# Track whether server EXPLICITLY sent the error code
server_error_code = str(error_data.get('errorCode', '')).upper()
server_explicit_reauth = (server_error_code == 'OAUTH_REAUTH_REQUIRED')

if is_permanent_failure:
    if server_explicit_reauth:
        # Server explicitly confirmed - mark invalid IMMEDIATELY
        print(f"[WARN] Server confirmed refresh token is permanently invalid...")
        self._refresh_token_invalid = True
        self._refresh_fail_count = 5  # Prevent further retries
    else:
        # Text-matching fallback - use 5-failure threshold as safety net
        self._refresh_fail_count += 1
        if self._refresh_fail_count >= 5:
            self._refresh_token_invalid = True
```

### 3.2 Fix #2: Session-Aware Login Page Routing

**Principle**: Check both `current_user` AND `_refresh_token_invalid` flag to determine if the session is truly valid.

**Implementation**:

```python
def _is_session_valid(self):
    """Check if user has a valid, refreshable session."""
    if not self.current_user:
        return False
    # If refresh token is marked invalid, session is expired
    if getattr(self.auth_manager, '_refresh_token_invalid', False):
        return False
    return True

@self.app.route('/login')
def login():
    session_expired = (self.current_user and 
                       getattr(self.auth_manager, '_refresh_token_invalid', False))
    
    if _is_session_valid(self):
        return redirect('/success')
    
    return self.render_login_page(session_expired=session_expired)
```

### 3.3 Fix #3: Session Expired Banner on Login Page

**Principle**: Show a clear message to users when their session has expired.

**Implementation**:

```python
def render_login_page(self, session_expired=False):
    expired_banner = ''
    if session_expired:
        expired_banner = '''
        <div class="session-expired-banner">
            <svg>...</svg>
            <span>Your session has expired. Please sign in again to continue.</span>
        </div>'''
    
    html = f'''<!DOCTYPE html>
    ...
    <div class="login-card">
        {expired_banner}
        ...
    </div>
    ...'''
```

---

## 4. Files Changed

### 4.1 python-desktop-app/desktop_app.py

| Section | Lines | Change |
|---------|-------|--------|
| Token refresh classification | 2436-2520 | Track `server_explicit_reauth` flag; immediate invalidation for explicit `OAUTH_REAUTH_REQUIRED` |
| Route definitions | 5862-5895 | Add `_is_session_valid()` helper; update `/` and `/login` routes |
| Login page template | 12391-12560 | Add `session_expired` parameter; add yellow banner for expired sessions |

### 4.2 python-desktop-app/tests/test_auth_refresh_classification.py

| Test | Change |
|------|--------|
| `test_refresh_reauth_error_code_is_permanent_failure` | Updated to expect immediate invalidation |
| `test_oauth_reauth_required_immediately_invalidates_token` | **New test** - verifies immediate invalidation |
| `test_non_explicit_permanent_failure_uses_5_retry_threshold` | **New test** - verifies fallback behavior |

### 4.3 python-desktop-app/test_session_management.py

| Section | Change |
|---------|--------|
| Module stubs | Added `log_auth_diagnostic` and `APP_LOGGER_AVAILABLE` stubs |

---

## 5. Test Coverage

### 5.1 Test Results

All **42 tests pass**:

```
tests/test_auth_refresh_classification.py::test_refresh_403_temporary_failure_does_not_mark_invalid PASSED
tests/test_auth_refresh_classification.py::test_refresh_reauth_error_code_is_permanent_failure PASSED
tests/test_auth_refresh_classification.py::test_refresh_text_match_underscore_phrasing_is_permanent PASSED
tests/test_auth_refresh_classification.py::test_refresh_text_match_unauthorized_client_is_permanent PASSED
tests/test_auth_refresh_classification.py::test_refresh_text_match_globally_revoked_is_permanent PASSED
tests/test_auth_refresh_classification.py::test_refresh_failure_logs_root_cause_details PASSED
tests/test_auth_refresh_classification.py::test_oauth_reauth_required_immediately_invalidates_token PASSED
tests/test_auth_refresh_classification.py::test_non_explicit_permanent_failure_uses_5_retry_threshold PASSED
test_session_management.py::TestTokenPersistenceAcrossRestart::* (4 tests) PASSED
test_session_management.py::TestGracePeriodAutoRecovery::* (4 tests) PASSED
test_session_management.py::TestTimeWindowedFailureCounting::* (6 tests) PASSED
test_session_management.py::TestNonRecursiveSubabaseToken::* (3 tests) PASSED
test_session_management.py::TestThreadSafetyInvalidFlagInsideLock::* (2 tests) PASSED
test_session_management.py::TestServer400vs401Separation::* (3 tests) PASSED
test_session_management.py::TestLogoutClearsAllState::* (2 tests) PASSED
test_session_management.py::TestSuccessfulRefreshResetsState::* (1 test) PASSED
test_session_management.py::TestIsAuthenticatedEdgeCases::* (5 tests) PASSED
test_session_management.py::TestHandleCallbackResetsFlags::* (1 test) PASSED
test_session_management.py::TestGetValidSupabaseToken::* (2 tests) PASSED
test_session_management.py::TestStressRecoveryScenario::* (1 test) PASSED

====================== 42 passed, 40 warnings in 10.87s =======================
```

### 5.2 Test Scenarios

| Scenario | Expected Behavior | Test |
|----------|-------------------|------|
| Server explicitly returns `OAUTH_REAUTH_REQUIRED` | Immediate invalidation (1 request) | `test_oauth_reauth_required_immediately_invalidates_token` |
| Text-matched permanent error (no `errorCode`) | 5-failure threshold | `test_non_explicit_permanent_failure_uses_5_retry_threshold` |
| Temporary failure (`OAUTH_TEMPORARY_FAILURE`) | Retry with backoff, no counter increment | `test_refresh_403_temporary_failure_does_not_mark_invalid` |
| Session expired, user visits `/login` | Shows login page with banner | Manual testing required |

---

## 6. Expected Behavior After Fix

### 6.1 Error Reduction

| Metric | Before | After |
|--------|--------|-------|
| Errors per expired session (explicit `OAUTH_REAUTH_REQUIRED`) | 9+ | **1** |
| Errors per expired session (text-matched) | 5+ | 5 (unchanged - safety net) |
| Time to re-auth notification | ~15-30 seconds | **Immediate** |

### 6.2 User Experience

| Scenario | Before | After |
|----------|--------|-------|
| Session expires | User sees "Authentication Issue" notification after multiple retries | User sees "Authentication Expired" notification immediately |
| User clicks login | Success page shown (can't login) | Login page with "Session expired" banner |
| User re-authenticates | Works after manual logout | Works directly from login page |

---

## 7. Deployment Notes

### 7.1 Prerequisites

- No server-side changes required (ai-server already sends `OAUTH_REAUTH_REQUIRED`)
- No database migrations required
- No configuration changes required

### 7.2 Deployment Steps

1. Deploy updated `desktop_app.py` to build server
2. Build new desktop app installer
3. Users will receive update via auto-update mechanism
4. Existing sessions with invalid refresh tokens will:
   - See re-auth notification immediately (if app is running)
   - See "Session expired" banner on login page (if they open the login page)

### 7.3 Rollback Plan

If issues occur, revert to previous version:
- The fix is backward compatible
- Previous behavior (5-retry threshold) was safe, just inefficient
- No data loss or corruption possible

---

## 8. Monitoring & Validation

### 8.1 Success Metrics

After deployment, monitor for:

1. **Reduced error log volume**: `[Auth] Token refresh error:` should appear 1x per expired session, not 9x
2. **Faster user recovery**: Time from session expiry to successful re-auth should decrease
3. **No increase in false positives**: Users should not be logged out incorrectly

### 8.2 Validation Steps

1. **Simulate session expiry**: Set refresh token to invalid value
2. **Observe**: Single error in logs, immediate notification, login page shows banner
3. **Re-authenticate**: Verify successful login from the login page

---

## 9. Related Documents

- [SESSION_EXPIRY_IMMEDIATE_INVALIDATION_FIX.md](../docs/SESSION_EXPIRY_IMMEDIATE_INVALIDATION_FIX.md) - Summary documentation
- [2026-05-26_multi-component_refresh-token-classification-fix.md](2026-05-26_multi-component_refresh-token-classification-fix.md) - Previous fix plan
- [SESSION_EXPIRATION_ROOT_CAUSE_ANALYSIS.md](../docs/SESSION_EXPIRATION_ROOT_CAUSE_ANALYSIS.md) - Original analysis
- [SESSION_MAINTENANCE_ROOT_CAUSE_ANALYSIS_V2.md](../docs/SESSION_MAINTENANCE_ROOT_CAUSE_ANALYSIS_V2.md) - JWT expiration analysis

---

## 10. Appendix: Code Diff Summary

### A. Token Refresh Classification (desktop_app.py:2436-2520)

```diff
- error_code = str(error_data.get('errorCode', '')).upper()
+ server_error_code = str(error_data.get('errorCode', '')).upper()
+ 
+ # Track whether the server EXPLICITLY sent an error code
+ server_explicit_reauth = (server_error_code == 'OAUTH_REAUTH_REQUIRED')

- if not error_code:
-     error_code = 'OAUTH_REAUTH_REQUIRED' if is_permanent_failure else 'OAUTH_TEMPORARY_FAILURE'
+ # For logging: derive error_code if server didn't provide one
+ error_code = server_error_code if server_error_code else ('OAUTH_REAUTH_REQUIRED' if is_permanent_failure else 'OAUTH_TEMPORARY_FAILURE')

  if is_permanent_failure:
-     # Track consecutive permanent failures...
-     self._refresh_fail_count += 1
-     if self._refresh_fail_count >= 5:
-         self._refresh_token_invalid = True
+     if server_explicit_reauth:
+         # Server explicitly confirmed - mark invalid IMMEDIATELY
+         self._refresh_token_invalid = True
+         self._refresh_fail_count = 5
+     else:
+         # Fallback: use 5-failure threshold as safety net
+         self._refresh_fail_count += 1
+         if self._refresh_fail_count >= 5:
+             self._refresh_token_invalid = True
```

### B. Route Definitions (desktop_app.py:5862-5895)

```diff
+ def _is_session_valid(self):
+     """Check if user has a valid, refreshable session."""
+     if not self.current_user:
+         return False
+     if getattr(self.auth_manager, '_refresh_token_invalid', False):
+         return False
+     return True

  @self.app.route('/login')
  def login():
-     if self.current_user:
+     session_expired = (self.current_user and 
+                        getattr(self.auth_manager, '_refresh_token_invalid', False))
+     
+     if _is_session_valid(self):
          return redirect('/success')
-     return self.render_login_page()
+     
+     return self.render_login_page(session_expired=session_expired)
```

### C. Login Page Template (desktop_app.py:12391-12560)

```diff
- def render_login_page(self):
+ def render_login_page(self, session_expired=False):
+     expired_banner = ''
+     if session_expired:
+         expired_banner = '''
+         <div class="session-expired-banner">
+             <svg>...</svg>
+             <span>Your session has expired. Please sign in again.</span>
+         </div>'''
+     
      html = f'''<!DOCTYPE html>
      ...
      <div class="login-card">
+         {expired_banner}
          <div class="app-logo">...
```
