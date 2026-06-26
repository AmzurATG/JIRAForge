# Web Productivity Portal — LOB Roster Import & Install-Status (Adoption Tracking)

- **Date:** 2026-06-26
- **Component:** ai-server (portal) + supabase (one new portal-owned table)
- **Status:** Draft spec — pending sign-off on the open questions in §7
- **Related:** `plan/2026-06-01_web-productivity-portal_lob-segmentation-rbac.md` (LOB tables),
  `20260602_add_portal_lob_segmentation.sql` (existing LOB schema)

---

## 1. Problem

A LOB only ever shows a person **after** they install the desktop app and complete OAuth
login — that login is what first creates their row in the Jira-owned `users` table, and LOB
membership (`portal_lob_employees`) is keyed on `users.id`. Until then a teammate is invisible.

Consequently a superadmin has **no way to see who is *supposed* to be using the app but
hasn't installed it yet** — i.e. no adoption visibility per team.

## 2. Root cause / context

- `portal_lob_employees` maps `lob_id → user_id` (soft ref to `users.id`, **no FK**). A
  `user_id` cannot exist before first login, so the intended roster cannot be pre-loaded.
- `users` (`id, display_name, email`) is **Jira-owned and read-only** for the portal. The
  portal must not create, alter, or write to it.
- The only reliable join between "who we expect" and "who actually installed" is **email**
  (the desktop app authenticates by Atlassian/Google account email). Names are not stable.

## 3. Proposed solution (v1)

Introduce an **email-keyed expected roster** per LOB, imported from Excel/CSV by a superadmin.
Install status is **derived at read time** by matching roster email against `users.email` —
so installing requires **zero writes** and the feature stays fully independent of Jira tables.

### 3.1 Data model — one new portal-owned table

`portal_lob_expected_members` (portal-owned; soft ref to `users` by **email**, no FK):

| column | type | notes |
|---|---|---|
| `id` | UUID PK | `gen_random_uuid()` |
| `lob_id` | UUID NOT NULL | FK → `portal_lobs(id)` ON DELETE CASCADE (portal-owned only) |
| `email` | TEXT NOT NULL | stored **normalized**: `lower(trim(email))` |
| `full_name` | TEXT | display label before they install (optional) |
| `imported_by` | UUID | FK → `portal_admin_users(id)` ON DELETE SET NULL |
| `created_at` | TIMESTAMPTZ NOT NULL | `NOW()` |
| `updated_at` | TIMESTAMPTZ NOT NULL | `NOW()` (re-import refreshes `full_name`) |

- `UNIQUE (lob_id, email)` — idempotent re-import; same person can be on multiple LOBs.
- Indexes on `lob_id` and `email`. RLS enabled, `service_role` policy (defense-in-depth, same
  as sibling LOB tables). No FK to any Jira-owned table.

### 3.2 Reconciliation = derive-on-read (no jobs, no install hooks)

Install status is computed every time the roster is read:

```
installed(email) := EXISTS (users row in this org WHERE lower(users.email) = roster.email)
```

- `Not installed` → roster email has no matching `users` row.
- `Installed` → match found (also surface `userId`).
- `Active` (optional refinement) → matched user has a recent `activity_records` row.

Because status is derived, **nothing is written when a user installs** — they appear as
Installed automatically on the next page load. No login hook, no background sweep, no
deletion of roster rows ("derive, don't delete"). This is the simplest design that satisfies
"independent" + "flips automatically."

### 3.3 Backend (ai-server)

New controller `portal-lob-roster-controller.js`, service `portal-lob-roster-service.js`,
DB helpers added to `portal-lob-db-service.js`. Routes registered in `src/index.js` next to
the existing `/api/portal/lobs/:lobId/members` routes, behind `verifyPortalToken`:

| Method / route | Auth | Purpose |
|---|---|---|
| `POST /api/portal/lobs/:lobId/roster/import` | superadmin (head of LOB allowed if scoped) | Parse uploaded sheet → upsert roster |
| `GET  /api/portal/lobs/:lobId/roster` | superadmin / LOB head | Roster rows + derived install status (paginated) |
| `DELETE /api/portal/lobs/:lobId/roster/:id` | superadmin / LOB head | Remove a roster entry (typo cleanup) |

