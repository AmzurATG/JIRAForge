-- ============================================================================
-- GDPR Compliance - Check for Untracked Tables/Buckets
-- ============================================================================
-- Run this query monthly to ensure all user data tables are tracked
-- in the Personal Data Reporting API implementation
-- Created: April 3, 2026
-- ============================================================================

-- ============================================================================
-- PART 1: Check for Untracked Tables with user_id Column
-- ============================================================================

SELECT 
  t.table_name,
  t.column_name,
  CASE 
    WHEN t.table_name IN (
      'users',
      'organization_members',
      'screenshots',
      'analysis_results',
      'activity_records',
      'worklogs',
      'documents',
      'feedback',
      'tracking_settings',
      'notification_preferences',
      'activity_log',
      'user_jira_issues_cache',
      'unassigned_activity',
      'worklog_sync',
      'notification_logs',
      'notification_cooldowns'
    ) THEN '✅ TRACKED'
    ELSE '⚠️ UNTRACKED - NEEDS REVIEW'
  END as tracking_status
FROM information_schema.columns t
WHERE t.column_name = 'user_id'
  AND t.table_schema = 'public'
  AND t.table_name NOT LIKE 'pg_%'  -- Exclude PostgreSQL system tables
  AND t.table_name NOT LIKE 'sql_%' -- Exclude SQL system tables
ORDER BY 
  CASE 
    WHEN t.table_name IN (
      'users', 'organization_members', 'screenshots', 'analysis_results',
      'activity_records', 'worklogs', 'documents', 'feedback',
      'tracking_settings', 'notification_preferences', 'activity_log',
      'user_jira_issues_cache', 'unassigned_activity', 'worklog_sync',
      'notification_logs', 'notification_cooldowns'
    ) THEN 1
    ELSE 0
  END ASC,
  t.table_name;

-- ============================================================================
-- Expected Result (as of April 2026):
-- All tables should show "✅ TRACKED"
-- If any show "⚠️ UNTRACKED", you MUST:
-- 1. Review if table contains user personal data
-- 2. Update user-data-service.js to export/delete from that table
-- 3. Update documentation
-- 4. Test export/deletion
-- ============================================================================

-- ============================================================================
-- PART 2: Check for New Storage Buckets
-- ============================================================================

SELECT 
  id as bucket_name,
  created_at,
  CASE 
    WHEN id IN ('screenshots', 'documents', 'feedback-images', 'exports') 
    THEN '✅ TRACKED'
    ELSE '⚠️ UNTRACKED - NEEDS REVIEW'
  END as tracking_status,
  public as is_public,
  file_size_limit,
  allowed_mime_types
FROM storage.buckets
ORDER BY 
  CASE 
    WHEN id IN ('screenshots', 'documents', 'feedback-images', 'exports') 
    THEN 1
    ELSE 0
  END ASC,
  created_at DESC;

-- ============================================================================
-- Expected Result (as of April 2026):
-- ✅ screenshots (tracked in export/delete)
-- ✅ documents (tracked in export/delete)
-- ✅ feedback-images (tracked in export/delete)
-- ✅ exports (temporary export files, auto-cleanup)
-- 
-- If any new buckets show "⚠️ UNTRACKED" and contain user data:
-- 1. Update exportStorageFiles() in user-data-service.js
-- 2. Update deleteStorageFiles() in user-data-service.js
-- 3. Update documentation
-- 4. Test export/deletion
-- ============================================================================

-- ============================================================================
-- PART 3: Check Row Counts for Each Tracked Table
-- ============================================================================

SELECT 
  'users' as table_name,
  COUNT(*) as total_rows,
  COUNT(DISTINCT id) as unique_users
FROM users

UNION ALL

SELECT 
  'organization_members',
  COUNT(*),
  COUNT(DISTINCT user_id)
FROM organization_members

UNION ALL

SELECT 
  'screenshots',
  COUNT(*),
  COUNT(DISTINCT user_id)
FROM screenshots

UNION ALL

SELECT 
  'analysis_results',
  COUNT(*),
  COUNT(DISTINCT user_id)
FROM analysis_results

UNION ALL

SELECT 
  'activity_records',
  COUNT(*),
  COUNT(DISTINCT user_id)
FROM activity_records

UNION ALL

SELECT 
  'worklogs',
  COUNT(*),
  COUNT(DISTINCT user_id)
FROM worklogs

UNION ALL

SELECT 
  'documents',
  COUNT(*),
  COUNT(DISTINCT user_id)
FROM documents

UNION ALL

SELECT 
  'feedback',
  COUNT(*),
  COUNT(DISTINCT user_id)
FROM feedback

UNION ALL

SELECT 
  'tracking_settings',
  COUNT(*),
  COUNT(DISTINCT user_id)
FROM tracking_settings

UNION ALL

SELECT 
  'notification_preferences',
  COUNT(*),
  COUNT(DISTINCT user_id)
FROM notification_preferences

UNION ALL

SELECT 
  'activity_log',
  COUNT(*),
  COUNT(DISTINCT user_id)
FROM activity_log

UNION ALL

SELECT 
  'user_jira_issues_cache',
  COUNT(*),
  COUNT(DISTINCT user_id)
FROM user_jira_issues_cache

UNION ALL

SELECT 
  'unassigned_activity',
  COUNT(*),
  COUNT(DISTINCT user_id)
FROM unassigned_activity

UNION ALL

SELECT 
  'worklog_sync',
  COUNT(*),
  COUNT(DISTINCT user_id)
FROM worklog_sync

UNION ALL

SELECT 
  'notification_logs',
  COUNT(*),
  COUNT(DISTINCT user_id)
FROM notification_logs

UNION ALL

