# Automatic Employee Location Detection — Feasibility & Implementation Plan

**Date:** 2026-06-12 (revised 2026-06-13)
**Components:** ai-server (primary), supabase, portal, python-desktop-app (consent text only)
**Status:** IMPLEMENTED in working tree 2026-06-13 (uncommitted, dev-only). Outstanding: Phase 0 outward-facing items (privacy policy, Marketplace Privacy & Security tab, employee notice), migration application (20260610 + 20260613, **dev first — explicitly not prod yet**), GeoLite2 data refresh chore, retention/history decision.
**Prerequisite reading:** `docs/AUTOMATIC_LOCATION_DETECTION_POLICY_ASSESSMENT_2026-06-12.md` (Atlassian policy verdict: allowed only as a transparent, consented, disclosed feature)
**Builds on:** WS-B Employee Location (`plan/2026-06-10_web-productivity-portal_ux-improvements.md` §6.1, migration `20260610_portal_employee_profiles.sql`)

---

## REVISION 2026-06-13 — pivot to periodic working-location detection (this is what shipped)

The original plan below (§1–§8) designed an **office-network → location *suggestion*** model: superadmins register office egress CIDRs, the server matches the client IP, and a human confirms a suggested location. **That does not fit this organization** — the workforce is mostly **work-from-home, employees can be anywhere**, so office-IP matching would rarely fire (confirmed with the user 2026-06-13).

**What was actually built instead** — periodic *current* working-location detection:

- **Signal:** approximate **city / region / country** derived from each employee's client IP via an **offline GeoIP database** (`geoip-lite`, added to `ai-server/package.json`). Offline = the IP is never sent to a third party (no Marketplace third-party-sharing disclosure, no DPA). Still **no GPS** — coarse only.
- **Cadence:** the existing capture hook in `exchangeToken` / Google auth (client IP seen ~hourly during active use) now calls `recordWorkingLocation(userId, req.ip)`, **throttled to re-detect at most every ~3h** — meets the user's "every 3-4h" ask with no new desktop timer.
- **Model:** `portal_employee_work_locations` (one row per user, upserted; soft `user_id`, no FK) — replaces the old `portal_location_ip_ranges` + `portal_location_suggestions` tables. Stores city/region/country + a **truncated /24 (or /64) IP prefix only — never the full IP**.
- **Display:** a **"Working From"** column on the portal Employees page (city, country, "detected X ago" tooltip), embedded in the employees-list response (`portal-service.getEmployees`). **No suggest/confirm flow** — it shows the detected location directly. The pre-existing manual "Location" column (WS-B) is untouched.
- **Removed vs. the original design:** office-network CRUD UI (SettingsPage), suggestion chips + dismiss (EmployeesPage), the `portal-location-detection-controller` and its routes, and the suggestion-reconcile hooks in the profile service.
- **Consent:** desktop `CONSENT_VERSION` → 1.1 (forces re-consent), disclosure now reads *"approximate working location … derived periodically … roughly every few hours while tracking is active, no GPS."*
- **Erasure:** `portal_employee_work_locations` wired into the GDPR deletion path (with the no-org-column fix).

**Heightened-sensitivity note:** this is now *ongoing* (every-few-hours) detection of where home-based employees physically are — materially more sensitive than a one-time office hint. It stays within the policy assessment's "allowed" box **only because** it is city-level (not GPS), offline (no third-party sharing), consent-gated, and disclosed. The Phase 0 outward-facing items (privacy policy, Marketplace tab, employee notice) are therefore **mandatory before any rollout**, and the India-DPDP/US-state notice obligations in the policy doc §3 apply with full force.

Sections §1–§8 below are retained for the original analysis and policy reasoning (still valid); where they describe office-network mechanics, the revision above supersedes them.

---

## 0. Verdict

**Yes — automatic location detection is technically possible, and it can be done with almost no changes to the desktop app's tracking code.** The decisive code-level facts (all verified, §2):

1. The ai-server already sees every desktop client's public IP on authenticated requests (`trust proxy` is enabled; the Supabase JWT is re-minted via `/api/auth/exchange-token` roughly hourly during active use).
2. The desktop app already auto-detects and uploads the user's IANA timezone with **every** activity record — but production data proves timezone is useless as a discriminator for our workforce (all 46 active users are in `Asia/Calcutta`/`Asia/Kolkata`).
3. Therefore the only viable automatic signal is **connection IP**, evaluated **server-side** — recommended as an admin-managed *office-network → location* mapping, producing **suggestions** that a superadmin confirms (never silent auto-assignment).
4. The desktop app already has a versioned `ConsentManager` with a re-consent-on-version-bump mechanism — the consent gate this feature requires already exists and only needs a text/version update.

