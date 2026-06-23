# Location Detection v2 — Implementation Plan

**Date:** 2026-06-22
**Components:** python-desktop-app, supabase
**Status:** Proposed — awaiting review
**Replaces:** `plan/Location Detection Feature — Implementation Plan.md`

---

## Why this plan replaces the original

The original plan (`Location Detection Feature — Implementation Plan.md`) has four blocking
problems documented in Section 11. This plan fixes all four. It also adopts a fundamentally
better storage design — a dedicated `user_location_log` table instead of embedding location
in every `activity_records` row — which avoids JSONB redundancy, simplifies GDPR deletion,
and keeps the activity upload path completely untouched.

**Key design change from the first draft of v2:**
The initial v2 draft stored location in `metadata` JSONB on each `activity_records` row
(one location object per batch, every 5 minutes). That was still redundant: the same city
and country object would be copied into hundreds of rows per day. Location is a property of
the user at a point in time, not a property of each individual activity window. The correct
model is a separate time-series table written once every 4 hours, completely independent of
the batch upload cycle.

---

## 1. Scope & goals

### 1.1 Feature overview

Add reliable work-location detection to the desktop app. Every 4 hours the desktop app
detects where the user is working and writes one row to a new `user_location_log` table in
Supabase. This loop runs entirely independently of the activity batch upload cycle.

The feature answers two questions:
- **Is this person in the office or working remotely?** (answered by Tier 1 — WiFi SSID /
  LAN subnet matching against an admin-configured list)
- **Which city and country are they in?** (answered by Tier 2 — IP geolocation via
  ipinfo.io, only when Tier 1 has not already confirmed "office")

Components touched: `python-desktop-app` (new `LocationDetector` class, new
`_location_log_loop()` background task, consent page update, tracking-settings read path),
`supabase` (two migrations: one new table, one column addition to `tracking_settings`).

Components **not** touched: `ai-server`, `forge-app`, `activity-webhook`,
`activity_records` table.

Primary personas affected: desktop app user (passive — no action required), org admin
(configures office network identifiers directly in Supabase until Forge UI lands in v3),
manager (queries `user_location_log` for location analytics — deferred to v3 portal work).

### 1.2 In scope

- New `LocationDetector` class in `desktop_app.py` implementing 3-tier detection.
- Tier 1a — WiFi SSID detection via `netsh wlan show interfaces` (Windows built-in, zero
  new dependency). Compares connected SSID against `tracking_settings.office_ssid_names`.
- Tier 1b — LAN subnet detection via Python `ipaddress` stdlib and `socket.gethostbyname`.
  Compares local IP against `tracking_settings.office_subnet_prefixes`.
- Tier 2 — IP geolocation via `https://ipinfo.io/json` (HTTPS, commercial use permitted on
  free tier, 50 k requests/month). Returns city, region, country. Used only when Tier 1
  does not determine the result.
- Fail-open: if all detection fails, no row is inserted for that cycle. The batch upload
  cycle is not affected in any way.
- New `_location_log_loop()` background task in `TimeTracker`. Runs every 4 hours on a
  dedicated daemon thread. Calls `LocationDetector.get_location()` and INSERTs one row to
  `user_location_log`. Completely independent of `upload_activity_batch()`.
- New `_insert_location_log()` helper method in `TimeTracker`. Builds the INSERT payload
  and handles exceptions.
- `upload_activity_batch()` is **not modified**. No `location` key is added to `metadata`.
- Supabase migration 1: create `user_location_log` table with RLS and indexes.
- Supabase migration 2: add `location_detection_enabled`, `office_ssid_names`, and
  `office_subnet_prefixes` columns to `tracking_settings` (org-level only).
- `fetch_tracking_settings()` reads the three new columns (with `_nvl` defaults).
- `render_consent_page()` updated to disclose location collection — required for GDPR.
- New test file `tests/test_location_detector.py`.

### 1.3 Out of scope

- Any change to `activity_records` table or its `metadata` JSONB column. Location is not
  stored there. This is intentional — see Section 6 for the rationale.
- Forge app Settings UI for admins to configure office SSIDs and subnets. Admins must
  currently set these values directly via Supabase dashboard or SQL. The UI is planned as
  v3 after the data is validated.
- Portal dashboard changes to display or filter by work location. Deferred to v3.
- Linux or macOS builds. SSID detection uses the Windows `netsh` command. On non-Windows
  the SSID tier is skipped silently; IP geolocation (Tier 2) still runs.
- GPS or hardware-based location. This is a desktop time tracker, not a mobile app.
- VPN detection. If a user is on corporate VPN and the company has not configured
  `office_ssid_names` or `office_subnet_prefixes`, the IP geolocation result reflects
  the VPN exit node, not the user's physical location. Documented in Section 11 (Risks).

---

## 2. Assumptions & dependencies

### 2.1 Assumptions

- `tracking_settings` table exists and has `organization_id`, `project_key` columns as
  defined in `20260220_tracking_settings_project_level.sql` (already applied).
- `fetch_tracking_settings()` in `desktop_app.py` builds a `fetched_settings` dict and
  caches it in `self.tracking_settings_cache`. `self.tracking_settings` is a `@property`
  (not a plain dict attribute) that returns `get_tracking_settings_for_project(
  self.current_project_key)`, which reads from that cache. The three new columns are
  read inside `fetch_tracking_settings()` and coalesced with `_nvl`.
- `self.default_tracking_settings` (set in `__init__`) is the fallback dict used when
  the network is unavailable. The three new location keys must also be added there.
- `upload_activity_batch()` is not modified by this plan. The `metadata` dict it already
  builds (`tracking_mode`, `app_version`, `user_projects`) is unchanged.
- `self.current_user_id` and `self.organization_id` are available on `TimeTracker` when
  `_location_log_loop()` runs. The loop guards against `None` AND against anonymous users
  (`current_user_id` starting with `anonymous_`), because anonymous IDs are not valid
  UUIDs and have no `public.users` row — an INSERT would violate the FK.
- `self.supabase` (the Supabase client) is available and initialised before
  `_location_log_loop()` runs. The loop guards against `not self.supabase_initialized`.
- The desktop app runs on Windows for Tier 1a (SSID). Non-Windows skips Tier 1a silently.
- `requests` is already a dependency. No new package for Tier 2.
- `subprocess`, `socket`, `requests`, `threading` are already imported. `ipaddress` is
  stdlib but was NOT yet imported — one new `import ipaddress` line is added near the
  existing `import socket` (the only new import this feature requires).
- `_location_log_loop()` is started from `_start_activity_monitor()` (not from
  `start_sync_thread()`), because `start_sync_thread()` is re-called whenever the sync
  thread dies and would create duplicate location threads without a guard at that level.
  `_start_activity_monitor()` is where the sync thread itself is also guarded and started,
  making it the correct and consistent place to add the location thread.
