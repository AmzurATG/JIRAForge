-- ============================================================================
-- BRD Time Tracker — Issue Matching & Description Quality Report
-- Comprehensive Issue Details with Matching Statistics
-- ============================================================================
-- Database: jira_forge_prod (Supabase)
-- Methodology: BRD Time Tracker Analysis Framework
-- 
-- This report provides detailed per-issue analysis including:
-- - Issue details (key, summary, description, description length)
-- - Matching statistics (matched vs unassigned percentages)
-- - Description quality breakdown (good/bad/none)
-- 
-- Description Quality Definitions (based on BRD methodology):
--   - NONE: description IS NULL OR TRIM(description) = ''
--   - BAD:  description length < 30 characters after trimming
--   - GOOD: description length >= 30 characters
-- ============================================================================

-- ============================================================================
-- DATE RANGE CONFIGURATION
-- ============================================================================
-- TO CHANGE DATE RANGE: Find and replace all instances of these dates below:
--   '2026-05-18' (start date - inclusive)
--   '2026-05-26' (end date - exclusive, use day AFTER your last desired day)
--
-- Example: For May 18-25 reporting window:
--   Start: '2026-05-18'
--   End:   '2026-05-26' (NOT '2026-05-25')
-- ============================================================================

-- ============================================================================
-- SECTION 1: ISSUE DETAILS REPORT — ALL USERS WITH MATCHING STATISTICS
-- ============================================================================
-- One row per unique (user, issue) pair seen in the reporting window.
-- Includes both matched and unassigned issues with full statistics.

WITH date_filtered_records AS (
  -- All activity records in the reporting window
  SELECT 
    ar.id,
    ar.user_id,
    ar.organization_id,
    ar.user_assigned_issue_key,
    ar.user_assigned_issues,
    ar.classification,
    ar.status,
    ar.total_time_seconds,
    ar.created_at::DATE AS activity_date
  FROM activity_records ar
  WHERE ar.created_at >= '2026-06-01'::DATE
    AND ar.created_at < '2026-06-08'::DATE
    AND ar.classification = 'productive'
    AND ar.status = 'analyzed'
),

-- Extract all issues from user_assigned_issues JSON for each user
user_issues_expanded AS (
  SELECT DISTINCT
    dfr.user_id,
    dfr.organization_id,
    (jsonb_array_elements(dfr.user_assigned_issues::jsonb))->>'key' AS issue_key,
    (jsonb_array_elements(dfr.user_assigned_issues::jsonb))->>'summary' AS issue_summary,
    (jsonb_array_elements(dfr.user_assigned_issues::jsonb))->>'description' AS issue_description,
    (jsonb_array_elements(dfr.user_assigned_issues::jsonb))->>'status' AS issue_status,
    (jsonb_array_elements(dfr.user_assigned_issues::jsonb))->>'project' AS project_key,
    (jsonb_array_elements(dfr.user_assigned_issues::jsonb))->>'labels' AS labels
  FROM date_filtered_records dfr
  WHERE dfr.user_assigned_issues IS NOT NULL
    AND dfr.user_assigned_issues != ''
    AND dfr.user_assigned_issues != 'null'
),

-- Matching statistics per user
user_matching_stats AS (
  SELECT 
    dfr.user_id,
    COUNT(*) AS total_records,
    COUNT(CASE WHEN dfr.user_assigned_issue_key IS NOT NULL THEN 1 END) AS matched_records,
    COUNT(CASE WHEN dfr.user_assigned_issue_key IS NULL THEN 1 END) AS unassigned_records,
    ROUND(
      COUNT(CASE WHEN dfr.user_assigned_issue_key IS NOT NULL THEN 1 END) * 100.0 
      / NULLIF(COUNT(*), 0), 2
    ) AS pct_matched,
    ROUND(
      COUNT(CASE WHEN dfr.user_assigned_issue_key IS NULL THEN 1 END) * 100.0 
      / NULLIF(COUNT(*), 0), 2
    ) AS pct_unassigned
  FROM date_filtered_records dfr
  GROUP BY dfr.user_id
),

