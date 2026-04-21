-- ============================================================================
-- Migration: Remove status filter from time-summary views
-- Date: 2026-04-22
--
-- The day timeline endpoints (fetchMyDayTimeline, fetchTeamDayTimeline) query
-- activity_records with no status filter, so records in 'failed' status still
-- render on the timeline as unassigned/idle blocks. The summary views, however,
-- filtered to status IN ('pending','processing','analyzed'), which caused the
-- Today/Week/Month cards to show a lower total than the timeline blocks visibly
-- represented.
--
-- Product decision: the timeline is the source of truth for "time the desktop
-- app tracked." A failed OCR/AI classification doesn't mean the user wasn't
-- working -- it just means we couldn't auto-classify the activity. The time
-- should still be counted (as unassigned, which the user can convert to a
-- worklog manually).
--
-- This migration drops status-based filtering from the activity_records branch
-- of all three views so timeline and cards report the same total.
-- ============================================================================

DROP VIEW IF EXISTS public.monthly_time_summary;
DROP VIEW IF EXISTS public.weekly_time_summary;
DROP VIEW IF EXISTS public.daily_time_summary;

-- ============================================================================
-- View: Daily time summary
-- ============================================================================
CREATE VIEW public.daily_time_summary AS
SELECT
    combined.user_id,
    combined.organization_id,
    combined.user_display_name,
    combined.work_date,
    combined.project_key,
    combined.task_key,
    combined.work_type,
    SUM(combined.session_count) AS session_count,
    SUM(combined.total_seconds) AS total_seconds,
    ROUND(SUM(combined.total_seconds)::NUMERIC / 3600.0, 2) AS total_hours,
    AVG(combined.avg_confidence) AS avg_confidence
FROM (
    -- Legacy data from screenshots + analysis_results
    SELECT
        ar.user_id,
        ar.organization_id,
        u.display_name AS user_display_name,
        COALESCE(s.work_date, DATE(s.timestamp AT TIME ZONE 'UTC')) AS work_date,
        ar.active_project_key AS project_key,
        ar.active_task_key AS task_key,
        ar.work_type,
        COUNT(*) AS session_count,
        SUM(COALESCE(s.duration_seconds, ar.time_spent_seconds)) AS total_seconds,
        AVG(ar.confidence_score) AS avg_confidence
    FROM public.analysis_results ar
    JOIN public.screenshots s ON ar.screenshot_id = s.id
    LEFT JOIN public.users u ON ar.user_id = u.id
    WHERE s.deleted_at IS NULL
      AND ar.work_type = 'office'
    GROUP BY ar.user_id, ar.organization_id, u.display_name,
             COALESCE(s.work_date, DATE(s.timestamp AT TIME ZONE 'UTC')),
             ar.active_project_key, ar.active_task_key, ar.work_type

    UNION ALL

    -- New data from activity_records (excludes idle and lock-screen records).
    -- NOTE: status filter intentionally removed so 'failed' records are counted
    -- consistently with the day-timeline endpoints.
    SELECT
        act.user_id,
        act.organization_id,
        u.display_name AS user_display_name,
        act.work_date,
        act.project_key,
        act.user_assigned_issue_key AS task_key,
        'office' AS work_type,
        1 AS session_count,
        act.duration_seconds AS total_seconds,
        NULL::NUMERIC AS avg_confidence
    FROM public.activity_records act
    LEFT JOIN public.users u ON act.user_id = u.id
    WHERE act.work_date IS NOT NULL
      AND COALESCE(act.is_idle, false) = false
      AND LOWER(COALESCE(act.application_name, '')) NOT IN ('lockapp.exe', 'logonui.exe')
) combined
GROUP BY combined.user_id, combined.organization_id, combined.user_display_name,
         combined.work_date, combined.project_key, combined.task_key, combined.work_type
ORDER BY work_date DESC, total_seconds DESC;

-- ============================================================================
-- View: Weekly time summary
-- ============================================================================
CREATE VIEW public.weekly_time_summary AS
SELECT
    combined.user_id,
    combined.organization_id,
    combined.user_display_name,
    DATE_TRUNC('week', combined.work_date::timestamp)::DATE AS week_start,
    combined.project_key,
    combined.task_key,
    combined.work_type,
    SUM(combined.session_count) AS session_count,
    SUM(combined.total_seconds) AS total_seconds,
    ROUND(SUM(combined.total_seconds)::NUMERIC / 3600.0, 2) AS total_hours,
    AVG(combined.avg_confidence) AS avg_confidence
