# Token Refresh Fix — Implementation Prompts

**Reference:** [2026-05-14_token_refresh_failure_root_cause_analysis.md](./2026-05-14_token_refresh_failure_root_cause_analysis.md)

---

## Phase 1: Immediate Mitigation

### PROMPT 1.1: Enhance Token Refresh Logging (ai-server)

**Context:** The ai-server currently logs token refresh errors without sufficient context. We need user_id, client_id prefix, HTTP status, and correlation IDs to diagnose the issue.

**Task:** Enhance the token refresh logging in `ai-server/src/controllers/auth-controller.js` to include diagnostic information.

**Requirements:**

1. **Before making any changes:**
   - Read the full `refreshToken()` function (lines 499-565)
   - Read the `verifyAtlassianToken()` function (lines 75-90) to understand how to decode user info
   - Understand the current error handling pattern

2. **Generate a correlation ID:**
   - At the start of `refreshToken()`, generate a UUID:
     ```javascript
     const crypto = require('crypto');
     const correlationId = crypto.randomUUID();
     ```
   - Add it to the logger context for all subsequent log calls

3. **Extract user info (optional — only if feasible):**
   - The `refresh_token` is opaque (cannot decode)
   - BUT: If the desktop app also sends the current `access_token` in a separate field, we can decode it
   - For now, skip this — log only what's available

4. **Update the initial info log (line 509):**
   ```javascript
   logger.info('[Auth] Refreshing Atlassian access token', {
     correlationId,
     client_id_prefix: clientId.substring(0, 8),
     refresh_token_prefix: refresh_token.substring(0, 8) + '...',
   });
   ```

5. **Update the success log (line 533):**
   ```javascript
   logger.info('[Auth] Successfully refreshed access token', {
     correlationId,
     token_rotated: !!tokens.refresh_token, // True if Atlassian returned new refresh token
     expires_in: tokens.expires_in,
   });
   ```

6. **Update the error log (line 541):**
   ```javascript
   logger.error('[Auth] Token refresh error', {
     correlationId,
     client_id_prefix: clientId.substring(0, 8),
     refresh_token_prefix: refresh_token.substring(0, 8) + '...',
     status: error.response?.status,
     error_code: error.response?.data?.error,
     error_description: error.response?.data?.error_description,
     full_error: error.response?.data || error.message,
   });
   ```

7. **Add the correlation ID to the response (for desktop app tracing):**
   - In the success response (line 534-538), add: `correlationId`
   - In the error responses (lines 547-551, 556-558), add: `correlationId`

8. **Write a test for this change:**
   - File: `ai-server/tests/controllers/auth-controller.test.js`
   - Test name: `'should log correlation ID and prefixes on refresh'`
   - Mock logger.info and logger.error
   - Call `refreshToken()` with mocked axios
   - Assert that logger.info was called with `correlationId`, `client_id_prefix`, `refresh_token_prefix`

**Acceptance criteria:**
- ✅ All refresh attempts log a unique `correlationId`
- ✅ Client ID prefix (first 8 chars) is logged
- ✅ Refresh token prefix (first 8 chars) is logged (NEVER the full token)
- ✅ HTTP status code is logged on error
- ✅ Full error object from Atlassian is logged on error
- ✅ Success logs indicate whether token rotation occurred
- ✅ Test coverage added

**Files to modify:**
- `ai-server/src/controllers/auth-controller.js` (lines 499-565)
- `ai-server/tests/controllers/auth-controller.test.js` (add new test)

---

### PROMPT 1.2: Improve Error Classification (ai-server)

**Context:** Atlassian returns `unauthorized_client` as HTTP 400 (not 401) when refresh tokens are invalid. The ai-server currently only sets `requiresReauth: true` for 401 errors, causing the desktop app to retry invalid tokens.

**Task:** Update the error handler in `refreshToken()` to correctly classify permanent vs transient failures.

**Requirements:**

1. **Read the current error handler (lines 540-562):**
   - Understand the distinction between 401 and 400
   - Note the comment explaining why 400 is treated as transient

