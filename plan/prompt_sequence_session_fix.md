# Sequential Implementation Prompts: Session Maintenance Bug Fix

**Date**: 2026-05-06  
**Component**: python-desktop-app  
**Related Spec**: [2026-05-06_python-desktop-app_fix-session-maintenance.md](2026-05-06_python-desktop-app_fix-session-maintenance.md)  
**Related RCA**: [SESSION_BUG_ROOT_CAUSE_ANALYSIS.md](SESSION_BUG_ROOT_CAUSE_ANALYSIS.md)

---

## Overview

This document contains the exact sequence of prompts to execute the Session Maintenance Bug fix following the Spec-Driven Development (SDD) workflow. Each prompt is designed to be given to the AI agent sequentially, with validation steps between each phase.

**Critical Rule**: Do NOT skip prompts or combine them. Each prompt builds on the previous one and includes specific validation to ensure correctness before proceeding.

---

## PHASE 1: Test Scaffolding

### Prompt 1.1: Create Test File Structure

```
Role: You are implementing the test scaffolding for the Session Maintenance Bug fix.

Task: Create the test file python-desktop-app/tests/test_session_maintenance.py with the following structure:

1. Import statements:
   - unittest.mock (Mock, patch, MagicMock)
   - pytest
   - datetime, timezone
   - The DesktopApp class from desktop_app.py

2. Create fixtures:
   - mock_app: A fixture that returns a partially mocked DesktopApp instance with:
     - current_user_id set to 'test-user-123'
     - app_version set to '1.3.9'
     - supabase client as None initially (will be mocked in tests)

3. Skeleton test functions (empty implementations for now):
   - test_initialize_supabase_fails_on_jwt_error
   - test_jwt_exchange_retries_on_network_error
   - test_jwt_exchange_fails_after_max_retries
   - test_update_desktop_status_returns_false_on_rls_block
   - test_update_desktop_status_returns_true_on_success
   - test_oauth_callback_shows_error_on_status_write_failure
   - test_oauth_callback_success_sets_desktop_logged_in

Reference: See acceptance criteria AC1-AC8 in the spec document.

After creating the file, run: python -m pytest tests/test_session_maintenance.py --collect-only

Expected output: Should list 7 collected test items with no errors.
```

**Validation**: Confirm 7 tests are collected successfully.

---

### Prompt 1.2: Implement Test - JWT Setup Failure Causes Init Failure

```
Role: You are writing Test-Driven Development (TDD) tests for the Session Maintenance Bug fix.

Context:
- File: python-desktop-app/desktop_app.py
- Method: initialize_supabase() at lines 5166-5244
- Current bug: Line 5228-5229 continues execution when _set_supabase_jwt() returns False

Task: Implement test_initialize_supabase_fails_on_jwt_error in tests/test_session_maintenance.py:

Test Requirements (AC1):
1. Mock the _set_supabase_jwt method to return False
2. Call initialize_supabase()
3. Assert the method returns False (not True)
4. Assert self.supabase_initialized is False
5. Assert "ERROR" appears in captured log output

Implementation hints:
- Use @patch.object(DesktopApp, '_set_supabase_jwt', return_value=False)
- Use caplog fixture to capture log messages
- Mock self.auth_manager.get_supabase_config() to return valid config

After implementation, run: python -m pytest tests/test_session_maintenance.py::test_initialize_supabase_fails_on_jwt_error -v

Expected output: TEST SHOULD FAIL (RED state) because production code still continues on JWT failure.
```

**Validation**: Test must fail with assertion error showing `initialize_supabase()` returned `True` when it should return `False`.

---

### Prompt 1.3: Implement Test - JWT Retry Logic Success