What this plan is **not**: GPS/Windows Location API collection (rejected — precise geolocation is sensitive-data class, see policy doc §4), and **not** silent auto-assignment (violates Marketplace Partner Agreement §8.4 consent leg).

### 0.1 Hard constraint — fully isolated from the Jira application (portal-only)

Location data is displayed in the **web portal only**. The feature must stay architecturally separate from the main Jira-facing application:

- **Zero forge-app changes**: no manifest, resolver, or UI work in `forge-app/`; location never appears in the Jira project page, issue panel, or admin page.
- **No forge-served data**: location/suggestion data must never be returned by any forge-auth'd ai-server endpoint (`forge-auth.js` / forge-proxy routes). All new endpoints mount under `/api/portal/*` behind `portal-auth` middleware only.
- **Portal-owned storage**: the new tables follow the existing portal-owned pattern (service-role-only RLS, no org-scoped policies) — exactly like `portal_locations` / `portal_employee_profiles` — so Jira-side user-scoped reads can never see them.
- The only contact points with the main application are unavoidable plumbing, not feature surface: the IP capture hook inside the desktop token-exchange path (auth, not Jira), and the GDPR erasure path (compliance, not display).

---

## 1. Problem

The portal's Employee Location feature (WS-B) requires a superadmin to manually assign each employee's location. With ~46 active users today and growth expected, manual assignment is toil and goes stale silently (e.g., employee moves office; nobody updates the portal). The manager's ask: detect location automatically.

---

## 2. Verified findings (no assumptions — every claim cites code or live data)

### 2.1 Desktop app (`python-desktop-app/desktop_app.py`)

| Fact | Evidence |
|---|---|
| UI is a local Flask web app + pystray tray icon (consent pages are HTML routes, not native dialogs) | imports at `desktop_app.py:56-59`; consent routes `desktop_app.py:7302-7368` |
| **`ConsentManager` already exists** with `CONSENT_VERSION = "1.0"`, a `data_collected` disclosure list, and forced re-consent when the version changes | `desktop_app.py:3988-4066`; version check at `:4026-4030`; `data_collected` list at `:4041-4047` |
| Consent gates tracking: `/consent` page → `/consent/submit` → only then `start_tracking()`; denial/revocation stops tracking | `desktop_app.py:7309-7352`; `has_valid_consent` checks before capture at `:6484, :6599, :12196` et al. |
| **Timezone auto-detection already ships**: `get_local_timezone_name()` returns IANA name via `tzlocal` (fallback `Etc/GMT±X`) | `desktop_app.py:826-842`; `tzlocal` pinned in `requirements.txt:27` and bundled in `desktop_app.spec:455` |
| `user_timezone` is sent with **every** activity/screenshot payload | `desktop_app.py:9907, :10806, :11257` |
| Activity uploads go **directly to Supabase** (minted JWT), *not* through ai-server — so ai-server does **not** see the client IP on every upload | Supabase client import `desktop_app.py:63`; upload payload `:10792-10818` |
| But the Supabase JWT expires after 3600 s and is re-minted via ai-server `POST /api/auth/exchange-token` — ai-server sees the client IP at least ~hourly during active use; also on `/api/auth/refresh-token`, `/api/auth/ocr-config`, `/api/classifications*`, `/api/auth/diagnostics`, pause-settings sync | token exchange `desktop_app.py:2894-2933`; JWT `expiresIn = 3600` in `ai-server/src/controllers/auth-controller.js:667`; endpoint list grep of `desktop_app.py` |
| Heartbeat (`users.desktop_last_heartbeat`) is a **direct Supabase write** every ~4 h — not an IP-capture point | `desktop_app.py:7900-7961` |
| Login diagnostics already send `platform`, `platform_version`, `hostname` to ai-server — device-info collection precedent exists and is disclosed nowhere granular | `desktop_app.py:3283-3292` → `POST /api/auth/diagnostics` |

### 2.2 ai-server

