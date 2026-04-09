-- =============================================================================
-- ALL user activity for today (2026-04-09) with issue breakdown
-- Shows EVERY record from BOTH data sources
-- =============================================================================

-- =============================================
-- 1. activity_records: Per-user, per-issue breakdown (newer pipeline)
--    This is what Team Analytics table + modal uses
-- =============================================
SELECT
    u.display_name AS member,
    ar.work_date,
    COALESCE(ar.user_assigned_issue_key, '(no issue)') AS issue_key,
    COALESCE(ar.project_key, '(no project)') AS project_key,
    ar.classification,
    COUNT(*) AS records,
    SUM(ar.duration_seconds) AS total_seconds,
    FLOOR(SUM(ar.duration_seconds) / 3600) || 'h '
      || FLOOR((SUM(ar.duration_seconds) % 3600) / 60) || 'm '
      || (SUM(ar.duration_seconds) % 60) || 's' AS time_display,
    MIN(ar.start_time AT TIME ZONE 'Asia/Kolkata') AS first_start_ist,
    MAX(ar.end_time AT TIME ZONE 'Asia/Kolkata') AS last_end_ist
FROM activity_records ar
JOIN users u ON ar.user_id = u.id
WHERE ar.work_date = '2026-04-09'
GROUP BY u.display_name, ar.work_date, ar.user_assigned_issue_key, ar.project_key, ar.classification
ORDER BY u.display_name, total_seconds DESC;


-- =============================================
-- 2. activity_records: Per-user TOTAL (with and without project_key filter)
--    Shows why team analytics table is LESS than daily timesheet
-- =============================================
WITH all_records AS (
    SELECT
        u.display_name,
        ar.project_key,
        ar.classification,
        SUM(ar.duration_seconds) AS seconds
    FROM activity_records ar
    JOIN users u ON ar.user_id = u.id
    WHERE ar.work_date = '2026-04-09'
      AND ar.classification IN ('productive', 'unknown')
    GROUP BY u.display_name, ar.project_key, ar.classification
)
SELECT
    display_name AS member,
    COALESCE(project_key, '(NULL - no project)') AS project_key,
    classification,
    seconds,
    FLOOR(seconds / 3600) || 'h ' || FLOOR((seconds % 3600) / 60) || 'm ' || (seconds % 60) || 's' AS time_display
FROM all_records
ORDER BY display_name, seconds DESC;


-- =============================================
-- 3. COMPARISON: Total with vs without project_key filter
--    This shows EXACTLY what time the team analytics table drops
-- =============================================
WITH per_user AS (
    SELECT
        u.display_name,
        SUM(ar.duration_seconds) AS total_all,
        SUM(CASE WHEN ar.project_key IS NOT NULL THEN ar.duration_seconds ELSE 0 END) AS total_with_project,
        SUM(CASE WHEN ar.project_key IS NULL THEN ar.duration_seconds ELSE 0 END) AS total_no_project
    FROM activity_records ar
    JOIN users u ON ar.user_id = u.id
    WHERE ar.work_date = '2026-04-09'
      AND ar.classification IN ('productive', 'unknown')
    GROUP BY u.display_name
)
SELECT
    display_name AS member,
    total_all,
    FLOOR(total_all / 3600) || 'h ' || FLOOR((total_all % 3600) / 60) || 'm ' || (total_all % 60) || 's' AS total_all_display,
    total_with_project,
    FLOOR(total_with_project / 3600) || 'h ' || FLOOR((total_with_project % 3600) / 60) || 'm ' || (total_with_project % 60) || 's' AS with_project_display,
    total_no_project AS missing_from_table_seconds,
    FLOOR(total_no_project / 3600) || 'h ' || FLOOR((total_no_project % 3600) / 60) || 'm ' || (total_no_project % 60) || 's' AS missing_display,
    CASE WHEN total_no_project > 0
        THEN 'Team table DROPS ' || FLOOR(total_no_project / 3600) || 'h ' || FLOOR((total_no_project % 3600) / 60) || 'm of unassigned work'
        ELSE 'All work has a project_key - no data loss'
    END AS explanation