```
Role: You are writing TDD tests for JWT exchange retry logic.

Context:
- File: python-desktop-app/desktop_app.py (or auth/auth_manager.py)
- Method: get_valid_supabase_token() at lines ~2236+
- Current bug: No retry logic exists; single network failure causes permanent auth failure

Task: Implement test_jwt_exchange_retries_on_network_error in tests/test_session_maintenance.py:

Test Requirements (AC2):
1. Mock get_supabase_token() to:
   - Raise requests.exceptions.ConnectionError on first call
   - Raise requests.exceptions.Timeout on second call
   - Return valid token on third call
2. Call get_valid_supabase_token()
3. Assert the method was called exactly 3 times
4. Assert final return value is the valid token
5. Assert retry delays occurred (check sleep was called with 3, 6 seconds)

Implementation hints:
- Use side_effect=[ConnectionError(), Timeout(), "valid-jwt-token"]
- Mock time.sleep to verify backoff timing
- Use mock_app fixture and patch auth_manager methods

After implementation, run: python -m pytest tests/test_session_maintenance.py::test_jwt_exchange_retries_on_network_error -v

Expected output: TEST SHOULD FAIL (RED state) because retry logic doesn't exist yet.
```

**Validation**: Test must fail showing only 1 call was made instead of 3, or that ConnectionError was not caught.

---

### Prompt 1.4: Implement Test - JWT Retry Exhaustion

```
Role: You are writing TDD tests for JWT exchange retry exhaustion scenario.

Context:
- File: python-desktop-app/desktop_app.py
- Method: get_valid_supabase_token()
- Requirement: After 3 failed retries, return None and log error

Task: Implement test_jwt_exchange_fails_after_max_retries in tests/test_session_maintenance.py:

Test Requirements (AC2):
1. Mock get_supabase_token() to always raise requests.exceptions.Timeout
2. Call get_valid_supabase_token()
3. Assert the method was called exactly 3 times (max retries)
4. Assert final return value is None
5. Assert "ERROR" and "after 3 attempts" appears in log output

Implementation hints:
- Use side_effect=requests.exceptions.Timeout (repeating exception)
- Verify exponential backoff: sleep(3), sleep(6)
- Capture logs with caplog fixture

After implementation, run: python -m pytest tests/test_session_maintenance.py::test_jwt_exchange_fails_after_max_retries -v

Expected output: TEST SHOULD FAIL (RED state) because retry logic and max attempts don't exist.
```

**Validation**: Test must fail showing exception was not caught or retry count was wrong.

---

### Prompt 1.5: Implement Test - Desktop Status Update Returns False on RLS Block

```
Role: You are writing TDD tests for database write integrity.

Context:
- File: python-desktop-app/desktop_app.py
- Method: _update_desktop_status() at lines 6341-6370
- Current bug: Method returns nothing (None), should return False when RLS blocks write

Task: Implement test_update_desktop_status_returns_false_on_rls_block in tests/test_session_maintenance.py:

Test Requirements (AC3, AC4):
1. Create mock Supabase client where update().eq().execute() returns result with empty data list
2. Mock self.supabase to return this client
3. Call _update_desktop_status(logged_in=True)
4. Assert return value is False
5. Assert "RLS may be blocking" appears in log output

Implementation hints:
- Mock result object: Mock(data=[])  # Empty list = no rows affected
- Use @patch.object to mock self.supabase attribute
- Verify the update was called with desktop_logged_in=True

After implementation, run: python -m pytest tests/test_session_maintenance.py::test_update_desktop_status_returns_false_on_rls_block -v

Expected output: TEST SHOULD FAIL (RED state) because _update_desktop_status() doesn't return boolean.
```

**Validation**: Test must fail showing return value is `None` instead of `False`.

---

### Prompt 1.6: Implement Test - Desktop Status Update Returns True on Success

