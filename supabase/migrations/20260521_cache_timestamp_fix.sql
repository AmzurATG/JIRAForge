-- Migration for Bug #2: Cache Timestamp Fix
-- Date: May 21, 2026
-- Purpose: Clear cache to force rebuild with correct Jira timestamps
--
-- Context: Bug #2 caused all cached issues to have the same updated_at
-- (server write time) instead of Jira's actual fields.updated timestamp.
-- After deploying the code fix, this migration clears the cache so it
-- rebuilds with correct timestamps within 30 minutes (forge-app refresh cycle).
--
-- Rollback: If needed, restore from pre-migration backup table:
--   INSERT INTO user_jira_issues_cache SELECT * FROM user_jira_issues_cache_backup_20260521;

-- Step 1: Create backup (optional, for rollback safety)
CREATE TABLE IF NOT EXISTS user_jira_issues_cache_backup_20260521 AS
SELECT * FROM user_jira_issues_cache;

-- Step 2: Clear entire cache to force rebuild with correct timestamps
DELETE FROM user_jira_issues_cache;

-- Step 3: Verify empty (should return 0)
SELECT COUNT(*) as remaining_rows FROM user_jira_issues_cache;

-- Expected: 0 rows
-- Next: Cache rebuilds automatically within 30 minutes via forge-app refresh

-- Post-migration validation (run after 30 minutes):
-- 
-- 1. Check cache repopulation:
--    SELECT organization_id, COUNT(*) as issue_count, 
--           MIN(updated_at) as oldest, MAX(updated_at) as newest
--    FROM user_jira_issues_cache
--    GROUP BY organization_id;
-- 
-- 2. Verify timestamp diversity (should have different timestamps):
--    SELECT COUNT(DISTINCT updated_at) as unique_timestamps, 
--           COUNT(*) as total_issues
--    FROM user_jira_issues_cache
--    WHERE organization_id = '<test-org-id>';
--    -- Expected: unique_timestamps > 1 (not all same timestamp)
