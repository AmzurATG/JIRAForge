/*
 * TEST_UNASSIGNED_WORK_INTEGRATION.sql
 * 
 * This script creates sample unassigned work data for testing the fix
 * where converting unassigned work should decrease total time in timeline
 * and remove the unassigned bars.
 * 
 * USAGE:
 * 1. Replace TARGET_USER_ID, TARGET_ORG_ID, and TEST_PROJECT_KEY with actual values
 * 2. Run each section sequentially
 * 3. Check intermediate queries to verify state
 * 4. After user converts work, run verification queries
 * 
 * Data Cleanup: See CLEANUP section at bottom
 */

-- ============================================================================
-- SETUP: Configure test parameters
-- ============================================================================

-- ⚠️  IMPORTANT: Update the UUIDs and values below before running
DROP TABLE IF EXISTS test_config;
CREATE TEMP TABLE test_config AS
SELECT
  '6ef2ec97-116c-474d-aa84-f3f6ecc01e8a'::uuid  AS target_user_id,   -- ← Replace with your user UUID
  'YOUR_ORG_UUID_HERE'::uuid                     AS target_org_id,    -- ← Replace with your org UUID
  'PROJ'                                          AS test_project_key,
  'PROJ-123'                                      AS test_issue_key,
  '2026-04-17'::date                              AS test_date;

-- Helper: verify config loaded correctly before running other phases
SELECT 'CONFIG' as section, * FROM test_config;


-- ============================================================================
-- PHASE 1: CREATE SAMPLE UNASSIGNED WORK ACTIVITIES
-- ============================================================================

/*
 * This phase creates 3 sample unassigned work sessions that simulates
 * a user working on different tasks without assigning them to JIRA issues
 */

-- Activity 1: Database optimization work (15 minutes = 900 seconds)
INSERT INTO public.activity_records (
  id, user_id, organization_id, window_title, application_name,
  start_time, end_time, duration_seconds, total_time_seconds,
  status, classification, clustering_dismissed, user_assigned_issue_key, project_key
)
SELECT
  gen_random_uuid(),
  (SELECT target_user_id FROM test_config),
  (SELECT target_org_id FROM test_config),
  'localhost:5432 - pgAdmin 4', 'pgAdmin',
  (SELECT test_date FROM test_config)::timestamptz + interval '9 hours 30 minutes',
  (SELECT test_date FROM test_config)::timestamptz + interval '9 hours 45 minutes',
  900, 900, 'analyzed', 'productive', false, NULL, NULL;

-- Activity 2: API debugging (12 minutes = 720 seconds)
INSERT INTO public.activity_records (
  id, user_id, organization_id, window_title, application_name,
  start_time, end_time, duration_seconds, total_time_seconds,
  status, classification, clustering_dismissed, user_assigned_issue_key, project_key
)
SELECT
  gen_random_uuid(),
  (SELECT target_user_id FROM test_config),
  (SELECT target_org_id FROM test_config),
  'localhost:3000 - My API Server', 'VS Code',
  (SELECT test_date FROM test_config)::timestamptz + interval '10 hours 15 minutes',
  (SELECT test_date FROM test_config)::timestamptz + interval '10 hours 27 minutes',
  720, 720, 'analyzed', 'productive', false, NULL, NULL;

-- Activity 3: Code review (18 minutes = 1080 seconds)
INSERT INTO public.activity_records (
  id, user_id, organization_id, window_title, application_name,
  start_time, end_time, duration_seconds, total_time_seconds,
  status, classification, clustering_dismissed, user_assigned_issue_key, project_key
)
SELECT
  gen_random_uuid(),
  (SELECT target_user_id FROM test_config),
  (SELECT target_org_id FROM test_config),
  'GitHub - Pull Request Review', 'Google Chrome',
  (SELECT test_date FROM test_config)::timestamptz + interval '11 hours',
  (SELECT test_date FROM test_config)::timestamptz + interval '11 hours 18 minutes',
  1080, 1080, 'analyzed', 'productive', false, NULL, NULL;

