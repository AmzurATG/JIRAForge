# Desktop App Version Update Reliability Fixes — Implementation Plan

**Date:** 2026-05-20  
**Component:** `python-desktop-app`  
**Severity:** 🔴 Critical  
**Related Analysis:** [docs/ROOT_CAUSE_ANALYSIS_desktop_app_version_not_updating_2026-05-20.md](../docs/ROOT_CAUSE_ANALYSIS_desktop_app_version_not_updating_2026-05-20.md)

---

## Problem Statement

Users running v1.4.1 of the desktop app experience silent database staleness where `desktop_app_version`, `desktop_logged_in`, and `desktop_last_heartbeat` fields are never updated in the `users` table. The app appears to function normally (tray shows "Up to Date", tracking works, admin panel loads from cache), but all database writes silently fail with **zero user-visible errors or notifications**.

**Observable symptoms:**
- DB shows old version (e.g., `1.3.7`) while system tray shows current version (e.g., `v1.4.1`)
- `desktop_last_heartbeat` frozen at timestamp from days/weeks ago
- `desktop_logged_in = false` even though app is running and tracking
- Affects ~5-15% of users (differential based on network timing at startup)

**Impact:**
- Admin cannot see accurate version adoption metrics
- Cannot detect which users need manual upgrade prompts
- Cannot identify users experiencing network/auth issues
- Support tickets require manual DB inspection to diagnose

---

## Root Causes Summary

| ID | Root Cause | Critical Path | Fix |
|----|-----------|---------------|-----|
| **RC-1** | `initialize_supabase()` is one-shot with no background recovery | `self.supabase = None` persists for entire session | FIX-1: Background retry in sync thread |
| **RC-2** | Supabase config not cached, requires live AI server at startup | Transient AI server unavailability blocks initialization | FIX-2: Disk cache with 24h TTL + stale fallback |
| **RC-3** | Early supabase init fires before connectivity check | Windows auto-start race condition, DNS not ready | FIX-2: Disk cache eliminates network dependency |
| **RC-4** | Both init attempts hit same endpoint (no independent fallback) | Single point of failure at startup | FIX-2: Cached fallback path |
| **RC-5** | Migration bug destroys `supabase_token_expires_at` | Proactive JWT refresh never fires, 1-hour expiry causes silent failure | FIX-3: Fix migration to preserve expiry field |
| **RC-6** | Full auth fallback path skips `_update_desktop_status` | Version not written even when supabase is initialized | FIX-4: Add version update in fallback path |
| **RC-7** | Heartbeat does not write `desktop_logged_in = True` | Flag remains false even when app is active | FIX-5: Include flag in heartbeat payload |
| **RC-8** | Heartbeat 0-row result (expired JWT) triggers 4-hour skip | No immediate recovery after JWT expiry | FIX-5: Force refresh + retry on 0-row result |

---

## Proposed Solution Architecture

### High-Level Strategy

1. **Eliminate hard network dependency at startup** via persistent disk cache (FIX-2)
2. **Add background recovery mechanism** to retry failed initialization every 30 minutes (FIX-1)
3. **Fix token expiry tracking** so proactive JWT refresh works correctly (FIX-3)
4. **Add version updates to all auth paths** including fallback paths (FIX-4)
5. **Make heartbeats self-healing** with immediate JWT refresh on 0-row results (FIX-5)

### Data Flow (After Fixes)

```
┌─────────────────────────────────────────────────────────────────┐
│ v1.4.1 STARTUP                                                   │
├─────────────────────────────────────────────────────────────────┤
│ Early Init (before connectivity check):                          │
│   has_stored_tokens? → Yes                                       │
│   initialize_supabase()                                          │
│     ├─ Check disk cache (auth_metadata.json)                    │
│     │  ├─ Cache fresh (<24h)? → Use cached config ✅            │
│     │  └─ Cache stale/missing? → Fetch from AI server           │
│     │     ├─ Success? → Cache + Use ✅                           │
│     │     └─ Fail? → Use stale cache as fallback ✅             │
│     └─ Build supabase client → self.supabase_initialized=True   │
│                                                                  │
│ If early init succeeded:                                         │
│   _update_desktop_status(logged_in=True) ← writes version ✅    │
└─────────────────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────┐
│ Full Auth Path:                                                  │
│   check_connectivity() → True                                    │
│   is_authenticated() → True                                      │
│   get_user_info() → Success                                      │
│   initialize_supabase() → Skips (already initialized) ✅         │
│   _update_desktop_status(logged_in=True) ← redundant write ✅   │
│                                                                  │
│ OR if get_user_info() fails 3 times:                            │
│   Fallback to cached credentials                                 │
│   if supabase_initialized:                                       │
│     _update_desktop_status(logged_in=True) ← NEW PATH ✅        │
└─────────────────────────────────────────────────────────────────┘
           │
           ▼
┌─────────────────────────────────────────────────────────────────┐
│ SYNC THREAD (every 30 seconds):                                  │
│                                                                  │
│ Background recovery (every 30 min = 60 iterations):              │
│   if not supabase_initialized and is_authenticated():            │
│     retry_initialize_supabase() ← NEW RECOVERY PATH ✅          │
│     if success:                                                  │
│       _update_desktop_status(logged_in=True)                    │
│                                                                  │
│ Proactive JWT refresh (every 15 min):                           │
│   sb_expires_at = tokens.get('supabase_token_expires_at', 0)    │
│   if sb_expires_at > 0 and time.time() > (sb_expires_at - 300): │
│     refresh_supabase_jwt() ← NOW WORKS (FIX-3) ✅               │
│                                                                  │
│ Heartbeat (every 4 hours):                                       │
│   UPDATE users SET desktop_app_version=..., desktop_logged_in=True │
│   if rows_updated == 0:                                          │
│     Force JWT refresh → retry UPDATE ← SELF-HEALING ✅          │
└─────────────────────────────────────────────────────────────────┘
```

---

## Acceptance Criteria

### AC-1: Supabase Config Persistent Cache

- [ ] `auth_metadata.json` includes `cached_supabase_url`, `cached_supabase_anon_key`, `supabase_cache_timestamp`
- [ ] On startup, if cache exists and `time.time() - supabase_cache_timestamp < 86400` (24h), use cached config without AI server call
- [ ] If cache stale, attempt AI server fetch; on failure, use stale cache as fallback with warning log
- [ ] On successful AI server fetch, update cache with new timestamp
- [ ] Cache survives app restarts and auto-updates (persisted in `%LOCALAPPDATA%\TimeTracker\auth_metadata.json`)

**Validation:** Start app with network disconnected → should initialize from cache if cache exists

---

### AC-2: Background Supabase Init Recovery

- [ ] Sync thread includes counter: `supabase_retry_counter` (increments every iteration)
- [ ] Every 60 iterations (~30 min), if `not self.supabase_initialized and self.is_authenticated()`, call `initialize_supabase()`
- [ ] On successful background retry, immediately call `_update_desktop_status(logged_in=True)` to push version
- [ ] Log `[RECOVERY] Supabase initialization succeeded after background retry` on success
- [ ] Counter resets after each attempt (success or failure)

**Validation:** 
1. Start app with AI server down → `self.supabase = None`
2. Bring AI server back up
3. Within 30 minutes, version should update in DB

---

### AC-3: Token Migration Preserves Expiry

