-- =============================================================================
-- DEBUG: Time Discrepancy Between Table and Modal
-- =============================================================================
-- Table uses: daily_time_summary (view over analysis_results + screenshots)
-- Modal uses: daily_time_summary for total + activity_records for breakdown
--
-- Run these queries in Supabase SQL Editor to compare both data sources.
-- Replace the date '2026-04-09' with today's actual date if different.
-- =============================================================================

-- =============================================
-- 1. TABLE SOURCE: daily_time_summary per user for today
--    This is what the Team Member Activity table shows
-- =============================================
SELECT
    user_id,
    user_display_name,
    project_key,
    work_date,
    SUM(total_seconds) AS total_seconds,
    ROUND(SUM(total_seconds)::NUMERIC / 3600.0, 2) AS total_hours,
    SUM(session_count) AS session_count
FROM daily_time_summary
WHERE work_date = '2026-04-09'
GROUP BY user_id, user_display_name, project_key, work_date
ORDER BY user_display_name;


-- =============================================
-- 2. TABLE SOURCE (DETAILED): daily_time_summary per user + task
--    Shows the breakdown by task_key within the view
-- =============================================
SELECT
    user_id,
    user_display_name,
    project_key,
    task_key,
    work_date,
    total_seconds,
    total_hours,
    session_count
FROM daily_time_summary
WHERE work_date = '2026-04-09'
ORDER BY user_display_name, total_seconds DESC;


-- =============================================
-- 3. MODAL SOURCE: activity_records per user for today
--    This is what the modal issue breakdown comes from
-- =============================================
SELECT
    ar.user_id,
    u.display_name,
    ar.project_key,
    ar.work_date,
    ar.classification,
    ar.user_assigned_issue_key,
    SUM(ar.duration_seconds) AS total_seconds,
    ROUND(SUM(ar.duration_seconds)::NUMERIC / 3600.0, 2) AS total_hours,
    COUNT(*) AS record_count
FROM activity_records ar
LEFT JOIN users u ON ar.user_id = u.id
WHERE ar.work_date = '2026-04-09'
  AND ar.classification IN ('productive', 'unknown')
GROUP BY ar.user_id, u.display_name, ar.project_key, ar.work_date, ar.classification, ar.user_assigned_issue_key
ORDER BY u.display_name, total_seconds DESC;


-- =============================================
-- 4. COMPARISON: Side-by-side totals from both sources per user
--    This shows the exact discrepancy
-- =============================================
WITH table_source AS (
    SELECT
        user_id,
        user_display_name,
        SUM(total_seconds) AS table_total_seconds
    FROM daily_time_summary
    WHERE work_date = '2026-04-09'
    GROUP BY user_id, user_display_name
),
modal_source AS (
    SELECT
        user_id,
        SUM(duration_seconds) AS modal_total_seconds
    FROM activity_records
    WHERE work_date = '2026-04-09'
      AND classification IN ('productive', 'unknown')
    GROUP BY user_id
)
SELECT
    t.user_display_name AS member,
    t.table_total_seconds,
    ROUND(t.table_total_seconds::NUMERIC / 3600.0, 2) AS table_hours,
    -- Table display: rounded to 1 decimal
    ROUND(t.table_total_seconds::NUMERIC / 3600.0, 1) AS table_display_hours,
    COALESCE(m.modal_total_seconds, 0) AS modal_total_seconds,
    ROUND(COALESCE(m.modal_total_seconds, 0)::NUMERIC / 3600.0, 2) AS modal_hours,
    -- Difference
    t.table_total_seconds - COALESCE(m.modal_total_seconds, 0) AS diff_seconds,
    ROUND((t.table_total_seconds - COALESCE(m.modal_total_seconds, 0))::NUMERIC / 3600.0, 2) AS diff_hours,
    -- What the modal NOW shows (uses table total as authoritative)
    t.table_total_seconds || 's = '
      || FLOOR(t.table_total_seconds / 3600) || 'h '
      || FLOOR((t.table_total_seconds % 3600) / 60) || 'm '
      || (t.table_total_seconds % 60) || 's' AS modal_display_time
FROM table_source t
LEFT JOIN modal_source m ON t.user_id = m.user_id
ORDER BY t.user_display_name;


-- =============================================
-- 5. RAW DATA: analysis_results + screenshots for today
--    This is the underlying data behind daily_time_summary
-- =============================================
SELECT
    ar.user_id,
    u.display_name,
    ar.active_project_key,
    ar.active_task_key,
    s.id AS screenshot_id,
    DATE(s.timestamp AT TIME ZONE 'UTC') AS work_date_utc,
    s.work_date AS screenshot_work_date,
    s.duration_seconds AS screenshot_duration,
    ar.time_spent_seconds AS ar_time_spent,
    COALESCE(s.duration_seconds, ar.time_spent_seconds) AS used_seconds,
    s.timestamp,
    s.start_time,
    s.end_time,
    ar.work_type,
    s.deleted_at
FROM analysis_results ar
JOIN screenshots s ON ar.screenshot_id = s.id
LEFT JOIN users u ON ar.user_id = u.id
WHERE DATE(s.timestamp AT TIME ZONE 'UTC') = '2026-04-09'
  AND s.deleted_at IS NULL
  AND ar.work_type = 'office'
ORDER BY u.display_name, s.timestamp;


-- =============================================
-- 6. CHECK: Are there analysis_results without matching activity_records?
--    This explains the "Other Activity" gap
-- =============================================
WITH ar_users AS (
    SELECT DISTINCT ar.user_id, u.display_name
    FROM analysis_results ar
    JOIN screenshots s ON ar.screenshot_id = s.id
    LEFT JOIN users u ON ar.user_id = u.id
    WHERE DATE(s.timestamp AT TIME ZONE 'UTC') = '2026-04-09'
      AND s.deleted_at IS NULL
      AND ar.work_type = 'office'
),
ar_total AS (
    SELECT
        ar.user_id,
        SUM(COALESCE(s.duration_seconds, ar.time_spent_seconds)) AS total
    FROM analysis_results ar
    JOIN screenshots s ON ar.screenshot_id = s.id
    WHERE DATE(s.timestamp AT TIME ZONE 'UTC') = '2026-04-09'
      AND s.deleted_at IS NULL
      AND ar.work_type = 'office'
    GROUP BY ar.user_id
),
act_total AS (
    SELECT
        user_id,
        SUM(duration_seconds) AS total
    FROM activity_records
    WHERE work_date = '2026-04-09'
      AND classification IN ('productive', 'unknown')
    GROUP BY user_id
)
SELECT
    au.display_name,
    COALESCE(art.total, 0) AS analysis_results_seconds,
    COALESCE(act.total, 0) AS activity_records_seconds,
    COALESCE(art.total, 0) - COALESCE(act.total, 0) AS gap_seconds,
    CASE
        WHEN COALESCE(art.total, 0) - COALESCE(act.total, 0) > 0
        THEN 'analysis_results has MORE data (shows as "Other Activity" in modal)'
        WHEN COALESCE(art.total, 0) - COALESCE(act.total, 0) < 0
        THEN 'activity_records has MORE data (unexpected)'
        ELSE 'Both sources match perfectly'
    END AS explanation
FROM ar_users au
LEFT JOIN ar_total art ON au.user_id = art.user_id
LEFT JOIN act_total act ON au.user_id = act.user_id
ORDER BY au.display_name;
