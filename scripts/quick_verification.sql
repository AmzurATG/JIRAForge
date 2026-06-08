-- ============================================================================
-- QUICK VERIFICATION — Users and Projects Summary
-- ============================================================================
-- This shows you exactly what SHOULD appear in the full report

WITH date_filtered_records AS (
  SELECT 
    ar.id,
    ar.user_id,
    ar.organization_id,
    ar.user_assigned_issue_key,
    ar.user_assigned_issues,
    ar.classification,
    ar.status
  FROM activity_records ar
  WHERE ar.created_at >= '2026-06-01'::DATE
    AND ar.created_at < '2026-06-08'::DATE
    AND ar.classification = 'productive'
    AND ar.status = 'analyzed'
),

user_issues_expanded AS (
  SELECT DISTINCT
    dfr.user_id,
    u.email,
    (jsonb_array_elements(dfr.user_assigned_issues::jsonb))->>'key' AS issue_key,
    (jsonb_array_elements(dfr.user_assigned_issues::jsonb))->>'project' AS project_key
  FROM date_filtered_records dfr
  JOIN users u ON u.id = dfr.user_id
  WHERE dfr.user_assigned_issues IS NOT NULL
    AND dfr.user_assigned_issues != ''
    AND dfr.user_assigned_issues != 'null'
),

matched_issues AS (
  SELECT DISTINCT
    dfr.user_id,
    dfr.user_assigned_issue_key AS issue_key
  FROM date_filtered_records dfr
  WHERE dfr.user_assigned_issue_key IS NOT NULL
)

SELECT 
  uie.email,
  COUNT(DISTINCT uie.issue_key) AS total_issues,
  COUNT(DISTINCT uie.project_key) AS total_projects,
  STRING_AGG(DISTINCT uie.project_key, ', ' ORDER BY uie.project_key) AS projects,
  COUNT(DISTINCT mi.issue_key) AS matched_issues,
  COUNT(DISTINCT uie.issue_key) FILTER (
    WHERE mi.issue_key IS NULL
  ) AS unassigned_issues,
  ROUND(
    COUNT(DISTINCT mi.issue_key) * 100.0 / COUNT(DISTINCT uie.issue_key), 1
  ) AS pct_matched
FROM user_issues_expanded uie
LEFT JOIN matched_issues mi ON mi.user_id = uie.user_id AND mi.issue_key = uie.issue_key
GROUP BY uie.email
ORDER BY uie.email;