- [ ] `_migrate_from_plaintext()` reads `time_tracker_auth.json` **before** calling `secure_storage.migrate_from_plaintext()`
- [ ] After migration, writes `supabase_token_expires_at` (and other non-sensitive fields) to `auth_metadata.json`
- [ ] Migration success logs: `[MIGRATION] Preserved token expiry: <timestamp>`
- [ ] If old file has no `supabase_token_expires_at`, use `0` (triggers immediate refresh on next check)
- [ ] Old plaintext file deleted only after successful write to both keyring + `auth_metadata.json`

**Validation:** 
1. Create test user with v1.3.x plaintext auth file including `supabase_token_expires_at`
2. Start v1.4.1 → migration runs
3. Check `auth_metadata.json` → `supabase_token_expires_at` present and correct

---

### AC-4: Fallback Auth Path Writes Version

- [ ] In `run()`, when `get_user_info()` exhausts retries and falls back to cached credentials:
  - If `self.supabase_initialized` is `True` and `self.current_user_id` is valid (non-anonymous), call `_update_desktop_status(logged_in=True)`
- [ ] Log: `[AUTH] Using cached credentials, updating desktop status`
- [ ] Version written even if Atlassian API is unreachable

**Validation:**
1. Mock `get_user_info()` to always fail (simulate Atlassian API down)
2. Ensure cached credentials exist
3. Start app → should fall back to cache and still write version

---

### AC-5: Heartbeat Self-Healing

- [ ] `_send_heartbeat()` UPDATE includes `'desktop_logged_in': True` in payload
- [ ] After UPDATE, check `response.data` length (Supabase Python returns list)
- [ ] If `len(response.data) == 0` (RLS block due to expired JWT):
  - Log: `[HEARTBEAT] 0 rows updated, attempting JWT refresh`
  - Call `self.auth_manager.refresh_supabase_jwt(force=True)`
  - If refresh succeeds, re-build supabase client with new JWT and retry UPDATE
  - If retry succeeds, log: `[HEARTBEAT] Recovered after JWT refresh`
  - If retry still fails, log error with full traceback
- [ ] Reset `heartbeat_counter = 0` only after **successful** update (rows > 0)

**Validation:**
1. Start app, wait 1 hour (JWT expires)
2. Wait for next heartbeat cycle
3. Should see JWT refresh in logs
4. DB should update successfully after refresh

---

### AC-6: Proactive JWT Refresh Works

- [ ] Sync thread checks every 15 minutes (every 30 iterations):
  ```python
  sb_expires_at = self.auth_manager.tokens.get('supabase_token_expires_at', 0)
  if sb_expires_at and time.time() > (sb_expires_at - 300):  # 5 min before expiry
      self.auth_manager.refresh_supabase_jwt()
  ```
- [ ] After successful refresh, `auth_metadata.json` updated with new `supabase_token_expires_at`
- [ ] Log: `[JWT] Proactive Supabase JWT refresh successful, new expiry: <timestamp>`

**Validation:**
1. Mock `supabase_token_expires_at` to be 4 minutes in the future
2. Wait for next sync iteration
3. Should see proactive refresh log within 5 minutes
4. New expiry should be 1 hour in the future

---

### AC-7: No Silent Failures

- [ ] All paths where `self.supabase is None` should log **warning or error** (not just `print` or silent return)
- [ ] Failed init attempts log: `[ERROR] Supabase initialization failed: <reason>`
- [ ] Background retry logs attempt: `[RETRY] Attempting Supabase re-initialization (attempt N)`
- [ ] Heartbeat 0-row result logs: `[WARN] Heartbeat UPDATE affected 0 rows (JWT likely expired)`

**Validation:** Grep logs for `WARN` and `ERROR` — all silent failures from analysis should now log

---

### AC-8: Regression Prevention

- [ ] Existing functionality unaffected:
  - OAuth login flow still works
  - Tracking start/stop still works
  - Screenshot upload still works
  - Offline mode still works
- [ ] No new crashes or exceptions during startup
- [ ] Memory usage stays stable (no leak from retry loops)

**Validation:** Run full pytest suite → all existing tests pass

---

## Out of Scope

- Fixing underlying AI server reliability issues (separate infrastructure work)
- Migrating to embedded Supabase config in binary (security risk)
- Rewriting Supabase JWT refresh mechanism (works correctly once expiry field preserved)
- Adding user-visible error notifications for initialization failures (would cause alarm fatigue)
- Implementing exponential backoff for background retries (30-minute fixed interval sufficient)
- Changing heartbeat interval from 4 hours (separate optimization)

---

## Implementation Guide

Each fix below includes:
1. **Files to modify**
2. **Detailed prompt** for the model implementing the fix
3. **Test cases** to write first (TDD)
4. **Verification steps**

---

## FIX-1: Background Supabase Initialization Recovery

### Files to Modify

- `python-desktop-app/desktop_app.py` (sync thread: `start_sync_thread()` function, ~line 10099)

### Implementation Prompt

```
CONTEXT:
You are modifying the desktop app's sync thread to add a background recovery mechanism for failed Supabase initialization. The app currently attempts Supabase init at startup, but if that fails (e.g., transient network issue), the app runs with self.supabase=None for the entire session, causing all DB writes to silently fail.

TASK:
Add a periodic retry mechanism in the sync thread that attempts to re-initialize Supabase every 30 minutes if initialization previously failed.

REQUIREMENTS:

1. In the `start_sync_thread()` function (around line 10099), add a new counter variable:
   - Name: `supabase_retry_counter`
   - Initialize to 0 before the while loop
   - Increment by 1 at the start of each iteration

2. Every 60 iterations (~30 minutes at 30-second intervals), check:
   - If `not self.supabase_initialized` (init failed)
   - AND `self.is_authenticated()` (user is logged in)
   - Then: Call `self.initialize_supabase()`

3. If background retry succeeds:
   - Log: `print("[RECOVERY] Supabase initialization succeeded after background retry")`
   - Immediately call `self._update_desktop_status(logged_in=True)` to push the version update
   - Reset `supabase_retry_counter = 0`

4. If background retry fails:
   - Log: `print("[RETRY] Supabase re-initialization attempt failed, will retry in 30 minutes")`
   - Reset `supabase_retry_counter = 0` (so it tries again in 30 min)

5. Wrap the retry logic in try-except to prevent sync thread crashes:
   ```python
   try:
       # retry logic here
   except Exception as e:
       print(f"[ERROR] Background Supabase retry failed: {e}")
       supabase_retry_counter = 0
   ```

EXAMPLE CODE STRUCTURE:

```python
def start_sync_thread(self):
    # ... existing setup ...
    heartbeat_counter = 0
    heartbeat_interval = 480
    supabase_retry_counter = 0  # NEW
    supabase_retry_interval = 60  # 30 min (60 * 30s)
    
    while self.running:
        try:
            time.sleep(30)
            
            # NEW: Background Supabase recovery
            supabase_retry_counter += 1
            if supabase_retry_counter >= supabase_retry_interval:
                supabase_retry_counter = 0
                if not self.supabase_initialized and self.is_authenticated():
                    print("[RETRY] Attempting Supabase re-initialization...")
                    try:
                        if self.initialize_supabase():
                            print("[RECOVERY] Supabase initialization succeeded after background retry")
                            if self.current_user_id:
                                self._update_desktop_status(logged_in=True)
                        else:
                            print("[RETRY] Supabase re-initialization attempt failed, will retry in 30 minutes")
                    except Exception as retry_err:
                        print(f"[ERROR] Background Supabase retry failed: {retry_err}")
            
            # ... existing sync logic (heartbeat, offline sync, etc.) ...