| Fact | Evidence |
|---|---|
| `app.set('trust proxy', 1)` is set — `req.ip` resolves the real client IP behind exactly one reverse proxy; prod runs behind Nginx | `ai-server/src/index.js:49-50`; Nginx documented in `docs/PORTAL_SETUP_GUIDE.md:266-276` |
| `req.ip` is already used widely (rate limiters, request-id middleware, admin login logging) — IP processing is established practice in this codebase | `index.js:114-231`, `middleware/request-id.js:49` |
| `exchangeToken` resolves the authenticated DB user (`dbUser.id`, `organization_id`) in the same request where `req.ip` is available — **the natural capture hook** | `controllers/auth-controller.js:597-690` |
| No geoip/maxmind/ip-api dependency exists today | grep of `ai-server/` — zero matches |
| `/api/auth/diagnostics` only logs; nothing is persisted | `auth-controller.js:890-944` |
| GDPR deletion exists (`user-data-service.js`) and erases `users`, `screenshots`, `documents`, `activity_log`, `exports`, `organization_members` — it does **not** cover `portal_employee_profiles` (or `activity_records`; pre-existing gap, out of scope here) | table list grep of `services/user-data-service.js` |

### 2.3 Database (live, read-only checks on prod `bzdoztgfozxkhkvctvdk`, 2026-06-12)

| Fact | Evidence |
|---|---|
| **All production users are in one timezone**: `Asia/Calcutta` 273,889 records / 44 users + `Asia/Kolkata` (same zone, alias) 172 records / 2 users. Timezone **cannot** distinguish Hyderabad vs Vizag vs any Indian office | live `GROUP BY user_timezone` on `activity_records` |
| `users` has no location column (columns: id, atlassian_account_id, email, display_name, supabase_user_id, timestamps, is_active, settings, organization_id, desktop_logged_in, desktop_last_heartbeat, desktop_app_version) | live `information_schema.columns` query |
| **Prod does NOT yet have the WS-B tables** (`portal_locations`, `portal_employee_profiles` → `to_regclass` returns NULL) — consistent with the known prod migration-drift issue | live query |
| `user_timezone` columns exist on `activity_records` (since `20260221_add_activity_records.sql:30`) and `screenshots` (since `20260130_add_timezone_support.sql`) | migration files |

### 2.4 Portal (WS-B, already shipped to dev)

Manual assignment, bulk assignment (max 500), location CRUD with delete-guard, and the Location filter across Dashboard/Time Logs/Reports/Employees all exist (`portal-employee-profile-{controller,service,db-service}.js`, `EmployeesPage.jsx`, `SettingsPage.jsx` LocationsCard, `LocationFilter.jsx`). Suggestions can reuse the existing assignment endpoints for the confirm action.

---

## 3. Options considered

| # | Approach | Signal quality | Desktop change | Compliance burden | Verdict |
|---|---|---|---|---|---|
| A | **Admin-managed office-network map**: superadmin registers office egress IPs/CIDRs per `portal_location`; ai-server matches `req.ip` on authenticated desktop requests → suggestion | Deterministic for office workers (office NAT means one stable egress IP per office — the NAT that ruins GeoIP city lookup makes this exact) | **None** (consent text only) | Low: no third party, no external DB; IP processed transiently | **RECOMMENDED — Phase 1** |
| B | GeoIP city lookup (offline `geoip-lite` npm, no external calls) as fallback for IPs that match no office range (WFH users) | City-level, ±wrong for VPN/mobile; offline DB avoids third-party sharing disclosure | None | Medium: stores derived city; GeoLite2 data updates needed | Optional **Phase 2** — only if WFH coverage is actually needed |
| C | Timezone inference from existing `activity_records.user_timezone` | **Proven insufficient**: 46/46 prod users in one zone | None | None (already collected) | Rejected as primary; usable only as a country-level sanity check |
| D | External IP geolocation API (ipinfo.io etc.) | City-level | None | High: new third-party data sharing → Marketplace Privacy & Security tab third-party disclosure + DPA | Rejected |
| E | Windows Location API / Wi-Fi BSSID from desktop | Precise | Significant | **Highest**: "precise geolocation" = sensitive data class (CPRA et al.); OS prompts; worst optics | **Rejected** (policy doc §4) |

**Design principle (from policy assessment): suggest, never silently assign.** `portal_employee_profiles` written by a human superadmin remains the only source of truth. The automatic signal only populates a suggestion the superadmin confirms (single or bulk).

---

## 4. Proposed solution

### Phase 0 — Compliance gate (BLOCKING; no code ships before this is done)

