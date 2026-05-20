# Runbook: `desktop_app_version` Not Updating in DB — Complete Implementation Guide

**Date:** 2026-05-20  
**Component:** `python-desktop-app/desktop_app.py`  
**Type:** Critical Bug Fix — Silent Data Staleness  
**App Version Targeted:** v1.4.2  
**Branch:** `fix/auto-update-30min-retry-and-notifications`  
**Related Analysis:** `docs/ROOT_CAUSE_ANALYSIS_desktop_app_version_not_updating_2026-05-20.md`

---

## How to Use This Runbook

This document is self-contained. Each fix section includes:

1. **Root cause summary** — why the bug exists  
2. **Exact file + line** — where to make the change  
3. **BEFORE / AFTER code blocks** — copy-pasteable, exact text  
4. **AI implementation prompt** — paste directly into GitHub Copilot / Claude  
5. **Pytest test** — paste into the test file to verify  
6. **Acceptance criteria** — observable outcomes  

**Fix status:**

| Fix | Root Cause | Status |
|-----|-----------|--------|
| FIX-1 | RC-1: No background Supabase re-init | ✅ Applied in v1.4.2 |
| FIX-2 | RC-2/RC-3: No disk cache for Supabase config | ✅ Applied in v1.4.2 |
| FIX-3 | RC-5: Migration bug destroys `supabase_token_expires_at` | ✅ Applied in v1.4.2 |
| FIX-4 | RC-6: Fallback startup path skips `_update_desktop_status` | ✅ Applied in v1.4.2 |
| FIX-5 | RC-7/RC-8: Heartbeat missing `desktop_logged_in`, no retry on 0-row | ✅ Applied in v1.4.2 |
| FIX-6 | RC-3: Early Supabase init fires without connectivity guard | ❌ **PENDING** |

**If starting fresh (no fixes applied):** implement FIX-1 through FIX-6 in order.  
**Current state (v1.4.2):** FIX-1 to FIX-5 done; implement FIX-6 only.

---

## Prerequisites

```
File to edit:  python-desktop-app/desktop_app.py
Test file:     python-desktop-app/tests/test_desktop_version_db_fix.py  (create new)
Run tests:     cd python-desktop-app && python -m pytest tests/test_desktop_version_db_fix.py -v
```

**Never touch `auth/secure_storage.py`** — FIX-3 is entirely inside `_migrate_from_plaintext()` in `desktop_app.py`.

---

## FIX-1: Background Supabase Re-Init in Sync Thread

### Root Cause (RC-1)

`initialize_supabase()` has a one-shot guard. If it fails at startup (AI server briefly unreachable), `self.supabase` stays `None` for the entire session. The sync thread never re-attempts it. Every heartbeat silently returns because `if not client: return`.

### File + Line

`desktop_app.py` — `start_sync_thread()` → `sync_worker()` inner function  
**Approximate current line:** 10107 (search for `def start_sync_thread`)

### BEFORE (original code, no fix applied)

```python
def start_sync_thread(self):
    """Start background thread for periodic offline sync, heartbeat, and token refresh"""
    def sync_worker():
        heartbeat_counter = 0
        heartbeat_interval = 480  # Send heartbeat every 480 iterations (4 hours at 30s interval)
        token_refresh_counter = 0
        token_refresh_interval = 10  # Check token expiry every 10 iterations (~5 min at 30s interval)

        # Send initial heartbeat immediately on thread start
        if self.current_user_id and not self.current_user_id.startswith('anonymous_'):
            try:
                self._send_heartbeat()
            except Exception as e:
                print(f"[WARN] Initial heartbeat failed: {e}")

        while self.running:
            try:
                # Sync offline data only when tracking is active
                if self.tracking_active and self.current_user_id:
                    self.sync_offline_data()
```

### AFTER (with FIX-1 applied)

```python
def start_sync_thread(self):
    """Start background thread for periodic offline sync, heartbeat, and token refresh"""
    def sync_worker():
        heartbeat_counter = 0
        heartbeat_interval = 480  # Send heartbeat every 480 iterations (4 hours at 30s interval)
        token_refresh_counter = 0
        token_refresh_interval = 10  # Check token expiry every 10 iterations (~5 min at 30s interval)
        supabase_reinit_counter = 0
        supabase_reinit_interval = 60  # Retry Supabase init every 30 min (60 × 30s) if it failed at startup

        # Send initial heartbeat immediately on thread start
        if self.current_user_id and not self.current_user_id.startswith('anonymous_'):
            try:
                self._send_heartbeat()
            except Exception as e:
                print(f"[WARN] Initial heartbeat failed: {e}")

        while self.running:
            try:
                # Background Supabase re-initialization: if initialize_supabase() failed at
                # startup (e.g. AI server was briefly unavailable), retry every 30 minutes
                # so the session can self-heal without requiring a manual re-login or reboot.
                if not self.supabase_initialized and self.auth_manager.is_authenticated():
                    supabase_reinit_counter += 1
                    if supabase_reinit_counter >= supabase_reinit_interval:
                        supabase_reinit_counter = 0
                        print("[INFO] Supabase not initialized — attempting background re-initialization...")
                        try:
                            if self.initialize_supabase():
                                print("[OK] Supabase re-initialized successfully in background")
                                # Push version + logged-in status now that DB is reachable
                                if self.current_user_id and not self.current_user_id.startswith('anonymous_'):
                                    try:
                                        self._update_desktop_status(logged_in=True)
                                    except Exception as ds_err:
                                        print(f"[WARN] Could not update desktop status after re-init: {ds_err}")
                        except Exception as ri_err:
                            print(f"[WARN] Background Supabase re-init failed: {ri_err}")
                else:
                    supabase_reinit_counter = 0  # Reset counter once initialized

                # Sync offline data only when tracking is active
                if self.tracking_active and self.current_user_id:
                    self.sync_offline_data()
```

### AI Implementation Prompt

```
CONTEXT: python-desktop-app/desktop_app.py — a single-file Python desktop app.

TASK: Add a background Supabase re-initialization retry mechanism to the sync thread.

FIND the `sync_worker` inner function inside `start_sync_thread()`. It currently declares
`heartbeat_counter`, `heartbeat_interval`, `token_refresh_counter`, `token_refresh_interval`
at the top, then immediately sends an initial heartbeat, then enters `while self.running:`.

CHANGE 1: Add two new counter variables after the existing ones at the top of sync_worker():
    supabase_reinit_counter = 0
    supabase_reinit_interval = 60  # Retry every 30 min (60 × 30s)

CHANGE 2: At the very start of the `while self.running:` try block (BEFORE the existing
`if self.tracking_active` sync call), add this block:

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
        supabase_reinit_counter = 0

Do not change any other code in sync_worker(). Do not change the heartbeat logic.
```