-- Issues that were matched (appeared as user_assigned_issue_key)
matched_issues AS (
  SELECT DISTINCT
    dfr.user_id,
    dfr.user_assigned_issue_key AS issue_key
  FROM date_filtered_records dfr
  WHERE dfr.user_assigned_issue_key IS NOT NULL
),

-- Description quality classification
issue_with_quality AS (
  SELECT 
    uie.user_id,
    uie.organization_id,
    uie.issue_key,
    uie.issue_summary,
    uie.issue_description,
    COALESCE(LENGTH(TRIM(uie.issue_description)), 0) AS description_length,
    uie.issue_status,
    uie.project_key,
    uie.labels,
    CASE 
      WHEN mi.issue_key IS NOT NULL THEN 'MATCHED'
      ELSE 'UNASSIGNED'
    END AS matching_status,
    CASE 
      WHEN uie.issue_description IS NULL OR TRIM(uie.issue_description) = '' THEN 'NONE'
      WHEN LENGTH(TRIM(uie.issue_description)) < 30 THEN 'BAD'
      ELSE 'GOOD'
    END AS description_quality
  FROM user_issues_expanded uie
  LEFT JOIN matched_issues mi 
    ON mi.user_id = uie.user_id 
    AND mi.issue_key = uie.issue_key
),

-- Aggregate description quality by matching status per user
user_quality_stats AS (
  SELECT 
    iwq.user_id,
    -- Overall statistics
    COUNT(*) AS total_issues,
    COUNT(CASE WHEN iwq.matching_status = 'MATCHED' THEN 1 END) AS total_matched_issues,
    COUNT(CASE WHEN iwq.matching_status = 'UNASSIGNED' THEN 1 END) AS total_unassigned_issues,
    
    -- Matched issues by quality
    COUNT(CASE WHEN iwq.matching_status = 'MATCHED' AND iwq.description_quality = 'GOOD' THEN 1 END) AS matched_good_desc,
    COUNT(CASE WHEN iwq.matching_status = 'MATCHED' AND iwq.description_quality = 'BAD' THEN 1 END) AS matched_bad_desc,
    COUNT(CASE WHEN iwq.matching_status = 'MATCHED' AND iwq.description_quality = 'NONE' THEN 1 END) AS matched_none_desc,
    
    -- Unassigned issues by quality
    COUNT(CASE WHEN iwq.matching_status = 'UNASSIGNED' AND iwq.description_quality = 'GOOD' THEN 1 END) AS unassigned_good_desc,
    COUNT(CASE WHEN iwq.matching_status = 'UNASSIGNED' AND iwq.description_quality = 'BAD' THEN 1 END) AS unassigned_bad_desc,
    COUNT(CASE WHEN iwq.matching_status = 'UNASSIGNED' AND iwq.description_quality = 'NONE' THEN 1 END) AS unassigned_none_desc,
    
    -- Percentages for matched issues
    ROUND(
      COUNT(CASE WHEN iwq.matching_status = 'MATCHED' AND iwq.description_quality = 'GOOD' THEN 1 END) * 100.0 
      / NULLIF(COUNT(CASE WHEN iwq.matching_status = 'MATCHED' THEN 1 END), 0), 2
    ) AS pct_matched_good_desc,
    ROUND(
      COUNT(CASE WHEN iwq.matching_status = 'MATCHED' AND iwq.description_quality = 'BAD' THEN 1 END) * 100.0 
      / NULLIF(COUNT(CASE WHEN iwq.matching_status = 'MATCHED' THEN 1 END), 0), 2
    ) AS pct_matched_bad_desc,
    ROUND(
      COUNT(CASE WHEN iwq.matching_status = 'MATCHED' AND iwq.description_quality = 'NONE' THEN 1 END) * 100.0 
      / NULLIF(COUNT(CASE WHEN iwq.matching_status = 'MATCHED' THEN 1 END), 0), 2
    ) AS pct_matched_none_desc,
    
    -- Percentages for unassigned issues
    ROUND(
      COUNT(CASE WHEN iwq.matching_status = 'UNASSIGNED' AND iwq.description_quality = 'GOOD' THEN 1 END) * 100.0 
      / NULLIF(COUNT(CASE WHEN iwq.matching_status = 'UNASSIGNED' THEN 1 END), 0), 2
    ) AS pct_unassigned_good_desc,
    ROUND(
      COUNT(CASE WHEN iwq.matching_status = 'UNASSIGNED' AND iwq.description_quality = 'BAD' THEN 1 END) * 100.0 
      / NULLIF(COUNT(CASE WHEN iwq.matching_status = 'UNASSIGNED' THEN 1 END), 0), 2
    ) AS pct_unassigned_bad_desc,
    ROUND(
      COUNT(CASE WHEN iwq.matching_status = 'UNASSIGNED' AND iwq.description_quality = 'NONE' THEN 1 END) * 100.0 
      / NULLIF(COUNT(CASE WHEN iwq.matching_status = 'UNASSIGNED' THEN 1 END), 0), 2
    ) AS pct_unassigned_none_desc
  FROM issue_with_quality iwq
  GROUP BY iwq.user_id
)

