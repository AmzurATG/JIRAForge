# Differential Root Cause Analysis: `desktop_app_version` Not Updating for Some Users

**Created:** 2026-05-18  
**Issue:** Most users get `desktop_app_version` updated in DB after auto-update to v1.4.1. A few users remain stuck at the old version (e.g., `1.3.7`) indefinitely, even though the app is visibly running the new version.  
**Affected user example:** `geetashish.sharma@amzur.com` — DB shows `desktop_app_version=1.3.7`, `desktop_logged_in=false`, `desktop_last_heartbeat=2026-05-11 07:11:17` (7 days old), while tray shows `Up to Date (v1.4.1)`.

---

## Why MOST Users Succeed (Happy Path)

1. v1.3.7 is actively running on the user's machine.
2. Auto-update downloads v1.4.1 in the background.
3. On completion, `_on_update_manager_state_changed('ready')` fires → `auto_apply()` → `os._exit(0)` (no DB cleanup).
4. Bat script waits for old PID, replaces `TimeTracker.exe`, starts v1.4.1.
5. v1.4.1 startup:
   - **Early init**: `has_stored_tokens` → loads cached user → calls `initialize_supabase()`:
     - `get_supabase_config()` hits `https://forgesync.amzur.com/api/auth/supabase-config` → **succeeds** (network ready, AI server up).
     - `_set_supabase_jwt()` → cached `supabase_token` is still valid (was refreshed within last hour by v1.3.7's sync thread) → sets JWT on Supabase client.
     - `supabase_initialized = True`.
   - **Full auth**: `get_user_info()` succeeds → `initialize_supabase()` returns `True` immediately (already done) → `ensure_user_exists()` → `_update_desktop_status(logged_in=True)` → **DB writes `desktop_app_version=1.4.1`** ✅.

---

## Why FEW Users Fail (Sad Path) — Root Cause Chain

The fundamental failure is that `self.supabase` becomes `None` at startup and **never recovers for the entire session** (potentially 7+ days on a machine that stays on). Multiple independent triggers can cause this.

---

### RC-DIFF-1 (Critical): One-Shot `supabase_initialized` Guard With No Background Retry

**Location:** `desktop_app.py` — `initialize_supabase()` (line ~5304), `start_sync_thread()` (line ~10041)

```python
# initialize_supabase()
def initialize_supabase(self):
    if self.supabase_initialized:
        return True          # ← Returns immediately on success
    if not self.auth_manager.get_supabase_config():
        return False         # ← On failure: self.supabase stays None FOREVER
    # ...
    self.supabase_initialized = True
    return True
```

```python
# sync_worker() in start_sync_thread() — no reinitialization attempt
while self.running:
    if self.tracking_active and self.current_user_id:
        self.sync_offline_data()             # FAILS silently if supabase is None
    if self.current_user_id and not ...:
        heartbeat_counter += 1
        if heartbeat_counter >= heartbeat_interval:
            self._send_heartbeat()           # SILENT SKIP if supabase is None
    # ← No: if not self.supabase_initialized: self.initialize_supabase()
```

```python
# _send_heartbeat()
def _send_heartbeat(self):
    client = self.supabase
    if not client:
        return              # ← SILENTLY RETURNS, no log, no retry, no alert
```

**Impact:** Once `initialize_supabase()` fails at startup, `self.supabase` stays `None` for the ENTIRE session. The sync thread runs every 30 seconds for the entire time the app is open, but never re-attempts initialization. Every heartbeat silently skips. For a machine that ran v1.4.1 for 7 days without reboot, this means 7 days × 6 heartbeats/day = 42+ silent skips.

---

### RC-DIFF-2 (Critical): `get_supabase_config()` Has No Fallback — Mandatory Network Call at Every Startup

**Location:** `desktop_app.py` — `EMBEDDED_CONFIG` (line ~348), `get_supabase_config()` (line ~2464)

```python
# Embedded config has NO Supabase credentials
EMBEDDED_CONFIG = {
    'ATLASSIAN_CLIENT_ID': 'Q8HT4Jn205AuTiAarj088oWNDrOqwvM5',
    'AI_SERVER_URL': 'https://forgesync.amzur.com',
    # REMOVED: SUPABASE_URL, SUPABASE_ANON_KEY — fetched from AI Server
}

# RUNTIME_SUPABASE_CONFIG is in-memory only — reset to None on every startup
RUNTIME_SUPABASE_CONFIG = {'SUPABASE_URL': None, 'SUPABASE_ANON_KEY': None}
```

```python
def get_supabase_config(self):
    # No caching check — ALWAYS makes a network call
    response = requests.post(
        f"{ai_server_url}/api/auth/supabase-config",
        json={'atlassian_token': access_token},
        timeout=(10, 60)     # 10s connect, 60s read — up to 70s blocking
    )
```

**Impact:** `SUPABASE_URL` and `SUPABASE_ANON_KEY` are not embedded in the app and are NOT cached to disk. Every startup requires a fresh network call to `forgesync.amzur.com`. If that server is unavailable for even 10 seconds during the startup window, `initialize_supabase()` fails.

**Why some users are affected more:** Network readiness varies by machine. Windows machines waking from sleep/hibernate, VPN reconnection, or machines where v1.4.1 started immediately after the update (while the network was briefly cycling) all create this window.

---

### RC-DIFF-3 (High): Early Init Runs BEFORE Connectivity Check

**Location:** `desktop_app.py` — `run()` (lines ~11247–11270)

```python
# STEP 1: Early init — NO connectivity check yet
has_stored_tokens = (...)
if has_stored_tokens:
    cached_user = self._load_cached_user_info()
    if cached_user and cached_user.get('organization_id'):
        try:
            if self.initialize_supabase():   # ← Network call to AI server!
                print("[OK] Supabase initialized from cache")
        except Exception as e:
            print(f"[WARN] Could not initialize Supabase from cache: {e}")

# STEP 2: Connectivity check — only NOW checks if online
is_online = self.offline_manager.check_connectivity(force=True)
```

**Impact:** When v1.4.1 starts (e.g., immediately after the bat script runs or on system boot), the early init fires before the connectivity check. If the network is not yet ready (common with VPNs, wake-from-sleep, or slow DHCP), the `get_supabase_config()` call in early init will fail with a `ConnectionError` or timeout, even though the network comes up a few seconds later.

This is especially problematic because the early init also has no timeout on the call itself beyond the built-in 70-second timeout — it blocks the entire startup for up to 70 seconds during this network-not-ready window.

---

### RC-DIFF-4 (High): Both Init Attempts Hit the Same AI Server — No Independent Fallback

**Location:** `desktop_app.py` — `run()` full auth (lines ~11285–11310)

```python
if user_info:
    try:
        if not self.initialize_supabase():   # ← SECOND attempt, same AI server
            print("[WARN] Could not initialize Supabase, using cached user ID")
            self.current_user_id = self._load_cached_user_id()
            # ← NO _update_desktop_status() here!
        else:
            self.current_user_id = self.ensure_user_exists(user_info)
            # ... verify ...
            self._update_desktop_status(logged_in=True)  # ← VERSION UPDATED
```

**Impact:** The startup flow makes **two** `initialize_supabase()` calls — early init and full auth. Both call the SAME `get_supabase_config()` endpoint on the SAME AI server (`forgesync.amzur.com`). If the server is unavailable for the 30-90 second window spanning both calls, both fail. The full auth path gracefully falls back to cached user ID but **never calls `_update_desktop_status(logged_in=True)`**, so the version is never written.

---

### RC-DIFF-5 (High): Migration Bug Loses `supabase_token_expires_at`

**Location:** `desktop_app.py` — `AtlassianAuthManager._migrate_from_plaintext()` (line ~1900)

```python
def _migrate_from_plaintext(self):
    if not os.path.exists(self.store_path):
        return

    # BUG: migrate_from_plaintext() DELETES self.store_path BEFORE we read it
    migrated = self.secure_storage.migrate_from_plaintext(self.store_path)
    # ↑ self.store_path ('time_tracker_auth.json') is now DELETED by this call

    if migrated:
        try:
            with open(self.store_path, 'r') as f:     # ← FileNotFoundError!
                old_data = json.load(f)
            metadata = {k: v for k, v in old_data.items() if k not in SENSITIVE_TOKEN_KEYS}
            if metadata:
                with open(self.metadata_path, 'w') as f:
                    json.dump(metadata, f)             # ← Never reached
        except Exception:
            pass  # ← Exception silently swallowed
```

**Impact:** When a user migrates from the old plaintext `time_tracker_auth.json` to the new secure storage, the `auth_metadata.json` file is **never created** because the old file is deleted before it can be read. After migration:
- `_load_tokens()` finds no `auth_metadata.json` → `tokens = {}`
- Keyring loads: `{'access_token': ..., 'refresh_token': ..., 'supabase_token': ...}`
- `supabase_token_expires_at` is missing from `self.tokens` (= 0)

---

### RC-DIFF-6 (High): When `supabase_token_expires_at = 0`, Proactive JWT Refresh Is Silently Skipped

**Location:** `desktop_app.py` — `start_sync_thread()` sync_worker (line ~10090)

```python
# Proactive Supabase JWT refresh every 5 minutes:
sb_expires_at = self.auth_manager.tokens.get('supabase_token_expires_at', 0)
if sb_expires_at and time.time() > (sb_expires_at - 300):   # ← 'if 0 and ...' = FALSE
    # This block is NEVER entered when supabase_token_expires_at is 0 or missing
    if self._set_supabase_jwt():
        print("[OK] Supabase JWT refresh successful")
```

**Impact:** After RC-DIFF-5 (migration bug), `supabase_token_expires_at` is 0. The proactive JWT refresh in the sync thread is gated on `if sb_expires_at and ...` which evaluates to `if 0 and ...` = **False**. The Supabase JWT is never proactively refreshed. After 1 hour, the JWT expires. The heartbeat's proactive refresh (`elif not sb_expires_at:`) does attempt a refresh but only at the 4-hour heartbeat mark, not every 5 minutes. If that per-heartbeat refresh also fails (AI server briefly unavailable at that moment), the heartbeat proceeds with an expired JWT → 0 rows updated → persistent failure.

---

### RC-DIFF-7 (Medium): `_send_heartbeat()` Skips Entirely if JWT Refresh Fails — No Retry for 4 Hours

**Location:** `desktop_app.py` — `_send_heartbeat()` (line ~6578) + `start_sync_thread()` (line ~10044–10055)

```python
# In _send_heartbeat():
if sb_expires_at and time.time() > (sb_expires_at - 300):
    if not self._set_supabase_jwt():
        print("[HEARTBEAT] JWT refresh failed — heartbeat skipped (will retry in 4 hours)")
        return   # ← ENTIRE heartbeat is skipped

# heartbeat_interval = 480 iterations × 30s = 4 hours
# After a failed heartbeat, next attempt is 4 hours later
```

**Impact:** If the JWT refresh fails (AI server unavailable for a few seconds at the heartbeat time), the heartbeat is skipped for the next 4 hours. In 7 days, there are only 42 heartbeat opportunities. Any transient AI server unavailability at each of those moments causes the miss. Combined with RC-DIFF-1 (Supabase never reinitialized), even a single brief outage at startup leads to infinite failure.

---

### RC-DIFF-8 (Medium): `_update_desktop_status()` Not Called in Offline/Fallback Startup Path

**Location:** `desktop_app.py` — `run()` (lines ~11335–11355 offline branch)

```python
# Offline startup path:
else:  # not is_online
    cached_user = self._load_cached_user_info()
    if cached_user:
        self.current_user = cached_user
        self.current_user_id = cached_user.get('user_id')
        # ← NO initialize_supabase() call
        # ← NO _update_desktop_status(logged_in=True)
```

```python
# Fallback path (get_user_info() fails 3x):
cached_user = self._load_cached_user_info()
if cached_user:
    self.current_user = cached_user
    self.current_user_id = cached_user.get('user_id')
    # ← NO _update_desktop_status(logged_in=True)
```

**Impact:** If v1.4.1 starts while the machine is offline (or `get_user_info()` fails), `_update_desktop_status(logged_in=True)` is NEVER called for that session. The sync thread's heartbeat IS the only remaining mechanism to update the version — but if `self.supabase` is None (because `initialize_supabase()` was also skipped in offline mode), heartbeats also silently fail.

---

### RC-DIFF-9 (Low): `desktop_logged_in` Not Updated by Heartbeat

**Location:** `desktop_app.py` — `_send_heartbeat()` (line ~6613)

```python
result = client.table('users').update({
    'desktop_last_heartbeat': datetime.now(timezone.utc).isoformat(),
    'desktop_app_version': self.app_version     # ← Only these two fields
}).eq('id', self.current_user_id).execute()
# ← 'desktop_logged_in' is NOT updated by heartbeat
```

**Impact:** When `quit_app()` sets `desktop_logged_in = False`, only a fresh login via `_update_desktop_status(logged_in=True)` can restore it. Heartbeats cannot repair a stale `desktop_logged_in=False` state. The user's DB record shows `desktop_logged_in=false` which, combined with a stale version, confirms `_update_desktop_status(logged_in=True)` was never successfully called for v1.4.1.

---

## Evidence Summary for `geetashish.sharma@amzur.com`

| Field | Value | Interpretation |
|-------|-------|----------------|
| `desktop_app_version` | `1.3.7` | `_update_desktop_status(logged_in=True)` was **never** called by v1.4.1 |
| `desktop_logged_in` | `false` | Last set by `quit_app()` from v1.3.7; v1.4.1 never called `_update_desktop_status(logged_in=True)` |
| `desktop_last_heartbeat` | `2026-05-11 07:11:17` | The last SUCCESSFUL Supabase write was from v1.3.7. v1.4.1's heartbeats are silently skipping (either `self.supabase = None` or JWT expired → 0 rows) |
| `supabase_user_id = id` | ✅ | RLS fix is working — the issue is NOT RLS blocking |
| Screenshot shows v1.4.1 tray | v1.4.1 running | `APP_VERSION = "1.4.1"` hardcoded in exe — app is definitely running v1.4.1 |

**Conclusion:** `self.supabase` is `None` for this user's v1.4.1 session. `initialize_supabase()` failed at startup (triggered by RC-DIFF-2: AI server was briefly unreachable during the v1.4.1 startup window on May 11). RC-DIFF-1 (no background retry) ensures this failure is permanent for the session.

---

## Code Fixes

### FIX-1 (Critical): Add Background Supabase Re-Initialization in Sync Thread

**File:** `python-desktop-app/desktop_app.py` — `start_sync_thread()` sync_worker

This single fix would prevent the 7-day persistent failure even if startup initialization fails.

```python
def start_sync_thread(self):
    def sync_worker():
        heartbeat_counter = 0
        heartbeat_interval = 480
        token_refresh_counter = 0
        token_refresh_interval = 10
        supabase_reinit_counter = 0
        supabase_reinit_interval = 60  # Retry every 30 minutes (60 × 30s)
        
        # ... (existing initial heartbeat) ...
        
        while self.running:
            try:
                # ← ADD THIS BLOCK (before heartbeat check):
                # Background Supabase re-initialization if it failed at startup.
                # Protects against brief AI server outage at startup time.
                if not self.supabase_initialized and self.auth_manager.is_authenticated():
                    supabase_reinit_counter += 1
                    if supabase_reinit_counter >= supabase_reinit_interval:
                        supabase_reinit_counter = 0
                        print("[INFO] Attempting background Supabase re-initialization...")
                        try:
                            if self.initialize_supabase():
                                print("[OK] Supabase re-initialized in background")
                                # Re-register DB status now that Supabase is available
                                try:
                                    self._update_desktop_status(logged_in=True)
                                except Exception as e:
                                    print(f"[WARN] Could not update desktop status after re-init: {e}")
                        except Exception as e:
                            print(f"[WARN] Background Supabase re-init failed: {e}")

                # ... (rest of existing sync_worker loop) ...
```

---

### FIX-2 (Critical): Cache Supabase Config to `auth_metadata.json`

**File:** `python-desktop-app/desktop_app.py` — `get_supabase_config()` + `initialize_supabase()`

Eliminate the mandatory AI server call at every startup by caching the Supabase URL and anon key locally.

```python
def get_supabase_config(self):
    """Fetch Supabase config from AI Server, with local cache fallback."""
    access_token = self.tokens.get('access_token')
    
    # ← ADD: Check local cache first (if recent enough)
    cached_url = self.tokens.get('cached_supabase_url')
    cached_anon_key = self.tokens.get('cached_supabase_anon_key')
    cached_at = self.tokens.get('cached_supabase_config_at', 0)
    CACHE_TTL = 86400  # 24 hours
    
    if cached_url and cached_anon_key and (time.time() - cached_at) < CACHE_TTL:
        print("[INFO] Using cached Supabase config (fetched recently)")
        set_runtime_supabase_config(cached_url, cached_anon_key)
        return True
    
    # ... (existing network fetch code) ...
    
    # ← ADD: After successful fetch, cache to metadata JSON:
    set_runtime_supabase_config(result.get('supabase_url'), result.get('supabase_anon_key'))
    self.tokens['cached_supabase_url'] = result.get('supabase_url')
    self.tokens['cached_supabase_anon_key'] = result.get('supabase_anon_key')
    self.tokens['cached_supabase_config_at'] = time.time()
    self._save_tokens()   # Persists cache to auth_metadata.json
    return True
```

---

### FIX-3 (High): Fix Migration Bug — Read Old File BEFORE Migrating

**File:** `python-desktop-app/desktop_app.py` — `AtlassianAuthManager._migrate_from_plaintext()`

```python
def _migrate_from_plaintext(self):
    if not os.path.exists(self.store_path):
        return

    # ← READ the old file BEFORE migration deletes it
    old_data = {}
    try:
        with open(self.store_path, 'r') as f:
            old_data = json.load(f)
    except Exception as e:
        print(f"[WARN] Could not read old token file for migration: {e}")

    migrated = self.secure_storage.migrate_from_plaintext(self.store_path)

    if migrated:
        print("[OK] Migrated tokens from plaintext to secure storage")
        # ← Now use the pre-read old_data (file is already gone)
        metadata = {k: v for k, v in old_data.items() if k not in SENSITIVE_TOKEN_KEYS}
        if metadata:
            try:
                with open(self.metadata_path, 'w') as f:
                    json.dump(metadata, f)
                print("[OK] Saved non-sensitive metadata separately (migration)")
            except Exception as e:
                print(f"[WARN] Could not save metadata during migration: {e}")
```

---

### FIX-4 (High): Add `_update_desktop_status` After Early Init Succeeds in Cached/Fallback Path

**File:** `python-desktop-app/desktop_app.py` — `run()` (lines ~11247–11264 early init) and fallback paths

```python
# In run(), after fallback to cached credentials:
cached_user = self._load_cached_user_info()
if cached_user:
    self.current_user = cached_user
    self.current_user_id = cached_user.get('user_id')
    print(f"[OK] Using cached credentials for {cached_user.get('email', 'User')}")
    print("[INFO] Will retry authentication in the background")
    # ← ADD: if Supabase is already initialized (from early init), update status now
    if self.supabase_initialized and self.current_user_id:
        try:
            self._update_desktop_status(logged_in=True)
            print("[OK] Desktop status updated from cached path")
        except Exception as e:
            print(f"[WARN] Could not update desktop status in fallback path: {e}")
```

---

### FIX-5 (Medium): Set `desktop_logged_in=True` in Heartbeat

**File:** `python-desktop-app/desktop_app.py` — `_send_heartbeat()`

```python
result = client.table('users').update({
    'desktop_last_heartbeat': datetime.now(timezone.utc).isoformat(),
    'desktop_app_version': self.app_version,
    'desktop_logged_in': True    # ← ADD: heartbeat implies the app is running and logged in
}).eq('id', self.current_user_id).execute()
```

---

### FIX-6 (Medium): Move Early Init After Connectivity Check, or Add Quick Connectivity Pre-Check

**File:** `python-desktop-app/desktop_app.py` — `run()` (lines ~11247–11270)

Option A (minimal change — add a quick connectivity pre-check before early init):
```python
if has_stored_tokens:
    cached_user = self._load_cached_user_info()
    if cached_user and cached_user.get('organization_id'):
        self.organization_id = cached_user.get('organization_id')
        self.current_user_id = cached_user.get('user_id')
        self.current_user = cached_user
        print(f"[OK] Restored organization_id from cache: {self.organization_id}")
        # ← ADD: Only attempt Supabase init if network is likely available
        # Use a short non-blocking check (no forced DNS lookup like check_connectivity)
        if self.offline_manager.check_connectivity(force=False):
            try:
                if self.initialize_supabase():
                    print("[OK] Supabase initialized successfully from cache")
            except Exception as e:
                print(f"[WARN] Could not initialize Supabase from cache: {e}")
        else:
            print("[INFO] Skipping early Supabase init (network not ready yet)")
```

---

### FIX-7 (Low): Reduce Heartbeat Interval or Add JWT Refresh on Supabase 0-Row Result

**File:** `python-desktop-app/desktop_app.py` — `_send_heartbeat()` and `start_sync_thread()`

```python
# In _send_heartbeat(), after detecting 0 rows:
if not result.data or len(result.data) == 0:
    print(f"[WARN] Heartbeat 0 rows — JWT may be expired, forcing refresh...")
    # ← ADD: Force JWT refresh and retry immediately (instead of waiting 4 hours)
    if self._set_supabase_jwt():
        retry_result = client.table('users').update({
            'desktop_last_heartbeat': datetime.now(timezone.utc).isoformat(),
            'desktop_app_version': self.app_version,
            'desktop_logged_in': True
        }).eq('id', self.current_user_id).execute()
        if retry_result.data and len(retry_result.data) > 0:
            print(f"[OK] Heartbeat retry succeeded after JWT refresh")
            return
    self.add_admin_log('ERROR', 
        f'Heartbeat failed: UPDATE affected 0 rows (version={self.app_version}). '
        f'Re-login may be required.')
```

---

## Priority Order for Fixes

| Priority | Fix | Impact | Effort |
|----------|-----|--------|--------|
| 🔴 P0 | FIX-1: Background Supabase reinit in sync thread | Fixes the 7-day persistence immediately for all affected users | Low |
| 🔴 P0 | FIX-2: Cache Supabase config to disk | Eliminates mandatory AI server call at every startup | Low |
| 🟠 P1 | FIX-3: Fix migration bug (read file before deleting) | Prevents `supabase_token_expires_at` loss during migration | Very Low |
| 🟠 P1 | FIX-4: `_update_desktop_status` in fallback/cached path | Covers the case where Supabase is up but user info fetch fails | Low |
| 🟡 P2 | FIX-5: `desktop_logged_in=True` in heartbeat | Repair stale `desktop_logged_in=false` without re-login | Very Low |
| 🟡 P2 | FIX-6: Pre-connectivity check before early init | Prevent early init failure on slow network startup | Low |
| 🟢 P3 | FIX-7: JWT refresh + retry on 0-row heartbeat result | Self-healing for expired JWT scenarios | Medium |

---

## Quick Fix for Affected Users (Immediate)

For users already stuck (like `geetashish.sharma@amzur.com`), the quickest fix is to force a re-authentication:
1. User clicks **Sign Out** in the tray menu → `quit_app()` → `_update_desktop_status(logged_in=False)`.
2. User clicks **Sign In** → full OAuth flow → `handle_callback()` → fresh tokens → `initialize_supabase()` will succeed → `_update_desktop_status(logged_in=True)` → **version updated**.

Alternatively, a server-side fix: the AI server could expose an endpoint to force a version update for specific users. But the proper fix is FIX-1 which would self-heal within 30 minutes of the next app startup.
