# Plan — Web Productivity Portal: UX & Data-Clarity Improvements

> Component: `ai-server` (portal sub-app) + `supabase` (portal-owned objects only).
> File follows `plan/base_plan/PLAN_TEMPLATE.md`.
> Date: 2026-06-10
> Status: DRAFT — pending manager sign-off on the open questions in §11.3.
> Reference screenshots: EmpMonitor (competitor) Edit-Employee modal + employee KPI
> cards + dashboard activity breakdown, plus screenshots of our own
> App Classifications / LOB App Classifications pages.

---

## 0. Problem & context (what was asked)

Three improvements requested by management on 2026-06-10, plus refinements
added during review (a/b on 2026-06-10, item 4 on 2026-06-11):

1. **Add Application UX** — when an app appears in employee activity but is not
   yet in the classification list, classifying it should be easy and obvious.
   *Refinement (a):* discovered apps show raw process identifiers
   (`msrdc.exe`, `ShellExperienceHost.exe`, `org.gnome.Nautilus`) — they should
   show clean human names. *Refinement (b):* desktop apps vs web applications
   need a clearly visible distinction in every app listing.
2. **Employee Location** — add a location attribute for employees (reference:
   EmpMonitor's Edit Employee modal with a Location dropdown).
3. **Activity category clarity** — Productive / Idle / Non-Productive (and
   Neutral) must be clearly differentiated and **consistent across the portal**,
   especially on the employee view.
4. **Rebrand to "Amzur Time Tracker"** — every user-visible occurrence of
   "Productivity Portal" / "BRD Tracker" in the portal UI (and the emails the
   portal sends) must read **Amzur Time Tracker**, and Jira must not be
   mentioned anywhere in the portal UI.

### Root causes (verified in code)

| Symptom | Root cause |
|---|---|
| Raw `.exe` names in the unlisted-apps widget | The widget shows `activity_records.application_name` verbatim ([portal-lob-app-classifications-controller.js](../ai-server/src/controllers/portal-lob-app-classifications-controller.js) `getUnlistedApps`); no friendly name exists pre-catalog. |
| Ugly names persist into the catalog | `openAddFor()` in [LobDetailPage.jsx](../ai-server/src/portal/src/pages/LobDetailPage.jsx) pre-fills the Add modal's **Display Name with the raw identifier**; unless the admin retypes it (or runs the flag-gated AI suggest) it is saved as-is. |
| Weak desktop/web distinction | Only a small grey subtitle `identifier · desktop/website` (LOB table) and a plain `process` chip (legacy page). `match_by` data exists everywhere; presentation is the gap. |
| No employee location | `users` is a Jira-pipeline-owned table with no location column, and the portal must never alter Jira-owned tables (locked decision, LOB spec §0.1/§0.7). The portal also has no employee-edit surface at all. |
| Idle time invisible | Every portal query and all three analytics RPCs filter `is_idle <> true`; employee detail hardcodes `idleHours: 0`. |
| Inconsistent percentages | Employee-detail **daily** % divides productive by ALL classifications; the **summary** % divides by productive+non_productive only. Dashboard RPC silently drops `private`/`unknown` time from the trend. |
| Misleading badges | Time-log / report badges render anything ≠ `productive` as red, so `private`/`unknown` read as non-productive. |
| Spelling drift | `non_productive` vs legacy `non-productive`: RPCs count both, but the time-logs classification filter uses `.eq('classification','non_productive')` and misses legacy rows. |
| Brand drift / Jira leakage | UI strings predate the branding decision: `index.html` title "Web Productivity Portal", Sidebar "Time Tracker / Portal" + "© 2026 BRD Tracker", LoginPage hero "Sync to Jira." + "matched to Jira issues", admin-invite email + password-reset email say "Productivity Portal" (10 occurrences), `MAIL_FROM_NAME=Productivity Portal`. |

The work is split into four workstreams: **WS-A** (Add Application UX),
**WS-B** (Employee Location), **WS-C** (Category clarity), **WS-D**
(rebrand). They are independently shippable.

---

## 1. Scope & goals

### 1.1 Feature overview

- Components touched: `ai-server` (portal React frontend + portal controllers/
  services) and `supabase` (new portal-owned tables + replacement aggregate
  functions). No `forge-app` or `python-desktop-app` changes.
- Personas: portal **superadmin** (full management), **LOB head** (classifies
  apps for their LOBs, views their employees), **admin/viewer** (analytics
  consumers).

### 1.2 In scope

**WS-A — Add Application UX**
- A heuristic display-name cleaner (strip extension, split camel/snake case,
  title-case, known-prefix trims) applied to: the unlisted-apps widget labels
  and the Add Application modal's pre-filled Display Name.
- Auto-run the existing AI suggest when the Add modal opens from an unlisted
  app and `PORTAL_AI_APP_SUGGEST=on` (today the admin must click the lookup).
- One-step "quick classify" on each unlisted-app row: a classification select
  + Add button inline (the `addApp` endpoint already accepts `classification`).
- A shared `AppKindBadge` component (icon + colored chip: 🖥 `Monitor`/"Desktop"
  vs 🌐 `Globe`/"Website") replacing the grey subtitle / plain chip in: the
  LOB App Classifications table, the unlisted-apps widget, the Add Application
  modal kind selector, the app-catalog rows it renders, and the legacy
  Application Classifications page's Match By column.
- A `match_by` filter toggle (All / Desktop / Website) on the LOB App
  Classifications table.

**WS-B — Employee Location**
- New portal-owned tables `portal_locations` (managed list) and
  `portal_employee_profiles` (soft `user_id` reference → location).
- Superadmin CRUD for locations (Settings page section) and a per-employee
  "Edit" affordance on the Employees page to assign a location.
- Location shown as a column + filter on the Employees page and on the
  Employee Detail header. Location included in the employee-summary CSV.

**WS-C — Activity category clarity**
- Canonical taxonomy (single definition used everywhere):
  - **Productive** = classification `productive`
  - **Non-Productive** = `non_productive` **or** legacy `non-productive`
  - **Neutral** = `private`, `unknown`, NULL, or any other non-idle value
  - **Idle** = rows with `is_idle = true`
  - **Active time** = Productive + Non-Productive + Neutral
  - **Office time** = Active + Idle
  - **Productivity %** = Productive ÷ (Productive + Non-Productive) — Neutral
    and Idle are *excluded from the ratio* but *visible as time*.
- Replace the three portal aggregate functions to additionally return
  `neutral_seconds` and `idle_seconds` (additive JSON keys / columns).
- Employee Detail page: EmpMonitor-style KPI strip — Office, Active,
  Productive, Non-Productive, Neutral, Idle, Productivity % — with one shared
  tooltip/legend explaining each category. Fix the daily-trend % to use the
  same denominator as the summary.
- Dashboard: add a Neutral Hours KPI card; donut becomes
  productive / non-productive / neutral (idle stays off the org dashboard —
  see §11.3 Q-C2).
- Time Logs + reports: 4-state badge colors (green / red / blue-grey neutral /
  grey idle), classification filter gains "Neutral"; non-productive filter
  matches **both** spellings; daily-summary and employee-summary reports gain
  Neutral + Idle columns (CSV + PDF).

**WS-D — Rebrand to "Amzur Time Tracker", remove Jira mentions**
- Exact, verified inventory (UI):
  - `portal/index.html` — `<title>Web Productivity Portal</title>` →
    `Amzur Time Tracker`.
  - `Sidebar.jsx` — brand block "Time Tracker"/"Portal" → "Amzur Time
    Tracker"; footer "© 2026 BRD Tracker" → "© 2026 Amzur Technologies".
  - `LoginPage.jsx` — logo block "Time Tracking"/"Portal by Amzur" →
    "Amzur Time Tracker"; hero line "Sync to Jira." replaced with a
    Jira-free line ("See the full picture."); feature card copy "Work is
    intelligently matched to Jira issues using AI analysis." → "Work is
    intelligently categorized using AI analysis." (final copy: Q-D1).
- Exact, verified inventory (portal-sent emails):
  - `templates/admin-invite.js` — 7 × "Productivity Portal" →
    "Amzur Time Tracker".
  - `portal-auth-controller.js` password-reset email — subject + body +
    footer (3 ×) → "Amzur Time Tracker".
  - `MAIL_FROM_NAME` env default/docs in `.env.example` →
    `Amzur Time Tracker` (deploy-time env change in each environment).

### 1.3 Out of scope

- **Wiring Phase 2 (`PORTAL_LOB_PRODUCTIVITY`)** — per-LOB classifications
  driving productivity numbers stays deferred (existing plan
  `2026-06-01_web-productivity-portal_lob-segmentation-rbac.md` §12 Phase 2).
  WS-A only improves how classifications are *entered*.
- Desktop-app URL capture (websites still cannot be auto-discovered; browsers
  appear as their exe — communicated as a known limitation, §11.2).
- Department / Shift / Timezone employee attributes (EmpMonitor shows them;
  schema is designed so they can be added later without rework — §6.1).
- Changing the AI pipeline's fallback classification (`'productive'` on
  failure) — cross-component impact; raised as Q-C3, not changed here.