2. **Update the error classification logic:**
   ```javascript
   catch (error) {
     logger.error('[Auth] Token refresh error', { /* ...existing context... */ });

     const status = error.response?.status;
     const errorCode = error.response?.data?.error;

     // Determine if this is a permanent failure requiring re-authentication
     const isPermanentFailure = 
       status === 401 ||
       status === 403 ||
       (status === 400 && errorCode === 'invalid_grant') ||
       (status === 400 && errorCode === 'unauthorized_client');

     if (isPermanentFailure) {
       return res.status(status || 401).json({
         success: false,
         error: 'Refresh token expired or invalid. User must re-authenticate.',
         requiresReauth: true,
         errorCode, // Include for desktop app logging
         correlationId, // Include for traceability
       });
     }

     // For other 400 errors (malformed request, etc.) and 5xx errors,
     // treat as transient/retryable without requiresReauth
     res.status(status || 500).json({
       success: false,
       error: `Token refresh failed: ${formatAtlassianError(error)}`,
       errorCode,
       correlationId,
     });
   }
   ```

3. **Update the comment explaining the logic:**
   ```javascript
   // Permanent failures (require user to re-authenticate):
   // - 401: Token expired or revoked by Atlassian
   // - 403: User revoked app permissions
   // - 400 + invalid_grant: Refresh token is truly invalid (Atlassian OAuth spec)
   // - 400 + unauthorized_client: Client credentials don't match token or token is invalid
   //
   // Transient failures (client should retry):
   // - 400 + other error codes (e.g., invalid_request = malformed JSON)
   // - 5xx: Atlassian server error
   ```

4. **Write tests for each case:**
   - File: `ai-server/tests/controllers/auth-controller.test.js`
   - Test cases:
     - `'should set requiresReauth=true for 401'` (already exists — verify)
     - `'should set requiresReauth=true for 400 + invalid_grant'` (NEW)
     - `'should set requiresReauth=true for 400 + unauthorized_client'` (NEW)
     - `'should NOT set requiresReauth for 400 + invalid_request'` (NEW)
     - `'should NOT set requiresReauth for 500'` (already exists — verify)

5. **Update desktop app documentation:**
   - File: `python-desktop-app/TOKEN_REFRESH_IMPLEMENTATION.md`
   - Add a section explaining the `requiresReauth` flag and error codes

**Acceptance criteria:**
- ✅ HTTP 401 → `requiresReauth: true` (existing)
- ✅ HTTP 403 → `requiresReauth: true` (new)
- ✅ HTTP 400 + `invalid_grant` → `requiresReauth: true` (new)
- ✅ HTTP 400 + `unauthorized_client` → `requiresReauth: true` (new)
- ✅ HTTP 400 + other errors → NO `requiresReauth` (existing)
- ✅ HTTP 5xx → NO `requiresReauth` (existing)
- ✅ All cases have test coverage
- ✅ Desktop app will immediately stop retrying on permanent failures

**Files to modify:**
- `ai-server/src/controllers/auth-controller.js` (lines 540-562)
- `ai-server/tests/controllers/auth-controller.test.js` (add 3 new tests)
- `python-desktop-app/TOKEN_REFRESH_IMPLEMENTATION.md` (add error code section)

---

### PROMPT 1.3: Add Environment Variable Validation (ai-server)

**Context:** Token refresh failures can be caused by environment configuration mismatches (client_id/secret changed but not updated in production). We need to validate these on startup.

**Task:** Add startup validation for `ATLASSIAN_CLIENT_ID` and `ATLASSIAN_CLIENT_SECRET` in the ai-server.

**Requirements:**

1. **Find the startup sequence:**
   - File: `ai-server/src/index.js`
   - Look for where the express app is initialized
   - Look for where environment variables are loaded (dotenv)

2. **Add validation after environment loading:**
   ```javascript
   // Validate critical environment variables
   const requiredEnvVars = [
     'ATLASSIAN_CLIENT_ID',
     'ATLASSIAN_CLIENT_SECRET',
     'SUPABASE_URL',
     'SUPABASE_SERVICE_ROLE_KEY',
     'JWT_SECRET',
     'AI_SERVER_API_KEY',
   ];

   const missing = requiredEnvVars.filter(name => !process.env[name]);
   if (missing.length > 0) {
     logger.error('[Startup] Missing required environment variables:', missing);
     logger.error('[Startup] Please check your .env file and ensure all variables are set.');
     process.exit(1);
   }

   logger.info('[Startup] Environment validation passed');
   logger.info('[Startup] Atlassian OAuth configured', {
     client_id_prefix: process.env.ATLASSIAN_CLIENT_ID.substring(0, 8) + '...',
     // NEVER log client_secret, even partially
   });
   ```

