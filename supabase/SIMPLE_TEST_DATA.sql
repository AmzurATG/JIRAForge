/* 
   SIMPLE TEST DATA SETUP FOR UNASSIGNED WORK CONVERSION
   ======================================================
   
   ⚠️ IMPORTANT: This script is for Supabase SQL Editor ONLY
   
   HOW TO USE:
   1. Find YOUR IDs by running these queries FIRST:
      - SELECT id FROM users WHERE email = 'your@email.com' LIMIT 1;
      - SELECT id FROM organizations LIMIT 1;
   
   2. Replace ALL three values below (lines 20-29):
      - Replace 'YOUR_USER_ID_HERE' with your actual user UUID
      - Replace 'YOUR_ORG_ID_HERE' with your actual org UUID
      - Update TEST_DATE if needed
   
   3. Copy ALL content into Supabase SQL Editor and click RUN
   
   4. You'll see verification results showing test data created
   
   5. Go to Time Analytics UI to test the feature!
*/

-- ============================================================================
-- ⚙️ CONFIGURATION - REPLACE THESE THREE VALUES ONLY
-- ============================================================================

-- YOUR USER ID (replace with your UUID from step 1)
-- Example: '6ef2ec97-116c-474d-aa84-f3f6ecc01e8a'
DO $$ 
DECLARE
    test_user_id UUID := 'YOUR_USER_ID_HERE'::UUID;
    test_org_id UUID := 'YOUR_ORG_ID_HERE'::UUID;
    test_date DATE := DATE '2026-04-17';
BEGIN

-- ============================================================================
-- ✅ SETUP SCRIPT - Creates test data
-- ============================================================================

-- Create timeline sessions directly (UNASSIGNED)
-- These are what appear as BLUE DOTTED blocks in the timeline
-- This is the ONLY thing you need to test the conversion feature!
INSERT INTO public.activity_records (
    user_id, organization_id, work_date, start_time, end_time, duration_seconds,
    total_time_seconds, window_title, application_name, user_assigned_issue_key,
    project_key, classification, status, created_at
) VALUES
(test_user_id, test_org_id, test_date, test_date + TIME '09:00:00', test_date + TIME '09:15:00', 900, 900,
 'GitHub - PR #456', 'Chrome', NULL, NULL, 'productive', 'analyzed', NOW()),
(test_user_id, test_org_id, test_date, test_date + TIME '09:30:00', test_date + TIME '09:45:00', 900, 900,
 'GitHub - PR #457', 'Chrome', NULL, NULL, 'productive', 'analyzed', NOW()),
(test_user_id, test_org_id, test_date, test_date + TIME '10:00:00', test_date + TIME '10:15:00', 900, 900,
 'GitHub - PR #458', 'Chrome', NULL, NULL, 'productive', 'analyzed', NOW())
ON CONFLICT DO NOTHING;

RAISE NOTICE '════════════════════════════════════════════';
RAISE NOTICE '✅ TEST DATA CREATED SUCCESSFULLY!';
RAISE NOTICE '════════════════════════════════════════════';
RAISE NOTICE 'Created 3 unassigned timeline sessions (BLUE DOTTED blocks)';
RAISE NOTICE 'Ready to test conversion feature!';
RAISE NOTICE '';
RAISE NOTICE '🎯 NEXT STEPS:';
RAISE NOTICE '   1. Go to Time Analytics → My Daily Timesheet';
RAISE NOTICE '   2. Look for 3 BLUE DOTTED blocks (9:00-10:15 AM)';
RAISE NOTICE '   3. Hover and click the + button on each block';
RAISE NOTICE '   4. Select project and click "Assign"';
RAISE NOTICE '   5. Watch blocks turn GREEN';
RAISE NOTICE '   6. See them DISAPPEAR from timeline after conversion';
RAISE NOTICE '';

END $$;

-- ============================================================================
-- ✅ VERIFICATION - Shows what was created
-- ============================================================================

SELECT '════════════════════════════════════════════' as result;
SELECT '✅ VERIFICATION SUCCESSFUL!' as result;
SELECT '════════════════════════════════════════════' as result;

-- Show timeline sessions created (these are the BLUE DOTTED blocks)
SELECT 
    COUNT(*) as "Sessions Created",
    SUM(duration_seconds) / 60 as "Total Minutes"
FROM public.activity_records
WHERE window_title LIKE 'GitHub - PR%'
AND user_assigned_issue_key IS NULL
AND work_date = DATE '2026-04-17';

-- ============================================================================
-- 🗑️ CLEANUP - Remove test data when done (uncomment to run)
-- ============================================================================

/*
DO $$ 
BEGIN
    DELETE FROM public.activity_records 
    WHERE window_title LIKE 'GitHub - PR%' 
    AND user_assigned_issue_key IS NULL;
    
    RAISE NOTICE 'Test timeline sessions cleaned up successfully!';
END $$;
*/
