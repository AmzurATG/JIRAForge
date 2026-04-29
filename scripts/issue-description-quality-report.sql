-- ============================================================================
-- Issue Matching vs Description Quality Report
-- Database: jira_forge_prod (Supabase)
-- 
-- This report answers:
-- 1. What % of activity records went to unassigned?
-- 2. Of unassigned records — what % had issues with bad/no description?
-- 3. Of matched records — what % had good vs bad/no description?
-- 4. Shows actual descriptions for each category.
--
-- "Bad description" = description is NULL, empty, or under 20 characters.
-- "Good description" = description is 20+ characters with meaningful content.
-- ============================================================================

-- ============================================================================
-- SECTION 1: Overall Matching Summary Per User
-- Shows: total records, matched %, unassigned %
-- ============================================================================

SELECT 
  u.email,
  COUNT(*) AS total_records,
  COUNT(CASE WHEN ar.user_assigned_issue_key IS NOT NULL THEN 1 END) AS matched_count,
  COUNT(CASE WHEN ar.user_assigned_issue_key IS NULL THEN 1 END) AS unassigned_count,
  ROUND(
    COUNT(CASE WHEN ar.user_assigned_issue_key IS NOT NULL THEN 1 END) * 100.0 
    / NULLIF(COUNT(*), 0), 1
  ) AS matched_pct,
  ROUND(
    COUNT(CASE WHEN ar.user_assigned_issue_key IS NULL THEN 1 END) * 100.0 
    / NULLIF(COUNT(*), 0), 1
  ) AS unassigned_pct
FROM activity_records ar
JOIN users u ON u.id = ar.user_id
WHERE ar.classification = 'productive'
  AND ar.status = 'analyzed'
GROUP BY u.email
ORDER BY unassigned_pct DESC;


-- ============================================================================
-- SECTION 2: Description Quality of User's Cached Issues (Overall)
-- Shows: per user, how many of their Jira issues have good vs bad descriptions
-- ============================================================================

SELECT 
  u.email,
  COUNT(*) AS total_cached_issues,
  COUNT(CASE 
    WHEN ic.description IS NOT NULL 
      AND TRIM(ic.description) != '' 
      AND LENGTH(TRIM(ic.description)) >= 20 
    THEN 1 
  END) AS good_description_count,
  COUNT(CASE 
    WHEN ic.description IS NULL 
      OR TRIM(ic.description) = '' 
      OR LENGTH(TRIM(ic.description)) < 20 
    THEN 1 
  END) AS bad_or_no_description_count,
  ROUND(
    COUNT(CASE 
      WHEN ic.description IS NOT NULL 
        AND TRIM(ic.description) != '' 
        AND LENGTH(TRIM(ic.description)) >= 20 
      THEN 1 
    END) * 100.0 / NULLIF(COUNT(*), 0), 1
  ) AS good_description_pct,
  ROUND(
    COUNT(CASE 
      WHEN ic.description IS NULL 
        OR TRIM(ic.description) = '' 
        OR LENGTH(TRIM(ic.description)) < 20 
      THEN 1 
    END) * 100.0 / NULLIF(COUNT(*), 0), 1
  ) AS bad_or_no_description_pct
FROM user_jira_issues_cache ic
JOIN users u ON u.id = ic.user_id
GROUP BY u.email
ORDER BY bad_or_no_description_pct DESC;


-- ============================================================================
-- SECTION 3: Unassigned Records — Description Quality of the User's Issues
-- For each user: of the activity records that went UNASSIGNED, what % of that
-- user's cached issues have bad/no descriptions (correlation analysis).
-- ============================================================================

