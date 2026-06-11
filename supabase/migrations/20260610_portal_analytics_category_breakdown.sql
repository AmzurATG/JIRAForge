-- ============================================================================
-- Migration: Portal analytics — Neutral + Idle category breakdown (WS-C)
-- Date: 2026-06-10
-- Spec: plan/2026-06-10_web-productivity-portal_ux-improvements.md §6.3
--
-- Canonical taxonomy (single definition, used by every portal surface):
--   Productive     = classification 'productive'
--   Non-Productive = classification 'non_productive' OR legacy 'non-productive'
--   Neutral        = any other non-idle value ('private', 'unknown', NULL, …)
--   Idle           = rows with is_idle = true (desktop idle blocks)
--
-- GUARANTEE (AC-C1): productive_seconds / nonproductive_seconds /
-- employeeCount keep byte-identical semantics to 20260602_portal_analytics_
-- aggregates.sql — the new neutral/idle outputs are purely ADDITIVE, so
-- existing dashboard numbers do not shift.
--
-- Notes:
--   * `is_idle <> true` (not IS DISTINCT FROM) is kept deliberately to match
--     the 20260602 semantics exactly (NULL is_idle rows are counted in no
--     bucket, same as before).
--   * portal_employee_summary RETURNS TABLE gains columns, which Postgres
--     cannot do via CREATE OR REPLACE → DROP + CREATE. Apply during low
--     usage; the function is read-only and callers fail soft (HTTP 500 on
--     those two endpoints only) for the instant it is absent.
--   * The HAVING clause on portal_employee_summary preserves WHO appears in
--     the employee list (only users with non-idle activity, as before) while
--     still reporting their idle seconds.
--   * portal_app_usage_summary keeps its is_idle filter (app usage of idle
--     blocks is meaningless) but its p_classification matching becomes
--     CANONICAL (AC-C5): 'non_productive' now matches BOTH stored spellings
--     and the new 'neutral' value matches private/unknown/NULL. Any other
--     value (e.g. 'private') keeps the old exact-match behavior.
--   * SECURITY INVOKER + empty search_path, matching repo convention.
-- ============================================================================

-- 1) Dashboard: distinct employees + per-day category seconds
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
                 'nonproductive_seconds', d.nonproductive_seconds,
                 'neutral_seconds', d.neutral_seconds,
                 'idle_seconds', d.idle_seconds
               ) order by d.work_date
             )
      from (
        select ar.work_date,
               coalesce(sum(ar.duration_seconds) filter (
                 where ar.is_idle <> true and ar.classification = 'productive'), 0) as productive_seconds,
               coalesce(sum(ar.duration_seconds) filter (
                 where ar.is_idle <> true and ar.classification in ('non_productive','non-productive')), 0) as nonproductive_seconds,
               coalesce(sum(ar.duration_seconds) filter (
                 where ar.is_idle <> true
                   and (ar.classification is null
                        or ar.classification not in ('productive','non_productive','non-productive'))), 0) as neutral_seconds,
               coalesce(sum(ar.duration_seconds) filter (
                 where ar.is_idle = true), 0) as idle_seconds
        from public.activity_records ar
        where ar.work_date >= p_from and ar.work_date <= p_to
          and (p_user_ids is null or ar.user_id = any (p_user_ids))
        group by ar.work_date
      ) d
    ), '[]'::json)
  );
$$;

-- 2) Employees: per-user category seconds + last (non-idle) activity.
--    RETURNS TABLE changes → DROP + CREATE (see header note).
drop function if exists public.portal_employee_summary(date, date, uuid[]);

create function public.portal_employee_summary(
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
  neutral_seconds bigint,
  idle_seconds bigint,
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
         coalesce(sum(ar.duration_seconds) filter (
           where ar.is_idle <> true and ar.classification = 'productive'), 0)::bigint as productive_seconds,
         coalesce(sum(ar.duration_seconds) filter (
           where ar.is_idle <> true and ar.classification in ('non_productive','non-productive')), 0)::bigint as nonproductive_seconds,
         coalesce(sum(ar.duration_seconds) filter (
           where ar.is_idle <> true
             and (ar.classification is null
                  or ar.classification not in ('productive','non_productive','non-productive'))), 0)::bigint as neutral_seconds,
         coalesce(sum(ar.duration_seconds) filter (
           where ar.is_idle = true), 0)::bigint as idle_seconds,
         max(ar.start_time) filter (where ar.is_idle <> true) as last_activity
  from public.activity_records ar
  left join public.users u on u.id = ar.user_id
  where ar.work_date >= p_from and ar.work_date <= p_to
    and (p_user_ids is null or ar.user_id = any (p_user_ids))
  group by ar.user_id, u.display_name, u.email
  -- Preserve the pre-existing employee set: only users with non-idle activity
  -- in the range appear (idle-only users were invisible before and stay so).
  having count(*) filter (where ar.is_idle <> true) > 0;
$$;

-- 3) Application usage: canonical p_classification matching (AC-C5).
--    Same signature/shape as 20260602 — CREATE OR REPLACE is sufficient.
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
    and (
      p_classification is null
      or (p_classification = 'productive' and ar.classification = 'productive')
      or (p_classification = 'non_productive'
          and ar.classification in ('non_productive','non-productive'))
      or (p_classification = 'neutral'
          and (ar.classification is null
               or ar.classification not in ('productive','non_productive','non-productive')))
      -- any other explicit value (e.g. 'private') keeps exact-match behavior
      or (p_classification not in ('productive','non_productive','neutral')
          and ar.classification = p_classification)
    )
  group by coalesce(ar.application_name, 'Unknown')
  order by total_seconds desc;
$$;
