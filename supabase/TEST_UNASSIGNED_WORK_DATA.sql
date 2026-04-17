-- ============================================================================
-- TEST UNASSIGNED WORK CONVERSION FEATURE - COMPREHENSIVE SQL SCRIPT
-- ============================================================================
-- This script creates realistic test data for the unassigned work timeline
-- conversion feature, with verification and cleanup queries.
--
-- USAGE INSTRUCTIONS:
-- 1. Update the variables below (lines 20-30) with your actual UUIDs
-- 2. Copy and run STEP 1-4 in your Supabase SQL editor
-- 3. Verify with the VERIFICATION QUERIES
-- 4. Test the conversion in the UI (click + on unassigned blocks)
-- 5. Run the CONVERSION TEST QUERIES to verify removal
-- 6. Use CLEANUP section to remove test data when done
--
-- ============================================================================

-- ============================================================================
-- CONFIGURATION: UPDATE THESE THREE VALUES WITH YOUR DATA
-- ============================================================================

-- 1. Get your user UUID:
--    SELECT id, email FROM users WHERE email = 'your_email@company.com';
-- Replace the UUID below:
\set test_user_id 'd3b0c4d2-5e1f-4a9c-b1d2-3e4f5a6b7c8d'

-- 2. Get your organization UUID:
--    SELECT id, org_name FROM organizations LIMIT 1;
-- Replace the UUID below:
\set test_org_id 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d'

-- 3. Choose a test date (today or specific date):
\set test_date '2026-04-17'

-- ============================================================================
-- STEP 1: VERIFY CONFIGURATION
-- ============================================================================

SELECT '✓ STEP 1: VERIFYING YOUR CONFIGURATION' as step;

-- Check that user exists
SELECT 
    CASE 
        WHEN COUNT(*) > 0 THEN '✓ User found: ' || email
        ELSE '✗ ERROR: User not found! Update test_user_id in configuration'
    END as user_check
FROM public.users 
WHERE id = :'test_user_id'::uuid
LIMIT 1;

-- Check that organization exists
SELECT 
    CASE 
        WHEN COUNT(*) > 0 THEN '✓ Organization found: ' || org_name
        ELSE '✗ ERROR: Organization not found! Update test_org_id in configuration'
    END as org_check
FROM public.organizations 
WHERE id = :'test_org_id'::uuid
LIMIT 1;

-- ============================================================================
-- STEP 2: CREATE TEST UNASSIGNED ACTIVITY RECORDS
-- ============================================================================

SELECT '✓ STEP 2: CREATING UNASSIGNED ACTIVITY RECORDS' as step;

-- Create 5 unassigned activity entries representing different work sessions
INSERT INTO public.unassigned_activity (
    user_id,
    organization_id,
    timestamp,
    window_title,
    application_name,
    time_spent_seconds,
    reason,
    detected_jira_keys,
    confidence_score,
    manually_assigned,
    created_at
) VALUES
(
    :'test_user_id'::uuid,
    :'test_org_id'::uuid,
    NOW() - INTERVAL '4 hours',
    'GitHub - Pull Requests #456',
    'Google Chrome',
    900, -- 15 minutes
    'Code Review PR #456',
    ARRAY['ATG-789'],
    0.95,
    false,
    NOW()
),
(
    :'test_user_id'::uuid,
    :'test_org_id'::uuid,
    NOW() - INTERVAL '3.5 hours',
    'GitHub - Pull Requests #457',
    'Google Chrome',
    900, -- 15 minutes
    'Code Review PR #457',
    ARRAY['ATG-790'],
    0.92,
    false,
    NOW()
),
(
    :'test_user_id'::uuid,
    :'test_org_id'::uuid,
    NOW() - INTERVAL '3 hours',
    'GitHub - Pull Requests #458',
    'Google Chrome',
    900, -- 15 minutes
    'Code Review PR #458',
    ARRAY['ATG-791'],
    0.90,
    false,
    NOW()
),
(
    :'test_user_id'::uuid,
    :'test_org_id'::uuid,
    NOW() - INTERVAL '2.5 hours',
    'Slack - engineering channel',
    'Google Chrome',
    600, -- 10 minutes (thin block test)
    'Team discussion',
    ARRAY[]::text[],
    0.85,
    false,
    NOW()
),
(
    :'test_user_id'::uuid,
    :'test_org_id'::uuid,
    NOW() - INTERVAL '2 hours',
    'Email - Client feedback',
    'Mozilla Firefox',
    1200, -- 20 minutes
    'Responding to client feedback',
    ARRAY['ATG-792'],
    0.88,
    false,
    NOW()
)
ON CONFLICT (analysis_result_id) DO NOTHING;