1. **Desktop consent update** (the only desktop change in this plan):
   - Bump `ConsentManager.CONSENT_VERSION` `"1.0"` → `"1.1"` (`desktop_app.py:3991`) — existing logic forces re-consent for all users on next launch (`:4026-4030`).
   - Add `'derived_work_location (from office network address)'` to the `data_collected` list (`:4041-4047`).
   - Update `render_consent_page()` text to state: the server derives an approximate work location (office/city level) from the network address of the app's connections, for workforce reporting; no GPS, no continuous tracking.
2. **End User Privacy Policy** updated (location derived from connection IP; purpose; retention).
3. **Marketplace Privacy & Security tab** data-type disclosures updated (IP address processed; derived location stored outside Atlassian).
4. Internal employee notice (India DPDP "legitimate use" still requires informing employees — policy doc §3).

### Phase 1 — Office-network mapping + suggestions (ai-server, supabase, portal)

**Migration `2026MMDD_portal_location_detection.sql`** (new file; never modify `20260610_…`):

- `portal_location_ip_ranges`: `id`, `location_id FK → portal_locations ON DELETE CASCADE`, `cidr CIDR NOT NULL`, `label` (e.g. "HYD office Airtel egress"), `created_by FK → portal_admin_users`, timestamps, unique on `cidr`. RLS service-role (same pattern as `20260610`).
- `portal_location_suggestions`: `id`, `user_id UUID NOT NULL UNIQUE` (soft ref to `users.id`, **no FK** — same rationale as `portal_employee_profiles`), `suggested_location_id FK → portal_locations ON DELETE CASCADE`, `source TEXT CHECK (source IN ('ip_range','geoip','timezone'))`, `ip_prefix TEXT` (truncated `/24` for audit — **never the full IP**), `detected_at`, `status TEXT CHECK (status IN ('pending','confirmed','dismissed')) DEFAULT 'pending'`, timestamps + updated_at trigger. RLS service-role.

**ai-server capture hook:**

- In `exchangeToken` (`auth-controller.js:597`), after `dbUser` resolves: fire-and-forget call to a new `location-detection-service.suggestFromIp(dbUser.id, req.ip)` (must never block or fail token minting — wrap in `.catch(logger.warn)`).
- `location-detection-service`:
  - Throttle: skip if a suggestion for this user was evaluated < 24 h ago with the same `/24` prefix (one indexed read).
  - Match `req.ip` against `portal_location_ip_ranges` (Postgres `>>=` CIDR containment via one RPC, or in-memory cache of ranges refreshed every 5 min — ranges are tiny).
  - On match ≠ current assignment and ≠ existing pending suggestion: upsert `portal_location_suggestions` (`source='ip_range'`, store truncated prefix only).
  - On no match: do nothing in Phase 1 (Phase 2 would try geoip fallback here).
  - **Raw IP is never persisted**; it exists only in request scope (it already does today for rate limiting).
- Same hook on `google-auth-controller.js` token mint (mirrors Atlassian flow per its header comment).

**Portal:**

- `SettingsPage` LocationsCard: per-location "Office networks" editor (CRUD on `portal_location_ip_ranges`) — superadmin only, reusing the card's existing patterns.
- `EmployeesPage`: suggestion chip on rows where a `pending` suggestion exists and differs from the assigned location ("Suggested: Hyderabad — office network, 2026-06-12") with Confirm (calls existing `locationsApi.setEmployeeLocation`; marks suggestion `confirmed`) and Dismiss actions. Bulk "Confirm all suggestions" uses the existing bulk endpoint (max 500 — `portal-employee-profile-controller.js:91`).
- New endpoints (all `portal-auth`; manage = superadmin only, mirroring `index.js:737-744` comment conventions): `GET/POST/DELETE /api/portal/locations/:id/ip-ranges`, `GET /api/portal/location-suggestions`, `POST /api/portal/location-suggestions/:userId/dismiss`.

### Phase 2 (optional, decide after Phase 1 soak) — GeoIP fallback for WFH

`geoip-lite` (offline) city lookup when no office range matches; suggestion carries `source='geoip'` and the city name for the superadmin to judge. Adds a data-update chore (GeoLite2 refresh) — only build if remote-worker coverage is actually requested.

### Phase 3 — Erasure + tests + soak