-- ============================================================================
-- PHASE 2: VERIFY ACTIVITIES CREATED
-- ============================================================================

-- Check: See all activities created (should show 3 rows)
SELECT 
  'PHASE 2: Created Activities' as phase,
  id, 
  window_title,
  start_time,
  end_time,
  duration_seconds,
  user_assigned_issue_key,
  application_name
FROM activity_records
WHERE user_id = (SELECT target_user_id FROM test_config)
  AND organization_id = (SELECT target_org_id FROM test_config)
  AND DATE(start_time) = (SELECT test_date FROM test_config)
  AND user_assigned_issue_key IS NULL
ORDER BY start_time ASC;


-- ============================================================================
-- PHASE 3: CREATE UNASSIGNED WORK GROUP
-- ============================================================================

/*
 * This phase creates an unassigned_work_groups record that clusters
 * the 3 activities together. This is what the AI server would normally create,
 * but we create it manually for testing.
 */

DROP TABLE IF EXISTS temp_activity_ids;
CREATE TEMP TABLE temp_activity_ids AS
SELECT id 
FROM activity_records
WHERE user_id = (SELECT target_user_id FROM test_config)
  AND organization_id = (SELECT target_org_id FROM test_config)
  AND DATE(start_time) = (SELECT test_date FROM test_config)
  AND user_assigned_issue_key IS NULL
LIMIT 3;

-- Create the unassigned work group
INSERT INTO public.unassigned_work_groups (
  id,
  user_id,
  organization_id,
  group_label,
  group_description,
  session_count,
  total_seconds,
  is_assigned,
  assigned_to_issue_key,
  is_dismissed,
  confidence_level,
  recommended_action,
  suggested_issue_key,
  recommendation_reason,
  created_at
)
SELECT
  gen_random_uuid() as id,
  (SELECT target_user_id FROM test_config),
  (SELECT target_org_id FROM test_config),
  'Backend Development Work' as group_label,
  'Unassigned work on database and API development' as group_description,
  COUNT(*) as session_count,
  SUM(ar.duration_seconds)::integer as total_seconds,
  false as is_assigned,  -- ⭐ KEY: NOT assigned yet
  NULL as assigned_to_issue_key,
  false as is_dismissed,
  'high' as confidence_level,
  'assign_to_existing' as recommended_action,
  'PROJ-123' as suggested_issue_key,
  'Work matches the development timeline for this sprint' as recommendation_reason,
  NOW() as created_at
FROM temp_activity_ids t
JOIN activity_records ar ON ar.id = t.id;

-- ============================================================================
-- PHASE 4: LINK ACTIVITIES TO GROUP (Group Members)
-- ============================================================================

/*
 * Link each activity to the group via unassigned_group_members
 */

INSERT INTO public.unassigned_group_members (group_id, activity_record_id)
SELECT 
  g.id as group_id,
  a.id as activity_record_id
FROM public.unassigned_work_groups g
CROSS JOIN temp_activity_ids a
WHERE g.user_id = (SELECT target_user_id FROM test_config)
  AND g.organization_id = (SELECT target_org_id FROM test_config)
  AND DATE(g.created_at) = (SELECT test_date FROM test_config)
  AND g.group_label = 'Backend Development Work'
ON CONFLICT (group_id, activity_record_id) DO NOTHING;


-- ============================================================================
-- PHASE 5: PRE-CONVERSION STATE VERIFICATION
-- ============================================================================

-- ✅ CHECK 1: Unassigned group exists and is NOT marked as assigned
SELECT 
  'PRE-CONVERSION: Group Status' as check_name,
  id as group_id,
  group_label,
  session_count,
  total_seconds,
  is_assigned,  -- Should be FALSE ⭐
  assigned_to_issue_key,  -- Should be NULL
  assigned_at,  -- Should be NULL
  confidence_level,
  recommended_action,
  suggested_issue_key
