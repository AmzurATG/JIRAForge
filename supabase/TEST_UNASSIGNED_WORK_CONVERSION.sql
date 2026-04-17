-- ============================================================================
-- Test Unassigned Work Conversion Feature
-- ============================================================================
-- This script creates test data for the unassigned work timeline conversion feature.
-- 
-- What it does:
-- 1. Creates test unassigned work groups with multiple sessions
-- 2. Creates unassigned activity entries
-- 3. Creates unassigned group members to link activities to groups
-- 4. Creates activity_records for the sessions (unassigned)
-- 5. Provides verification queries to test conversion
--
-- IMPORTANT: Update these values with YOUR actual data:
-- - @test_user_id: UUID of the test user (from users table)
-- - @test_org_id: UUID of the test organization (from organizations table)
-- - @test_date: Date to use for test sessions (e.g., '2026-04-17')
--
-- ============================================================================

-- ============================================================================
-- STEP 1: Define Variables (UPDATE THESE WITH YOUR DATA)
-- ============================================================================

-- Get a test user (or replace with specific UUID)
-- SELECT id FROM users WHERE email = 'your_email@company.com' LIMIT 1;
\set test_user_id 'd3b0c4d2-5e1f-4a9c-b1d2-3e4f5a6b7c8d'::uuid

-- Get a test organization
-- SELECT id FROM organizations LIMIT 1;
\set test_org_id 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d'::uuid

-- Test date (today or any date you want to test)
\set test_date '2026-04-17'

-- Test user ID for display
\set test_display_user 'iswarya.kolimalla'

-- ============================================================================
-- STEP 2: CREATE TEST UNASSIGNED ACTIVITY RECORDS
-- ============================================================================

-- First, check if we have the test data we need
SELECT 'CHECKING TEST DATA PREREQUISITES' as status;
SELECT COUNT(*) as user_count FROM users WHERE id = :'test_user_id';
SELECT COUNT(*) as org_count FROM organizations WHERE id = :'test_org_id';

-- Create 4 unassigned activity sessions
-- Group 1: Code Review sessions (3 sessions, 15 mins each)
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
        NOW() - INTERVAL '3 hours',
        'GitHub - Pull Requests',
        'Google Chrome',
        900, -- 15 mins
        'Reviewing PR #456',
        ARRAY['PROJ-789'],
        0.95,
        false,
        NOW()
    ),
    (
        :'test_user_id'::uuid,
        :'test_org_id'::uuid,
        NOW() - INTERVAL '2.5 hours',
        'GitHub - Pull Requests',
        'Google Chrome',
        900, -- 15 mins
        'Reviewing PR #457',
        ARRAY['PROJ-790'],
        0.92,
        false,
        NOW()
    ),
    (
        :'test_user_id'::uuid,
        :'test_org_id'::uuid,
        NOW() - INTERVAL '2 hours',
        'GitHub - Pull Requests',
        'Google Chrome',
        900, -- 15 mins
        'Reviewing PR #458',
        ARRAY['PROJ-791'],
        0.90,
        false,
        NOW()
    )
ON CONFLICT DO NOTHING;

-- Store the created unassigned activity IDs for later use
WITH test_activities AS (
    SELECT id FROM public.unassigned_activity 
    WHERE user_id = :'test_user_id'::uuid 
    AND organization_id = :'test_org_id'::uuid
    AND window_title = 'GitHub - Pull Requests'
    ORDER BY created_at DESC 
    LIMIT 3
)
-- Create unassigned work group 1: "Code Review Sessions"
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
    'Code Review Sessions',
    'GitHub%',
    'Google Chrome',
    2700, -- 45 mins (3 × 15 mins)
    3,
    false,
    NOW()
WHERE NOT EXISTS (
    SELECT 1 FROM public.unassigned_work_groups 
    WHERE user_id = :'test_user_id'::uuid 
    AND group_name = 'Code Review Sessions'
)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- STEP 3: CREATE UNASSIGNED GROUP MEMBERS (Link activities to groups)
-- ============================================================================