3. **Add a startup health check log:**
   - After the server starts listening, log:
   ```javascript
   logger.info('[Startup] AI Server ready', {
     port: PORT,
     node_env: process.env.NODE_ENV || 'development',
     atlassian_oauth: 'configured',
     supabase: 'connected',
   });
   ```

4. **Handle the edge case where environment variables are empty strings:**
   ```javascript
   const missing = requiredEnvVars.filter(name => {
     const value = process.env[name];
     return !value || value.trim() === '';
   });
   ```

5. **Write a test:**
   - File: `ai-server/tests/index.test.js`
   - Test name: `'should exit if ATLASSIAN_CLIENT_ID is missing'`
   - Mock `process.exit` and `logger.error`
   - Delete `process.env.ATLASSIAN_CLIENT_ID`
   - Require the index.js (or call the validation function)
   - Assert that `process.exit(1)` was called
   - Assert that logger.error logged the missing variable

**Acceptance criteria:**
- ✅ Server exits immediately if any required env var is missing or empty
- ✅ Clear error message lists which variables are missing
- ✅ Startup success log includes client_id prefix (for debugging)
- ✅ Client secret is NEVER logged (even partially)
- ✅ Test coverage for missing env vars

**Files to modify:**
- `ai-server/src/index.js` (add validation near the top, after dotenv.config())
- `ai-server/tests/index.test.js` (add new test)

---

## Phase 2: Token Rotation Race Fix

### PROMPT 2.1: Improve Single-Instance Lock (desktop app)

**Context:** The single-instance lock on Windows uses `win32event.GetLastError()`, which may not work correctly. This can allow multiple instances to run, each burning the same refresh token.

**Task:** Fix the single-instance lock to reliably detect existing instances.

**Requirements:**

1. **Read the current implementation:**
   - File: `python-desktop-app/desktop_app.py`
   - Function: `acquire_single_instance_lock()` (lines 232-267)
   - Understand the mutex approach and the lock file fallback

2. **Replace the `GetLastError()` logic:**
   ```python
   def acquire_single_instance_lock():
       """
       Acquire a system-wide mutex to ensure only one instance runs.
       Returns True if lock acquired (this is the only instance).
       Returns False if another instance is already running.
       """
       global _instance_mutex

       if not WIN32_AVAILABLE:
           # On non-Windows, use a lock file approach
           return _acquire_lock_file()

       try:
           import ctypes
           from ctypes import winerror

           # Create a named mutex - if it already exists, another instance is running
           mutex_name = "TimeTracker_SingleInstance_Mutex"
           _instance_mutex = win32event.CreateMutex(None, True, mutex_name)

           # Use ctypes to reliably get the last error
           last_error = ctypes.windll.kernel32.GetLastError()

           if last_error == winerror.ERROR_ALREADY_EXISTS:
               print(f"[WARN] Another instance of Time Tracker is already running! (ERROR_ALREADY_EXISTS)")
               print(f"[WARN] Mutex name: {mutex_name}, Last error: {last_error}")
               # Close the handle since we won't be using it
               win32event.CloseHandle(_instance_mutex)
               _instance_mutex = None
               return False

           print(f"[OK] Single instance lock acquired (mutex: {mutex_name})")
           return True

       except Exception as e:
           print(f"[WARN] Could not create single instance lock via mutex: {e}")
           # Fall back to lock file approach
           print("[INFO] Falling back to lock file approach")
           return _acquire_lock_file()
   ```