FROM unassigned_work_groups
WHERE user_id = (SELECT target_user_id FROM test_config)
  AND organization_id = (SELECT target_org_id FROM test_config)
  AND group_label = 'Backend Development Work';

-- ✅ CHECK 2: Activities still show as unassigned
SELECT 
  'PRE-CONVERSION: Activity Status' as check_name,
  id,
  window_title,
  duration_seconds,
  user_assigned_issue_key,  -- Should be NULL ⭐
  project_key,  -- Should be NULL
  start_time
FROM activity_records
WHERE user_id = (SELECT target_user_id FROM test_config)
  AND organization_id = (SELECT target_org_id FROM test_config)
  AND DATE(start_time) = (SELECT test_date FROM test_config)
  AND user_assigned_issue_key IS NULL
ORDER BY start_time;

-- ✅ CHECK 3: Group appears in unassigned groups query (what user sees)
SELECT 
  'PRE-CONVERSION: Groups List Query' as check_name,
  g.id,
  g.group_label,
  g.session_count,
  g.total_seconds,
  g.is_assigned,
  g.is_dismissed
FROM unassigned_work_groups g
WHERE g.user_id = (SELECT target_user_id FROM test_config)
  AND g.organization_id = (SELECT target_org_id FROM test_config)
  AND g.is_assigned = FALSE  -- Query filter
  AND g.is_dismissed = FALSE  -- Query filter
  AND g.session_count > 0
  AND g.total_seconds > 0;

-- ✅ CHECK 4: Calculate total unassigned time for this user on this date (BEFORE)
SELECT 
  'PRE-CONVERSION: Total Unassigned Time' as check_name,
  COUNT(*) as unassigned_session_count,
  SUM(duration_seconds) as total_unassigned_seconds,
  (SUM(duration_seconds) / 60.0)::numeric(10,2) as total_unassigned_minutes
FROM activity_records
WHERE user_id = (SELECT target_user_id FROM test_config)
  AND organization_id = (SELECT target_org_id FROM test_config)
  AND DATE(start_time) = (SELECT test_date FROM test_config)
  AND user_assigned_issue_key IS NULL  -- Unassigned filter ⭐
  AND classification IN ('productive', 'unknown');

-- Expected: 2700 seconds (45 minutes), 3 sessions


-- ============================================================================
-- PHASE 6: SIMULATE USER ASSIGNMENT
-- ============================================================================

/*
 * This simulates what the backend does when user assigns the group to PROJ-123
 * This mimics the assignToExistingIssue() resolver logic
 */

-- Get the group ID that we just created
DROP TABLE IF EXISTS temp_group_id;
CREATE TEMP TABLE temp_group_id AS
SELECT id FROM unassigned_work_groups
WHERE user_id = (SELECT target_user_id FROM test_config)
  AND organization_id = (SELECT target_org_id FROM test_config)
  AND group_label = 'Backend Development Work'
LIMIT 1;

-- Get all activity IDs in this group
DROP TABLE IF EXISTS temp_assignment_activity_ids;
CREATE TEMP TABLE temp_assignment_activity_ids AS
SELECT DISTINCT ugm.activity_record_id as id
FROM unassigned_group_members ugm
WHERE ugm.group_id = (SELECT id FROM temp_group_id)
  AND ugm.activity_record_id IS NOT NULL;

-- STEP 1: Update activity_records - Mark as assigned to PROJ-123 ⭐ CRITICAL
UPDATE activity_records
SET 
  user_assigned_issue_key = 'PROJ-123',  -- ⭐ NO LONGER NULL
  project_key = 'PROJ'
WHERE id IN (SELECT id FROM temp_assignment_activity_ids)
  AND user_id = (SELECT target_user_id FROM test_config)
  AND organization_id = (SELECT target_org_id FROM test_config);

-- STEP 2: Update the group - Mark as assigned ⭐ CRITICAL
UPDATE unassigned_work_groups
SET 
  is_assigned = TRUE,  -- ⭐ Changed from FALSE to TRUE
  assigned_to_issue_key = 'PROJ-123',
  assigned_at = NOW(),
  assigned_by = (SELECT target_user_id FROM test_config)
