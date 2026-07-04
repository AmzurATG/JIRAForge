-- ============================================================================
-- Data repair: merge duplicate Google-login users into their original accounts
-- Date: 2026-07-03
-- Spec: plan/2026-07-03_ai-server_google-login-duplicate-users.md
--
-- WHAT HAPPENED: findOrCreateGoogleUser matched only auth_provider='google' +
-- google_sub, so existing Atlassian-provisioned users who signed in with Google
-- got a SECOND users row (same email, atlassian_account_id NULL). Their tracking
-- history is split across two identities. Verified prod pairs (2026-07-03):
--   iswarya.kolimalla@amzur.com  canonical b6a7058c… (5,440 rows)  dup e4817f18… (436 rows)
--   vishnu.kanthamraju@amzur.com canonical b43bfb14… (6,307 rows)  dup ff9ac7eb… (471 rows, CURRENTLY ACTIVE)
-- Dev has FOUR pairs of the same shape (iswarya, pushpa, raghu, vishnu).
-- The script detects pairs generically, so the same file works on prod AND dev.
--
-- SAFETY AUDIT (2026-07-03, prod + dev): every user_id FK is ON DELETE CASCADE,
-- so the repoint step BEFORE the delete is what protects history — and six
-- tables reference users with NO FK at all (they would orphan, not error):
-- ai_accuracy_events, ocr_test_results, portal_employee_profiles,
-- portal_lob_employees, user_jira_issues_cache_backup_20260521, worklog_sync.
-- All are handled explicitly below. Dev-only unassigned_sync_jobs is handled
-- conditionally.
--
-- WHAT THIS DOES, per detected pair (dup → canonical):
--   1. Repoints history rows (activity_records incl. approved_by, notification
--      logs, location log, screenshots, worklogs, documents, feedback, etc.).
--   2. Deletes the dup's per-user STATE rows (org membership, notification
--      cooldowns/preferences, device sessions, jira issue cache, oauth creds) —
--      the canonical row keeps/rebuilds its own; moving them risks unique clashes.
--   3. Copies the dup's google_sub onto the canonical row (auth_provider is NOT
--      changed — 'google' means "non-Jira user" to clustering/AI and canonicals
--      are real Jira users).
--   4. Deletes the dup users row.
-- Then swaps the google_sub unique index to cover ANY provider, and adds a
-- unique guard on (organization_id, lower(email)) for active users.
--
-- !! RUNBOOK — ORDER MATTERS !!
--   1. Deploy the ai-server fix first (findOrCreateGoogleUser link-by-email +
--      provider-agnostic sub lookup). Running this SQL against an OLD server
--      means the next Google login re-creates the duplicate.
--   2. Paste this WHOLE file into the Supabase Dashboard SQL editor and run it
--      once per environment (prod, then dev). It is DML + tiny index builds on a
--      66-row table — the implicit single transaction is fine here (no
--      CONCURRENTLY). Safe to re-run: with no duplicates left it does nothing.
--   3. Tell affected users (iswarya, vishnu) to sign out of the desktop app and
--      sign back in with Google — their old session references the deleted dup
--      id; queued offline records sync under the merged identity after re-login.
--
-- Canonical = the row with atlassian_account_id (the original). Dup = same org +
-- email, atlassian_account_id NULL, auth_provider='google', google_sub set.
-- Pairs not matching this exact shape are skipped (visible in the final SELECT).
-- ============================================================================

-- The pair map drives every statement below. (Session-scoped temp table — no
-- ON COMMIT DROP, so the file also works statement-by-statement via psql.)
drop table if exists _dup_pairs;
create temp table _dup_pairs as
select c.id as canonical_id,
       d.id as dup_id,
       d.google_sub as dup_google_sub,
       c.email
from public.users c
join public.users d
  on d.organization_id = c.organization_id
 and lower(d.email) = lower(c.email)
 and d.id <> c.id
where c.atlassian_account_id is not null
  and d.atlassian_account_id is null
  and d.auth_provider = 'google'
  and d.google_sub is not null
  -- guard: exactly one canonical candidate for the email+org
  and not exists (
    select 1 from public.users c2
    where c2.organization_id = c.organization_id
      and lower(c2.email) = lower(c.email)
      and c2.id not in (c.id, d.id)
      and c2.atlassian_account_id is not null
  );

-- ---- 1. Repoint history rows --------------------------------------------
update public.activity_records t set user_id = p.canonical_id from _dup_pairs p where t.user_id = p.dup_id;
update public.activity_records t set approved_by = p.canonical_id from _dup_pairs p where t.approved_by = p.dup_id;
update public.activity_log t set user_id = p.canonical_id from _dup_pairs p where t.user_id = p.dup_id;
update public.analysis_results t set user_id = p.canonical_id from _dup_pairs p where t.user_id = p.dup_id;
update public.created_issues_log t set user_id = p.canonical_id from _dup_pairs p where t.user_id = p.dup_id;
update public.documents t set user_id = p.canonical_id from _dup_pairs p where t.user_id = p.dup_id;
update public.feedback t set user_id = p.canonical_id from _dup_pairs p where t.user_id = p.dup_id;
update public.notification_logs t set user_id = p.canonical_id from _dup_pairs p where t.user_id = p.dup_id;
update public.screenshots t set user_id = p.canonical_id from _dup_pairs p where t.user_id = p.dup_id;
update public.unassigned_activity t set user_id = p.canonical_id from _dup_pairs p where t.user_id = p.dup_id;
update public.unassigned_activity t set assigned_by = p.canonical_id from _dup_pairs p where t.assigned_by = p.dup_id;
update public.unassigned_work_groups t set user_id = p.canonical_id from _dup_pairs p where t.user_id = p.dup_id;
update public.unassigned_work_groups t set assigned_by = p.canonical_id from _dup_pairs p where t.assigned_by = p.dup_id;
update public.unassigned_work_groups t set dismissed_by = p.canonical_id from _dup_pairs p where t.dismissed_by = p.dup_id;
update public.user_location_log t set user_id = p.canonical_id from _dup_pairs p where t.user_id = p.dup_id;
update public.worklogs t set user_id = p.canonical_id from _dup_pairs p where t.user_id = p.dup_id;
update public.app_releases t set created_by = p.canonical_id from _dup_pairs p where t.created_by = p.dup_id;
update public.project_settings t set configured_by = p.canonical_id from _dup_pairs p where t.configured_by = p.dup_id;