- Redesign of the legacy Application Classifications page beyond the
  `AppKindBadge` swap; merging it with the per-LOB system (Q2 of the LOB plan
  remains open).
- Screenshots / Web History / App History / Keystroke tabs from the EmpMonitor
  reference — not requested.
- Editing employee identity fields (name/email) — those stay owned by the
  Jira/desktop pipeline.
- **Rebrand scope limits (WS-D):** internal identifiers are NOT renamed —
  `/api/portal/*` paths, `portal_token`/`portal_user` localStorage keys,
  `PORTAL_*` env var names, `portal_*` DB tables, file/folder names, and code
  comments all stay. Non-portal surfaces also stay: the desktop/Jira email
  templates (`login-reminder`, `download-reminder`,
  `approval-pending-digest`, `default-password-reminder` — their Jira
  references are correct for their Jira-user audience), the ai-server root
  endpoint name ("BRD Time Tracker AI Server"), legal pages, and the admin
  dashboard.

---

## 2. Assumptions & dependencies

### 2.1 Assumptions

- `activity_records` is populated by the desktop pipeline with
  `classification ∈ {productive, non_productive, private, unknown, idle}`
  (CHECK from `20260325_add_idle_time_support.sql`), legacy rows may carry
  `non-productive`, and idle blocks are rows with `is_idle = true`.
