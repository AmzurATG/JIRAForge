/*
 * VERIFY_UNASSIGNED_WORK.sql
 * 
 * Quick verification query to see all unassigned work for a user
 * showing what should appear in the timeline
 * 
 * USAGE: Update the CONFIG section below with your user ID and date, then run
 */

-- ============================================================================
-- CONFIG: Set your user details
-- ============================================================================

DROP TABLE IF EXISTS verify_config;
CREATE TEMP TABLE verify_config AS
SELECT
  '6ef2ec97-116c-474d-aa84-f3f6ecc01e8a'::uuid  AS target_user_id,   -- ← Replace with your user UUID
  'YOUR_ORG_UUID_HERE'::uuid                     AS target_org_id,    -- ← Replace with your org UUID
  '2026-04-17'::date                              AS verify_date;

-- Verify config
SELECT 'CONFIG' as section, * FROM verify_config;


-- ============================================================================
-- CHECK 1: Show all unassigned activities for this user on this date
-- ============================================================================

SELECT 
  '1️⃣ UNASSIGNED ACTIVITIES' as check_section,
  COUNT(*) as activity_count,
  SUM(duration_seconds) as total_unassigned_seconds,
  (SUM(duration_seconds) / 60.0)::numeric(10,2) as total_unassigned_minutes,
  MIN(start_time) as earliest_activity,
  MAX(end_time) as latest_activity
FROM activity_records
WHERE user_id = (SELECT target_user_id FROM verify_config)
  AND organization_id = (SELECT target_org_id FROM verify_config)
  AND DATE(start_time) = (SELECT verify_date FROM verify_config)
  AND user_assigned_issue_key IS NULL
  AND classification IN ('productive', 'unknown');

-- Expected: Should show 3 activities, 2700 seconds (45 minutes)


-- ============================================================================
-- CHECK 2: Detailed list of each unassigned activity
-- ============================================================================

SELECT 
  '2️⃣ UNASSIGNED ACTIVITY DETAILS' as check_section,
  ROW_NUMBER() OVER (ORDER BY start_time) as activity_num,
  window_title,
  application_name,
  start_time,
  end_time,
  duration_seconds,
  (duration_seconds / 60.0)::numeric(10,2) as duration_minutes,
  classification,
  status,
  user_assigned_issue_key,  -- Should be NULL
  project_key  -- Should be NULL
FROM activity_records
WHERE user_id = (SELECT target_user_id FROM verify_config)
  AND organization_id = (SELECT target_org_id FROM verify_config)
  AND DATE(start_time) = (SELECT verify_date FROM verify_config)
  AND user_assigned_issue_key IS NULL
  AND classification IN ('productive', 'unknown')
ORDER BY start_time ASC;


-- ============================================================================
-- CHECK 3: Show unassigned work groups (clustering)
-- ============================================================================

SELECT 
  '3️⃣ UNASSIGNED WORK GROUPS' as check_section,
  id as group_id,
  group_label,
  group_description,
  session_count,
  total_seconds,
  (total_seconds / 60.0)::numeric(10,2) as total_minutes,
  is_assigned,  -- Should be FALSE before conversion
  is_dismissed,
  confidence_level,
  recommended_action,
  suggested_issue_key,
  created_at
FROM unassigned_work_groups
WHERE user_id = (SELECT target_user_id FROM verify_config)
  AND organization_id = (SELECT target_org_id FROM verify_config)
  AND is_assigned = FALSE  -- Only unassigned groups
  AND is_dismissed = FALSE  -- Not dismissed
ORDER BY created_at DESC;

-- Expected: Should show 1 group "Backend Development Work" with 3 sessions, 2700 seconds


-- ============================================================================
-- CHECK 4: Activities grouped by unassigned group (what user sees)
-- ============================================================================

SELECT 
  '4️⃣ GROUPED ACTIVITIES' as check_section,
  g.group_label,
  g.session_count,
  g.total_seconds,
  (g.total_seconds / 60.0)::numeric(10,2) as total_minutes_in_group,
  COUNT(ugm.id) as actual_member_count,
  STRING_AGG(ar.window_title, ' | ' ORDER BY ar.start_time) as activity_titles,
  STRING_AGG(ar.application_name, ' | ' ORDER BY ar.start_time) as applications
FROM unassigned_work_groups g
LEFT JOIN unassigned_group_members ugm ON g.id = ugm.group_id
LEFT JOIN activity_records ar ON ugm.activity_record_id = ar.id
WHERE g.user_id = (SELECT target_user_id FROM verify_config)
  AND g.organization_id = (SELECT target_org_id FROM verify_config)
  AND g.is_assigned = FALSE
  AND g.is_dismissed = FALSE
