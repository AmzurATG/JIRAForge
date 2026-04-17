/* 
   VERIFICATION QUERIES FOR UNASSIGNED WORK CONVERSION
   ====================================================
   
   Use these queries AFTER testing the conversion to verify
   that the feature is working correctly.
   
   IMPORTANT: Update the TEST_USER and TEST_ORG variables with YOUR values
              before running these queries.
*/

-- ============================================================================
-- ⚙️ CONFIGURATION - Update these values
-- ============================================================================

\set TEST_USER 'YOUR_USER_ID_HERE'
\set TEST_ORG 'YOUR_ORG_ID_HERE'
\set TEST_DATE '2026-04-17'

-- ============================================================================
-- BEFORE CONVERSION - Run this first to see baseline
-- ============================================================================

SELECT '════════════════════════════════════════════════════════════════' as '';
SELECT 'BEFORE CONVERSION - BASELINE DATA' as '';
SELECT '════════════════════════════════════════════════════════════════' as '';

-- Check 1: Unassigned sessions count
SELECT 'Unassigned Sessions in Timeline' as metric,
       COUNT(*) as count,
       SUM(duration_seconds) / 60 as total_minutes
FROM public.activity_records
WHERE user_id = :'TEST_USER'::uuid
AND organization_id = :'TEST_ORG'::uuid
AND work_date = :'TEST_DATE'::date
AND user_assigned_issue_key IS NULL;

-- Check 2: Unassigned work groups
SELECT 'Groups with Unassigned Sessions' as metric,
       COUNT(*) as count
FROM public.unassigned_work_groups
WHERE user_id = :'TEST_USER'::uuid
AND organization_id = :'TEST_ORG'::uuid
AND is_assigned = false;

-- Check 3: Group members
SELECT 'Group Members Linked' as metric,
       COUNT(*) as count
FROM public.unassigned_group_members ugm
JOIN public.unassigned_work_groups uwg ON uwg.id = ugm.group_id
WHERE uwg.user_id = :'TEST_USER'::uuid;

SELECT '' as '';

-- ============================================================================
-- CONVERSION TEST - Run this after converting sessions
-- ============================================================================

SELECT '════════════════════════════════════════════════════════════════' as '';
SELECT 'AFTER CONVERSION - VERIFICATION' as '';
SELECT '════════════════════════════════════════════════════════════════' as '';

-- Verify 1: Converted Sessions (should show issue keys)
SELECT 'ℹ️ CONVERTED SESSIONS - Should show issue keys now':
SELECT 
    TO_CHAR(start_time, 'HH24:MI') as time,
    window_title,
    user_assigned_issue_key as "assigned_to",
    project_key as "project",
    duration_seconds / 60 as minutes
FROM public.activity_records
WHERE user_id = :'TEST_USER'::uuid
AND organization_id = :'TEST_ORG'::uuid
AND work_date = :'TEST_DATE'::date
AND user_assigned_issue_key IS NOT NULL
AND window_title LIKE '%GitHub%'
ORDER BY start_time;

-- Verify 2: Remaining unassigned (should be 0 or fewer)
SELECT '' as '';
SELECT '✅ REMAINING UNASSIGNED - Should be 0' as check_title;
SELECT 
    COUNT(*) as unassigned_remaining,
    COALESCE(SUM(duration_seconds) / 60, 0) as total_minutes
FROM public.activity_records
WHERE user_id = :'TEST_USER'::uuid
AND organization_id = :'TEST_ORG'::uuid
AND work_date = :'TEST_DATE'::date
AND user_assigned_issue_key IS NULL;

-- Verify 3: Group status
SELECT '' as '';
SELECT '🔍 GROUP STATUS - Should be marked "assigned"' as check_title;
SELECT 
    group_name,
    activity_count,
    CASE WHEN is_assigned THEN '✅ Yes' ELSE '❌ No' END as is_assigned,
    COALESCE(assigned_task_key, 'N/A') as assigned_to
FROM public.unassigned_work_groups
WHERE user_id = :'TEST_USER'::uuid
AND organization_id = :'TEST_ORG'::uuid
AND group_name LIKE '%Test%';

-- Verify 4: Group members remaining
SELECT '' as '';
SELECT '🔗 GROUP MEMBERS - Should be 0 after full conversion' as check_title;
WITH test_groups AS (
    SELECT id, group_name FROM public.unassigned_work_groups 
    WHERE user_id = :'TEST_USER'::uuid 
    AND group_name LIKE '%Test%'
)
SELECT 
    tg.group_name,
    COUNT(ugm.id) as remaining_members
