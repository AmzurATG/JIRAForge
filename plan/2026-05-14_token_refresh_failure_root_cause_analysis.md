# Token Refresh Failure Root Cause Analysis

**Date:** 2026-05-14  
**Component:** ai-server + python-desktop-app  
**Symptom:** Multiple `unauthorized_client` / `refresh_token is invalid` errors with intermittent success

---

## Executive Summary

The system is experiencing repeated token refresh failures with Atlassian OAuth, showing the error:
```
unauthorized_client: refresh_token is invalid
```

The pattern shows:
- Rapid successive refresh attempts (multiple per minute)
- Intermittent successes followed by immediate failures
- Errors occurring on both 13:48–13:49 and 13:53–13:55 UTC

**Primary root causes identified:**
1. **Token rotation race condition** — Multiple concurrent requests burning the same refresh token
2. **Insufficient error classification** — "unauthorized_client" errors (HTTP 400) not properly flagged as permanent failures
3. **Potential multiple instance issue** — Single-instance lock may be failing silently
4. **Environment configuration mismatch** — Client credentials may not match the refresh tokens in use
5. **Inadequate diagnostic logging** — Cannot determine which user, which request, or actual HTTP status from logs

---

## Error Log Analysis

### Timeline Pattern (UTC timestamps)

```
13:48:11  [Start of error cascade]
13:48:34  ❌ Token refresh error (unauthorized_client)
13:48:37  ❌ Token refresh error (unauthorized_client)
13:48:41  ❌ Token refresh error (unauthorized_client)
13:48:42  ❌ Token refresh error (unauthorized_client)
13:49:08  ✅ Successfully refreshed access token
13:49:12  ❌ Token refresh error (unauthorized_client)
13:49:15  ❌ Token refresh error (unauthorized_client)

[7-minute gap]

13:53:39  [Second cascade begins]
13:53:42  ❌ Token refresh error (unauthorized_client)
13:53:47  ❌ Token refresh error (unauthorized_client)
13:54:13  ✅ Successfully refreshed access token
13:54:20  ❌ Token refresh error (unauthorized_client)
13:54:23  ❌ Token refresh error (unauthorized_client)
13:55:01  ℹ️  Update check (app version 1.4.0)
13:55:36  ⚠️  Invalid Atlassian token
```

### Key Observations

1. **Burst pattern**: Multiple refresh attempts within 3-7 seconds
2. **Success followed by failures**: `13:49:08` succeeds, then `13:49:12` and `13:49:15` fail
3. **Repetition**: Same pattern repeats at `13:54:13` → `13:54:20/23`
4. **Consistent error message**: Always `unauthorized_client` with `refresh_token is invalid`

---

## Root Cause Analysis

### Root Cause 1: Token Rotation Race Condition (HIGH PRIORITY)

**What is happening:**

Atlassian OAuth uses **rotating refresh tokens** — each successful refresh call returns a NEW refresh token and invalidates the old one. If two requests use the same (stale) refresh token:
- Request A succeeds → Token rotates to `v2`
- Request B (using old `v1`) fails → `unauthorized_client: refresh_token is invalid`

**Evidence from codebase:**

**Desktop app** (`python-desktop-app/desktop_app.py:1804-1808`):
```python
# Prevents concurrent token refreshes from burning the same refresh_token twice.
# Atlassian uses token rotation: each refresh invalidates the old refresh_token.
# Without a lock, two threads racing on an expired token will both send the same
# refresh_token — the second call arrives after rotation and gets "token invalid".
self._refresh_lock = threading.Lock()
```

The desktop app DOES implement a lock for **within-process** concurrency. However, the error pattern suggests:

**Scenario A — Lock not being acquired correctly:**
- Multiple threads calling `refresh_access_token()` before the first one completes
- The lock should prevent this, but there may be call sites that bypass the lock

**Scenario B — Multiple desktop app instances running:**
- Each instance loads the refresh token from secure storage
- Instance A refreshes → Token rotates
- Instance B still has old token in memory → Fails with "invalid"
- The single-instance lock (`desktop_app.py:232-267`) may be failing

**Scenario C — Concurrent requests from different sources:**
- Desktop app batch upload (every 5 minutes)
- Manual user actions (issue fetch, user info check)
- Auto-update check (version 1.4.0 logged at 13:55:01)
- Each could trigger a token refresh if the access token is expired

**Why the lock might fail:**