3. **Improve the lock file fallback:**
   ```python
   def _acquire_lock_file():
       """Fallback lock file approach for non-Windows or when mutex fails"""
       lock_file = os.path.join(get_app_data_dir(), '.lock')

       try:
           # Check if lock file exists and if the process is still running
           if os.path.exists(lock_file):
               try:
                   with open(lock_file, 'r') as f:
                       pid = int(f.read().strip())

                   # Check if process is still running
                   if psutil.pid_exists(pid):
                       try:
                           proc = psutil.Process(pid)
                           proc_name = proc.name().lower()
                           # Check if it's our app (not just any Python process)
                           if 'timetracker' in proc_name or 'desktop_app' in proc_name or 'python' in proc_name:
                               print(f"[WARN] Another instance is running (PID: {pid}, name: {proc_name})")
                               return False
                       except (psutil.NoSuchProcess, psutil.AccessDenied):
                           # Process exists but we can't access it - assume it's stale
                           print(f"[INFO] Lock file exists but process {pid} is not accessible - assuming stale")
                           pass
                   else:
                       print(f"[INFO] Lock file exists but PID {pid} is not running - removing stale lock")
               except (ValueError, IOError) as e:
                   print(f"[WARN] Could not read lock file: {e} - removing it")

               # If we got here, the lock is stale - remove it
               try:
                   os.remove(lock_file)
               except:
                   pass

           # Write our PID to lock file
           with open(lock_file, 'w') as f:
               f.write(str(os.getpid()))

           print(f"[OK] Lock file acquired (PID: {os.getpid()})")
           return True

       except Exception as e:
           print(f"[WARN] Lock file error: {e}")
           # If we can't create/check the lock file, allow running
           # (better to have duplicate instance than block startup entirely)
           return True
   ```

4. **Update the main entry point:**
   - Ensure `acquire_single_instance_lock()` is called BEFORE any OAuth or API calls
   - If it returns `False`, show a message box and exit:
     ```python
     if not acquire_single_instance_lock():
         # On Windows, show a message box
         if WIN32_AVAILABLE:
             import ctypes
             ctypes.windll.user32.MessageBoxW(
                 0,
                 "Another instance of Time Tracker is already running.\n\nPlease close it before starting a new one.",
                 "Time Tracker - Instance Already Running",
                 0x10  # MB_ICONERROR
             )
         sys.exit(0)
     ```

5. **Write tests:**
   - File: `python-desktop-app/tests/test_single_instance.py` (create new)
   - Test cases:
     - `test_mutex_acquired_on_first_instance()` — First call returns True
     - `test_mutex_blocked_on_second_instance()` — Second call returns False (mock CreateMutex to return ERROR_ALREADY_EXISTS)
     - `test_lock_file_fallback_when_mutex_fails()` — If CreateMutex raises exception, uses lock file
     - `test_stale_lock_file_removed()` — If PID doesn't exist, lock file is removed and new lock acquired

**Acceptance criteria:**
- ✅ `acquire_single_instance_lock()` reliably detects existing instances using `ctypes.windll.kernel32.GetLastError()`
- ✅ If mutex approach fails, falls back to PID-based lock file
- ✅ Stale lock files (PID no longer running) are automatically removed
- ✅ Clear log messages indicate which lock method was used and the result
- ✅ If another instance is detected, the app exits with a user-friendly message
- ✅ Test coverage for mutex, lock file, and stale lock scenarios

**Files to modify:**
- `python-desktop-app/desktop_app.py` (lines 232-267 + main entry point)
- `python-desktop-app/tests/test_single_instance.py` (create new)

---

### PROMPT 2.2: Token Reload After Rotation (desktop app)

**Context:** When thread A successfully refreshes the token, thread B (waiting for the lock) may still have the old token in its local variable. We need to reload from secure storage.

**Task:** Update the `refresh_access_token()` method to reload tokens from storage when another thread has already refreshed.

**Requirements:**

1. **Read the current implementation:**
   - File: `python-desktop-app/desktop_app.py`
   - Function: `refresh_access_token()` (lines 2106-2230)
   - Understand the double-check pattern inside the lock (lines 2121-2127)