WHERE id = (SELECT id FROM temp_group_id);


-- ============================================================================
-- PHASE 7: POST-CONVERSION STATE VERIFICATION
-- ============================================================================

-- ✅ CHECK 5: Group is now marked as assigned
SELECT 
  'POST-CONVERSION: Group Status' as check_name,
  id as group_id,
  group_label,
  session_count,
  total_seconds,
  is_assigned,  -- Should NOW be TRUE ✅
  assigned_to_issue_key,  -- Should NOW be PROJ-123 ✅
  assigned_at,  -- Should have timestamp
  assigned_by
FROM unassigned_work_groups
WHERE user_id = (SELECT target_user_id FROM test_config)
  AND organization_id = (SELECT target_org_id FROM test_config)
  AND group_label = 'Backend Development Work';

-- ✅ CHECK 6: Activities now show as assigned to PROJ-123
SELECT 
  'POST-CONVERSION: Activity Status' as check_name,
  id,
  window_title,
  duration_seconds,
  user_assigned_issue_key,  -- Should NOW be PROJ-123 ✅
  project_key,  -- Should NOW be PROJ ✅
  start_time
FROM activity_records
WHERE user_id = (SELECT target_user_id FROM test_config)
  AND organization_id = (SELECT target_org_id FROM test_config)
  AND DATE(start_time) = (SELECT test_date FROM test_config)
  AND user_assigned_issue_key = 'PROJ-123'
ORDER BY start_time;

-- ✅ CHECK 7: Group NO LONGER appears in unassigned groups query
SELECT 
  'POST-CONVERSION: Groups List Query' as check_name,
  COUNT(*) as group_count
FROM unassigned_work_groups g
WHERE g.user_id = (SELECT target_user_id FROM test_config)
  AND g.organization_id = (SELECT target_org_id FROM test_config)
  AND g.is_assigned = FALSE  -- Filter applied
  AND g.is_dismissed = FALSE
  AND g.session_count > 0
  AND g.total_seconds > 0;

-- Expected: Should be 1 less than before (our group is no longer included)

-- ✅ CHECK 8: Total unassigned time for this date is NOW REDUCED
SELECT 
  'POST-CONVERSION: Total Unassigned Time' as check_name,
  COUNT(*) as unassigned_session_count,
  SUM(duration_seconds) as total_unassigned_seconds,
  (COALESCE(SUM(duration_seconds), 0) / 60.0)::numeric(10,2) as total_unassigned_minutes
FROM activity_records
WHERE user_id = (SELECT target_user_id FROM test_config)
  AND organization_id = (SELECT target_org_id FROM test_config)
  AND DATE(start_time) = (SELECT test_date FROM test_config)
  AND user_assigned_issue_key IS NULL  -- Unassigned filter ⭐
  AND classification IN ('productive', 'unknown');

-- Expected: 0 sessions, 0 seconds (all were converted to PROJ-123)


-- ============================================================================
-- PHASE 8: TIMELINE BEHAVIOR VERIFICATION
-- ============================================================================

/*
 * These queries simulate what the teamAnalyticsService.js uses
 * to build the timeline view
 */

