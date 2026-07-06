# Google login creates duplicate users for existing Atlassian-provisioned accounts

**Date:** 2026-07-03
**Component:** ai-server (`user-db-service.findOrCreateGoogleUser`) + data-repair SQL

## Problem

Two employees (`iswarya.kolimalla@amzur.com`, `vishnu.kanthamraju@amzur.com`) each
have TWO active `users` rows in the same org in prod. Their tracking history is
split across two identities: the Employees page lists them twice, the detail
page/reports show only the clicked identity's share, and (vishnu) current desktop
uploads go to the duplicate while the original looks inactive since Jun 29.

## Root cause (verified in prod `bzdoztgfozxkhkvctvdk`, 2026-07-03)

`findOrCreateGoogleUser` (user-db-service.js:366) looks up ONLY
`auth_provider='google' AND google_sub=<sub>`. A user originally provisioned by
the **Atlassian** flow (`auth_provider='atlassian'`, `google_sub` NULL) who later
signs into the desktop app with **Google** matches nothing → a brand-new row is
inserted with the same email (`atlassian_account_id` NULL, `auth_provider='google'`).
Both prod duplicates fit exactly (created 2026-06-24 / 2026-07-01, on desktop
1.4.9→1.4.10 re-login). `users` has a unique index on `google_sub` (partial,
provider='google') and on `atlassian_account_id`, but **nothing guards email-per-org**.

Constraint discovered during design: `auth_provider='google'` semantically means
"non-Jira user" — it disables nightly Jira clustering
(clustering-polling-service.js:101) and switches AI describe-summary length
(activity-service.js:606). Therefore the fix must NOT flip an Atlassian user's
provider; it links the Google identity onto the existing row instead.

## Fix

### A. Code (this change)

In `findOrCreateGoogleUser`:
1. Look up by `google_sub` alone (drop the `auth_provider='google'` filter), so a
   linked Atlassian row is found on subsequent Google logins. Same change in the
   23505 concurrent-insert refetch.
2. On google_sub miss, **link by email**: exactly one ACTIVE `users` row in the
   resolved org with that email (case-insensitive, ilike-escaped, `is_active =
   true` — a deactivated ex-employee is never silently resurrected) → set `google_sub` on it
   (plus the standard `supabase_user_id`/profile freshness updates) and return it.
   `auth_provider` is left untouched (Jira semantics preserved).
3. Zero or 2+ email matches → fall through to today's create path unchanged.

### B. Data repair (user runs `scripts/fix_duplicate_google_users.sql`)

Per duplicate pair (canonical = row with `atlassian_account_id`; dup = google row,
same org + email): repoint history rows (activity_records incl. approved_by,
notification_logs, user_location_log, plus every other user-FK history table),
DELETE per-user state rows of the dup (org membership, cooldowns, preferences,
sessions, caches, oauth credentials — canonical keeps/rebuilds its own), copy the
dup's `google_sub` to the canonical, delete the dup user row. Then:
- replace the `google_sub` unique index with one covering ANY provider, and
- add `UNIQUE (organization_id, lower(email)) WHERE is_active` to prevent recurrence.

**Runbook order matters:** deploy the ai-server code fix FIRST, then run the SQL
(prod + dev). Affected users must re-login to the desktop app with Google once
(their JWT references the deleted dup id; queued offline records then sync under
the canonical identity).

## Acceptance criteria

1. **AC1 — link, don't duplicate:** google_sub miss + exactly one same-email user
   in the resolved org → that row is updated with `google_sub` and returned; no
   insert; `auth_provider` not modified.
2. **AC2 — ambiguous email falls through:** 2+ same-email rows → create path runs
   (today's behavior), no throw.
3. **AC3 — provider-agnostic sub lookup:** the google_sub lookup no longer filters
   on `auth_provider`, so a linked Atlassian row is found on the next login.
4. **AC4 — existing behavior preserved:** idempotent-on-sub return, org-mismatch
   403, supabase_user_id backfill, membership ensure — all unchanged (existing
   tests keep passing).

## Out of scope

- Backfilling `desktop_app_version`/heartbeat from dup to canonical (next
  heartbeat overwrites within hours).
- Any UI change; portal pages heal automatically once identities merge.
- The separate timeline revamp (own spec, same date).