SELECT ROW_COUNT() || ' unassigned activity records created' as result;

-- ============================================================================
-- STEP 3: CREATE UNASSIGNED WORK GROUPS AND LINK MEMBERS
-- ============================================================================

SELECT '✓ STEP 3: CREATING UNASSIGNED WORK GROUPS' as step;

-- Create Group 1: Code Reviews
INSERT INTO public.unassigned_work_groups (
    user_id,
    organization_id,
    group_name,
    window_title_pattern,
    application_name,
    total_duration_seconds,
    activity_count,
    is_assigned,
    created_at
)
SELECT 
    :'test_user_id'::uuid,
    :'test_org_id'::uuid,
    'Code Review Sessions - Test Group 1',
    'GitHub - Pull%',
    'Google Chrome',
    2700, -- 3 × 900 seconds
    3,
    false,
    NOW()
WHERE NOT EXISTS (
    SELECT 1 FROM public.unassigned_work_groups 
    WHERE user_id = :'test_user_id'::uuid 
    AND group_name = 'Code Review Sessions - Test Group 1'
)
ON CONFLICT DO NOTHING;

-- Create Group 2: Communication & Feedback
INSERT INTO public.unassigned_work_groups (
    user_id,
    organization_id,
    group_name,
    window_title_pattern,
    application_name,
    total_duration_seconds,
    activity_count,
    is_assigned,
    created_at
)
SELECT 
    :'test_user_id'::uuid,
    :'test_org_id'::uuid,
    'Communication - Test Group 2',
    '%Slack%',
    'Google Chrome',
    1800, -- 600 + 1200 seconds
    2,
    false,
    NOW()
WHERE NOT EXISTS (
    SELECT 1 FROM public.unassigned_work_groups 
    WHERE user_id = :'test_user_id'::uuid 
    AND group_name = 'Communication - Test Group 2'
)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- STEP 4: LINK ACTIVITIES TO GROUPS (unassigned_group_members)
-- ============================================================================

SELECT '✓ STEP 4: LINKING ACTIVITIES TO GROUPS' as step;

-- Link Code Review activities to Group 1
WITH code_reviews AS (
    SELECT id FROM public.unassigned_activity 
    WHERE user_id = :'test_user_id'::uuid 
    AND organization_id = :'test_org_id'::uuid
    AND window_title LIKE 'GitHub - Pull%'
    ORDER BY created_at DESC 
    LIMIT 3
),
group1 AS (
    SELECT id FROM public.unassigned_work_groups 
    WHERE user_id = :'test_user_id'::uuid 
    AND group_name = 'Code Review Sessions - Test Group 1'
    ORDER BY created_at DESC 
    LIMIT 1
)
INSERT INTO public.unassigned_group_members (
    group_id,
    unassigned_activity_id,
    created_at
)
SELECT g.id, c.id, NOW()
FROM code_reviews c
CROSS JOIN group1 g
WHERE NOT EXISTS (
    SELECT 1 FROM public.unassigned_group_members 
    WHERE group_id = g.id AND unassigned_activity_id = c.id
)
ON CONFLICT (group_id, unassigned_activity_id) DO NOTHING;

-- Link Communication activities to Group 2
WITH comm_activities AS (
    SELECT id FROM public.unassigned_activity 
    WHERE user_id = :'test_user_id'::uuid 
    AND organization_id = :'test_org_id'::uuid
    AND (window_title LIKE '%Slack%' OR window_title LIKE '%Email%')
    ORDER BY created_at DESC 
    LIMIT 2
),
group2 AS (
    SELECT id FROM public.unassigned_work_groups 
    WHERE user_id = :'test_user_id'::uuid 
    AND group_name = 'Communication - Test Group 2'
    ORDER BY created_at DESC 
    LIMIT 1
)
INSERT INTO public.unassigned_group_members (
    group_id,
    unassigned_activity_id,
    created_at
)
SELECT g.id, c.id, NOW()
FROM comm_activities c
CROSS JOIN group2 g
WHERE NOT EXISTS (
    SELECT 1 FROM public.unassigned_group_members 
    WHERE group_id = g.id AND unassigned_activity_id = c.id
)
ON CONFLICT (group_id, unassigned_activity_id) DO NOTHING;

