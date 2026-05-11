# Spec: Fix Session Maintenance Bug - Desktop Logged-In Flag

**Date**: 2026-05-06  
**Component**: python-desktop-app  
**Status**: Draft  
**Severity**: 🔴 CRITICAL  
**Related Docs**: [SESSION_BUG_ROOT_CAUSE_ANALYSIS.md](../plan/SESSION_BUG_ROOT_CAUSE_ANALYSIS.md)

---

## Problem

**User-Visible Symptom**: Users complete OAuth login successfully in the desktop app (v1.3.5+) and see "Logged in as: [email]" in the system tray. However, when they navigate to the Jira Forge UI, they encounter an "Admin Panel Locked" message stating "The admin panel is not available until the desktop app has authenticated."

**Impact**:
- Users cannot access admin features in Jira despite being authenticated
- Time tracking data is visible (partial session access) but admin controls are blocked
- No error messages visible to user - creates confusion about authentication state
- Affects all users who log in via Atlassian OAuth

**Root Cause**: The `desktop_logged_in` flag in the Supabase `users` table is never set to `true` after successful OAuth login due to silent failures in the authentication flow.

---

## Root Cause / Context

### Technical Chain of Failures

1. **JWT Setup Failure Silently Ignored** (`desktop_app.py:5228-5229`)
   - `initialize_supabase()` calls `_set_supabase_jwt()` to authenticate the Supabase client
   - If JWT exchange fails (network timeout, token expired, server error), `_set_supabase_jwt()` returns `False`
   - Current code logs a warning but **continues execution** instead of failing fast
   - Supabase client is marked as "initialized" but lacks JWT authentication

2. **RLS-Protected Write Fails Silently** (`desktop_app.py:6365-6369`)
   - After OAuth completes, `_update_desktop_status(logged_in=True)` is called
   - Without a valid JWT, the Supabase client has no `auth.uid()` context
   - The RLS policy `WHERE supabase_user_id = auth.uid()` blocks the write
   - Exception is caught, logged as warning, and **execution continues**
   - The `desktop_logged_in` flag remains `NULL` in the database

3. **Forge UI Detects NULL as "Not Setup"** (`forge-app/src/resolvers/userResolvers.js:120-138`)
   - When rendering the admin panel, Forge queries the `users` table
   - If `desktop_logged_in` is `NULL`, it returns status `'not-setup'`
   - UI displays "Admin Panel Locked" message with download instructions

### Why JWT Exchange Can Fail

The `/api/auth/exchange-token` endpoint (`ai-server/src/controllers/auth-controller.js:615-750`) may fail due to:
- Network timeout calling Atlassian API for token verification
- Expired or revoked Atlassian access token
- Auto-provisioning failures (Jira cloud resources inaccessible)
- Supabase JWT secret misconfiguration
- User record not created successfully in auto-provisioning

### Current Error Handling Gap

No retry logic exists for transient failures. A single network timeout during JWT exchange permanently leaves the user in a broken state until manual re-authentication.

---

## Proposed Solution

### 1. Fail-Fast on JWT Setup Failure

**File**: `python-desktop-app/desktop_app.py`  
**Location**: Lines 5228-5229 in `initialize_supabase()`

**Change**: When `_set_supabase_jwt()` returns `False`, immediately return `False` from `initialize_supabase()` instead of continuing.

**Rationale**: Without JWT, all subsequent RLS-protected operations will fail silently. Better to fail the login attempt and prompt user to retry than to proceed in a broken state.

### 2. Add Retry Logic with Exponential Backoff

**File**: `python-desktop-app/desktop_app.py`  
**Location**: Lines 2236+ in `auth/auth_manager.py` (called from `_set_supabase_jwt()`)

**Change**: Wrap the `get_supabase_token()` call (which hits `/api/auth/exchange-token`) in a retry loop:
- Maximum 3 attempts
- Exponential backoff: 3s, 6s between retries
- Log each failure with specific error context

**Rationale**: Transient network failures should not cause permanent authentication issues. Most failures are recoverable with retry.

### 3. Make Desktop Status Update Return Boolean

**File**: `python-desktop-app/desktop_app.py`  
**Location**: Lines 6341-6370 in `_update_desktop_status()`

**Change**: 
- Modify method signature to return `bool` (`True` = success, `False` = failure)
- Check `result.data` for empty list (indicates RLS blocked the write)
- Return `False` on exception instead of silently continuing
- Add full stack trace logging on failure

**Rationale**: Caller needs to know if the critical write succeeded to decide whether to proceed or prompt user to retry.

### 4. Verify Write Success After Login