- Idle data **before 2026-06-10 is unreliable** (desktop sleep-detection
  OverflowError fix shipped 2026-06-10) — historical idle numbers will look
  small/odd; noted in UI copy is NOT required, but reviewers should expect it.
- The portal runs with the Supabase service-role key; authorization is
  enforced in ai-server code (LOB plan locked decision). Portal reads across
  all Jira orgs by design (single logical organization).
- `portal_app_catalog` / `portal_lob_app_classifications` and the three
  `portal_*_summary` functions from `20260602_*` migrations are applied in the
  target environment.

### 2.2 Dependencies

- Plans: `2026-05-21_web-productivity-portal_implementation-plan.md`,
  `2026-06-01_web-productivity-portal_lob-segmentation-rbac.md`.
- Supabase objects that must pre-exist: `portal_admin_users`, `portal_lobs`,
  `portal_lob_employees`, `portal_app_catalog`,
  `portal_lob_app_classifications`, `activity_records.is_idle`,
  functions `portal_dashboard_summary` / `portal_employee_summary` /
  `portal_app_usage_summary`.
- Third party: existing AI provider via `services/ai` for AI suggest
  (unchanged); no new external services.

---

## 3. UI layouts

All surfaces are in the portal React app (`ai-server/src/portal/src/`).

### 3.1 User flows

**WS-A: classify a discovered app (head or superadmin)**
- Open LOB → App Classifications tab → "Apps your team used recently that
  aren't classified yet" widget.
- Each row now shows: cleaned display name (bold) + raw identifier (small
  grey) + `AppKindBadge` + usage stats + an inline classification select +
  **Add** button.
- One click on Add (with a chosen classification) creates the catalog entry
  (cleaned name) + the per-LOB rule, removes the row, and flashes success.
- "Customize…" (secondary action per row) opens the existing Add modal,
  pre-filled with the cleaned name; if `PORTAL_AI_APP_SUGGEST=on` the AI
  lookup fires automatically on open and populates suggestions.

**WS-B: assign a location (superadmin)**
- Settings → new "Locations" card: list / add / rename / deactivate locations.
- Employees page → pencil icon per row → "Edit Employee" modal (location
  select only) → save → list refreshes showing the location chip.
- Employees page → new Location filter dropdown (client-side filter on the
  merged profile data).

**WS-C: read consistent categories (any portal user)**
- Employee Detail shows the six-card KPI strip + an ⓘ legend popover defining
  Productive / Non-Productive / Neutral / Idle / Active / Office.
- Dashboard shows Productive, Non-Productive, **Neutral**, Productivity %,
  Active Employees; donut has three segments.
- Time Logs / Reports render the 4-state badge and a Neutral filter option.

### 3.2 Screens and components

- `components/common/AppKindBadge.jsx` — **new**. Props: `matchBy`
  (`'process'|'url'`), `size`. Renders Monitor/Globe icon + label chip
  (indigo for Desktop, teal for Website). Used by LobDetailPage,
  AppClassificationsPage, AddAppModal.
- `components/common/CategoryBadge.jsx` — **new**. Props: `classification`.
  Maps the canonical taxonomy → color (green/red/blue-grey/grey). Replaces the
  inline ternaries in TimeLogsPage, ReportsPage, EmployeeDetailPage.
- `components/common/CategoryLegend.jsx` — **new**. ⓘ popover with the §1.2
  definitions; used on Dashboard + Employee Detail.
- `pages/LobDetailPage.jsx` — **modified**: UnlistedApps row layout (clean
  name, badge, inline quick-classify), `openAddFor` pre-fills cleaned name,
  AddAppModal auto-triggers AI lookup when opened with a prefill and the
  feature is available, `match_by` filter toggle on the classifications table.
- `pages/AppClassificationsPage.jsx` — **modified**: Match By column renders
  `AppKindBadge`.
- `pages/EmployeesPage.jsx` — **modified**: Location column + filter + edit
  modal (superadmin only sees the pencil).
- `pages/EmployeeDetailPage.jsx` — **modified**: six-card KPI strip, legend,
  corrected daily-trend math labels.
- `pages/DashboardPage.jsx` — **modified**: Neutral KPI card, 3-segment donut.
- `pages/SettingsPage.jsx` — **modified**: Locations management card
  (superadmin).
- `utils/appNames.js` — **new** (frontend mirror of the backend cleaner for
  optimistic rendering; single source of truth stays backend — §4.2).

Critical states: every new fetch keeps the existing pattern (LoadingSpinner /
ErrorBanner / empty-state copy). The unlisted widget keeps its non-blocking
"background scan failed silently, Rescan available" behavior.

---

## 4. File and function names (physical structure)

> Portal exception to the template's `org_id` rule: portal analytics
> intentionally read across all Jira orgs (single logical organization —
> LOB plan §0.6). New **portal-owned** tables here are company-wide and carry
> no `org_id` by design, matching `portal_lobs` et al.

### 4.1 Forge app

Not touched by this plan.

### 4.2 AI server (`ai-server/src/`)