-- ============================================================================
-- STEP 5: CREATE TIMELINE ACTIVITY_RECORDS (UNASSIGNED)
-- ============================================================================

SELECT '✓ STEP 5: CREATING TIMELINE ACTIVITY_RECORDS' as step;

-- Create activity_records for timeline display (these are UNASSIGNED sessions)
INSERT INTO public.activity_records (
    user_id,
    organization_id,
    work_date,
    start_time,
    end_time,
    duration_seconds,
    total_time_seconds,
    window_title,
    application_name,
    user_assigned_issue_key,
    project_key,
    classification,
    status,
    created_at
) VALUES
-- Code Review sessions
(
    :'test_user_id'::uuid,
    :'test_org_id'::uuid,
    :'test_date'::date,
    :'test_date'::date + TIME '09:00:00',
    :'test_date'::date + TIME '09:15:00',
    900,
    900,
    'GitHub - Pull Request #456',
    'Google Chrome',
    NULL, -- UNASSIGNED
    NULL,
    'productive',
    'analyzed',
    NOW()
),
(
    :'test_user_id'::uuid,
    :'test_org_id'::uuid,
    :'test_date'::date,
    :'test_date'::date + TIME '09:30:00',
    :'test_date'::date + TIME '09:45:00',
    900,
    900,
    'GitHub - Pull Request #457',
    'Google Chrome',
    NULL, -- UNASSIGNED
    NULL,
    'productive',
    'analyzed',
    NOW()
),
(
    :'test_user_id'::uuid,
    :'test_org_id'::uuid,
    :'test_date'::date,
    :'test_date'::date + TIME '10:00:00',
    :'test_date'::date + TIME '10:15:00',
    900,
    900,
    'GitHub - Pull Request #458',
    'Google Chrome',
    NULL, -- UNASSIGNED
    NULL,
    'productive',
    'analyzed',
    NOW()
),
-- Slack session (thin block)
(
    :'test_user_id'::uuid,
    :'test_org_id'::uuid,
    :'test_date'::date,
    :'test_date'::date + TIME '10:30:00',
    :'test_date'::date + TIME '10:40:00',
    600,
    600,
    'Slack - engineering channel',
    'Google Chrome',
    NULL, -- UNASSIGNED
    NULL,
    'productive',
    'analyzed',
    NOW()
),
-- Email session
(
    :'test_user_id'::uuid,
    :'test_org_id'::uuid,
    :'test_date'::date,
    :'test_date'::date + TIME '11:00:00',
    :'test_date'::date + TIME '11:20:00',
    1200,
    1200,
    'Email - Client feedback',
    'Mozilla Firefox',
    NULL, -- UNASSIGNED
    NULL,
    'productive',
    'analyzed',
    NOW()
)
ON CONFLICT DO NOTHING;

SELECT ROW_COUNT() || ' activity_records created' as result;

-- ============================================================================
-- VERIFICATION: CHECK CREATED DATA
-- ============================================================================

SELECT '' as '';
SELECT '════════════════════════════════════════════════════════════════' as '';
SELECT 'VERIFICATION: TEST DATA CREATED SUCCESSFULLY' as '';
SELECT '════════════════════════════════════════════════════════════════' as '';
SELECT '' as '';

-- Verify Groups
SELECT 
    '📊 UNASSIGNED WORK GROUPS' as check_title,
    COUNT(*) as group_count
FROM public.unassigned_work_groups
WHERE user_id = :'test_user_id'::uuid
AND organization_id = :'test_org_id'::uuid
AND group_name LIKE '% - Test Group%';

-- Verify Activities
SELECT 
    '📝 UNASSIGNED ACTIVITY RECORDS' as check_title,
    COUNT(*) as activity_count