```
Role: You are writing TDD tests for successful database write verification.

Context:
- File: python-desktop-app/desktop_app.py
- Method: _update_desktop_status() at lines 6341-6370
- Requirement: Return True when write succeeds (row count > 0)

Task: Implement test_update_desktop_status_returns_true_on_success in tests/test_session_maintenance.py:

Test Requirements (AC3):
1. Create mock Supabase client where update().eq().execute() returns result with data list containing 1 row
2. Mock self.supabase to return this client
3. Call _update_desktop_status(logged_in=True)
4. Assert return value is True
5. Assert "Desktop status updated: logged in" appears in log output

Implementation hints:
- Mock result object: Mock(data=[{'id': 'test-user-123', 'desktop_logged_in': True}])
- Verify update was called with correct timestamp (desktop_last_heartbeat)
- Check desktop_app_version was included in update_data

After implementation, run: python -m pytest tests/test_session_maintenance.py::test_update_desktop_status_returns_true_on_success -v

Expected output: TEST SHOULD FAIL (RED state) because _update_desktop_status() doesn't return boolean.
```

**Validation**: Test must fail showing return value is `None` instead of `True`.

---

### Prompt 1.7: Implement Test - OAuth Callback Error Handling

```
Role: You are writing TDD tests for OAuth callback error propagation.

Context:
- File: python-desktop-app/desktop_app.py
- Method: OAuth callback handler around line 5371
- Current bug: No verification that _update_desktop_status() succeeded

Task: Implement test_oauth_callback_shows_error_on_status_write_failure in tests/test_session_maintenance.py:

Test Requirements (AC5):
1. Mock _update_desktop_status to return False
2. Mock send_login_diagnostics (if it exists) or verify error logging
3. Simulate OAuth callback completion
4. Assert error message "Failed to complete authentication" is logged
5. Assert send_login_diagnostics was called with context='failed', reason='desktop_status_write'

Implementation hints:
- Patch multiple methods: _update_desktop_status, ensure_user_exists, initialize_supabase
- Use caplog to capture error messages
- Mock self.auth_manager.handle_callback to return valid tokens

After implementation, run: python -m pytest tests/test_session_maintenance.py::test_oauth_callback_shows_error_on_status_write_failure -v

Expected output: TEST SHOULD FAIL (RED state) because OAuth callback doesn't check return value.
```

**Validation**: Test must fail showing `send_login_diagnostics` was not called or error not logged.

---

### Prompt 1.8: Implement Test - OAuth Callback Success Path

```
Role: You are writing TDD tests for successful OAuth callback flow.

Context:
- File: python-desktop-app/desktop_app.py
- Method: OAuth callback handler around line 5355-5379
- Requirement: Verify desktop_logged_in flag is written on successful login

Task: Implement test_oauth_callback_success_sets_desktop_logged_in in tests/test_session_maintenance.py:

Test Requirements (AC6, AC7):
1. Mock all Supabase operations to succeed
2. Mock _update_desktop_status to return True
3. Simulate OAuth callback
4. Assert _update_desktop_status was called with logged_in=True
5. Assert self.current_user is set correctly
6. Assert tracking is started (start_tracking called)

Implementation hints:
- Create comprehensive mock chain for OAuth flow
- Verify update() call included desktop_app_version
- Check that no error logs were generated

After implementation, run: python -m pytest tests/test_session_maintenance.py::test_oauth_callback_success_sets_desktop_logged_in -v

Expected output: TEST SHOULD FAIL (RED state) because status verification doesn't exist in callback.
```

**Validation**: Test must fail showing callback doesn't verify status write success.

---

### Prompt 1.9: Run Full Test Suite (RED State Verification)

```
Role: You are verifying the RED state of the test suite before implementation.

Task: Run the complete test suite for test_session_maintenance.py:

Command: python -m pytest tests/test_session_maintenance.py -v --tb=short

Expected output:
- All 7 tests should be collected
- All 7 tests should FAIL
- Failure reasons should match the validation steps from prompts 1.2-1.8

If any test passes at this stage, STOP and investigate why the test is not correctly validating the bug.

Document the test results:
1. List each test name and its failure reason
2. Confirm failures align with the bug description in SESSION_BUG_ROOT_CAUSE_ANALYSIS.md
3. Take a screenshot or copy the full pytest output for the commit message

After verification, commit:
git add tests/test_session_maintenance.py
git commit -m "test: add failing tests for session maintenance bug (RED state)

All 7 tests fail as expected:
- AC1: initialize_supabase continues on JWT failure
- AC2: no retry logic for JWT exchange
- AC3-4: _update_desktop_status returns None, not boolean
- AC5: OAuth callback doesn't verify status write
- AC6-7: callback doesn't react to status failure

Refs: SESSION_BUG_ROOT_CAUSE_ANALYSIS.md"
```