2. **Enhance the double-check pattern:**
   ```python
   with self._refresh_lock:
       # Re-check invalid flag inside the lock — another thread may have set it
       # while we were waiting to acquire the lock.
       if getattr(self, '_refresh_token_invalid', False):
           grace_period = 1800
           invalid_since = getattr(self, '_refresh_invalid_set_at', 0)
           if not (invalid_since and (time.time() - invalid_since) >= grace_period):
               print("[INFO] Another thread marked token invalid while waiting for lock")
               return False
           # Grace period expired — clear and proceed
           self._refresh_token_invalid = False
           self._refresh_fail_count = 0
           self._refresh_invalid_set_at = 0

       # Double-check: if the refresh_token in self.tokens changed while we were
       # waiting for the lock, another thread already refreshed successfully.
       refresh_token_now = self.tokens.get('refresh_token')
       if refresh_token_now and refresh_token_now != refresh_token_before:
           # Reload ALL tokens from secure storage to ensure we have the latest
           # access_token, expires_at, etc. (not just the refresh_token).
           try:
               print("[INFO] Token already refreshed by another thread, reloading from storage")
               self.tokens = self._load_tokens()
               return True
           except Exception as e:
               print(f"[ERROR] Failed to reload tokens from storage: {e}")
               # Continue with the refresh attempt rather than failing
               pass

       # If we got here, no other thread refreshed — proceed with our own refresh
       refresh_token = refresh_token_now or refresh_token_before
       if not refresh_token:
           print("[ERROR] No refresh token available")
           return False

       # ... rest of the refresh logic ...
   ```

3. **Add logging for debugging:**
   - When reloading tokens, log the first 8 chars of the old and new refresh tokens:
     ```python
     old_prefix = refresh_token_before[:8] if refresh_token_before else 'none'
     new_prefix = refresh_token_now[:8] if refresh_token_now else 'none'
     print(f"[INFO] Token changed while waiting for lock: {old_prefix}... → {new_prefix}...")
     ```

4. **Write a test:**
   - File: `python-desktop-app/test_session_management.py` (add to existing)
   - Test name: `test_token_reload_after_concurrent_refresh`
   - Setup:
     - Mock `_load_tokens()` to return updated tokens
     - Thread A acquires lock, refreshes token (changes `refresh_token` in `self.tokens`)
     - Thread B waits for lock
   - Expected:
     - Thread B acquires lock, sees changed token, calls `_load_tokens()`, returns True
     - Thread B does NOT make a network call to ai-server

**Acceptance criteria:**
- ✅ When thread B acquires the lock and sees `refresh_token` changed, it reloads from storage
- ✅ `_load_tokens()` is called to get the latest `access_token`, `expires_at`, etc.
- ✅ Thread B returns `True` without making a network call
- ✅ Log messages indicate when token was reloaded vs when a new refresh was performed
- ✅ Test coverage for concurrent refresh scenario

**Files to modify:**
- `python-desktop-app/desktop_app.py` (lines 2121-2135)
- `python-desktop-app/test_session_management.py` (add new test)

---

### PROMPT 2.3: Add Refresh Correlation ID (desktop app)

**Context:** To trace token refresh flows across the desktop app and ai-server, we need correlation IDs.

**Task:** Generate a correlation ID in the desktop app and pass it to the ai-server via a custom header.

**Requirements:**

1. **Generate UUID in `refresh_access_token()`:**
   ```python
   import uuid

   def refresh_access_token(self):
       """Refresh access token using refresh token via AI Server."""
       correlation_id = str(uuid.uuid4())
       
       # Fast-path: if the refresh token was marked invalid...
       # [existing code]
       
       print(f"[INFO] Refreshing access token via AI Server (correlation: {correlation_id})")
       
       # ... [existing lock acquisition and double-check] ...

       try:
           response = requests.post(
               f"{self.ai_server_url}/api/auth/refresh-token",
               json={'refresh_token': refresh_token},
               headers={
                   'Content-Type': 'application/json',
                   'X-Refresh-Correlation-ID': correlation_id,  # NEW
               },
               timeout=(10, 60)
           )
           
           # ... [existing response handling] ...
           
       except Exception as e:
           print(f"[ERROR] Failed to refresh access token (correlation: {correlation_id}): {e}")
           return False
   ```

2. **Log the correlation ID in success and error paths:**
   ```python
   if response.status_code != 200:
       error_data = response.json() if ... else {}
       error = error_data.get('error', response.text)
       print(f"[ERROR] Token refresh failed (correlation: {correlation_id}): {error}")
       # ... [existing error handling] ...
   
   # On success:
   print(f"[OK] Access token refreshed successfully via AI Server (correlation: {correlation_id})")
   ```