-- Final output: One row per (user, issue) with all statistics
SELECT 
  u.email,
  o.org_name AS organization_name,
  o.jira_cloud_id AS organization_id,
  iwq.issue_key,
  iwq.issue_summary,
  COALESCE(iwq.issue_description, '<<NO DESCRIPTION>>') AS issue_description,
  iwq.description_length,
  iwq.issue_status,
  iwq.project_key,
  iwq.labels,
  iwq.matching_status,
  iwq.description_quality,
  
  -- User-level matching statistics
  ums.total_records AS user_total_activity_records,
  ums.matched_records AS user_matched_records,
  ums.unassigned_records AS user_unassigned_records,
  ums.pct_matched AS user_pct_issues_matched,
  ums.pct_unassigned AS user_pct_issues_unassigned,
  
  -- User-level issue quality statistics
  uqs.total_issues AS user_total_issues,
  uqs.total_matched_issues AS user_total_matched_issues,
  uqs.total_unassigned_issues AS user_total_unassigned_issues,
  
  -- Matched issues quality breakdown
  uqs.pct_matched_good_desc AS user_pct_matched_with_good_desc,
  uqs.pct_matched_bad_desc AS user_pct_matched_with_bad_desc,
  uqs.pct_matched_none_desc AS user_pct_matched_with_none_desc,
  
  -- Unassigned issues quality breakdown
  uqs.pct_unassigned_good_desc AS user_pct_unassigned_with_good_desc,
  uqs.pct_unassigned_bad_desc AS user_pct_unassigned_with_bad_desc,
  uqs.pct_unassigned_none_desc AS user_pct_unassigned_with_none_desc

FROM issue_with_quality iwq
JOIN users u ON u.id = iwq.user_id
JOIN organizations o ON o.id = iwq.organization_id
LEFT JOIN user_matching_stats ums ON ums.user_id = iwq.user_id
LEFT JOIN user_quality_stats uqs ON uqs.user_id = iwq.user_id

ORDER BY 
  u.email,
  iwq.matching_status DESC,  -- MATCHED first, then UNASSIGNED
  iwq.description_quality,   -- GOOD, BAD, NONE
  iwq.issue_key;


-- ============================================================================
-- SECTION 2: USER-LEVEL SUMMARY STATISTICS
-- ============================================================================
-- Aggregated view showing one row per user with all key metrics

WITH date_filtered_records AS (
  SELECT 
    ar.id,
    ar.user_id,
    ar.organization_id,
    ar.user_assigned_issue_key,
    ar.user_assigned_issues,
    ar.classification,
    ar.status,
    ar.total_time_seconds
  FROM activity_records ar
  WHERE ar.created_at >= '2026-05-18'::DATE
    AND ar.created_at < '2026-05-26'::DATE
    AND ar.classification = 'productive'
    AND ar.status = 'analyzed'
),

user_issues_expanded AS (
  SELECT DISTINCT
    dfr.user_id,
    (jsonb_array_elements(dfr.user_assigned_issues::jsonb))->>'key' AS issue_key,
    (jsonb_array_elements(dfr.user_assigned_issues::jsonb))->>'description' AS issue_description
  FROM date_filtered_records dfr
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
),