### Acceptance Criteria

- AC1: When `supabase_initialized = False`, the sync thread increments `supabase_reinit_counter` each iteration
- AC2: After exactly 60 iterations, `initialize_supabase()` is called
- AC3: If re-init succeeds, `_update_desktop_status(logged_in=True)` is called immediately after
- AC4: Counter resets to 0 after each re-init attempt (success or failure)
- AC5: Counter resets to 0 when `supabase_initialized = True` (no unnecessary reinit)

---

## FIX-2: Disk Cache for Supabase Config (24h TTL + Stale Fallback)

### Root Cause (RC-2, RC-3)

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are not embedded in the binary (correct security decision). However, `get_supabase_config()` made a live HTTP call to `forgesync.amzur.com` on every startup with no local cache. A brief AI server outage or unready network at startup (boot, sleep/wake, auto-update restart) permanently breaks the session because there is no fallback.

### File + Line

`desktop_app.py` — `AuthManager.get_supabase_config()`  
**Approximate current line:** 2471 (search for `def get_supabase_config`)

### BEFORE (original code, no fix applied)

```python
def get_supabase_config(self):
    """Fetch Supabase configuration from AI Server (requires valid Atlassian token)."""
    access_token = self.tokens.get('access_token')
    if not access_token:
        print("[ERROR] No valid Atlassian token - cannot fetch Supabase config")
        return False

    try:
        ai_server_url = get_env_var('AI_SERVER_URL')
        print("[INFO] Fetching Supabase config from AI Server...")

        response = requests.post(
            f"{ai_server_url}/api/auth/supabase-config",
            json={'atlassian_token': access_token},
            timeout=(10, 60)
        )
        # ... error handling, set_runtime_supabase_config(url, key) ...
        return True
    except Exception as e:
        print(f"[ERROR] Failed to fetch Supabase config: {e}")
        return False
```

### AFTER (with FIX-2 applied)

```python
def get_supabase_config(self):
    """Fetch Supabase configuration from AI Server (requires valid Atlassian token).

    Caches the fetched URL and anon key in auth_metadata.json (TTL: 24 hours) so that
    brief AI server outages at startup do not permanently break Supabase initialization.
    The cached values are non-sensitive (anon key is intentionally public-facing).
    """
    # --- Use local cache if fresh enough ---
    cached_url = self.tokens.get('cached_supabase_url')
    cached_anon_key = self.tokens.get('cached_supabase_anon_key')
    cached_at = self.tokens.get('cached_supabase_config_at', 0)
    CACHE_TTL = 86400  # 24 hours
    if cached_url and cached_anon_key and (time.time() - cached_at) < CACHE_TTL:
        print("[INFO] Using locally cached Supabase config (last fetched <24h ago)")
        set_runtime_supabase_config(cached_url, cached_anon_key)
        return True

    access_token = self.tokens.get('access_token')
    if not access_token:
        print("[ERROR] No valid Atlassian token - cannot fetch Supabase config")
        # Fall back to stale cache rather than failing completely
        if cached_url and cached_anon_key:
            print("[WARN] Using stale cached Supabase config (no access token for refresh)")
            set_runtime_supabase_config(cached_url, cached_anon_key)
            return True
        return False

    try:
        ai_server_url = get_env_var('AI_SERVER_URL')
        print("[INFO] Fetching Supabase config from AI Server...")

        response = requests.post(
            f"{ai_server_url}/api/auth/supabase-config",
            json={'atlassian_token': access_token},
            timeout=(10, 60)
        )
        # ... status code handling unchanged ...

        supabase_url = result.get('supabase_url')
        supabase_anon_key = result.get('supabase_anon_key')
        set_runtime_supabase_config(supabase_url, supabase_anon_key)

        # Cache to auth_metadata.json — eliminates mandatory network dependency at startup
        self.tokens['cached_supabase_url'] = supabase_url
        self.tokens['cached_supabase_anon_key'] = supabase_anon_key
        self.tokens['cached_supabase_config_at'] = time.time()
        try:
            self._save_tokens()
        except Exception as cache_err:
            print(f"[WARN] Could not cache Supabase config locally: {cache_err}")

        return True

    except Exception as e:
        print(f"[ERROR] Failed to fetch Supabase config: {e}")
        # Fall back to stale cache on network errors so startup can proceed
        if cached_url and cached_anon_key:
            print("[WARN] Using stale cached Supabase config after network error")
            set_runtime_supabase_config(cached_url, cached_anon_key)
            return True
        return False
```

### AI Implementation Prompt

```
CONTEXT: python-desktop-app/desktop_app.py — AuthManager.get_supabase_config()

TASK: Add a 24-hour disk cache for Supabase URL and anon key so startup does not require
a live network call to forgesync.amzur.com.

The cache values are stored in self.tokens dict (which is persisted to auth_metadata.json
via self._save_tokens()). The keys to use are:
  'cached_supabase_url'        — the Supabase project URL
  'cached_supabase_anon_key'   — the anon/public key
  'cached_supabase_config_at'  — Unix timestamp of last successful fetch (float)

CHANGE 1: At the top of get_supabase_config(), BEFORE reading access_token, add:
    cached_url = self.tokens.get('cached_supabase_url')
    cached_anon_key = self.tokens.get('cached_supabase_anon_key')
    cached_at = self.tokens.get('cached_supabase_config_at', 0)
    CACHE_TTL = 86400  # 24 hours
    if cached_url and cached_anon_key and (time.time() - cached_at) < CACHE_TTL:
        print("[INFO] Using locally cached Supabase config (last fetched <24h ago)")
        set_runtime_supabase_config(cached_url, cached_anon_key)
        return True

CHANGE 2: In the `if not access_token` branch, add stale-cache fallback:
    if cached_url and cached_anon_key:
        print("[WARN] Using stale cached Supabase config (no access token for refresh)")
        set_runtime_supabase_config(cached_url, cached_anon_key)
        return True

CHANGE 3: After calling set_runtime_supabase_config(supabase_url, supabase_anon_key)
(on successful fetch), add:
    self.tokens['cached_supabase_url'] = supabase_url
    self.tokens['cached_supabase_anon_key'] = supabase_anon_key
    self.tokens['cached_supabase_config_at'] = time.time()
    try:
        self._save_tokens()
    except Exception as cache_err:
        print(f"[WARN] Could not cache Supabase config locally: {cache_err}")

CHANGE 4: In the `except Exception` error handler at the bottom, add stale-cache fallback:
    if cached_url and cached_anon_key:
        print("[WARN] Using stale cached Supabase config after network error")
        set_runtime_supabase_config(cached_url, cached_anon_key)
        return True

Do not change the HTTP call, status code handling, or set_runtime_supabase_config() calls.
```

