# Session Expiry - Immediate Invalidation Fix

**Date**: 2026-06-03  
**Status**: ✅ Implemented and Tested (42 tests pass)  
**Severity**: Medium (log flood, unnecessary server load)

---

## Executive Summary

Fixed the root cause of repeated "refresh_token is invalid" error bursts (9+ identical errors in rapid succession) that persisted despite previous session expiry fixes.

**Root Cause**: When the AI server correctly returned `OAUTH_REAUTH_REQUIRED` (indicating a permanently dead refresh token), the desktop app was still retrying **5 times** before stopping, due to a defensive threshold designed for ambiguous errors.

**Fix**: When the server explicitly says `OAUTH_REAUTH_REQUIRED`, mark the refresh token invalid **immediately** instead of waiting for 5 failures.

---

## Problem Statement

Error logs from 2026-06-02 showed repeated bursts of identical errors:

```json
{"error":"unauthorized_client","error_description":"refresh_token is invalid","level":"error","message":"[Auth] Token refresh error:","service":"ai-analysis-server","timestamp":"2026-06-02 10:14:59"}
{"error":"unauthorized_client","error_description":"refresh_token is invalid","level":"error","message":"[Auth] Token refresh error:","service":"ai-analysis-server","timestamp":"2026-06-02 10:15:00"}
// ... (~9 identical errors within 1 second)
```

Despite previous fixes that correctly classified `unauthorized_client` as a permanent failure on the server side, the client continued to generate multiple retry requests.

---

## Technical Analysis

### Previous Fixes (Already Implemented)

1. **Layer 2** ([auth-controller.js](../ai-server/src/controllers/auth-controller.js#L560-L578)): Server correctly classifies `unauthorized_client` and `invalid_grant` as permanent failures and returns `OAUTH_REAUTH_REQUIRED`.

2. **Layer 3** ([desktop_app.py](../python-desktop-app/desktop_app.py#L2445-L2468)): Desktop client correctly detects `OAUTH_REAUTH_REQUIRED` as a permanent failure.

### The Missed Issue

The permanent failure detection worked correctly, but the **invalidation logic** was too conservative:

```python
# BEFORE: Even for permanent failures, waited for 5 consecutive failures
if is_permanent_failure:
    self._refresh_fail_count = getattr(self, '_refresh_fail_count', 0) + 1
    if self._refresh_fail_count >= 5:  # <-- Wait for 5 failures before stopping
        self._refresh_token_invalid = True
```

This 5-failure threshold was designed for **ambiguous errors** where we couldn't be certain the failure was permanent. But `OAUTH_REAUTH_REQUIRED` is **NOT ambiguous** — Atlassian has explicitly told us the token is dead.

### Why 9 Errors?

1. **`is_authenticated()`** has a retry loop: 3 attempts per call
2. **Multiple callers**: Sync worker, proactive refresh, etc. each call `is_authenticated()`
3. **Result**: 3 attempts × 3 callers = 9 requests before the 5-failure threshold is reached

---

## The Fix

**File**: [python-desktop-app/desktop_app.py](../python-desktop-app/desktop_app.py#L2474-L2518)

When the server explicitly returns `errorCode: 'OAUTH_REAUTH_REQUIRED'`:

```python
# AFTER: Immediate invalidation for explicit OAUTH_REAUTH_REQUIRED
if error_code == 'OAUTH_REAUTH_REQUIRED':
    print(f"[WARN] Server confirmed refresh token is permanently invalid...")
    self._refresh_token_invalid = True  # Mark invalid IMMEDIATELY
    self._refresh_fail_count = 5  # Set to threshold to prevent further retries
```

For text-matched permanent failures (older servers, edge cases), the 5-failure threshold is preserved as a safety net.

---

## Expected Behavior After Fix

| Scenario | Before Fix | After Fix |
|----------|------------|-----------|
| `OAUTH_REAUTH_REQUIRED` received | 5+ retries, then stop | **1 request, immediate stop** |
| Text-matched permanent error | 5 retries | 5 retries (unchanged) |
| Transient error (`OAUTH_TEMPORARY_FAILURE`) | Retry with backoff | Retry with backoff (unchanged) |

---

## Test Coverage

Updated tests in [test_auth_refresh_classification.py](../python-desktop-app/tests/test_auth_refresh_classification.py):

1. **`test_refresh_reauth_error_code_is_permanent_failure`**: Updated to expect immediate invalidation
2. **`test_oauth_reauth_required_immediately_invalidates_token`**: New test for immediate invalidation
3. **`test_non_explicit_permanent_failure_uses_5_retry_threshold`**: New test verifying fallback behavior

---

## Deployment Notes

1. This fix is **backward compatible** — it doesn't require any server-side changes
2. Deploy the updated desktop app; users will need to update to get the fix
3. The 30-minute grace period for auto-recovery is preserved
4. Users with currently invalid sessions will need to re-authenticate

---

## Related Documents

- [2026-05-26_multi-component_refresh-token-classification-fix.md](../plan/2026-05-26_multi-component_refresh-token-classification-fix.md)
- [SESSION_EXPIRATION_ROOT_CAUSE_ANALYSIS.md](SESSION_EXPIRATION_ROOT_CAUSE_ANALYSIS.md)
- [SESSION_MAINTENANCE_ROOT_CAUSE_ANALYSIS_V2.md](SESSION_MAINTENANCE_ROOT_CAUSE_ANALYSIS_V2.md)
