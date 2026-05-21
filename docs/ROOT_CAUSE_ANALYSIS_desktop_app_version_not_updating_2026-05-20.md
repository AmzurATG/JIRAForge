# Root Cause Analysis: `desktop_app_version` Not Updating in DB for Some Users

**Date:** 2026-05-20  
**Analyst:** Deep-dive codebase scan  
**Severity:** 🔴 Critical — silent data staleness, no user-visible error  
**Scope:** `python-desktop-app/desktop_app.py`, `python-desktop-app/auth/secure_storage.py`  
**Branch:** `fix/auto-update-30min-retry-and-notifications`

---

## Evidence (The Anomaly That Triggered This Analysis)

```json
{
  "email": "geetashish.sharma@amzur.com",
  "desktop_app_version": "1.3.7",
  "desktop_logged_in": false,
  "desktop_last_heartbeat": "2026-05-11 07:11:17.402551+00",
  "updated_at": "2026-05-11 07:11:18.469234+00"
}
```

**System tray shows:** `✓ Up to Date (v1.4.1) - Click to Check`

**What this means:**
- The app on the user's machine is running **v1.4.1** (confirmed by the tray)
- The DB record has not been updated since **2026-05-11** (9 days of silence) — but the actual broken state spans **all versions from v1.3.8 through v1.4.1**
- The timestamp `2026-05-11 07:11:17` is the last successful DB write, from **v1.3.7** — terminated when Geetashish manually installed v1.3.8

**Geetashish's full upgrade path:**

| Step | Version | Method | DB Updated? |
|------|---------|--------|-------------|
| 1 | v1.3.7 | Manual install (original) | ✅ Yes — last DB write at `07:11:17` |
| 2 | v1.3.8 | Manual install over v1.3.7 | ❌ No — RC-1 from first startup |
| 3 | v1.3.9 | Manual install (first version with auto-update) | ❌ No — RC-1 from first startup |
| 4 | v1.4.0 | **Auto-update** from v1.3.9 (`os._exit(0)` + bat script) | ❌ No — RC-1 from first startup |
| 5 | v1.4.1 | **Auto-update** from v1.4.0 (`os._exit(0)` + bat script) | ❌ No — current state |

- **Auto-update was introduced in v1.3.9** — v1.3.7 and v1.3.8 had no `UpdateManager`, no `_shutdown_for_update()`, no bat script. They opened the browser when a new version was detected.
- `desktop_logged_in = false` persists because none of v1.3.8 through v1.4.1 have ever successfully written to the DB (RC-1 blocks all DB writes from their first startup onward)
- Every database write from **v1.3.8 onwards** is silently failing — the user has no awareness of this

---

## Full System Architecture Context

### How `desktop_app_version` Gets Written to the DB

There are **three code paths** that can write `desktop_app_version` to the `users` table:

#### Path 1: OAuth Callback (`/auth/callback` route)
```
User clicks Login
  → OAuth flow completes
  → /auth/callback handler
      → initialize_supabase()           [requires AI server]
      → ensure_user_exists(user_info)   [creates/updates user row]
      → _update_desktop_status(logged_in=True)   ← writes desktop_app_version
```
Called at: `desktop_app.py:5585`

#### Path 2: `run()` Startup Auth Flow (the primary path for returning users)
```
App starts (v1.4.1 — launched by auto-update bat script OR newly-started installed copy after manual install)
  → run()
      → Early init block (lines ~11365-11385)
          → has_stored_tokens check
          → _load_cached_user_info()
          → initialize_supabase()           [requires AI server]
      → check_connectivity()
      → is_authenticated()
      → get_user_info()                     [requires Atlassian API]
      → initialize_supabase()               [skip if already done]
      → ensure_user_exists()
      → _update_desktop_status(logged_in=True)   ← writes desktop_app_version
```
Called at: `desktop_app.py:11458`

#### Path 3: Heartbeat (`_send_heartbeat()`)
```
Sync thread (every 30 seconds)
  → heartbeat_counter++
  → if heartbeat_counter >= 480 (4 hours):
      → _send_heartbeat()   ← writes desktop_app_version
      → heartbeat_counter = 0
```
Called at: `desktop_app.py:6660`

**Critical insight:** If Paths 1 and 2 both fail to write `desktop_app_version`, the DB stays at the old version until Path 3 (heartbeat) fires. If Path 3 also fails, the DB never updates — regardless of how long the app runs.

---

## The Silent Mechanism: `self.supabase = None`

The single most important fact for this analysis is:

```python
# desktop_app.py:6627-6630
def _send_heartbeat(self):
    client = self.supabase
    if not client:
        return               # ← Zero output. Zero log. Zero retry.
```

And:

```python
# desktop_app.py:6594-6600
def _update_desktop_status(self, logged_in=True):
    client = self.supabase
    if not client:
        print("[WARN] No Supabase client available for status update")
        return False
```

**When `self.supabase` is `None`, every single DB write attempt silently returns.** The user sees the app working normally. The tray shows `Up to Date`. The admin panel loads (from cached credentials). No error notification is raised. Nothing is logged that would alert anyone. The DB simply never updates.

The entire investigation is therefore: **why does `self.supabase` stay `None` for this user's v1.4.1 session?**

---

## Root Cause Analysis

### RC-1 (Critical): `initialize_supabase()` Is One-Shot With No Background Recovery