SELECT 
  'notification_cooldowns',
  COUNT(*),
  COUNT(DISTINCT user_id)
FROM notification_cooldowns

ORDER BY total_rows DESC;

-- ============================================================================
-- This gives you a sense of data volume per table
-- Helps estimate export/deletion processing times
-- ============================================================================

-- ============================================================================
-- PART 4: Find Tables with Email, Name, or Other PII Columns
-- ============================================================================

SELECT DISTINCT
  table_name,
  column_name,
  data_type,
  '⚠️ Contains potential PII' as warning
FROM information_schema.columns
WHERE table_schema = 'public'
  AND (
    column_name ILIKE '%email%'
    OR column_name ILIKE '%name%'
    OR column_name ILIKE '%phone%'
    OR column_name ILIKE '%address%'
    OR column_name ILIKE '%ip_%'
  )
  AND table_name NOT LIKE 'pg_%'
  AND table_name NOT LIKE 'sql_%'
ORDER BY table_name, column_name;

-- ============================================================================
-- Review this list carefully!
-- Any table with PII columns should be included in export/deletion
-- Even if it doesn't have a user_id column, it might have user data
-- ============================================================================

-- ============================================================================
-- PART 5: Check Foreign Key Relationships to Users Table
-- ============================================================================

SELECT
  tc.table_name as child_table,
  kcu.column_name as fk_column,
  ccu.table_name AS parent_table,
  ccu.column_name AS parent_column,
  rc.delete_rule as on_delete_action
FROM information_schema.table_constraints AS tc
JOIN information_schema.key_column_usage AS kcu
  ON tc.constraint_name = kcu.constraint_name
  AND tc.table_schema = kcu.table_schema
JOIN information_schema.constraint_column_usage AS ccu
  ON ccu.constraint_name = tc.constraint_name
  AND ccu.table_schema = tc.table_schema
JOIN information_schema.referential_constraints AS rc
  ON tc.constraint_name = rc.constraint_name
WHERE tc.constraint_type = 'FOREIGN KEY'
  AND ccu.table_name = 'users'
  AND tc.table_schema = 'public'
ORDER BY tc.table_name;

-- ============================================================================
-- Expected Result: All user-related tables should have:
-- on_delete_action = 'CASCADE' 
-- 
-- This ensures when user is deleted, all related data is automatically removed
-- If any table shows 'NO ACTION' or 'SET NULL', review carefully!
-- ============================================================================

-- ============================================================================
-- PART 6: Test Query - Simulate Export for a User
-- ============================================================================

-- Replace 'test-user-id-here' with actual user UUID to test
/*
SELECT 
  'users' as table_name,
  COUNT(*) as record_count
FROM users
WHERE id = 'test-user-id-here'

UNION ALL

SELECT 'screenshots', COUNT(*) FROM screenshots WHERE user_id = 'test-user-id-here'
UNION ALL
SELECT 'analysis_results', COUNT(*) FROM analysis_results WHERE user_id = 'test-user-id-here'
UNION ALL
SELECT 'activity_records', COUNT(*) FROM activity_records WHERE user_id = 'test-user-id-here'
UNION ALL
SELECT 'worklogs', COUNT(*) FROM worklogs WHERE user_id = 'test-user-id-here'
UNION ALL
SELECT 'documents', COUNT(*) FROM documents WHERE user_id = 'test-user-id-here'
UNION ALL
SELECT 'feedback', COUNT(*) FROM feedback WHERE user_id = 'test-user-id-here'
UNION ALL
SELECT 'tracking_settings', COUNT(*) FROM tracking_settings WHERE user_id = 'test-user-id-here'
UNION ALL
SELECT 'notification_preferences', COUNT(*) FROM notification_preferences WHERE user_id = 'test-user-id-here'
UNION ALL
SELECT 'activity_log', COUNT(*) FROM activity_log WHERE user_id = 'test-user-id-here'
UNION ALL
SELECT 'user_jira_issues_cache', COUNT(*) FROM user_jira_issues_cache WHERE user_id = 'test-user-id-here'
UNION ALL
SELECT 'unassigned_activity', COUNT(*) FROM unassigned_activity WHERE user_id = 'test-user-id-here'
UNION ALL
SELECT 'worklog_sync', COUNT(*) FROM worklog_sync WHERE user_id = 'test-user-id-here'
UNION ALL
SELECT 'notification_logs', COUNT(*) FROM notification_logs WHERE user_id = 'test-user-id-here'
UNION ALL
SELECT 'notification_cooldowns', COUNT(*) FROM notification_cooldowns WHERE user_id = 'test-user-id-here'
UNION ALL
SELECT 'organization_members', COUNT(*) FROM organization_members WHERE user_id = 'test-user-id-here'

ORDER BY record_count DESC;
*/

-- ============================================================================
-- RECOMMENDATIONS:
-- 
-- 1. Run PART 1 and PART 2 MONTHLY to check for new tables/buckets
-- 2. Run PART 3 QUARTERLY to monitor data growth
-- 3. Run PART 4 when adding new tables with string columns
-- 4. Run PART 5 when modifying foreign key relationships
-- 5. Run PART 6 before/after testing export/deletion
-- 
-- Set a calendar reminder to run this script!
-- ============================================================================

-- ============================================================================
-- AUDIT LOG
-- Record when this check was last performed
-- ============================================================================

-- Uncomment and run to log check:
/*
INSERT INTO activity_log (event_type, event_data, created_at)
VALUES (
  'gdpr_compliance_check',
  jsonb_build_object(
    'checked_at', NOW(),
    'checked_by', 'development_team',
    'script_version', '1.0',
    'notes', 'Monthly GDPR compliance check for untracked tables'
  ),
  NOW()
);
*/