**Validation**: Confirm commit created with RED state documented.

---

## PHASE 2: Authentication Hardening

### Prompt 2.1: Implement Fail-Fast on JWT Setup Failure

```
Role: You are fixing the JWT setup failure handling bug.

Context:
- File: python-desktop-app/desktop_app.py
- Method: initialize_supabase() at lines 5228-5229
- Current code: Logs warning and continues when _set_supabase_jwt() returns False
- Target test: test_initialize_supabase_fails_on_jwt_error

Task: Modify initialize_supabase() to fail-fast when JWT setup fails:

Required changes:
1. Locate lines 5228-5229 (the warning after _set_supabase_jwt() returns False)
2. Change log level from WARN to ERROR
3. Add "return False" immediately after the error log
4. Update log message to: "Could not set Supabase JWT - authentication incomplete"
5. Ensure self.supabase_initialized remains False in this path

Include context: Preserve 3-5 lines before and after the change for clarity.

After implementation, run: python -m pytest tests/test_session_maintenance.py::test_initialize_supabase_fails_on_jwt_error -v

Expected output: TEST SHOULD PASS (GREEN state) - initialize_supabase now returns False on JWT failure.
```

**Validation**: Test `test_initialize_supabase_fails_on_jwt_error` must pass.

---

### Prompt 2.2: Add Retry Logic to JWT Token Acquisition

```
Role: You are implementing retry logic with exponential backoff for JWT exchange.

Context:
- File: python-desktop-app/desktop_app.py (or auth/auth_manager.py if separate)
- Method: get_valid_supabase_token() around line 2236
- Current code: Single attempt, no retry on failure
- Target tests: test_jwt_exchange_retries_on_network_error, test_jwt_exchange_fails_after_max_retries

Task: Add retry logic to get_valid_supabase_token():

Required changes:
1. Locate the call to get_supabase_token() (which hits /api/auth/exchange-token)
2. Wrap the call in a for loop: for attempt in range(3)
3. Catch these exceptions: requests.exceptions.ConnectionError, requests.exceptions.Timeout, Exception
4. On exception:
   - Log: f"[WARN] JWT exchange attempt {attempt + 1}/3 failed: {e}"
   - If attempt < 2: sleep for (attempt + 1) * 3 seconds (3s, 6s backoff)
   - If attempt == 2: break and return None
5. Add final error log if all retries fail: "[ERROR] Could not get Supabase token after 3 attempts"
6. Import time module if not already imported

Include diagnostic logging (AC8):
- Log error type, attempt count, network status

After implementation, run: python -m pytest tests/test_session_maintenance.py::test_jwt_exchange_retries_on_network_error tests/test_session_maintenance.py::test_jwt_exchange_fails_after_max_retries -v

Expected output: Both tests SHOULD PASS (GREEN state).
```

**Validation**: Both retry tests must pass. Verify sleep was called with correct backoff intervals.

---

### Prompt 2.3: Verify Authentication Hardening Tests