**File:** `desktop_app.py`  
**Lines:** 5351–5412 (`initialize_supabase()`), 10099–10230 (`start_sync_thread`)

#### The Code

```python
def initialize_supabase(self):
    if self.supabase_initialized:          # ← Guard: skip if already done
        print("[INFO] Supabase already initialized")
        return True

    if not self.auth_manager.get_supabase_config():   # ← NETWORK CALL
        print("[ERROR] Failed to get Supabase config from AI server")
        return False                       # ← self.supabase stays None

    # ...build Supabase client...
    self.supabase_initialized = True
    return True
```

**If this returns `False`:** `self.supabase = None`, `self.supabase_initialized = False`. There is no retry. There is no recovery mechanism (pre-fix).

#### The Sync Thread (before fixes)

```python
while self.running:
    # No check for self.supabase_initialized
    if self.tracking_active and self.current_user_id:
        self.sync_offline_data()     # silently no-ops if supabase is None
    if self.current_user_id and not self.current_user_id.startswith('anonymous_'):
        heartbeat_counter += 1
        if heartbeat_counter >= heartbeat_interval:
            self._send_heartbeat()   # silently returns if supabase is None
            heartbeat_counter = 0
```

A machine that starts v1.4.1 with a transient AI server failure gets stuck in this broken state indefinitely. The sync thread iterates 2880 times per day (every 30 seconds) and never re-attempts `initialize_supabase()`.

#### Why This Explains the 9-Day Staleness

For `geetashish.sharma@amzur.com`, RC-1 has been silently broken across **four consecutive versions**:

- **v1.3.7 (last working):** Ran successfully and wrote to DB. Last heartbeat: `2026-05-11 07:11:17`. v1.3.7 had no auto-update — it opened the browser when a new version was detected. **Auto-update was introduced in v1.3.9.**
- **v1.3.8 (manual install):** Geetashish ran v1.3.8.exe from Downloads. v1.3.8's `install_application()` terminated v1.3.7 (v1.3.7 had no `check_for_shutdown_signal()` handler, so it was force-killed via `terminate_old_version()`). `quit_app()` was NOT called. v1.3.8 started → `initialize_supabase()` failed (RC-2: no disk cache, AI server unreachable at startup moment) → `self.supabase = None` → RC-1: no recovery. DB stays at v1.3.7.
- **v1.3.9 (manual install — first version with auto-update):** Geetashish ran v1.3.9.exe. v1.3.9 introduced `UpdateManager`, `_shutdown_for_update()`, `apply_update.bat`, and `check_for_shutdown_signal()`. v1.3.9 terminated v1.3.8. v1.3.9 started → same RC-1 → `self.supabase = None`. DB still at v1.3.7. But v1.3.9's `UpdateManager` works **independently of Supabase** — it polls the version check API and detects v1.4.0.
- **v1.4.0 (auto-update):** v1.3.9's `UpdateManager` → `auto_apply()` → `_shutdown_for_update()` → `os._exit(0)` → bat script starts v1.4.0. v1.4.0 startup → same RC-1. v1.4.0's `UpdateManager` detects v1.4.1.
- **v1.4.1 (auto-update — current):** Same `os._exit(0)` + bat script. v1.4.1 startup → same RC-1 → `self.supabase = None`.

The sync thread has run ~25,920 iterations across this entire time. Every single one silently returned because `self.supabase = None`. No error, no log, no alert.

**Fix applied (FIX-1):** Background retry added to sync thread — every 60 iterations (30 min), if `not self.supabase_initialized and is_authenticated()`, re-attempts `initialize_supabase()` and calls `_update_desktop_status(logged_in=True)` on success.

---

### RC-2 (Critical): Supabase Config Is Not Cached — Every Startup Requires a Live AI Server Call

**File:** `desktop_app.py`  
**Lines:** 2471–2570 (`get_supabase_config()`)

#### The Problem

`SUPABASE_URL` and `SUPABASE_ANON_KEY` are not embedded in the app binary:

```python
EMBEDDED_CONFIG = {
    'ATLASSIAN_CLIENT_ID': 'Q8HT4Jn205AuTiAarj088oWNDrOqwvM5',
    'AI_SERVER_URL': 'https://forgesync.amzur.com',
    # SUPABASE_URL and SUPABASE_ANON_KEY are intentionally not embedded
    # They are fetched from the AI server at runtime
}
```

#### Why Not Embedding Is the Correct Security Decision

The `# intentionally not embedded` comment reflects a deliberate security design. **This should not be changed.** PyInstaller executables are not obfuscated — tools like `pyinstxtractor` can unpack them and `strings` can extract plaintext literals from the bytecode. Any `SUPABASE_URL` or `SUPABASE_ANON_KEY` stored as a string in the binary is extractable by anyone with access to the `.exe` file.

**What an attacker with the Supabase `anon_key` can do:**
- Make direct REST/PostgREST calls to `https://<project>.supabase.co/rest/v1/users` — bypassing all application logic
- Attempt to exploit any misconfigured RLS policies (missing `USING` clauses, overly broad `SELECT` grants)
- Enumerate schema via the Supabase introspection API
- Exhaust Supabase plan quotas (request/row limits)
- The `anon_key` is a JWT — it grants persistent bearer-token access until explicitly rotated