The single-instance lock code has a known issue:
```python
last_error = win32event.GetLastError() if hasattr(win32event, 'GetLastError') else 0
# Alternative way to check - try to get last error via ctypes
import ctypes
last_error = ctypes.windll.kernel32.GetLastError()
```

The `GetLastError()` call may return 0 even when `ERROR_ALREADY_EXISTS` should be set, allowing multiple instances to run.

---

### Root Cause 2: Insufficient Error Classification (MEDIUM PRIORITY)

**What is happening:**

Atlassian returns `unauthorized_client` as an **HTTP 400** error (not 401) when the refresh token is truly invalid. The ai-server currently only sets `requiresReauth: true` for HTTP 401:

**ai-server** (`auth-controller.js:543-558`):
```javascript
catch (error) {
  logger.error('[Auth] Token refresh error:', error.response?.data || error.message);

  // Only signal requiresReauth for true 401 (token revoked/expired).
  // HTTP 400 can be a transient malformed-request issue and should NOT
  // permanently kill the client session.
  if (error.response?.status === 401) {
    return res.status(401).json({
      success: false,
      error: 'Refresh token expired or invalid. User must re-authenticate.',
      requiresReauth: true
    });
  }

  // For 400 and other errors, return the status as-is without requiresReauth
  res.status(error.response?.status || 500).json({
    success: false,
    error: `Token refresh failed: ${formatAtlassianError(error)}`
  });
}
```

**The problem:**
- Atlassian's OAuth spec uses HTTP 400 for `invalid_grant` and `unauthorized_client`
- The desktop app checks for specific error strings to determine permanent failure:
  ```python
  is_permanent_failure = (
      error_data.get('requiresReauth') or
      'invalid_grant' in error_lower or
      'refresh token is invalid' in error_lower or
      'token has been revoked' in error_lower or
      'token has been expired' in error_lower or
      response.status_code == 403
  )
  ```
- The desktop app DOES check the error text, BUT it also relies on the server's `requiresReauth` flag for the most definitive signal
- Without that flag on 400 errors, the desktop app treats it as potentially transient

**Result:**
- The desktop app may retry stale tokens longer than necessary
- Failure counter increments until the 5-failure threshold is reached
- User session is killed after 5 failures instead of immediately on the first `unauthorized_client`

---

### Root Cause 3: Environment Configuration Mismatch (MEDIUM PRIORITY)

**What is happening:**

The error `unauthorized_client` can also mean:
- The `client_id` in the refresh request doesn't match the client that issued the refresh token
- The `client_secret` is incorrect

**Evidence:**

**ai-server** (`auth-controller.js:507-517`):
```javascript
logger.info('[Auth] Refreshing Atlassian access token');

const tokenResponse = await axios.post(
  ATLASSIAN_TOKEN_URL,
  {
    grant_type: 'refresh_token',
    client_id: clientId,          // ← From process.env.ATLASSIAN_CLIENT_ID
    client_secret: clientSecret,  // ← From process.env.ATLASSIAN_CLIENT_SECRET
    refresh_token: refresh_token
  },
  ...
);
```

**Possible scenarios:**
1. **Client credentials changed:** Admin rotated the Atlassian OAuth app credentials but forgot to update the `.env` file
2. **Multiple environments:** Refresh tokens were generated in DEV using `client_id=A`, but PROD has `client_id=B`
3. **Deployment issue:** Docker container or production server has stale environment variables

**Detection:**
- Check if `ATLASSIAN_CLIENT_ID` and `ATLASSIAN_CLIENT_SECRET` in production match the values in the Atlassian Developer Console for the OAuth app
- Verify all users re-authenticated after any client credential change

---

### Root Cause 4: Inadequate Diagnostic Logging (LOW PRIORITY — Blocks diagnosis)

**What is missing:**

Current log output:
```
[Auth] Token refresh error: {"error":"unauthorized_client","error_description":"refresh_token is invalid"}
```

**Does NOT include:**
- Which `user_id` or `org_id` is affected (multi-tenant app — need to know which org)
- The actual HTTP status code (400 vs 401)
- Whether this is a retry or initial attempt
- The `refresh_token` value (first 8 chars for debugging — NOT full token)
- The `client_id` being used (to detect environment mismatch)
- Correlation ID to trace related requests

**Impact:**
- Cannot determine if it's one user or many
- Cannot confirm if multiple instances are the issue
- Cannot verify environment configuration without SSH access
- Cannot trace which code path triggered the refresh

---

## Affected Code Paths

