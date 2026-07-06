-- ============================================================================
-- Migration: Portal employee presence (live activity status)
-- Date: 2026-07-02
-- Spec: plan/2026-07-02_portal_employee-activity-status.md
--
-- Problem: the Employees page is built from portal_employee_summary, whose
-- HAVING clause drops every user with no non-idle activity in the range —
-- inactive employees are invisible, so admins cannot see who is NOT working
-- today (verified prod 2026-07-02: 66 users, only 42 rows for "Today").
--
-- This function returns ONE row per active user account — including users with
-- no activity at all — with their latest non-idle activity timestamp, so the
-- portal can render a live status (Active / Away / Inactive / Never tracked)
-- and filter on it. portal_employee_summary is intentionally untouched.
--
--   * read-only over public.users + public.activity_records.
--   * SECURITY INVOKER — called with the service-role key (bypasses RLS),
--     matching the other portal_* functions; explicit empty search_path.
--   * p_user_ids NULL = no user filter (superadmin/all); an array = LOB scope.
--   * p_today = the VIEWER's local calendar date (work_date is the user-local
--     date, set by the desktop app).
--   * last_active_at looks back 7 days (p_today - 7): enough for every live
--     bucket the UI has (15 min / 2 h / 3 h / today); anything older reads as
--     NULL → "Inactive 7+ days". The 7-day window keeps the aggregate scan on
--     idx_activity_portal_analytics small and index-only.
--   * `is_idle <> true` (NULL matches nothing) — same NULL-parity as the
--     existing aggregates. Locked/idle-only time does NOT count as active.
--   * No org filter — matches the existing cross-org behavior of the other
--     portal RPCs; LOB scoping via p_user_ids is the access-control mechanism.
--
-- Perf (prod-verified shapes): the recent-activity scan is an index-only
-- range scan of idx_activity_portal_analytics over ≤8 work_date days;
-- ever_tracked is one index seek per user on idx_activity_user_work_date.
-- Well under the 8 s authenticator statement_timeout.
--
-- Apply: single CREATE OR REPLACE statement — safe to paste as-is into the
-- Supabase Dashboard SQL editor (no CONCURRENTLY / transaction traps).
-- ============================================================================

create or replace function public.portal_employee_presence(
  p_today date,
  p_user_ids uuid[] default null
)
returns table(
  user_id uuid,
  name text,
  email text,
  last_active_at timestamptz,
  active_today boolean,
  ever_tracked boolean
)
language sql
stable
security invoker
set search_path = ''
as $$
  with recent as (
    select ar.user_id,
           max(ar.start_time) filter (where ar.is_idle <> true) as last_active_at,
           bool_or(ar.work_date = p_today and ar.is_idle <> true) as active_today
    from public.activity_records ar
    where ar.work_date >= p_today - 7 and ar.work_date <= p_today
      and (p_user_ids is null or ar.user_id = any (p_user_ids))
    group by ar.user_id
  )
  select u.id as user_id,
         coalesce(u.display_name, u.email, 'Unknown User') as name,
         u.email,
         r.last_active_at,
         coalesce(r.active_today, false) as active_today,
         exists (
           select 1 from public.activity_records ar
           where ar.user_id = u.id
         ) as ever_tracked
  from public.users u
  left join recent r on r.user_id = u.id
  where u.is_active = true
    and (p_user_ids is null or u.id = any (p_user_ids));
$$;
