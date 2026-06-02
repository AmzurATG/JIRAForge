# Plan — Web Productivity Portal: Line-of-Business (LOB) Segmentation & Role-Based Access

> Component: `ai-server` (portal sub-app) + `supabase` (new **portal-owned** tables only).
> File follows `plan/base_plan/PLAN_TEMPLATE.md`.
> Date: 2026-06-01
> Status: APPROVED (design) — core decisions + Q1 signed off 2026-06-02; Q3 (LOB viewer tier)
> deferred. Design only, no implementation in this document.

---

## 0. Decisions locked with stakeholder (no assumptions)

These were confirmed before writing this plan and drive every section below:

1. **"Existing tables" that must NOT be touched = the Jira/AI tables** — specifically
   `application_classifications`, `users`, `activity_records`, `organizations`, and any
   other table owned by the desktop-app / ai-server / forge-app pipeline.
   **Portal-owned tables (`portal_admin_users` and any new `portal_*` table) MAY be
   created or extended.**
2. **LOB app classification is a NEW, portal-only feature.** It does **not** feed the
   upstream AI/classification pipeline and does **not** modify `activity_records` or the
   Jira `application_classifications` table. It is an independent per-LOB list stored in a
   new portal table.
3. **Membership is many-to-many:** one employee can belong to multiple LOBs; one person
   can be head of multiple LOBs.
4. **LOB head can: view their LOB members' analytics + manage (CRUD) the app-classification
   list for the LOBs they head.** Only the **superadmin** creates LOBs and assigns
   members/heads, and the superadmin sees everything.
5. **"LOB head" is derived from a new assignment table**, not a new role value — the
   existing `portal_admin_users.role` CHECK (`superadmin|admin|viewer`) is left untouched.

**Update — decisions confirmed 2026-06-02:**

6. **Single logical organization.** The company runs several separate Jira organizations
   (`organizations` rows), but for this portal feature they are treated as **one logical
   organization**. The portal is a single-tenant deployment for this company and reads across
   all underlying Jira orgs. Therefore the new LOB tables are **not scoped to a Jira
   `organizations.id`** — scoping is purely by LOB membership. (Q5)
7. **No foreign keys from LOB tables into Jira-owned tables.** `user_id` is a **soft
   reference** to `users.id` (no FK); LOB tables carry no FK to `organizations`. This is the
   chosen way to guarantee the feature can never disturb the main Jira application. (Q4)
8. **Existing global app-classifications portal page is kept as-is for now** (untouched);
   the new per-LOB app feature is added alongside it, pending a later call. (Q2)
9. **App-classification model (clarified 2026-06-02):** a **shared app catalog** that we seed
   and that **superadmins add to / delete from**. Apps are one of two kinds — **desktop**
   (matched by process/exe, e.g. `slack.exe`) or **browser/website** (matched by domain/url,
   e.g. `youtube`). On top of the catalog, each LOB applies its **own classification**
   (productive / non_productive / private), and the **same app can be classified differently
   by different LOBs** (YouTube non-productive for one LOB, productive for another). Modeled as
   two new tables: `portal_app_catalog` + `portal_lob_app_classifications` (§6.1).
10. **App classifications DRIVE the productivity numbers (Q1 — APPROVED 2026-06-02).** The
    portal re-derives productive/non-productive **at read time** using each LOB's
    classifications, with precedence **per-LOB rule → org-wide default → `neutral`**. A new
    **`neutral`** state is added so unrated/unmatched activity is counted as time but excluded
    from the productive ÷ (productive + non-productive) ratio. This stays entirely portal-side
    — the AI pipeline, `activity_records`, and Jira tables are still untouched. Industry-standard
    model (ActivTrak / Time Doctor / Insightful all use default → per-group override that drives
    the metric). Delivered in two phases (§12): Phase 1 = catalog + per-LOB config; Phase 2 =
    flip on consumption behind a flag after browser/domain matching is validated.
11. **Still open (low priority):** read-only **LOB viewer** tier (Q3) — deferred; schema already
    reserves `portal_lob_heads.role` so it needs no rework. See §11.3.

---

## 1. Scope & goals

### 1.1 Feature overview

Today the portal ([ai-server/src/portal/](../ai-server/src/portal/)) shows **all** employees'
productivity to **every** authenticated portal user. Analytics in
[portal-service.js](../ai-server/src/services/portal-service.js) query `activity_records`
and `users` with **no org and no per-user scoping**, under the Supabase **service-role key**
(RLS bypassed — see [supabase-client.js](../ai-server/src/services/db/supabase-client.js)).

This feature introduces **Line of Business (LOB)** as an organizational unit *inside the
portal* and enforces **role-based, LOB-scoped access**:

- **Superadmin** — global. Creates/edits/deletes LOBs, assigns employees and heads to LOBs,
  manages any LOB's app-classification list, and sees all data across all LOBs.
- **LOB head** — scoped. Sees analytics **only for employees in the LOB(s) they head**, and
  manages the app-classification list **only for those LOB(s)**.
- **Per-LOB app classification** — each LOB maintains its own productive / non_productive /
  private application list (portal-only; independent of the Jira pipeline).

Components touched:
- `ai-server` — new portal controllers/services/db modules; modify existing portal analytics
  controllers/service to apply scope; mount new routes in
  [index.js](../ai-server/src/index.js).