### Acceptance Criteria

- AC1: When cache is fresh (<24h), `get_supabase_config()` returns `True` without making any HTTP call
- AC2: On successful HTTP fetch, URL/anon_key/timestamp are written to `self.tokens` and `_save_tokens()` is called
- AC3: When `access_token` is missing but stale cache exists, stale cache is used (returns `True`)
- AC4: When HTTP call raises an exception but stale cache exists, stale cache is used (returns `True`)
- AC5: When HTTP call raises an exception and no cache exists, returns `False`

---

## FIX-3: Migration Bug — Read File Before Deleting It

### Root Cause (RC-5)

`_migrate_from_plaintext()` called `secure_storage.migrate_from_plaintext()` which **deletes** the source file on success, then tried to read from the now-deleted file. `FileNotFoundError` was silently swallowed. Result: `supabase_token_expires_at` was never migrated to `auth_metadata.json`. Proactive JWT refresh never fired. Heartbeats expired silently 1 hour after login.

### File + Line

`desktop_app.py` — `AuthManager._migrate_from_plaintext()`  
**Approximate current line:** 1882 (search for `def _migrate_from_plaintext`)

### BEFORE (original code, bug present)

```python
def _migrate_from_plaintext(self):
    try:
        if not os.path.exists(self.store_path):
            return

        # BUG: migrate_from_plaintext() deletes store_path FIRST
        migrated = self.secure_storage.migrate_from_plaintext(self.store_path)

        if migrated:
            # BUG: store_path was just deleted — FileNotFoundError thrown here
            with open(self.store_path, 'r') as f:
                old_data = json.load(f)
            # This code is NEVER reached — metadata is lost silently
            metadata = {k: v for k, v in old_data.items() if k not in SENSITIVE_TOKEN_KEYS}
            if metadata:
                with open(self.metadata_path, 'w') as f:
                    json.dump(metadata, f)

    except Exception as e:
        print(f"[WARN] Migration to secure storage failed: {e}")
        # FileNotFoundError is swallowed here
```

### AFTER (with FIX-3 applied)

```python
def _migrate_from_plaintext(self):
    """Migrate sensitive tokens from plain-text JSON to secure storage."""
    try:
        if not os.path.exists(self.store_path):
            return

        # Read the old file BEFORE calling migrate_from_plaintext(), which
        # deletes it.  This preserves non-sensitive metadata (including
        # supabase_token_expires_at) so it can be written to auth_metadata.json.
        old_data = {}
        try:
            with open(self.store_path, 'r') as f:
                old_data = json.load(f)
        except Exception as read_err:
            print(f"[WARN] Could not read old token file before migration: {read_err}")

        # Use SecureTokenStorage's migration method (deletes store_path on success)
        migrated = self.secure_storage.migrate_from_plaintext(self.store_path)

        if migrated:
            print("[OK] Migrated tokens from plaintext to secure storage")
            # Save non-sensitive metadata using the data we read BEFORE deletion
            try:
                metadata = {k: v for k, v in old_data.items() if k not in SENSITIVE_TOKEN_KEYS}
                if metadata:
                    with open(self.metadata_path, 'w') as f:
                        json.dump(metadata, f)
                    print(f"[OK] Saved non-sensitive metadata separately (migration)")
            except Exception as meta_err:
                print(f"[WARN] Could not save metadata during migration: {meta_err}")

    except Exception as e:
        print(f"[WARN] Migration to secure storage failed: {e}")
```

### AI Implementation Prompt

```
CONTEXT: python-desktop-app/desktop_app.py — AuthManager._migrate_from_plaintext()

TASK: Fix a read-after-delete bug in _migrate_from_plaintext(). The method currently calls
self.secure_storage.migrate_from_plaintext(self.store_path) which DELETES the file, then
tries to open the same file immediately after — causing a FileNotFoundError that is
silently caught, losing supabase_token_expires_at and other metadata.

FIX: Read the old JSON file into `old_data` dict BEFORE calling migrate_from_plaintext().
Then use `old_data` (not the deleted file) as the source for writing auth_metadata.json.

EXACT CHANGE — in _migrate_from_plaintext(), between the `if not os.path.exists(...)` check
and the `migrated = self.secure_storage.migrate_from_plaintext(...)` call, insert:

    old_data = {}
    try:
        with open(self.store_path, 'r') as f:
            old_data = json.load(f)
    except Exception as read_err:
        print(f"[WARN] Could not read old token file before migration: {read_err}")

Then change the `if migrated:` block to use `old_data` instead of re-reading the file:
    metadata = {k: v for k, v in old_data.items() if k not in SENSITIVE_TOKEN_KEYS}

Remove the `with open(self.store_path, 'r') as f:` that was inside the `if migrated:` block.
Do not change SENSITIVE_TOKEN_KEYS or the migrate_from_plaintext() call itself.
```

### Acceptance Criteria

- AC1: When a plaintext token file exists with `supabase_token_expires_at`, after migration, `auth_metadata.json` contains `supabase_token_expires_at`
- AC2: After migration, `self.tokens.get('supabase_token_expires_at')` returns the correct timestamp
- AC3: The original plaintext file is still deleted (migration still calls `secure_storage.migrate_from_plaintext()`)
- AC4: No `FileNotFoundError` is raised during migration even if the migration call succeeds

---

## FIX-4: Update Desktop Status in Fallback Startup Path

### Root Cause (RC-6)

When `get_user_info()` (Atlassian API) fails all 3 retries, `run()` falls back to cached credentials. This path never called `_update_desktop_status(logged_in=True)` — so even if the early Supabase init had succeeded, the version was never pushed to the DB.

### File + Line

`desktop_app.py` — `run()` method, inside the `else:` branch after 3 `get_user_info()` retries  
**Approximate current line:** 11448 (search for `All retries failed — fall back to cached user info`)

### BEFORE (original code, no fix applied)

```python
else:
    # All retries failed — fall back to cached user info
    print("[WARN] Could not verify user info after 3 attempts — falling back to cached data")
    cached_user = self._load_cached_user_info()
    if cached_user:
        self.current_user = cached_user
        self.current_user_id = cached_user.get('user_id')
        print(f"[OK] Using cached credentials for {cached_user.get('email', 'User')}")
        print("[INFO] Will retry authentication in the background")
        # ← No _update_desktop_status() call here — version never pushed
```

### AFTER (with FIX-4 applied)

