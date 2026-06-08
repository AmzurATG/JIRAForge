-- ============================================================================
-- DIAGNOSTIC QUERY — Check Data Availability
-- ============================================================================
-- Run this to understand what data is available in your database

-- Check 1: Activity records by date range and user
SELECT 
  ar.created_at::DATE AS activity_date,
  u.email,
  o.org_name,
  COUNT(*) AS record_count,
  COUNT(CASE WHEN ar.user_assigned_issues IS NOT NULL 
             AND ar.user_assigned_issues != '' 
             AND ar.user_assigned_issues != 'null' THEN 1 END) AS records_with_issues,
  COUNT(CASE WHEN ar.user_assigned_issue_key IS NOT NULL THEN 1 END) AS matched_records
FROM activity_records ar
JOIN users u ON u.id = ar.user_id
JOIN organizations o ON o.id = ar.organization_id
WHERE ar.created_at >= '2026-06-01'::DATE
  AND ar.created_at < '2026-06-09'::DATE
  AND ar.classification = 'productive'
  AND ar.status = 'analyzed'
GROUP BY ar.created_at::DATE, u.email, o.org_name
ORDER BY activity_date DESC, record_count DESC;

-- Check 2: Sample user_assigned_issues content
SELECT 
  u.email,
  ar.created_at::DATE AS activity_date,
  LEFT(ar.user_assigned_issues, 500) AS issues_sample,
  LENGTH(ar.user_assigned_issues) AS issues_length
FROM activity_records ar
JOIN users u ON u.id = ar.user_id
WHERE ar.created_at >= '2026-06-01'::DATE
  AND ar.created_at < '2026-06-09'::DATE
  AND ar.classification = 'productive'
  AND ar.status = 'analyzed'
  AND ar.user_assigned_issues IS NOT NULL
  AND ar.user_assigned_issues != ''
  AND ar.user_assigned_issues != 'null'
LIMIT 5;

-- Check 3: Total users and organizations in the system
SELECT 
  'Total Users' AS metric,
  COUNT(DISTINCT u.id)::TEXT AS count
FROM users u
WHERE EXISTS (
  SELECT 1 FROM activity_records ar 
  WHERE ar.user_id = u.id 
    AND ar.created_at >= '2026-06-01'::DATE
    AND ar.classification = 'productive'
)

UNION ALL

SELECT 
  'Total Organizations',
  COUNT(DISTINCT o.id)::TEXT
FROM organizations o
WHERE EXISTS (
  SELECT 1 FROM activity_records ar 
  WHERE ar.organization_id = o.id 
    AND ar.created_at >= '2026-06-01'::DATE
    AND ar.classification = 'productive'
)

UNION ALL

SELECT 
  'Total Activity Records',
  COUNT(*)::TEXT
FROM activity_records
WHERE created_at >= '2026-06-01'::DATE
  AND classification = 'productive'
  AND status = 'analyzed';

-- Check 4: Issues extracted from JSON by user
WITH issues_extracted AS (
  SELECT 
    ar.user_id,
    u.email,
    (jsonb_array_elements(ar.user_assigned_issues::jsonb))->>'key' AS issue_key,
    (jsonb_array_elements(ar.user_assigned_issues::jsonb))->>'project' AS project_key
  FROM activity_records ar
  JOIN users u ON u.id = ar.user_id
  WHERE ar.created_at >= '2026-06-01'::DATE
    AND ar.created_at < '2026-06-09'::DATE
    AND ar.classification = 'productive'
    AND ar.status = 'analyzed'
    AND ar.user_assigned_issues IS NOT NULL
    AND ar.user_assigned_issues != ''
    AND ar.user_assigned_issues != 'null'
)
SELECT 
  email,
  COUNT(DISTINCT issue_key) AS total_issues,
  COUNT(DISTINCT project_key) AS total_projects,
  STRING_AGG(DISTINCT project_key, ', ' ORDER BY project_key) AS project_list
FROM issues_extracted
GROUP BY email
ORDER BY total_issues DESC;