### 1. Desktop App — Token Refresh Entry Points

| File | Line | Function | Trigger |
|------|------|----------|---------|
| `desktop_app.py` | 2106 | `refresh_access_token()` | Explicit refresh via any 401 response |
| `desktop_app.py` | 2057 | `get_user_info()` | Fetches Atlassian user info, auto-refreshes on 401 |
| `desktop_app.py` | 8244 | `_upload_batch_to_supabase()` | Batch upload checks JWT expiry, may trigger Atlassian refresh |
| `desktop_app.py` | 2243 | `is_authenticated()` | Startup check, auto-refreshes if token expired |

### 2. AI Server — Token Refresh Endpoint

| File | Line | Function | Caller |
|------|------|----------|--------|
| `auth-controller.js` | 499 | `refreshToken()` | Desktop app → `POST /api/auth/refresh-token` |
| `auth-controller.js` | 541 | Error handler | Logs error and returns response |

---

## Acceptance Criteria for Fix

### AC1: Token Rotation Race Prevention

✅ **Within-process concurrency:** Desktop app's `_refresh_lock` must be used by ALL code paths that call `refresh_access_token()` (direct or indirect)

✅ **Multiple instance prevention:** Single-instance lock must reliably detect existing instances:
- Improve `GetLastError()` call to use `ctypes` consistently
- Add fallback to PID-based lock file if mutex fails
- Log clearly when another instance is detected

✅ **Token reload after rotation:** After a successful refresh by thread A, thread B must reload the token from secure storage before attempting its own refresh

### AC2: Correct Error Classification

✅ **Permanent failure detection:** ai-server must set `requiresReauth: true` for ALL of:
- HTTP 401 (current behavior)
- HTTP 400 with `error: "invalid_grant"`
- HTTP 400 with `error: "unauthorized_client"`

✅ **Transient failure handling:** HTTP 400 with other errors (e.g., `invalid_request` due to malformed JSON) should NOT set `requiresReauth`

### AC3: Diagnostic Logging Enhancement

✅ **Refresh attempts must log:**
- `user_id` or `atlassian_account_id`
- `org_id` if available
- First 8 chars of refresh token (e.g., `abc12345...`)
- `client_id` first 8 chars
- HTTP status code and full error body
- Correlation ID (generate UUID per refresh attempt)

✅ **Success logs must include:**
- Same correlation ID
- Whether a new refresh token was returned (token rotation confirmation)

### AC4: Environment Validation on Startup

✅ **ai-server startup must verify:**
- `ATLASSIAN_CLIENT_ID` is set and non-empty
- `ATLASSIAN_CLIENT_SECRET` is set and non-empty
- Log first 8 chars of each (for environment mismatch debugging)

✅ **Desktop app startup must verify:**
- Single-instance lock was acquired successfully
- Log the lock method used (mutex vs file) and PID

---

## Fix Implementation Plan

### Phase 1: Immediate Mitigation (1-2 hours)

**Goal:** Stop the error cascade and improve diagnostics

#### Task 1.1: Enhance Token Refresh Logging (ai-server)

**File:** `ai-server/src/controllers/auth-controller.js`

**Changes:**
1. Add correlation ID generation at the start of `refreshToken()`
2. Extract `user_id` from the existing token (decode JWT if possible)
3. Log client_id (first 8 chars), refresh_token (first 8 chars), correlation ID
4. Log HTTP status and full error body on failure
5. On success, log if a new refresh_token was returned

**Priority:** HIGH — Enables diagnosis of ongoing issues

---

#### Task 1.2: Improve Error Classification (ai-server)

**File:** `ai-server/src/controllers/auth-controller.js`

**Changes:**
1. Update error handler to check `error.response?.data?.error` field
2. Set `requiresReauth: true` for:
   - HTTP 401 (existing)
   - HTTP 400 with `error === 'invalid_grant'`
   - HTTP 400 with `error === 'unauthorized_client'`
3. Leave 400 + other errors as transient (existing behavior)

**Priority:** HIGH — Prevents desktop app from retrying invalid tokens

---

#### Task 1.3: Add Environment Variable Validation (ai-server)

**File:** `ai-server/src/index.js` (startup sequence)