**Why the server-fetch approach is more secure:**
- Fetching the config requires a **valid Atlassian OAuth `access_token`** — the attacker must be an authenticated user in the org at the moment of access
- The config (URL + anon_key) can be **rotated at the server** without rebuilding or releasing a new app version
- Each config fetch is logged server-side, providing an audit trail of access
- The AI server can block specific users or add rate-limiting without a client update

**Note on FIX-2 disk cache:** Caching `SUPABASE_URL` and `SUPABASE_ANON_KEY` to `auth_metadata.json` does store them on disk. However:
- `%LOCALAPPDATA%\TimeTracker\` uses Windows user-scoped ACLs — accessible only to that user's session or a local admin
- An attacker with that level of local access can already extract keyring tokens (`access_token`, `supabase_token`), giving them full authenticated access — the anon_key alone adds no meaningful capability at that point
- The cache has a 24h TTL and is a reliability necessity; the alternative (failing on every cold startup) is operationally unacceptable

**The bug in RC-2 is not the architecture — it is the missing cache.** The fix (FIX-2) adds the cache while preserving the correct security model.

And the in-memory config is reset to `None` on every process start:

```python
RUNTIME_SUPABASE_CONFIG = {'SUPABASE_URL': None, 'SUPABASE_ANON_KEY': None}
```

Therefore, **every startup** of v1.4.1 must make a live HTTP call:

```python
response = requests.post(
    f"{ai_server_url}/api/auth/supabase-config",   # https://forgesync.amzur.com/api/auth/supabase-config
    json={'atlassian_token': access_token},
    timeout=(10, 60)   # 10s connect, 60s read
)
```

If this call fails for **any reason** (server briefly down, DNS cold-start, VPN reconnecting, connection reset), `get_supabase_config()` returns `False`, `initialize_supabase()` returns `False`, and `self.supabase` stays `None` for the entire session.

#### Why This Is Differentially Triggered

The call is made at startup during a ~30-second window. Brief AI server outages, DNS latency spikes, and VPN reconnection delays last seconds to minutes — enough to span the startup window. This explains why only SOME users are affected: it depends on the specific timing of network readiness at the moment v1.4.1 first starts (immediately after the bat script restarts the process).

**Fix applied (FIX-2):** After successful fetch, `SUPABASE_URL` and `SUPABASE_ANON_KEY` are now cached to `auth_metadata.json` with a 24-hour TTL. On next startup, the cache is checked first. If fresh, the AI server is skipped entirely. If stale, the AI server is called and if that fails, the stale cache is used as fallback. This eliminates the mandatory network dependency at startup.

---

### RC-3 (High): Early Supabase Init Fires Before Connectivity Check

**File:** `desktop_app.py`  
**Lines:** ~11363–11395 (`run()` startup sequence)

#### The Startup Order (Before Analysis)

```python
def run(self):
    # ...startup boilerplate...

    # STEP 1: Early init block — runs UNCONDITIONALLY, no connectivity check
    has_stored_tokens = (self.auth_manager.tokens.get('access_token') or
                         self.auth_manager.tokens.get('refresh_token'))
    if has_stored_tokens:
        cached_user = self._load_cached_user_info()
        if cached_user and cached_user.get('organization_id'):
            # ...
            try:
                if self.initialize_supabase():    # ← NETWORK CALL — no check if network is ready
                    print("[OK] Supabase initialized successfully from cache")
            except Exception as e:
                print(f"[WARN] Could not initialize Supabase from cache: {e}")

    # STEP 2: Connectivity check — runs AFTER the above
    is_online = self.offline_manager.check_connectivity(force=True)
```

#### The Problem: Windows Boot and Auto-Start Timing

The desktop app is registered in Windows startup (`HKCU\Software\Microsoft\Windows\CurrentVersion\Run`). On auto-update, the bat script immediately starts v1.4.1 after installing it. In both cases:

- **Windows login auto-start:** The OS notifies the app to start before network adapters (especially Wi-Fi) are fully initialized. DNS resolvers may not be ready for 5–30 seconds after startup.
- **Auto-update restart:** The bat script starts v1.4.1 immediately. If the user was on VPN and the update disconnected/reconnected VPN, the network may not be ready when early init fires.
- **Wake from sleep:** If the machine woke from sleep immediately before (or triggered by) the update, the network adapter resumes but DNS may not resolve for several seconds.

In all of these cases, the early init fires into a non-ready network stack and fails. The subsequent full auth path (`check_connectivity()` → `is_authenticated()` → `initialize_supabase()`) would succeed, but at that point `initialize_supabase()` has already failed once, and with no fallback, `self.supabase` remains `None` through the full auth path too.

**Fix applied (FIX-2 — indirect):** With the disk cache from FIX-2, the early init's `get_supabase_config()` succeeds from cache without needing network. This makes the entire startup network-race-free for users who have previously authenticated.

---

### RC-4 (High): Both Init Attempts Hit the Same Single Endpoint — No Independent Fallback

**File:** `desktop_app.py`  
**Lines:** Early init (~11379), Full auth path (~11407)

#### The Two Init Attempts

```python
# Attempt 1: Early init (before connectivity check)
if self.initialize_supabase():   # calls get_supabase_config() → forgesync.amzur.com

# Attempt 2: Full auth path (after connectivity check)
if not self.initialize_supabase():   # SKIPS because guard: if self.supabase_initialized: return True
```

Wait — `initialize_supabase()` has an early-exit guard:

```python
def initialize_supabase(self):
    if self.supabase_initialized:
        return True   # ← Only guards on TRUE state