WITH user_unassigned AS (
  SELECT 
    ar.user_id,
    u.email,
    COUNT(*) AS unassigned_records,
    ROUND(SUM(ar.total_time_seconds) / 3600.0, 2) AS unassigned_hours
  FROM activity_records ar
  JOIN users u ON u.id = ar.user_id
  WHERE ar.user_assigned_issue_key IS NULL
    AND ar.classification = 'productive'
    AND ar.status = 'analyzed'
  GROUP BY ar.user_id, u.email
),
user_issue_quality AS (
  SELECT 
    ic.user_id,
    COUNT(*) AS total_issues,
    COUNT(CASE 
      WHEN ic.description IS NULL 
        OR TRIM(ic.description) = '' 
        OR LENGTH(TRIM(ic.description)) < 20 
      THEN 1 
    END) AS bad_description_issues,
    ROUND(
      COUNT(CASE 
        WHEN ic.description IS NULL 
          OR TRIM(ic.description) = '' 
          OR LENGTH(TRIM(ic.description)) < 20 
        THEN 1 
      END) * 100.0 / NULLIF(COUNT(*), 0), 1
    ) AS bad_description_pct
  FROM user_jira_issues_cache ic
  GROUP BY ic.user_id
)
SELECT 
  ua.email,
  ua.unassigned_records,
  ua.unassigned_hours,
  uiq.total_issues,
  uiq.bad_description_issues,
  uiq.bad_description_pct AS issues_with_bad_description_pct
FROM user_unassigned ua
JOIN user_issue_quality uiq ON uiq.user_id = ua.user_id
ORDER BY ua.unassigned_records DESC;


-- ============================================================================
-- SECTION 4: Matched Records — Description Quality Breakdown
-- For records that WERE matched, join back to the issue cache and check
-- whether the matched issue had a good or bad description.
-- ============================================================================

SELECT 
  u.email,
  COUNT(*) AS matched_records,
  COUNT(CASE 
    WHEN ic.description IS NOT NULL 
      AND TRIM(ic.description) != '' 
      AND LENGTH(TRIM(ic.description)) >= 20 
    THEN 1 
  END) AS matched_with_good_desc,
  COUNT(CASE 
    WHEN ic.description IS NULL 
      OR TRIM(ic.description) = '' 
      OR LENGTH(TRIM(ic.description)) < 20 
    THEN 1 
  END) AS matched_with_bad_desc,
  ROUND(
    COUNT(CASE 
      WHEN ic.description IS NOT NULL 
        AND TRIM(ic.description) != '' 
        AND LENGTH(TRIM(ic.description)) >= 20 
      THEN 1 
    END) * 100.0 / NULLIF(COUNT(*), 0), 1
  ) AS good_desc_pct,
  ROUND(
    COUNT(CASE 
      WHEN ic.description IS NULL 
        OR TRIM(ic.description) = '' 
        OR LENGTH(TRIM(ic.description)) < 20 
      THEN 1 
    END) * 100.0 / NULLIF(COUNT(*), 0), 1
  ) AS bad_desc_pct
FROM activity_records ar
JOIN users u ON u.id = ar.user_id
LEFT JOIN user_jira_issues_cache ic 
  ON ic.user_id = ar.user_id 
  AND ic.issue_key = ar.user_assigned_issue_key
WHERE ar.user_assigned_issue_key IS NOT NULL
  AND ar.classification = 'productive'
  AND ar.status = 'analyzed'
GROUP BY u.email
ORDER BY bad_desc_pct DESC;


-- ============================================================================
-- SECTION 5: Matched Issues — Detail with Descriptions (Good Description)
-- Shows the actual description for each matched issue that had a good description
-- ============================================================================

SELECT DISTINCT
  u.email,
  ar.user_assigned_issue_key AS issue_key,
  ic.issue_summary,
  ic.status AS issue_status,
  LEFT(ic.description, 300) AS description_preview,
  LENGTH(ic.description) AS description_length,
  'GOOD' AS description_quality
FROM activity_records ar
JOIN users u ON u.id = ar.user_id
JOIN user_jira_issues_cache ic 
  ON ic.user_id = ar.user_id 
  AND ic.issue_key = ar.user_assigned_issue_key
WHERE ar.user_assigned_issue_key IS NOT NULL
  AND ar.classification = 'productive'
  AND ar.status = 'analyzed'
  AND ic.description IS NOT NULL
  AND TRIM(ic.description) != ''
  AND LENGTH(TRIM(ic.description)) >= 20