```

CONSTRAINTS:
- Do not change the existing heartbeat logic or interval
- Do not change the existing offline sync logic
- Only add new code for the retry mechanism
- Ensure the retry only runs when user is authenticated (don't retry during login flow)

VERIFICATION:
After implementation, the following scenario should work:
1. Start app with AI server down → self.supabase = None
2. Bring AI server online
3. Within 30 minutes, app should log "[RECOVERY] Supabase initialization succeeded..."
4. DB should show updated desktop_app_version
```

---

### Tests to Write (TDD)

**File:** `tests/test_supabase_background_recovery.py`

```python
import pytest
import time
from unittest.mock import Mock, patch, MagicMock
from desktop_app import TimeTrackerApp

class TestSupabaseBackgroundRecovery:
    
    def test_background_retry_fires_after_30_minutes(self):
        """Verify retry counter triggers re-init at 60 iterations"""
        app = TimeTrackerApp()
        app.running = True
        app.supabase_initialized = False
        app.current_user_id = "test-user-123"
        
        with patch.object(app, 'is_authenticated', return_value=True), \
             patch.object(app, 'initialize_supabase', return_value=True) as mock_init, \
             patch.object(app, '_update_desktop_status') as mock_update, \
             patch('time.sleep', return_value=None):
            
            # Simulate 60 iterations (30 minutes)
            thread_func = app.start_sync_thread
            # We'll manually drive the counter for testing
            for i in range(60):
                if not app.supabase_initialized and app.is_authenticated():
                    if i == 59:  # 60th iteration (0-indexed)
                        app.initialize_supabase()
            
            # Verify initialize_supabase was called
            assert mock_init.called
    
    def test_background_retry_success_updates_status(self):
        """Verify successful retry calls _update_desktop_status"""
        app = TimeTrackerApp()
        app.supabase_initialized = False
        app.current_user_id = "test-user-123"
        
        with patch.object(app, 'is_authenticated', return_value=True), \
             patch.object(app, 'initialize_supabase', return_value=True), \
             patch.object(app, '_update_desktop_status') as mock_update:
            
            # Simulate successful retry
            if app.initialize_supabase():
                if app.current_user_id:
                    app._update_desktop_status(logged_in=True)
            
            mock_update.assert_called_once_with(logged_in=True)
    
    def test_background_retry_skipped_when_already_initialized(self):
        """Verify no retry when supabase_initialized=True"""
        app = TimeTrackerApp()
        app.supabase_initialized = True  # Already initialized
        
        with patch.object(app, 'initialize_supabase') as mock_init:
            # Retry logic should skip
            if not app.supabase_initialized:
                app.initialize_supabase()
            
            mock_init.assert_not_called()
    
    def test_background_retry_skipped_when_not_authenticated(self):
        """Verify no retry when user not authenticated"""
        app = TimeTrackerApp()
        app.supabase_initialized = False
        
        with patch.object(app, 'is_authenticated', return_value=False), \
             patch.object(app, 'initialize_supabase') as mock_init:
            
            # Retry logic should skip
            if not app.supabase_initialized and app.is_authenticated():
                app.initialize_supabase()
            
            mock_init.assert_not_called()
    
    def test_background_retry_handles_exceptions(self):
        """Verify retry exception doesn't crash sync thread"""
        app = TimeTrackerApp()
        app.supabase_initialized = False
        
        with patch.object(app, 'is_authenticated', return_value=True), \
             patch.object(app, 'initialize_supabase', side_effect=Exception("Network error")):
            
            # Should not raise exception
            try:
                if not app.supabase_initialized and app.is_authenticated():
                    app.initialize_supabase()
            except Exception as e:
                # In real code, this should be caught
                assert False, f"Exception not handled: {e}"
```

---

## FIX-2: Supabase Config Disk Cache with 24h TTL

### Files to Modify