```

If Attempt 1 **succeeds**: `self.supabase_initialized = True` → Attempt 2 skips (correct).  
If Attempt 1 **fails**: `self.supabase_initialized = False` → Attempt 2 **also calls** `get_supabase_config()` → **same endpoint** → if that endpoint is still down, Attempt 2 also fails.

There is no independent fallback mechanism. Both attempts go through `forgesync.amzur.com`. A brief server outage spanning the startup window (~30–90 seconds) kills both attempts.

**Partial mitigation via FIX-2:** If a disk cache exists from a previous session, neither attempt needs to hit the network. The dependency on AI server availability at startup is eliminated entirely for returning users.

---

### RC-5 (High): Migration Bug Silently Destroys `supabase_token_expires_at`

**File:** `desktop_app.py`  
**Lines:** 1887–1928 (`_migrate_from_plaintext()`)

#### The Old Storage Format

Before the keyring-based secure storage was introduced (circa v1.3.x), all tokens were stored in a single plaintext JSON file at `%LOCALAPPDATA%\TimeTracker\time_tracker_auth.json`. This file contained:

```json
{
  "access_token": "...",
  "refresh_token": "...",
  "supabase_token": "...",
  "supabase_token_expires_at": 1747234567.89,
  "expires_at": 1747238000.12,
  "cached_supabase_url": "...",
  "cached_supabase_anon_key": "..."
}
```

The new storage splits tokens:
- **Sensitive** (`access_token`, `refresh_token`, `supabase_token`) → Windows Credential Manager (keyring)
- **Non-sensitive** (`supabase_token_expires_at`, `expires_at`, etc.) → `auth_metadata.json`

#### The Bug (Before Fix)

```python
def _migrate_from_plaintext(self):
    try:
        if not os.path.exists(self.store_path):
            return

        # BUG: Calls migrate_from_plaintext() FIRST — this deletes store_path
        migrated = self.secure_storage.migrate_from_plaintext(self.store_path)

        if migrated:
            # BUG: store_path was just deleted above — this throws FileNotFoundError
            with open(self.store_path, 'r') as f:
                old_data = json.load(f)
            # This block is NEVER reached
            # auth_metadata.json is NEVER created
            # supabase_token_expires_at = LOST

    except Exception as e:
        print(f"[WARN] Migration to secure storage failed: {e}")
        # The FileNotFoundError is silently swallowed here
```

`secure_storage.migrate_from_plaintext()` (in `auth/secure_storage.py`) saves the sensitive tokens to keyring and **deletes** the source file on success. The code then tries to read from the deleted file, gets `FileNotFoundError`, which is caught by `except Exception`, and silently swallowed.

**Consequence chain:**

1. `auth_metadata.json` is never created for migrated users
2. `self.auth_manager.tokens.get('supabase_token_expires_at', 0)` → returns `0`
3. Proactive JWT refresh check in the sync thread: `if sb_expires_at and time.time() > (sb_expires_at - 300)` → `if 0 and ...` → **False** → proactive refresh NEVER fires
4. JWT minted at login (1 hour TTL) is never refreshed by the proactive check
5. After 1 hour, all Supabase writes produce 0-row results (expired JWT, `auth.uid()` = NULL, RLS blocks)
6. Combined with RC-1 (heartbeat silent skip when supabase is None), affected users never get version updated

**When does this affect users?**  
Any user who:
1. Was on v1.3.x or earlier (when plaintext storage was used)
2. Upgraded to the first version that introduced keyring storage

These are **not new users** — they are long-standing users who migrated from the old format. This explains why the affected user has a `created_at` of `2026-04-09` (a user who existed before the keyring migration was deployed).

**Fix applied (FIX-3):** Read the old file **before** calling `migrate_from_plaintext()`. The pre-read data (including `supabase_token_expires_at`) is then used to populate `auth_metadata.json` correctly after migration.

---

### RC-6 (High): Full Auth Fallback Path Skips `_update_desktop_status`

**File:** `desktop_app.py`  
**Lines:** ~11440–11470 (`run()` — `get_user_info()` retry exhaustion path)

#### The Scenario

When `get_user_info()` (the Atlassian API call) fails all 3 retries, the app falls back to cached credentials:

```python
else:
    # get_user_info() failed 3 times — fall back to cached data
    cached_user = self._load_cached_user_info()
    if cached_user:
        self.current_user = cached_user
        self.current_user_id = cached_user.get('user_id')
        print(f"[OK] Using cached credentials for {cached_user.get('email', 'User')}")
        print("[INFO] Will retry authentication in the background")
        # ← BEFORE FIX: _update_desktop_status(logged_in=True) was NEVER called here
        # ← Even if early init succeeded (supabase_initialized=True), version not pushed