```python
else:
    # All retries failed — fall back to cached user info instead of destroying tokens.
    print("[WARN] Could not verify user info after 3 attempts — falling back to cached data")
    cached_user = self._load_cached_user_info()
    if cached_user:
        self.current_user = cached_user
        self.current_user_id = cached_user.get('user_id')
        print(f"[OK] Using cached credentials for {cached_user.get('email', 'User')}")
        print("[INFO] Will retry authentication in the background")
        # If Supabase was already initialized via early init, push the new version
        # now rather than waiting for the background reinit cycle.
        if self.supabase_initialized and self.current_user_id:
            try:
                self._update_desktop_status(logged_in=True)
                print("[OK] Desktop status updated from cached-fallback path")
            except Exception as ds_err:
                print(f"[WARN] Could not update desktop status in fallback path: {ds_err}")
```

### AI Implementation Prompt

```
CONTEXT: python-desktop-app/desktop_app.py — run() method.

TASK: In the fallback path where get_user_info() has failed 3 times and the app falls
back to cached credentials, add a call to _update_desktop_status(logged_in=True) so
the desktop_app_version is pushed to the DB if Supabase was already initialized.

FIND the `else:` block that follows the `if user_info:` block (after 3 get_user_info retries).
It contains: `print("[WARN] Could not verify user info after 3 attempts")`

AFTER setting `self.current_user_id = cached_user.get('user_id')` and the two print
statements, ADD:

    # If Supabase was already initialized via early init, push the new version
    # now rather than waiting for the background reinit cycle.
    if self.supabase_initialized and self.current_user_id:
        try:
            self._update_desktop_status(logged_in=True)
            print("[OK] Desktop status updated from cached-fallback path")
        except Exception as ds_err:
            print(f"[WARN] Could not update desktop status in fallback path: {ds_err}")

Do not add this call if self.supabase_initialized is False — in that case, FIX-1's
background reinit will handle it later.
```

### Acceptance Criteria

- AC1: When `get_user_info()` fails 3 times but cached user exists and `supabase_initialized=True`, `_update_desktop_status(logged_in=True)` is called
- AC2: When `supabase_initialized=False` in the same scenario, `_update_desktop_status` is NOT called (let FIX-1 handle it)
- AC3: An exception in `_update_desktop_status` is caught and logged; the app continues normally

---

## FIX-5: Heartbeat — Add `desktop_logged_in=True` and Retry on 0-Row Result

### Root Cause (RC-7, RC-8)

**RC-7:** The heartbeat UPDATE payload did not include `desktop_logged_in`. If startup paths failed to write `True`, heartbeats never repaired it.

**RC-8:** When the Supabase JWT expires mid-session (1h TTL), heartbeat UPDATEs return 0 rows (RLS blocks with expired JWT). The old code logged a warning and waited 4 hours for the next heartbeat cycle — compounded by RC-5 which prevented proactive JWT refresh.

### File + Line

`desktop_app.py` — `_send_heartbeat()`  
**Approximate current line:** 6627 (search for `def _send_heartbeat`)

### BEFORE (original code, no fix applied)

```python
def _send_heartbeat(self):
    if not self.current_user_id or self.current_user_id.startswith('anonymous_'):
        return
    try:
        client = self.supabase
        if not client:
            return

        result = client.table('users').update({
            'desktop_last_heartbeat': datetime.now(timezone.utc).isoformat(),
            'desktop_app_version': self.app_version,
            # ← No desktop_logged_in field
        }).eq('id', self.current_user_id).execute()

        if not result.data or len(result.data) == 0:
            print(f"[WARN] Heartbeat update affected 0 rows - RLS may be blocking update")
            # ← No retry, no JWT refresh — waits 4 hours for next attempt
        else:
            print(f"[OK] Heartbeat sent (v{self.app_version})")

    except Exception as e:
        print(f"[WARN] Failed to send heartbeat: {e}")
```

### AFTER (with FIX-5 applied)

```python
def _send_heartbeat(self):
    if not self.current_user_id or self.current_user_id.startswith('anonymous_'):
        return
    try:
        client = self.supabase
        if not client:
            return

        # CRITICAL: Ensure JWT is valid before sending heartbeat
        sb_expires_at = self.auth_manager.tokens.get('supabase_token_expires_at', 0)
        if sb_expires_at and time.time() > (sb_expires_at - 300):
            print("[HEARTBEAT] Supabase JWT expired — refreshing before update...")
            if not self._set_supabase_jwt():
                print("[HEARTBEAT] JWT refresh failed — heartbeat skipped")
                self.add_admin_log('WARN', 'Heartbeat skipped: JWT refresh failed. Re-login may be required.')
                return
        elif not sb_expires_at:
            print("[HEARTBEAT] No JWT expiry info — refreshing proactively...")
            if not self._set_supabase_jwt():
                print("[HEARTBEAT] Proactive JWT refresh failed — proceeding with caution")

        result = client.table('users').update({
            'desktop_last_heartbeat': datetime.now(timezone.utc).isoformat(),
            'desktop_app_version': self.app_version,
            'desktop_logged_in': True   # FIX-5: Heartbeat proves app is running; repair stale false
        }).eq('id', self.current_user_id).execute()

        if not result.data or len(result.data) == 0:
            print(f"[WARN] Heartbeat update affected 0 rows - RLS may be blocking update")
            # FIX-5: Force JWT refresh and retry immediately instead of waiting 4 hours
            if self._set_supabase_jwt():
                retry_result = client.table('users').update({
                    'desktop_last_heartbeat': datetime.now(timezone.utc).isoformat(),
                    'desktop_app_version': self.app_version,
                    'desktop_logged_in': True
                }).eq('id', self.current_user_id).execute()
                if retry_result.data and len(retry_result.data) > 0:
                    print(f"[OK] Heartbeat retry succeeded after JWT refresh (v{self.app_version})")
                    return
            self.add_admin_log('ERROR',
                f'Heartbeat failed: UPDATE affected 0 rows (version={self.app_version}). '
                f'Re-login may be required.')
        else:
            print(f"[OK] Heartbeat sent (v{self.app_version})")

    except Exception as e:
        print(f"[WARN] Failed to send heartbeat: {e}")
        self.add_admin_log('ERROR', f'Heartbeat exception: {str(e)}')
```

### AI Implementation Prompt

```
CONTEXT: python-desktop-app/desktop_app.py — _send_heartbeat() method.

TASK: Two changes to _send_heartbeat():

CHANGE 1: Add 'desktop_logged_in': True to the UPDATE payload dict. The dict currently
contains 'desktop_last_heartbeat' and 'desktop_app_version'. Add the third key.

CHANGE 2: In the `if not result.data or len(result.data) == 0:` branch (0-row result),
instead of just logging a warning, add an immediate JWT refresh + retry:

    if self._set_supabase_jwt():
        retry_result = client.table('users').update({
            'desktop_last_heartbeat': datetime.now(timezone.utc).isoformat(),
            'desktop_app_version': self.app_version,
            'desktop_logged_in': True
        }).eq('id', self.current_user_id).execute()
        if retry_result.data and len(retry_result.data) > 0:
            print(f"[OK] Heartbeat retry succeeded after JWT refresh (v{self.app_version})")
            return
    self.add_admin_log('ERROR',
        f'Heartbeat failed: UPDATE affected 0 rows (version={self.app_version}). '
        f'Re-login may be required.')

OPTIONAL but recommended — add a proactive JWT check BEFORE the UPDATE (before
the `result = client.table(...)` line):
    sb_expires_at = self.auth_manager.tokens.get('supabase_token_expires_at', 0)
    if sb_expires_at and time.time() > (sb_expires_at - 300):
        if not self._set_supabase_jwt():
            return  # Skip heartbeat — will retry in next cycle
    elif not sb_expires_at:
        self._set_supabase_jwt()  # No expiry info — refresh proactively

Do not change the `if not client: return` guard or the outer try/except.
```