```
Role: You are verifying Phase 2 implementation.

Task: Run all authentication-related tests:

Command: python -m pytest tests/test_session_maintenance.py::test_initialize_supabase_fails_on_jwt_error tests/test_session_maintenance.py::test_jwt_exchange_retries_on_network_error tests/test_session_maintenance.py::test_jwt_exchange_fails_after_max_retries -v

Expected output: All 3 tests PASS.

If any test fails:
1. Review the implementation against the spec
2. Check that error handling is exhaustive (catch all exception types)
3. Verify log messages match expected patterns
4. Re-run individual test with --tb=long for detailed traceback

After all pass, commit:
git add python-desktop-app/desktop_app.py
git commit -m "fix(desktop): implement fail-fast JWT setup and retry logic

Changes:
- initialize_supabase() now returns False on JWT setup failure
- get_valid_supabase_token() retries 3 times with exponential backoff
- Comprehensive exception handling for network failures

Tests passing: AC1, AC2
Refs: #SESSION_BUG"
```

**Validation**: Confirm commit created with passing tests documented.

---

## PHASE 3: Database Write Integrity

### Prompt 3.1: Make Desktop Status Update Return Boolean

```
Role: You are fixing the database write verification bug.

Context:
- File: python-desktop-app/desktop_app.py
- Method: _update_desktop_status() at lines 6341-6370
- Current code: Returns nothing (implicitly None), silently catches exceptions
- Target tests: test_update_desktop_status_returns_false_on_rls_block, test_update_desktop_status_returns_true_on_success

Task: Modify _update_desktop_status() to return success/failure:

Required changes:
1. Add docstring return type: """... Returns: True if successful, False if failed"""
2. Change all early returns (lines 6345, 6350) to "return False"
3. After the Supabase update().execute() call (line 6366):
   a. Capture result: result = client.table('users').update(update_data).eq('id', self.current_user_id).execute()
   b. Check if result.data is empty: if not result.data or len(result.data) == 0
   c. If empty, log WARN and return False
4. After successful write, return True (line ~6368)
5. In the exception handler (line 6369), add "return False" after logging error
6. Add full traceback logging: import traceback, then traceback.print_exc() in exception handler

Include context: Show 5+ lines around each change for clarity.

After implementation, run: python -m pytest tests/test_session_maintenance.py::test_update_desktop_status_returns_false_on_rls_block tests/test_session_maintenance.py::test_update_desktop_status_returns_true_on_success -v

Expected output: Both tests SHOULD PASS (GREEN state).
```

**Validation**: Both status update tests must pass. Verify return types are boolean.

---

### Prompt 3.2: Verify Database Write Integrity Tests

```
Role: You are verifying Phase 3 implementation.

Task: Run all database write tests:

Command: python -m pytest tests/test_session_maintenance.py::test_update_desktop_status_returns_false_on_rls_block tests/test_session_maintenance.py::test_update_desktop_status_returns_true_on_success -v

Expected output: Both tests PASS.

Additional verification:
1. Check log output includes "RLS may be blocking" for RLS failure case
2. Verify return value type is bool, not None
3. Confirm traceback is printed on exception (use --log-cli-level=DEBUG if needed)

After all pass, commit:
git add python-desktop-app/desktop_app.py
git commit -m "fix(desktop): make desktop status update return boolean

Changes:
- _update_desktop_status() now returns True on success, False on failure
- Checks result.data for empty list (RLS block detection)
- Adds full stack trace logging on exceptions

Tests passing: AC3, AC4
Refs: #SESSION_BUG"
```

**Validation**: Confirm commit created with passing tests documented.

---

## PHASE 4: Diagnostics & UI Sync

### Prompt 4.1: Add Status Write Verification to OAuth Callback