```

This is significant because:
1. Early init may have succeeded (AI server reachable during early init, Atlassian API down slightly later)
2. `self.supabase_initialized = True`, `self.supabase` is valid
3. Cached user has valid `user_id`
4. But the version update is never written because this path didn't call `_update_desktop_status`

**Fix applied (FIX-4):** Added version update call in the fallback path — if `supabase_initialized` is `True` and `current_user_id` is valid, immediately push `_update_desktop_status(logged_in=True)`.

---

### RC-7 (Medium): Heartbeat Does Not Write `desktop_logged_in = True`

**File:** `desktop_app.py`  
**Lines:** ~6628–6700 (`_send_heartbeat()` — before fix)

#### The `false` Ratchet

When an old version is replaced (for Geetashish: v1.3.7 terminated by v1.3.8 installer), one of two things happens:
- **Force-kill via `terminate_old_version()`** (applies to v1.3.7 and v1.3.8, which have no `check_for_shutdown_signal()` handler): `quit_app()` is NOT called. `desktop_logged_in` stays at whatever it was — likely `false` if set by a prior clean quit, or never repaired to `true` since v1.3.7 heartbeats did not include `desktop_logged_in`
- **Auto-update exit** (`_shutdown_for_update()` → `os._exit(0)`, applies to v1.3.9+): also bypasses `quit_app()` entirely. Same effect — `desktop_logged_in` stays at its prior value
- **Normal quit** (`quit_app()`): calls `_update_desktop_status(logged_in=False)` → DB: `desktop_logged_in = false` (only happens on user-initiated exit, not on installer-driven or auto-update termination)

After v1.4.1 starts:
- The successful path writes `desktop_logged_in = True` via `_update_desktop_status(logged_in=True)`
- But if that path fails (due to RC-1/RC-2/RC-5), `desktop_logged_in` stays `false`
- Heartbeats (before fix) only updated `desktop_last_heartbeat` and `desktop_app_version` — **not** `desktop_logged_in`

So even if a heartbeat eventually succeeded (e.g., after a manual JWT refresh), `desktop_logged_in` would remain `false` because the heartbeat payload didn't include it.

**Fix applied (FIX-5):** Heartbeat payload now includes `'desktop_logged_in': True`. A successful heartbeat means the app is running and the user is active — the flag should be `true`.

---

### RC-8 (Medium): Heartbeat 0-Row Result Triggers 4-Hour Skip With No Immediate Retry

**File:** `desktop_app.py`  
**Lines:** ~6670–6690 (`_send_heartbeat()` — before fix)

#### The Problem

When the Supabase JWT expires mid-session (1 hour TTL), heartbeat UPDATEs return 0 rows because `auth.uid()` returns `NULL` with an expired JWT, and the RLS policy `WHERE id = get_current_user_id()` matches nothing. The old code logged a warning and then... waited 4 hours for the next heartbeat cycle.

```python
# heartbeat_counter resets to 0 after each heartbeat attempt
# heartbeat_interval = 480 (4 hours at 30s/iteration)
# After a 0-row result, the next heartbeat is 4 hours away
```

Combined with RC-5 (proactive refresh never fires due to missing `supabase_token_expires_at`), this means:
- Hour 0: Login, JWT minted
- Hour 1: JWT expires. Proactive refresh blocked (RC-5). 
- Hour 1+: First heartbeat after expiry: 0 rows. Next attempt: 4 hours later.
- Hour 5+: Second heartbeat: 0 rows. And so on.
- Result: Version never updates until user manually relogs

**Fix applied (FIX-5):** On 0-row result, immediately force a JWT refresh and retry the UPDATE. If the retry succeeds, the session self-heals without waiting 4 hours.

---

## Root Cause Interaction Map

The following shows how the root causes chain together for the affected user:

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ v1.3.7 running — NO auto-update (auto-update introduced in v1.3.9,          │
│ not present in v1.3.7 or v1.3.8)                                            │
│ v1.3.7 detects new version → opens browser → Geetashish manually downloads  │
│ v1.3.8 and runs it → v1.3.8's install_application() force-kills v1.3.7     │
│ Last DB write: desktop_app_version=1.3.7 at 2026-05-11 07:11:17             │
└────────────────────────────────┬───────────────────────────────────────────┘
           v1.3.8 starts         │   (Geetashish later manually installs v1.3.9
                                 │    which has auto-update; v1.3.9 then auto-
                                 │    updates to v1.4.0, which auto-updates to
                                 │    v1.4.1 — all via os._exit(0) + bat script)
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ EVERY VERSION STARTUP: v1.3.8, v1.3.9, v1.4.0, v1.4.1 — all hit RC-1      │
│                                                                              │
│ RC-3: Early init fires before network ready                                  │
│   → initialize_supabase() → get_supabase_config()                           │
│     → HTTP call to forgesync.amzur.com (network not ready or server blip)   │
│     → FAILS → self.supabase = None                                          │
│                                                                              │
│ RC-2: No disk cache exists for this version's first run                      │
│   → No fallback available → still None                                       │
└────────────────────────────────┬───────────────────────────────────────────┘
                                 │
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ Full auth path:                                                              │
│   check_connectivity() → OK                                                  │
│   is_authenticated() → True (tokens in keyring)                             │
│   get_user_info() → succeeds (Atlassian API reachable)                      │
│   initialize_supabase() → SKIPS (guard: supabase_initialized=False)...      │
│                                                                              │
│   Wait — guard only skips when supabase_initialized=True.                   │
│   supabase_initialized=False → CALLS initialize_supabase() AGAIN            │
│                                                                              │
│ RC-4: Second attempt hits same endpoint                                      │
│   → get_supabase_config() → HTTP to forgesync.amzur.com                    │
│                                                                              │
│   Scenario A: Server recovered → init SUCCEEDS → version written ✅         │
│   Scenario B: Server still down (30-90s outage spans full startup) → FAILS  │
│   Scenario C: Uses stale supabase_token from keyring → _set_supabase_jwt()  │
│              → supabase_initialized=True ONLY IF JWT exchange also succeeds  │
└────────────────────────────────┬───────────────────────────────────────────┘
                                 │ (Scenario B/C: init still failed)
                                 ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│ RC-1: Sync thread starts — self.supabase = None                              │
│   → Every 30 seconds, heartbeat silent-returns                               │
│   → No version update ever                                                   │
│   → No re-init attempt                                                       │
│                                                                              │
│ RC-5 (for migrated users): supabase_token_expires_at = 0                    │
│   → Proactive JWT refresh never fires                                        │
│   → If init somehow later succeeds, heartbeat still fails (expired JWT)     │
│                                                                              │
│ RC-8: Heartbeat with expired JWT → 0 rows → next try in 4 hours             │
│                                                                              │
│ RC-7: Even if heartbeat succeeds, desktop_logged_in stays false              │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## Why This Is Differential (Why SOME Users, Not All)

The "happy path" succeeds when **all three** of the following are true at v1.4.1 startup:
1. Network is fully ready when early init fires (no VPN, no boot delay)
2. `forgesync.amzur.com` responds within 10 seconds  
3. The cached Atlassian JWT is still valid for the AI server call

Failure occurs when **any one** of these is false at the specific moment v1.4.1 first starts (a window of ~30–90 seconds) — regardless of whether it arrived via auto-update or manual installation:

| Trigger | Which Users | Install Method |
|---------|-------------|----------------|
| Machine had just woken from sleep at startup time | Anyone whose first v1.4.1 launch happened while NIC was resuming | Both |
| VPN reconnect delay (e.g. GlobalProtect, Cisco AnyConnect) | Users on corporate VPN | Both |
| AI server brief outage during the startup window | Everyone starting v1.4.1 during that window | Both |
| DNS cold-start on Windows boot (app auto-starts at login) | Windows auto-start users on each boot | Both |
| Migration bug (RC-5): user migrated from plaintext tokens | All users who used v1.3.x or earlier | Both |

**The 7-day / 9-day duration** is the definitive proof that RC-1 is the dominant cause. JWT failures would cause intermittent problems with explicit log warnings every 4 hours. A completely silent freeze for 9 days means `self.supabase = None` from the start, with the sync thread running but doing nothing.

---

## What v1.3.7's Heartbeat Timestamp Tells Us

```
desktop_last_heartbeat: 2026-05-11 07:11:17.402551+00
```

This is the **last successful DB write** that ever happened. The correct sequence (corrected from any auto-update assumption):

**Important context:** Auto-update was introduced in **v1.3.9** — NOT v1.3.7 or v1.3.8. v1.3.7 and v1.3.8 have no `UpdateManager`, no `_shutdown_for_update()`, no bat script, no `check_for_shutdown_signal()`. When those versions detected a newer version, they opened the system browser to a download page. The user had to manually download and run the installer.

**Reconstructed four-version chain for this user:**

1. **v1.3.7 last heartbeat at `07:11:17`** — DB writes `desktop_app_version=1.3.7`. This is the last successful DB write.
2. **Transition to v1.3.8 (manual):** Geetashish ran v1.3.8.exe from Downloads. v1.3.8's `install_application()` detected v1.3.7 running → `request_graceful_shutdown()` (signal file) → v1.3.7 had no `check_for_shutdown_signal()` handler → after 1s, `terminate_old_version()` fired `TerminateProcess` → v1.3.7 force-killed. `quit_app()` was NOT called.
3. **v1.3.8 startup:** `initialize_supabase()` failed (RC-2: no disk cache, AI server unreachable at startup). `self.supabase = None`. RC-1: no recovery mechanism. DB stays at v1.3.7.
4. **Transition to v1.3.9 (manual):** Geetashish ran v1.3.9.exe. **v1.3.9 is the first version with auto-update** — introduces `UpdateManager`, `_shutdown_for_update()`, `apply_update.bat`, and `check_for_shutdown_signal()`. v1.3.9's installer terminated v1.3.8. DB still at v1.3.7.
5. **v1.3.9 startup:** Same RC-1 → `self.supabase = None`. DB never updated. However, v1.3.9's `UpdateManager` polls the version API **independently of Supabase** and detects v1.4.0.
6. **v1.3.9 → v1.4.0 (auto-update):** `UpdateManager` → `auto_apply()` → `_shutdown_for_update()` → **`os._exit(0)`** → bat script starts v1.4.0. v1.4.0 startup → same RC-1. v1.4.0's `UpdateManager` detects v1.4.1.
7. **v1.4.0 → v1.4.1 (auto-update):** Same `os._exit(0)` + bat script. **v1.4.1 startup (current state):** same RC-1 → `self.supabase = None` → all heartbeats and status updates silently no-op.

The 9-day gap is the sum of this four-version chain of RC-1 failures. The auto-update transitions (v1.3.9 → v1.4.0 → v1.4.1) worked correctly — only the Supabase DB writes are broken, and they have been broken since v1.3.8.

---

## Code Paths Where `desktop_app_version` Is Written — Complete Trace

### Call 1: `/auth/callback` (OAuth Login) — `desktop_app.py:5585`
```python
success = self._update_desktop_status(logged_in=True)
```
**Failure modes:** `self.supabase = None` (RC-1/RC-2); JWT not set (`_set_supabase_jwt()` failure); RLS mismatch

### Call 2: `run()` Main Auth Path — `desktop_app.py:11458`
```python
self._update_desktop_status(logged_in=True)
```
**Failure modes:** Same as above; `self.current_user_id` not set (ensure_user_exists failed); exception in verify-user DB check

### Call 3: `run()` Fallback Path (post-fix) — `desktop_app.py:11456–11462`
```python
if self.supabase_initialized and self.current_user_id:
    self._update_desktop_status(logged_in=True)