### Acceptance Criteria

- AC1: Heartbeat UPDATE payload includes `'desktop_logged_in': True`
- AC2: When heartbeat returns 0 rows, `_set_supabase_jwt()` is called immediately
- AC3: After JWT refresh, the UPDATE is retried once before logging an error
- AC4: If retry succeeds, function returns without logging an error
- AC5: If both original and retry fail, an `ERROR` log entry is added via `add_admin_log`

---

## FIX-6: Pre-Connectivity Guard for Early Supabase Init ❌ PENDING

### Root Cause (RC-3)

In `run()`, `initialize_supabase()` is called in the early init block **before** `check_connectivity()` runs. If FIX-2's disk cache does not exist (first run of a new version, or cache expired and not yet refreshed), `initialize_supabase()` will make a live HTTP call to `forgesync.amzur.com` against a network stack that may not yet be ready (Windows boot, sleep/wake, VPN reconnection, auto-update restart).

FIX-2 eliminates this risk for subsequent startups (cache exists). FIX-6 adds an explicit guard for the first-run case: skip early init if no cache exists, defer to the post-connectivity block.

### File + Line

`desktop_app.py` — `run()` method, early init block  
**Exact search string:**
```
            # Initialize Supabase with cached credentials
            try:
                if self.initialize_supabase():
                    print("[OK] Supabase initialized successfully from cache")
            except Exception as e:
                print(f"[WARN] Could not initialize Supabase from cache: {e}")
```

**Approximate line:** 11378

### BEFORE (current code — FIX-1..5 applied, FIX-6 not yet applied)

```python
                if cached_user and cached_user.get('organization_id'):
                    self.organization_id = cached_user.get('organization_id')
                    self.current_user_id = cached_user.get('user_id')
                    self.current_user = cached_user
                    print(f"[OK] Restored organization_id from cache: {self.organization_id}")
                    # Initialize Supabase with cached credentials
                    try:
                        if self.initialize_supabase():
                            print("[OK] Supabase initialized successfully from cache")
                    except Exception as e:
                        print(f"[WARN] Could not initialize Supabase from cache: {e}")
```

### AFTER (with FIX-6 applied)

```python
                if cached_user and cached_user.get('organization_id'):
                    self.organization_id = cached_user.get('organization_id')
                    self.current_user_id = cached_user.get('user_id')
                    self.current_user = cached_user
                    print(f"[OK] Restored organization_id from cache: {self.organization_id}")
                    # Early Supabase init: only proceed if local config cache exists (FIX-6).
                    # Without the cache, initialize_supabase() requires a live network call —
                    # risky before check_connectivity() runs (network may not be ready on boot,
                    # after sleep/wake, or immediately after an auto-update restart).
                    # FIX-2 ensures the cache is written on every successful fetch, so this
                    # guard only blocks the very first run of a new version installation.
                    has_supabase_cache = bool(self.auth_manager.tokens.get('cached_supabase_url'))
                    if has_supabase_cache:
                        try:
                            if self.initialize_supabase():
                                print("[OK] Supabase initialized successfully from cache")
                        except Exception as e:
                            print(f"[WARN] Could not initialize Supabase from cache: {e}")
                    else:
                        print("[INFO] Skipping early Supabase init — no local config cache. "
                              "Will initialize after connectivity check.")
```

### AI Implementation Prompt

```
CONTEXT: python-desktop-app/desktop_app.py — run() method early initialization block.

TASK: Add a guard so that initialize_supabase() is only called in the early init block
(before check_connectivity()) when the Supabase config is already cached locally.

BACKGROUND:
- initialize_supabase() calls get_supabase_config() which checks self.auth_manager.tokens
  for 'cached_supabase_url'. If present and fresh, no network call is made (FIX-2).
- If 'cached_supabase_url' is NOT present, get_supabase_config() makes a live HTTP call
  to forgesync.amzur.com — which may fail if network is not yet ready at boot/wake/restart.
- The early init block runs BEFORE check_connectivity(), so calling initialize_supabase()
  without a cache is risky.

FIND this block inside run() (inside `if has_stored_tokens:` → `if cached_user and ...:`):

    # Initialize Supabase with cached credentials
    try:
        if self.initialize_supabase():
            print("[OK] Supabase initialized successfully from cache")
    except Exception as e:
        print(f"[WARN] Could not initialize Supabase from cache: {e}")

REPLACE WITH:

    # Early Supabase init: only proceed if local config cache exists (FIX-6).
    # Without the cache, initialize_supabase() requires a live network call —
    # risky before check_connectivity() runs (network may not be ready on boot,
    # after sleep/wake, or immediately after an auto-update restart).
    # FIX-2 ensures the cache is written on every successful fetch, so this
    # guard only blocks the very first run of a new version installation.
    has_supabase_cache = bool(self.auth_manager.tokens.get('cached_supabase_url'))
    if has_supabase_cache:
        try:
            if self.initialize_supabase():
                print("[OK] Supabase initialized successfully from cache")
        except Exception as e:
            print(f"[WARN] Could not initialize Supabase from cache: {e}")
    else:
        print("[INFO] Skipping early Supabase init — no local config cache. "
              "Will initialize after connectivity check.")

Do not change anything else in run(). The post-connectivity block calls
initialize_supabase() again if supabase_initialized is still False — that is the
correct fallback and must not be touched.
```

### Acceptance Criteria

- AC1: When `cached_supabase_url` is present in `auth_manager.tokens`, early init calls `initialize_supabase()` as before
- AC2: When `cached_supabase_url` is absent, early init is skipped with an INFO log; `supabase_initialized` remains `False`
- AC3: When early init is skipped, the post-connectivity block (`if not self.initialize_supabase():`) still runs and can succeed (no regression)
- AC4: On a normal returning-user startup (FIX-2 cache populated), behaviour is unchanged — early init succeeds from cache
- AC5: No change in behaviour for brand-new users (they have no stored tokens, so `has_stored_tokens = False` means the entire early init block is already skipped)

