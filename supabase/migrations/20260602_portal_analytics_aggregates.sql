-- ============================================================================
-- Migration: Portal analytics aggregate functions (fix 1000-row cap undercount)
-- Date: 2026-06-02
-- Spec: plan/2026-06-01_web-productivity-portal_lob-segmentation-rbac.md §6.3
--
-- Root cause: the portal dashboard/employees/reports fetched raw rows and summed
-- them in Node, but PostgREST caps responses at 1000 rows, so any view over
-- 1000 activity rows silently undercounted (verified: 6,920 rows in a week
-- returned only 1,000 -> 23.8h instead of ~146h). Aggregating in SQL returns a
-- handful of rows (well under the cap) and the exact totals.
--
-- All functions:
--   * read-only over public.activity_records (+ users); no table is modified.
--   * SECURITY INVOKER — the portal calls them with the service-role key, which
--     bypasses RLS; no elevated privilege needed.
--   * explicit empty search_path (advisor hygiene); all objects schema-qualified.
--   * p_user_ids NULL = no user filter (superadmin/all); an array = LOB scope.
--   * match the existing portal filter `is_idle <> true`.
-- ============================================================================

-- 1) Dashboard: distinct employees + per-day productive/non-productive seconds
create or replace function public.portal_dashboard_summary(
  p_from date,
  p_to date,
  p_user_ids uuid[] default null
)
returns json
language sql
stable
security invoker
set search_path = ''
as $$
  select json_build_object(
    'employeeCount', (
      select count(distinct ar.user_id)
      from public.activity_records ar
      where ar.work_date >= p_from and ar.work_date <= p_to and ar.is_idle <> true
        and (p_user_ids is null or ar.user_id = any (p_user_ids))
    ),
    'daily', coalesce((
      select json_agg(
               json_build_object(
                 'work_date', d.work_date,
                 'productive_seconds', d.productive_seconds,
                 'nonproductive_seconds', d.nonproductive_seconds
               ) order by d.work_date
             )
      from (
        select ar.work_date,
               coalesce(sum(ar.duration_seconds) filter (where ar.classification = 'productive'), 0) as productive_seconds,
               coalesce(sum(ar.duration_seconds) filter (where ar.classification in ('non_productive','non-productive')), 0) as nonproductive_seconds
        from public.activity_records ar
        where ar.work_date >= p_from and ar.work_date <= p_to and ar.is_idle <> true
          and (p_user_ids is null or ar.user_id = any (p_user_ids))
        group by ar.work_date
      ) d
    ), '[]'::json)
  );
$$;

-- 2) Employees: per-user productive/non-productive seconds + last activity,
--    joined to users so the caller does not need a second (cap-prone) query.
create or replace function public.portal_employee_summary(
  p_from date,
  p_to date,
  p_user_ids uuid[] default null
)
returns table(
  user_id uuid,
  name text,
  email text,
  productive_seconds bigint,
  nonproductive_seconds bigint,
  last_activity timestamptz
)
language sql
stable
security invoker
set search_path = ''
as $$
  select ar.user_id,
         coalesce(u.display_name, u.email, 'Unknown User') as name,
         u.email,
         coalesce(sum(ar.duration_seconds) filter (where ar.classification = 'productive'), 0)::bigint as productive_seconds,
         coalesce(sum(ar.duration_seconds) filter (where ar.classification in ('non_productive','non-productive')), 0)::bigint as nonproductive_seconds,
         max(ar.start_time) as last_activity
  from public.activity_records ar
  left join public.users u on u.id = ar.user_id
  where ar.work_date >= p_from and ar.work_date <= p_to and ar.is_idle <> true
    and (p_user_ids is null or ar.user_id = any (p_user_ids))
  group by ar.user_id, u.display_name, u.email;
$$;

-- 3) Application usage: per-application totals (optional classification filter).
create or replace function public.portal_app_usage_summary(
  p_from date,
  p_to date,
  p_user_ids uuid[] default null,
  p_classification text default null
)
returns table(
  application_name text,
  total_seconds bigint,
  session_count bigint,
  employee_count bigint
)
language sql
stable
security invoker
set search_path = ''
as $$
  select coalesce(ar.application_name, 'Unknown') as application_name,
         coalesce(sum(ar.duration_seconds), 0)::bigint as total_seconds,
         count(*)::bigint as session_count,
         count(distinct ar.user_id)::bigint as employee_count
  from public.activity_records ar
  where ar.work_date >= p_from and ar.work_date <= p_to and ar.is_idle <> true
    and (p_user_ids is null or ar.user_id = any (p_user_ids))
    and (p_classification is null or ar.classification = p_classification)
  group by coalesce(ar.application_name, 'Unknown')
  order by total_seconds desc;
$$;