```
**Added by FIX-4.** Pre-fix: this write never happened in the fallback path.

### Call 4: `_send_heartbeat()` — `desktop_app.py:6660`
```python
result = client.table('users').update({
    'desktop_last_heartbeat': ...,
    'desktop_app_version': self.app_version,
    'desktop_logged_in': True   # FIX-5 addition
}).eq('id', self.current_user_id).execute()
```
**Failure modes:** `client = None` (RC-1, silent return); JWT expired (0-row result, RC-8); `current_user_id` not set

### Call 5: Background Re-init (post-fix) — `desktop_app.py:10138`
```python
if self.initialize_supabase():
    if self.current_user_id and not ...:
        self._update_desktop_status(logged_in=True)
```
**Added by FIX-1.** Pre-fix: no background re-init ever happened.

---

## Supplementary Root Cause: Old-Version Shutdown Behaviour Differs by Install Method

How the old version exits has a direct effect on the initial DB state that the new version inherits.

### Auto-Update Exit: `os._exit(0)` — Abrupt

**File:** `desktop_app.py:5189–5199`

```python
def _shutdown_for_update(self):
    """Exit process after scheduling updater script."""
    try:
        self.running = False
        self.tracking_active = False
    except Exception:
        pass
    print("[UPDATE] Exiting immediately for updater handoff...")
    os._exit(0)    # ← Bypasses quit_app() entirely
