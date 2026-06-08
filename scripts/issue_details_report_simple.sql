-- ============================================================================
-- BRD Time Tracker — Issue Details Report (Simplified Version)
-- ============================================================================
-- This version uses inline date literals for easy execution in Supabase dashboard
-- 
-- TO USE: Simply replace the dates in the WHERE clauses below with your desired range
-- ============================================================================

-- ============================================================================
-- QUICK SUMMARY — Key Metrics at a Glance
-- ============================================================================

WITH date_filtered AS (
  SELECT 
    ar.user_id,
    ar.organization_id,
    ar.user_assigned_issue_key,
    ar.user_assigned_issues,
    ar.total_time_seconds
  FROM activity_records ar
  WHERE ar.created_at >= '2026-05-18'::DATE
    AND ar.created_at < '2026-05-26'::DATE  -- Exclusive end date
    AND ar.classification = 'productive'
    AND ar.status = 'analyzed'
),

issues_expanded AS (
  SELECT DISTINCT
    df.user_id,
    (jsonb_array_elements(df.user_assigned_issues::jsonb))->>'key' AS issue_key,
    (jsonb_array_elements(df.user_assigned_issues::jsonb))->>'description' AS description
  FROM date_filtered df
  WHERE df.user_assigned_issues IS NOT NULL
    AND df.user_assigned_issues != ''
    AND df.user_assigned_issues != 'null'
),

matched AS (
  SELECT DISTINCT user_id, user_assigned_issue_key AS issue_key
  FROM date_filtered
  WHERE user_assigned_issue_key IS NOT NULL
)

SELECT 
  'Total Activity Records' AS metric,
  COUNT(*)::TEXT AS value
FROM date_filtered

UNION ALL

SELECT 
  'Matched Records',
  COUNT(CASE WHEN user_assigned_issue_key IS NOT NULL THEN 1 END)::TEXT
FROM date_filtered

UNION ALL

SELECT 
  'Unassigned Records',
  COUNT(CASE WHEN user_assigned_issue_key IS NULL THEN 1 END)::TEXT
FROM date_filtered

UNION ALL

SELECT 
  '% Records Matched',
  ROUND(
    COUNT(CASE WHEN user_assigned_issue_key IS NOT NULL THEN 1 END) * 100.0 / COUNT(*), 2
  )::TEXT || '%'
FROM date_filtered

UNION ALL

SELECT 
  'Total Unique Issues',
  COUNT(DISTINCT issue_key)::TEXT
FROM issues_expanded

UNION ALL

SELECT 
  'Matched Issues',
  COUNT(DISTINCT m.issue_key)::TEXT
FROM matched m

UNION ALL

SELECT 
  'Unassigned Issues',
  COUNT(DISTINCT ie.issue_key)::TEXT
FROM issues_expanded ie
LEFT JOIN matched m ON m.user_id = ie.user_id AND m.issue_key = ie.issue_key
WHERE m.issue_key IS NULL

UNION ALL

SELECT 
  'Total Users',
  COUNT(DISTINCT user_id)::TEXT
FROM date_filtered;


-- ============================================================================
-- MAIN REPORT — Issue Details with All Statistics
-- ============================================================================

WITH date_filtered AS (
  SELECT 
    ar.user_id,
    ar.organization_id,
    ar.user_assigned_issue_key,
    ar.user_assigned_issues,
    ar.total_time_seconds
  FROM activity_records ar
  WHERE ar.created_at >= '2026-05-18'::DATE
    AND ar.created_at < '2026-05-26'::DATE
    AND ar.classification = 'productive'
    AND ar.status = 'analyzed'
),

issues_expanded AS (
  SELECT DISTINCT
    df.user_id,
    df.organization_id,
    (jsonb_array_elements(df.user_assigned_issues::jsonb))->>'key' AS issue_key,
    (jsonb_array_elements(df.user_assigned_issues::jsonb))->>'summary' AS issue_summary,
    (jsonb_array_elements(df.user_assigned_issues::jsonb))->>'description' AS issue_description,
    (jsonb_array_elements(df.user_assigned_issues::jsonb))->>'status' AS issue_status,
    (jsonb_array_elements(df.user_assigned_issues::jsonb))->>'project' AS project_key
  FROM date_filtered df
  WHERE df.user_assigned_issues IS NOT NULL
    AND df.user_assigned_issues != ''
    AND df.user_assigned_issues != 'null'
),