-- Tables that reference users WITHOUT an FK constraint (audited 2026-07-03 on
-- prod AND dev): they would not block the DELETE below — their rows would
-- silently orphan. Repoint them too.
update public.ai_accuracy_events t set user_id = p.canonical_id from _dup_pairs p where t.user_id = p.dup_id;
update public.ocr_test_results t set user_id = p.canonical_id from _dup_pairs p where t.user_id = p.dup_id;
update public.user_jira_issues_cache_backup_20260521 t set user_id = p.canonical_id from _dup_pairs p where t.user_id = p.dup_id;

-- Guarded moves for no-FK tables with a UNIQUE key on user_id: move the dup's
-- row only when the canonical has no competing row, else drop the dup's.
-- portal_employee_profiles: UNIQUE (user_id) — the admin-assigned branch.
update public.portal_employee_profiles t set user_id = p.canonical_id
from _dup_pairs p
where t.user_id = p.dup_id
  and not exists (select 1 from public.portal_employee_profiles x where x.user_id = p.canonical_id);
delete from public.portal_employee_profiles t using _dup_pairs p where t.user_id = p.dup_id;
-- portal_lob_employees: UNIQUE (lob_id, user_id) — LOB roster membership.
update public.portal_lob_employees t set user_id = p.canonical_id
from _dup_pairs p
where t.user_id = p.dup_id
  and not exists (select 1 from public.portal_lob_employees x
                  where x.lob_id = t.lob_id and x.user_id = p.canonical_id);
delete from public.portal_lob_employees t using _dup_pairs p where t.user_id = p.dup_id;
-- worklog_sync: UNIQUE (organization_id, user_id, issue_key).
update public.worklog_sync t set user_id = p.canonical_id
from _dup_pairs p
where t.user_id = p.dup_id
  and not exists (select 1 from public.worklog_sync x
                  where x.organization_id = t.organization_id
                    and x.user_id = p.canonical_id and x.issue_key = t.issue_key);
delete from public.worklog_sync t using _dup_pairs p where t.user_id = p.dup_id;

-- unassigned_sync_jobs exists on DEV only (transient Jira-sync job state, FK
-- ON DELETE CASCADE). Clear the dup's jobs explicitly where the table exists.
do $$
begin
  if to_regclass('public.unassigned_sync_jobs') is not null then
    execute 'delete from public.unassigned_sync_jobs t using _dup_pairs p where t.user_id = p.dup_id';
  end if;
end $$;

-- ---- 2. Drop the dup's per-user state (canonical keeps its own) ----------
delete from public.organization_members t using _dup_pairs p where t.user_id = p.dup_id;
delete from public.notification_cooldowns t using _dup_pairs p where t.user_id = p.dup_id;
delete from public.notification_preferences t using _dup_pairs p where t.user_id = p.dup_id;
delete from public.device_sessions t using _dup_pairs p where t.user_id = p.dup_id;
delete from public.user_jira_issues_cache t using _dup_pairs p where t.user_id = p.dup_id;
delete from public.user_oauth_credentials t using _dup_pairs p where t.user_id = p.dup_id;

-- ---- 3. Delete dup rows, then move the google identity -------------------
-- (delete first: the partial unique index on google_sub would reject the copy
-- while the dup still holds the same value)
delete from public.users u using _dup_pairs p where u.id = p.dup_id;

update public.users u
set google_sub = p.dup_google_sub
from _dup_pairs p
where u.id = p.canonical_id;

-- ---- 4. Constraint hygiene -----------------------------------------------
-- google_sub must be unique for ANY provider now that linked Atlassian rows
-- carry one (the old index only covered auth_provider='google').
drop index if exists public.idx_users_google_sub_unique;
create unique index idx_users_google_sub_unique
  on public.users (google_sub)
  where google_sub is not null;

-- One active account per email per org — turns any future duplicate-creation
-- bug into a loud insert error instead of silent data splitting.
create unique index if not exists uq_users_org_email_active
  on public.users (organization_id, lower(email))
  where is_active = true and email is not null;

-- ---- 5. Verification (same paste/transaction — the temp table only lives
--         here; expect the merged pairs, then zero remaining duplicates) ----
select 'merged' as status, email, canonical_id, dup_id from _dup_pairs
union all
select 'REMAINING DUPLICATE (needs manual review)', x.email, x.id, null::uuid
from (
  select lower(email) as email, id,
         count(*) over (partition by lower(email), organization_id) as n
  from public.users
  where is_active and email is not null
) x
where x.n > 1;