FROM public.unassigned_activity
WHERE user_id = :'test_user_id'::uuid
AND organization_id = :'test_org_id'::uuid;

-- Verify Group Members
SELECT 
    '🔗 GROUP MEMBERS LINKED' as check_title,
    COUNT(*) as members_count
FROM public.unassigned_group_members ugm
JOIN public.unassigned_work_groups uwg ON uwg.id = ugm.group_id
WHERE uwg.user_id = :'test_user_id'::uuid
AND uwg.organization_id = :'test_org_id'::uuid
AND uwg.group_name LIKE '% - Test Group%';

-- Verify Timeline Sessions
SELECT 
    '📅 TIMELINE UNASSIGNED SESSIONS' as check_title,
    COUNT(*) as session_count,
    SUM(duration_seconds) as total_seconds,
    (SUM(duration_seconds)::float / 60)::int as total_minutes
FROM public.activity_records
WHERE user_id = :'test_user_id'::uuid
AND organization_id = :'test_org_id'::uuid
AND work_date = :'test_date'::date
AND user_assigned_issue_key IS NULL;

SELECT '' as '';

-- ============================================================================
-- DETAILED VIEW: ALL TEST DATA
-- ============================================================================

SELECT '════════════════════════════════════════════════════════════════' as '';
SELECT 'DETAILED VIEW: ALL TEST DATA' as '';
SELECT '════════════════════════════════════════════════════════════════' as '';
SELECT '' as '';

-- View 1: Groups
SELECT 
    '1️⃣ UNASSIGNED WORK GROUPS' as heading,
    NULL::text as data_line
UNION ALL
SELECT 
    'Group Name',
    'Activities | Duration'
UNION ALL
SELECT 
    '─' || REPEAT('─', 50) as heading,
    NULL
UNION ALL
SELECT 
    group_name,
    activity_count || ' activities | ' || (total_duration_seconds / 60) || ' min'
FROM public.unassigned_work_groups
WHERE user_id = :'test_user_id'::uuid
AND organization_id = :'test_org_id'::uuid
AND group_name LIKE '% - Test Group%'
ORDER BY created_at;

-- View 2: Timeline Sessions
SELECT '' as '';
SELECT 
    '2️⃣ TIMELINE SESSIONS (UNASSIGNED)' as heading,
    NULL::text as data_line
UNION ALL
SELECT 
    'Time',
    'Application | Duration'
UNION ALL
SELECT 
    '─' || REPEAT('─', 50) as heading,
    NULL
UNION ALL
SELECT 
    TO_CHAR(start_time, 'HH24:MI') || ' - ' || TO_CHAR(end_time, 'HH24:MI'),
    application_name || ' | ' || (duration_seconds / 60) || ' min'
FROM public.activity_records
WHERE user_id = :'test_user_id'::uuid
AND organization_id = :'test_org_id'::uuid
AND work_date = :'test_date'::date
AND user_assigned_issue_key IS NULL
ORDER BY start_time;

SELECT '' as '';

-- ============================================================================
-- INSTRUCTIONS FOR TESTING CONVERSION
-- ============================================================================

SELECT '════════════════════════════════════════════════════════════════' as '';
SELECT 'HOW TO TEST THE CONVERSION FEATURE' as '';
SELECT '════════════════════════════════════════════════════════════════' as '';
SELECT '' as '';
SELECT '✅ 1. Go to Time Analytics > My Daily Timesheet' as instruction;
SELECT '✅ 2. Look for BLUE DOTTED blocks in the timeline (around 09:00-11:20)' as instruction;
SELECT '✅ 3. Hover over blue blocks and click the + button to convert' as instruction;
SELECT '✅ 4. In the modal: Create New Issue or Assign to Existing Issue' as instruction;
SELECT '✅ 5. Select a project (or existing issue) and save' as instruction;
SELECT '✅ 6. Blue blocks should disappear from timeline and turn green' as instruction;
SELECT '✅ 7. Sessions should also disappear from Unassigned Work page' as instruction;
SELECT '' as '';

-- ============================================================================
-- CONVERSION VERIFICATION QUERIES (Run AFTER conversion)
-- ============================================================================

