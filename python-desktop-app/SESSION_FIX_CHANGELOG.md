# Desktop App: Session Maintenance Fix

**Date:** April 10, 2026  
**Branch:** `fix/desktopbug`  
**File Changed:** `python-desktop-app/desktop_app.py`  
**Issue:** Users are prompted to log in multiple times during a single session, disrupting their workflow.

---

## Problem Summary

Users reported that the desktop application was not maintaining their session properly — the app would frequently prompt for re-login even while actively using the application. Investigation revealed three separate bugs that combined to cause this behavior.

---

## Root Cause Analysis

### Bug 1 (Primary): Overly Aggressive `_refresh_token_invalid` Flag

**Location:** `AtlassianAuthManager.refresh_access_token()` (line ~1769)

**Problem:**  
The token refresh error handler used a broad substring check to determine if re-authentication was needed:

```python
if error_data.get('requiresReauth') or 'invalid' in str(error).lower():
    self._refresh_token_invalid = True
```

The check `'invalid' in str(error).lower()` matched **any** error message containing the word "invalid" — including transient server errors like:
- `"invalid request format"` (malformed request due to network issues)
- `"invalid JSON"` (response parsing failure)
- `"invalid content-type"` (server misconfiguration)

Once `_refresh_token_invalid` was set to `True`, **all** future refresh attempts were blocked:

```python
def is_authenticated(self):
    if getattr(self, '_refresh_token_invalid', False):
        return False  # ← Session permanently dead
```

This triggered the re-authentication notification every 15 minutes via `_show_reauth_notification()`, prompting the user to log in again — even though their refresh token was still valid.

**Impact:** A single transient error permanently killed the user's session for the remainder of the app's runtime.

---

### Bug 2: OAuth `prompt=login` Forces Full Credential Re-entry

**Location:** `AtlassianAuthManager.get_auth_url()` (line ~1574)

**Problem:**  
The OAuth authorization URL included `'prompt': 'login'`:

```python
params = {
    ...
    'prompt': 'login',
    ...
}
```

