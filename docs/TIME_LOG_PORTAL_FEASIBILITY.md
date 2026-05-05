# Feasibility Report: Internal Time Log Portal

**Date:** 2026-05-05  
**Requested by:** Amzur internal ops  
**Analysed by:** GitHub Copilot (codebase + schema review)

## Scope

A brand-new standalone web app for Amzur ops staff. Flow: pick an organisation → pick a user within that org → view their `activity_records` split by productive / non-productive, filtered by time period (today / this week / this month / this year). New internal auth mechanism (separate from the existing Jira admin OAuth and the password-protected `/admin-dashboard`).

---

## What Already Exists

### Data model (fully ready)

| Requirement | Table / Column | Status |
|---|---|---|
| Productive vs non-productive classification | `activity_records.classification` (`productive`, `non_productive`, `private`, `unknown`) | ✅ Exists |
| Time per record | `duration_seconds`, `start_time`, `end_time`, `work_date` | ✅ Exists |
| Filter by date | `work_date DATE` column + composite index `(organization_id, user_id, work_date)` + `(organization_id, project_key, work_date)` | ✅ Exists |
| User display info | `users.display_name`, `users.email`, `users.organization_id` | ✅ Exists |
| Org listing | `organizations.org_name`, `organizations.id` | ✅ Exists |
| App name per record | `activity_records.application_name`, `window_title` | ✅ Exists |
| Jira task assigned | `activity_records.user_assigned_issue_key`, `project_key` | ✅ Exists |
| AI confidence + reasoning | `activity_records.metadata` JSONB (`confidenceScore`, `reasoning`, `workType`) | ✅ Exists |

### Summary views (partially useful)

Three materialised views exist — `daily_time_summary`, `weekly_time_summary`, `monthly_time_summary`. They already `UNION ALL` legacy screenshot data with `activity_records`. **However**, they only emit `work_type = 'office'` — there is no equivalent view for `non_productive` or `private` time. The portal's breakdown requirement would need to query `activity_records` directly rather than through these views.

### Existing user-list API

The existing `/admin-dashboard/api/stats` endpoint already returns every org with every user nested inside it (uses `service_role` key, bypasses RLS). The data shape — `org_name`, `user.id`, `user.email`, `user.display_name`, `user.desktop_last_heartbeat` — is exactly what the user-picker needs. **However**, this endpoint is protected by the in-memory session/password system, not a proper auth mechanism for a new standalone app.

### Service layer

`activity-db-service.js` and the Supabase client are already wired up. Adding a new DB query function (fetch records by `user_id + date_range + classification`) is a handful of lines reusing existing patterns.

---

## What Does Not Exist

| Gap | Effort |
|---|---|
| **New standalone web app** (UI) | Medium — no frontend exists for this. A React SPA or server-rendered page needs to be built from scratch. |
| **Auth for Amzur internal staff** | Medium — nothing exists for non-Atlassian, non-Jira-admin internal users. Options: Google Workspace OAuth (best for a company), or a hardened shared-secret approach like the current dashboard but with per-user credentials. |
| **API endpoint: org → user list** | Small — the data exists; a new authenticated route wrapping the existing `organizations + users` query is needed. |
| **API endpoint: user time logs with classification + date filter** | Small — needs a new DB service function (`getActivityRecordsByUser(userId, orgId, from, to, classification[])`) and a controller route. The query pattern mirrors what the polling service already does. |
| **Productive/non-productive breakdown query** | Small — `WHERE classification IN ('productive', 'non_productive') AND work_date BETWEEN ? AND ?` grouped by `classification` and `work_date`. Straightforward. |
| **`private` records handling** | Decision needed — `private` records (banking, health apps) exist in the table. The portal should either hide them entirely or require explicit elevated access. There is no access tier for this today. |
| **Time period presets** (today / this week / this month / this year) | Small — server-side date math. The `work_date` column supports this directly. |

---

## Security Issues