3. **Update the ai-server to read the header:**
   - File: `ai-server/src/controllers/auth-controller.js`
   - In `refreshToken()`, read the header:
     ```javascript
     const clientCorrelationId = req.headers['x-refresh-correlation-id'];
     const correlationId = crypto.randomUUID(); // Server's own ID

     logger.info('[Auth] Refreshing Atlassian access token', {
       correlationId,
       clientCorrelationId,
       // ... [existing context] ...
     });
     ```

4. **Write a test:**
   - File: `python-desktop-app/test_session_management.py`
   - Test name: `test_refresh_sends_correlation_id`
   - Mock `requests.post`
   - Call `refresh_access_token()`
   - Assert that `requests.post` was called with header `X-Refresh-Correlation-ID`
   - Assert that the value is a valid UUID

**Acceptance criteria:**
- ✅ Desktop app generates a UUID for each refresh attempt
- ✅ UUID is passed to ai-server in `X-Refresh-Correlation-ID` header
- ✅ Desktop app logs the correlation ID in all refresh-related messages
- ✅ ai-server logs both its own correlation ID and the client's correlation ID
- ✅ Test coverage for header generation and transmission

**Files to modify:**
- `python-desktop-app/desktop_app.py` (lines 2106-2230)
- `ai-server/src/controllers/auth-controller.js` (lines 499-510)
- `python-desktop-app/test_session_management.py` (add new test)

---

## Phase 3: Defensive Enhancements (Optional)

### PROMPT 3.1: Rate Limit Token Refresh (desktop app)

**Context:** If there's a bug that causes rapid refresh attempts, we should rate-limit to prevent cascading failures.

**Task:** Add a 10-second rate limit to `refresh_access_token()`.

**Requirements:**

1. **Add instance variables to track last attempt:**
   ```python
   # In __init__:
   self._last_refresh_attempt_time = 0  # Timestamp of last refresh attempt
   self._min_refresh_interval = 10  # Minimum seconds between refresh attempts
   ```

2. **Check at the start of `refresh_access_token()`:**
   ```python
   def refresh_access_token(self):
       """Refresh access token using refresh token via AI Server."""
       correlation_id = str(uuid.uuid4())
       
       # Rate limit: prevent rapid successive refresh attempts (likely a bug)
       time_since_last = time.time() - self._last_refresh_attempt_time
       if time_since_last < self._min_refresh_interval:
           print(f"[WARN] Refresh attempted {time_since_last:.1f}s after last attempt (correlation: {correlation_id})")
           print(f"[WARN] Rate limit: waiting {self._min_refresh_interval}s between refreshes — skipping")
           return False
       
       self._last_refresh_attempt_time = time.time()
       
       # ... [existing code] ...
   ```

3. **Reset the timer on successful refresh:**
   ```python
   # After successful token update:
   self.tokens.update({ ... })
   self._save_tokens()
   
   # Reset counters
   self._refresh_token_invalid = False
   self._refresh_fail_count = 0
   self._refresh_invalid_set_at = 0
   self._last_refresh_fail_time = 0
   self._last_refresh_attempt_time = time.time()  # Update to current time
   
   print("[OK] Access token refreshed successfully via AI Server")
   return True
   ```

4. **Make the interval configurable (optional):**
   ```python
   # In __init__, read from environment or config:
   self._min_refresh_interval = int(os.getenv('REFRESH_RATE_LIMIT_SECONDS', '10'))
   ```

5. **Write a test:**
   - File: `python-desktop-app/test_session_management.py`
   - Test name: `test_refresh_rate_limited`
   - Call `refresh_access_token()` twice within 5 seconds
   - Assert that the second call returns `False` and logs the rate limit warning

**Acceptance criteria:**
- ✅ If two refresh attempts occur within 10 seconds, the second is blocked
- ✅ Clear warning message logged when rate limit is triggered
- ✅ Timer is reset after successful refresh
- ✅ Rate limit interval is configurable via environment variable
- ✅ Test coverage for rate limiting