```text
ai-server/src/
  controllers/
    portal-controller.js                      # MOD: employees list/detail merge location; category fields
    portal-reports-controller.js              # MOD: neutral/idle columns; location in employee-summary CSV
    portal-lob-app-classifications-controller.js  # MOD: unlisted rows gain displayName (cleaned)
    portal-employee-profile-controller.js     # NEW: locations CRUD + profile upsert
    portal-auth-controller.js                 # MOD (WS-D): reset-email brand strings
  services/
    notifications/templates/admin-invite.js   # MOD (WS-D): brand strings
    portal-service.js                         # MOD: consume new RPC fields; fix detail math; spelling-safe filters
    portal-app-name-service.js                # NEW: cleanDisplayName(identifier) heuristic (pure)
    portal-employee-profile-service.js        # NEW: locations + profiles domain logic
    db/
      portal-employee-profile-db-service.js   # NEW: Supabase queries for the two new tables
  portal/src/                                 # frontend changes per §3.2
  portal/index.html                           # MOD (WS-D): <title>
  .env.example                                # MOD (WS-D): MAIL_FROM_NAME doc
tests/
  controllers/
    portal-employee-profile-controller.test.js  # NEW
    portal-lob-app-classifications-controller.test.js  # MOD: displayName assertions
  services/
    portal-app-name-service.test.js           # NEW
    portal-employee-profile-service.test.js   # NEW
    portal-service.test.js                    # MOD: category fields + math fixes
```

Key functions:

- `services/portal-app-name-service.js`
  - `cleanDisplayName(identifier)` — pure; `'shellexperiencehost.exe'` →
    `'Shell Experience Host'`, `'org.gnome.Nautilus'` → `'Nautilus'`,
    `'docker desktop.exe'` → `'Docker Desktop'`. Rules: strip known extensions
    (`.exe`, `.app`), take last dotted segment for reverse-DNS ids, split
    camelCase/snake_case/kebab-case, collapse digits-only suffixes (`idea64` →
    `Idea`… see test table), title-case, max 120 chars. Never throws; returns
    the trimmed input if cleaning would produce an empty string.
- `services/portal-employee-profile-service.js`
  - `listLocations({includeInactive})`, `createLocation(name, createdBy)`,
    `updateLocation(id, {name,isActive})`, `deleteLocation(id)` — name unique
    (409 on duplicate), delete blocked with 409 if any profile references it.
  - `getProfilesForUsers(userIds)` — map `user_id → {locationId, locationName}`.
  - `setEmployeeLocation(userId, locationId, updatedBy)` — validates the user
    exists in `users` (read-only check) and the location exists; upserts.
- `services/portal-service.js`
  - `getDashboardData` / `getEmployees` / `getApplicationUsage` — pass through
    new `neutral_seconds` / `idle_seconds`; expose `neutralHours`, `idleHours`,
    `activeHours`, `officeHours` per the §1.2 taxonomy.
  - `getEmployeeDetail` — drop the `neq('is_idle', true)` filter, bucket rows
    into the four categories in one pass, **daily % uses
    productive ÷ (productive + non_productive)** (same as summary).
  - `getTimeLogs` — non-productive filter becomes
    `.in('classification', ['non_productive','non-productive'])`; new
    `neutral` filter value → `.in('classification', ['private','unknown'])`
    (plus NULL via `or`); optional `includeIdle` param (default false keeps
    today's behavior).
- `controllers/portal-employee-profile-controller.js` — request parsing +
  superadmin checks only (write ops); read endpoints allow any portal user.
- `controllers/portal-lob-app-classifications-controller.js`
  - `getUnlistedApps` — each row gains
    `displayName: appNameService.cleanDisplayName(identifier)`.

### 4.3 Python desktop app

Not touched by this plan.

### 4.4 Supabase (`supabase/`)

```text
supabase/migrations/
  20260610_portal_employee_profiles.sql            # NEW (WS-B)
  20260610_portal_analytics_category_breakdown.sql # NEW (WS-C)
```

Details in §6/§7.

---

## 5. API contracts

### 5.1 Forge resolver API

Not applicable — no Forge changes.

### 5.2 AI server HTTP endpoints

All endpoints use `portal-auth.js` (`verifyPortalToken`); role checks inline
per the existing portal pattern. All responses follow
`{ success, data | error }`.

**New (WS-B):**

| Method & path | Role | Body / params | Response data |
|---|---|---|---|
| `GET /api/portal/locations?includeInactive=` | any portal user | — | `[{id, name, isActive}]` |
| `POST /api/portal/locations` | superadmin | `{name}` (1–120 chars) | created location; `409` duplicate name |
| `PUT /api/portal/locations/:id` | superadmin | `{name?, isActive?}` | updated location; `404`/`409` |
| `DELETE /api/portal/locations/:id` | superadmin | — | `409 LOCATION_IN_USE` if referenced; else success |
| `PUT /api/portal/employees/:userId/profile` | superadmin | `{locationId: uuid\|null}` | `{userId, locationId, locationName}`; `404` unknown user/location |

**Modified:**

- `GET /api/portal/employees` (and `/employees/list`) — each row gains
  `location: {id, name} | null` (merged in Node from
  `portal_employee_profiles`; no RPC change).
- `GET /api/portal/employees/:userId` — `user.location` added; `summary` gains
  `neutralHours`, `idleHours`, `activeHours`, `officeHours`; `dailyTrend[*]`
  gains `neutralHours`, `idleHours` and its `productivityPercentage` switches
  to the canonical denominator (**behavioral change, AC-C4**).
- `GET /api/portal/dashboard` — `summary` gains `totalNeutralHours`
  (idle intentionally not surfaced org-wide, Q-C2); `dailyTrend[*]` gains
  `neutralHours`.
- `GET /api/portal/time-logs` — `classification` filter accepts
  `productive | non-productive | neutral`; rows expose the canonical
  `category` field alongside the raw `classification`.
- `GET /api/portal/lobs/:lobId/unlisted-apps` — rows gain `displayName`.
- `GET /api/portal/reports/data|export/*` — `daily-summary` and
  `employee-summary` types gain `neutralHours`/`idleHours`
  (+ `location` column on employee-summary).

Errors keep the existing shape `{ success:false, error: string }` with 400 /
403 / 404 / 409 / 500.

### 5.3 Supabase Edge Functions

Not applicable.

---

## 6. Database structure

### 6.1 New tables (WS-B) — both portal-owned, company-wide (no `org_id` by
design, same rationale as `portal_lobs`; documented here per the
multi-tenancy guard)