ORDER BY u.email, ar.user_assigned_issue_key;


-- ============================================================================
-- SECTION 6: Matched Issues — Detail with Descriptions (Bad/No Description)
-- Shows the actual description (or lack thereof) for matched issues with bad descriptions
-- ============================================================================

SELECT DISTINCT
  u.email,
  ar.user_assigned_issue_key AS issue_key,
  ic.issue_summary,
  ic.status AS issue_status,
  COALESCE(LEFT(ic.description, 300), '<<NO DESCRIPTION>>') AS description_preview,
  COALESCE(LENGTH(ic.description), 0) AS description_length,
  CASE 
    WHEN ic.description IS NULL THEN 'NO DESCRIPTION'
    WHEN TRIM(ic.description) = '' THEN 'EMPTY DESCRIPTION'
    ELSE 'TOO SHORT (< 20 chars)'
  END AS description_quality
FROM activity_records ar
JOIN users u ON u.id = ar.user_id
LEFT JOIN user_jira_issues_cache ic 
  ON ic.user_id = ar.user_id 
  AND ic.issue_key = ar.user_assigned_issue_key
WHERE ar.user_assigned_issue_key IS NOT NULL
  AND ar.classification = 'productive'
  AND ar.status = 'analyzed'
  AND (
    ic.description IS NULL 
    OR TRIM(ic.description) = '' 
    OR LENGTH(TRIM(ic.description)) < 20
  )
ORDER BY u.email, ar.user_assigned_issue_key;


-- ============================================================================
-- SECTION 7: Unassigned Records — User's Issues with Bad Descriptions (Detail)
-- For users with unassigned records, shows the issues that have bad descriptions
-- (these are likely contributing to unmatched records)
-- ============================================================================

SELECT 
  u.email,
  ic.issue_key,
  ic.issue_summary,
  ic.status AS issue_status,
  COALESCE(LEFT(ic.description, 300), '<<NO DESCRIPTION>>') AS description_preview,
  COALESCE(LENGTH(ic.description), 0) AS description_length,
  CASE 
    WHEN ic.description IS NULL THEN 'NO DESCRIPTION'
    WHEN TRIM(ic.description) = '' THEN 'EMPTY DESCRIPTION'
    ELSE 'TOO SHORT (< 20 chars)'
  END AS description_quality
FROM user_jira_issues_cache ic
JOIN users u ON u.id = ic.user_id
WHERE ic.user_id IN (
  -- Users who have unassigned records
  SELECT DISTINCT ar.user_id
  FROM activity_records ar
  WHERE ar.user_assigned_issue_key IS NULL
    AND ar.classification = 'productive'
    AND ar.status = 'analyzed'
)
AND (
  ic.description IS NULL 
  OR TRIM(ic.description) = '' 
  OR LENGTH(TRIM(ic.description)) < 20
)
ORDER BY u.email, ic.issue_key;


-- ============================================================================
-- SECTION 8: Grand Summary — Single-Row Overview
-- ============================================================================

SELECT 
  COUNT(*) AS total_analyzed_records,
  COUNT(CASE WHEN ar.user_assigned_issue_key IS NOT NULL THEN 1 END) AS total_matched,
  COUNT(CASE WHEN ar.user_assigned_issue_key IS NULL THEN 1 END) AS total_unassigned,
  ROUND(
    COUNT(CASE WHEN ar.user_assigned_issue_key IS NOT NULL THEN 1 END) * 100.0 
    / NULLIF(COUNT(*), 0), 1
  ) AS overall_matched_pct,
  ROUND(
    COUNT(CASE WHEN ar.user_assigned_issue_key IS NULL THEN 1 END) * 100.0 
    / NULLIF(COUNT(*), 0), 1
  ) AS overall_unassigned_pct
FROM activity_records ar
WHERE ar.classification = 'productive'
  AND ar.status = 'analyzed';