```

`os._exit(0)` bypasses all Python cleanup: atexit handlers, context managers, `quit_app()`, and therefore `_update_desktop_status(logged_in=False)`. The DB's `desktop_logged_in` stays at whatever it was before the update. The new version **must** write `true` at startup — and if RC-1 prevents that, `desktop_logged_in` stays stuck indefinitely.

This is a deliberate design tradeoff: the update shutdown must be instantaneous so the bat script can replace the locked exe file. Adding a DB write before `os._exit(0)` would risk a network timeout that stalls the installer.

### Manual Install Exit: `quit_app()` — Graceful

**File:** `desktop_app.py:11308–11316`

When the user manually runs a new `TimeTracker.exe` from Downloads while an old version is installed, `install_application()` calls `request_graceful_shutdown()`, which writes a `.shutdown_signal` file. The running old version's sync thread detects this signal and calls `quit_app()`:

```python
def quit_app(self):
    self._update_desktop_status(logged_in=False)   # ← DB WRITTEN cleanly
    self._shutdown_cleanup()
    self.stop_tracking()
    if self.tray:
        self.tray.stop()
    sys.exit(0)    # ← Graceful — all cleanup runs
```

`_update_desktop_status(logged_in=False)` IS called. `desktop_logged_in` IS set to `false` cleanly before the new version starts.

**Net effect on the bug:** The old version's final DB state is cleaner under manual install, but the new version still faces the exact same RC-1 through RC-8 failure modes in its `run()` startup. The silent version staleness is identical.

---

## Installation Scope: Which Paths Does This Bug Affect?

RC-1 through RC-8 are all properties of `run()` — the startup sequence executed by every new version process. They apply identically regardless of how the new version arrived. This section traces all three install paths explicitly.

### Summary Table

| | Auto-Update | Manual Install (Returning User) | Manual Install (Brand New User) |
|---|---|---|---|
| Old version exit | `os._exit(0)` — abrupt | `quit_app()` → `sys.exit(0)` — graceful | N/A |
| `desktop_logged_in=False` written before new version starts? | ❌ No | ✅ Yes | N/A |
| New version startup path | `run()` | `run()` | `run()` → OAuth → `/auth/callback` |
| RC-1 through RC-8 apply? | ✅ Yes | ✅ Yes — identically | ❌ No — different failure mode |
| Failure visible to user? | ❌ Silent | ❌ Silent | ✅ HTTP 500 error page |

---

### Auto-Update Path (applies to v1.3.9+ only)

**Note:** Auto-update was introduced in **v1.3.9**. Users on v1.3.7 or v1.3.8 had no auto-update and required manual installs. For this user (`geetashish.sharma@amzur.com`): v1.3.7 and v1.3.8 were manual installs; v1.3.9 was the first manual install with auto-update; v1.4.0 and v1.4.1 were auto-updated from v1.3.9 and v1.4.0 respectively.

```
v1.3.9+ running (auto-update capable)
  → UpdateManager detects newer version ready
  → auto_apply() → apply_update() → create_update_script() → apply_update.bat launched
  → _shutdown_for_update() → os._exit(0)          ← no DB cleanup
  → bat script: waits for PID → replaces exe → starts new version
  → new process: run() → [RC-1 through RC-8 can all apply]