issue_with_quality AS (
  SELECT 
    uie.user_id,
    uie.issue_key,
    CASE 
      WHEN mi.issue_key IS NOT NULL THEN 'MATCHED'
      ELSE 'UNASSIGNED'
    END AS matching_status,
    CASE 
      WHEN uie.issue_description IS NULL OR TRIM(uie.issue_description) = '' THEN 'NONE'
      WHEN LENGTH(TRIM(uie.issue_description)) < 30 THEN 'BAD'
      ELSE 'GOOD'
    END AS description_quality
  FROM user_issues_expanded uie
  LEFT JOIN matched_issues mi 
    ON mi.user_id = uie.user_id 
    AND mi.issue_key = uie.issue_key
),

user_stats AS (
  SELECT 
    dfr.user_id,
    COUNT(*) AS total_records,
    COUNT(CASE WHEN dfr.user_assigned_issue_key IS NOT NULL THEN 1 END) AS matched_records,
    COUNT(CASE WHEN dfr.user_assigned_issue_key IS NULL THEN 1 END) AS unassigned_records,
    SUM(dfr.total_time_seconds) AS total_time_seconds
  FROM date_filtered_records dfr
  GROUP BY dfr.user_id
)

SELECT 
  u.email,
  o.org_name AS organization_name,
  
  -- Activity record statistics
  us.total_records,
  us.matched_records,
  us.unassigned_records,
  ROUND(us.matched_records * 100.0 / NULLIF(us.total_records, 0), 2) AS pct_records_matched,
  ROUND(us.unassigned_records * 100.0 / NULLIF(us.total_records, 0), 2) AS pct_records_unassigned,
  ROUND(us.total_time_seconds / 3600.0, 2) AS total_hours,
  
  -- Issue-level statistics
  COUNT(DISTINCT iwq.issue_key) AS total_unique_issues,
  COUNT(DISTINCT CASE WHEN iwq.matching_status = 'MATCHED' THEN iwq.issue_key END) AS total_matched_issues,
  COUNT(DISTINCT CASE WHEN iwq.matching_status = 'UNASSIGNED' THEN iwq.issue_key END) AS total_unassigned_issues,
  
  -- Matched issues by quality
  COUNT(DISTINCT CASE WHEN iwq.matching_status = 'MATCHED' AND iwq.description_quality = 'GOOD' THEN iwq.issue_key END) AS matched_issues_good_desc,
  COUNT(DISTINCT CASE WHEN iwq.matching_status = 'MATCHED' AND iwq.description_quality = 'BAD' THEN iwq.issue_key END) AS matched_issues_bad_desc,
  COUNT(DISTINCT CASE WHEN iwq.matching_status = 'MATCHED' AND iwq.description_quality = 'NONE' THEN iwq.issue_key END) AS matched_issues_none_desc,
  
  ROUND(
    COUNT(DISTINCT CASE WHEN iwq.matching_status = 'MATCHED' AND iwq.description_quality = 'GOOD' THEN iwq.issue_key END) * 100.0 
    / NULLIF(COUNT(DISTINCT CASE WHEN iwq.matching_status = 'MATCHED' THEN iwq.issue_key END), 0), 2
  ) AS pct_matched_good_desc,
  ROUND(
    COUNT(DISTINCT CASE WHEN iwq.matching_status = 'MATCHED' AND iwq.description_quality = 'BAD' THEN iwq.issue_key END) * 100.0 
    / NULLIF(COUNT(DISTINCT CASE WHEN iwq.matching_status = 'MATCHED' THEN iwq.issue_key END), 0), 2
  ) AS pct_matched_bad_desc,
  ROUND(
    COUNT(DISTINCT CASE WHEN iwq.matching_status = 'MATCHED' AND iwq.description_quality = 'NONE' THEN iwq.issue_key END) * 100.0 
    / NULLIF(COUNT(DISTINCT CASE WHEN iwq.matching_status = 'MATCHED' THEN iwq.issue_key END), 0), 2
  ) AS pct_matched_none_desc,
  
  -- Unassigned issues by quality
  COUNT(DISTINCT CASE WHEN iwq.matching_status = 'UNASSIGNED' AND iwq.description_quality = 'GOOD' THEN iwq.issue_key END) AS unassigned_issues_good_desc,
  COUNT(DISTINCT CASE WHEN iwq.matching_status = 'UNASSIGNED' AND iwq.description_quality = 'BAD' THEN iwq.issue_key END) AS unassigned_issues_bad_desc,
  COUNT(DISTINCT CASE WHEN iwq.matching_status = 'UNASSIGNED' AND iwq.description_quality = 'NONE' THEN iwq.issue_key END) AS unassigned_issues_none_desc,
  
  ROUND(
    COUNT(DISTINCT CASE WHEN iwq.matching_status = 'UNASSIGNED' AND iwq.description_quality = 'GOOD' THEN iwq.issue_key END) * 100.0 
    / NULLIF(COUNT(DISTINCT CASE WHEN iwq.matching_status = 'UNASSIGNED' THEN iwq.issue_key END), 0), 2
  ) AS pct_unassigned_good_desc,
  ROUND(
    COUNT(DISTINCT CASE WHEN iwq.matching_status = 'UNASSIGNED' AND iwq.description_quality = 'BAD' THEN iwq.issue_key END) * 100.0 
    / NULLIF(COUNT(DISTINCT CASE WHEN iwq.matching_status = 'UNASSIGNED' THEN iwq.issue_key END), 0), 2
  ) AS pct_unassigned_bad_desc,
  ROUND(
    COUNT(DISTINCT CASE WHEN iwq.matching_status = 'UNASSIGNED' AND iwq.description_quality = 'NONE' THEN iwq.issue_key END) * 100.0 
    / NULLIF(COUNT(DISTINCT CASE WHEN iwq.matching_status = 'UNASSIGNED' THEN iwq.issue_key END), 0), 2
  ) AS pct_unassigned_none_desc