- The new columns added to `tracking_settings` have safe non-null defaults so existing
  rows work without a data migration:
  `location_detection_enabled DEFAULT TRUE`,
  `office_ssid_names DEFAULT '{}'::TEXT[]`,
  `office_subnet_prefixes DEFAULT '{}'::TEXT[]`.

### 2.2 Dependencies

- Migration `20260220_tracking_settings_project_level.sql` must already be applied (it is).
- `users` and `organizations` tables must exist (they do — they are base tables referenced
  by `activity_records` and all other tables).
- ipinfo.io free tier: 50,000 requests/month. At one call per device per 4 hours, a fleet
  of 100 active devices generates approximately 18,000 calls/month — well within the free
  tier. Fleets above ~280 active devices will exceed 50,000 calls/month and require the
  ipinfo.io Basic plan (~$99/month as of 2026-06). See R1 in Section 11.
- No changes to `activity-webhook/index.ts`, `ai-server`, or `forge-app` are required.

---

## 3. UI layouts

### 3.1 User flows

The user has no action to take. Location detection is silent and passive.

The only user-visible change is the updated consent page, seen at first install or after a
consent reset. They read the updated disclosure and click "I Agree" as before. No new
button, checkbox, or prompt is introduced.

### 3.2 Screens and components

**Consent page (`render_consent_page()` in `desktop_app.py`)**

The "Data We Collect" section (`<div class="section">`) currently has five
`<div class="data-item">` entries: Screenshots, Window Titles, Application Names,
Timestamps, Jira Issue Data. Add a sixth entry immediately after the "Jira Issue Data"
item and before the closing `</div>` of the section:

```html
<div class="data-item">
    <span class="data-icon">📍</span>
    <div class="data-text">
        <strong>Approximate Work Location</strong>
        <span>Whether you are working from the office or remotely (city and country
        when detected via IP), captured at most once every 4 hours. Detected from
        your WiFi network name or IP address.</span>
    </div>
</div>
```

The "Third-Party Processing" section (`<div class="section third-party">`) currently
lists OpenAI and Supabase as `<div class="data-item">` entries. Add a third entry after
the Supabase item:

```html
<div class="data-item">
    <span class="data-icon">🌐</span>
    <div class="data-text">
        <strong>ipinfo.io</strong>
        <span>Used to determine your approximate city and country from your IP address
        when you are not on a recognised office network. Your IP address is sent to
        ipinfo.io for this lookup only.</span>
    </div>
</div>
```

No layout or CSS changes. The new items use the existing `.data-item` / `.data-icon` /
`.data-text` classes already defined in `render_consent_page()`.

**Admin dashboard (`render_admin_dashboard()` in `desktop_app.py`)**

No change required for Phase 1.

---

## 4. File and function names (physical structure)

```
python-desktop-app/
  desktop_app.py                        ← modified
tests/
  test_location_detector.py             ← new
```

```
supabase/
  migrations/
    20260622_create_user_location_log.sql          ← new
    20260622_add_location_to_tracking_settings.sql ← new
```

### 4.1 Forge app — not modified

### 4.2 AI server — not modified

### 4.3 Python desktop app (`python-desktop-app/desktop_app.py`)

---

#### New class: `LocationDetector`

Place alongside the other utility/manager classes near `AppClassificationManager`. This
class is self-contained: it has no reference to `TimeTracker` and no internal state. It
takes the office network lists as arguments to `get_location()` so it can be unit-tested
without a live `TimeTracker` instance.

There is no cache inside this class. The calling loop (`_location_log_loop`) controls the
4-hour interval — it is the cache. A stateless detector is simpler and easier to test.

**Constants (module-level, near other constants):**

```
LOCATION_LOG_INTERVAL_SECONDS = 14400   # 4 hours
IPINFO_URL                    = "https://ipinfo.io/json"
IPINFO_TIMEOUT_SECONDS        = 5
NETSH_TIMEOUT_SECONDS         = 3
```

**Methods:**

- `LocationDetector.__init__(self)`
  No state. Empty body (or `pass`).

- `LocationDetector.get_location(self, office_ssids: list, office_subnets: list) -> dict | None`
  Public entry point called by `_location_log_loop()`. Runs the 3-tier sequence. Returns
  a location dict on success or `None` on total failure. Never raises. Logs at DEBUG only.

  Execution order:
  1. Tier 1a: `_get_current_ssid()` → check against `office_ssids` → if match, return
     office dict immediately (no IP lookup).
  2. Tier 1b: `_get_local_ip()` → `_is_in_office_subnet()` → if match, return office
     dict immediately (no IP lookup).
  3. Tier 2: `_fetch_ipinfo()` → return remote dict or `None`.

- `LocationDetector._get_current_ssid(self) -> str | None`
  Calls `subprocess.run(['netsh', 'wlan', 'show', 'interfaces'], capture_output=True,
  text=True, timeout=NETSH_TIMEOUT_SECONDS)`. Parses the line containing `'SSID'` that
  does NOT contain `'BSSID'` (the BSSID line appears first — skip it). Returns the trimmed
  SSID string or `None` on any failure. Catches all exceptions.

- `LocationDetector._get_local_ip(self) -> str | None`
  Calls `socket.gethostbyname(socket.gethostname())`. Returns the local IPv4 string or
  `None` on any exception.

- `LocationDetector._is_in_office_subnet(self, local_ip: str, office_subnets: list) -> bool`
  Iterates `office_subnets`. For each entry: `ipaddress.ip_address(local_ip) in
  ipaddress.ip_network(entry, strict=False)`. Returns `True` on first match. Skips
  malformed entries (logs at DEBUG). Returns `False` if no match or list is empty.

- `LocationDetector._fetch_ipinfo(self) -> dict | None`
  Issues `requests.get(IPINFO_URL, timeout=IPINFO_TIMEOUT_SECONDS)`. On HTTP 200 builds
  and returns the location dict (see Section 5 for the shape). Returns `None` on any
  non-200 status or exception.

---

#### New method: `TimeTracker._location_log_loop(self)`

Background daemon thread method. Started once from `_start_activity_monitor()`.

Canonical structure (explicit pseudocode, no ambiguity):