matched_issues AS (
  SELECT DISTINCT user_id, user_assigned_issue_key AS issue_key
  FROM date_filtered
  WHERE user_assigned_issue_key IS NOT NULL
),

-- User-level stats
user_stats AS (
  SELECT 
    user_id,
    COUNT(*) AS total_records,
    COUNT(CASE WHEN user_assigned_issue_key IS NOT NULL THEN 1 END) AS matched_records,
    COUNT(CASE WHEN user_assigned_issue_key IS NULL THEN 1 END) AS unassigned_records
  FROM date_filtered
  GROUP BY user_id
),

-- Issue with matching status and quality
issue_details AS (
  SELECT 
    ie.user_id,
    ie.organization_id,
    ie.issue_key,
    ie.issue_summary,
    ie.issue_description,
    ie.issue_status,
    ie.project_key,
    CASE WHEN mi.issue_key IS NOT NULL THEN 'MATCHED' ELSE 'UNASSIGNED' END AS matching_status,
    CASE 
      WHEN ie.issue_description IS NULL OR TRIM(ie.issue_description) = '' THEN 'NONE'
      WHEN LENGTH(TRIM(ie.issue_description)) < 30 THEN 'BAD'
      ELSE 'GOOD'
    END AS description_quality,
    COALESCE(LENGTH(TRIM(ie.issue_description)), 0) AS description_length
  FROM issues_expanded ie
  LEFT JOIN matched_issues mi ON mi.user_id = ie.user_id AND mi.issue_key = ie.issue_key
),

-- Per-user quality breakdown
user_quality_stats AS (
  SELECT 
    user_id,
    COUNT(*) FILTER (WHERE matching_status = 'MATCHED') AS matched_issues,
    COUNT(*) FILTER (WHERE matching_status = 'UNASSIGNED') AS unassigned_issues,
    COUNT(*) FILTER (WHERE matching_status = 'MATCHED' AND description_quality = 'GOOD') AS matched_good,
    COUNT(*) FILTER (WHERE matching_status = 'MATCHED' AND description_quality = 'BAD') AS matched_bad,
    COUNT(*) FILTER (WHERE matching_status = 'MATCHED' AND description_quality = 'NONE') AS matched_none,
    COUNT(*) FILTER (WHERE matching_status = 'UNASSIGNED' AND description_quality = 'GOOD') AS unassigned_good,
    COUNT(*) FILTER (WHERE matching_status = 'UNASSIGNED' AND description_quality = 'BAD') AS unassigned_bad,
    COUNT(*) FILTER (WHERE matching_status = 'UNASSIGNED' AND description_quality = 'NONE') AS unassigned_none
  FROM issue_details
  GROUP BY user_id
)

SELECT 
  u.email,
  o.org_name AS organization,
  id.issue_key,
  id.issue_summary,
  LEFT(COALESCE(id.issue_description, '<<NO DESCRIPTION>>'), 200) AS description_preview,
  id.description_length,
  id.issue_status,
  id.project_key,
  id.matching_status,
  id.description_quality,
  
  -- User-level activity statistics
  us.total_records AS user_total_activity_records,
  us.matched_records AS user_matched_activity_records,
  us.unassigned_records AS user_unassigned_activity_records,
  ROUND(us.matched_records * 100.0 / NULLIF(us.total_records, 0), 2) AS user_pct_records_matched,
  ROUND(us.unassigned_records * 100.0 / NULLIF(us.total_records, 0), 2) AS user_pct_records_unassigned,
  
  -- User-level issue statistics
  uqs.matched_issues + uqs.unassigned_issues AS user_total_issues,
  uqs.matched_issues AS user_matched_issues,
  uqs.unassigned_issues AS user_unassigned_issues,
  
  -- Matched issue quality percentages
  ROUND(uqs.matched_good * 100.0 / NULLIF(uqs.matched_issues, 0), 2) AS user_pct_matched_good_desc,
  ROUND(uqs.matched_bad * 100.0 / NULLIF(uqs.matched_issues, 0), 2) AS user_pct_matched_bad_desc,
  ROUND(uqs.matched_none * 100.0 / NULLIF(uqs.matched_issues, 0), 2) AS user_pct_matched_none_desc,
  
  -- Unassigned issue quality percentages
  ROUND(uqs.unassigned_good * 100.0 / NULLIF(uqs.unassigned_issues, 0), 2) AS user_pct_unassigned_good_desc,
  ROUND(uqs.unassigned_bad * 100.0 / NULLIF(uqs.unassigned_issues, 0), 2) AS user_pct_unassigned_bad_desc,
  ROUND(uqs.unassigned_none * 100.0 / NULLIF(uqs.unassigned_issues, 0), 2) AS user_pct_unassigned_none_desc