**Changes:**
1. After loading `.env`, validate:
   ```javascript
   if (!process.env.ATLASSIAN_CLIENT_ID || !process.env.ATLASSIAN_CLIENT_SECRET) {
     logger.error('[Startup] ATLASSIAN_CLIENT_ID or CLIENT_SECRET not configured');
     process.exit(1);
   }
   logger.info('[Startup] Atlassian OAuth configured', {
     client_id_prefix: process.env.ATLASSIAN_CLIENT_ID.substring(0, 8),
     client_secret_prefix: '********' // Never log even partial secrets
   });
   ```

**Priority:** MEDIUM — Catches configuration errors early

---

### Phase 2: Token Rotation Race Fix (2-4 hours)

#### Task 2.1: Improve Single-Instance Lock (desktop app)

**File:** `python-desktop-app/desktop_app.py`

**Changes:**
1. Replace the `GetLastError()` logic:
   ```python
   import ctypes
   from ctypes import winerror

   _instance_mutex = win32event.CreateMutex(None, True, mutex_name)
   last_error = ctypes.windll.kernel32.GetLastError()

   if last_error == winerror.ERROR_ALREADY_EXISTS:
       print(f"[WARN] Another instance detected (mutex ERROR_ALREADY_EXISTS)")
       return False
   ```

2. Add explicit logging when lock is acquired vs another instance detected

3. If mutex approach fails, ensure the PID-based lock file fallback runs

**Priority:** HIGH — Prevents multiple instances burning tokens

---

#### Task 2.2: Token Reload After Rotation (desktop app)

**File:** `python-desktop-app/desktop_app.py`

**Changes:**
1. In `refresh_access_token()`, inside the lock, after the double-check pattern:
   ```python
   # Double-check: if the refresh_token in self.tokens changed while we were
   # waiting for the lock, another thread already refreshed successfully.
   refresh_token_now = self.tokens.get('refresh_token')
   if refresh_token_now and refresh_token_now != refresh_token_before:
       # Reload ALL tokens from secure storage to get the new access_token too
       self.tokens = self._load_tokens()
       print("[INFO] Token already refreshed by another thread, reloaded from storage")
       return True
   ```

**Priority:** MEDIUM — Ensures threads always use the latest token

---

#### Task 2.3: Add Refresh Correlation ID (desktop app)

**File:** `python-desktop-app/desktop_app.py`

**Changes:**
1. Generate a UUID at the start of `refresh_access_token()`
2. Log it in all refresh-related messages
3. Pass it to the ai-server in a custom header: `X-Refresh-Correlation-ID`
4. ai-server logs it alongside its own correlation ID

**Priority:** LOW — Improves traceability

---

### Phase 3: Defensive Enhancements (Optional, 1-2 hours)

#### Task 3.1: Rate Limit Token Refresh (desktop app)

**File:** `python-desktop-app/desktop_app.py`

**Changes:**
1. Track `_last_refresh_attempt_time` (timestamp)
2. At the start of `refresh_access_token()`, if `time.time() - _last_refresh_attempt_time < 10`:
   ```python
   print("[WARN] Refresh attempted within 10 seconds of last attempt — skipping to prevent cascade")
   return False
   ```

**Priority:** LOW — Prevents runaway refresh loops

---

#### Task 3.2: Server-Side Token Storage (Future — 1-2 days)

**Scope:** Store the latest refresh_token in Supabase keyed by `(user_id, device_id)`

**Benefits:**
- Prevents cross-device token rotation conflicts
- Enables centralized token revocation
- Allows audit trail of refresh events

**Complexity:** High — Requires schema change, RLS policies, device ID generation

**Priority:** BACKLOG — Only if multiple-device usage becomes common

---

## Testing Plan

### Test 1: Token Rotation Race (Single Instance)

**Setup:**
1. Desktop app running
2. Access token expired
3. Trigger two operations simultaneously:
   - Batch upload (5-minute timer fires)
   - Manual "Fetch Issues" button click

**Expected:**
- Only one refresh call to ai-server (lock prevents second)
- Both operations succeed using the new token
- Logs show: `[INFO] Token already refreshed by another thread, reloaded from storage`

---

### Test 2: Multiple Instance Prevention

**Setup:**
1. Start desktop app instance #1
2. Attempt to start instance #2 from the same executable

**Expected:**
- Instance #2 shows: `[WARN] Another instance of Time Tracker is already running!`
- Instance #2 exits immediately
- Instance #1 continues normally

---

### Test 3: Permanent Failure Detection (HTTP 400)

**Setup:**
1. Mock ai-server to return HTTP 400 with `{"error": "unauthorized_client"}`
2. Desktop app calls `refresh_access_token()`