```python
def _location_log_loop(self):
    """Background loop: snapshot work location every 4 hours into user_location_log."""
    while self.running:
        try:
            # GUARD 1: must have a REAL, logged-in user.
            # Anonymous users (current_user_id == 'anonymous_xxx') are NOT valid UUIDs
            # and have no row in public.users — an INSERT would violate the FK.
            # This mirrors the heartbeat guard in start_sync_thread() (line ~12034)
            # and _update_desktop_status() (line ~8222).
            if (self.current_user_id
                    and not self.current_user_id.startswith('anonymous_')
                    and self.supabase_initialized):

                # GUARD 2: read ORG-LEVEL settings from the org-default cache,
                # NOT self.tracking_settings (which returns project-level settings
                # and could mask an org-level location_detection_enabled = FALSE).
                org_settings = self.tracking_settings_cache.get(
                    '_org_default', self.default_tracking_settings)

                if org_settings.get('location_detection_enabled', True):
                    office_ssids   = org_settings.get('office_ssid_names', [])
                    office_subnets = org_settings.get('office_subnet_prefixes', [])
                    result = self.location_detector.get_location(
                        office_ssids=office_ssids, office_subnets=office_subnets)
                    if result:
                        self._insert_location_log(result)
                    # else: detection returned None — skip INSERT this cycle (DEBUG log)
        except Exception as e:
            # Never propagate — log and continue to the next cycle.
            print(f"[WARN] Location log loop error: {e}")

        # Sleep 4 hours in 60-second increments so the thread exits within ~60s
        # of self.running going False at shutdown.
        slept = 0
        while slept < LOCATION_LOG_INTERVAL_SECONDS and self.running:
            time.sleep(60)
            slept += 60
```

Behaviour notes:
- The first detection runs immediately on thread start (no initial sleep), so the first
  snapshot is captured at startup, not 4 hours later.
- Loop is gated by `while self.running` (matches the tracking-session lifecycle — the
  thread is created in `_start_activity_monitor()` after `start_tracking()` sets
  `self.running = True`, and exits when `stop_tracking()` sets it `False`). On a later
  re-start of tracking, `_start_activity_monitor()` recreates the thread via its
  `is_alive()` guard.