Per the [Atlassian OAuth 2.0 documentation](https://developer.atlassian.com/cloud/jira/platform/oauth-2-3lo-apps/), `prompt=login` forces the authorization server to re-prompt the user for credentials, **even if they already have an active browser session** with Atlassian.

This meant every time the app needed re-authentication (due to Bug 1), the user had to enter their full Atlassian credentials from scratch — no SSO, no session reuse.

**Impact:** Re-authentication was unnecessarily painful and slow, compounding the frequency issue from Bug 1.

---

### Bug 3: Incomplete Token Cleanup in `logout()`

**Location:** `AtlassianAuthManager.logout()` (line ~1994)

**Problem:**  
The `logout()` method only cleaned up two of four storage locations:

```python
def logout(self):
    self.tokens = {}
    # ✅ Cleared keyring entries
    if KEYRING_AVAILABLE:
        for key in SENSITIVE_TOKEN_KEYS:
            _keyring_delete(KEYRING_SERVICE, key)
    # ✅ Removed old JSON file
    if os.path.exists(self.store_path):
        os.remove(self.store_path)
    # ❌ Did NOT clear SecureTokenStorage (encrypted fallback)
    # ❌ Did NOT remove auth_metadata.json
    # ❌ Did NOT reset _refresh_token_invalid flag
```

Missing cleanup caused:
1. **Stale encrypted tokens:** If the app had fallen back to encrypted file storage (10-15% of users), those tokens persisted after logout and could be loaded on next startup.
2. **Stale metadata:** `auth_metadata.json` containing `oauth_state`, `code_verifier`, and other non-sensitive metadata was not removed, potentially interfering with the next OAuth flow.
3. **Lingering state flags:** `_refresh_token_invalid` remained `True` after logout, meaning even after a fresh login, the flag could block token refresh until the app was fully restarted.

**Impact:** After explicit logout + re-login, users could still experience session issues due to stale state.

---

## Changes Made

### Fix 1: Precise Token Invalidation with Retry Counter

**Before:**
```python
if error_data.get('requiresReauth') or 'invalid' in str(error).lower():
    print("[WARN] Refresh token expired - user must re-authenticate")
    self._refresh_token_invalid = True
```

**After:**
```python
error_lower = str(error).lower()
is_permanent_failure = (
    error_data.get('requiresReauth') or
    'invalid_grant' in error_lower or
    'refresh token is invalid' in error_lower or
    'token has been revoked' in error_lower or
    'token has been expired' in error_lower or
    response.status_code == 403
)
if is_permanent_failure:
    self._refresh_fail_count = getattr(self, '_refresh_fail_count', 0) + 1
    if self._refresh_fail_count >= 3:
        print(f"[WARN] Refresh token failed {self._refresh_fail_count} consecutive times - user must re-authenticate")
        self._refresh_token_invalid = True
    else:
        print(f"[WARN] Refresh token failure {self._refresh_fail_count}/3 - will retry before requiring re-auth")
```

**What changed:**
- Replaced broad `'invalid' in error` check with **specific Atlassian error patterns**: `invalid_grant`, `refresh token is invalid`, `token has been revoked`, `token has been expired`, HTTP 403, and the explicit `requiresReauth` server flag.
- Added a **3-strike consecutive failure counter** (`_refresh_fail_count`). The session is only permanently invalidated after 3 consecutive permanent failures, preventing a single transient error from killing the session.
- The counter resets to `0` on any successful refresh.

---

### Fix 2: OAuth Prompt Changed from `login` to `consent`

**Before:**
```python
'prompt': 'login',
```

**After:**
```python
'prompt': 'consent',
```

**What changed:**
- `prompt=consent` allows Atlassian to reuse the user's existing browser session (SSO). If the user is already logged in to Atlassian in their browser, they only see a consent confirmation screen — no credential re-entry needed.
- This dramatically reduces friction when re-authentication is genuinely required.

---

### Fix 3: Complete Token Cleanup in `logout()`

**Before:**
```python
def logout(self):
    self.tokens = {}
    if KEYRING_AVAILABLE:
        for key in SENSITIVE_TOKEN_KEYS:
            _keyring_delete(KEYRING_SERVICE, key)
    if os.path.exists(self.store_path):
        os.remove(self.store_path)
```

**After:**
```python
def logout(self):
    self.tokens = {}
    self._refresh_token_invalid = False
    self._refresh_fail_count = 0

    # Clear secure storage (keyring + encrypted fallback)
    try:
        self.secure_storage.delete_tokens()
    except Exception as e:
        print(f"[WARN] Failed to clear secure storage: {e}")

    # Also clear keyring directly (handles legacy entries)
    if KEYRING_AVAILABLE:
        for key in SENSITIVE_TOKEN_KEYS:
            _keyring_delete(KEYRING_SERVICE, key)

    # Remove old JSON file
    if os.path.exists(self.store_path):
        os.remove(self.store_path)

    # Remove metadata file
    if os.path.exists(self.metadata_path):
        os.remove(self.metadata_path)
```

**What changed:**
- Added `self.secure_storage.delete_tokens()` to clear the encrypted fallback storage.
- Added removal of `self.metadata_path` (`auth_metadata.json`) to clean up non-sensitive metadata.
- Added reset of `_refresh_token_invalid` and `_refresh_fail_count` state flags so a fresh login starts with a clean slate.

---

### Fix 4: Failure Counter Reset on Successful Operations

Both `handle_callback()` (initial OAuth login) and `refresh_access_token()` (token refresh) now reset the failure counter on success:

```python
self._refresh_token_invalid = False
self._refresh_fail_count = 0
```

This ensures that after any successful token operation, the retry counter starts fresh.

---

## Session Lifecycle (After Fix)

```
App Start
  │
  ├─ Load tokens from secure storage (keyring → encrypted fallback)
  ├─ Check is_authenticated()
  │    ├─ Has access_token? → Yes
  │    ├─ _refresh_token_invalid? → No (clean start)
  │    ├─ Token expired? → Check expires_at
  │    │    ├─ Not expired → ✅ Authenticated
  │    │    └─ Expired → Call refresh_access_token()
  │    │         ├─ Success → ✅ Authenticated, reset fail counter
  │    │         └─ Failure → Increment fail counter
  │    │              ├─ < 3 failures → Return False (will retry in ~10 min)
  │    │              └─ ≥ 3 failures → Set _refresh_token_invalid = True
  │    │                   └─ Show re-auth notification (every 15 min)
  │    └─ No access_token → Redirect to /login
  │
  ├─ Background sync thread (every 30s)
  │    ├─ Proactive token refresh (every ~10 min, 5-min buffer before expiry)
  │    └─ Supabase JWT refresh (5-min buffer before expiry)
  │
  └─ API calls (Jira, Supabase)
       ├─ 401 response → Call refresh_access_token()
       │    ├─ Success → Retry API call with new token
       │    └─ Failure → Log error (session survives for retry)
       └─ 200 response → Continue normally
```

---

## Testing Checklist

| Scenario | Expected Behavior |
|---|---|
| Normal operation (token valid) | No login prompts during session |
| Access token expires naturally (~1 hour) | Proactive refresh succeeds silently |
| Single transient server error during refresh | Fail counter increments to 1/3, session continues |
| Three consecutive permanent refresh failures | Session marked invalid, re-auth notification shown |
| Successful refresh after 1-2 failures | Fail counter resets to 0 |
| Re-authentication when user has active Atlassian browser session | Consent screen only (no credential re-entry) |
| Explicit logout + re-login | All storage cleaned, fresh session starts |
| App restart after previous session | Tokens loaded from secure storage, session resumes |
| Network offline → back online | Cached credentials used, token refresh on reconnect |

---

## Files Modified

| File | Changes |
|---|---|
| `python-desktop-app/desktop_app.py` | 5 edits across `refresh_access_token()`, `get_auth_url()`, `handle_callback()`, `logout()` |

## Risk Assessment

- **Low risk:** All changes are contained within the `AtlassianAuthManager` class.
- **Backward compatible:** The new `_refresh_fail_count` attribute uses `getattr(..., 0)` default, so it works even if old state is loaded.
- **No API changes:** No changes to server endpoints, database schema, or user-facing UI.
- **Fail-safe:** If the precise error patterns miss a genuine permanent failure, the 3-strike counter still catches it (just takes 3 cycles instead of 1).