**`portal_locations`**

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK default `gen_random_uuid()` | |
| `name` | VARCHAR(120) NOT NULL | `UNIQUE` |
| `is_active` | BOOLEAN NOT NULL default TRUE | soft-retire |
| `created_by` | UUID NULL → `portal_admin_users(id)` ON DELETE SET NULL | |
| `created_at` / `updated_at` | TIMESTAMPTZ NOT NULL default now() | updated_at trigger, `search_path=''` |

**`portal_employee_profiles`**

| Column | Type | Notes |
|---|---|---|
| `id` | UUID PK default `gen_random_uuid()` | |
| `user_id` | UUID NOT NULL **UNIQUE** | **soft reference** to `users.id` — intentionally NO FK (LOB plan §0.7 pattern) |
| `location_id` | UUID NULL → `portal_locations(id)` | ON DELETE RESTRICT (delete endpoint returns 409 first) |
| `updated_by` | UUID NULL → `portal_admin_users(id)` ON DELETE SET NULL | |
| `created_at` / `updated_at` | TIMESTAMPTZ NOT NULL default now() | trigger as above |

Indexes: `portal_employee_profiles(location_id)`,
`portal_employee_profiles(user_id)` (unique), FK-audit indexes on
`created_by`/`updated_by`. RLS: enabled on both tables with the standard
`service_role` defense-in-depth policy (portal authorization lives in
ai-server code).

Future-proofing: Department/Shift land as additional nullable columns on
`portal_employee_profiles` later — no rework needed.

### 6.2 Changes to existing tables

None. (`users`, `activity_records`, `portal_app_catalog` untouched.)

### 6.3 New or modified views / functions (WS-C)

`CREATE OR REPLACE` of `portal_dashboard_summary` and
`portal_app_usage_summary` (JSON / same return shape + additive keys), and
**DROP + CREATE** of `portal_employee_summary` (its `RETURNS TABLE` gains
columns, which Postgres cannot do via `OR REPLACE`). All three:

- stop filtering idle out and instead aggregate
  `idle_seconds = sum(duration) FILTER (WHERE is_idle = true)`;
- `neutral_seconds = sum(duration) FILTER (WHERE is_idle <> true AND
  (classification IS NULL OR classification NOT IN
  ('productive','non_productive','non-productive')))`;
- keep `productive_seconds` / `nonproductive_seconds` semantics identical to
  today (both non-productive spellings counted) so existing numbers do not
  shift (AC-C1);
- remain `SECURITY INVOKER`, `STABLE`, `set search_path = ''`,
  `p_user_ids` semantics unchanged.

`portal_app_usage_summary` keeps its `is_idle <> true` filter (app usage of
idle blocks is meaningless) — only dashboard + employee functions change
their idle handling.

---

## 7. Migration files

- `20260610_portal_employee_profiles.sql` — creates `portal_locations` +
  `portal_employee_profiles` with RLS, triggers, indexes (depends on
  `20260521_add_portal_admin_users.sql`). Optionally seeds nothing — locations
  are entered by the superadmin (Q-B1 decides if we seed an initial list).
- `20260610_portal_analytics_category_breakdown.sql` — replaces the three
  aggregate functions per §6.3 (depends on
  `20260602_portal_analytics_aggregates.sql`). Top-of-file comment documents
  the DROP+CREATE of `portal_employee_summary` and why.

Rules honored: new files only, `IF NOT EXISTS` guards, purpose comment block,
re-runnable. Delivered as files; applied by the project owner (standing
operating rule: assistant never writes to the production DB).

### 7.2 Data migrations / seed

No backfill needed: profiles start empty (UI shows "—" for no location);
category aggregates are computed at read time.

---

## 8. Background jobs and Edge Functions

No background jobs for this feature.

---

## 9. Test plan

Failing tests are written first, mapped 1:1 to the acceptance criteria in §14.

### 9.1 Unit tests (ai-server, Jest; mock `services/db/supabase-client`)