- Add `portal_employee_profiles`, `portal_location_suggestions` to the deletion path in `user-data-service.js` (keyed via `users.id` lookup from `account_id`). Flag separately: `activity_records` is already missing from that path (pre-existing gap — file as its own issue).
- Tests first, red, 1-to-1 with acceptance criteria (repo workflow): `tests/services/location-detection-service.test.js`, additions to `portal-employee-profile-*` suites, controller tests for new endpoints.
- **Dev soak before any prod build/deploy, validating the full loop** (desktop re-consent → token exchange → suggestion row → portal confirm → filter works), not just login-time success.

---

## 5. Acceptance criteria

1. Bumping `CONSENT_VERSION` forces the consent page on next launch for a previously-consented user; declining stops/never starts tracking (existing behavior, re-verified with new version string).
2. The consent page and stored consent record include derived-work-location in `data_collected`.
3. A token exchange from an IP inside a registered office CIDR creates exactly one `pending` suggestion for that user within one request cycle; repeat exchanges within 24 h from the same `/24` create no duplicates.
4. A token exchange from an unregistered IP creates no suggestion (Phase 1).
5. The full client IP never appears in any table; `portal_location_suggestions.ip_prefix` holds at most a `/24` prefix; no new `info`-level log line contains a full IP (existing rate-limiter logging unchanged).
6. Suggestion creation failure (DB down, malformed IP) never fails or delays `/api/auth/exchange-token` (assert 200 with service mocked to throw).
7. Superadmin can CRUD IP ranges per location; non-superadmin gets 403 (mirror of existing location CRUD tests).
8. Employees page shows pending suggestions; Confirm assigns via the existing profile endpoint and marks the suggestion `confirmed`; Dismiss marks `dismissed` and suppresses re-suggestion for the same location+prefix.
9. A suggestion never modifies `portal_employee_profiles` by itself (assert no write without the confirm call).
10. GDPR delete for a user removes their `portal_employee_profiles` and `portal_location_suggestions` rows.
11. Deactivated/deleted locations: suggestions pointing at them are not shown (CASCADE handles delete; filter handles inactive).
12. Isolation (§0.1): every new endpoint rejects requests without a valid portal token (401/403 for desktop-JWT and forge-signed callers); no forge-app file is modified by this feature; grep-level check that no forge-auth'd route handler imports the location-detection or employee-profile services.

---

## 6. Out of scope

- **Any surface in the Jira application**: no forge-app changes, no location in the Jira project page / issue panel / admin page, no location data on forge-auth'd endpoints (hard constraint, §0.1) — portal display only.
- GPS / OS location services / Wi-Fi BSSID collection (rejected permanently — policy doc §4).
- Auto-*assignment* without human confirmation.
- Geofencing, presence detection, "who is in the office today" features.
- Backfilling the pre-existing `activity_records` gap in the GDPR deletion path (file separately).
- Department/Shift profile attributes (WS-B follow-ons).

---

## 7. Risks & open questions

| Risk | Mitigation |
|---|---|
| **Prod lacks WS-B tables today** (verified 2026-06-12) — this feature stacks a second migration on an unapplied one | Apply `20260610` + the new migration together; verify actual schema (not migration history) per the prod-drift lesson |
| Office egress IPs change (ISP churn) | Ranges are admin-editable; stale ranges simply stop matching (no wrong suggestions — only on-match suggestions) |
| VPN through office egress makes a remote user look in-office | Acceptable for suggestion-grade data; superadmin confirms; document in portal UI tooltip |
| Shared egress across two offices in one city/ISP | Label ranges precisely; superadmin judgment at confirm time |
| `trust proxy = 1` correctness if a CDN is ever added in front of Nginx | Note in deployment docs: adding a hop requires `trust proxy` review or suggestions will key on the CDN's IP |
| Consent re-prompt friction (all users re-consent at v1.1) | One-time; text change is small; tracking pauses until consent — communicate the rollout internally first |
| Who confirms suggestions at scale? | Bulk-confirm action; volume is bounded by workforce size, not record count |

---

## 8. Decision needed before implementation

1. Approve Phase 0 compliance items (privacy policy + Marketplace tab edits are outward-facing and need owner sign-off).
2. Confirm Phase 1 scope (office-IP mapping only; no GeoIP) is acceptable for the mostly-office workforce shown in the data.
3. Confirm suggestion retention (proposal: suggestions older than 90 days with status `dismissed`/`confirmed` are purged by the existing cleanup cadence — keeps the table tiny and honors data-minimization).