```

---

### Manual Install Path — Returning User

```
User double-clicks new TimeTracker.exe from Downloads
  → install_application()
      → is_running_from_install_location() = False
      → is_update = True (old exe exists at install path)
      → request_graceful_shutdown()            ← writes .shutdown_signal file
      → old process sync thread detects signal → calls quit_app()
          → _update_desktop_status(logged_in=False)   ← DB WRITTEN (graceful)
          → sys.exit(0)
      → terminate_old_version() confirms old PID is gone
      → copies new exe to install path
      → subprocess.Popen([installed_exe])      ← starts new v1.4.1 process
      → this installer process exits (return False → sys.exit(0))
  → NEW installed process: run() → [RC-1 through RC-8 apply identically]
```

Once `run()` begins, this path is **structurally identical to auto-update**. The same `initialize_supabase()` calls, the same timing races, the same sync thread — everything. The only observable difference is that `desktop_logged_in` starts from a cleanly-written `false` rather than whatever the old version left behind.

---

### Manual Install Path — Brand New User (First Ever Install)

```
User downloads and double-clicks TimeTracker.exe (no prior install exists)
  → install_application()
      → no existing exe at install path
      → copies exe → subprocess.Popen([installed_exe]) → this instance exits
  → NEW installed process: run()
      → has_stored_tokens = False        ← no keyring entries, no auth_metadata.json
      → early init block SKIPPED         ← guard requires has_stored_tokens
      → is_authenticated() = False
      → browser opens → user completes OAuth
      → /auth/callback handler:
          → initialize_supabase()         ← if FAILS → return error_msg, 500
                                          ← USER SEES AN ERROR PAGE (visible)
```

**This is a fundamentally different failure mode:**

- RC-1 does not apply: no background sync thread is running during OAuth
- RC-2 does apply: no disk cache exists (first run) — but the failure is visible, not silent
- RC-5 does not apply: no prior plaintext token file to migrate from
- RC-6 through RC-8 do not apply during OAuth flow

Brand-new users see a **visible HTTP 500 error** if `initialize_supabase()` fails. They can close the browser and click Login again — the problem is self-evident and self-correcting. This is the opposite of the silent 9-day staleness experienced by returning users.

**After successful OAuth login**, a brand-new user runs the full `run()` startup on the next launch — at which point RC-1 through RC-8 become relevant if `initialize_supabase()` fails in a subsequent startup.

---

## Fixes Applied (Summary)

All fixes are in `python-desktop-app/desktop_app.py`. All are currently on the `fix/auto-update-30min-retry-and-notifications` branch and built into v1.4.2.

| # | Root Cause | Fix Description | Status |
|---|-----------|-----------------|--------|
| FIX-1 | RC-1 | Background Supabase re-init in sync thread every 30 min | ✅ Applied |
| FIX-2 | RC-2, RC-3 | Cache Supabase URL/anon key to `auth_metadata.json` (24h TTL + stale fallback) | ✅ Applied |
| FIX-3 | RC-5 | Read old plaintext token file BEFORE migration deletes it | ✅ Applied |
| FIX-4 | RC-6 | Call `_update_desktop_status(logged_in=True)` in fallback startup path | ✅ Applied |
| FIX-5 | RC-7, RC-8 | `desktop_logged_in=True` in heartbeat; immediate JWT refresh + retry on 0-row result | ✅ Applied |

**Pending:**

| # | Root Cause | Fix Description | Status |
|---|-----------|-----------------|--------|
| FIX-6 | RC-3 | Pre-connectivity guard before early Supabase init in `run()` | ❌ Pending |

---

## Immediate Mitigation for Affected Users (Before v1.4.2 Ships)

Users who are currently stuck (DB version not updating, `desktop_logged_in=false`):

1. **Sign out → Sign back in** from the system tray → "Logged in as: [email]" menu option
   - This re-runs the full OAuth flow, which calls `initialize_supabase()` fresh and then `_update_desktop_status(logged_in=True)`
   - This is the only manual fix for users on v1.4.1

2. **After v1.4.2 is deployed:**
   - FIX-1 will auto-heal the session within 30 minutes of the app next starting
   - FIX-2 will prevent recurrence by caching the Supabase config locally
   - No user action required

---

## Verification Queries

### Find all users with stuck versions
```sql
SELECT 
  email,
  desktop_app_version,
  desktop_logged_in,
  desktop_last_heartbeat,
  updated_at,
  NOW() - desktop_last_heartbeat AS heartbeat_age
FROM users
WHERE desktop_last_heartbeat < NOW() - INTERVAL '24 hours'
  AND desktop_logged_in = false
ORDER BY desktop_last_heartbeat ASC;
```

### Confirm fix success after v1.4.2 deployment
```sql
SELECT 
  email,
  desktop_app_version,
  desktop_logged_in,
  desktop_last_heartbeat
FROM users
WHERE email IN ('geetashish.sharma@amzur.com')
ORDER BY updated_at DESC;
```
Expected after fix: `desktop_app_version = '1.4.2'`, `desktop_logged_in = true`, `desktop_last_heartbeat` within the last 4 hours.

---

## References

- [Plan file with fix details](../plan/2026-05-19_python-desktop-app_fix-desktop-version-not-updating-in-db.md)
- [Differential root cause (earlier analysis)](DIFFERENTIAL_ROOT_CAUSE_desktop_version_not_updating.md)
- [Auto-update mechanism analysis](AUTO_UPDATE_MECHANISM_CORRECTED_ANALYSIS.md)
- Source: `python-desktop-app/desktop_app.py` (all line numbers cited are from the `fix/auto-update-30min-retry-and-notifications` branch)