### Critical: RLS provides zero protection for this portal

The AI server — and any new backend built alongside it — uses `SUPABASE_SERVICE_ROLE_KEY`. This key has `bypassrls = true` in PostgreSQL, meaning it skips **every** RLS policy on every table. All the policies on `activity_records`, `users`, `organizations` etc. are only enforced when a request arrives with a user-scoped JWT (i.e. from the desktop app or Forge). Backend code is entirely outside RLS.

**Implication**: The portal backend must enforce org-scoping manually in every query. Any query that fetches `activity_records` without an explicit `WHERE organization_id = :orgId AND user_id = :userId` would silently return data from every org in the database. There is no RLS safety net to catch a missing filter.

**Specific patterns to lock down in new API code:**
- Always bind `organization_id` when querying `activity_records`, even if you already have `user_id`. The `user_id` alone is not sufficient — two orgs can theoretically share a user ID if data was ever migrated or corrupted.
- When listing users for an org, do `WHERE organization_id = :orgId` on the `users` table. Do **not** accept a `user_id` from the client and look it up without verifying it belongs to the requested org first (IDOR risk).

### High: No multi-org isolation in the existing admin stats endpoint

`/admin-dashboard/api/stats` returns **all organisations** and **all users** in a single call. If the portal reuses this endpoint as-is without scoping, an internal user who should only see one org would see all of them. A new org-scoped variant or role-based filter is required.

### High: Admin dashboard tables have `USING (true)` RLS policies

The four tables created in `20260330_create_admin_dashboard_tables.sql` (`dashboard_header_metrics`, `dashboard_organizations`, etc.) all have `CREATE POLICY "Service role full access" ... USING (true)`. This is a Supabase Security Advisor warning (`rls_policy_always_true`) — it means any authenticated user who hits Supabase PostgREST directly (not via the AI server) can read all rows across all orgs. Not immediately dangerous since there is no direct PostgREST exposure today, but it is a latent issue.

### Medium: In-memory session store for existing admin dashboard

The existing `/admin-dashboard` session tokens are stored in a `Map()` in process memory. A server restart wipes all sessions silently. If the new portal reuses this approach, the same limitation applies. Use a persistent store (Redis, or a `sessions` DB table) for a proper standalone app.

### Medium: `private`-classification records contain sensitive personal data

Records with `classification = 'private'` (banking, healthcare, password managers) exist in `activity_records`. The OCR text and window titles for these are redacted by the desktop app before upload, but `application_name` and `window_title` may still reveal what sensitive app was open. The portal should filter these out entirely unless there is a specific ops reason to see them, and that access should be separately audited.

### Low: No rate limiting on new routes yet

New portal routes must be explicitly enrolled in appropriate rate-limit tiers. Without this, they will either have no limit or share the general bucket with production desktop-app traffic.

---

## Summary Table

| Requirement | Status | Effort |
|---|---|---|
| Data: productive/non-productive split | ✅ `classification` column exists | None |
| Data: time period filtering | ✅ `work_date` + indexes exist | None |
| Data: user and org listing | ✅ Tables + existing admin query exist | None |
| API: org → user list endpoint | ❌ Not exposed | Small |
| API: user time logs with filters | ❌ Not exposed | Small |
| Frontend: user picker + time log view | ❌ Not built | Medium |
| Auth: Amzur internal staff | ❌ Not built | Medium |
| RLS enforcement in new API code | ⚠️ Manual — no RLS backstop | Discipline required |
| `private` record access policy | ⚠️ Decision + enforcement needed | Small |
| In-memory session store limitation | ⚠️ Current pattern is ephemeral | Small if persistent store added |

**Overall verdict: technically straightforward.** The data model is complete and indexes are already in place. The heaviest work is the frontend and the auth mechanism. There is no RLS safety net for server-side code, so query authoring must be treated as a security-critical task — every query touching `activity_records` or `users` must be explicitly scoped to `organization_id`.