**File**: `python-desktop-app/desktop_app.py`  
**Location**: Line 5371 in OAuth callback handler

**Change**: 
- Capture return value from `_update_desktop_status(logged_in=True)`
- If write fails, call `send_login_diagnostics()` with error context
- Log error message visible to user: "Failed to complete authentication - please try logging in again"

**Rationale**: User needs immediate feedback if authentication didn't complete successfully, rather than discovering the issue later in Jira.

### 5. Add Diagnostic Logging

Add structured logging at each failure point to aid in production debugging:
- JWT exchange attempt/success/failure with error details
- RLS write attempt with row count verification
- Supabase client JWT header verification

---

## Acceptance Criteria

The following outcomes must be observable after implementation:

1. **AC1**: When `/api/auth/exchange-token` returns an error, `initialize_supabase()` returns `False` and login flow stops
2. **AC2**: When `/api/auth/exchange-token` fails due to transient network error, the system retries up to 3 times with exponential backoff before giving up
3. **AC3**: When `_update_desktop_status()` writes to Supabase, it returns `True` if the write succeeds (row count > 0) and `False` if it fails
4. **AC4**: When `_update_desktop_status()` is called with `logged_in=True` and the write is blocked by RLS, the method returns `False` and logs the specific RLS failure
5. **AC5**: When the OAuth callback completes and `_update_desktop_status()` returns `False`, an error message is displayed to the user via the tray notification
6. **AC6**: When a user successfully logs in and all steps complete, the `desktop_logged_in` flag in the Supabase `users` table is set to `true`
7. **AC7**: When a user successfully logs in, the Jira Forge UI shows "Active" status instead of "Admin Panel Locked" within 30 seconds
8. **AC8**: When JWT exchange fails on all retry attempts, structured diagnostic data is logged including: attempt count, error type, network status, token expiry

---

## Test Plan

### Unit Tests (pytest)

**File**: `python-desktop-app/tests/test_session_maintenance.py` (new file)

Test cases to write **before** implementation:

1. **test_initialize_supabase_fails_on_jwt_error**
   - Mock `_set_supabase_jwt()` to return `False`
   - Call `initialize_supabase()`
   - Assert it returns `False` (not `True`)
   - Assert `self.supabase_initialized` is `False`

2. **test_jwt_exchange_retries_on_network_error**
   - Mock `get_supabase_token()` to raise `requests.exceptions.ConnectionError` twice, then succeed
   - Call `get_valid_supabase_token()`
   - Assert 3 calls were made
   - Assert final return is valid token

3. **test_jwt_exchange_fails_after_max_retries**
   - Mock `get_supabase_token()` to always raise `requests.exceptions.Timeout`
   - Call `get_valid_supabase_token()`
   - Assert 3 calls were made
   - Assert final return is `None`

4. **test_update_desktop_status_returns_false_on_rls_block**
   - Mock Supabase client `update().eq().execute()` to return empty `data` list
   - Call `_update_desktop_status(logged_in=True)`
   - Assert return value is `False`

5. **test_update_desktop_status_returns_true_on_success**
   - Mock Supabase client `update().eq().execute()` to return `data=[{...}]`
   - Call `_update_desktop_status(logged_in=True)`
   - Assert return value is `True`

6. **test_oauth_callback_shows_error_on_status_write_failure**
   - Mock `_update_desktop_status()` to return `False`
   - Mock `send_login_diagnostics()` to verify it's called
   - Simulate OAuth callback
   - Assert error message is logged
   - Assert `send_login_diagnostics()` was called with error context

7. **test_oauth_callback_success_sets_desktop_logged_in**
   - Mock all Supabase operations to succeed
   - Mock `_update_desktop_status()` to return `True`
   - Simulate OAuth callback
   - Assert `update()` was called with `desktop_logged_in=True`

### Integration Tests

**File**: `python-desktop-app/tests/integration/test_full_login_flow.py` (new file)

1. **test_full_login_flow_with_valid_token**
   - Use test Supabase instance
   - Complete full OAuth flow with mock Atlassian token
   - Verify `desktop_logged_in=True` in database
   - Verify `desktop_last_heartbeat` is set

2. **test_login_flow_with_jwt_exchange_failure**
   - Mock AI server to return 500 error on `/api/auth/exchange-token`
   - Attempt login
   - Verify login returns error
   - Verify `desktop_logged_in` is `NULL` or `False` in database

---

## Agent Sequence

Once this spec is approved, implementation will proceed in these steps:

### Step 1: Write Failing Tests
- Create `tests/test_session_maintenance.py` with all 7 unit tests
- Create `tests/integration/test_full_login_flow.py` with 2 integration tests
- Run `python -m pytest tests/test_session_maintenance.py -v`
- Confirm all tests fail (RED state)
- Commit: `test: add failing tests for session maintenance bug`

### Step 2: Implement Fix #1 - Fail-Fast JWT Setup
- Modify `initialize_supabase()` at line 5228-5229
- Change warning to error and return `False`
- Run tests: `test_initialize_supabase_fails_on_jwt_error` should pass
- Commit: `fix(desktop): fail-fast on JWT setup failure`

### Step 3: Implement Fix #2 - Retry Logic
- Modify `auth/auth_manager.py` in `get_valid_supabase_token()`
- Add retry loop with exponential backoff
- Run tests: `test_jwt_exchange_retries_on_network_error` and `test_jwt_exchange_fails_after_max_retries` should pass
- Commit: `fix(desktop): add retry with backoff for JWT exchange`

### Step 4: Implement Fix #3 - Return Boolean from Status Update
- Modify `_update_desktop_status()` signature and implementation
- Add `return True/False` based on result
- Check `result.data` for empty list
- Run tests: `test_update_desktop_status_returns_false_on_rls_block` and `test_update_desktop_status_returns_true_on_success` should pass
- Commit: `fix(desktop): make desktop status update return boolean`

### Step 5: Implement Fix #4 - Verify Write After Login
- Modify OAuth callback handler at line 5371
- Capture return value and handle failure case
- Add error logging and diagnostic call
- Run tests: `test_oauth_callback_shows_error_on_status_write_failure` and `test_oauth_callback_success_sets_desktop_logged_in` should pass
- Commit: `fix(desktop): verify and report status write failures`

### Step 6: Run Full Test Suite
- Run `python -m pytest tests/ -v`
- Confirm no regressions
- Confirm all new tests pass (GREEN state)

### Step 7: Manual Verification
- Test on local desktop app:
  1. Clear credentials
  2. Login with test Atlassian account
  3. Verify `desktop_logged_in=true` in Supabase
  4. Open Jira Forge UI
  5. Verify admin panel is accessible
- Test failure scenario:
  1. Disconnect network during JWT exchange
  2. Verify retry attempts logged
  3. Verify error message shown to user
  4. Reconnect network and retry login
  5. Verify successful login after reconnection

### Step 8: Update Documentation
- Update `docs/desktop-app_TROUBLESHOOTING.md` with new error messages
- Add section "Session Maintenance Issues" with diagnostic steps

---

## Out of Scope

The following are explicitly **NOT** part of this fix:

1. **UI/UX improvements to login flow** - keeping existing tray notification system
2. **Forge UI status polling optimization** - no changes to how often Forge checks `desktop_logged_in`
3. **Heartbeat mechanism changes** - heartbeat continues to run every 4 hours unchanged
4. **OAuth token refresh improvements** - only fixing the initial JWT exchange, not token refresh logic
5. **AI server endpoint modifications** - no changes to `/api/auth/exchange-token` or `/api/auth/supabase-config`
6. **RLS policy changes** - no modifications to Supabase Row Level Security policies
7. **Auto-provisioning flow changes** - not modifying user/org creation logic in AI server
8. **Desktop app version migration** - no special handling for users upgrading from v1.3.5 to fixed version

### Why These Are Out of Scope

This fix focuses narrowly on **error handling and observability** in the existing authentication flow. Changes to OAuth token management, server endpoints, or database policies would require separate specs with their own test plans and could introduce additional risks.

Users experiencing this issue can resolve it by logging out and logging back in after the fix is deployed (manual workaround documented in SESSION_BUG_ROOT_CAUSE_ANALYSIS.md Part 7).

---

## Success Metrics

Post-deployment, we expect:
- Zero "Admin Panel Locked" reports from users with "Logged in" desktop status
- Decrease in support tickets related to authentication state mismatch
- Increase in successful login attempts (captured via diagnostic logging)
- Reduction in silent authentication failures (visible via new structured logs)

---

## Rollback Plan

If the fix introduces regressions:
1. Revert commits in reverse order (Step 5 → Step 4 → Step 3 → Step 2)
2. Deploy previous desktop app version (v1.3.9) via release rollback
3. Re-enable old behavior by commenting out fail-fast logic temporarily
4. Investigate regression via structured logs added in this fix

---

**Spec Author**: GitHub Copilot (via Agent)  
**Review Required**: Yes  
**Next Step**: Await spec approval before proceeding to Step 1 (Write Failing Tests)