-- ✅ CHECK 9: Activities for timeline BEFORE (would show as unassigned bars)
SELECT 
  'TIMELINE: Activities Before Assignment' as check_name,
  'unassigned' as block_type,
  id,
  start_time,
  end_time,
  duration_seconds,
  user_assigned_issue_key  -- This should be NULL (but isn't after our update)
FROM activity_records
WHERE user_id = (SELECT target_user_id FROM test_config)
  AND organization_id = (SELECT target_org_id FROM test_config)
  AND DATE(start_time) = (SELECT test_date FROM test_config)
  AND user_assigned_issue_key IS NULL;

-- After conversion, this should return 0 rows for those activities

-- ✅ CHECK 10: Activities for timeline AFTER (now show as assigned/green bars)
SELECT 
  'TIMELINE: Activities After Assignment' as check_name,
  'assigned' as block_type,
  id,
  start_time,
  end_time,
  duration_seconds,
  user_assigned_issue_key,  -- Should be PROJ-123
  project_key  -- Should be PROJ
FROM activity_records
WHERE user_id = (SELECT target_user_id FROM test_config)
  AND organization_id = (SELECT target_org_id FROM test_config)
  AND DATE(start_time) = (SELECT test_date FROM test_config)
  AND user_assigned_issue_key = 'PROJ-123';

-- Expected: 3 rows with our activities


-- ============================================================================
-- PHASE 9: CROSS-DATA CONSISTENCY CHECKS
-- ============================================================================

-- ✅ CHECK 11: Group members still exist and point to correct activities
SELECT 
  'CONSISTENCY: Group Members' as check_name,
  ugm.id as member_id,
  ugm.group_id,
  ugm.activity_record_id,
  ar.user_assigned_issue_key,
  g.is_assigned,
  g.assigned_to_issue_key
FROM unassigned_group_members ugm
JOIN activity_records ar ON ugm.activity_record_id = ar.id
JOIN unassigned_work_groups g ON ugm.group_id = g.id
WHERE g.user_id = (SELECT target_user_id FROM test_config)
  AND g.organization_id = (SELECT target_org_id FROM test_config)
  AND g.group_label = 'Backend Development Work';

-- Expected: 3 rows, all pointing to activities with user_assigned_issue_key = PROJ-123

-- ✅ CHECK 12: Group metadata matches activity count
SELECT 
  'CONSISTENCY: Group Metadata vs Activities' as check_name,
  g.id as group_id,
  g.session_count as metadata_session_count,
  COUNT(ugm.id) as actual_member_count,
  g.total_seconds as metadata_total_seconds,
  SUM(ar.duration_seconds)::integer as actual_total_seconds,
  CASE 
    WHEN g.session_count = COUNT(ugm.id) AND g.total_seconds = SUM(ar.duration_seconds)::integer
    THEN '✅ CONSISTENT'
    ELSE '❌ MISMATCH'
  END as consistency_status
FROM unassigned_work_groups g
LEFT JOIN unassigned_group_members ugm ON g.id = ugm.group_id
LEFT JOIN activity_records ar ON ugm.activity_record_id = ar.id
WHERE g.user_id = (SELECT target_user_id FROM test_config)
  AND g.organization_id = (SELECT target_org_id FROM test_config)
  AND g.group_label = 'Backend Development Work'
GROUP BY g.id, g.session_count, g.total_seconds;


-- ============================================================================
-- PHASE 10: COMPARISON BEFORE & AFTER (SUMMARY)
-- ============================================================================

CREATE TEMP TABLE timeline_before AS
SELECT 
  'BEFORE' as state,
  COUNT(CASE WHEN user_assigned_issue_key IS NULL THEN 1 END) as unassigned_count,
  COUNT(CASE WHEN user_assigned_issue_key IS NOT NULL THEN 1 END) as assigned_count,
  SUM(CASE WHEN user_assigned_issue_key IS NULL THEN duration_seconds ELSE 0 END)::integer as unassigned_seconds,
  SUM(CASE WHEN user_assigned_issue_key IS NOT NULL THEN duration_seconds ELSE 0 END)::integer as assigned_seconds
FROM activity_records
WHERE user_id = (SELECT target_user_id FROM test_config)
  AND organization_id = (SELECT target_org_id FROM test_config)
  AND DATE(start_time) = (SELECT test_date FROM test_config);

SELECT 
  'SUMMARY: State Comparison' as section,
  state,
  unassigned_count,
  assigned_count,
  unassigned_seconds,
  (COALESCE(unassigned_seconds, 0) / 60.0)::numeric(10,2) as unassigned_minutes,
  assigned_seconds,
  (COALESCE(assigned_seconds, 0) / 60.0)::numeric(10,2) as assigned_minutes
FROM timeline_before;

-- Expected output:
-- BEFORE: 3 unassigned, 0 assigned, 2700 seconds unassigned
-- AFTER (should be opposite):  0 unassigned, 3 assigned, 0 seconds unassigned


-- ============================================================================
-- CLEANUP: Remove Test Data
-- ============================================================================

/*
 * Run this section ONLY after testing is complete to clean up test data
 * 
 * ⚠️ WARNING: This will delete all test data created in this script
 * Make sure TARGET_USER_ID and TARGET_DATE are correct before running
 */

-- PHASE CLEANUP: Uncomment when ready to delete test data

-- -- Get IDs to delete
-- DROP TABLE IF EXISTS cleanup_activity_ids;
-- CREATE TEMP TABLE cleanup_activity_ids AS
-- SELECT id FROM activity_records
-- WHERE user_id = (SELECT target_user_id FROM test_config)
--   AND organization_id = (SELECT target_org_id FROM test_config)
--   AND DATE(start_time) = (SELECT test_date FROM test_config)
--   AND window_title IN (
--     'localhost:5432 - pgAdmin 4',
--     'localhost:3000 - My API Server',
--     'GitHub - Pull Request Review'
--   );

-- DROP TABLE IF EXISTS cleanup_group_ids;
-- CREATE TEMP TABLE cleanup_group_ids AS
-- SELECT id FROM unassigned_work_groups
-- WHERE user_id = (SELECT target_user_id FROM test_config)
--   AND organization_id = (SELECT target_org_id FROM test_config)
--   AND group_label = 'Backend Development Work';

-- -- Delete group members (references must be deleted first)
-- DELETE FROM unassigned_group_members ugm
-- WHERE ugm.group_id IN (SELECT id FROM cleanup_group_ids);

-- -- Delete groups
-- DELETE FROM unassigned_work_groups
-- WHERE id IN (SELECT id FROM cleanup_group_ids);

-- -- Delete activities
-- DELETE FROM activity_records
-- WHERE id IN (SELECT id FROM cleanup_activity_ids);

-- SELECT 'Test data cleanup complete' as message;


-- ============================================================================
-- EXPECTED TEST RESULTS
-- ============================================================================

/*
 * PASS CRITERIA:
 * 
 * ✅ Phase 2: 3 unassigned activities created
 *    - All have user_assigned_issue_key = NULL
 *    - Total duration = 2700 seconds (45 minutes)
 *
 * ✅ Phase 5 (PRE-CONVERSION):
 *    - Group shows is_assigned = FALSE
 *    - Group is_dismissed = FALSE
 *    - All activities have user_assigned_issue_key = NULL
 *    - Total unassigned time = 2700 seconds
 *    - Group appears in unassigned groups query
 *
 * ✅ Phase 7 (POST-CONVERSION):
 *    - Group shows is_assigned = TRUE ⭐
 *    - Group shows assigned_to_issue_key = PROJ-123 ⭐
 *    - All activities have user_assigned_issue_key = PROJ-123 ⭐
 *    - All activities have project_key = PROJ ⭐
 *    - Total unassigned time = 0 seconds ⭐
 *    - Group NO LONGER appears in unassigned groups query ⭐
 *
 * ✅ Phase 9 (CONSISTENCY):
 *    - Group members metadata matches actual activities
 *    - session_count and total_seconds are consistent
 *
 * FAILURE INDICATORS:
 * 
 * ❌ POST-CONVERSION: is_assigned still FALSE
 *    → Fix: Check markGroupAsAssigned() in assignmentResolvers.js
 *
 * ❌ POST-CONVERSION: activites still have user_assigned_issue_key = NULL
 *    → Fix: Check updateSessionsAndAnalysis() in assignmentResolvers.js
 *
 * ❌ POST-CONVERSION: Total unassigned time didn't decrease
 *    → Fix: Verify timeline query filters correctly
 *
 * ❌ POST-CONVERSION: Group still appears in unassigned list
 *    → Fix: Check is_assigned filter in getUnassignedGroups()
 */