```
Role: You are implementing status write verification in the OAuth callback flow.

Context:
- File: python-desktop-app/desktop_app.py
- Location: OAuth callback handler around line 5371
- Current code: Calls _update_desktop_status(logged_in=True) but doesn't check result
- Target tests: test_oauth_callback_shows_error_on_status_write_failure, test_oauth_callback_success_sets_desktop_logged_in

Task: Modify OAuth callback to verify status write:

Required changes:
1. Locate line 5371: self._update_desktop_status(logged_in=True)
2. Change to: success = self._update_desktop_status(logged_in=True)
3. Add verification block:
   ```python
   if not success:
       error_msg = "Failed to complete authentication - please try logging in again"
       print(f"[ERROR] {error_msg}")
       # Send diagnostic if function exists
       if hasattr(self, 'send_login_diagnostics'):
           self.send_login_diagnostics(
               self.auth_manager, 
               'failed', 
               'desktop_status_write',
               error=error_msg
           )
       return error_msg, 500
   ```
4. Preserve existing success path (line 5379: self.start_tracking())

Note: If send_login_diagnostics doesn't exist, create a stub method that logs the diagnostic data structurally (JSON format).

After implementation, run: python -m pytest tests/test_session_maintenance.py::test_oauth_callback_shows_error_on_status_write_failure tests/test_session_maintenance.py::test_oauth_callback_success_sets_desktop_logged_in -v

Expected output: Both tests SHOULD PASS (GREEN state).
```

**Validation**: Both OAuth callback tests must pass. Verify error handling stops execution on failure.

---

### Prompt 4.2: Implement Diagnostic Logging (If Needed)

```
Role: You are implementing structured diagnostic logging for authentication failures.

Context:
- File: python-desktop-app/desktop_app.py
- Method: send_login_diagnostics() (may not exist yet)
- Purpose: Log structured data for production debugging (AC8)

Task: Create or verify send_login_diagnostics() method:

Required implementation:
```python
def send_login_diagnostics(self, auth_manager, status, reason, error=None):
    """Send structured diagnostic data for login flow debugging
    
    Args:
        auth_manager: Auth manager instance
        status: 'success' or 'failed'
        reason: Specific failure reason ('jwt_exchange', 'desktop_status_write', etc.)
        error: Optional error message or exception string
    """
    import json
    
    diagnostic_data = {
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'status': status,
        'reason': reason,
        'app_version': self.app_version,
        'user_id': self.current_user_id if hasattr(self, 'current_user_id') else None,
        'error': str(error) if error else None
    }
    
    print(f"[DIAGNOSTIC] Login flow: {json.dumps(diagnostic_data, indent=2)}")
    
    # Optionally send to analytics endpoint (out of scope for this fix)
    # self._send_to_analytics(diagnostic_data)
```

Location: Add after _update_desktop_status() method (~line 6370)

After implementation, re-run OAuth tests to verify diagnostic logging works.

No specific test needed - this is verified by test_oauth_callback_shows_error_on_status_write_failure.
```

**Validation**: Verify diagnostic data is logged in JSON format when status write fails.

---

### Prompt 4.3: Verify Diagnostics & UI Sync Tests

```
Role: You are verifying Phase 4 implementation.

Task: Run all OAuth callback and diagnostics tests:

Command: python -m pytest tests/test_session_maintenance.py::test_oauth_callback_shows_error_on_status_write_failure tests/test_session_maintenance.py::test_oauth_callback_success_sets_desktop_logged_in -v

Expected output: Both tests PASS.

Additional verification:
1. Check that error logging includes diagnostic data (JSON format)
2. Verify OAuth callback returns 500 status on status write failure
3. Confirm success path continues to call start_tracking()

After all pass, commit:
git add python-desktop-app/desktop_app.py
git commit -m "fix(desktop): add status write verification to OAuth callback

Changes:
- OAuth callback now checks _update_desktop_status() return value
- Returns error 500 if status write fails
- Implements send_login_diagnostics() for structured error logging

Tests passing: AC5, AC6, AC7, AC8
Refs: #SESSION_BUG"
```

**Validation**: Confirm commit created with all Phase 4 tests passing.

---

## PHASE 5: Verification

### Prompt 5.1: Run Complete Test Suite (GREEN State Verification)