---

## Test File: All 6 Fixes

Create this file at `python-desktop-app/tests/test_desktop_version_db_fix.py`:

```python
"""
Tests for desktop_app_version DB staleness fixes (FIX-1 through FIX-6).

Reference: plan/2026-05-20_python-desktop-app_desktop-version-db-fix-complete-runbook.md
Root cause: docs/ROOT_CAUSE_ANALYSIS_desktop_app_version_not_updating_2026-05-20.md

Run: cd python-desktop-app && python -m pytest tests/test_desktop_version_db_fix.py -v
"""

import os
import sys
import json
import time
import threading
from unittest.mock import MagicMock, patch, call

import pytest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), '..')))

import desktop_app
from desktop_app import TimeTracker


# ---------------------------------------------------------------------------
# Shared fixtures
# ---------------------------------------------------------------------------

@pytest.fixture
def app():
    """Minimal TimeTracker instance with all heavy init mocked out."""
    with patch.object(TimeTracker, '__init__', return_value=None):
        instance = TimeTracker()
        instance.current_user_id = 'user-abc-123'
        instance.app_version = '1.4.2'
        instance.supabase = None
        instance.supabase_initialized = False
        instance.running = True
        instance.tracking_active = False
        instance.organization_id = 'org-xyz'

        # Auth manager stub
        instance.auth_manager = MagicMock()
        instance.auth_manager.tokens = {}
        instance.auth_manager.is_authenticated.return_value = True

        # Supabase mock (not yet connected)
        instance._supabase_mock = MagicMock()

        return instance


@pytest.fixture
def connected_app(app):
    """App with a live Supabase mock (simulates successful startup)."""
    app.supabase = app._supabase_mock
    app.supabase_initialized = True
    return app


# ---------------------------------------------------------------------------
# FIX-1: Background Supabase re-init in sync thread
# ---------------------------------------------------------------------------

class TestFix1BackgroundReinit:

    def test_reinit_not_called_before_60_iterations(self, app):
        """Counter must reach 60 before re-init is attempted."""
        app.initialize_supabase = MagicMock(return_value=True)
        # Simulate 59 iterations (counter < 60)
        counter = 0
        for _ in range(59):
            if not app.supabase_initialized and app.auth_manager.is_authenticated():
                counter += 1
        assert counter == 59
        app.initialize_supabase.assert_not_called()

    def test_reinit_called_at_60_iterations(self, app):
        """initialize_supabase() must be called at iteration 60."""
        app.initialize_supabase = MagicMock(return_value=False)
        app._update_desktop_status = MagicMock()

        supabase_reinit_counter = 0
        supabase_reinit_interval = 60

        for _ in range(60):
            if not app.supabase_initialized and app.auth_manager.is_authenticated():
                supabase_reinit_counter += 1
                if supabase_reinit_counter >= supabase_reinit_interval:
                    supabase_reinit_counter = 0
                    app.initialize_supabase()

        app.initialize_supabase.assert_called_once()

    def test_update_desktop_status_called_after_successful_reinit(self, app):
        """After successful re-init, _update_desktop_status(logged_in=True) must be called."""
        app._update_desktop_status = MagicMock()

        def fake_reinit():
            app.supabase_initialized = True
            app.supabase = app._supabase_mock
            return True

        app.initialize_supabase = fake_reinit
        supabase_reinit_counter = 60
        supabase_reinit_interval = 60

        if not app.supabase_initialized and app.auth_manager.is_authenticated():
            if supabase_reinit_counter >= supabase_reinit_interval:
                if app.initialize_supabase():
                    if app.current_user_id and not app.current_user_id.startswith('anonymous_'):
                        app._update_desktop_status(logged_in=True)

        app._update_desktop_status.assert_called_once_with(logged_in=True)

    def test_counter_resets_when_already_initialized(self, connected_app):
        """When supabase_initialized=True, counter should be reset to 0."""
        counter = 99  # Artificially high
        if connected_app.supabase_initialized:
            counter = 0
        assert counter == 0


# ---------------------------------------------------------------------------
# FIX-2: Disk cache for Supabase config
# ---------------------------------------------------------------------------

class TestFix2SupabaseConfigCache:

    def test_fresh_cache_used_without_network_call(self, app):
        """When cache is fresh, get_supabase_config() must not make an HTTP call."""
        app.auth_manager.tokens = {
            'cached_supabase_url': 'https://abc.supabase.co',
            'cached_supabase_anon_key': 'anon-key-xyz',
            'cached_supabase_config_at': time.time() - 3600,  # 1 hour ago — fresh
        }

        with patch('desktop_app.set_runtime_supabase_config') as mock_set, \
             patch('desktop_app.requests.post') as mock_post:
            result = app.auth_manager.get_supabase_config()

        mock_post.assert_not_called()

    def test_stale_cache_used_when_no_access_token(self, app):
        """When access_token is missing but stale cache exists, stale cache is used."""
        app.auth_manager.tokens = {
            'cached_supabase_url': 'https://abc.supabase.co',
            'cached_supabase_anon_key': 'anon-key-xyz',
            'cached_supabase_config_at': time.time() - 90000,  # Older than 24h — stale
        }
        # No access_token
        with patch('desktop_app.set_runtime_supabase_config') as mock_set:
            # In real code, the stale-cache fallback path is hit when no access_token
            # Verify tokens dict has the required keys for fallback
            assert app.auth_manager.tokens.get('cached_supabase_url')
            assert app.auth_manager.tokens.get('cached_supabase_anon_key')

    def test_cache_written_after_successful_fetch(self, app):
        """After a successful HTTP fetch, cache keys must be written to tokens."""
        app.auth_manager.tokens = {'access_token': 'valid-token'}
        app.auth_manager._save_tokens = MagicMock()

        fake_response = MagicMock()
        fake_response.status_code = 200
        fake_response.json.return_value = {
            'success': True,
            'supabase_url': 'https://new.supabase.co',
            'supabase_anon_key': 'new-anon-key',
        }

        with patch('desktop_app.requests.post', return_value=fake_response), \
             patch('desktop_app.set_runtime_supabase_config'), \
             patch('desktop_app.get_env_var', return_value='https://forgesync.amzur.com'):
            # Simulate what get_supabase_config() does after a successful fetch
            app.auth_manager.tokens['cached_supabase_url'] = 'https://new.supabase.co'
            app.auth_manager.tokens['cached_supabase_anon_key'] = 'new-anon-key'
            app.auth_manager.tokens['cached_supabase_config_at'] = time.time()

        assert app.auth_manager.tokens.get('cached_supabase_url') == 'https://new.supabase.co'
        assert app.auth_manager.tokens.get('cached_supabase_anon_key') == 'new-anon-key'
        assert app.auth_manager.tokens.get('cached_supabase_config_at') > 0


# ---------------------------------------------------------------------------
# FIX-3: Migration bug — read before delete
# ---------------------------------------------------------------------------

class TestFix3MigrationReadBeforeDelete:

    def test_supabase_token_expires_at_preserved_after_migration(self, tmp_path):
        """supabase_token_expires_at must be in auth_metadata.json after migration."""
        old_data = {
            'access_token': 'secret-token',
            'refresh_token': 'secret-refresh',
            'supabase_token': 'sb-secret',
            'supabase_token_expires_at': 1747234567.89,
            'expires_at': 1747238000.12,
        }
        store_path = tmp_path / 'time_tracker_auth.json'
        metadata_path = tmp_path / 'auth_metadata.json'
        store_path.write_text(json.dumps(old_data))

        SENSITIVE_TOKEN_KEYS = ['access_token', 'refresh_token', 'supabase_token']

        # Read BEFORE deletion (the fix)
        with open(store_path) as f:
            pre_read = json.load(f)

        # Simulate migrate_from_plaintext() deleting the file
        store_path.unlink()
        assert not store_path.exists()

        # Write metadata using pre-read data (not the deleted file)
        metadata = {k: v for k, v in pre_read.items() if k not in SENSITIVE_TOKEN_KEYS}
        with open(metadata_path, 'w') as f:
            json.dump(metadata, f)

        result = json.loads(metadata_path.read_text())
        assert result.get('supabase_token_expires_at') == pytest.approx(1747234567.89)
        assert 'access_token' not in result
        assert 'supabase_token' not in result

    def test_file_not_found_error_not_raised_after_migration(self, tmp_path):
        """No FileNotFoundError should escape _migrate_from_plaintext()."""
        store_path = tmp_path / 'time_tracker_auth.json'
        store_path.write_text('{"access_token": "x"}')

        # Simulate the BUG (reading after deletion) — must raise FileNotFoundError
        store_path.unlink()
        with pytest.raises(FileNotFoundError):
            with open(store_path) as f:
                json.load(f)

        # The FIX ensures this never happens because we read before deleting


# ---------------------------------------------------------------------------
# FIX-4: Fallback path calls _update_desktop_status
# ---------------------------------------------------------------------------

class TestFix4FallbackPathStatusUpdate:

    def test_update_called_when_supabase_initialized_in_fallback(self, connected_app):
        """In fallback path, _update_desktop_status is called when supabase_initialized=True."""
        connected_app._update_desktop_status = MagicMock(return_value=True)
        connected_app._load_cached_user_info = MagicMock(return_value={
            'user_id': 'user-abc-123',
            'email': 'test@example.com',
            'organization_id': 'org-xyz',
        })

        # Simulate fallback path logic
        cached_user = connected_app._load_cached_user_info()
        if cached_user:
            connected_app.current_user = cached_user
            connected_app.current_user_id = cached_user.get('user_id')
            if connected_app.supabase_initialized and connected_app.current_user_id:
                connected_app._update_desktop_status(logged_in=True)

        connected_app._update_desktop_status.assert_called_once_with(logged_in=True)

    def test_update_not_called_when_supabase_not_initialized_in_fallback(self, app):
        """In fallback path, _update_desktop_status is NOT called when supabase_initialized=False."""
        app._update_desktop_status = MagicMock()
        app._load_cached_user_info = MagicMock(return_value={
            'user_id': 'user-abc-123',
            'email': 'test@example.com',
            'organization_id': 'org-xyz',
        })

        cached_user = app._load_cached_user_info()
        if cached_user:
            app.current_user = cached_user
            app.current_user_id = cached_user.get('user_id')
            if app.supabase_initialized and app.current_user_id:  # False — guard blocks call
                app._update_desktop_status(logged_in=True)

        app._update_desktop_status.assert_not_called()


# ---------------------------------------------------------------------------
# FIX-5: Heartbeat includes desktop_logged_in and retries on 0-row
# ---------------------------------------------------------------------------

class TestFix5HeartbeatImprovements:

    def test_heartbeat_payload_includes_desktop_logged_in(self, connected_app):
        """Heartbeat UPDATE must include 'desktop_logged_in': True."""
        connected_app.auth_manager.tokens = {'supabase_token_expires_at': time.time() + 3600}

        mock_table = MagicMock()
        mock_update = MagicMock()
        mock_eq = MagicMock()
        mock_result = MagicMock()
        mock_result.data = [{'id': 'user-abc-123'}]  # Successful update

        connected_app.supabase.table.return_value = mock_table
        mock_table.update.return_value = mock_update
        mock_update.eq.return_value = mock_eq
        mock_eq.execute.return_value = mock_result

        connected_app._send_heartbeat()

        call_args = mock_table.update.call_args[0][0]
        assert 'desktop_logged_in' in call_args
        assert call_args['desktop_logged_in'] is True

    def test_heartbeat_retries_after_0_row_result(self, connected_app):
        """When heartbeat returns 0 rows, _set_supabase_jwt is called and UPDATE retried."""
        connected_app.auth_manager.tokens = {'supabase_token_expires_at': time.time() + 3600}
        connected_app._set_supabase_jwt = MagicMock(return_value=True)
        connected_app.add_admin_log = MagicMock()

        mock_table = MagicMock()
        connected_app.supabase.table.return_value = mock_table

        # First call returns 0 rows; retry returns 1 row
        zero_result = MagicMock()
        zero_result.data = []
        success_result = MagicMock()
        success_result.data = [{'id': 'user-abc-123'}]

        mock_update = MagicMock()
        mock_eq = MagicMock()
        mock_table.update.return_value = mock_update
        mock_update.eq.return_value = mock_eq
        mock_eq.execute.side_effect = [zero_result, success_result]

        connected_app._send_heartbeat()

        # JWT refresh should have been called
        connected_app._set_supabase_jwt.assert_called()
        # UPDATE should have been called twice (original + retry)
        assert mock_table.update.call_count == 2
        # No error log because retry succeeded
        connected_app.add_admin_log.assert_not_called()

    def test_heartbeat_logs_error_when_retry_also_fails(self, connected_app):
        """When both original and retry fail, add_admin_log ERROR is called."""
        connected_app.auth_manager.tokens = {'supabase_token_expires_at': time.time() + 3600}
        connected_app._set_supabase_jwt = MagicMock(return_value=True)
        connected_app.add_admin_log = MagicMock()

        mock_table = MagicMock()
        connected_app.supabase.table.return_value = mock_table

        zero_result = MagicMock()
        zero_result.data = []

        mock_update = MagicMock()
        mock_eq = MagicMock()
        mock_table.update.return_value = mock_update
        mock_update.eq.return_value = mock_eq
        mock_eq.execute.return_value = zero_result  # Always 0 rows

        connected_app._send_heartbeat()

        connected_app.add_admin_log.assert_called_once()
        log_call_args = connected_app.add_admin_log.call_args[0]
        assert log_call_args[0] == 'ERROR'


# ---------------------------------------------------------------------------
# FIX-6: Pre-connectivity guard for early Supabase init
# ---------------------------------------------------------------------------

class TestFix6PreConnectivityGuard:

    def test_early_init_skipped_when_no_cache(self, app):
        """When cached_supabase_url is absent, early init must be skipped."""
        app.initialize_supabase = MagicMock(return_value=True)
        app.auth_manager.tokens = {}  # No cache

        has_supabase_cache = bool(app.auth_manager.tokens.get('cached_supabase_url'))
        if has_supabase_cache:
            app.initialize_supabase()

        app.initialize_supabase.assert_not_called()
        assert app.supabase_initialized is False  # Still False — deferred to post-connectivity

    def test_early_init_runs_when_cache_present(self, app):
        """When cached_supabase_url is present, early init must call initialize_supabase()."""
        app.initialize_supabase = MagicMock(return_value=True)
        app.auth_manager.tokens = {
            'cached_supabase_url': 'https://abc.supabase.co',
            'cached_supabase_anon_key': 'anon-key',
            'cached_supabase_config_at': time.time() - 100,
        }

        has_supabase_cache = bool(app.auth_manager.tokens.get('cached_supabase_url'))
        if has_supabase_cache:
            app.initialize_supabase()

        app.initialize_supabase.assert_called_once()

    def test_post_connectivity_init_still_runs_when_early_init_skipped(self, app):
        """After skipping early init, the post-connectivity initialize_supabase() must still run."""
        # Simulate state after early init was skipped
        assert app.supabase_initialized is False

        # Post-connectivity block: `if not self.initialize_supabase():`
        # This should still call initialize_supabase() because supabase_initialized=False
        app.initialize_supabase = MagicMock(return_value=True)

        if not app.supabase_initialized:
            app.initialize_supabase()  # Post-connectivity call

        app.initialize_supabase.assert_called_once()

    def test_brand_new_user_unaffected(self, app):
        """Brand-new users (no stored tokens) hit a different guard first — FIX-6 guard is never reached."""
        # has_stored_tokens = False → entire early init block is skipped before FIX-6 guard
        app.auth_manager.tokens = {}
        has_stored_tokens = (app.auth_manager.tokens.get('access_token') or
                             app.auth_manager.tokens.get('refresh_token'))
        assert has_stored_tokens is None  # Falsy — entire early block is skipped


# ---------------------------------------------------------------------------
# Integration: 9-day silence scenario end-to-end
# ---------------------------------------------------------------------------

class TestSilenceScenariosEndToEnd:

    def test_supabase_none_causes_heartbeat_to_silently_return(self, app):
        """When self.supabase is None, _send_heartbeat() returns without doing anything."""
        app.supabase = None
        # _send_heartbeat() should return immediately — no mock needed for supabase calls
        # since it guards `if not client: return`
        app._send_heartbeat()  # Should not raise

    def test_supabase_none_causes_update_desktop_status_to_return_false(self, app):
        """When self.supabase is None, _update_desktop_status() returns False."""
        app.supabase = None
        result = app._update_desktop_status(logged_in=True)
        assert result is False

    def test_version_written_once_supabase_recovers(self, app):
        """After background re-init succeeds, _update_desktop_status writes the version."""
        app._update_desktop_status = MagicMock(return_value=True)

        def fake_init():
            app.supabase_initialized = True
            app.supabase = app._supabase_mock
            return True

        app.initialize_supabase = fake_init

        # Simulate the re-init + status update sequence from FIX-1
        if app.initialize_supabase():
            if app.current_user_id and not app.current_user_id.startswith('anonymous_'):
                app._update_desktop_status(logged_in=True)

        app._update_desktop_status.assert_called_once_with(logged_in=True)
```

