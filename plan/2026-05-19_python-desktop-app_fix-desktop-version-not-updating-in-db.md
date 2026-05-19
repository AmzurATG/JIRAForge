# Fix: `desktop_app_version` Not Updating in DB After Auto-Update

**Date:** 2026-05-19  
**Component:** `python-desktop-app`  
**Type:** Critical Bug Fix  
**App Version:** 1.4.2 (fixes built and included)  
**Status:** Fixes 1–5 implemented and built. Fix 6 pending.

**Related Documentation:**
- [docs/DIFFERENTIAL_ROOT_CAUSE_desktop_version_not_updating.md](../docs/DIFFERENTIAL_ROOT_CAUSE_desktop_version_not_updating.md)
- [docs/SESSION_MAINTENANCE_ROOT_CAUSE_ANALYSIS_V2.md](../docs/SESSION_MAINTENANCE_ROOT_CAUSE_ANALYSIS_V2.md)
- [plan/2026-05-14_python-desktop-app_fix-jwt-expiration-timing-and-validation.md](2026-05-14_python-desktop-app_fix-jwt-expiration-timing-and-validation.md)

---

## Problem

**User-Visible Symptom:**  
The desktop app tray shows `Up to Date (v1.4.1)` — the correct new version — but the Supabase `users` table still shows `desktop_app_version = 1.3.7`. The `desktop_logged_in` flag is stuck at `false` and `desktop_last_heartbeat` is frozen at the exact moment the old version was last running. This affects a subset of users (not all). For the affected users, the DB record never self-corrects — it can remain stale for 7+ days without any error being visible to the user.

**Confirmed Example:**
```
email:                  geetashish.sharma@amzur.com
desktop_app_version:    1.3.7   ← stuck at old version
desktop_logged_in:      false
desktop_last_heartbeat: 2026-05-11 07:11:17  ← 7 days ago (coincides with update date)
supabase_user_id = id:  ✅ (RLS fix from previous session is working)
```