FROM (
    SELECT
        ar.user_id,
        ar.organization_id,
        u.display_name AS user_display_name,
        COALESCE(s.work_date, DATE(s.timestamp AT TIME ZONE 'UTC')) AS work_date,
        ar.active_project_key AS project_key,
        ar.active_task_key AS task_key,
        ar.work_type,
        COUNT(*) AS session_count,
        SUM(COALESCE(s.duration_seconds, ar.time_spent_seconds)) AS total_seconds,
        AVG(ar.confidence_score) AS avg_confidence
    FROM public.analysis_results ar
    JOIN public.screenshots s ON ar.screenshot_id = s.id
    LEFT JOIN public.users u ON ar.user_id = u.id
    WHERE s.deleted_at IS NULL
      AND ar.work_type = 'office'
    GROUP BY ar.user_id, ar.organization_id, u.display_name,
             COALESCE(s.work_date, DATE(s.timestamp AT TIME ZONE 'UTC')),
             ar.active_project_key, ar.active_task_key, ar.work_type

    UNION ALL

    SELECT
        act.user_id,
        act.organization_id,
        u.display_name AS user_display_name,
        act.work_date,
        act.project_key,
        act.user_assigned_issue_key AS task_key,
        'office' AS work_type,
        1 AS session_count,
        act.duration_seconds AS total_seconds,
        NULL::NUMERIC AS avg_confidence
    FROM public.activity_records act
    LEFT JOIN public.users u ON act.user_id = u.id
    WHERE act.work_date IS NOT NULL
      AND COALESCE(act.is_idle, false) = false
      AND LOWER(COALESCE(act.application_name, '')) NOT IN ('lockapp.exe', 'logonui.exe')
) combined
GROUP BY combined.user_id, combined.organization_id, combined.user_display_name,
         DATE_TRUNC('week', combined.work_date::timestamp),
         combined.project_key, combined.task_key, combined.work_type
ORDER BY week_start DESC, total_seconds DESC;

-- ============================================================================
-- View: Monthly time summary
-- ============================================================================
CREATE VIEW public.monthly_time_summary AS
SELECT
    combined.user_id,
    combined.organization_id,
    combined.user_display_name,
    DATE_TRUNC('month', combined.work_date::timestamp)::DATE AS month_start,
    combined.project_key,
    combined.task_key,
    combined.work_type,
    SUM(combined.session_count) AS session_count,
    SUM(combined.total_seconds) AS total_seconds,
    ROUND(SUM(combined.total_seconds)::NUMERIC / 3600.0, 2) AS total_hours,
    AVG(combined.avg_confidence) AS avg_confidence
FROM (
    SELECT
        ar.user_id,
        ar.organization_id,
        u.display_name AS user_display_name,
        COALESCE(s.work_date, DATE(s.timestamp AT TIME ZONE 'UTC')) AS work_date,
        ar.active_project_key AS project_key,
        ar.active_task_key AS task_key,
        ar.work_type,
        COUNT(*) AS session_count,
        SUM(COALESCE(s.duration_seconds, ar.time_spent_seconds)) AS total_seconds,
        AVG(ar.confidence_score) AS avg_confidence
    FROM public.analysis_results ar
    JOIN public.screenshots s ON ar.screenshot_id = s.id
    LEFT JOIN public.users u ON ar.user_id = u.id
    WHERE s.deleted_at IS NULL
      AND ar.work_type = 'office'
    GROUP BY ar.user_id, ar.organization_id, u.display_name,
             COALESCE(s.work_date, DATE(s.timestamp AT TIME ZONE 'UTC')),
             ar.active_project_key, ar.active_task_key, ar.work_type

    UNION ALL

    SELECT
        act.user_id,
        act.organization_id,
        u.display_name AS user_display_name,
        act.work_date,
        act.project_key,
        act.user_assigned_issue_key AS task_key,
        'office' AS work_type,
        1 AS session_count,
        act.duration_seconds AS total_seconds,
        NULL::NUMERIC AS avg_confidence
    FROM public.activity_records act
    LEFT JOIN public.users u ON act.user_id = u.id
    WHERE act.work_date IS NOT NULL
      AND COALESCE(act.is_idle, false) = false
      AND LOWER(COALESCE(act.application_name, '')) NOT IN ('lockapp.exe', 'logonui.exe')
) combined
GROUP BY combined.user_id, combined.organization_id, combined.user_display_name,
         DATE_TRUNC('month', combined.work_date::timestamp),
         combined.project_key, combined.task_key, combined.work_type
ORDER BY month_start DESC, total_seconds DESC;

-- ============================================================================
-- Preserve SECURITY INVOKER setting
-- ============================================================================
ALTER VIEW public.daily_time_summary   SET (security_invoker = on);
ALTER VIEW public.weekly_time_summary  SET (security_invoker = on);
ALTER VIEW public.monthly_time_summary SET (security_invoker = on);

COMMENT ON VIEW public.daily_time_summary   IS 'Daily time aggregation (all activity_records statuses, excludes idle/lock-screen) - SECURITY INVOKER';
COMMENT ON VIEW public.weekly_time_summary  IS 'Weekly time aggregation (all activity_records statuses, excludes idle/lock-screen) - SECURITY INVOKER';
COMMENT ON VIEW public.monthly_time_summary IS 'Monthly time aggregation (all activity_records statuses, excludes idle/lock-screen) - SECURITY INVOKER';