- `tests/services/portal-app-name-service.test.js` — table-driven:
  `('devenv.exe','Devenv')` is **wrong** → expected mappings include
  `shellexperiencehost.exe → Shell Experience Host`,
  `org.gnome.Nautilus → Nautilus`, `msrdc.exe → Msrdc` (documents the
  heuristic's honest limit), `docker desktop.exe → Docker Desktop`,
  `TimeTracker.exe → Time Tracker`, empty/garbage input → input echoed,
  length cap, no-throw guarantee.
- `tests/services/portal-employee-profile-service.test.js` — locations CRUD
  (duplicate 409, delete-in-use 409, rename), `setEmployeeLocation` happy /
  unknown user / unknown location / clear (null), `getProfilesForUsers`
  batching and empty input.
- `tests/controllers/portal-employee-profile-controller.test.js`
  (supertest) — superadmin-only write enforcement (403 for admin/viewer/head),
  validation 400s, response shapes.
- `tests/services/portal-service.test.js` (extend) —
  - dashboard/employee summaries pass through `neutral`/`idle` fields;
  - `getEmployeeDetail`: single dataset where daily % and summary % now agree;
    idle rows counted into `idleHours`, excluded from the ratio;
  - `getTimeLogs`: `non-productive` filter matches both spellings; `neutral`
    filter matches `private`/`unknown`/NULL; default still excludes idle.
- `tests/controllers/portal-lob-app-classifications-controller.test.js`
  (extend) — unlisted rows carry `displayName` ≠ raw identifier for `.exe`
  inputs.
- `tests/controllers/portal-reports-controller.test.js` (**new**, supertest) —
  daily-summary / employee-summary include the new columns in JSON and CSV
  header rows; employee-summary CSV includes Location.
- **WS-D brand guards**:
  - `tests/notifications/templates.test.js` (extend) — `admin-invite`
    subject/text/html contain "Amzur Time Tracker" and do **not** contain
    "Productivity Portal" or "Jira".
  - `tests/controllers/portal-auth-controller.test.js` (**new**, supertest,
    mock `notifme-wrapper`) — forgot-password dispatch is called with a
    subject/body containing "Amzur Time Tracker" and free of
    "Productivity Portal".
  - Frontend grep guard (lint step or jest test reading source files):
    `portal/src/**/*.jsx` + `portal/index.html` contain no user-visible
    "Productivity Portal", "BRD", or "Jira" strings (allowlist: code
    comments, api paths, localStorage keys).

### 9.2 Integration tests

- None new beyond controller-level supertest (portal has no Forge Remote
  surface). Manual verification against a real Supabase instance with the two
  migrations applied is part of the rollout checklist (§12).

### 9.3 End-to-end (manual script for QA)

1. Apply both migrations → open an LOB with unclassified usage → verify clean
   names + kind badges → quick-classify one app → it moves into the table with
   the chosen classification.
2. Create two locations → assign to an employee → verify Employees column,
   filter, detail header, and employee-summary CSV.
3. Open Employee Detail for a user with idle + private rows → six KPI cards
   sum correctly (Office = Active + Idle; Active = P + NP + N) and daily %
   matches the summary definition; Dashboard neutral card and 3-segment donut
   render; Time Logs neutral filter works.

---

## 10. Interaction diagrams

Portal layer reference (used by all diagrams; Forge/desktop layers are not
crossed by this feature):

```
React page (portal/src/pages/*)
  → axios (portal/src/api/*, Bearer portal JWT)
    → Express route (ai-server src/index.js)
      → portal-auth middleware (verifyPortalToken)
        → controller → service → db-service / RPC → Supabase (service role)
```

### 10.1 Happy path — quick-classify a discovered app (WS-A)

1. LobDetailPage mounts → `GET /api/portal/lobs/:lobId/unlisted-apps`.
2. `verifyPortalToken` → `getUnlistedApps` resolves LOB scope
   (superadmin or head of this LOB; 403 otherwise).
3. Controller calls `portal_app_usage_summary` RPC (scoped to the LOB's
   user_ids), filters out cataloged identifiers, and maps each row through
   `portal-app-name-service.cleanDisplayName()`.
4. Widget renders `displayName` (bold) + raw identifier + `AppKindBadge` +
   usage stats + inline classification select.
5. User picks "Productive" and clicks **Add** →
   `POST /api/portal/lobs/:lobId/apps`
   `{identifier, displayName (cleaned), matchBy:'process', classification:'productive'}`.
6. `addLobApp` find-or-creates the catalog entry (no org default — head's
   choice never leaks to other LOBs) and upserts the per-LOB rule.
7. UI removes the row from the widget, adds the merged row to the table,
   flashes "Added Shell Experience Host".

### 10.2 Failure path — AI suggest unavailable (WS-A)

1–4. As above; user clicks "Customize…" → AddAppModal opens pre-filled with
   the cleaned name; modal auto-fires `POST /api/portal/app-catalog/ai-suggest`.
5. Flag off → `{available:false, suggestions:null}` → AI panel hidden, manual
   entry proceeds. Provider error → controller logs a warning and returns
   `{available:true, suggestions:null}` → modal shows "No suggestion — enter
   details manually"; **the modal never blocks on AI** (existing contract,
   preserved).
6. Submit proceeds exactly as 10.1 steps 5–7. No Supabase write happens until
   the user submits.