- `python-desktop-app/desktop_app.py` (`get_supabase_config()` method in `AuthManager` class, ~line 2471)
- `python-desktop-app/desktop_app.py` (`_save_auth_metadata()` and `_load_auth_metadata()` methods, if they don't exist, create them)

### Implementation Prompt

```
CONTEXT:
The desktop app fetches Supabase URL and anon key from the AI server at every startup. This creates a hard dependency on AI server availability during the startup window. If the AI server is unreachable (transient outage, DNS delay, VPN reconnecting), Supabase initialization fails and the app runs with self.supabase=None for the entire session.

TASK:
Implement a persistent disk cache for Supabase config with 24-hour TTL and stale fallback.

REQUIREMENTS:

1. **Disk cache location:**
   - File: `auth_metadata.json` (already used for other non-sensitive data)
   - Path: `%LOCALAPPDATA%\TimeTracker\auth_metadata.json`
   - Fields to add: `cached_supabase_url`, `cached_supabase_anon_key`, `supabase_cache_timestamp`

2. **Modify `get_supabase_config()` method** (in `AuthManager` class, around line 2471):

   **Cache-first logic:**
   ```
   A. Load auth_metadata.json
   B. Check if cache exists:
      - cached_supabase_url and cached_supabase_anon_key present
      - supabase_cache_timestamp present
   C. If cache exists:
      - Calculate age: current_time - supabase_cache_timestamp
      - If age < 86400 seconds (24 hours):
          → Use cached values, return True (SKIP AI server call)
   D. If cache missing or stale:
      - Attempt AI server fetch (existing HTTP call)
      - If fetch succeeds:
          → Update cache with new values + current timestamp
          → Return True
      - If fetch fails:
          → If stale cache exists: Use stale values with warning log
          → If no cache exists: Return False (existing behavior)
   ```

3. **Cache write:** After successful AI server fetch, write to `auth_metadata.json`:
   ```python
   metadata = self._load_auth_metadata() or {}
   metadata['cached_supabase_url'] = supabase_url
   metadata['cached_supabase_anon_key'] = supabase_anon_key
   metadata['supabase_cache_timestamp'] = time.time()
   self._save_auth_metadata(metadata)
   ```

4. **Logging:**
   - Cache hit (fresh): `print("[CACHE] Using cached Supabase config (age: {age}s)")`
   - Cache miss, fetching: `print("[CACHE] Fetching Supabase config from AI server")`
   - Fetch success: `print("[CACHE] Supabase config cached successfully")`
   - Fetch fail, using stale: `print("[WARN] AI server unreachable, using stale cache (age: {age}s)")`
   - Fetch fail, no cache: `print("[ERROR] Failed to get Supabase config and no cache available")`

5. **Helper methods** (if they don't exist, create them):

   ```python
   def _load_auth_metadata(self):
       """Load non-sensitive auth metadata from JSON file"""
       metadata_path = os.path.join(
           os.getenv('LOCALAPPDATA'),
           'TimeTracker',
           'auth_metadata.json'
       )
       if not os.path.exists(metadata_path):
           return {}
       try:
           with open(metadata_path, 'r') as f:
               return json.load(f)
       except Exception as e:
           print(f"[WARN] Failed to load auth metadata: {e}")
           return {}
   
   def _save_auth_metadata(self, metadata):
       """Save non-sensitive auth metadata to JSON file"""
       metadata_path = os.path.join(
           os.getenv('LOCALAPPDATA'),
           'TimeTracker',
           'auth_metadata.json'
       )
       os.makedirs(os.path.dirname(metadata_path), exist_ok=True)
       try:
           with open(metadata_path, 'w') as f:
               json.dump(metadata, f, indent=2)
           return True
       except Exception as e:
           print(f"[ERROR] Failed to save auth metadata: {e}")
           return False
   ```

EXAMPLE IMPLEMENTATION:

```python
def get_supabase_config(self):
    """
    Get Supabase config from cache (if fresh) or AI server.
    Falls back to stale cache if AI server unreachable.
    """
    # Load existing metadata
    metadata = self._load_auth_metadata()
    
    # Check cache freshness
    cached_url = metadata.get('cached_supabase_url')
    cached_key = metadata.get('cached_supabase_anon_key')
    cache_timestamp = metadata.get('supabase_cache_timestamp', 0)
    
    current_time = time.time()
    cache_age = current_time - cache_timestamp
    cache_fresh = cache_age < 86400  # 24 hours
    
    # Use fresh cache
    if cached_url and cached_key and cache_fresh:
        print(f"[CACHE] Using cached Supabase config (age: {int(cache_age)}s)")
        RUNTIME_SUPABASE_CONFIG['SUPABASE_URL'] = cached_url
        RUNTIME_SUPABASE_CONFIG['SUPABASE_ANON_KEY'] = cached_key
        return True
    
    # Attempt AI server fetch
    print("[CACHE] Fetching Supabase config from AI server...")
    access_token = self.tokens.get('access_token')
    if not access_token:
        print("[ERROR] No access token available for Supabase config fetch")
        # Try stale cache as last resort
        if cached_url and cached_key:
            print(f"[WARN] Using stale cache (age: {int(cache_age)}s)")
            RUNTIME_SUPABASE_CONFIG['SUPABASE_URL'] = cached_url
            RUNTIME_SUPABASE_CONFIG['SUPABASE_ANON_KEY'] = cached_key
            return True
        return False
    
    try:
        ai_server_url = EMBEDDED_CONFIG['AI_SERVER_URL']
        response = requests.post(
            f"{ai_server_url}/api/auth/supabase-config",
            json={'atlassian_token': access_token},
            timeout=(10, 60)
        )
        
        if response.status_code == 200:
            data = response.json()
            supabase_url = data.get('supabaseUrl')
            supabase_anon_key = data.get('supabaseAnonKey')
            
            if supabase_url and supabase_anon_key:
                # Update runtime config
                RUNTIME_SUPABASE_CONFIG['SUPABASE_URL'] = supabase_url
                RUNTIME_SUPABASE_CONFIG['SUPABASE_ANON_KEY'] = supabase_anon_key
                
                # Update cache
                metadata['cached_supabase_url'] = supabase_url
                metadata['cached_supabase_anon_key'] = supabase_anon_key
                metadata['supabase_cache_timestamp'] = current_time
                self._save_auth_metadata(metadata)
                
                print("[CACHE] Supabase config fetched and cached successfully")
                return True
        
        # Fetch failed, try stale cache
        print(f"[WARN] AI server returned {response.status_code}")
        if cached_url and cached_key:
            print(f"[WARN] Using stale cache as fallback (age: {int(cache_age)}s)")
            RUNTIME_SUPABASE_CONFIG['SUPABASE_URL'] = cached_url
            RUNTIME_SUPABASE_CONFIG['SUPABASE_ANON_KEY'] = cached_key
            return True
        
        return False
        
    except Exception as e:
        print(f"[ERROR] Failed to fetch Supabase config: {e}")
        # Try stale cache as fallback
        if cached_url and cached_key:
            print(f"[WARN] Using stale cache as fallback (age: {int(cache_age)}s)")
            RUNTIME_SUPABASE_CONFIG['SUPABASE_URL'] = cached_url
            RUNTIME_SUPABASE_CONFIG['SUPABASE_ANON_KEY'] = cached_key
            return True
        
        return False
```

CONSTRAINTS:
- Do not hardcode Supabase URL/key in the binary (security risk)
- Cache must survive app restarts and auto-updates
- Stale cache fallback should only log a warning, not error (allows graceful degradation)
- Do not change the AI server endpoint URL or request format

VERIFICATION:
1. Start app with network connected → should fetch from AI server and cache
2. Check auth_metadata.json → should contain cached_supabase_url, cached_supabase_anon_key, supabase_cache_timestamp
3. Restart app within 24h → should use cache, no AI server call
4. Restart app after 24h with AI server down → should use stale cache with warning
```

---

### Tests to Write (TDD)

**File:** `tests/test_supabase_config_cache.py`

```python
import pytest
import os
import time
import json
from unittest.mock import Mock, patch, MagicMock
from desktop_app import AuthManager, RUNTIME_SUPABASE_CONFIG

class TestSupabaseConfigCache:
    
    @pytest.fixture
    def auth_manager(self, tmp_path):
        """Create AuthManager with temporary storage path"""
        with patch.dict(os.environ, {'LOCALAPPDATA': str(tmp_path)}):
            am = AuthManager()
            am.tokens = {'access_token': 'test-token'}
            yield am
    
    def test_fresh_cache_skips_ai_server(self, auth_manager, tmp_path):
        """Verify fresh cache (<24h) skips AI server call"""
        # Create fresh cache
        metadata = {
            'cached_supabase_url': 'https://test.supabase.co',
            'cached_supabase_anon_key': 'test-key-123',
            'supabase_cache_timestamp': time.time() - 3600  # 1 hour ago
        }
        metadata_path = tmp_path / 'TimeTracker' / 'auth_metadata.json'
        metadata_path.parent.mkdir(parents=True, exist_ok=True)
        with open(metadata_path, 'w') as f:
            json.dump(metadata, f)
        
        with patch('requests.post') as mock_post:
            result = auth_manager.get_supabase_config()
            
            # Should use cache, not call AI server
            assert result is True
            mock_post.assert_not_called()
            assert RUNTIME_SUPABASE_CONFIG['SUPABASE_URL'] == 'https://test.supabase.co'
    
    def test_stale_cache_fetches_from_server(self, auth_manager, tmp_path):
        """Verify stale cache (>24h) triggers AI server fetch"""
        # Create stale cache
        metadata = {
            'cached_supabase_url': 'https://old.supabase.co',
            'cached_supabase_anon_key': 'old-key-123',
            'supabase_cache_timestamp': time.time() - 90000  # >24h ago
        }
        metadata_path = tmp_path / 'TimeTracker' / 'auth_metadata.json'
        metadata_path.parent.mkdir(parents=True, exist_ok=True)
        with open(metadata_path, 'w') as f:
            json.dump(metadata, f)
        
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            'supabaseUrl': 'https://new.supabase.co',
            'supabaseAnonKey': 'new-key-456'
        }
        
        with patch('requests.post', return_value=mock_response) as mock_post:
            result = auth_manager.get_supabase_config()
            
            # Should fetch from server
            assert result is True
            mock_post.assert_called_once()
            assert RUNTIME_SUPABASE_CONFIG['SUPABASE_URL'] == 'https://new.supabase.co'
    
    def test_server_fail_uses_stale_cache(self, auth_manager, tmp_path):
        """Verify AI server failure falls back to stale cache"""
        # Create stale cache
        metadata = {
            'cached_supabase_url': 'https://stale.supabase.co',
            'cached_supabase_anon_key': 'stale-key-789',
            'supabase_cache_timestamp': time.time() - 90000  # >24h ago
        }
        metadata_path = tmp_path / 'TimeTracker' / 'auth_metadata.json'
        metadata_path.parent.mkdir(parents=True, exist_ok=True)
        with open(metadata_path, 'w') as f:
            json.dump(metadata, f)
        
        with patch('requests.post', side_effect=Exception("Network error")):
            result = auth_manager.get_supabase_config()
            
            # Should use stale cache as fallback
            assert result is True
            assert RUNTIME_SUPABASE_CONFIG['SUPABASE_URL'] == 'https://stale.supabase.co'
    
    def test_no_cache_and_server_fail_returns_false(self, auth_manager):
        """Verify no cache + server failure = False"""
        with patch('requests.post', side_effect=Exception("Network error")):
            result = auth_manager.get_supabase_config()
            
            assert result is False
    
    def test_successful_fetch_updates_cache(self, auth_manager, tmp_path):
        """Verify successful fetch writes to cache"""
        mock_response = Mock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            'supabaseUrl': 'https://new.supabase.co',
            'supabaseAnonKey': 'new-key-abc'
        }
        
        with patch('requests.post', return_value=mock_response):
            result = auth_manager.get_supabase_config()
            
            assert result is True
            
            # Check cache was written
            metadata_path = tmp_path / 'TimeTracker' / 'auth_metadata.json'
            assert metadata_path.exists()
            with open(metadata_path, 'r') as f:
                metadata = json.load(f)
            assert metadata['cached_supabase_url'] == 'https://new.supabase.co'
            assert metadata['cached_supabase_anon_key'] == 'new-key-abc'
            assert 'supabase_cache_timestamp' in metadata
```

---

## FIX-3: Fix Token Migration to Preserve Expiry Field

### Files to Modify

- `python-desktop-app/desktop_app.py` (`_migrate_from_plaintext()` method in `AuthManager` class, ~line 1887)

### Implementation Prompt

```
CONTEXT:
The app migrates from plaintext token storage (v1.3.x) to encrypted keyring storage (v1.4.x). The migration function calls `secure_storage.migrate_from_plaintext()` which deletes the plaintext file, then tries to read from the deleted file to extract non-sensitive fields like `supabase_token_expires_at`. This causes a FileNotFoundError which is silently caught, resulting in the expiry field being lost. Without the expiry field, proactive JWT refresh never fires, causing silent DB write failures after 1 hour.

TASK:
Fix the migration logic to read the plaintext file BEFORE deleting it, then write non-sensitive fields to auth_metadata.json.

REQUIREMENTS:

1. **Read-before-delete:** In `_migrate_from_plaintext()` method (around line 1887):
   - Check if `self.store_path` exists (the old plaintext file)
   - If yes: Read the entire JSON **BEFORE** calling `migrate_from_plaintext()`
   - Extract non-sensitive fields: `supabase_token_expires_at`, `expires_at`, `cached_supabase_url`, `cached_supabase_anon_key`

2. **Call migration:** After reading:
   - Call `self.secure_storage.migrate_from_plaintext(self.store_path)`
   - This moves sensitive tokens to keyring and deletes the plaintext file

3. **Write metadata:** After migration succeeds:
   - Load existing `auth_metadata.json` (might already have some data)
   - Merge in the preserved fields from step 1
   - Write to `auth_metadata.json`

4. **Logging:**
   - Before migration: `print("[MIGRATION] Found plaintext auth file, migrating to secure storage...")`
   - After extracting fields: `print(f"[MIGRATION] Preserved {len(preserved_fields)} non-sensitive fields")`
   - After successful write: `print("[MIGRATION] Migration complete, metadata preserved")`
   - On any error: `print(f"[ERROR] Migration failed: {e}")` (do NOT silently catch)

5. **Handle missing fields gracefully:**
   - If old file doesn't have `supabase_token_expires_at`, use `0` (will trigger immediate refresh)
   - If old file doesn't have other fields, skip them (don't write `None` or `null`)

EXAMPLE IMPLEMENTATION:

```python
def _migrate_from_plaintext(self):
    """
    Migrate tokens from plaintext JSON to encrypted keyring storage.
    Preserves non-sensitive fields (expiry timestamps, cached config) in auth_metadata.json.
    """
    try:
        if not os.path.exists(self.store_path):
            return  # No migration needed
        
        print("[MIGRATION] Found plaintext auth file, migrating to secure storage...")
        
        # STEP 1: Read plaintext file BEFORE deletion
        old_data = {}
        try:
            with open(self.store_path, 'r') as f:
                old_data = json.load(f)
        except Exception as e:
            print(f"[ERROR] Failed to read plaintext file: {e}")
            return
        
        # STEP 2: Extract non-sensitive fields to preserve
        preserved_fields = {}
        
        if 'supabase_token_expires_at' in old_data:
            preserved_fields['supabase_token_expires_at'] = old_data['supabase_token_expires_at']
        else:
            # If missing, set to 0 to trigger immediate refresh
            preserved_fields['supabase_token_expires_at'] = 0
        
        if 'expires_at' in old_data:
            preserved_fields['expires_at'] = old_data['expires_at']
        
        if 'cached_supabase_url' in old_data:
            preserved_fields['cached_supabase_url'] = old_data['cached_supabase_url']
        
        if 'cached_supabase_anon_key' in old_data:
            preserved_fields['cached_supabase_anon_key'] = old_data['cached_supabase_anon_key']
        
        print(f"[MIGRATION] Preserved {len(preserved_fields)} non-sensitive fields")
        
        # STEP 3: Migrate sensitive tokens to keyring (this deletes plaintext file)
        migrated = self.secure_storage.migrate_from_plaintext(self.store_path)
        
        if not migrated:
            print("[WARN] Secure storage migration returned False")
            return
        
        # STEP 4: Write preserved fields to auth_metadata.json
        metadata = self._load_auth_metadata() or {}
        metadata.update(preserved_fields)
        
        if self._save_auth_metadata(metadata):
            print("[MIGRATION] Migration complete, metadata preserved")
        else:
            print("[ERROR] Failed to save preserved metadata")
        
    except Exception as e:
        print(f"[ERROR] Migration to secure storage failed: {e}")
        import traceback
        traceback.print_exc()
```

CONSTRAINTS:
- Do not modify `secure_storage.migrate_from_plaintext()` (in `auth/secure_storage.py`)
- Do not change the plaintext file path or name
- If migration fails, do NOT delete the plaintext file (user can retry)
- Ensure the preserved fields are actually written to disk (fsync or close file properly)

VERIFICATION:
1. Create test plaintext file at `%LOCALAPPDATA%\TimeTracker\time_tracker_auth.json`:
   ```json
   {
     "access_token": "test-access",
     "refresh_token": "test-refresh",
     "supabase_token": "test-supabase",
     "supabase_token_expires_at": 1747234567.89,
     "expires_at": 1747238000.12
   }
   ```
2. Start app → migration should run
3. Check auth_metadata.json → should contain `supabase_token_expires_at: 1747234567.89`
4. Check keyring (Credential Manager on Windows) → should contain encrypted tokens
5. Check that plaintext file is deleted
```

---

### Tests to Write (TDD)

**File:** `tests/test_token_migration.py`

```python
import pytest
import os
import json
import time
from unittest.mock import Mock, patch
from desktop_app import AuthManager

class TestTokenMigration:
    
    @pytest.fixture
    def auth_manager(self, tmp_path):
        """Create AuthManager with temporary storage"""
        with patch.dict(os.environ, {'LOCALAPPDATA': str(tmp_path)}):
            am = AuthManager()
            yield am
    
    def test_migration_preserves_expiry_field(self, auth_manager, tmp_path):
        """Verify migration preserves supabase_token_expires_at"""
        # Create plaintext file
        plaintext_path = tmp_path / 'TimeTracker' / 'time_tracker_auth.json'
        plaintext_path.parent.mkdir(parents=True, exist_ok=True)
        plaintext_data = {
            'access_token': 'test-access',
            'refresh_token': 'test-refresh',
            'supabase_token': 'test-supabase',
            'supabase_token_expires_at': 1747234567.89,
            'expires_at': 1747238000.12
        }
        with open(plaintext_path, 'w') as f:
            json.dump(plaintext_data, f)
        
        # Mock secure_storage migration
        with patch.object(auth_manager.secure_storage, 'migrate_from_plaintext', return_value=True):
            auth_manager._migrate_from_plaintext()
        
        # Check auth_metadata.json
        metadata_path = tmp_path / 'TimeTracker' / 'auth_metadata.json'
        assert metadata_path.exists()
        with open(metadata_path, 'r') as f:
            metadata = json.load(f)
        
        assert metadata['supabase_token_expires_at'] == 1747234567.89
        assert metadata['expires_at'] == 1747238000.12
    
    def test_migration_handles_missing_expiry(self, auth_manager, tmp_path):
        """Verify migration sets expiry=0 when missing"""
        # Create plaintext file without expiry
        plaintext_path = tmp_path / 'TimeTracker' / 'time_tracker_auth.json'
        plaintext_path.parent.mkdir(parents=True, exist_ok=True)
        plaintext_data = {
            'access_token': 'test-access',
            'refresh_token': 'test-refresh'
        }
        with open(plaintext_path, 'w') as f:
            json.dump(plaintext_data, f)
        
        with patch.object(auth_manager.secure_storage, 'migrate_from_plaintext', return_value=True):
            auth_manager._migrate_from_plaintext()
        
        metadata_path = tmp_path / 'TimeTracker' / 'auth_metadata.json'
        with open(metadata_path, 'r') as f:
            metadata = json.load(f)
        
        # Should default to 0 (triggers immediate refresh)
        assert metadata['supabase_token_expires_at'] == 0
    
    def test_migration_preserves_cached_config(self, auth_manager, tmp_path):
        """Verify migration preserves cached Supabase config"""
        plaintext_path = tmp_path / 'TimeTracker' / 'time_tracker_auth.json'
        plaintext_path.parent.mkdir(parents=True, exist_ok=True)
        plaintext_data = {
            'access_token': 'test-access',
            'cached_supabase_url': 'https://test.supabase.co',
            'cached_supabase_anon_key': 'test-key-123'
        }
        with open(plaintext_path, 'w') as f:
            json.dump(plaintext_data, f)
        
        with patch.object(auth_manager.secure_storage, 'migrate_from_plaintext', return_value=True):
            auth_manager._migrate_from_plaintext()
        
        metadata_path = tmp_path / 'TimeTracker' / 'auth_metadata.json'
        with open(metadata_path, 'r') as f:
            metadata = json.load(f)
        
        assert metadata['cached_supabase_url'] == 'https://test.supabase.co'
        assert metadata['cached_supabase_anon_key'] == 'test-key-123'
    
    def test_migration_skips_when_no_plaintext_file(self, auth_manager):
        """Verify migration skips cleanly when no file exists"""
        # No plaintext file exists
        with patch.object(auth_manager.secure_storage, 'migrate_from_plaintext') as mock_migrate:
            auth_manager._migrate_from_plaintext()
            
            # Should not call migration
            mock_migrate.assert_not_called()
```

---

## FIX-4: Full Auth Fallback Path Writes Version

### Files to Modify

- `python-desktop-app/desktop_app.py` (`run()` method, fallback path after `get_user_info()` exhausts retries, ~line 11440)

### Implementation Prompt

```
CONTEXT:
In the `run()` method, when `get_user_info()` (Atlassian API call) fails all 3 retries, the app falls back to cached user credentials. This allows the app to start in offline/degraded mode. However, this fallback path never calls `_update_desktop_status(logged_in=True)`, so even if Supabase initialization succeeded, the version is never written to the DB.

TASK:
Add version update to the fallback path when Supabase is initialized.

REQUIREMENTS:

1. **Locate the fallback path** in `run()` method (around line 11440-11470):
   - Look for: `else:` block after `if user_info:`
   - This is where cached credentials are loaded
   - Pattern: `cached_user = self._load_cached_user_info()`

2. **Add version update after loading cached credentials:**
   ```python
   else:
       # get_user_info() failed all retries — fall back to cached data
       cached_user = self._load_cached_user_info()
       if cached_user:
           self.current_user = cached_user
           self.current_user_id = cached_user.get('user_id')
           print(f"[OK] Using cached credentials for {cached_user.get('email', 'User')}")
           print("[INFO] Will retry authentication in the background")
           
           # NEW: Update version if Supabase is initialized
           if self.supabase_initialized and self.current_user_id and not self.current_user_id.startswith('anonymous_'):
               print("[AUTH] Updating desktop status with cached credentials")
               self._update_desktop_status(logged_in=True)
   ```

3. **Conditions for update:**
   - `self.supabase_initialized` must be `True` (init succeeded during early init or full auth)
   - `self.current_user_id` must exist and be valid
   - User must NOT be anonymous (`not self.current_user_id.startswith('anonymous_')`)

4. **No exceptions:** Wrap in try-except to prevent startup failures:
   ```python
   try:
       if self.supabase_initialized and self.current_user_id and not self.current_user_id.startswith('anonymous_'):
           print("[AUTH] Updating desktop status with cached credentials")
           self._update_desktop_status(logged_in=True)
   except Exception as e:
       print(f"[WARN] Failed to update desktop status in fallback path: {e}")
   ```

EXAMPLE IMPLEMENTATION:

```python
# In run() method, around line 11440
user_info = self.get_user_info()
if user_info:
    # Successful Atlassian API call
    self.current_user = user_info
    self.current_user_id = user_info.get('account_id')
    
    # Initialize Supabase if not already done
    if not self.supabase_initialized:
        self.initialize_supabase()
    
    # Update status
    if self.current_user_id and not self.current_user_id.startswith('anonymous_'):
        self._update_desktop_status(logged_in=True)
else:
    # NEW LOGIC: Fallback to cached credentials
    cached_user = self._load_cached_user_info()
    if cached_user:
        self.current_user = cached_user
        self.current_user_id = cached_user.get('user_id')
        print(f"[OK] Using cached credentials for {cached_user.get('email', 'User')}")
        print("[INFO] Will retry authentication in the background")
        
        # NEW: Update version if Supabase is initialized
        try:
            if self.supabase_initialized and self.current_user_id and not self.current_user_id.startswith('anonymous_'):
                print("[AUTH] Updating desktop status with cached credentials")
                self._update_desktop_status(logged_in=True)
        except Exception as e:
            print(f"[WARN] Failed to update desktop status in fallback path: {e}")
    else:
        # No cached credentials — start in anonymous mode
        self.current_user_id = f"anonymous_{int(time.time())}"
        print("[INFO] Starting in anonymous mode...")
```

CONSTRAINTS:
- Do not change the retry logic or number of retries for `get_user_info()`
- Do not change the cached credential loading logic
- Do not change anonymous mode behavior
- Update should be best-effort (catch exceptions, log warning, continue startup)

VERIFICATION:
1. Mock `get_user_info()` to always return `None` (simulate Atlassian API down)
2. Ensure cached credentials exist
3. Ensure early init succeeded (self.supabase_initialized = True)
4. Start app → should fall back to cache
5. Check DB → desktop_app_version should be updated
```

---

### Tests to Write (TDD)

**File:** `tests/test_auth_fallback_version_update.py`

```python
import pytest
from unittest.mock import Mock, patch
from desktop_app import TimeTrackerApp

class TestAuthFallbackVersionUpdate:
    
    def test_fallback_updates_version_when_supabase_initialized(self):
        """Verify fallback path writes version if Supabase initialized"""
        app = TimeTrackerApp()
        app.supabase_initialized = True
        app.current_user_id = "test-user-123"
        
        cached_user = {
            'user_id': 'test-user-123',
            'email': 'test@example.com'
        }
        
        with patch.object(app, 'get_user_info', return_value=None), \
             patch.object(app, '_load_cached_user_info', return_value=cached_user), \
             patch.object(app, '_update_desktop_status') as mock_update:
            
            # Simulate fallback path
            user_info = app.get_user_info()
            if not user_info:
                cached = app._load_cached_user_info()
                if cached:
                    app.current_user = cached
                    app.current_user_id = cached['user_id']
                    if app.supabase_initialized and app.current_user_id:
                        app._update_desktop_status(logged_in=True)
            
            mock_update.assert_called_once_with(logged_in=True)
    
    def test_fallback_skips_update_when_supabase_not_initialized(self):
        """Verify no update if Supabase not initialized"""
        app = TimeTrackerApp()
        app.supabase_initialized = False  # Init failed
        
        cached_user = {'user_id': 'test-user-123', 'email': 'test@example.com'}
        
        with patch.object(app, 'get_user_info', return_value=None), \
             patch.object(app, '_load_cached_user_info', return_value=cached_user), \
             patch.object(app, '_update_desktop_status') as mock_update:
            
            user_info = app.get_user_info()
            if not user_info:
                cached = app._load_cached_user_info()
                if cached:
                    app.current_user_id = cached['user_id']
                    # Should skip update
                    if app.supabase_initialized and app.current_user_id:
                        app._update_desktop_status(logged_in=True)
            
            mock_update.assert_not_called()
    
    def test_fallback_skips_update_for_anonymous_user(self):
        """Verify no update for anonymous users"""
        app = TimeTrackerApp()
        app.supabase_initialized = True
        app.current_user_id = "anonymous_1234567890"  # Anonymous
        
        with patch.object(app, '_update_desktop_status') as mock_update:
            if app.supabase_initialized and app.current_user_id and not app.current_user_id.startswith('anonymous_'):
                app._update_desktop_status(logged_in=True)
            
            mock_update.assert_not_called()
```

---

## FIX-5: Heartbeat Self-Healing (JWT Refresh + Retry on 0-Row Result)

### Files to Modify

- `python-desktop-app/desktop_app.py` (`_send_heartbeat()` method, ~line 6628)

### Implementation Prompt

```
CONTEXT:
The heartbeat function updates `desktop_last_heartbeat` and `desktop_app_version` in the `users` table every 4 hours. When the Supabase JWT expires (1-hour TTL), the UPDATE returns 0 rows because RLS blocks the query (auth.uid() is NULL with expired JWT). The current code logs a warning but waits 4 hours before the next attempt. This means version updates can be delayed by 4+ hours after JWT expiry.

TASK:
Make heartbeat self-healing by immediately refreshing JWT and retrying UPDATE when 0 rows are affected. Also include `desktop_logged_in: True` in the heartbeat payload.

REQUIREMENTS:

1. **Add `desktop_logged_in` to heartbeat payload:**
   ```python
   update_data = {
       'desktop_last_heartbeat': 'now()',
       'desktop_app_version': CURRENT_VERSION,
       'desktop_logged_in': True  # NEW
   }
   ```

2. **Check rows affected after UPDATE:**
   - Supabase Python client returns: `response.data` (list of updated rows)
   - 0 rows = `len(response.data) == 0` or `response.data == []`

3. **On 0-row result:**
   - Log: `print("[HEARTBEAT] 0 rows updated (JWT likely expired), attempting refresh...")`
   - Call: `self.auth_manager.refresh_supabase_jwt(force=True)`
   - If refresh succeeds:
     - Re-build Supabase client: `self._set_supabase_jwt(new_token)`
     - Retry the UPDATE with same payload
     - Log result: `print("[HEARTBEAT] Recovered after JWT refresh, rows updated: {len(retry_response.data)}")`
   - If refresh fails or retry still returns 0 rows:
     - Log: `print("[ERROR] Heartbeat recovery failed after JWT refresh")`

4. **Reset heartbeat counter ONLY on success:**
   - Current behavior: `heartbeat_counter = 0` happens regardless of success
   - NEW: Only reset if `len(response.data) > 0` (successful UPDATE)
   - This ensures failed heartbeats retry on the next cycle (4 hours later)

5. **Wrap in try-except to prevent sync thread crash:**
   ```python
   try:
       # heartbeat logic
   except Exception as e:
       print(f"[ERROR] Heartbeat failed: {e}")
       import traceback
       traceback.print_exc()
   ```

EXAMPLE IMPLEMENTATION:

```python
def _send_heartbeat(self):
    """
    Send periodic heartbeat to update last_heartbeat timestamp and version.
    Self-heals by refreshing JWT if UPDATE returns 0 rows.
    """
    client = self.supabase
    if not client:
        return
    
    user_id = self.current_user_id
    if not user_id or user_id.startswith('anonymous_'):
        return
    
    try:
        # Prepare update payload
        update_data = {
            'desktop_last_heartbeat': 'now()',
            'desktop_app_version': CURRENT_VERSION,
            'desktop_logged_in': True  # NEW
        }
        
        # Attempt UPDATE
        response = client.table('users').update(update_data).eq('id', user_id).execute()
        
        # Check if any rows were updated
        if response.data and len(response.data) > 0:
            print(f"[HEARTBEAT] Updated successfully for user {user_id}")
            return True  # Success
        
        # 0 rows updated — likely expired JWT
        print("[HEARTBEAT] 0 rows updated (JWT likely expired), attempting refresh...")
        
        # Attempt JWT refresh
        new_token = self.auth_manager.refresh_supabase_jwt(force=True)
        if not new_token:
            print("[ERROR] JWT refresh failed in heartbeat")
            return False
        
        # Re-build Supabase client with new JWT
        self._set_supabase_jwt(new_token)
        client = self.supabase  # Get refreshed client
        if not client:
            print("[ERROR] Failed to rebuild Supabase client after JWT refresh")
            return False
        
        # Retry UPDATE
        retry_response = client.table('users').update(update_data).eq('id', user_id).execute()
        
        if retry_response.data and len(retry_response.data) > 0:
            print(f"[HEARTBEAT] Recovered after JWT refresh, rows updated: {len(retry_response.data)}")
            return True
        else:
            print("[ERROR] Heartbeat still failed after JWT refresh (0 rows)")
            return False
        
    except Exception as e:
        print(f"[ERROR] Heartbeat failed: {e}")
        import traceback
        traceback.print_exc()
        return False
```

**Modification to sync thread (around line 10200):**

```python
# In start_sync_thread(), around line 10200
if heartbeat_counter >= heartbeat_interval:
    try:
        success = self._send_heartbeat()
        if success:
            heartbeat_counter = 0  # Only reset on success
        else:
            print("[WARN] Heartbeat failed, will retry on next cycle")
            # Don't reset counter if failed? Or reset anyway?
            # Decision: Reset anyway to avoid tight retry loop
            heartbeat_counter = 0
    except Exception as e:
        print(f"[ERROR] Heartbeat exception: {e}")
        heartbeat_counter = 0  # Reset to avoid infinite hang
```

CONSTRAINTS:
- Do not change the heartbeat interval (480 iterations = 4 hours)
- Do not change the sync thread sleep duration (30 seconds)
- JWT refresh must use `force=True` to bypass cache/TTL checks
- Do not retry more than once per heartbeat cycle (avoid retry storms)

VERIFICATION:
1. Start app, wait 1 hour (JWT expires)
2. Wait for next heartbeat cycle (~4 hours)
3. Check logs → should see "JWT likely expired" → "attempting refresh" → "Recovered after JWT refresh"
4. Check DB → desktop_last_heartbeat should be updated
5. Check DB → desktop_logged_in should be True
```

---

### Tests to Write (TDD)

**File:** `tests/test_heartbeat_self_healing.py`

```python
import pytest
from unittest.mock import Mock, patch, MagicMock
from desktop_app import TimeTrackerApp

class TestHeartbeatSelfHealing:
    
    def test_heartbeat_includes_logged_in_flag(self):
        """Verify heartbeat UPDATE includes desktop_logged_in=True"""
        app = TimeTrackerApp()
        app.current_user_id = "test-user-123"
        
        mock_supabase = MagicMock()
        mock_response = Mock()
        mock_response.data = [{'id': 'test-user-123'}]  # 1 row updated
        mock_supabase.table().update().eq().execute.return_value = mock_response
        app.supabase = mock_supabase
        
        app._send_heartbeat()
        
        # Check that update was called with desktop_logged_in=True
        update_call = mock_supabase.table().update.call_args
        update_data = update_call[0][0]
        assert update_data['desktop_logged_in'] is True
    
    def test_heartbeat_success_returns_true(self):
        """Verify successful heartbeat returns True"""
        app = TimeTrackerApp()
        app.current_user_id = "test-user-123"
        
        mock_supabase = MagicMock()
        mock_response = Mock()
        mock_response.data = [{'id': 'test-user-123'}]
        mock_supabase.table().update().eq().execute.return_value = mock_response
        app.supabase = mock_supabase
        
        result = app._send_heartbeat()
        assert result is True
    
    def test_heartbeat_zero_rows_triggers_jwt_refresh(self):
        """Verify 0-row result triggers JWT refresh + retry"""
        app = TimeTrackerApp()
        app.current_user_id = "test-user-123"
        
        # First call returns 0 rows (expired JWT)
        mock_response_fail = Mock()
        mock_response_fail.data = []
        
        # After refresh, retry returns 1 row
        mock_response_success = Mock()
        mock_response_success.data = [{'id': 'test-user-123'}]
        
        mock_supabase = MagicMock()
        mock_supabase.table().update().eq().execute.side_effect = [
            mock_response_fail,
            mock_response_success
        ]
        app.supabase = mock_supabase
        
        with patch.object(app.auth_manager, 'refresh_supabase_jwt', return_value='new-jwt-token'), \
             patch.object(app, '_set_supabase_jwt'):
            
            result = app._send_heartbeat()
            
            # Should have called JWT refresh
            app.auth_manager.refresh_supabase_jwt.assert_called_once_with(force=True)
            # Should have retried UPDATE
            assert mock_supabase.table().update().eq().execute.call_count == 2
            # Should return True (retry succeeded)
            assert result is True
    
    def test_heartbeat_jwt_refresh_failure_returns_false(self):
        """Verify JWT refresh failure returns False"""
        app = TimeTrackerApp()
        app.current_user_id = "test-user-123"
        
        mock_response_fail = Mock()
        mock_response_fail.data = []
        
        mock_supabase = MagicMock()
        mock_supabase.table().update().eq().execute.return_value = mock_response_fail
        app.supabase = mock_supabase
        
        with patch.object(app.auth_manager, 'refresh_supabase_jwt', return_value=None):
            result = app._send_heartbeat()
            
            # Should return False (refresh failed)
            assert result is False
    
    def test_heartbeat_skips_anonymous_users(self):
        """Verify heartbeat skips anonymous users"""
        app = TimeTrackerApp()
        app.current_user_id = "anonymous_1234567890"
        app.supabase = MagicMock()
        
        result = app._send_heartbeat()
        
        # Should skip entirely
        app.supabase.table.assert_not_called()
    
    def test_heartbeat_handles_exceptions_gracefully(self):
        """Verify exceptions don't crash sync thread"""
        app = TimeTrackerApp()
        app.current_user_id = "test-user-123"
        
        mock_supabase = MagicMock()
        mock_supabase.table().update().eq().execute.side_effect = Exception("Network error")
        app.supabase = mock_supabase
        
        # Should not raise exception
        result = app._send_heartbeat()
        assert result is False
```

---

## Implementation Order

**Follow this order to minimize integration complexity:**

1. **FIX-3 first** (migration) — fixes data corruption for existing users, no dependencies
2. **FIX-2 second** (disk cache) — eliminates network dependency, enables other fixes
3. **FIX-4 third** (fallback path) — simple addition, uses existing methods
4. **FIX-5 fourth** (heartbeat self-healing) — depends on JWT refresh working (fixed by FIX-3)
5. **FIX-1 last** (background recovery) — safety net, depends on all other fixes working

---

## Rollback Plan

If any fix causes regressions:

1. **Identify broken fix** via error logs or user reports
2. **Revert specific commit** for that fix (each fix should be separate commit)
3. **Deploy hotfix** without the broken change
4. **Root cause offline** — use test suite to reproduce failure
5. **Re-implement with additional tests**

Each fix is independent enough to be rolled back individually without breaking the others.

---

## Success Metrics

After deployment, monitor for 7 days:

| Metric | Before | Target After Fix |
|--------|--------|------------------|
| Users with stale `desktop_app_version` (>24h old) | ~5-15% | <1% |
| Users with `desktop_logged_in = false` while app running | ~10-20% | <2% |
| Support tickets: "version not updating" | ~2-3/week | <1/month |
| Auto-update adoption rate (v1.4.x → v1.5.x) | ~75% in 14 days | >90% in 14 days |

---

## Related Documentation

- [Root Cause Analysis](../docs/ROOT_CAUSE_ANALYSIS_desktop_app_version_not_updating_2026-05-20.md) — Full technical analysis
- [Desktop App README](../docs/desktop-app_README.md) — Architecture overview
- [Copilot Instructions](../.github/copilot-instructions.md) — Project conventions

---

## Appendix: Complete Test Suite Checklist

Before marking implementation complete, ensure ALL tests pass:

```bash
# Run full test suite
cd python-desktop-app
python -m pytest tests/ -v --tb=short

# Expected test files after implementation:
# tests/test_supabase_background_recovery.py      (5 tests)
# tests/test_supabase_config_cache.py              (6 tests)
# tests/test_token_migration.py                    (4 tests)
# tests/test_auth_fallback_version_update.py       (3 tests)
# tests/test_heartbeat_self_healing.py             (6 tests)
# Total new tests: 24

# All existing tests must still pass (regression check)
# Expected: 0 failures, 0 errors
```

---

**End of Implementation Plan**