FROM per_user
ORDER BY display_name;


-- =============================================
-- 4. analysis_results (daily_time_summary) vs activity_records
--    Shows difference between Daily Timesheet and Team Analytics
-- =============================================
WITH timesheet_source AS (
    -- Daily Timesheet uses analysis_results + screenshots
    SELECT
        u.display_name,
        SUM(COALESCE(s.duration_seconds, ar.time_spent_seconds)) AS total_seconds
    FROM analysis_results ar
    JOIN screenshots s ON ar.screenshot_id = s.id
    JOIN users u ON ar.user_id = u.id
    WHERE DATE(s.timestamp AT TIME ZONE 'UTC') = '2026-04-09'
      AND s.deleted_at IS NULL
      AND ar.work_type = 'office'
    GROUP BY u.display_name
),
team_source AS (
    -- Team Analytics uses activity_records
    SELECT
        u.display_name,
        SUM(ar.duration_seconds) AS total_seconds
    FROM activity_records ar
    JOIN users u ON ar.user_id = u.id
    WHERE ar.work_date = '2026-04-09'
      AND ar.classification IN ('productive', 'unknown')
    GROUP BY u.display_name
),
team_with_project AS (
    -- Team Analytics with project_key filter (what table actually shows)
    SELECT
        u.display_name,
        SUM(ar.duration_seconds) AS total_seconds
    FROM activity_records ar
    JOIN users u ON ar.user_id = u.id
    WHERE ar.work_date = '2026-04-09'
      AND ar.classification IN ('productive', 'unknown')
      AND ar.project_key IS NOT NULL
    GROUP BY u.display_name
)
SELECT
    COALESCE(ts.display_name, te.display_name) AS member,
    -- Daily Timesheet (analysis_results)
    COALESCE(ts.total_seconds, 0) AS timesheet_seconds,
    FLOOR(COALESCE(ts.total_seconds, 0) / 3600) || 'h '
      || FLOOR((COALESCE(ts.total_seconds, 0) % 3600) / 60) || 'm '
      || (COALESCE(ts.total_seconds, 0) % 60) || 's' AS daily_timesheet,
    -- All activity_records (what modal + table SHOULD show)
    COALESCE(te.total_seconds, 0) AS all_activity_seconds,
    FLOOR(COALESCE(te.total_seconds, 0) / 3600) || 'h '
      || FLOOR((COALESCE(te.total_seconds, 0) % 3600) / 60) || 'm '
      || (COALESCE(te.total_seconds, 0) % 60) || 's' AS all_activity_display,
    -- activity_records with project filter (what table CURRENTLY shows)
    COALESCE(tp.total_seconds, 0) AS table_current_seconds,
    FLOOR(COALESCE(tp.total_seconds, 0) / 3600) || 'h '
      || FLOOR((COALESCE(tp.total_seconds, 0) % 3600) / 60) || 'm '
      || (COALESCE(tp.total_seconds, 0) % 60) || 's' AS team_table_current
FROM timesheet_source ts
FULL OUTER JOIN team_source te ON ts.display_name = te.display_name
FULL OUTER JOIN team_with_project tp ON ts.display_name = tp.display_name
ORDER BY member;


-- =============================================
-- 5. DETAILED: Every single activity_record entry per user today
--    Full breakdown with timestamps
-- =============================================
SELECT
    u.display_name AS member,
    ar.start_time AT TIME ZONE 'Asia/Kolkata' AS start_ist,
    ar.end_time AT TIME ZONE 'Asia/Kolkata' AS end_ist,
    ar.duration_seconds,
    FLOOR(ar.duration_seconds / 60) || 'm ' || (ar.duration_seconds % 60) || 's' AS duration,
    ar.classification,
    COALESCE(ar.project_key, '(none)') AS project_key,
    COALESCE(ar.user_assigned_issue_key, '(none)') AS issue_key,
    ar.application_name,
    LEFT(ar.window_title, 80) AS window_title
FROM activity_records ar
JOIN users u ON ar.user_id = u.id
WHERE ar.work_date = '2026-04-09'
ORDER BY u.display_name, ar.start_time;