### 10.3 Happy path — assign employee location (WS-B)

1. Superadmin opens Employees → pencil → modal loads
   `GET /api/portal/locations`.
2. Picks "Hyderabad" → `PUT /api/portal/employees/:userId/profile
   {locationId}`.
3. Controller: superadmin check → service validates user exists in `users`
   (read-only) and location exists/active → db-service upserts
   `portal_employee_profiles` on `user_id`.
4. Employees page refetches; `getEmployees` merges
   `getProfilesForUsers(rows.map(user_id))` into each row → Location chip
   renders; filter dropdown includes Hyderabad.

### 10.4 Failure path — category RPC migration not applied (WS-C)

1. Dashboard calls `GET /api/portal/dashboard`.
2. `portal_dashboard_summary` RPC returns the **old** JSON shape (no
   `neutral` keys) because `20260610_portal_analytics_category_breakdown.sql`
   was not applied.
3. `portal-service` treats missing keys as `0` via `Number(...) || 0` and the
   frontend hides the Neutral card when the field is absent/zero-and-undefined
   (`'totalNeutralHours' in summary` guard) — the page renders today's view,
   no crash, no wrong numbers.
4. A `logger.warn` ("category breakdown fields missing — migration applied?")
   fires once per process so the gap is diagnosable in production
   (mirrors the 20260602 rollout lesson).

---

## 11. Risks, edge cases, and open questions

### 11.1 Risks

- **Dropping the idle filter in two RPCs** touches every dashboard/employee
  number. Mitigated by: keeping `productive/nonproductive` math byte-identical
  (AC-C1) and adding only new keys; verified by golden-number tests.
- **`portal_employee_summary` DROP+CREATE** briefly removes the function —
  apply during low usage; ai-server tolerates RPC errors with a 500 on those
  endpoints only (no data corruption possible; read-only).
- Heuristic name cleaning will be wrong for opaque executables (`msrdc.exe`).
  Mitigation: raw identifier always shown alongside; name editable in the
  modal; AI suggest (when on) usually knows the product name. We accept
  "better than raw" not "always right".
- PDF/CSV column additions can break downstream spreadsheet consumers —
  flagged in release notes; columns are appended, not reordered.
- Per the standing rule, migrations are delivered as files and applied by the
  owner — the plan's numbers don't appear until both migrations are applied
  (10.4 covers the gap behavior).

### 11.2 Edge cases

- Unlisted app identifier collides with an **inactive** catalog entry →
  existing find-or-create reuses it; quick-classify then sets the LOB rule
  (no duplicate, AC-A3 covers).
- Same app used by multiple LOBs: quick-add from LOB X must not set a default
  visible to LOB Y (existing `addLobApp` guarantee — regression-tested).
- Employee deleted/orphaned in `users` but present in
  `portal_employee_profiles` (soft ref) → profile rows are ignored on merge
  (orphan tolerance, same as `portal_lob_employees`).
- Location deactivated while assigned → stays displayed (greyed) and
  filterable; cannot be newly assigned.
- Days with **only idle** activity → Office > 0, Active = 0, productivity %
  = 0 with "no active time" tooltip rather than a misleading 0% red badge.
- All-neutral day → ratio denominator 0 → 0% with the same tooltip.
- Legacy `non-productive` rows: counted as Non-Productive everywhere
  (filters, badges, RPCs) — AC-C5.
- `lobId` analytics filter still no-ops while `PORTAL_LOB_ENFORCEMENT=off`
  (pre-existing behavior, untouched by this plan; noted to avoid QA
  confusion).

### 11.3 Open questions (need manager sign-off; blocking only their own AC)

- **Q-A1**: Should catalog `display_name` also replace raw names in **Time
  Logs and the Application Usage report** (requires an application_name →
  catalog join at read time)? Recommended **yes, as a follow-up plan** —
  excluded here to keep this plan's surface contained.
- **Q-B1**: Location values — managed list (recommended, matches the
  dropdown reference) confirmed? Seed an initial list (e.g. Tampa /
  Hyderabad) or start empty?
- **Q-C2**: Should **Idle** appear on the org-wide Dashboard (EmpMonitor
  shows it) or only on Employee Detail? Plan assumes **employee-detail only**;
  flipping later is one KPI card.
- **Q-C3**: AI pipeline currently defaults failed classifications to
  `productive` (inflates the ratio). Recommend changing the fallback to
  `unknown` in a separate ai-server plan (affects Jira-side analytics too) —
  approve separately.
- **Q-D1**: Final marketing copy for the LoginPage hero/feature card after
  removing the Jira lines (plan proposes "See the full picture." /
  "Work is intelligently categorized using AI analysis."). Any wording works
  technically; needs a one-line OK.

---

## 12. Rollout and feature flagging

- **No new env flags.** WS-A/WS-B are additive UI + new endpoints. WS-C is
  rollout-safe via response-shape detection (frontend renders new cards only
  when the new fields are present — §10.4), so the portal works against a DB
  with or without the new migration.
- Existing flags unchanged: `PORTAL_AI_APP_SUGGEST` keeps gating AI suggest
  (auto-run included); `PORTAL_LOB_ENFORCEMENT` / `PORTAL_LOB_PRODUCTIVITY`
  untouched.