**Expected:**
- Desktop app logs: `[WARN] Refresh token failed 1/5 - will retry before requiring re-auth`
- After 5th attempt: `[WARN] Refresh token invalid — re-authentication required`
- `_refresh_token_invalid` flag is set
- Subsequent calls return `False` immediately (no more API calls)

---

### Test 4: Transient Failure Retry (HTTP 500)

**Setup:**
1. Mock ai-server to return HTTP 500 (server error)
2. Desktop app calls `refresh_access_token()`

**Expected:**
- Desktop app logs: `[ERROR] Failed to refresh access token: <error>`
- `_refresh_token_invalid` is NOT set
- Next call retries (does not fail permanently)

---

### Test 5: Environment Mismatch Detection

**Setup:**
1. Change `ATLASSIAN_CLIENT_ID` in ai-server `.env` to a different value
2. Restart ai-server
3. Desktop app (with old refresh token) calls refresh

**Expected:**
- ai-server logs: `[Startup] Atlassian OAuth configured { client_id_prefix: 'XYZ12345' }`
- Refresh call fails with `unauthorized_client`
- ai-server logs: `[Auth] Token refresh error: unauthorized_client` with full context (client_id prefix, user_id)
- Admin can immediately see the client_id mismatch

---

## Rollout Strategy

### Step 1: Deploy Enhanced Logging (Zero Risk)

1. Merge and deploy Task 1.1 (logging) and Task 1.3 (env validation)
2. Monitor logs for 24-48 hours
3. Identify which users/orgs are affected
4. Determine if multiple instances or environment mismatch

### Step 2: Deploy Error Classification Fix (Low Risk)

1. Merge and deploy Task 1.2 (error classification)
2. Affected users will be prompted to re-authenticate immediately (instead of after 5 failures)
3. Monitor for reduction in error cascade volume

### Step 3: Deploy Single-Instance Lock Fix (Medium Risk)

1. Merge and deploy Task 2.1 (single-instance lock)
2. Test on staging/dev first with multiple launch attempts
3. Deploy to production
4. Verify logs show only one instance per user

### Step 4: Deploy Token Reload Fix (Low Risk)

1. Merge and deploy Task 2.2 (token reload)
2. Monitor logs for `[INFO] Token already refreshed by another thread, reloaded from storage`
3. Confirm concurrent requests no longer cause cascades

---

## Runbook: Immediate User Remediation

**If a user reports token refresh errors:**

1. **Check their environment:**
   - Ask: "Do you have multiple instances of the app running?" (Task Manager → Check for `timetracker.exe` or `python.exe` with `desktop_app.py`)
   - Verify the `.lock` file: `%LOCALAPPDATA%\TimeTracker\.lock` — Does the PID exist?

2. **Force re-authentication:**
   - Close all app instances
   - Delete token files:
     - Windows: `%LOCALAPPDATA%\TimeTracker\time_tracker_auth.json`
     - Windows: `%LOCALAPPDATA%\TimeTracker\auth_metadata.json`
     - Keyring: Delete `TimeTracker` entries (Windows Credential Manager)
   - Restart app → Will show OAuth login prompt

3. **Check ai-server logs:**
   - Search for user's email or `account_id`
   - Look for `client_id_prefix` in startup logs
   - Verify it matches the Atlassian Developer Console

4. **Check environment variables (production):**
   ```bash
   docker exec <container> printenv | grep ATLASSIAN
   ```
   - Verify `ATLASSIAN_CLIENT_ID` and `ATLASSIAN_CLIENT_SECRET` match the OAuth app

---

## Related Documentation

- [TOKEN_REFRESH_IMPLEMENTATION.md](../python-desktop-app/TOKEN_REFRESH_IMPLEMENTATION.md) — Original token refresh design
- [SESSION_MANAGEMENT_FIX_REPORT.md](../docs/SESSION_MANAGEMENT_FIX_REPORT.md) — Previous fix for grace period and failure counting
- [RISK_REMEDIATION.md](../docs/RISK_REMEDIATION.md) — Section 2.1: Refresh-token race analysis
- [DESKTOP_APP_COMPLIANCE.md](../docs/DESKTOP_APP_COMPLIANCE.md) — OAuth security audit

---

## Next Steps

1. Review this analysis with the team
2. Prioritize tasks based on urgency and risk
3. Create spec documents for each task (following [CLAUDE.md](../CLAUDE.md) workflow)
4. Write tests before implementation
5. Deploy in phases per rollout strategy