SELECT '════════════════════════════════════════════════════════════════' as '';
SELECT 'VERIFICATION QUERIES (Run after converting)' as '';
SELECT '════════════════════════════════════════════════════════════════' as '';
SELECT '' as '';

-- Query A: How many sessions are still unassigned?
SELECT '🔍 Q1: Sessions Still Unassigned (should be 0 after conversion)' as query_title;
SELECT 
    COUNT(*) as still_unassigned_count,
    COALESCE(SUM(duration_seconds) / 60, 0)::int as unassigned_minutes
FROM public.activity_records
WHERE user_id = :'test_user_id'::uuid
AND organization_id = :'test_org_id'::uuid
AND work_date = :'test_date'::date
AND user_assigned_issue_key IS NULL;

-- Query B: View converted sessions
SELECT '' as '';
SELECT '🔍 Q2: Converted Sessions (should show issue keys after conversion)' as query_title;
SELECT 
    TO_CHAR(start_time, 'HH24:MI') as time,
    window_title,
    user_assigned_issue_key as assigned_to,
    project_key,
    (duration_seconds / 60)::int as minutes
FROM public.activity_records
WHERE user_id = :'test_user_id'::uuid
AND organization_id = :'test_org_id'::uuid
AND work_date = :'test_date'::date
AND user_assigned_issue_key IS NOT NULL
AND window_title LIKE '%GitHub%' OR window_title LIKE '%Slack%' OR window_title LIKE '%Email%'
ORDER BY start_time;

-- Query C: Check if group is marked as assigned
SELECT '' as '';
SELECT '🔍 Q3: Group Status (is_assigned should be TRUE after full conversion)' as query_title;
SELECT 
    group_name,
    activity_count,
    is_assigned,
    COALESCE(assigned_task_key, 'N/A') as assigned_to
FROM public.unassigned_work_groups
WHERE user_id = :'test_user_id'::uuid
AND organization_id = :'test_org_id'::uuid
AND group_name LIKE '% - Test Group%'
ORDER BY created_at;

-- Query D: Check remaining group members
SELECT '' as '';
SELECT '🔍 Q4: Group Members (should be 0 if all sessions converted)' as query_title;
WITH test_groups AS (
    SELECT id, group_name FROM public.unassigned_work_groups 
    WHERE user_id = :'test_user_id'::uuid 
    AND group_name LIKE '% - Test Group%'
)
SELECT 
    tg.group_name,
    COUNT(ugm.id) as remaining_members
FROM test_groups tg
LEFT JOIN public.unassigned_group_members ugm ON ugm.group_id = tg.id
GROUP BY tg.id, tg.group_name;

SELECT '' as '';

-- ============================================================================
-- CLEANUP: Remove test data (Uncomment to run)
-- ============================================================================

/*
SELECT '🗑️ CLEANUP: Removing all test data...' as status;

-- Step 1: Delete group members
DELETE FROM public.unassigned_group_members 
WHERE group_id IN (
    SELECT id FROM public.unassigned_work_groups
    WHERE user_id = :'test_user_id'::uuid
    AND organization_id = :'test_org_id'::uuid
    AND group_name LIKE '% - Test Group%'
);

-- Step 2: Delete groups
DELETE FROM public.unassigned_work_groups
WHERE user_id = :'test_user_id'::uuid
AND organization_id = :'test_org_id'::uuid
AND group_name LIKE '% - Test Group%';

-- Step 3: Delete activities
DELETE FROM public.unassigned_activity
WHERE user_id = :'test_user_id'::uuid
AND organization_id = :'test_org_id'::uuid
AND (window_title LIKE 'GitHub%' 
     OR window_title LIKE '%Slack%' 
     OR window_title LIKE '%Email%');

-- Step 4: Delete timeline records
DELETE FROM public.activity_records
WHERE user_id = :'test_user_id'::uuid
AND organization_id = :'test_org_id'::uuid
AND work_date = :'test_date'::date
AND (window_title LIKE 'GitHub%' 
     OR window_title LIKE '%Slack%' 
     OR window_title LIKE '%Email%')
AND user_assigned_issue_key IS NULL;

SELECT '✅ Test data cleaned up successfully!' as status;
*/