FROM issue_details id
JOIN users u ON u.id = id.user_id
JOIN organizations o ON o.id = id.organization_id
LEFT JOIN user_stats us ON us.user_id = id.user_id
LEFT JOIN user_quality_stats uqs ON uqs.user_id = id.user_id

ORDER BY 
  u.email,
  id.matching_status DESC,
  id.description_quality,
  id.issue_key;


-- ============================================================================
-- USER SUMMARY — One Row Per User
-- ============================================================================

WITH date_filtered AS (
  SELECT 
    ar.user_id,
    ar.organization_id,
    ar.user_assigned_issue_key,
    ar.user_assigned_issues,
    ar.total_time_seconds
  FROM activity_records ar
  WHERE ar.created_at >= '2026-05-18'::DATE
    AND ar.created_at < '2026-05-26'::DATE
    AND ar.classification = 'productive'
    AND ar.status = 'analyzed'
),

issues_expanded AS (
  SELECT DISTINCT
    df.user_id,
    (jsonb_array_elements(df.user_assigned_issues::jsonb))->>'key' AS issue_key,
    (jsonb_array_elements(df.user_assigned_issues::jsonb))->>'description' AS issue_description
  FROM date_filtered df
  WHERE df.user_assigned_issues IS NOT NULL
    AND df.user_assigned_issues != ''
    AND df.user_assigned_issues != 'null'
),

matched_issues AS (
  SELECT DISTINCT user_id, user_assigned_issue_key AS issue_key
  FROM date_filtered
  WHERE user_assigned_issue_key IS NOT NULL
),

issue_quality AS (
  SELECT 
    ie.user_id,
    ie.issue_key,
    CASE WHEN mi.issue_key IS NOT NULL THEN 'MATCHED' ELSE 'UNASSIGNED' END AS status,
    CASE 
      WHEN ie.issue_description IS NULL OR TRIM(ie.issue_description) = '' THEN 'NONE'
      WHEN LENGTH(TRIM(ie.issue_description)) < 30 THEN 'BAD'
      ELSE 'GOOD'
    END AS quality
  FROM issues_expanded ie
  LEFT JOIN matched_issues mi ON mi.user_id = ie.user_id AND mi.issue_key = ie.issue_key
)