-- Link the unassigned activities to the group
WITH test_activities AS (
    SELECT id FROM public.unassigned_activity 
    WHERE user_id = :'test_user_id'::uuid 
    AND organization_id = :'test_org_id'::uuid
    AND window_title = 'GitHub - Pull Requests'
    ORDER BY created_at DESC 
    LIMIT 3
),
test_group AS (
    SELECT id FROM public.unassigned_work_groups 
    WHERE user_id = :'test_user_id'::uuid 
    AND group_name = 'Code Review Sessions'
    ORDER BY created_at DESC 
    LIMIT 1
)
INSERT INTO public.unassigned_group_members (
    group_id,
    unassigned_activity_id,
    created_at
)
SELECT tg.id, ta.id, NOW()
FROM test_activities ta
CROSS JOIN test_group tg
WHERE NOT EXISTS (
    SELECT 1 FROM public.unassigned_group_members 
    WHERE group_id = tg.id 
    AND unassigned_activity_id = ta.id
)
ON CONFLICT DO NOTHING;

-- ============================================================================
-- STEP 4: CREATE ACTIVITY_RECORDS (Timeline sessions without issue assignment)
-- ============================================================================

-- Create activity_records entries for the unassigned sessions
-- These will appear in the timeline as unassigned blocks
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
    (
        :'test_user_id'::uuid,
        :'test_org_id'::uuid,
        :'test_date'::date,
        :'test_date'::date + TIME '09:00:00',
        :'test_date'::date + TIME '09:15:00',
        900, -- 15 mins
        900,
        'GitHub - Pull Request #456',
        'Google Chrome',
        NULL, -- UNASSIGNED - no issue key
        NULL, -- no project key yet
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
    (
        :'test_user_id'::uuid,
        :'test_org_id'::uuid,
        :'test_date'::date,
        :'test_date'::date + TIME '10:30:00',
        :'test_date'::date + TIME '10:40:00',
        600, -- 10 mins (thin block)
        600,
        'Slack - General',
        'Google Chrome',
        NULL, -- UNASSIGNED
        NULL,
        'productive',
        'analyzed',
        NOW()
    )
ON CONFLICT DO NOTHING;

-- ============================================================================
-- VERIFICATION QUERIES
-- ============================================================================

SELECT '============================================' as '';
SELECT 'VERIFICATION QUERIES - RUN THESE TO VERIFY' as '';
SELECT '============================================' as '';

-- Query 1: View all unassigned work groups for the test user
SELECT '--- 1. UNASSIGNED WORK GROUPS ---' as '';
SELECT 
    id,
    group_name,
    window_title_pattern,
    application_name,
    activity_count,
    total_duration_seconds,
    is_assigned,
    created_at
FROM public.unassigned_work_groups
WHERE user_id = :'test_user_id'::uuid
AND organization_id = :'test_org_id'::uuid
ORDER BY created_at DESC;

-- Query 2: View unassigned activity entries
SELECT '--- 2. UNASSIGNED ACTIVITY ENTRIES ---' as '';
SELECT 
    ua.id,
    ua.window_title,
    ua.application_name,
    ua.time_spent_seconds,
    ua.manually_assigned,
    ua.created_at
FROM public.unassigned_activity ua
WHERE ua.user_id = :'test_user_id'::uuid
AND ua.organization_id = :'test_org_id'::uuid
ORDER BY ua.created_at DESC;

-- Query 3: View group members (activities linked to groups)
SELECT '--- 3. UNASSIGNED GROUP MEMBERS ---' as '';
SELECT 
    ugm.id,
    ugm.group_id,
    uwg.group_name,
    ugm.unassigned_activity_id,
    ua.window_title,
    ua.time_spent_seconds,
    ugm.created_at
FROM public.unassigned_group_members ugm
JOIN public.unassigned_work_groups uwg ON uwg.id = ugm.group_id
JOIN public.unassigned_activity ua ON ua.id = ugm.unassigned_activity_id
WHERE uwg.user_id = :'test_user_id'::uuid
ORDER BY ugm.created_at DESC;

-- Query 4: View unassigned activity_records (timeline sessions)
SELECT '--- 4. UNASSIGNED ACTIVITY_RECORDS (TIMELINE SESSIONS) ---' as '';
SELECT 
    id,
    work_date,
    start_time,
    end_time,
    duration_seconds,
    window_title,
    application_name,
    user_assigned_issue_key,
    project_key,
    classification,
    status
FROM public.activity_records
WHERE user_id = :'test_user_id'::uuid
AND organization_id = :'test_org_id'::uuid
AND work_date = :'test_date'::date
AND user_assigned_issue_key IS NULL -- Only unassigned
ORDER BY start_time ASC;

-- ============================================================================
-- CONVERSION TEST QUERIES
-- ============================================================================

SELECT '============================================' as '';
SELECT 'AFTER CONVERSION - RUN THESE TO VERIFY REMOVAL' as '';
SELECT '============================================' as '';

-- Query 5A: Check if sessions are still unassigned (BEFORE conversion)
SELECT '--- 5A. BEFORE CONVERSION: Unassigned Sessions in Timeline ---' as '';
SELECT 
    COUNT(*) as unassigned_session_count,
    SUM(duration_seconds) as total_unassigned_seconds
FROM public.activity_records
WHERE user_id = :'test_user_id'::uuid
AND organization_id = :'test_org_id'::uuid
AND work_date = :'test_date'::date
AND user_assigned_issue_key IS NULL;

-- Query 5B: Check if sessions are assigned (AFTER conversion)
SELECT '--- 5B. AFTER CONVERSION: Assigned Sessions in Timeline ---' as '';
SELECT 
    id,
    start_time,
    end_time,
    duration_seconds,
    window_title,
    user_assigned_issue_key,
    project_key
FROM public.activity_records
WHERE user_id = :'test_user_id'::uuid
AND organization_id = :'test_org_id'::uuid
AND work_date = :'test_date'::date
AND user_assigned_issue_key IS NOT NULL
ORDER BY start_time ASC;

-- Query 5C: Check if group members are removed (AFTER conversion)
SELECT '--- 5C. AFTER CONVERSION: Group Members Remaining ---' as '';
WITH test_group AS (
    SELECT id FROM public.unassigned_work_groups 
    WHERE user_id = :'test_user_id'::uuid 
    AND group_name = 'Code Review Sessions'
)
SELECT 
    COUNT(*) as remaining_members
FROM public.unassigned_group_members
WHERE group_id = (SELECT id FROM test_group LIMIT 1);

-- Query 5D: Check if group is marked as assigned (AFTER full conversion)
SELECT '--- 5D. AFTER CONVERSION: Group Status ---' as '';
SELECT 
    id,
    group_name,
    activity_count,
    is_assigned,
    assigned_task_key,
    assigned_at
FROM public.unassigned_work_groups
WHERE user_id = :'test_user_id'::uuid
AND group_name = 'Code Review Sessions'
ORDER BY created_at DESC;

-- ============================================================================
-- CLEANUP SCRIPT (Uncomment to remove test data)
-- ============================================================================
/*
-- CLEANUP: Run this to remove all test data

-- Delete group members first (FK dependency)
DELETE FROM public.unassigned_group_members 
WHERE group_id IN (
    SELECT id FROM public.unassigned_work_groups
    WHERE user_id = :'test_user_id'::uuid
    AND organization_id = :'test_org_id'::uuid
);

-- Delete unassigned work groups
DELETE FROM public.unassigned_work_groups
WHERE user_id = :'test_user_id'::uuid
AND organization_id = :'test_org_id'::uuid;

-- Delete unassigned activities
DELETE FROM public.unassigned_activity
WHERE user_id = :'test_user_id'::uuid
AND organization_id = :'test_org_id'::uuid
AND window_title = 'GitHub - Pull Requests';

-- Delete activity_records (timeline sessions)
DELETE FROM public.activity_records
WHERE user_id = :'test_user_id'::uuid
AND organization_id = :'test_org_id'::uuid
AND work_date = :'test_date'::date
AND window_title LIKE 'GitHub%'
AND user_assigned_issue_key IS NULL;

SELECT 'Test data cleaned up successfully' as status;
*/