```
Role: You are verifying the complete implementation.

Task: Run the full test suite for session maintenance:

Command: python -m pytest tests/test_session_maintenance.py -v --tb=short --cov=desktop_app --cov-report=term-missing

Expected output:
- All 7 tests PASS (GREEN state)
- Coverage report shows lines 5228-5229, 5371-5378, 6341-6370 are covered
- No warnings or errors

If any test fails:
1. Review the failure output
2. Check if the implementation matches the spec exactly
3. Verify all mocks are properly configured
4. Re-run failed test with --tb=long for full traceback

Document the results:
1. Screenshot or copy full pytest output
2. Note coverage percentage for modified methods
3. Confirm all acceptance criteria (AC1-AC8) are validated

After verification, create final commit:
git add tests/test_session_maintenance.py
git commit -m "test: verify all session maintenance tests pass (GREEN state)

All 7 tests passing:
✓ AC1: initialize_supabase fails fast on JWT error
✓ AC2: JWT exchange retries with exponential backoff
✓ AC3-4: Desktop status update returns boolean + verifies RLS
✓ AC5: OAuth callback handles status write failure
✓ AC6-7: OAuth callback sets desktop_logged_in on success
✓ AC8: Diagnostic logging captures structured error data

Coverage: [report coverage %]
Refs: #SESSION_BUG"
```

**Validation**: All 7 tests must pass. Coverage should be >80% for modified methods.

---

### Prompt 5.2: Run Regression Test Suite

```
Role: You are running regression tests to ensure no existing functionality broke.

Task: Run the full python-desktop-app test suite:

Command: python -m pytest tests/ -v --tb=short -k "not integration"

Expected output:
- All existing tests continue to pass
- New test_session_maintenance.py tests all pass
- No new failures introduced

If any existing test fails:
1. Identify which test broke
2. Review if your changes affected that code path
3. Check if the test needs updating (mocks may need adjustment for new return values)
4. Fix the issue before proceeding

Common issues to check:
- Tests that mock _update_desktop_status may need to handle boolean return
- Tests that call initialize_supabase may fail faster now (expected behavior)
- OAuth flow tests may need to mock the new status verification

Document regression results:
- List any tests that needed adjustment
- Confirm total test count increased by 7
- Note overall pass rate
```

**Validation**: No regressions. All existing tests continue to pass (possibly with minor mock adjustments).

---

### Prompt 5.3: Manual Testing with Local Supabase

```
Role: You are performing manual integration testing.

Context: The code changes are complete and unit tests pass. Now verify the fix works end-to-end with a local Supabase instance.

Prerequisites:
- Local Supabase running: cd supabase && supabase start
- AI server running: cd ai-server && npm run dev
- Desktop app built: cd python-desktop-app && python desktop_app.py

Task: Perform manual verification checklist:

Test Scenario 1: Successful Login
1. Clear credentials in desktop app
2. Click "Login with Atlassian"
3. Complete OAuth flow with test account
4. Verify console output shows:
   - "[OK] Supabase JWT set on client"
   - "[OK] Desktop status updated: logged in"
   - No ERROR or WARN messages
5. Check Supabase users table:
   ```sql
   SELECT id, email, desktop_logged_in, desktop_last_heartbeat, desktop_app_version 
   FROM users 
   WHERE email = '[your-test-email]';
   ```
   Expected: desktop_logged_in = true, recent timestamp
6. Open Jira Forge UI (local tunnel: forge tunnel)
7. Navigate to Admin Panel
8. Verify: "Active" status displayed, NOT "Admin Panel Locked"

Test Scenario 2: JWT Exchange Failure with Retry
1. Stop the AI server (npm stop)
2. Attempt login in desktop app
3. Verify console output shows:
   - "[WARN] JWT exchange attempt 1/3 failed: ..."
   - "[WARN] JWT exchange attempt 2/3 failed: ..."
   - "[WARN] JWT exchange attempt 3/3 failed: ..."
   - "[ERROR] Could not get Supabase token after 3 attempts"
   - "[ERROR] Could not set Supabase JWT - authentication incomplete"
4. Verify login fails with error message to user
5. Restart AI server
6. Retry login - should succeed

Test Scenario 3: RLS Write Failure Detection
1. Manually corrupt the JWT in desktop app (invalid signature)
2. Attempt to update status (trigger heartbeat or re-login)
3. Verify console output shows:
   - "[WARN] Desktop status update returned no rows - RLS may be blocking"
   - "[ERROR] Failed to complete authentication..."
   - "[DIAGNOSTIC] Login flow: {status: 'failed', reason: 'desktop_status_write'}"

Document results:
- Screenshot of successful login flow (console + Supabase table)
- Screenshot of retry behavior (console showing 3 attempts)
- Screenshot of Jira UI showing "Active" status
- Note any unexpected behavior
```