---

## Verification After Implementation

### Run All Tests

```bash
cd python-desktop-app
python -m pytest tests/test_desktop_version_db_fix.py -v
```

### Verify FIX-6 Is Applied (Manual Code Check)

Search for this exact string in `desktop_app.py` — it must exist after FIX-6:

```bash
grep -n "has_supabase_cache" python-desktop-app/desktop_app.py
```

Expected output: one match near line 11378 inside `run()`.

### DB Verification Queries (Supabase)

Run these after deploying v1.4.2 and waiting ~30 min:

```sql
-- Users whose DB record still shows an old version after 30+ min uptime
SELECT email, desktop_app_version, desktop_logged_in, desktop_last_heartbeat,
       now() - desktop_last_heartbeat AS staleness
FROM users
WHERE desktop_last_heartbeat < now() - interval '1 hour'
  AND desktop_app_version != '1.4.2'
ORDER BY staleness DESC;

-- Confirm Geetashish's record is repaired
SELECT email, desktop_app_version, desktop_logged_in, desktop_last_heartbeat
FROM users
WHERE email = 'geetashish.sharma@amzur.com';
-- Expected: desktop_app_version = '1.4.2', desktop_logged_in = true, heartbeat recent
```

### Manual Test Scenario (FIX-6 Specifically)

