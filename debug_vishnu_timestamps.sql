-- =============================================================================
-- DEBUG: Vishnu's tracking timestamps for today (2026-04-09)
-- Shows EVERY tracked entry with exact start/end times
-- =============================================================================

-- =============================================
-- 1. activity_records: All entries with timestamps (newer pipeline)
-- =============================================
SELECT
    ar.id,
    ar.work_date,
    ar.start_time AT TIME ZONE 'Asia/Kolkata' AS start_time_ist,
    ar.end_time AT TIME ZONE 'Asia/Kolkata' AS end_time_ist,
    ar.duration_seconds,
    FLOOR(ar.duration_seconds / 60) || 'm ' || (ar.duration_seconds % 60) || 's' AS duration_display,
    ar.classification,
    ar.user_assigned_issue_key,
    ar.application_name,
    ar.window_title,
    ar.status
FROM activity_records ar
JOIN users u ON ar.user_id = u.id
WHERE ar.work_date = '2026-04-09'
  AND u.display_name ILIKE '%Vishnu%'
ORDER BY ar.start_time ASC;


-- =============================================
-- 2. analysis_results + screenshots: All entries with timestamps (older pipeline)
-- =============================================
SELECT
    s.id AS screenshot_id,
    s.timestamp AT TIME ZONE 'Asia/Kolkata' AS timestamp_ist,
    s.start_time AT TIME ZONE 'Asia/Kolkata' AS start_time_ist,
    s.end_time AT TIME ZONE 'Asia/Kolkata' AS end_time_ist,
    COALESCE(s.duration_seconds, ar.time_spent_seconds) AS used_seconds,
    FLOOR(COALESCE(s.duration_seconds, ar.time_spent_seconds) / 60) || 'm ' ||
      (COALESCE(s.duration_seconds, ar.time_spent_seconds) % 60) || 's' AS duration_display,
    ar.active_project_key,
    ar.active_task_key,
    ar.work_type,
    ar.confidence_score,
    s.work_date AS screenshot_work_date,
    DATE(s.timestamp AT TIME ZONE 'UTC') AS utc_work_date
FROM analysis_results ar
JOIN screenshots s ON ar.screenshot_id = s.id
JOIN users u ON ar.user_id = u.id
WHERE DATE(s.timestamp AT TIME ZONE 'UTC') = '2026-04-09'
  AND s.deleted_at IS NULL
  AND ar.work_type = 'office'
  AND u.display_name ILIKE '%Vishnu%'
ORDER BY s.timestamp ASC;


-- =============================================
-- 3. SUMMARY: First/last tracking time + total per source
-- =============================================
WITH act AS (
    SELECT
        MIN(ar.start_time AT TIME ZONE 'Asia/Kolkata') AS first_start,
        MAX(ar.end_time AT TIME ZONE 'Asia/Kolkata') AS last_end,
        SUM(ar.duration_seconds) AS total_seconds,
        COUNT(*) AS record_count
    FROM activity_records ar
    JOIN users u ON ar.user_id = u.id
    WHERE ar.work_date = '2026-04-09'
      AND u.display_name ILIKE '%Vishnu%'
      AND ar.classification IN ('productive', 'unknown')
),
scr AS (
    SELECT
        MIN(s.start_time AT TIME ZONE 'Asia/Kolkata') AS first_start,
        MAX(s.end_time AT TIME ZONE 'Asia/Kolkata') AS last_end,
        SUM(COALESCE(s.duration_seconds, ar.time_spent_seconds)) AS total_seconds,
        COUNT(*) AS record_count
    FROM analysis_results ar
    JOIN screenshots s ON ar.screenshot_id = s.id
    JOIN users u ON ar.user_id = u.id
    WHERE DATE(s.timestamp AT TIME ZONE 'UTC') = '2026-04-09'
      AND s.deleted_at IS NULL
      AND ar.work_type = 'office'
      AND u.display_name ILIKE '%Vishnu%'
)
SELECT 'activity_records' AS source,
    act.first_start, act.last_end,
    act.total_seconds,
    FLOOR(act.total_seconds / 3600) || 'h ' || FLOOR((act.total_seconds % 3600) / 60) || 'm' AS total_display,
    act.record_count
FROM act
UNION ALL
SELECT 'analysis_results' AS source,
    scr.first_start, scr.last_end,
    scr.total_seconds,
    FLOOR(scr.total_seconds / 3600) || 'h ' || FLOOR((scr.total_seconds % 3600) / 60) || 'm' AS total_display,
    scr.record_count
FROM scr;


-- =============================================
-- 4. CHECK FOR OVERLAPS: Are there overlapping time entries?
--    Overlapping entries = double-counted time = inflated hours
-- =============================================
WITH entries AS (
    SELECT
        s.start_time,
        s.end_time,
        COALESCE(s.duration_seconds, ar.time_spent_seconds) AS duration,
        s.id AS screenshot_id
    FROM analysis_results ar
    JOIN screenshots s ON ar.screenshot_id = s.id
    JOIN users u ON ar.user_id = u.id
    WHERE DATE(s.timestamp AT TIME ZONE 'UTC') = '2026-04-09'
      AND s.deleted_at IS NULL
      AND ar.work_type = 'office'
      AND u.display_name ILIKE '%Vishnu%'
)
SELECT
    a.screenshot_id AS entry_a,
    a.start_time AT TIME ZONE 'Asia/Kolkata' AS a_start,
    a.end_time AT TIME ZONE 'Asia/Kolkata' AS a_end,
    a.duration AS a_seconds,
    b.screenshot_id AS entry_b,
    b.start_time AT TIME ZONE 'Asia/Kolkata' AS b_start,
    b.end_time AT TIME ZONE 'Asia/Kolkata' AS b_end,
    b.duration AS b_seconds
FROM entries a
JOIN entries b ON a.screenshot_id < b.screenshot_id
WHERE a.start_time < b.end_time AND b.start_time < a.end_time
ORDER BY a.start_time
LIMIT 50;


-- =============================================
-- 5. HOURLY BREAKDOWN: How much time per hour today?
--    Helps spot if any hour has unreasonably high tracking
-- =============================================
SELECT
    EXTRACT(HOUR FROM s.timestamp AT TIME ZONE 'Asia/Kolkata') AS hour_ist,
    TO_CHAR(
      DATE_TRUNC('hour', s.timestamp AT TIME ZONE 'Asia/Kolkata'),
      'HH12:MI AM'
    ) AS hour_label,
    COUNT(*) AS entries,
    SUM(COALESCE(s.duration_seconds, ar.time_spent_seconds)) AS total_seconds,
    FLOOR(SUM(COALESCE(s.duration_seconds, ar.time_spent_seconds)) / 60) || 'm ' ||
      (SUM(COALESCE(s.duration_seconds, ar.time_spent_seconds)) % 60) || 's' AS total_display
FROM analysis_results ar
JOIN screenshots s ON ar.screenshot_id = s.id
JOIN users u ON ar.user_id = u.id
WHERE DATE(s.timestamp AT TIME ZONE 'UTC') = '2026-04-09'
  AND s.deleted_at IS NULL
  AND ar.work_type = 'office'
  AND u.display_name ILIKE '%Vishnu%'
GROUP BY 1, 2
ORDER BY 1;