- **Anonymous-user guard is mandatory** — anonymous tracking is a supported mode
  ([desktop_app.py:12604](python-desktop-app/desktop_app.py#L12604)); without this guard
  the INSERT fails the `user_id` FK every cycle.
- `'_org_default'` is populated by `fetch_tracking_settings(None)`, called whenever
  `self.current_project_key` is `None` (always true at startup before first project
  detection) and on the admin "refresh_settings" action. If it has not been populated yet,
  the `.get('_org_default', self.default_tracking_settings)` fallback yields the safe
  defaults (`location_detection_enabled = True`, empty office lists → Tier 2 IP geo).

---

#### New method: `TimeTracker._insert_location_log(self, location: dict)`

Helper called only from `_location_log_loop()`. Builds and executes the Supabase INSERT.

Payload columns:

```python
{
    'user_id':              self.current_user_id,
    'organization_id':      self.organization_id,
    'recorded_at':          datetime.now(timezone.utc).isoformat(),
    'work_location_type':   location.get('work_location_type'),
    'work_location_source': location.get('work_location_source'),
    'city':                 location.get('city'),
    'region':               location.get('region'),
    'country':              location.get('country'),
    'country_code':         location.get('country_code'),
    'ip':                   location.get('ip'),   # None for office detections
}
```

Uses `self.supabase.table('user_location_log').insert(payload).execute()`. Catches all
exceptions and logs at WARNING. Does not retry — the next loop cycle will try again in
4 hours.

---

#### Wiring: `TimeTracker.__init__`

Add alongside the other manager instantiations (near `self.session_manager`,
`self.classification_manager` at lines 6188-6189):

```python
self.location_detector = LocationDetector()
```

Also add alongside `self._sync_thread = None` (line 6178) so the guard in
`_start_activity_monitor()` can check whether the location thread is already alive:

```python
self._location_thread = None
```

---

#### Wiring: `fetch_tracking_settings()`

The method already uses `SELECT *` so new columns are returned automatically. The
`fetched_settings` dict built inside the method (after line 9627 in the current code)
needs three new entries. Add them at the end of the existing `fetched_settings` literal:

```python
fetched_settings = {
    # ... existing keys unchanged (screenshot_monitoring_enabled, tracking_mode, etc.) ...
    'location_detection_enabled': _nvl(settings.get('location_detection_enabled'), True),
    'office_ssid_names':          _nvl(settings.get('office_ssid_names'), []),
    'office_subnet_prefixes':     _nvl(settings.get('office_subnet_prefixes'), []),
}
```

Also update `self.default_tracking_settings` in `__init__` (the fallback used when the
network is unavailable) to include the same three keys:

```python
self.default_tracking_settings = {
    # ... existing keys unchanged ...
    'location_detection_enabled': True,
    'office_ssid_names':          [],
    'office_subnet_prefixes':     [],
}
```

No cache invalidation call needed. `LocationDetector` is stateless and reads the
settings passed to it by `_location_log_loop()` on each call. The next loop cycle
reads fresh settings from `tracking_settings_cache['_org_default']`.

---

#### Wiring: `_start_activity_monitor()`

**Do NOT wire into `start_sync_thread()`.**  `start_sync_thread()` is re-called by
`_start_activity_monitor()` every time the sync thread dies; wiring there would spawn
a duplicate location thread on each restart.

The correct place is `_start_activity_monitor()`, immediately after the existing sync
thread guard (after line 12655 in the current code). Follow the exact same guard
pattern used for `self._sync_thread`:

```python
# Start location log thread
if not self._location_thread or not self._location_thread.is_alive():
    self._location_thread = threading.Thread(
        target=self._location_log_loop,
        name='location-log',
        daemon=True
    )
    self._location_thread.start()
    print("[OK] Location log background thread started")
```

Storing the reference in `self._location_thread` is required so the `is_alive()` guard
works correctly on subsequent calls to `_start_activity_monitor()`.

---

#### `upload_activity_batch()` — NOT MODIFIED

No changes. The `metadata` dict in `upload_activity_batch()` remains exactly as it is
today: `{tracking_mode, app_version, user_projects}`. No `location` key is added.

---

#### Consent page update (`render_consent_page()`)

See Section 3.2 for the exact HTML bullet points to add.

---

### 4.4 Supabase (`supabase/`)

**Two new migration files** (see Section 7 for full SQL content):

- `20260622_create_user_location_log.sql` — creates the `user_location_log` table, indexes,
  and RLS policies.
- `20260622_add_location_to_tracking_settings.sql` — adds three columns to
  `tracking_settings`.

---

## 5. API contracts

### 5.1 Forge app resolver API

Not applicable. No new resolvers in this plan.

### 5.2 AI server HTTP endpoints

Not applicable. No new or modified endpoints.

### 5.3 ipinfo.io external API

**URL:** `GET https://ipinfo.io/json`
**Auth:** None (anonymous free tier — 50 k req/month)
**Timeout:** 5 seconds
**Response (HTTP 200):**

```json
{
  "ip": "203.0.113.45",
  "city": "Austin",
  "region": "Texas",
  "country": "US",
  "org": "AS12345 Some ISP"
}
```

Fields consumed: `ip`, `city`, `region`, `country`.
Fields ignored: `org`, `timezone`, `loc` (lat/long — not stored, not needed).

---

### 5.4 `LocationDetector.get_location()` return shape

This dict is returned to `_location_log_loop()`, which maps each key directly to a column
in `user_location_log`.

**When Tier 1a matches (office via SSID):**
```python
{
    'work_location_type':   'office',
    'work_location_source': 'ssid',
    'city':         None,
    'region':       None,
    'country':      None,
    'country_code': None,
    'ip':           None,   # intentionally null — no IP stored for office detection
}
```

**When Tier 1b matches (office via subnet):**
```python
{
    'work_location_type':   'office',
    'work_location_source': 'subnet',
    'city':         None,
    'region':       None,
    'country':      None,
    'country_code': None,
    'ip':           None,
}
```

**When Tier 2 succeeds (IP geolocation):**
```python
{
    'work_location_type':   'remote',
    'work_location_source': 'ip_geo',
    'city':         'Austin',
    'region':       'Texas',
    'country':      'US',
    'country_code': 'US',
    'ip':           '203.0.113.45',
}
```

Note: `work_location_type` is `'remote'` for IP geo results because by this point Tier 1
has already confirmed the device is NOT on a known office network.

**When all detection fails:**
```python
None  # _location_log_loop skips the INSERT for this cycle
```

---

## 6. Database structure

### 6.1 Why a separate table (not metadata JSONB)

Location is a property of the user/device at a point in time, not a property of each
individual activity window. Embedding it in `activity_records.metadata` JSONB would:

- Copy the same `{city, country}` object into every row of every batch — hundreds of
  identical copies per user per day.
- Prevent index-based filtering (PostgreSQL cannot maintain statistics on JSONB field
  values; `WHERE metadata->>'city' = 'Austin'` always does a full sequential scan).
- Complicate GDPR erasure: deleting location data would require UPDATing thousands of
  `activity_records` rows per user instead of `DELETE FROM user_location_log WHERE
  user_id = $uid` (one statement).
- Make correction of a bad location entry require mass UPDATEs instead of one row fix.

A dedicated table with typed columns solves all four problems.

### 6.2 New table: `public.user_location_log`

| Column | Type | Default | Nullable | Notes |
|--------|------|---------|----------|-------|
| `id` | `UUID` | `gen_random_uuid()` | NO | Primary key |
| `user_id` | `UUID` | — | NO | FK → `users(id)` ON DELETE CASCADE |
| `organization_id` | `UUID` | — | NO | FK → `organizations(id)` ON DELETE CASCADE |
| `recorded_at` | `TIMESTAMPTZ` | `NOW()` | NO | When the snapshot was taken |
| `work_location_type` | `TEXT` | — | YES | `'office'` \| `'remote'` \| `'unknown'` |
| `work_location_source` | `TEXT` | — | YES | `'ssid'` \| `'subnet'` \| `'ip_geo'` |
| `city` | `TEXT` | — | YES | `null` for office detections |
| `region` | `TEXT` | — | YES | State / province |
| `country` | `TEXT` | — | YES | Two-letter ISO country code |
| `country_code` | `TEXT` | — | YES | Same as `country` (kept for clarity) |
| `ip` | `TEXT` | — | YES | `null` for office detections; populated only for `ip_geo` |

CHECK constraints:
- `work_location_type IN ('office', 'remote', 'unknown')`
- `work_location_source IN ('ssid', 'subnet', 'ip_geo')`

**Indexes:**

| Index name | Columns | Purpose |
|------------|---------|---------|
| `idx_location_log_user_time` | `(user_id, recorded_at DESC)` | "Latest location for user X" |
| `idx_location_log_org_time` | `(organization_id, recorded_at DESC)` | Org-wide analytics |
| `idx_location_log_org_date_type` | `(organization_id, work_location_type, recorded_at DESC)` | Filter an org by location type, newest first (plain columns — a `timestamptz::date` cast is STABLE, not IMMUTABLE, so it cannot be indexed) |

**RLS policies:**

| Policy | Operation | Condition |
|--------|-----------|-----------|
| `location_log_insert_own` | INSERT | `user_id = get_current_user_id()` |
| `location_log_select_own` | SELECT | `user_id = get_current_user_id()` |
| `location_log_select_org` | SELECT | `organization_id IN (SELECT organization_id FROM organization_members WHERE user_id = get_current_user_id())` |
| `location_log_service_role` | ALL | `auth.role() = 'service_role'` |

RLS enabled. No UPDATE or DELETE policy for users — rows are append-only from the desktop
app. Admins can delete via service role if correction is needed.

### 6.3 Changes to existing table: `public.tracking_settings`

Three new columns (org-level only — not used for project-level rows):

| Column | Type | Default | Nullable | Purpose |
|--------|------|---------|----------|---------|
| `location_detection_enabled` | `BOOLEAN` | `TRUE` | NO | Org-level toggle. `FALSE` disables all location detection for the org. |
| `office_ssid_names` | `TEXT[]` | `'{}'::TEXT[]` | NO | WiFi SSIDs that identify office networks. Case-sensitive. |
| `office_subnet_prefixes` | `TEXT[]` | `'{}'::TEXT[]` | NO | CIDR ranges that identify office LANs (covers wired Ethernet). |

No new indexes. The columns are read in the existing `tracking_settings` SELECT which
already has indexes on `(organization_id, project_key)`.

No RLS policy changes. Existing policies on `tracking_settings` already cover all columns.

### 6.4 New or modified views

None.

---

## 7. Migration files

### 7.1 Migration 1: create `user_location_log`

**File:** `supabase/migrations/20260622_create_user_location_log.sql`

Purpose: create the `user_location_log` table, indexes, and RLS so the desktop app can
write hourly location snapshots independently of `activity_records`.

Depends on: base migrations for `users` and `organizations` tables (already applied).

```sql
-- ============================================================================
-- Migration: Create user_location_log table
-- Date: 2026-06-22
--
-- Stores work-location snapshots written by the desktop app every 4 hours.
-- Location is stored here — NOT in activity_records.metadata — to avoid
-- JSONB redundancy, enable indexed queries, and simplify GDPR erasure.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.user_location_log (
    id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id              UUID        NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
    organization_id      UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    recorded_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    work_location_type   TEXT        CHECK (work_location_type IN ('office', 'remote', 'unknown')),
    work_location_source TEXT        CHECK (work_location_source IN ('ssid', 'subnet', 'ip_geo')),
    city                 TEXT,
    region               TEXT,
    country              TEXT,
    country_code         TEXT,
    ip                   TEXT
);

-- ============================================================================
-- INDEXES
-- ============================================================================

-- Primary access pattern: latest location for a given user
CREATE INDEX IF NOT EXISTS idx_location_log_user_time
    ON public.user_location_log (user_id, recorded_at DESC);

-- Org-level analytics (e.g., how many users in office today)
CREATE INDEX IF NOT EXISTS idx_location_log_org_time
    ON public.user_location_log (organization_id, recorded_at DESC);

-- Portal query: filter an org's rows by location type, most recent first.
-- Plain columns only: a timestamptz->date cast is STABLE (timezone-dependent),
-- not IMMUTABLE, and Postgres rejects it in an index expression.
CREATE INDEX IF NOT EXISTS idx_location_log_org_date_type
    ON public.user_location_log (organization_id, work_location_type, recorded_at DESC);

-- ============================================================================
-- ROW LEVEL SECURITY
-- ============================================================================

ALTER TABLE public.user_location_log ENABLE ROW LEVEL SECURITY;

-- Desktop app can insert its own rows
DROP POLICY IF EXISTS "location_log_insert_own" ON public.user_location_log;
CREATE POLICY "location_log_insert_own" ON public.user_location_log
    FOR INSERT
    WITH CHECK (user_id = (SELECT get_current_user_id()));

-- Users can read their own location history
DROP POLICY IF EXISTS "location_log_select_own" ON public.user_location_log;
CREATE POLICY "location_log_select_own" ON public.user_location_log
    FOR SELECT
    USING (user_id = (SELECT get_current_user_id()));

-- Org members can read all location rows in their org (for manager/portal views)
DROP POLICY IF EXISTS "location_log_select_org" ON public.user_location_log;
CREATE POLICY "location_log_select_org" ON public.user_location_log
    FOR SELECT
    USING (
        organization_id IN (
            SELECT organization_id FROM public.organization_members
            WHERE user_id = (SELECT get_current_user_id())
        )
    );

-- Service role (AI server, Edge Functions) has full access
DROP POLICY IF EXISTS "location_log_service_role" ON public.user_location_log;
CREATE POLICY "location_log_service_role" ON public.user_location_log
    FOR ALL
    USING (auth.role() = 'service_role');

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON TABLE public.user_location_log IS
    'Work-location snapshots written by the desktop app every 4 hours. '
    'Stores one row per detection cycle per device. '
    'Rows are append-only — the desktop app never UPDATEs or DELETEs rows here.';

COMMENT ON COLUMN public.user_location_log.work_location_type IS
    'Detected location type: office (SSID/subnet match), remote (IP geo), unknown (detection failed).';

COMMENT ON COLUMN public.user_location_log.work_location_source IS
    'Detection method used: ssid (WiFi SSID matched), subnet (LAN IP matched), ip_geo (ipinfo.io lookup).';

COMMENT ON COLUMN public.user_location_log.ip IS
    'Public IP address — null for office detections (ssid/subnet). '
    'Only populated when work_location_source = ip_geo to minimise PII at rest.';
```

### 7.2 Migration 2: add location settings to `tracking_settings`

**File:** `supabase/migrations/20260622_add_location_to_tracking_settings.sql`

Purpose: adds `location_detection_enabled`, `office_ssid_names`, `office_subnet_prefixes`
to `tracking_settings` so admins can configure office network identifiers and opt orgs out
of location detection.

Depends on: `20260220_tracking_settings_project_level.sql` (already applied).

```sql
-- ============================================================================
-- Migration: Add location detection settings to tracking_settings
-- Date: 2026-06-22
--
-- Adds three columns read by the desktop app's _location_log_loop():
--   location_detection_enabled  — org-level on/off toggle
--   office_ssid_names           — WiFi SSIDs that identify office networks
--   office_subnet_prefixes      — CIDR ranges that identify office LANs
--
-- No RLS changes — existing tracking_settings policies cover these columns.
-- ============================================================================

ALTER TABLE public.tracking_settings
    ADD COLUMN IF NOT EXISTS location_detection_enabled BOOLEAN  NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS office_ssid_names          TEXT[]   NOT NULL DEFAULT '{}'::TEXT[],
    ADD COLUMN IF NOT EXISTS office_subnet_prefixes     TEXT[]   NOT NULL DEFAULT '{}'::TEXT[];

COMMENT ON COLUMN public.tracking_settings.location_detection_enabled IS
    'When FALSE, the desktop app skips all location detection for this org. '
    'Use in jurisdictions with strict monitoring laws (e.g., Germany works councils). '
    'Default TRUE — opt-out, not opt-in, because location collection is disclosed in the consent page.';

COMMENT ON COLUMN public.tracking_settings.office_ssid_names IS
    'WiFi SSID names that identify office locations. Case-sensitive. '
    'Example: {"Amzur-Office","Amzur-5G"}. '
    'Desktop app matches the connected SSID against this list. '
    'Leave empty if office WiFi detection is not needed.';

COMMENT ON COLUMN public.tracking_settings.office_subnet_prefixes IS
    'CIDR subnet prefixes that identify office LAN ranges (covers wired Ethernet). '
    'Example: {"10.0.0.0/8","192.168.100.0/24"}. '
    'Desktop app checks local IP against these ranges via Python ipaddress module. '
    'Leave empty if subnet detection is not needed.';
```

### 7.3 Data migrations and seed data

No data migrations required.

New columns on `tracking_settings` have non-null defaults — existing rows are updated
automatically by PostgreSQL when the migration runs.

`user_location_log` starts empty. The desktop app populates it on first run after the
update is installed. Historical activity before this feature shipped has no location
association — this is correct and expected. The portal should handle the absence of
location rows for older dates gracefully (show "—" or "unknown").

---

## 8. Background jobs and Edge Functions

### 8.1 `_location_log_loop()` — new background task in desktop app

| Property | Value |
|----------|-------|
| Thread name | `location-log` |
| Daemon | Yes (exits with the process) |
| Started from | `TimeTracker._start_activity_monitor()` (guarded by `self._location_thread.is_alive()`) |
| Interval | 14,400 s (4 hours) |
| First run | Immediately on thread start (no initial sleep) |
| Writes to | `user_location_log` via Supabase INSERT |
| On failure | Logs at WARNING, sleeps until next cycle |

The 4-hour interval is the rate limiter — no internal cache is needed in `LocationDetector`.

The sleep between cycles is implemented as a loop of 60-second sleeps checking `self.running`
so the thread exits within 60 seconds of app shutdown rather than sleeping for the full
4-hour interval.

### 8.2 Edge Functions — not modified

No changes to `activity-webhook` or any other Edge Function.

---

## 9. Test plan

### 9.1 Unit tests — `tests/test_location_detector.py`

All tests use `unittest.mock.patch`. `pytest.fixture` provides a clean `LocationDetector()`
instance for each test.

**Tier 1a — SSID detection:**

| Scenario | Setup | Expected |
|----------|-------|----------|
| SSID matches office list | `_get_current_ssid` returns `"Amzur-Office"`; `office_ssids=["Amzur-Office"]` | `work_location_type="office"`, `work_location_source="ssid"`, `ip=None` |
| SSID present but not in list | returns `"HomeWiFi"`; list=`["Amzur-Office"]` | Falls through to Tier 1b / Tier 2 |
| No WiFi adapter (`FileNotFoundError`) | `subprocess.run` raises | `_get_current_ssid` returns `None`; falls through silently |
| SSID detection timeout | `subprocess.run` raises `TimeoutExpired` | Same — falls through silently |
| `office_ssids` list is empty | Any SSID | No office match; falls through |
| Case-sensitivity | SSID=`"amzur-office"`, list=`["Amzur-Office"]` | No match |

**Tier 1b — subnet detection:**

| Scenario | Setup | Expected |
|----------|-------|----------|
| Local IP inside subnet | `_get_local_ip` returns `"10.0.1.42"`; subnets=`["10.0.0.0/8"]` | `work_location_type="office"`, `work_location_source="subnet"`, `ip=None` |
| Local IP outside all subnets | IP=`"192.168.1.5"`; subnets=`["10.0.0.0/8"]` | Falls through to Tier 2 |
| Malformed subnet in list | subnets=`["not-a-cidr", "10.0.0.0/8"]` | Malformed entry skipped; valid entry matched |
| `socket.gethostbyname` raises | Exception | Returns `None`; falls through silently |
| `office_subnets` list is empty | Any IP | No subnet check; falls through |

**Tier 2 — IP geolocation:**

| Scenario | Setup | Expected |
|----------|-------|----------|
| Happy path | Mock returns `{"city":"Austin","region":"Texas","country":"US","ip":"1.2.3.4"}` | `work_location_type="remote"`, `work_location_source="ip_geo"`, `city="Austin"`, `ip="1.2.3.4"` |
| HTTP 429 (rate limited) | Returns status 429 | Returns `None`; does not raise |
| HTTP 503 (down) | Returns status 503 | Returns `None`; does not raise |
| Network timeout | `requests.Timeout` | Returns `None`; does not raise |
| Connection refused | `requests.ConnectionError` | Returns `None`; does not raise |
| Malformed JSON | Returns 200 with body `"not json"` | Returns `None`; does not raise |
| Partial response | Returns `{"ip":"1.2.3.4"}` (no city) | Returns dict with `city=None`; does not raise |

**Tier precedence (tiers do not bleed into each other):**

| Scenario | Expected |
|----------|----------|
| Tier 1a matches | Returns immediately; `_fetch_ipinfo` is never called |
| Tier 1a misses, Tier 1b matches | Returns immediately; `_fetch_ipinfo` is never called |
| Both Tier 1 miss, Tier 2 succeeds | Returns ip_geo result |
| All tiers fail | Returns `None` |

**`_location_log_loop()` unit tests** (in `test_location_detector.py` or a separate
`test_location_log_loop.py`):

| Scenario | Expected |
|----------|----------|
| `location_detection_enabled = False` (org-default) | `get_location()` is never called; no INSERT |
| `current_user_id = None` | Detection skipped; no INSERT |
| `current_user_id = "anonymous_abc123"` | Detection skipped; no INSERT (FK-safe guard) |
| `supabase_initialized = False` | Detection skipped; no INSERT |
| Project-specific row has `location_detection_enabled = TRUE` but org-default = `FALSE` | No INSERT — loop reads `_org_default`, not project settings |
| `get_location()` returns `None` | No INSERT; loop continues |
| `get_location()` returns valid dict | `_insert_location_log()` called with that dict |
| `_insert_location_log()` raises Supabase error | Exception caught; loop logs WARNING and continues |
| App shutdown (`self.running = False`) | Thread exits within 60 s of flag being set |

### 9.2 Integration tests

No new integration tests required for Phase 1. Unit tests cover all paths with mocks.

### 9.3 Manual verification checklist

1. Apply both Supabase migrations.
2. Build and install the updated desktop app.
3. Start the desktop app and wait approximately 2 minutes (the first loop cycle runs
   immediately on thread start).
4. Open Supabase Table Editor → `user_location_log`. Confirm one new row exists for your
   `user_id`. Confirm:
   - `work_location_type` is either `"office"` or `"remote"`.
   - `work_location_source` is one of `"ssid"`, `"subnet"`, `"ip_geo"`.
   - `city` and `country` are populated if source is `"ip_geo"`; `null` if source is
     `"ssid"` or `"subnet"`.
   - `ip` is populated only if source is `"ip_geo"`; `null` otherwise.
5. Open Supabase Table Editor → `activity_records`. Find a recent row. Confirm
   `metadata` does NOT contain a `"location"` key (it should only have `tracking_mode`,
   `app_version`, `user_projects`). Verify the batch upload cycle is unchanged.
6. Add your office WiFi SSID to `tracking_settings.office_ssid_names` directly in
   Supabase. Wait up to 5 minutes for the settings refresh. Wait up to 4 hours for the
   next location cycle OR restart the desktop app to trigger an immediate detection.
   Confirm the next `user_location_log` row has `work_location_type="office"` and
   `ip=null`.
7. Set `tracking_settings.location_detection_enabled = FALSE` for your org. Restart the
   app. Confirm no new rows appear in `user_location_log`.
8. Disconnect from the internet. Restart the app. Confirm no row is written to
   `user_location_log` (detection failed — expected). Confirm `activity_records` batch
   upload is unaffected (the two loops are independent).

---

## 10. Interaction diagrams

### 10.1 Happy path — device on office WiFi (SSID match)

```
TimeTracker._start_activity_monitor()
  └─ starts thread: _location_log_loop()   [daemon, every 4 hours, stored as self._location_thread]
        │
        ├─ reads tracking_settings_cache['_org_default']:
        │   location_detection_enabled = True
        │   office_ssid_names = ["Amzur-Office"]
        │   office_subnet_prefixes = []
        │
        ├─ location_detector.get_location(
        │       office_ssids=["Amzur-Office"],
        │       office_subnets=[]
        │   )
        │     │
        │     ├─ Tier 1a: _get_current_ssid()
        │     │    subprocess("netsh wlan show interfaces")  <1ms
        │     │    returns "Amzur-Office"
        │     │
        │     ├─ "Amzur-Office" in ["Amzur-Office"] → True
        │     │   → returns {work_location_type:"office", work_location_source:"ssid",
        │     │               city:None, region:None, country:None, ip:None}
        │     │   Tier 2 (_fetch_ipinfo) is NOT called
        │     │
        ├─ _insert_location_log({work_location_type:"office", ...})
        │     │
        │     └─ supabase.table('user_location_log').insert({
        │            user_id, organization_id, recorded_at,
        │            work_location_type:"office",
        │            work_location_source:"ssid",
        │            city:None, ip:None, ...
        │        }).execute()
        │           → Supabase PostgreSQL: one row inserted
        │
        └─ sleep 14400s (4 hours)   [60s check-loop on self.running]

─── COMPLETELY SEPARATE ─────────────────────────────────────────────────────
TimeTracker.tracking_loop() (every 5 min)
  → upload_activity_batch()
      → session_manager.harvest_and_clear()
      → metadata = {tracking_mode, app_version, user_projects}  ← NO location key
      → supabase.table('activity_records').insert(...)           ← unchanged
```

### 10.2 Happy path — device working remotely (IP geolocation)

```
_location_log_loop()
  │
  ├─ office_ssid_names = []  (not configured)
  │
  ├─ location_detector.get_location(office_ssids=[], office_subnets=[])
  │     │
  │     ├─ Tier 1a: _get_current_ssid() → "HomeWiFi"
  │     │   "HomeWiFi" not in [] → no match
  │     │
  │     ├─ Tier 1b: _get_local_ip() → "192.168.1.5"
  │     │   office_subnets = [] → skip
  │     │
  │     ├─ Tier 2: _fetch_ipinfo()
  │     │    GET https://ipinfo.io/json  (HTTPS, timeout=5s)
  │     │    HTTP 200 → {city:"Austin", region:"Texas", country:"US", ip:"203.0.113.45"}
  │     │
  │     └─ returns {work_location_type:"remote", work_location_source:"ip_geo",
  │                 city:"Austin", region:"Texas", country:"US",
  │                 country_code:"US", ip:"203.0.113.45"}
  │
  └─ _insert_location_log({...})  → one row in user_location_log
```

### 10.3 Failure path — ipinfo.io unreachable

```
_location_log_loop()
  │
  ├─ location_detector.get_location(office_ssids=[], office_subnets=[])
  │     │
  │     ├─ Tier 1a: no match (HomeWiFi not in empty list)
  │     ├─ Tier 1b: no match (no subnets configured)
  │     │
  │     ├─ Tier 2: _fetch_ipinfo()
  │     │    GET https://ipinfo.io/json
  │     │    requests.ConnectionError → caught
  │     │    returns None
  │     │
  │     └─ returns None
  │
  ├─ result is None → skip INSERT
  │   log.debug("location detection returned no result — skipping insert")
  │
  └─ sleep 14400s → retry in 4 hours

─── COMPLETELY SEPARATE ─────────────────────────────────────────────────────
upload_activity_batch()  ← NOT AFFECTED. Runs on its own 5-min cycle.
  No location lookup. No dependency on user_location_log.
```

### 10.4 Failure path — location detection disabled by admin

```
fetch_tracking_settings(None) [runs when current_project_key is None, or on admin refresh]
  → caches in tracking_settings_cache['_org_default']
  → location_detection_enabled = False

_location_log_loop() [every 4 hours]
  ├─ org_settings = tracking_settings_cache.get('_org_default', default_tracking_settings)
  ├─ org_settings.get('location_detection_enabled', True) → False
  ├─ skips detection entirely
  ├─ no INSERT
  └─ sleep 14400s
```

### 10.5 Settings change path — admin adds office SSID

```
Admin sets tracking_settings.office_ssid_names = ["Amzur-Office"] on the org-wide row
in Supabase.

fetch_tracking_settings(None) [next 5-min cycle when current_project_key is None]
  → reads new value from DB
  → updates tracking_settings_cache['_org_default']['office_ssid_names'] = ["Amzur-Office"]
  → (no cache to invalidate — LocationDetector is stateless)

_location_log_loop() [next 4-hour cycle, or immediately after restart]
  → org_settings = tracking_settings_cache['_org_default']
  → office_ssids = org_settings['office_ssid_names'] → ["Amzur-Office"]
  → get_location(office_ssids=["Amzur-Office"], ...)
  → SSID matches → work_location_type:"office" written to user_location_log
```

### 10.6 Portal query — "what was this user's location on a given date?"

```
Portal (future v3)
  → query user_location_log:

  SELECT DISTINCT ON (user_id)
      user_id, work_location_type, city, country, recorded_at
  FROM user_location_log
  WHERE user_id = $uid
    AND recorded_at::DATE <= $work_date
  ORDER BY user_id, recorded_at DESC;

  Uses index idx_location_log_user_time (user_id, recorded_at DESC).
  Returns the last snapshot on or before that date. One index scan, no JSONB parsing.
```

---

## 11. Risks, edge cases, and open questions

### 11.1 Risks

**R1 — ipinfo.io free tier capacity**
At 50,000 requests/month free, the threshold at a 4-hour interval is approximately 280
active devices. Below that, the free tier is sufficient. Above it, requests return HTTP 429.
`_fetch_ipinfo` returns `None` on 429; no row is inserted for that cycle.

Mitigation: monitor usage in the first month. If the fleet exceeds 200 active concurrent
devices, purchase the ipinfo.io Basic plan (~$99/month). Zero code change required — same
endpoint, higher limit.

Alternative: switch to self-hosted MaxMind GeoLite2 (~60 MB database, free for commercial
use, no rate limits). Deferred to a future plan if needed.

**R2 — Corporate VPN masks physical location**
If a user is on corporate VPN and no office networks are configured, ipinfo.io sees the VPN
exit node IP and returns the VPN server's city. `user_location_log` stores a technically
accurate but physically misleading "remote" location.

Mitigation: Tier 1 (SSID/subnet) exists precisely for this case. Orgs must configure at
least one of `office_ssid_names` or `office_subnet_prefixes` for deterministic office
detection. Document this in the admin guide. The Forge Settings UI (v3) will surface this
with a VPN-limitation tooltip.

**R3 — WiFi-less devices (Ethernet-only desktops)**
`netsh wlan show interfaces` produces no SSID output on a wired desktop. Tier 1a skips
silently; Tier 1b (subnet) runs if configured.

Mitigation: admins with wired office desktops should configure `office_subnet_prefixes`.

**R4 — GDPR jurisdictions (Germany, France, Netherlands)**
Some EU jurisdictions require works-council consultation before enabling location-based
employee monitoring.

Mitigation: `location_detection_enabled = FALSE` per org with no code deploy. Document in
admin guide with a specific note about works-council requirements.

**R5 — IP addresses in `user_location_log`**
`ip` is stored in `user_location_log` for `ip_geo` detections. This is personal data
under GDPR.

Mitigation: `ip` is `null` for `ssid` and `subnet` detections (the common case for
configured orgs). For `ip_geo` detections the IP is stored so the detection can be audited
or corrected later. It is not logged at INFO level in application logs. It is not sent
anywhere except the initial ipinfo.io request and the Supabase INSERT. Covered by
existing `user_location_log` RLS.

**R6 — `netsh` restricted on locked-down enterprise images**
Some enterprise Windows builds restrict subprocess execution.

Mitigation: all exceptions in `_get_current_ssid` are caught and return `None`. Tier 1b
(subnet via pure Python `ipaddress`/`socket`) is not affected by subprocess restrictions.

**R7 — `location_detection_enabled = FALSE` can be masked by project-specific rows**
`tracking_settings` uses a 3-tier fetch (project → org → global). After the migration,
every existing project-specific row gets `location_detection_enabled = TRUE` (the NOT NULL
DEFAULT). If an org admin sets the org-wide row to `FALSE` (for GDPR), but the org also
has project-specific `tracking_settings` rows, the project row wins and location detection
remains enabled for users whose current project has a project-specific row.

`_location_log_loop()` reads from `tracking_settings_cache['_org_default']` (the org-wide
row) which avoids this problem at the desktop app level. However, the risk exists if the
implementation is later changed to use `self.tracking_settings` (the `@property`) instead.

Mitigation: document in admin guide that `location_detection_enabled = FALSE` must be set
on BOTH the org-wide row AND all project-specific rows if project rows exist. A Forge UI
toggle (v3) should write the value to all rows in one operation.

### 11.2 Edge cases

**E1 — User switches network mid-day (office morning, remote afternoon)**
The 4-hour loop captures the state at the moment it runs. If the user moved from office to
home between two loop cycles, the log will show "office" for the morning snapshot and
"remote" for the afternoon snapshot. Both rows are stored. The portal can show the most
recent snapshot per day or all snapshots for a day depending on the view.

**E2 — Device offline for an entire 4-hour window**
No row is written for the missed cycle. The previous row remains the last known location.
When connectivity returns, the next cycle writes a fresh row. The portal shows the last
known location for the offline period.

**E3 — First install (no prior rows in `user_location_log`)**
The first detection runs on thread start (no initial delay). A row should appear in
`user_location_log` within 10 seconds of the app starting. The portal handles the case
where no rows exist for a user/date gracefully (no crash, shows "—" or "unknown").

**E4 — Multiple office SSIDs (multi-site org)**
`office_ssid_names` is `TEXT[]`. Orgs configure all their SSIDs:
`{"London-Office", "NYC-Office", "Austin-Office"}`. The SSID check matches any entry.

**E5 — `tracking_settings` fetch fails (network error)**
`fetch_tracking_settings()` already handles this: uses the previous cached value with a
60-second retry window. `_location_log_loop()` reads `tracking_settings_cache['_org_default']`
at that moment — it will use the last successfully fetched org-level values, or the safe
`default_tracking_settings` fallback if `_org_default` was never populated.

**E6 — `current_user_id` is `None` or anonymous at loop start**
The combined guard `if self.current_user_id and not self.current_user_id.startswith(
'anonymous_') and self.supabase_initialized:` ensures no INSERT is attempted for either a
missing user OR an anonymous session. Anonymous IDs (`anonymous_xxx`) are not valid UUIDs
and have no `public.users` row, so an INSERT would fail the `user_id` FK. Once the user
logs in (which converts the session to a real UUID and associates prior anonymous data),
the next loop cycle writes rows normally. Anonymous tracking IS a supported mode
([desktop_app.py:12604](python-desktop-app/desktop_app.py#L12604)), so this guard is not
hypothetical.

### 11.3 Open questions

**Q1 — ipinfo.io capacity and cost approval**
Who approves the ipinfo.io Basic plan (~$99/month) if the active device fleet exceeds 280
devices? Confirm before rollout and set up a usage alert on the ipinfo.io dashboard.

**Q2 — `work_location_type` when no office networks configured**
When `office_ssid_names` and `office_subnet_prefixes` are both empty and Tier 2 returns
a city, should `work_location_type` be `"remote"` (the device is not on a known office
network) or `"unknown"` (we have no office networks to compare against, so we cannot
classify)? Currently the plan uses `"remote"` for all ip_geo results. Decision needed
before implementation.

**Q3 — Forge Settings UI timeline**
Admins must currently configure `office_ssid_names` via direct Supabase SQL. Is this
acceptable for the initial rollout or must the UI land first?

---

## 12. Rollout and feature flagging

### Feature flag

`tracking_settings.location_detection_enabled` (default `TRUE`) is the org-level flag.
Disable for a specific org with no code deploy:

```sql
UPDATE public.tracking_settings
SET location_detection_enabled = FALSE
WHERE organization_id = '<org-uuid>'
  AND project_key IS NULL;
```

For a fully staged rollout (off by default globally until validated):

```sql
UPDATE public.tracking_settings
SET location_detection_enabled = FALSE
WHERE organization_id IS NULL AND project_key IS NULL;
```

### Additive-only rule

No existing columns, API shapes, or table structures are changed. `activity_records` is
not touched. Old desktop versions (without this feature) continue to work without writing
to `user_location_log`. The new table simply has no rows for those devices until they
upgrade.

### Deploy order

1. **Supabase migrations first** — Apply `20260622_create_user_location_log.sql`, then
   `20260622_add_location_to_tracking_settings.sql`. Both are safe to apply before the
   desktop update ships: existing desktop versions do not reference either migration.
2. **Desktop app build** — Build with `build.bat`. Version bump required so
   `update_manager` distributes the new binary.
3. **Distribute via `app_releases`** — Insert new version row. Auto-update delivers to
   all active desktops.

No AI server deploy needed. No Forge app deploy needed.

### Rollback

**Supabase — `user_location_log`:** Drop the table. Add a reversal migration:
```sql
DROP TABLE IF EXISTS public.user_location_log;
```
No other tables are affected.

**Supabase — `tracking_settings` columns:** Add a reversal migration:
```sql
ALTER TABLE public.tracking_settings
    DROP COLUMN IF EXISTS location_detection_enabled,
    DROP COLUMN IF EXISTS office_ssid_names,
    DROP COLUMN IF EXISTS office_subnet_prefixes;
```

**Desktop app:** Previous installer in `app_releases` is always retained. The previous
version simply does not start `_location_log_loop()`.

---

## 13. Notification events

No notification events for this feature.

---

## Estimated effort

| Work item | Estimate |
|-----------|----------|
| `LocationDetector` class (3 tiers, stateless) | 0.5 day |
| `_location_log_loop()` + `_insert_location_log()` | 0.5 day |
| Wiring into `__init__`, `fetch_tracking_settings`, `_start_activity_monitor` | 2 hours |
| `render_consent_page` update | 1 hour |
| `tests/test_location_detector.py` (all §9.1 scenarios) | 0.5 day |
| Two Supabase migrations + apply + verify | 2 hours |
| Manual verification checklist (§9.3) | 1 hour |
| **Total** | **~2.5 days** |

Portal analytics UI and Forge Settings UI for office network configuration: estimated
separately in v3.