- `supabase` — new **portal-owned** migration files (new tables only). No change to any
  Jira/AI table.
- Portal frontend (`ai-server/src/portal/`) — new admin pages (LOB management, per-LOB app
  list), LOB filters on analytics pages, role-aware navigation.

Primary personas: **superadmin** (org owner / HR lead), **LOB head** (department/practice
lead), and indirectly the **tracked employee** (whose `users`/`activity_records` rows are
read but never written by this feature).

### 1.2 In scope

- New portal data model for LOBs, LOB↔employee membership (M:N), LOB↔head assignment (M:N),
  and per-LOB app classifications — all in **new `portal_*` tables**.
- A single authoritative **scope-resolution** step (per request) that converts the calling
  portal user into `{ isSuperadmin, visibleLobIds, visibleUserIds }`.
- Backend enforcement: every analytics endpoint restricted to `visibleUserIds`; every LOB
  management endpoint restricted by role; per-LOB app-classification endpoints restricted to
  superadmin or the head of that LOB.
- Frontend: superadmin LOB-management UI (LOBs, members, heads); per-LOB app-classification
  UI; LOB filter on Dashboard / Employees / Time Logs / Reports; navigation gated by role;
  "Access Denied" states for unscoped users.
- Backfill/onboarding path for existing portal users and existing employees.

### 1.3 Out of scope

- **No change to the AI classification pipeline.** The new per-LOB app list does NOT
  re-classify activity, does NOT change `activity_records.classification`, and does NOT
  touch the Jira `application_classifications` table or its existing portal endpoints.
- ~~Consumption of the LOB app list inside analytics~~ — **now IN scope (Q1 approved
  2026-06-02).** The portal re-derives productive/non-productive at read time from each LOB's
  classifications (precedence per-LOB rule → org default → `neutral`), delivered in Phase 2
  (§12). It still never re-classifies `activity_records` or touches the AI pipeline / Jira
  tables — the re-derivation is computed in the portal at query time only.
- **No new "LOB viewer" tier (this phase).** Only superadmin (global) and LOB head (scoped).
  A read-only LOB tier is a deferred extension (Q3, §11.3).
- The pre-existing portal authentication gaps found during review (Google-only login,
  orphaned `/forgot-password` & `/reset-password` routes, `ErrorBanner onDismiss` mismatch)
  are **not** addressed here — tracked separately.
- Multi-org tenancy hardening of the existing analytics queries beyond what LOB scoping
  introduces (the portal remains effectively single-org; see §2.1).

---

## 2. Assumptions & dependencies

### 2.1 Assumptions

- **Single logical organization (confirmed 2026-06-02).** The company operates several
  separate Jira organizations (`organizations` rows: amzur, evoke, itracker, …); for this
  portal feature they are treated as **one logical organization**. The portal is a
  single-tenant deployment for this company and continues to read analytics across **all**
  underlying Jira orgs (no per-Jira-org filter). Consequently the new LOB tables are **not
  scoped to a Jira `organizations.id`** — an LOB may contain employees drawn from any
  underlying Jira org, and scoping is **purely by LOB membership** (see §6.1).
- The Supabase **service-role** client is the only DB path the portal uses, so RLS is **not**
  the enforcement mechanism for the portal — **authorization is enforced in ai-server
  application code**. RLS policies on the new tables are added for defense-in-depth only and
  are documented as non-authoritative for the portal path.
- "Employees / members" = rows in the Jira-owned `users` table (the tracked desktop-app
  users), referenced by `users.id` and `activity_records.user_id`.
- "Portal users / heads" = rows in `portal_admin_users` (id, email, display_name, role,
  org_id), authenticated via the existing portal JWT (`PORTAL_JWT_SECRET`, payload
  `{ userId, orgId, email, role }` — see
  [portal-auth.js](../ai-server/src/middleware/portal-auth.js)).
- `users`, `activity_records`, and `organizations` are **read-only** to this feature and are
  never altered.

### 2.2 Dependencies

- Existing portal auth + JWT middleware
  ([portal-auth.js](../ai-server/src/middleware/portal-auth.js)) — reused unchanged for
  authentication; **authorization** logic is added on top.
- Existing analytics service
  ([portal-service.js](../ai-server/src/services/portal-service.js)) — modified to accept a
  scope filter.
- Supabase migration tooling (`supabase db reset` for dev replay).
- No dependency on any Jira-owned table for schema creation — the LOB tables stand alone
  (no FK into `organizations` or `users`; see §6.1). They only reference
  `portal_admin_users(id)` for `created_by`/`added_by`/`assigned_by`.

---

## 3. UI layouts

### 3.1 User flows

**Superadmin — LOB management (new):**
- Open **Line of Businesses** (new nav item, superadmin-only).
- Create an LOB (name, description). Edit / deactivate / delete an LOB.
- Open an LOB → **Members** tab: search the employee directory (`users`) and add/remove
  employees (M:N). → **Heads** tab: add/remove portal admins as heads of this LOB (M:N).
- Open an LOB → **App Classifications** tab: manage that LOB's productive/non_productive/
  private list (CRUD + bulk import).

**LOB head — scoped experience:**
- Dashboard / Employees / Time Logs / Reports show only employees in the LOB(s) they head.
- An **LOB filter** dropdown lists only the head's LOB(s); "All my LOBs" is the default
  (union, de-duplicated).