- **Additive-only**: no endpoint, field, or RPC key is renamed or removed;
  `portal_employee_summary` is re-created with a superset of columns.
- **Deploy order**:
  1. Apply `20260610_portal_employee_profiles.sql` then
     `20260610_portal_analytics_category_breakdown.sql` (owner applies;
     delivered as files).
  2. Deploy ai-server.
  3. Build + deploy the portal frontend (Vercel).
  (Front/backend order is forgiving thanks to shape detection, but DB-first
  avoids the §10.4 degraded mode.)
- **Rollback**: new reversal migration re-creating the 20260602 function
  bodies; ai-server/frontend redeploy previous build. `portal_locations` /
  `portal_employee_profiles` can stay in place (inert) on rollback.

---

## 13. Notification events

No notification events for this feature.

---

## 14. Acceptance criteria

Numbered; tests in §9 map 1:1. "Verified" = covered by an automated test
unless marked (manual).

**WS-A — Add Application UX**
- **AC-A1** Unlisted-apps rows display a cleaned `displayName` (per the
  §4.2 heuristic table) with the raw identifier still visible; the Add modal
  opened from an unlisted app pre-fills the cleaned name, never the raw
  identifier.
- **AC-A2** With `PORTAL_AI_APP_SUGGEST=on`, opening the Add modal from an
  unlisted app fires the AI lookup automatically; flag off / provider failure
  leaves the modal fully usable (no error banner) — existing contract
  preserved.
- **AC-A3** Each unlisted row offers inline classification + Add: one click
  creates/reuses the catalog entry **without** an org default and upserts the
  per-LOB rule; the row leaves the widget and appears in the table with the
  chosen classification.
- **AC-A4** Every app listing (LOB classifications table, unlisted widget,
  Add modal, legacy page Match By column) renders the shared `AppKindBadge`
  with distinct icon + color for Desktop vs Website; the LOB table gains an
  All/Desktop/Website filter.

**WS-B — Employee Location**
- **AC-B1** Superadmin can create/rename/deactivate locations; duplicate
  names → 409; deleting a referenced location → 409 `LOCATION_IN_USE`.
- **AC-B2** Superadmin can set/clear an employee's location; non-superadmin
  write attempts → 403; unknown user or location → 404; `users` table is
  never written.
- **AC-B3** Employees list and detail expose `location`; the Employees page
  shows a Location column and filter; employee-summary CSV includes a
  Location column. Employees without a profile render "—".

**WS-C — Category clarity**
- **AC-C1** Existing productive / non-productive totals and productivity %
  are numerically unchanged by the new RPCs for identical inputs
  (golden-number test).
- **AC-C2** Dashboard and employee summaries expose `neutral` and (employee
  only) `idle` hours; Employee Detail shows Office / Active / Productive /
  Non-Productive / Neutral / Idle / % cards where
  Office = Active + Idle and Active = P + NP + Neutral (sum-check test).
- **AC-C3** Time-log rows expose a canonical `category`; badges render four
  distinct states; the classification filter offers Neutral and the
  non-productive filter matches both spellings.
- **AC-C4** Employee-detail daily-trend % uses the canonical denominator
  (productive ÷ (productive + non_productive)) and equals the summary % when
  computed over a single day (consistency test).
- **AC-C5** Rows with classification `private`, `unknown`, NULL, or legacy
  `non-productive` are bucketed per the §1.2 taxonomy in every surface
  (RPCs, detail page, time logs, reports).
- **AC-C6** With the WS-C migration absent, all portal pages render today's
  view without errors and a diagnostic warning is logged (degraded-mode test
  with old-shape RPC mock).

**WS-D — Rebrand**
- **AC-D1** No user-visible string in the portal frontend
  (`portal/src/**/*.jsx`, `portal/index.html`) contains "Productivity
  Portal", "BRD", or "Jira"; the browser tab title, sidebar brand block, and
  login page all read "Amzur Time Tracker" (grep-guard test).
- **AC-D2** The admin-invite email and the password-reset email
  (subject, text, and HTML) read "Amzur Time Tracker" and contain no
  "Productivity Portal" or "Jira" (template + controller tests).
- **AC-D3** Internal identifiers are unchanged: `/api/portal/*` routes,
  `portal_token`/`portal_user` keys, `PORTAL_*` env names, and `portal_*`
  tables — verified by the existing test suites passing unmodified.
- **AC-D4** `.env.example` documents `MAIL_FROM_NAME=Amzur Time Tracker`;
  rollout checklist includes updating the live env value (manual).

---

## 15. Delivery slices (suggested PR order)

0. **PR-0 (WS-D)** — pure string/branding changes + grep-guard tests
   (AC-D1…D4). Zero behavioral risk; ships first.
1. **PR-1 (WS-A)** — `portal-app-name-service` + unlisted `displayName` +
   modal pre-fill/auto-AI + `AppKindBadge` + quick-classify (tests AC-A1…A4).
2. **PR-2 (WS-B)** — migration file + profile service/controller + Employees
   UI (tests AC-B1…B3).
3. **PR-3 (WS-C)** — migration file + RPC consumption + detail-page math fix +
   badges/filters/reports (tests AC-C1…C6).

Each PR is independently revertible; no PR depends on a later one.