SELECT 
  u.email,
  o.org_name AS organization,
  
  -- Activity records
  COUNT(DISTINCT df.user_assigned_issue_key) FILTER (WHERE df.user_assigned_issue_key IS NOT NULL) AS total_matched_records,
  COUNT(*) FILTER (WHERE df.user_assigned_issue_key IS NULL) AS total_unassigned_records,
  COUNT(*) AS total_activity_records,
  ROUND(COUNT(DISTINCT df.user_assigned_issue_key) FILTER (WHERE df.user_assigned_issue_key IS NOT NULL) * 100.0 / COUNT(*), 2) AS pct_records_matched,
  ROUND(SUM(df.total_time_seconds) / 3600.0, 2) AS total_hours,
  
  -- Issues
  COUNT(DISTINCT iq.issue_key) AS total_issues,
  COUNT(DISTINCT iq.issue_key) FILTER (WHERE iq.status = 'MATCHED') AS matched_issues,
  COUNT(DISTINCT iq.issue_key) FILTER (WHERE iq.status = 'UNASSIGNED') AS unassigned_issues,
  
  -- Matched quality
  COUNT(DISTINCT iq.issue_key) FILTER (WHERE iq.status = 'MATCHED' AND iq.quality = 'GOOD') AS matched_good,
  COUNT(DISTINCT iq.issue_key) FILTER (WHERE iq.status = 'MATCHED' AND iq.quality = 'BAD') AS matched_bad,
  COUNT(DISTINCT iq.issue_key) FILTER (WHERE iq.status = 'MATCHED' AND iq.quality = 'NONE') AS matched_none,
  ROUND(COUNT(DISTINCT iq.issue_key) FILTER (WHERE iq.status = 'MATCHED' AND iq.quality = 'GOOD') * 100.0 / 
        NULLIF(COUNT(DISTINCT iq.issue_key) FILTER (WHERE iq.status = 'MATCHED'), 0), 2) AS pct_matched_good,
  
  -- Unassigned quality
  COUNT(DISTINCT iq.issue_key) FILTER (WHERE iq.status = 'UNASSIGNED' AND iq.quality = 'GOOD') AS unassigned_good,
  COUNT(DISTINCT iq.issue_key) FILTER (WHERE iq.status = 'UNASSIGNED' AND iq.quality = 'BAD') AS unassigned_bad,
  COUNT(DISTINCT iq.issue_key) FILTER (WHERE iq.status = 'UNASSIGNED' AND iq.quality = 'NONE') AS unassigned_none,
  ROUND(COUNT(DISTINCT iq.issue_key) FILTER (WHERE iq.status = 'UNASSIGNED' AND iq.quality = 'GOOD') * 100.0 / 
        NULLIF(COUNT(DISTINCT iq.issue_key) FILTER (WHERE iq.status = 'UNASSIGNED'), 0), 2) AS pct_unassigned_good

FROM date_filtered df
JOIN users u ON u.id = df.user_id
JOIN organizations o ON o.id = df.organization_id
LEFT JOIN issue_quality iq ON iq.user_id = df.user_id

GROUP BY u.email, o.org_name
ORDER BY total_unassigned_records DESC, u.email;


-- ============================================================================
-- PROBLEM ISSUES — Unassigned with Bad/No Descriptions
-- ============================================================================

WITH date_filtered AS (
  SELECT DISTINCT
    ar.user_id,
    ar.user_assigned_issues
  FROM activity_records ar
  WHERE ar.created_at >= '2026-05-18'::DATE
    AND ar.created_at < '2026-05-26'::DATE
    AND ar.classification = 'productive'
    AND ar.status = 'analyzed'
    AND ar.user_assigned_issue_key IS NULL  -- Only unassigned
),

issues_expanded AS (
  SELECT DISTINCT
    df.user_id,
    (jsonb_array_elements(df.user_assigned_issues::jsonb))->>'key' AS issue_key,
    (jsonb_array_elements(df.user_assigned_issues::jsonb))->>'summary' AS issue_summary,
    (jsonb_array_elements(df.user_assigned_issues::jsonb))->>'description' AS issue_description,
    (jsonb_array_elements(df.user_assigned_issues::jsonb))->>'status' AS issue_status
  FROM date_filtered df
  WHERE df.user_assigned_issues IS NOT NULL
    AND df.user_assigned_issues != ''
    AND df.user_assigned_issues != 'null'
)

SELECT 
  u.email,
  ie.issue_key,
  ie.issue_summary,
  ie.issue_status,
  COALESCE(LEFT(ie.issue_description, 200), '<<NO DESCRIPTION>>') AS description_preview,
  COALESCE(LENGTH(TRIM(ie.issue_description)), 0) AS description_length,
  CASE 
    WHEN ie.issue_description IS NULL OR TRIM(ie.issue_description) = '' THEN 'NONE'
    WHEN LENGTH(TRIM(ie.issue_description)) < 30 THEN 'BAD'
    ELSE 'GOOD'
  END AS quality,
  CASE 
    WHEN ie.issue_description IS NULL OR TRIM(ie.issue_description) = '' THEN 'No description'
    ELSE 'Description too short (< 30 chars)'
  END AS problem

FROM issues_expanded ie
JOIN users u ON u.id = ie.user_id

WHERE 
  ie.issue_description IS NULL 
  OR TRIM(ie.issue_description) = '' 
  OR LENGTH(TRIM(ie.issue_description)) < 30

ORDER BY u.email, ie.issue_key;