**Files to modify:**
- `python-desktop-app/desktop_app.py` (lines 1800-1820 for init, 2106-2230 for refresh)
- `python-desktop-app/test_session_management.py` (add new test)

---

## Testing Sequence

After implementing each prompt, run the following tests **in order**:

### 1. Unit Tests (after each prompt)

```bash
# ai-server
cd ai-server && npm test

# desktop-app
cd python-desktop-app && python -m pytest tests/ -v
```

### 2. Integration Test (after Phase 1 complete)

**Scenario:** Token refresh with invalid token

1. Mock ai-server to return `400 + unauthorized_client`
2. Desktop app calls `refresh_access_token()`
3. Verify:
   - ai-server logs include `correlationId`, `client_id_prefix`, `refresh_token_prefix`
   - Desktop app receives `requiresReauth: true`
   - Desktop app stops retrying after 5 failures (or immediately if error logic is enhanced)

### 3. End-to-End Test (after Phase 2 complete)

**Scenario:** Multiple instances prevented

1. Start desktop app instance #1
2. Attempt to start instance #2
3. Verify:
   - Instance #2 logs: `[WARN] Another instance of Time Tracker is already running!`
   - Instance #2 shows message box and exits
   - Instance #1 continues running

### 4. Stress Test (after Phase 3 complete)

**Scenario:** Concurrent refresh attempts

1. Desktop app with access token expired
2. Trigger 5 operations simultaneously (batch upload, fetch issues, get user info, etc.)
3. Verify:
   - Only ONE refresh call to ai-server (lock prevents duplicates)
   - Other operations wait and reuse the new token
   - Logs show: `[INFO] Token already refreshed by another thread, reloaded from storage`

---

## Rollback Plan

If any phase causes regressions:

### Phase 1 (Logging + Error Classification)

- **Risk:** Low (only logging and error response changes)
- **Rollback:** Revert the merge commit
- **Detection:** No functional changes — only improved diagnostics

### Phase 2 (Single-Instance Lock + Token Reload)

- **Risk:** Medium (changes startup behavior and concurrency logic)
- **Rollback:** Revert the merge commit
- **Detection:** Users report "can't start app" or "token refresh still failing"
- **Mitigation:** Deploy to 10% of users first (canary deployment)

### Phase 3 (Rate Limiting)

- **Risk:** Low (only adds a safety check)
- **Rollback:** Revert the merge commit
- **Detection:** Users report "can't refresh token" (rate limit too aggressive)
- **Mitigation:** Make interval configurable via env var (already in prompt)

---

## Post-Deployment Monitoring

### Metrics to Track (first 48 hours)

1. **Token refresh error rate:**
   - Count of `[Auth] Token refresh error` logs per hour
   - Should decrease significantly after Phase 1 deployment

2. **Correlation ID coverage:**
   - Percentage of refresh logs that include `correlationId`
   - Should be 100% after Phase 1 deployment

3. **requiresReauth flag usage:**
   - Count of responses with `requiresReauth: true` per hour
   - Should INCREASE initially (correct classification) then decrease (users re-auth)

4. **Multiple instance detections:**
   - Count of `[WARN] Another instance is already running` logs
   - Indicates how many users were affected by the multi-instance bug

5. **Token reload events:**
   - Count of `[INFO] Token already refreshed by another thread, reloaded from storage` logs
   - Indicates concurrent refresh attempts that were correctly handled

### Alert Conditions

- ❗ **Critical:** Error rate > 10 per minute → Rollback immediately
- ⚠️ **Warning:** Error rate increases by > 50% after deployment → Investigate
- ℹ️ **Info:** `requiresReauth: true` spike in first hour → Expected (correct classification)

---

## Summary

This document provides **copy-paste prompts** for implementing each fix. Each prompt:

- ✅ Includes full context and requirements
- ✅ Specifies exactly which files and lines to modify
- ✅ Includes code snippets with inline comments
- ✅ Specifies test cases to write
- ✅ Lists acceptance criteria
- ✅ Can be executed independently (with dependencies noted)

**Usage:**
1. Pick a prompt (e.g., PROMPT 1.1)
2. Copy the entire prompt to your AI assistant or developer
3. Follow the requirements step-by-step
4. Run the tests before moving to the next prompt