FROM user_stats us
JOIN users u ON u.id = us.user_id
JOIN organizations o ON o.id = u.organization_id
LEFT JOIN issue_with_quality iwq ON iwq.user_id = us.user_id

GROUP BY 
  u.email,
  o.org_name,
  us.total_records,
  us.matched_records,
  us.unassigned_records,
  us.total_time_seconds

ORDER BY 
  us.unassigned_records DESC,
  u.email;


-- ============================================================================
-- SECTION 3: ORGANIZATION-LEVEL ROLLUP
-- ============================================================================
-- High-level metrics aggregated across the entire organization

WITH date_filtered_records AS (
  SELECT 
    ar.id,
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

user_issues_expanded AS (
  SELECT DISTINCT
    dfr.organization_id,
    dfr.user_id,
    (jsonb_array_elements(dfr.user_assigned_issues::jsonb))->>'key' AS issue_key,
    (jsonb_array_elements(dfr.user_assigned_issues::jsonb))->>'description' AS issue_description
  FROM date_filtered_records dfr
  WHERE dfr.user_assigned_issues IS NOT NULL
    AND dfr.user_assigned_issues != ''
    AND dfr.user_assigned_issues != 'null'
),

matched_issues AS (
  SELECT DISTINCT
    dfr.organization_id,
    dfr.user_id,
    dfr.user_assigned_issue_key AS issue_key
  FROM date_filtered_records dfr
  WHERE dfr.user_assigned_issue_key IS NOT NULL
),

issue_with_quality AS (
  SELECT 
    uie.organization_id,
    uie.user_id,
    uie.issue_key,
    CASE 
      WHEN mi.issue_key IS NOT NULL THEN 'MATCHED'
      ELSE 'UNASSIGNED'
    END AS matching_status,
    CASE 
      WHEN uie.issue_description IS NULL OR TRIM(uie.issue_description) = '' THEN 'NONE'
      WHEN LENGTH(TRIM(uie.issue_description)) < 30 THEN 'BAD'
      ELSE 'GOOD'
    END AS description_quality
  FROM user_issues_expanded uie
  LEFT JOIN matched_issues mi 
    ON mi.organization_id = uie.organization_id
    AND mi.user_id = uie.user_id 
    AND mi.issue_key = uie.issue_key
)

SELECT 
  o.org_name AS organization_name,
  o.jira_cloud_id AS organization_id,
  
  -- Date range
  '2026-05-18' AS report_start_date,
  '2026-05-25' AS report_end_date,
  
  -- Activity records
  COUNT(DISTINCT dfr.user_id) AS total_users,
  COUNT(dfr.id) AS total_records,
  COUNT(CASE WHEN dfr.user_assigned_issue_key IS NOT NULL THEN 1 END) AS total_matched_records,
  COUNT(CASE WHEN dfr.user_assigned_issue_key IS NULL THEN 1 END) AS total_unassigned_records,
  ROUND(
    COUNT(CASE WHEN dfr.user_assigned_issue_key IS NOT NULL THEN 1 END) * 100.0 
    / NULLIF(COUNT(dfr.id), 0), 2
  ) AS pct_records_matched,
  ROUND(
    COUNT(CASE WHEN dfr.user_assigned_issue_key IS NULL THEN 1 END) * 100.0 
    / NULLIF(COUNT(dfr.id), 0), 2
  ) AS pct_records_unassigned,
  ROUND(SUM(dfr.total_time_seconds) / 3600.0, 2) AS total_hours,
  
  -- Unique issues
  COUNT(DISTINCT iwq.issue_key) AS total_unique_issues,
  COUNT(DISTINCT CASE WHEN iwq.matching_status = 'MATCHED' THEN iwq.issue_key END) AS total_matched_issues,
  COUNT(DISTINCT CASE WHEN iwq.matching_status = 'UNASSIGNED' THEN iwq.issue_key END) AS total_unassigned_issues,
  
  -- Matched issues quality
  COUNT(DISTINCT CASE WHEN iwq.matching_status = 'MATCHED' AND iwq.description_quality = 'GOOD' THEN iwq.issue_key END) AS matched_issues_good_desc,
  COUNT(DISTINCT CASE WHEN iwq.matching_status = 'MATCHED' AND iwq.description_quality = 'BAD' THEN iwq.issue_key END) AS matched_issues_bad_desc,
  COUNT(DISTINCT CASE WHEN iwq.matching_status = 'MATCHED' AND iwq.description_quality = 'NONE' THEN iwq.issue_key END) AS matched_issues_none_desc,
  
  ROUND(
    COUNT(DISTINCT CASE WHEN iwq.matching_status = 'MATCHED' AND iwq.description_quality = 'GOOD' THEN iwq.issue_key END) * 100.0 
    / NULLIF(COUNT(DISTINCT CASE WHEN iwq.matching_status = 'MATCHED' THEN iwq.issue_key END), 0), 2
  ) AS pct_matched_good_desc,
  
  -- Unassigned issues quality
  COUNT(DISTINCT CASE WHEN iwq.matching_status = 'UNASSIGNED' AND iwq.description_quality = 'GOOD' THEN iwq.issue_key END) AS unassigned_issues_good_desc,
  COUNT(DISTINCT CASE WHEN iwq.matching_status = 'UNASSIGNED' AND iwq.description_quality = 'BAD' THEN iwq.issue_key END) AS unassigned_issues_bad_desc,
  COUNT(DISTINCT CASE WHEN iwq.matching_status = 'UNASSIGNED' AND iwq.description_quality = 'NONE' THEN iwq.issue_key END) AS unassigned_issues_none_desc,
  
  ROUND(
    COUNT(DISTINCT CASE WHEN iwq.matching_status = 'UNASSIGNED' AND iwq.description_quality = 'GOOD' THEN iwq.issue_key END) * 100.0 
    / NULLIF(COUNT(DISTINCT CASE WHEN iwq.matching_status = 'UNASSIGNED' THEN iwq.issue_key END), 0), 2
  ) AS pct_unassigned_good_desc,
  ROUND(
    COUNT(DISTINCT CASE WHEN iwq.matching_status = 'UNASSIGNED' AND iwq.description_quality = 'BAD' THEN iwq.issue_key END) * 100.0 
    / NULLIF(COUNT(DISTINCT CASE WHEN iwq.matching_status = 'UNASSIGNED' THEN iwq.issue_key END), 0), 2
  ) AS pct_unassigned_bad_desc,
  ROUND(
    COUNT(DISTINCT CASE WHEN iwq.matching_status = 'UNASSIGNED' AND iwq.description_quality = 'NONE' THEN iwq.issue_key END) * 100.0 
    / NULLIF(COUNT(DISTINCT CASE WHEN iwq.matching_status = 'UNASSIGNED' THEN iwq.issue_key END), 0), 2
  ) AS pct_unassigned_none_desc

FROM date_filtered_records dfr
JOIN organizations o ON o.id = dfr.organization_id
LEFT JOIN issue_with_quality iwq ON iwq.organization_id = dfr.organization_id

GROUP BY 
  o.org_name,
  o.jira_cloud_id;


-- ============================================================================
-- SECTION 4: DETAILED ISSUE LIST — UNASSIGNED ISSUES WITH BAD/NONE DESCRIPTIONS
-- ============================================================================
-- Shows which specific issues are likely causing matching failures

WITH date_filtered_records AS (
  SELECT DISTINCT
    ar.user_id,
    ar.user_assigned_issues
  FROM activity_records ar
  WHERE ar.created_at >= '2026-05-18'::DATE
    AND ar.created_at < '2026-05-26'::DATE
    AND ar.classification = 'productive'
    AND ar.status = 'analyzed'
    AND ar.user_assigned_issue_key IS NULL  -- Only unassigned records
),

user_issues_expanded AS (
  SELECT DISTINCT
    dfr.user_id,
    (jsonb_array_elements(dfr.user_assigned_issues::jsonb))->>'key' AS issue_key,
    (jsonb_array_elements(dfr.user_assigned_issues::jsonb))->>'summary' AS issue_summary,
    (jsonb_array_elements(dfr.user_assigned_issues::jsonb))->>'description' AS issue_description,
    (jsonb_array_elements(dfr.user_assigned_issues::jsonb))->>'status' AS issue_status,
    (jsonb_array_elements(dfr.user_assigned_issues::jsonb))->>'project' AS project_key
  FROM date_filtered_records dfr
  WHERE dfr.user_assigned_issues IS NOT NULL
    AND dfr.user_assigned_issues != ''
    AND dfr.user_assigned_issues != 'null'
)

SELECT 
  u.email,
  uie.issue_key,
  uie.issue_summary,
  uie.issue_status,
  uie.project_key,
  COALESCE(uie.issue_description, '<<NO DESCRIPTION>>') AS issue_description,
  COALESCE(LENGTH(TRIM(uie.issue_description)), 0) AS description_length,
  CASE 
    WHEN uie.issue_description IS NULL THEN 'NONE'
    WHEN TRIM(uie.issue_description) = '' THEN 'NONE'
    WHEN LENGTH(TRIM(uie.issue_description)) < 30 THEN 'BAD'
    ELSE 'GOOD'
  END AS description_quality,
  CASE 
    WHEN uie.issue_description IS NULL THEN 'No description provided'
    WHEN TRIM(uie.issue_description) = '' THEN 'Empty description'
    WHEN LENGTH(TRIM(uie.issue_description)) < 30 THEN 'Description too short (< 30 chars)'
    ELSE 'Description meets quality threshold'
  END AS quality_issue

FROM user_issues_expanded uie
JOIN users u ON u.id = uie.user_id

WHERE 
  uie.issue_description IS NULL 
  OR TRIM(uie.issue_description) = '' 
  OR LENGTH(TRIM(uie.issue_description)) < 30

ORDER BY 
  u.email,
  CASE 
    WHEN uie.issue_description IS NULL THEN 1
    WHEN TRIM(uie.issue_description) = '' THEN 1
    ELSE 2
  END,
  uie.issue_key;


-- ============================================================================
-- EXECUTION NOTES
-- ============================================================================
-- 
-- 1. To run this report:
--    - Update the START_DATE and END_DATE variables at the top
--    - Run each section separately or as a complete script
--    - Export results to CSV for further analysis
--
-- 2. Performance considerations:
--    - The queries use CTEs for readability but may benefit from materialization
--    - Consider adding indexes on activity_records.created_at if not present
--    - For large date ranges, run queries during off-peak hours
--
-- 3. Data assumptions:
--    - Only analyzes records with classification = 'productive'
--    - Only includes records with status = 'analyzed'
--    - Issue data comes from user_assigned_issues JSON field
--    - Description quality uses 30-character threshold per BRD methodology
--
-- 4. Output sections:
--    - Section 1: Detailed per-issue report with all statistics
--    - Section 2: User-level summary (one row per user)
--    - Section 3: Organization-level rollup (single summary row)
--    - Section 4: Problem issues list (unassigned with bad/no descriptions)
--
-- ============================================================================