**Upload mechanism (no new dependency):** the frontend reads the chosen file, base64-encodes
it, and POSTs `{ filename, contentBase64 }` as JSON. The server decodes to a Buffer and parses
with **`exceljs`** (already a dependency; `.csv` handled by `exceljs` CSV reader or a simple
split). This avoids adding `multer`/multipart and keeps parsing + validation server-side
(single source of truth). Rosters are small (hundreds of rows) so base64 overhead is moot.

**Import rules:** expect columns `email` (required) and `name`/`full_name` (optional), header
row case-insensitive. For each row: trim + lowercase email, validate format, skip blanks /
invalid, dedupe within the file, upsert (`onConflict: lob_id,email`, refresh `full_name`).
Return a summary: `{ received, imported, duplicatesSkipped, invalidSkipped }`.

### 3.4 Frontend (portal)

`LobDetailPage.jsx` → `MembersTab`: the members list becomes the **union** of
(a) imported roster entries and (b) existing `portal_lob_employees` members, **deduped by
email**, each rendered with an inline status badge **beside the name**:

```
Members (25)                                   [ Import roster ]  [ + Add ]
NAME                                  EMAIL                 ACTIONS
Vishnu Sai Kanthamraju  ● Installed   vishnu.k@amzur.com      🗑
Priya Sharma            ○ Not installed  priya.s@amzur.com    🗑
```

- Green dot **Installed** / gray dot **Not installed**, derived per §3.2.
- "Import roster" opens an upload modal; on success shows the import summary toast.
- `lobsApi` (`api/lobs.js`) gains `importRoster`, `listRoster`, `removeRosterEntry`.
- Scope minimal ("just the badge"): **no** counts header, status filters, or extra tabs in v1.

## 4. Acceptance criteria

1. Migration creates `portal_lob_expected_members` exactly as §3.1 — portal-owned, no FK to
   `users`, RLS enabled with a `service_role` policy; re-runnable (`IF NOT EXISTS`).
2. `POST …/roster/import` is **superadmin-only** (403 for admin/head-without-scope); parses an
   `.xlsx`/`.csv` payload into rows of `{ email, name }`.
3. Import **normalizes** email (`lower(trim)`), **skips** blank/invalid emails, **dedupes**
   within the file and against existing rows, and **upserts** (re-import refreshes `full_name`).