- **App Classifications** page lets the head pick one of their LOBs and manage its list.
- LOB management nav item is hidden; direct navigation shows "Access Denied".

**Unscoped portal user** (non-superadmin with zero head assignments):
- Sees empty analytics and an explanatory empty-state; no management surfaces.

### 3.2 Screens and components

All paths under `ai-server/src/portal/src/`.

- **`pages/LobsPage.jsx`** (new) — superadmin LOB list + create/edit/delete; drill into an
  LOB. States: loading / error / empty / list. Data via `api/lobs.js`.
- **`pages/LobDetailPage.jsx`** (new) — tabs: Members, Heads, App Classifications for one
  LOB. Reuses `DataTable`, `ConfirmDialog`. Member/head pickers use the employee directory
  (`employees/list`) and admin directory (`admin-users`).
- **`pages/AppClassificationsPage.jsx`** (modify) — add a required **LOB selector** at the
  top; CRUD now targets `api/lobAppClassifications.js` (the new per-LOB table) instead of the
  current global Jira-table endpoints. The current global behavior is retired from the UI
  (the Jira table and its endpoints remain in code, untouched — see §11.3).
- **`components/layout/Sidebar.jsx`** (modify) — gate menu items by effective role; add
  **Line of Businesses** (superadmin). Today the sidebar shows every link to everyone
  ([Sidebar.jsx:16-23](../ai-server/src/portal/src/components/layout/Sidebar.jsx#L16-L23)).
- **`components/common/LobFilter.jsx`** (new) — dropdown of LOBs the caller may see
  (superadmin: all; head: their LOBs + "All my LOBs"). Added to Dashboard, Employees,
  TimeLogs, Reports.
- **`contexts/AuthContext.jsx`** (modify) — expose effective capabilities (`isSuperadmin`,
  `headedLobs`) fetched after login so the UI can gate without guessing from `role` alone.
- **`App.jsx`** (modify) — add routes for `/lobs` and `/lobs/:lobId`.

ASCII sketch — LOB detail:

```
┌ Line of Business: "Cloud Practice" ───────────────────────────┐
│ [ Members ] [ Heads ] [ App Classifications ]                  │
│---------------------------------------------------------------│
│ Members (M:N)                          [+ Add employee]        │
│  Name           Email              In other LOBs?   [remove]   │
│  ...                                                           │
└───────────────────────────────────────────────────────────────┘
```

---

## 4. File and function names (physical structure)

> Rules from the template still apply: controllers do request/auth/validation only; services
> hold domain logic (no `req`/`res`); DB modules hold Supabase queries only;
> `'use strict'`; `logger.*` not `console.log`.

### 4.1 AI server (`ai-server/src/`)

```text
ai-server/src/
  controllers/
    portal-lob-controller.js                  # NEW — LOB CRUD + members + heads
    portal-app-catalog-controller.js          # NEW — shared app catalog CRUD + bulk import (superadmin)
    portal-lob-app-classifications-controller.js  # NEW — per-LOB classification of catalog apps (superadmin + head)
    portal-controller.js                      # MODIFY — resolve scope, pass to service, enforce membership on :userId
    portal-reports-controller.js              # MODIFY — apply scope to all report types
  services/
    portal-lob-service.js                     # NEW — LOB domain logic + scope resolution
    portal-service.js                         # MODIFY — accept scope (visibleUserIds) and filter
    db/
      portal-lob-db-service.js                # NEW — queries for new portal_* tables
  middleware/
    portal-auth.js                            # MODIFY (small) — optional helper to attach req.portalScope
tests/
  controllers/
    portal-lob-controller.test.js             # NEW
    portal-lob-app-classifications-controller.test.js  # NEW
    portal-controller.test.js                 # MODIFY/ADD — scope enforcement cases
    portal-reports-controller.test.js         # MODIFY/ADD
  services/
    portal-lob-service.test.js                # NEW
    portal-service.test.js                    # MODIFY/ADD — filtered aggregation
    db/
      portal-lob-db-service.test.js           # NEW
```

Key functions (descriptions only):

- `services/portal-lob-service.js`
  - `resolveScope(portalUser)` → `{ isSuperadmin, visibleLobIds, visibleUserIds|null }`.
    `visibleUserIds = null` means "no restriction" (superadmin). For a head it is the
    **de-duplicated union** of employees across all LOBs they head. Computed per request
    from the DB (not from the JWT) so revocations take effect immediately.
  - `assertCanManageLob(portalUser, lobId)` — superadmin always; head only if they head
    `lobId`.
  - `createLob / updateLob / deleteLob` — superadmin only.
  - `addMembers / removeMember / listMembers` — superadmin only (members), head may list.
  - `addHead / removeHead / listHeads` — superadmin only.
- `services/db/portal-lob-db-service.js`
  - Query helpers for `portal_lobs`, `portal_lob_employees`, `portal_lob_heads`,
    `portal_lob_app_classifications` (list/create/update/delete; `getHeadedLobIds(adminId)`;
    `getVisibleUserIds(adminId)`).
- `services/portal-service.js` (modify) — each of `getDashboardData`, `getEmployees`,
  `getEmployeesList`, `getEmployeeDetail`, `getTimeLogs` gains a `scope` argument; when
  `scope.visibleUserIds` is a list, queries add `.in('user_id', visibleUserIds)` (activity)
  and `.in('id', visibleUserIds)` (users); when `null`, behavior is unchanged (superadmin).
- `services/portal-productivity-service.js` (NEW, Phase 2) — given a set of activity rows and
  a target LOB, resolves each row's effective label via **per-LOB rule → catalog
  `default_classification` → `neutral`** (see §6.1), then computes productive/non-productive/
  neutral totals and productivity %. Pure function over already-fetched rows + a per-LOB
  classification map; no `req`/`res`, no extra Jira reads. Gated behind the Phase-2 flag.
- `controllers/portal-controller.js` (modify) — call `resolveScope` first; for
  `getEmployeeDetail`/`getEmployeeLogs` reject (403) if `:userId ∉ visibleUserIds` for
  non-superadmin. In Phase 2, pass the caller's active LOB to `portal-productivity-service`
  so dashboard/employee/report numbers reflect that LOB's classifications.

### 4.4 Supabase (`supabase/migrations/`)

```text
supabase/migrations/
  YYYYMMDD_add_portal_lobs.sql                       # NEW
  YYYYMMDD_add_portal_lob_employees.sql              # NEW  (M:N employee membership)
  YYYYMMDD_add_portal_lob_heads.sql                  # NEW  (M:N head assignment)
  YYYYMMDD_add_portal_lob_app_classifications.sql    # NEW  (per-LOB app list)
  YYYYMMDD_add_portal_lob_scope_function.sql         # NEW (OPTIONAL) — RPC for scalable scoped aggregation
```

Each migration: comment block stating purpose; `IF NOT EXISTS` guards; enables RLS with a
`service_role`-full-access policy (+ documented note that portal enforcement is app-layer).
**No migration alters any Jira/AI table.**

---

## 5. API contracts

All endpoints are mounted under `/api/portal/` after
[`portalAuthMiddleware.verifyPortalToken`](../ai-server/src/index.js#L688) and return the
existing envelope `{ success, data?, error? }`. Authorization (role/scope) is enforced inside
the controller/service.

### 5.2 AI server HTTP endpoints

**LOB management (superadmin, except where noted):**

| Method & path | Auth/role | Request | Response |
|---|---|---|---|
| `GET /api/portal/lobs` | any portal user | `?includeInactive` | superadmin: all LOBs; head: only LOBs they head |
| `POST /api/portal/lobs` | superadmin | `{ name, description? }` | created LOB |
| `PUT /api/portal/lobs/:lobId` | superadmin | `{ name?, description?, isActive? }` | updated LOB |
| `DELETE /api/portal/lobs/:lobId` | superadmin | — | `{ success }` (cascade members/heads/app-list) |
| `GET /api/portal/lobs/:lobId/members` | superadmin or head of lob | `?page&limit&search` | employees in LOB |
| `POST /api/portal/lobs/:lobId/members` | superadmin | `{ userIds: [] }` | added rows |
| `DELETE /api/portal/lobs/:lobId/members/:userId` | superadmin | — | `{ success }` |
| `GET /api/portal/lobs/:lobId/heads` | superadmin | — | heads of LOB |
| `POST /api/portal/lobs/:lobId/heads` | superadmin | `{ adminIds: [] }` | added rows |
| `DELETE /api/portal/lobs/:lobId/heads/:adminId` | superadmin | — | `{ success }` |

**App catalog (superadmin manages the shared app list; any authenticated user may read it to
populate pickers):**

| Method & path | Role | Request | Notes |
|---|---|---|---|
| `GET /api/portal/app-catalog` | any | `?search&match_by&page&limit` | the shared app list |
| `POST /api/portal/app-catalog` | superadmin | `{ identifier, displayName, matchBy }` | add an app; `matchBy ∈ {process,url}` |
| `PUT /api/portal/app-catalog/:id` | superadmin | `{ displayName?, isActive? }` | identifier/matchBy immutable |
| `DELETE /api/portal/app-catalog/:id` | superadmin | — | removes the app (cascades its per-LOB classifications) |
| `POST /api/portal/app-catalog/bulk-import` | superadmin | `{ data: [...] }` | per-row success/failure summary |

**Per-LOB classification (superadmin OR head of that LOB):**

| Method & path | Request | Notes |
|---|---|---|
| `GET /api/portal/lobs/:lobId/app-classifications` | `?classification&search&page&limit` | catalog apps + this LOB's classification for each |
| `PUT /api/portal/lobs/:lobId/app-classifications` | `{ appId, classification }` | set/override this LOB's classification for one app (upsert) |
| `DELETE /api/portal/lobs/:lobId/app-classifications/:appId` | — | clear this LOB's classification for an app |
| `POST /api/portal/lobs/:lobId/app-classifications/bulk` | `{ items: [{ appId, classification }] }` | bulk set; per-row result |

**Modified analytics endpoints (LOB scope applied):** all of
`GET /api/portal/dashboard`, `/employees`, `/employees/list`, `/employees/:userId`,
`/employees/:userId/logs`, `/time-logs`, `/reports/data`, `/reports/export/csv`,
`/reports/export/pdf` gain:
- backend scope filtering by `visibleUserIds` (superadmin = unrestricted);
- an **optional `lobId` query param** to narrow to one LOB (must be one the caller may see);
- `403` for non-superadmin requesting a `:userId` or `lobId` outside their scope.

Error shape unchanged: `{ success: false, error: "..." }` with `401` (unauthenticated),
`403` (out of scope / insufficient role), `400` (validation), `404` (not found), `500`.

---

## 6. Database structure

> All new tables are **portal-owned**, `public` schema, snake_case, `portal_`-prefixed.
> No Jira/AI table is created, altered, or referenced for write. `users.id` is referenced by
> **value only (soft reference)** — see design note — to keep the portal fully decoupled
> from the Jira-owned `users` table.

### 6.1 New tables

**`portal_lobs`** — LOB definitions.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | default gen_random_uuid() |
| `name` | varchar(255) NOT NULL | |
| `description` | text NULL | |
| `is_active` | boolean NOT NULL default true | soft-delete / deactivate |
| `created_by` | uuid NULL | references `portal_admin_users(id)` |
| `created_at` / `updated_at` | timestamptz | |
| Constraint | UNIQUE (`name`) | LOB name unique within the single logical org |
| Index | (`is_active`) | |

> **No `org_id` (Q5/Q6):** LOBs are company-wide in this single-tenant portal and are not tied
> to a Jira `organizations` row.

**`portal_lob_employees`** — M:N LOB ↔ tracked employee.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `lob_id` | uuid NOT NULL | references `portal_lobs(id)` ON DELETE CASCADE |
| `user_id` | uuid NOT NULL | **soft reference** to `users.id` (no FK — see design note) |
| `added_by` | uuid NULL | `portal_admin_users(id)` |
| `created_at` | timestamptz | |
| Constraint | UNIQUE (`lob_id`, `user_id`) | one membership row per LOB |
| Index | (`lob_id`), (`user_id`) | `user_id` index drives reverse lookups |

**`portal_lob_heads`** — M:N LOB ↔ portal admin (head).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `lob_id` | uuid NOT NULL | references `portal_lobs(id)` ON DELETE CASCADE |
| `admin_id` | uuid NOT NULL | references `portal_admin_users(id)` ON DELETE CASCADE |
| `role` | text NOT NULL default `'head'` | per-assignment role; `head` today. Reserved so a `viewer` tier (Q3) can be added additively without schema change |
| `assigned_by` | uuid NULL | `portal_admin_users(id)` |
| `created_at` | timestamptz | |
| Constraint | UNIQUE (`lob_id`, `admin_id`) | |
| Index | (`admin_id`), (`lob_id`) | `admin_id` index drives scope resolution |

**`portal_app_catalog`** — the master list of applications we ship (seeded) and that
**superadmins** add to / delete from. Shared across all LOBs.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `identifier` | text NOT NULL | the match key — process name for desktop apps (`slack.exe`) or site/domain for browser apps (`youtube`) |
| `display_name` | text NOT NULL | e.g. "Slack", "YouTube" |
| `match_by` | text NOT NULL | CHECK in (`process`,`url`). `process` = desktop app matched by exe; `url` = browser/website matched by domain |
| `default_classification` | text NULL | CHECK in (`productive`,`non_productive`,`private`,`neutral`). Org-wide default used when an LOB has no rule for this app (Q1 precedence). NULL ⇒ falls through to `neutral` |
| `is_seed` | boolean default false | true for the product-provided defaults |
| `is_active` | boolean default true | soft-delete |
| `created_by` | uuid NULL | `portal_admin_users(id)` |
| `created_at` / `updated_at` | timestamptz | |
| Constraint | UNIQUE (`identifier`, `match_by`) | one catalog entry per app |
| Index | (`match_by`), (`is_active`) | |

**`portal_lob_app_classifications`** — how each LOB classifies a catalog app. The **same app
can be classified differently by different LOBs**.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid PK | |
| `lob_id` | uuid NOT NULL | references `portal_lobs(id)` ON DELETE CASCADE |
| `app_id` | uuid NOT NULL | references `portal_app_catalog(id)` ON DELETE CASCADE |
| `classification` | text NOT NULL | CHECK in (`productive`,`non_productive`,`private`,`neutral`). `neutral` lets an LOB explicitly exclude an app from its productivity ratio |
| `created_by` | uuid NULL | `portal_admin_users(id)` |
| `created_at` / `updated_at` | timestamptz | |
| Constraint | UNIQUE (`lob_id`, `app_id`) | one classification per app per LOB |
| Index | (`lob_id`), (`app_id`) | |

**Who manages what (refines Q4):**
- **App catalog (which apps exist):** **superadmin only** — add / delete / rename apps, and
  set each app's optional org-wide `default_classification`.
- **Per-LOB classification (productive / non_productive / private / neutral per app):**
  **superadmin (any LOB) + the LOB head (their own LOBs only).**

**Classification resolution at read time (Q1 — approved):** when the portal computes an LOB's
productivity, each activity's effective label is resolved in this order:
1. the **LOB's own rule** for the matched app (`portal_lob_app_classifications`), else
2. the app's **org-wide `default_classification`** (`portal_app_catalog`), else
3. **`neutral`** (also used when the activity can't be matched to any catalog app — e.g. an
   un-extractable browser tab).
Productivity % = productive ÷ (productive + non_productive); **`neutral` and `private` are
excluded from that ratio** (time is still totaled). Matching is on the normalized
`application_name` and the title-derived domain (see §11.1 caveat). This is computed **in the
portal at query time** — it never writes back to `activity_records` or the AI pipeline.

**Design note — soft reference to `users.id`:** to honor "do not touch the Jira tables," LOB
membership stores `user_id` as a UUID value and validates it against `users` **in
application code at write time**, rather than adding a DB foreign key from a portal table to
the Jira-owned `users` table. This keeps the portal schema fully decoupled (no cross-feature
cascade/lock coupling) and means deleting a `users` row never blocks on portal data. The
read joins tolerate orphaned rows. **DECISION (Q4, 2026-06-02): use the soft reference (no
FK), plus write-time validation against `users` and tolerant reads.** A real FK was rejected
because it would couple the portal to the Jira-owned `users` table — a Jira-side user delete
could then cascade into, or be blocked by, portal rows, i.e. it could *disturb the main Jira
application*, which is explicitly disallowed. The same principle removes any FK to
`organizations` from the LOB tables (Q5/Q6).

**RLS note:** each new table gets `ENABLE ROW LEVEL SECURITY` + a `service_role` full-access
policy for defense-in-depth (LOB tables carry no `org_id`). Because the portal uses
the service-role key, **RLS is not the authoritative control for portal traffic** — ai-server
application code is. This is documented in each migration's comment block.

### 6.2 Changes to existing tables

**None.** No Jira/AI table (`users`, `activity_records`, `application_classifications`,
`organizations`) is altered. `portal_admin_users` is **not** altered either — the
`superadmin|admin|viewer` CHECK stays, and "LOB head" is derived from `portal_lob_heads`.

### 6.3 New or modified views

Optional: a SQL helper **function** (not a view) `portal_lob_scoped_activity(admin_id, from,
to)` (in `YYYYMMDD_add_portal_lob_scope_function.sql`) that joins `activity_records` to
`portal_lob_employees` for the admin's headed LOBs and returns aggregates. This is the
scalable alternative to passing large `IN (...)` lists from Node (§11.1). It only **reads**
`activity_records`.

---

## 7. Migration files

### 7.1 Migration files

- `YYYYMMDD_add_portal_lobs.sql` — creates `portal_lobs` (+ RLS, indexes). Stands alone — no
  FK into any Jira-owned table.
- `YYYYMMDD_add_portal_lob_employees.sql` — creates `portal_lob_employees`. Depends on
  `portal_lobs`.
- `YYYYMMDD_add_portal_lob_heads.sql` — creates `portal_lob_heads`. Depends on `portal_lobs`
  and existing `portal_admin_users`.
- `YYYYMMDD_add_portal_app_catalog.sql` — creates `portal_app_catalog` (shared app list).
  Stands alone.
- `YYYYMMDD_seed_portal_app_catalog.sql` — seeds the product-provided default apps
  (`is_seed = true`). Depends on `portal_app_catalog`.
- `YYYYMMDD_add_portal_lob_app_classifications.sql` — creates
  `portal_lob_app_classifications`. Depends on `portal_lobs` and `portal_app_catalog`.
- `YYYYMMDD_add_portal_lob_scope_function.sql` (optional) — read-only aggregation function.

Rules honored: comment block per file; `IF NOT EXISTS` guards; never edit an existing
migration; additive only.

### 7.2 Data migrations and seed data

- **Seed the app catalog.** A starter migration seeds `portal_app_catalog` with the
  product-provided default apps (each marked `is_seed = true`) — a mix of desktop apps
  (`match_by = process`, e.g. `slack.exe`, `code.exe`) and common browser apps
  (`match_by = url`, e.g. `youtube`, `github`, `chatgpt`). Superadmins extend/trim this list at
  runtime. No per-LOB classifications are seeded — each LOB classifies apps itself.
- **No automatic backfill of employees into LOBs.** Until a superadmin assigns them, no LOB
  head sees any employee; the superadmin still sees everyone (unchanged behavior).
- **Existing portal users:** superadmins keep global access. Existing `admin`/`viewer` users
  become **LOB-scoped** and see nothing until assigned as heads — a deliberate, documented
  behavior change (§11.1). Onboarding step: superadmin creates LOBs and assigns heads.
- **Optional continuity seed:** create one default LOB (e.g., "Unassigned") and bulk-insert
  all current `users` as its members, so existing dashboards are not empty during rollout.
  This is an operational choice for the superadmin, not an automatic migration.

---

## 8. Background jobs and Edge Functions

No background jobs or Edge Functions for this feature.

---

## 9. Test plan

### 9.1 Unit tests (ai-server, Jest; mock `supabase-client.js`)

- `portal-lob-service.test.js`
  - `resolveScope`: superadmin → `visibleUserIds=null`; head of 2 LOBs → de-duplicated union;
    head with overlapping employees counted once; non-superadmin with no LOB → empty set;
    scope read from DB (revocation reflected without new JWT).
  - `assertCanManageLob`: superadmin any LOB; head only their LOB; head of LOB A denied for
    LOB B.
- `portal-lob-db-service.test.js` — CRUD + uniqueness violations (duplicate member, duplicate
  head, duplicate app identifier) surfaced as 409; cascade on LOB delete.
- `portal-service.test.js` — aggregation with `visibleUserIds` filter vs unrestricted;
  employee in multiple LOBs counted once in dashboard `employeeCount`.
- `portal-controller.test.js` — `getEmployeeDetail`/`getEmployeeLogs` return 403 when
  `:userId` outside scope; superadmin unaffected.
- `portal-lob-controller.test.js` / `portal-app-catalog-controller.test.js` /
  `portal-lob-app-classifications-controller.test.js` (supertest) — role gates: non-superadmin
  blocked from LOB create/member/head ops and from catalog add/delete; head allowed to classify
  apps for their own LOB, blocked for others; validation (classification/match_by enums).
- `portal-productivity-service.test.js` (NEW, Phase 2) — resolution precedence: per-LOB rule
  wins over catalog default wins over `neutral`; `neutral`/`private` excluded from the
  productive ÷ (productive+non_productive) ratio; **same app classified differently in two LOBs
  yields different productivity %**; unmatched activity → `neutral` (not mislabeled).

### 9.2 Integration tests

- ai-server + Supabase (test instance): create LOB → add member + head → head logs in →
  dashboard/employees/time-logs return only that LOB's employees; superadmin sees all; remove
  head → head immediately loses access on next request.

### 9.3 End-to-end (vertical slice)

- Superadmin creates "Cloud Practice", adds 3 employees + 1 head → head signs in (Google SSO)
  → sees exactly those 3 across Dashboard/Employees/TimeLogs/Reports → manages the LOB's app
  list → cannot see a second LOB's employees or app list. Verified manually + (optional)
  Playwright against the deployed portal.

---

## 10. Interaction diagrams

Layer reference for the portal path:
```
Portal React page (ai-server/src/portal/src/pages/*)
  → api/*.js (axios, Bearer JWT)
    → ai-server route (index.js) → verifyPortalToken
      → controller (portal-*-controller.js)  [resolves scope, enforces role]
        → service (portal-lob-service.js / portal-service.js)
          → db service (portal-lob-db-service.js) → Supabase (service-role)
```

**10.1 Happy path — LOB head loads Dashboard (scoped)**

1. Head opens Dashboard; `api/dashboard.js` → `GET /api/portal/dashboard?from&to`.
2. `verifyPortalToken` attaches `req.portalUser` (role=`admin`).
3. `portal-controller.getDashboard` calls `portalLobService.resolveScope(portalUser)`.
4. `resolveScope` → `portal-lob-db-service.getHeadedLobIds(adminId)` → `getVisibleUserIds(...)`
   returns the de-duplicated employee set (not null).
5. `getDashboard` calls `portalService.getDashboardData(orgId, from, to, scope)`.
6. `portal-service` adds `.in('user_id', visibleUserIds)` to the `activity_records` query.
7. Supabase returns only those employees' rows; aggregates computed; `{ success, data }`.
8. Page renders KPIs/charts for the head's LOB(s) only.

**10.2 Happy path — superadmin manages a LOB's app list**

1. Superadmin opens LOB detail → App Classifications tab → `POST
   /api/portal/lobs/:lobId/app-classifications`.
2. Controller: role=`superadmin` → `assertCanManageLob` passes.
3. `portal-lob-service.createAppClassification` → `portal-lob-db-service` insert into
   `portal_lob_app_classifications` (unique on lob_id+identifier+match_by).
4. `201 { success, data }`; table refreshes. (No Jira table touched.)

**10.3 Failure path — head requests an employee outside scope**

1. Head opens `/employees/<userId-from-another-LOB>` →
   `GET /api/portal/employees/:userId`.
2. Controller resolves scope; `:userId ∉ visibleUserIds`.
3. Controller returns `403 { success:false, error:'Insufficient permissions' }`. No DB read of
   that employee's activity occurs.
4. Page shows the error/empty state.

**10.4 Failure path — non-superadmin attempts LOB create**

1. `POST /api/portal/lobs` by role=`admin`.
2. Controller role check fails → `403`. No write. (Frontend also hides the action.)

---

## 11. Risks, edge cases, and open questions

### 11.1 Risks

- **Behavior change for existing portal users:** non-superadmin users currently see *all*
  data; after rollout they see *nothing* until assigned as LOB heads. Must be communicated;
  the optional "Unassigned" continuity LOB (§7.2) mitigates blank dashboards.
- **Large `IN (...)` lists:** a head over many LOBs can resolve to thousands of `user_id`s.
  PostgREST `.in()` builds a query string — risk of URL length / planner cost. Mitigation:
  use the optional `portal_lob_scope_function` RPC (server-side join) for the scaled path;
  the `IN()` approach is acceptable for MVP/small orgs.
- **Authorization is app-layer only** (service-role bypasses RLS). Every new and modified
  endpoint must be covered by the role/scope tests in §9; a missing check is a data-leak bug.
- **Scope freshness:** scope is resolved per request from the DB (not the JWT), so head
  removal takes effect immediately — but the 24h JWT still authenticates the session; ensure
  no scope is cached in the token.

### 11.2 Edge cases

- Employee in **multiple** LOBs that a head leads → counted **once** (use distinct union;
  dashboard already de-dupes `user_id` via a Set — preserve that).
- Head of **multiple** LOBs → union across all; one shared employee appears once.
- `portal_lobs` delete → cascade removes membership/head/app-list rows; **never** touches
  `users`/`activity_records`.
- Employee deleted on the Jira side (`users` row gone) → orphaned `portal_lob_employees`
  row (soft ref); reads must tolerate missing user (skip/label "Unknown"), and a cleanup
  job/manual prune is a later nicety.
- Non-superadmin with zero LOBs → empty (not error) analytics; explanatory empty state.
- Duplicate assignment (same employee/head/app identifier) → 409, idempotent UX.
- `lobId` query param that the caller can't see → 403 (not silently ignored).

### 11.3 Open questions

1. **DECIDED (Q1, approved 2026-06-02) — per-LOB classifications ARE consumed by portal
   analytics.** Productivity is re-derived at read time with precedence **per-LOB rule →
   catalog `default_classification` → `neutral`** (§6.1, §4.1, §0 #10). This is the
   industry-standard model (ActivTrak / Time Doctor / Insightful). It stays portal-side and
   never re-classifies `activity_records` or touches the AI pipeline / Jira tables.
   **Data caveat (drives the phased rollout):** `activity_records` has **no URL column**;
   browser activity is identified by a **domain heuristically parsed from the window title** by
   the desktop app (`_extract_domain_from_title`, e.g. "… - YouTube" → `youtube`) plus the
   normalized `application_name`. So per-LOB *desktop-app* matching is reliable, but *website*
   matching is best-effort — anything unmatched falls to `neutral` rather than being
   mislabeled. **Phase 2 must validate this matching on real data before enabling consumption**
   (§12). Capturing the real browser URL in the agent is a possible future accuracy
   improvement (out of scope here).
2. **DECIDED (2026-06-02) — keep for now.** The existing global app-classifications portal
   page + its `/api/portal/app-classifications` endpoints (which read/write the Jira
   `application_classifications` table) are **left in place and untouched**; the new per-LOB
   app feature is added **alongside** it. Hide/remove later per manager's call. *(This
   supersedes the earlier "replace the portal page" recommendation: for now the new per-LOB
   app page is added as a separate surface; the global page stays.)*
3. **OPEN — Read-only "LOB viewer" tier** in addition to head — now or later? Currently
   superadmin + head only. The `portal_lob_heads.role` column (default `head`) is reserved so
   a `viewer` value can be added later **without a schema change**.
4. **DECIDED (2026-06-02) — soft reference, no FK** for `portal_lob_employees.user_id` (and no
   FK to `organizations` on any LOB table). Chosen specifically so the feature cannot disturb
   the Jira-owned `users`/`organizations` tables. See §6.1 design note.
5. **DECIDED (2026-06-02) — single logical org.** The company's several Jira organizations are
   treated as one logical org; the portal stays single-tenant and reads across all of them;
   LOB tables are **not** scoped to a Jira org (see §2.1, §6.1).

---

## 12. Rollout and feature flagging

Two flags, so segmentation and number-recalculation can be turned on independently:
- `PORTAL_LOB_ENFORCEMENT` — turns on LOB scoping (who sees whom).
- `PORTAL_LOB_PRODUCTIVITY` — turns on Q1 consumption (per-LOB classifications re-deriving the
  productivity numbers). Kept separate so config can ship and be validated before the numbers
  change.

### Phase 1 — Segmentation + app-classification config (no number changes)

What ships: LOB tables, app catalog (+ seed) and per-LOB classification, all CRUD/UI, LOB
scoping of analytics. Productivity is still computed the way it is today (from
`activity_records.classification`). `PORTAL_LOB_PRODUCTIVITY=off`.

Deploy order:
1. Supabase: apply the new portal migrations (incl. catalog seed).
2. ai-server: deploy with `PORTAL_LOB_ENFORCEMENT=off`, `PORTAL_LOB_PRODUCTIVITY=off`.
3. Superadmin seeds LOBs, members, heads (and optional "Unassigned" LOB), and reviews the
   app catalog + org defaults; heads set their per-LOB classifications.
4. Portal frontend (Vercel) deploy with the new pages/filters.
5. Flip `PORTAL_LOB_ENFORCEMENT=on` (scoping live; numbers unchanged).

### Phase 2 — Consumption (per-LOB classifications drive the numbers)

1. **Validate matching** on real `activity_records`: how reliably can `application_name` +
   title-derived domain be matched to catalog apps (esp. browser/`url`)? Confirm unmatched
   activity lands in `neutral` and the productivity % is sensible per LOB.
2. Deploy `portal-productivity-service.js` and wire it into dashboard/employee/report numbers.
3. Flip `PORTAL_LOB_PRODUCTIVITY=on`. Dashboards now re-derive productivity per the LOB's
   classifications (precedence per-LOB rule → catalog default → neutral).

- **Additive-only:** new tables, new routes, new pages, new query params, new columns only. No
  existing route/column renamed or removed.
- **Rollback:** set either flag back to `off` (instant, no schema change) — `PORTAL_LOB_
  PRODUCTIVITY=off` reverts to today's classification math while keeping scoping; both off
  reverts to pre-LOB behavior. If needed, add a reversal migration to drop the new portal
  tables (never edit existing migrations). Jira/AI tables are unaffected throughout.

---

## 13. Notification events

No notification events for this feature.

> Optional future nicety (explicitly out of scope here): emailing a portal admin when they
> are assigned as an LOB head, reusing the existing
> [adminInvite template](../ai-server/src/services/notifications/templates) pattern. Not part
> of this plan.