FROM test_groups tg
LEFT JOIN public.unassigned_group_members ugm ON ugm.group_id = tg.id
GROUP BY tg.id, tg.group_name;

SELECT '' as '';

-- ============================================================================
-- DETAILED CONVERSION AUDIT
-- ============================================================================

SELECT '════════════════════════════════════════════════════════════════' as '';
SELECT 'DETAILED CONVERSION AUDIT' as '';
SELECT '════════════════════════════════════════════════════════════════' as '';

-- Show all sessions with their conversion status
SELECT 'TIMELINE SESSION DETAILS' as section;
SELECT 
    TO_CHAR(start_time, 'HH24:MI') as "Time",
    window_title as "Session",
    CASE 
        WHEN user_assigned_issue_key IS NULL THEN '❌ Unassigned'
        ELSE '✅ ' || user_assigned_issue_key
    END as "Status",
    project_key as "Project",
    (duration_seconds / 60)::int as "Min"
FROM public.activity_records
WHERE user_id = :'TEST_USER'::uuid
AND organization_id = :'TEST_ORG'::uuid
AND work_date = :'TEST_DATE'::date
AND window_title LIKE '%GitHub%'
ORDER BY start_time;

SELECT '' as '';

-- ============================================================================
-- SUCCESS CRITERIA
-- ============================================================================

SELECT '════════════════════════════════════════════════════════════════' as '';
SELECT 'SUCCESS VERIFICATION' as '';
SELECT '════════════════════════════════════════════════════════════════' as '';

WITH before_after AS (
    SELECT 
        'Unassigned Sessions' as metric,
        (SELECT COUNT(*) FROM public.activity_records 
         WHERE user_id = :'TEST_USER'::uuid 
         AND organization_id = :'TEST_ORG'::uuid
         AND work_date = :'TEST_DATE'::date
         AND user_assigned_issue_key IS NULL) as remaining,
        3 as expected_after_conversion
),
conversion_check AS (
    SELECT 
        CASE 
            WHEN (SELECT COUNT(*) FROM public.activity_records 
                  WHERE user_id = :'TEST_USER'::uuid 
                  AND organization_id = :'TEST_ORG'::uuid
                  AND work_date = :'TEST_DATE'::date
                  AND user_assigned_issue_key IS NOT NULL
                  AND window_title LIKE '%GitHub%') >= 1
            THEN '✅ PASS - At least 1 session converted'
            ELSE '❌ FAIL - No sessions converted'
        END as conversion_status
)
SELECT 
    CASE 
        WHEN (SELECT remaining FROM before_after) = 0 
        THEN '✅ PASS - All sessions converted' 
        ELSE '⚠️  WARNING - ' || (SELECT remaining FROM before_after)::text || ' sessions still unassigned'
    END as result_1
UNION ALL
SELECT (SELECT conversion_status FROM conversion_check);

SELECT '' as '';
SELECT '════════════════════════════════════════════════════════════════' as '';
SELECT 'INTERPRETATION:' as '';
SELECT '════════════════════════════════════════════════════════════════' as '';
SELECT '' as '';
SELECT '✅ If you see:' as '';
SELECT '   • "0 unassigned remaining"' as '';
SELECT '   • All sessions have issue keys' as '';
SELECT '   • Group members count = 0' as '';
SELECT '   • is_assigned = true' as '';
SELECT '' as '';
SELECT 'Then the conversion worked perfectly! 🎉' as '';
SELECT '' as '';

-- ============================================================================
-- DEBUG INFO (if something goes wrong)
-- ============================================================================

/*
SELECT '════════════════════════════════════════════════════════════════' as '';
SELECT 'DEBUG: ALL SESSIONS IN DETAIL' as '';
SELECT '════════════════════════════════════════════════════════════════' as '';

SELECT 
    id,
    TO_CHAR(start_time, 'YYYY-MM-DD HH24:MI:SS') as start_time,
    window_title,
    user_assigned_issue_key,
    project_key,
    duration_seconds,
    classification,
    status,
    TO_CHAR(created_at, 'YYYY-MM-DD HH24:MI:SS') as created_at
FROM public.activity_records
WHERE user_id = :'TEST_USER'::uuid
AND organization_id = :'TEST_ORG'::uuid
AND work_date = :'TEST_DATE'::date
ORDER BY start_time;
*/