4. Import responds with `{ received, imported, duplicatesSkipped, invalidSkipped }`.
5. `GET …/roster` returns each entry with a **derived** `installed` boolean (true iff a `users`
   row with that email exists in the caller's org), plus `userId` when installed; paginated.
6. Install status requires **no write on install** — a roster entry flips to Installed purely
   because the email now matches a `users` row (verified by test: insert a matching user → next
   read shows Installed, roster row unchanged).
7. `DELETE …/roster/:id` removes **only** the portal roster row; `users`/`activity_records`
   are untouched.
8. The LOB Members view renders an **inline Installed / Not installed badge beside each name**
   and exposes an **Import roster** action with a summary on success.
9. **No write or schema change** touches `users`, `activity_records`, or any Jira-owned table
   at any point in the feature.
10. Roster import/read for a **LOB head** is restricted to LOBs they head; superadmin sees all
    (reuses `lobService.resolveScope` / existing scope checks).

## 5. Test plan (Jest, ai-server — written red first per workflow)

- `tests/services/portal-lob-roster-service.test.js` — parse/normalize/dedupe/invalid-skip;
  derive-on-read status (mock `users` lookup: matching email → Installed, none → Not installed);
  re-import idempotency + `full_name` refresh.
- `tests/controllers/portal-lob-roster-controller.test.js` — role enforcement (403 paths),
  import summary shape, `GET` pagination + derived status, `DELETE` removes only the roster row,
  unsupported/missing file → 400.
- No Jira-owned table is mocked for writes (asserts §AC9 by construction).

## 6. Out of scope (explicit — candidate Phase 2+)

- **Invite emails** to non-installers (reuse notification system + `admin-invite` template).
- **Auto-linking** an installed roster member into `portal_lob_employees` so they flow into LOB
  productivity analytics (v1 keeps roster = adoption view only; analytics membership stays
  managed via the existing "Add Employee" path).
- **Directory sync** (Atlassian org users / Google Workspace Admin SDK) as a roster source.
- Status **filters / counts / "export not-installed"** and inline roster row editing.

## 7. Open questions / risks

1. **`users.email` completeness — DEFERRED (decision 2026-06-26).** Atlassian accounts with
   email privacy may expose null/placeholder email; those people would stay "Not installed"
   even after installing (false negative). **Decision:** ship v1 on the email match as-is and
   revisit later only if false-negatives actually surface; the fallback (match on Atlassian
   `account_id` as a secondary key) is a future enhancement, not a v1 blocker.
2. **Org scoping of the `users` lookup** — confirm the portal's org context (`req.portalUser`)
   and scope the email match to that org, mirroring `portalService.getEmployees(orgId, …)`.
   *(Implementation detail; resolved during coding.)*
3. **Members tab layout — RESOLVED: Option A (union).** The existing Members tab becomes the
   single dedupe-by-email **union** of roster + `portal_lob_employees`, each row badged
   Installed / Not installed (per §3.4). No separate "Roster" sub-tab.

## 8. Migration draft (apply manually — DB is read-only for the agent)

> Save as `supabase/migrations/20260626_add_portal_lob_expected_members.sql`. **Not applied by
> the agent.** Follows the existing portal-table pattern (no Jira-owned FK, RLS service_role,
> re-runnable).

```sql
-- Portal LOB expected-member roster: email-keyed intended team per LOB, for
-- adoption tracking (installed-vs-not is DERIVED by matching email -> users.email
-- at read time; this table is never written when a user installs). Portal-owned;
-- soft reference to users by email, no FK. Re-runnable.
CREATE TABLE IF NOT EXISTS public.portal_lob_expected_members (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lob_id      UUID NOT NULL REFERENCES public.portal_lobs(id) ON DELETE CASCADE,
    email       TEXT NOT NULL,                 -- stored normalized: lower(trim(email))
    full_name   TEXT,
    imported_by UUID REFERENCES public.portal_admin_users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT portal_lob_expected_members_unique UNIQUE (lob_id, email)
);
CREATE INDEX IF NOT EXISTS idx_portal_lob_expected_members_lob   ON public.portal_lob_expected_members(lob_id);
CREATE INDEX IF NOT EXISTS idx_portal_lob_expected_members_email ON public.portal_lob_expected_members(email);

CREATE OR REPLACE FUNCTION update_portal_lob_expected_members_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_portal_lob_expected_members_updated_at ON public.portal_lob_expected_members;
CREATE TRIGGER trigger_portal_lob_expected_members_updated_at
    BEFORE UPDATE ON public.portal_lob_expected_members
    FOR EACH ROW EXECUTE FUNCTION update_portal_lob_expected_members_updated_at();

ALTER TABLE public.portal_lob_expected_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS portal_lob_expected_members_service_role ON public.portal_lob_expected_members;
CREATE POLICY portal_lob_expected_members_service_role ON public.portal_lob_expected_members
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

COMMENT ON TABLE public.portal_lob_expected_members IS
  'Per-LOB imported expected roster (email-keyed). Install status is derived by matching email against users.email at read time; never written on install. Portal-owned, no FK to Jira users.';
```

## 9. Files to change

- **New:** `supabase/migrations/20260626_add_portal_lob_expected_members.sql` *(manual apply)*
- **New:** `ai-server/src/controllers/portal-lob-roster-controller.js`
- **New:** `ai-server/src/services/portal-lob-roster-service.js`
- **Edit:** `ai-server/src/services/db/portal-lob-db-service.js` (roster CRUD + email→users lookup)
- **Edit:** `ai-server/src/index.js` (register 3 roster routes)
- **Edit:** `ai-server/src/portal/src/api/lobs.js` (`importRoster`, `listRoster`, `removeRosterEntry`)
- **Edit:** `ai-server/src/portal/src/pages/LobDetailPage.jsx` (`MembersTab`: union list + badge + import modal)
- **New tests:** `tests/services/portal-lob-roster-service.test.js`,
  `tests/controllers/portal-lob-roster-controller.test.js`

## 10. Implementation order (per spec-driven workflow)

1. Sign off §7 open questions (esp. `users.email` completeness).
2. You apply the §8 migration; confirm the table exists.
3. Write failing tests (§5) mapped to acceptance criteria.
4. Implement DB helpers → service → controller → routes → frontend until green.
5. Run the full `ai-server` suite + portal build; verify the badge end-to-end.
