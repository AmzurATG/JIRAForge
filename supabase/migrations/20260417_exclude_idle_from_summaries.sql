-- ============================================================================
-- Migration: Exclude idle / lock-screen records from time summary views
-- Date: 2026-04-17
--
-- Problem: LockApp.exe (Windows lock screen) was recorded as an active
-- session spanning overnight hours (e.g. 1:20 AM – 10:56 AM = 8h 31m).
-- Because the daily/weekly/monthly summary views include ALL activity
-- records regardless of is_idle or application_name, the inflated
-- LockApp.exe record was counted in "Time Spent Today".
--
-- Fix: Add two filters to the activity_records subquery in each view:
--   1. COALESCE(act.is_idle, false) = false  — exclude explicit idle records
--   2. act.application_name NOT IN ('LockApp.exe', 'LogonUI.exe')
--      — defense-in-depth for records that slipped through without is_idle
--
-- The legacy screenshots subquery is unchanged (it never had this issue).
-- ============================================================================

-- ============================================================================
-- DROP existing views (required — CREATE OR REPLACE cannot change column types)
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

    -- New data from activity_records (excludes idle and lock-screen records)
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
    WHERE act.status IN ('pending', 'processing', 'analyzed')
      AND act.work_date IS NOT NULL
      AND COALESCE(act.is_idle, false) = false
      AND act.application_name NOT IN ('LockApp.exe', 'LogonUI.exe')
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

    -- New data from activity_records (excludes idle and lock-screen records)
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
    WHERE act.status IN ('pending', 'processing', 'analyzed')
      AND act.work_date IS NOT NULL
      AND COALESCE(act.is_idle, false) = false
      AND act.application_name NOT IN ('LockApp.exe', 'LogonUI.exe')
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

    -- New data from activity_records (excludes idle and lock-screen records)
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
    WHERE act.status IN ('pending', 'processing', 'analyzed')
      AND act.work_date IS NOT NULL
      AND COALESCE(act.is_idle, false) = false
      AND act.application_name NOT IN ('LockApp.exe', 'LogonUI.exe')
) combined
GROUP BY combined.user_id, combined.organization_id, combined.user_display_name,
         DATE_TRUNC('month', combined.work_date::timestamp),
         combined.project_key, combined.task_key, combined.work_type
ORDER BY month_start DESC, total_seconds DESC;

-- ============================================================================
-- Preserve SECURITY INVOKER setting
-- ============================================================================
ALTER VIEW public.daily_time_summary SET (security_invoker = on);
ALTER VIEW public.weekly_time_summary SET (security_invoker = on);
ALTER VIEW public.monthly_time_summary SET (security_invoker = on);

-- ============================================================================
-- COMMENTS
-- ============================================================================
COMMENT ON VIEW public.daily_time_summary IS 'Daily time aggregation combining legacy screenshot analysis and activity records (excludes idle/lock-screen time) - SECURITY INVOKER';
COMMENT ON VIEW public.weekly_time_summary IS 'Weekly time aggregation combining legacy screenshot analysis and activity records (excludes idle/lock-screen time) - SECURITY INVOKER';
COMMENT ON VIEW public.monthly_time_summary IS 'Monthly time aggregation combining legacy screenshot analysis and activity records (excludes idle/lock-screen time) - SECURITY INVOKER';