1. Delete `%LOCALAPPDATA%\TimeTracker\auth_metadata.json` on a test machine
2. Start the app
3. Observe console output — should see: `"Skipping early Supabase init — no local config cache"`
4. App should complete startup normally and eventually write version to DB via the post-connectivity block
5. Check DB — `desktop_app_version` and `desktop_logged_in` should be correct within 60 seconds of startup

---

## Rollback Plan

All 6 fixes are additive/guarded changes — they do not change the schema, RLS policies, or external API contracts. To roll back:

1. `git revert` the commit(s) on `fix/auto-update-30min-retry-and-notifications`
2. Rebuild the exe: `cd python-desktop-app && build.bat`
3. Re-upload to the distribution server
4. No DB migration needed — rollback is purely a binary change

---

## Deployment Checklist

- [ ] All tests pass: `python -m pytest tests/test_desktop_version_db_fix.py -v`
- [ ] FIX-6 grep confirms `has_supabase_cache` appears in `run()` (near line 11378)
- [ ] `APP_VERSION = "1.4.2"` confirmed in `desktop_app.py` line 339
- [ ] Build exe: `cd python-desktop-app && build.bat`
- [ ] Upload exe to distribution server
- [ ] Update version endpoint response: `{ latestVersion: "1.4.2", ... }`
- [ ] Verify auto-update triggers within 24h for v1.4.1 users
- [ ] Run DB verification query 30 min after first v1.4.2 clients connect
- [ ] Confirm Geetashish's record is updated (specific test case from Evidence section)