GROUP BY g.id, g.group_label, g.session_count, g.total_seconds
ORDER BY g.created_at DESC;


-- ============================================================================
-- CHECK 5: Timeline aggregation (what dashboard actually displays)
-- ============================================================================

SELECT 
  '5️⃣ TIMELINE SUMMARY' as check_section,
  DATE(ar.start_time)::text as date,
  COUNT(CASE WHEN ar.user_assigned_issue_key IS NULL THEN 1 END) as unassigned_sessions,
  SUM(CASE WHEN ar.user_assigned_issue_key IS NULL THEN ar.duration_seconds ELSE 0 END)::integer as unassigned_seconds,
  (SUM(CASE WHEN ar.user_assigned_issue_key IS NULL THEN ar.duration_seconds ELSE 0 END) / 60.0)::numeric(10,2) as unassigned_minutes,
  COUNT(CASE WHEN ar.user_assigned_issue_key IS NOT NULL THEN 1 END) as assigned_sessions,
  SUM(CASE WHEN ar.user_assigned_issue_key IS NOT NULL THEN ar.duration_seconds ELSE 0 END)::integer as assigned_seconds,
  (SUM(CASE WHEN ar.user_assigned_issue_key IS NOT NULL THEN ar.duration_seconds ELSE 0 END) / 60.0)::numeric(10,2) as assigned_minutes
FROM activity_records ar
WHERE ar.user_id = (SELECT target_user_id FROM verify_config)
  AND ar.organization_id = (SELECT target_org_id FROM verify_config)
  AND ar.classification IN ('productive', 'unknown')
GROUP BY DATE(ar.start_time)
ORDER BY DATE(ar.start_time) DESC;

-- This is what should appear in the dashboard:
-- Should show unassigned_minutes = 45 (from the 2700 seconds we created)


-- ============================================================================
-- CHECK 6: Debug - See ALL activities regardless of assignment (for comparison)
-- ============================================================================

SELECT 
  '6️⃣ ALL ACTIVITIES (DEBUG)' as check_section,
  COUNT(*) as total_activities,
  COUNT(CASE WHEN user_assigned_issue_key IS NULL THEN 1 END) as unassigned_count,
  COUNT(CASE WHEN user_assigned_issue_key IS NOT NULL THEN 1 END) as assigned_count,
  SUM(duration_seconds) as total_seconds,
  (SUM(duration_seconds) / 60.0)::numeric(10,2) as total_minutes
FROM activity_records
WHERE user_id = (SELECT target_user_id FROM verify_config)
  AND organization_id = (SELECT target_org_id FROM verify_config)
  AND DATE(start_time) = (SELECT verify_date FROM verify_config);


-- ============================================================================
-- TROUBLESHOOTING CHECKLIST
-- ============================================================================

/*
 * If unassigned work is not showing in the dashboard:
 * 
 * ❓ CHECK 1: Did the test data get created?
 *    Run CHECK 1 - should show 3 activities, 2700 seconds
 *    If 0: The INSERT statements didn't work. Check Phase 1-2 of main script.
 * 
 * ❓ CHECK 2: Are the activities marked as unassigned?
 *    Run CHECK 2 - all should have user_assigned_issue_key = NULL
 *    If not NULL: Activities were assigned. Check Phase 6 update logic.
 * 
 * ❓ CHECK 3: Is the group created and marked as unassigned?
 *    Run CHECK 3 - should show 1 group with is_assigned = FALSE
 *    If empty: Group creation failed or group is already assigned. Check Phase 3-4.
 * 
 * ❓ CHECK 4: Are activities linked to the group?
 *    Run CHECK 4 - actual_member_count should equal session_count
 *    If mismatch: Group members weren't linked. Check Phase 4.
 * 
 * ❓ CHECK 5: Why isn't it showing in the dashboard?
 *    Run CHECK 5 - compare unassigned_minutes with what dashboard shows
 *    If mismatch: Check if dashboard filters by date or other criteria.
 *    - Make sure you're viewing the correct date (April 17, 2026)
 *    - Check if there's a project filter applied
 *    - Verify the user_id matches your logged-in user
 * 
 * ❓ CHECK 6: Sanity check - data integrity
 *    Run CHECK 6 - see all activities to verify nothing was accidentally deleted
 */