**Validation**: All 3 scenarios work as expected. User experience matches AC1-AC8.

---

### Prompt 5.4: Create Final Summary & Close

```
Role: You are documenting the completed fix.

Task: Create a summary comment in the SESSION_BUG_ROOT_CAUSE_ANALYSIS.md file:

Add this section at the top of the file:

---
## FIX VERIFICATION (2026-05-06)

**Status**: ✅ RESOLVED

### Implementation Summary
All fixes from PART 5 (The Fix Required) have been successfully implemented and tested.

#### Changes Made:
1. ✅ Fix 1: initialize_supabase() now returns False on JWT setup failure (line 5228-5229)
2. ✅ Fix 2: get_valid_supabase_token() implements 3-retry with exponential backoff (3s, 6s)
3. ✅ Fix 3: _update_desktop_status() returns boolean + verifies result.data (lines 6341-6370)
4. ✅ Fix 4: OAuth callback verifies status write success + sends diagnostics (line 5371)

#### Test Results:
- Unit tests: 7/7 passing ✓
- Regression tests: All existing tests pass ✓
- Manual integration: All scenarios verified ✓

#### Files Modified:
- python-desktop-app/desktop_app.py (4 methods)
- python-desktop-app/tests/test_session_maintenance.py (new file, 7 tests)

#### Commits:
- [commit hash] test: add failing tests (RED state)
- [commit hash] fix: authentication hardening (AC1, AC2)
- [commit hash] fix: database write integrity (AC3, AC4)
- [commit hash] fix: diagnostics & UI sync (AC5-AC8)
- [commit hash] test: verify GREEN state

### Verification Checklist:
- [x] AC1: initialize_supabase fails fast on JWT error
- [x] AC2: JWT exchange retries with backoff
- [x] AC3: Desktop status update returns boolean
- [x] AC4: RLS block detection logs warning
- [x] AC5: OAuth callback shows error on write failure
- [x] AC6: desktop_logged_in flag set to true on success
- [x] AC7: Jira UI shows Active status (not locked)
- [x] AC8: Structured diagnostic logging on failures

### Deployment Notes:
- No database migrations required
- No AI server changes required
- Desktop app version: 1.4.0 (next release)
- Backward compatible with existing user sessions

**Next Steps**: Deploy to beta testers, monitor diagnostic logs for any edge cases.

---

After adding this section, commit:
git add plan/SESSION_BUG_ROOT_CAUSE_ANALYSIS.md
git commit -m "docs: mark session maintenance bug as resolved

All acceptance criteria verified.
Ready for beta deployment.

Refs: #SESSION_BUG"
```

**Final Step**: Tag the release candidate:
```bash
git tag -a v1.4.0-rc1 -m "Release candidate: Session maintenance bug fix"
git push origin v1.4.0-rc1
```

---

## Summary

This prompt sequence ensures:
- ✅ Tests written first (TDD)
- ✅ Each change validated individually
- ✅ No golden path bias (error cases explicitly tested)
- ✅ Full regression testing
- ✅ Manual end-to-end verification
- ✅ Proper documentation and git history

**Total prompts**: 15 (1.9 test setup, 4 implementation, 4 verification, 1 manual testing, 1 documentation)  
**Estimated time**: 3-4 hours for complete implementation and verification

**Critical Success Factor**: Do NOT skip validation steps. Each GREEN test confirms a specific bug is fixed. If a test fails unexpectedly, investigate before proceeding to the next prompt.