**Business Impact:**
- Admin dashboards show incorrect version for affected users (can't verify who is on v1.4.1)
- Users appear as "inactive" or "logged out" in Jira Forge UI despite actively working
- No self-healing — affected users stay broken until manual sign-out/sign-in
- Invisible to users — they see no error, the app appears normal

---

## Why Previous Fixes Didn't Catch This

Previous analyses (`SESSION_MAINTENANCE_ROOT_CAUSE_ANALYSIS_V2.md`, `2026-05-14_python-desktop-app_fix-jwt-expiration-timing-and-validation.md`) identified JWT token expiry timing as the root cause of heartbeat failures. Those fixes were correct for mid-session failures (JWT expires after 1 hour while app is running). However, they did NOT address a deeper class of failures that begins at startup:

- JWT expiry failure: `self.supabase` IS initialized, but the JWT on the client is expired → 0-row results → detectable and loggable
- **This bug:** `self.supabase` is `None` (never initialized) → every heartbeat silently returns immediately with zero log output

The 7-day duration with a version frozen at exactly the update date is incompatible with JWT timing as the cause. JWT failures would show up intermittently with 0-row log warnings every 4 hours. A completely silent 7-day freeze points definitively to `self.supabase = None`.

---

## Root Causes Identified

### RC-1 (Critical): One-Shot Initialization Guard — No Background Recovery

**File:** `desktop_app.py`  
**Functions:** `initialize_supabase()`, `start_sync_thread()`, `_send_heartbeat()`

`initialize_supabase()` has an early-exit guard `if self.supabase_initialized: return True`. If initialization fails at startup (e.g. AI server briefly unreachable), `self.supabase` stays `None` and `self.supabase_initialized` stays `False` for the entire session. The background sync thread — which runs every 30 seconds — never calls `initialize_supabase()`. Every heartbeat silently skips:

```python
def _send_heartbeat(self):
    client = self.supabase
    if not client:
        return   # ← Zero log output. App continues looking healthy.
```

For a machine that doesn't reboot, this broken state persists indefinitely.

---

### RC-2 (Critical): Supabase Credentials Not Cached to Disk

**File:** `desktop_app.py`  
**Function:** `get_supabase_config()`

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are not embedded in the app and are not stored on disk. At every startup the app must make a live HTTP call to `https://forgesync.amzur.com/api/auth/supabase-config` to obtain them. If this call fails (server briefly down, network not yet ready after sleep/VPN reconnect, DNS cold start), `initialize_supabase()` fails immediately and RC-1 takes over.

```python
EMBEDDED_CONFIG = {
    'ATLASSIAN_CLIENT_ID': '...',
    'AI_SERVER_URL': 'https://forgesync.amzur.com',
    # SUPABASE_URL and SUPABASE_ANON_KEY intentionally not embedded — fetched at runtime
}
# RUNTIME_SUPABASE_CONFIG is reset to None on every process start
```

---

### RC-3 (High): Early Init Fires Before Connectivity Check

**File:** `desktop_app.py`  
**Function:** `run()`

The early Supabase initialization block (which calls `get_supabase_config()` over the network) runs unconditionally before `check_connectivity()`. On Windows, NICs are not immediately ready after wake-from-sleep or auto-start on login. The result is a guaranteed network failure during early init when the machine just woke up, before the app has verified that the network is available.

```python
# run():
# STEP 1 — Early init (network call, NO connectivity pre-check)
if has_stored_tokens:
    if self.initialize_supabase():   ← get_supabase_config() called here, network may not be ready
        ...

# STEP 2 — Connectivity check (too late)
is_online = self.offline_manager.check_connectivity(force=True)
```

---

### RC-4 (High): Both Init Attempts Hit the Same Server — No Independent Fallback

**File:** `desktop_app.py`  
**Function:** `run()`

`initialize_supabase()` is called twice in the startup sequence: once in early init and once in the full auth flow. Both calls go through `get_supabase_config()`, which hits the same `forgesync.amzur.com` endpoint. If that server has a brief outage spanning the startup window (~30–90 seconds), both attempts fail. The full auth fallback path then uses cached credentials but **never calls `_update_desktop_status(logged_in=True)`**:

```python
else:
    # get_user_info() failed 3 times — use cache
    self.current_user = cached_user
    self.current_user_id = cached_user.get('user_id')
    # ← NO initialize_supabase() retry
    # ← NO _update_desktop_status(logged_in=True)
```

---

### RC-5 (High): Migration Bug Loses `supabase_token_expires_at`

**File:** `desktop_app.py`  
**Function:** `AtlassianAuthManager._migrate_from_plaintext()`

When users migrated from the old plaintext `time_tracker_auth.json` to the new Windows Credential Manager storage, the code attempted to read the old file and extract non-sensitive metadata (including `supabase_token_expires_at`) for saving to `auth_metadata.json`. However, the migration helper `secure_storage.migrate_from_plaintext()` **deletes the source file before the AuthManager reads it**. The resulting `FileNotFoundError` was silently swallowed by `except Exception: pass`. As a consequence:

- `auth_metadata.json` was never created for migrated users
- `supabase_token_expires_at` is missing from `self.tokens` → defaults to `0`
- The proactive Supabase JWT refresh in the sync thread is gated on `if sb_expires_at and ...` which evaluates to `if 0 and ...` = **False**
- JWT expires after 1 hour with no proactive refresh; subsequent heartbeats fail with 0-row results or JWT exceptions

**The bug (before fix):**
```python
migrated = self.secure_storage.migrate_from_plaintext(self.store_path)  # Deletes store_path
if migrated:
    with open(self.store_path, 'r') as f:   # ← FileNotFoundError — file was just deleted
        old_data = json.load(f)
    # This block never runs → auth_metadata.json never created → supabase_token_expires_at = 0
```

---

### RC-6 (Medium): Heartbeat Does Not Write `desktop_logged_in=True`

**File:** `desktop_app.py`  
**Function:** `_send_heartbeat()`

`quit_app()` sets `desktop_logged_in = False` in the DB when the old version exits. Only `_update_desktop_status(logged_in=True)` (called during the startup auth flow) can repair it. Heartbeats never include this field. If the startup auth flow fails (RC-1), `desktop_logged_in` remains `False` indefinitely even though the app is actively running.

---

### RC-7 (Medium): Heartbeat Skips Entirely on JWT Refresh Failure, Waits 4 Hours

**File:** `desktop_app.py`  
**Function:** `_send_heartbeat()`

When the Supabase JWT is expired and the refresh call fails (AI server briefly unavailable at the 4-hour heartbeat mark), the entire heartbeat is skipped. There is no immediate retry and no fallback. The next opportunity is 4 hours later. If the 0-row result from an expired JWT is reached instead, there is also no retry — the failure is logged but the 4-hour wait begins again.

---

## Solution Overview

Seven targeted fixes address the root causes. Fixes 1–5 are already implemented in the codebase and included in the v1.4.2 build. Fix 6 is pending implementation.

| Fix | Root Cause | Status | Risk |
|-----|-----------|--------|------|
| FIX-1: Background Supabase re-init in sync thread | RC-1 | ✅ Implemented | Low |
| FIX-2: Cache Supabase config to `auth_metadata.json` | RC-2 | ✅ Implemented | Low |
| FIX-3: Fix migration bug (read file before deleting) | RC-5 | ✅ Implemented | Very Low |
| FIX-4: Call `_update_desktop_status` in fallback path | RC-4 | ✅ Implemented | Low |
| FIX-5: `desktop_logged_in=True` + 0-row retry in heartbeat | RC-6, RC-7 | ✅ Implemented | Very Low |
| FIX-6: Pre-connectivity guard before early init | RC-3 | ❌ Pending | Low |

---

## Detailed Implementation

---

### FIX-1: Background Supabase Re-Initialization in Sync Thread

**Status:** ✅ Implemented  
**File:** `python-desktop-app/desktop_app.py`  
**Function:** `start_sync_thread()` → `sync_worker()`  
**Lines:** ~10106–10138

**What it does:**  
Every 30 minutes, if `self.supabase_initialized` is still `False` and the user is authenticated, the sync thread calls `initialize_supabase()`. On success it immediately calls `_update_desktop_status(logged_in=True)` to write the correct version and login state to the DB. This turns a permanent per-session failure into a self-healing one that recovers within 30 minutes.

**Implemented code:**
```python
supabase_reinit_counter = 0
supabase_reinit_interval = 60  # Retry every 30 min (60 × 30s)

while self.running:
    # Background Supabase re-initialization
    if not self.supabase_initialized and self.auth_manager.is_authenticated():
        supabase_reinit_counter += 1
        if supabase_reinit_counter >= supabase_reinit_interval:
            supabase_reinit_counter = 0
            print("[INFO] Supabase not initialized — attempting background re-initialization...")
            try:
                if self.initialize_supabase():
                    print("[OK] Supabase re-initialized successfully in background")
                    if self.current_user_id and not self.current_user_id.startswith('anonymous_'):
                        try:
                            self._update_desktop_status(logged_in=True)
                        except Exception as ds_err:
                            print(f"[WARN] Could not update desktop status after re-init: {ds_err}")
            except Exception as ri_err:
                print(f"[WARN] Background Supabase re-init failed: {ri_err}")
    else:
        supabase_reinit_counter = 0  # Reset once initialized
```

**Why 30 minutes:** Balances fast recovery against unnecessary AI server traffic. A user affected by this bug would have their version updated within 30 minutes of next startup without any manual action.

---

### FIX-2: Cache Supabase Config to Disk (24-Hour TTL)

**Status:** ✅ Implemented  
**File:** `python-desktop-app/desktop_app.py`  
**Function:** `get_supabase_config()`  
**Lines:** ~2470–2550

**What it does:**  
After a successful call to `/api/auth/supabase-config`, the Supabase URL and anon key are saved to `auth_metadata.json` with a timestamp. On the next startup, if the cached values are less than 24 hours old, they are used immediately without making a network call. This eliminates the hard dependency on AI server availability at startup. On network failure, falls back to stale cache rather than returning `False`.

The Supabase anon key is intentionally public-facing (designed to be exposed to browser clients by Supabase), so storing it locally raises no security concern.

**Cache keys added to `auth_metadata.json`:**
```json
{
  "cached_supabase_url": "https://jvijitdewbypqbatfboi.supabase.co",
  "cached_supabase_anon_key": "eyJ...",
  "cached_supabase_config_at": 1747641234.567
}
```

**Implemented code (key sections):**
```python
def get_supabase_config(self):
    # Check local cache first (24-hour TTL)
    cached_url = self.tokens.get('cached_supabase_url')
    cached_anon_key = self.tokens.get('cached_supabase_anon_key')
    cached_at = self.tokens.get('cached_supabase_config_at', 0)
    CACHE_TTL = 86400  # 24 hours
    if cached_url and cached_anon_key and (time.time() - cached_at) < CACHE_TTL:
        print("[INFO] Using locally cached Supabase config (last fetched <24h ago)")
        set_runtime_supabase_config(cached_url, cached_anon_key)
        return True

    # ... (network fetch) ...

    # After successful fetch: persist to auth_metadata.json
    self.tokens['cached_supabase_url'] = supabase_url
    self.tokens['cached_supabase_anon_key'] = supabase_anon_key
    self.tokens['cached_supabase_config_at'] = time.time()
    self._save_tokens()

    # On network error: fall back to stale cache instead of failing
    except Exception as e:
        if cached_url and cached_anon_key:
            print("[WARN] Using stale cached Supabase config after network error")
            set_runtime_supabase_config(cached_url, cached_anon_key)
            return True
        return False
```

---

### FIX-3: Fix Migration Bug — Read File Before Deleting

**Status:** ✅ Implemented  
**File:** `python-desktop-app/desktop_app.py`  
**Function:** `AtlassianAuthManager._migrate_from_plaintext()`  
**Lines:** ~1887–1930

**What it does:**  
Reads the old plaintext token file **before** calling `migrate_from_plaintext()` (which deletes it). The pre-read data, including `supabase_token_expires_at`, is then used to populate `auth_metadata.json` correctly. This ensures that users who migrated from old storage have their token expiry information preserved, enabling proper proactive JWT refresh in the sync thread.

**Before (broken):**
```python
migrated = self.secure_storage.migrate_from_plaintext(self.store_path)  # Deletes store_path
if migrated:
    with open(self.store_path, 'r') as f:   # FileNotFoundError — file gone
        old_data = json.load(f)
    # Never reached — auth_metadata.json never created
```

**After (fixed):**
```python
# Read BEFORE migration deletes the file
old_data = {}
try:
    with open(self.store_path, 'r') as f:
        old_data = json.load(f)
except Exception as read_err:
    print(f"[WARN] Could not read old token file before migration: {read_err}")

migrated = self.secure_storage.migrate_from_plaintext(self.store_path)
if migrated:
    try:
        metadata = {k: v for k, v in old_data.items() if k not in SENSITIVE_TOKEN_KEYS}
        if metadata:
            with open(self.metadata_path, 'w') as f:
                json.dump(metadata, f)
    except Exception as meta_err:
        print(f"[WARN] Could not save metadata during migration: {meta_err}")
```

---

### FIX-4: Call `_update_desktop_status` in Fallback Startup Paths

**Status:** ✅ Implemented  
**File:** `python-desktop-app/desktop_app.py`  
**Function:** `run()`  
**Lines:** ~11392–11407

**What it does:**  
When `get_user_info()` fails all 3 retries and the app falls back to cached credentials, if Supabase was successfully initialized via early init (FIX-2 makes this more likely), the new version and login state are written to the DB immediately. Previously, this path never called `_update_desktop_status`.

**Implemented code:**
```python
# Fallback path: get_user_info() failed, using cached credentials
cached_user = self._load_cached_user_info()
if cached_user:
    self.current_user = cached_user
    self.current_user_id = cached_user.get('user_id')
    print(f"[OK] Using cached credentials for {cached_user.get('email', 'User')}")
    # If Supabase was already initialized (early init succeeded), push version now
    if self.supabase_initialized and self.current_user_id:
        try:
            self._update_desktop_status(logged_in=True)
            print("[OK] Desktop status updated from cached-fallback path")
        except Exception as ds_err:
            print(f"[WARN] Could not update desktop status in fallback path: {ds_err}")
```

---

### FIX-5: `desktop_logged_in=True` in Heartbeat + Immediate Retry on 0-Row Result

**Status:** ✅ Implemented  
**File:** `python-desktop-app/desktop_app.py`  
**Function:** `_send_heartbeat()`  
**Lines:** ~6658–6685

**What it does (two parts):**

**Part A — `desktop_logged_in=True` in heartbeat payload:**  
The heartbeat payload now includes `desktop_logged_in: True`. A running heartbeat is proof the app is active and the user is logged in. This self-heals any stale `desktop_logged_in=false` state left over from `quit_app()` on the old version.

**Part B — Immediate retry after 0-row result:**  
When the heartbeat UPDATE returns 0 rows (indicating the JWT on the Supabase client is expired or the RLS check failed), instead of logging and waiting 4 hours for the next attempt, the code forces a JWT refresh and retries the UPDATE immediately. This collapses a 4-hour recovery window into seconds.

**Implemented code:**
```python
result = client.table('users').update({
    'desktop_last_heartbeat': datetime.now(timezone.utc).isoformat(),
    'desktop_app_version': self.app_version,
    'desktop_logged_in': True   # Repair stale false; heartbeat = app is running
}).eq('id', self.current_user_id).execute()

if not result.data or len(result.data) == 0:
    print(f"[WARN] Heartbeat 0 rows — JWT may be expired, forcing refresh...")
    # Immediate retry after JWT refresh (instead of waiting 4 hours)
    if self._set_supabase_jwt():
        retry_result = client.table('users').update({
            'desktop_last_heartbeat': datetime.now(timezone.utc).isoformat(),
            'desktop_app_version': self.app_version,
            'desktop_logged_in': True
        }).eq('id', self.current_user_id).execute()
        if retry_result.data and len(retry_result.data) > 0:
            print(f"[OK] Heartbeat retry succeeded after JWT refresh (v{self.app_version})")
            return
    self.add_admin_log('ERROR', f'Heartbeat failed: 0 rows ...')
```

---

### FIX-6: Pre-Connectivity Guard Before Early Init (PENDING)

**Status:** ❌ Not yet implemented  
**File:** `python-desktop-app/desktop_app.py`  
**Function:** `run()`  
**Lines:** ~11363–11380

**Problem:**  
The early Supabase initialization block runs before `check_connectivity()`. On machines that just woke from sleep, auto-started on Windows login, or have a VPN reconnecting, the network adapter is not yet ready. The `get_supabase_config()` network call fails immediately, wasting the early init opportunity.

**Proposed Change:**  
Add a lightweight non-forced connectivity check (`force=False` uses a 30-second cache) before calling `initialize_supabase()` in the early init block. If the check fails, skip early init — FIX-1 (background re-init) and FIX-2 (disk cache) together ensure the session self-heals quickly after the network is ready.

**Target code change in `run()`:**
```python
# BEFORE (current):
if has_stored_tokens:
    cached_user = self._load_cached_user_info()
    if cached_user and cached_user.get('organization_id'):
        self.organization_id = cached_user.get('organization_id')
        self.current_user_id = cached_user.get('user_id')
        self.current_user = cached_user
        print(f"[OK] Restored organization_id from cache: {self.organization_id}")
        try:
            if self.initialize_supabase():              # ← Network call with no pre-check
                print("[OK] Supabase initialized successfully from cache")
        except Exception as e:
            print(f"[WARN] Could not initialize Supabase from cache: {e}")

# AFTER (proposed):
if has_stored_tokens:
    cached_user = self._load_cached_user_info()
    if cached_user and cached_user.get('organization_id'):
        self.organization_id = cached_user.get('organization_id')
        self.current_user_id = cached_user.get('user_id')
        self.current_user = cached_user
        print(f"[OK] Restored organization_id from cache: {self.organization_id}")
        # Only attempt Supabase init if network appears ready.
        # Use force=False (non-blocking cached check) to avoid a slow DNS call
        # here — the full is_online check runs a few lines below.
        if self.offline_manager.check_connectivity(force=False):
            try:
                if self.initialize_supabase():
                    print("[OK] Supabase initialized successfully from cache")
            except Exception as e:
                print(f"[WARN] Could not initialize Supabase from cache: {e}")
        else:
            print("[INFO] Skipping early Supabase init (network not yet ready)")
```

**Note:** With FIX-2 (disk cache), even if the early init is skipped, the full auth path's `initialize_supabase()` call will use cached credentials and succeed without a network call. This makes FIX-6 a safety improvement, not a critical dependency.

---

## How the Fixes Work Together

For the specific scenario of a user whose machine starts v1.4.1 while the AI server is briefly unreachable:

```
v1.4.1 startup:
  Early init (FIX-6 guards this, FIX-2 uses cache if available)
  ↓
  Full auth path:
    get_user_info() → succeeds (Atlassian API, different server)
    initialize_supabase():
      get_supabase_config() → uses cached URL/anon key (FIX-2) → SUCCESS
      _set_supabase_jwt() → uses cached supabase_token → SUCCESS
    _update_desktop_status(logged_in=True) → desktop_app_version = 1.4.1 ✅

If full auth also fails (worst case — AI server down for full startup window):
  FIX-4: If Supabase IS initialized (from cache), update status from fallback path
  FIX-1: Within 30 minutes, sync thread retries initialize_supabase() + updates status

If heartbeat fires with expired JWT:
  FIX-5: Immediate retry after JWT refresh (no 4-hour wait)
  FIX-5: desktop_logged_in repaired in same write
```

---

## Acceptance Criteria

### AC-1: Background Recovery (FIX-1)
When `initialize_supabase()` fails at startup, the sync thread **must** re-attempt initialization within 30 minutes. After successful background re-init:
- `desktop_app_version` is updated to the running version
- `desktop_logged_in` is set to `true`
- `desktop_last_heartbeat` is updated

### AC-2: Startup Without AI Server (FIX-2)
When the AI server is completely unreachable at startup but a cached Supabase config exists from the previous 24 hours:
- `initialize_supabase()` **must succeed** using cached values
- No 500 errors, no degraded state
- `desktop_app_version` is updated within the same startup

### AC-3: Stale Cache Fallback (FIX-2)
When a network error occurs during `get_supabase_config()` and a stale cache exists (>24 hours old):
- `get_supabase_config()` **must return True** using the stale values
- A `[WARN]` log is emitted: `"Using stale cached Supabase config after network error"`

### AC-4: Migration Metadata Preserved (FIX-3)
When migrating from `time_tracker_auth.json` to secure storage:
- `auth_metadata.json` **must be created** with all non-sensitive fields from the old file
- `supabase_token_expires_at` **must be present** in `auth_metadata.json` after migration
- The proactive JWT refresh in the sync thread fires correctly after migration

### AC-5: Fallback Path Writes Version (FIX-4)
When `get_user_info()` fails 3 times and the app uses cached credentials:
- If `supabase_initialized = True`, `_update_desktop_status(logged_in=True)` **must be called**
- `desktop_app_version` **must reflect the running version** after fallback startup

### AC-6: Heartbeat Repairs `desktop_logged_in` (FIX-5)
When a heartbeat succeeds:
- The `desktop_logged_in` field in the DB **must be set to `true`**
- A user who was stuck at `desktop_logged_in=false` (from `quit_app()` on old version) must have it repaired on the next successful heartbeat

### AC-7: 0-Row Heartbeat Retries Immediately (FIX-5)
When a heartbeat UPDATE returns 0 rows:
- A JWT refresh **must be attempted immediately**
- If the refresh succeeds, the UPDATE **must be retried in the same heartbeat cycle**
- The 4-hour wait **must not apply** when an immediate retry is possible

### AC-8: Early Init Respects Network Readiness (FIX-6)
When the network is not yet available at startup time (e.g., machine just woke from sleep):
- Early init `initialize_supabase()` call **must be skipped**
- A log message `"Skipping early Supabase init (network not yet ready)"` **must be emitted**
- The full auth flow's `initialize_supabase()` call (which runs after `check_connectivity()`) **must still execute**

---

## Test Plan

### Unit Tests

**File:** `python-desktop-app/tests/test_desktop_version_update.py` (new)

#### test_supabase_reinit_in_sync_thread
- Set `app.supabase_initialized = False`, `app.supabase = None`
- Mock `initialize_supabase()` to return `True` after 60 iterations
- Mock `_update_desktop_status()` and verify it is called with `logged_in=True` after successful re-init
- Assert: `_update_desktop_status` called exactly once with `logged_in=True`

#### test_supabase_reinit_does_not_fire_before_interval
- Set `app.supabase_initialized = False`
- Mock `initialize_supabase()` to track call count
- Run 59 iterations of the sync_worker check block
- Assert: `initialize_supabase` was NOT called at iteration 59

#### test_get_supabase_config_uses_disk_cache
- Pre-populate `auth_manager.tokens` with `cached_supabase_url`, `cached_supabase_anon_key`, `cached_supabase_config_at = time.time()`
- Mock `requests.post` to raise `ConnectionError`
- Call `auth_manager.get_supabase_config()`
- Assert: returns `True` (cache hit, no network call)
- Assert: `requests.post` was NOT called

#### test_get_supabase_config_refreshes_cache_after_ttl
- Pre-populate cache with `cached_supabase_config_at = time.time() - 90000` (25 hours ago — expired)
- Mock `requests.post` to return valid response
- Call `auth_manager.get_supabase_config()`
- Assert: `requests.post` WAS called
- Assert: `tokens['cached_supabase_config_at']` updated to approximately `time.time()`

#### test_get_supabase_config_falls_back_to_stale_on_error
- Pre-populate cache with `cached_supabase_config_at = time.time() - 90000` (25 hours — stale)
- Mock `requests.post` to raise `ConnectionError`
- Call `auth_manager.get_supabase_config()`
- Assert: returns `True` (fell back to stale cache)
- Assert: `RUNTIME_SUPABASE_CONFIG` was populated with stale values

#### test_migrate_from_plaintext_preserves_supabase_token_expires_at
- Create a mock `time_tracker_auth.json` with `supabase_token_expires_at = 1234567890`
- Mock `secure_storage.migrate_from_plaintext()` to return `True` AND delete the source file
- Call `auth_manager._migrate_from_plaintext()`
- Assert: `auth_metadata.json` exists and contains `supabase_token_expires_at = 1234567890`

#### test_heartbeat_writes_desktop_logged_in_true
- Mock Supabase client's `update().eq().execute()` to return `data=[{'id': '...'}]`
- Call `app._send_heartbeat()` with valid `current_user_id`
- Inspect the `update()` call arguments
- Assert: payload includes `'desktop_logged_in': True`

#### test_heartbeat_retries_on_zero_rows
- Mock Supabase client's first `execute()` to return `data=[]` (0 rows)
- Mock `_set_supabase_jwt()` to return `True`
- Mock Supabase client's second `execute()` to return `data=[{'id': '...'}]`
- Call `app._send_heartbeat()`
- Assert: `execute()` was called **twice**
- Assert: `_set_supabase_jwt()` was called once between them

#### test_fallback_path_calls_update_desktop_status
- Set `app.supabase_initialized = True`, `app.supabase = MagicMock()`
- Set up cached user info with a valid `user_id`
- Mock `auth_manager.get_user_info()` to return `None` (all 3 retries fail)
- Mock `_update_desktop_status()` to track calls
- Run the fallback branch of `run()`
- Assert: `_update_desktop_status` called with `logged_in=True`

#### test_early_init_skipped_when_offline (FIX-6)
- Mock `offline_manager.check_connectivity(force=False)` to return `False`
- Mock `initialize_supabase()` to track calls
- Set `has_stored_tokens = True`, valid `cached_user` with `organization_id`
- Run early init block
- Assert: `initialize_supabase()` was NOT called during early init
- Assert: log contains `"Skipping early Supabase init (network not yet ready)"`

---

## Manual Verification Steps

For affected users (those currently stuck with stale `desktop_app_version`):

### Immediate Fix (Without App Restart)
1. Ask user to open the desktop app
2. Within 30 minutes, FIX-1 will attempt background Supabase re-init
3. Check DB: `desktop_app_version` should update and `desktop_logged_in` should become `true`

### Confirmation After v1.4.2 Build
1. Identify a test machine where v1.4.1 produced a stuck version in the DB
2. Manually simulate AI server unavailability at startup (block the AI server URL via hosts file for 60 seconds at startup)
3. Start the app — observe log: `"Supabase not initialized — attempting background re-initialization..."`
4. Wait 30 minutes — observe log: `"[OK] Supabase re-initialized successfully in background"`
5. Verify DB: `desktop_app_version = 1.4.2`, `desktop_logged_in = true`

### Verify Disk Cache Behavior
1. Start app normally — verify AI server is called and cache is populated in `auth_metadata.json`
2. Stop app. Edit hosts file to block `forgesync.amzur.com`
3. Start app again — observe log: `"Using locally cached Supabase config (last fetched <24h ago)"`
4. Verify: `initialize_supabase()` succeeds, `_update_desktop_status` is called

---

## Files Changed

| File | Change Type | Description |
|------|-------------|-------------|
| `python-desktop-app/desktop_app.py` | Modified | All 5 implemented fixes |
| `python-desktop-app/tests/test_desktop_version_update.py` | New (pending) | Unit tests for all 6 fixes |

---

## Rollback Plan

All fixes are additive/defensive with no schema changes or API changes. If a regression is detected:

1. **FIX-1 (sync thread re-init):** Remove the `supabase_reinit_counter` block. No data loss.
2. **FIX-2 (disk cache):** Remove cache read/write in `get_supabase_config()`. The `cached_supabase_*` keys in `auth_metadata.json` are ignored by the original code path and cause no harm.
3. **FIX-3 (migration):** The fixed migration only affects users who still have the old `time_tracker_auth.json` (first migration). No rollback needed once migrated.
4. **FIX-4 (fallback path):** Remove the `if self.supabase_initialized` block in the fallback path. No data loss.
5. **FIX-5 (heartbeat):** Revert heartbeat payload to original two-field version; remove retry block. The only behavior change is writing `desktop_logged_in=True` and retrying — both are safe writes.
6. **FIX-6 (pending):** If the connectivity pre-check causes issues, the fallback path (`if self.offline_manager.check_connectivity(force=False)`) can be removed, restoring the original unconditional early init.
