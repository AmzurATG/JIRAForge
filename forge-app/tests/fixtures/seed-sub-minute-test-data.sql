-- =============================================================================
-- Seed sub-minute unassigned work groups for testing
-- User: iswarya.kolimalla (dd980fc2-253b-4ee1-af4f-60835e75844b)
-- Org:  d6ca6176-b92e-470c-82a7-4d27b214b696
--
-- Run this in Supabase SQL Editor or DBeaver to create test data.
-- After testing, run the cleanup block at the bottom to remove test data.
-- =============================================================================

DO $$
DECLARE
  v_user_id  UUID := 'dd980fc2-253b-4ee1-af4f-60835e75844b';
  v_org_id   UUID := 'd6ca6176-b92e-470c-82a7-4d27b214b696';

  -- Activity record IDs (generated UUIDs)
  v_ar1 UUID := gen_random_uuid();
  v_ar2 UUID := gen_random_uuid();
  v_ar3 UUID := gen_random_uuid();
  v_ar4 UUID := gen_random_uuid();
  v_ar5 UUID := gen_random_uuid();

  -- Group IDs
  v_group1 UUID;
  v_group2 UUID;
  v_group3 UUID;
BEGIN

  -- =========================================================================
  -- Step 1: Create activity_records (the raw tracked activities)
  -- =========================================================================

  -- Activity 1: 8 seconds on Calculator (sub-minute)
  INSERT INTO activity_records (
    id, user_id, organization_id, window_title, application_name,
    classification, start_time, end_time, duration_seconds, status
  ) VALUES (
    v_ar1, v_user_id, v_org_id,
    'Calculator', 'Calculator.exe',
    'productive',
    NOW() - INTERVAL '2 hours',
    NOW() - INTERVAL '2 hours' + INTERVAL '8 seconds',
    8, 'analyzed'
  );

  -- Activity 2: 15 seconds on Notepad (sub-minute)
  INSERT INTO activity_records (
    id, user_id, organization_id, window_title, application_name,
    classification, start_time, end_time, duration_seconds, status
  ) VALUES (
    v_ar2, v_user_id, v_org_id,
    'Untitled - Notepad', 'notepad.exe',
    'productive',
    NOW() - INTERVAL '1 hour 50 minutes',
    NOW() - INTERVAL '1 hour 50 minutes' + INTERVAL '15 seconds',
    15, 'analyzed'
  );

  -- Activity 3: 25 seconds on Chrome - Jira (sub-minute)
  INSERT INTO activity_records (
    id, user_id, organization_id, window_title, application_name,
    classification, start_time, end_time, duration_seconds, status
  ) VALUES (
    v_ar3, v_user_id, v_org_id,
    'ESW-5717 Sprint | Internal meetings - Jira', 'chrome.exe',
    'productive',
    NOW() - INTERVAL '1 hour 40 minutes',
    NOW() - INTERVAL '1 hour 40 minutes' + INTERVAL '25 seconds',
    25, 'analyzed'
  );

  -- Activity 4: 45 seconds on VS Code (sub-minute)
  INSERT INTO activity_records (
    id, user_id, organization_id, window_title, application_name,
    classification, start_time, end_time, duration_seconds, status
  ) VALUES (
    v_ar4, v_user_id, v_org_id,
    'desktop_app.py - JIRAForge - Visual Studio Code', 'Code.exe',
    'productive',
    NOW() - INTERVAL '1 hour 30 minutes',
    NOW() - INTERVAL '1 hour 30 minutes' + INTERVAL '45 seconds',
    45, 'analyzed'
  );

  -- Activity 5: 5 seconds on DBeaver (sub-minute)
  INSERT INTO activity_records (
    id, user_id, organization_id, window_title, application_name,
    classification, start_time, end_time, duration_seconds, status
  ) VALUES (
    v_ar5, v_user_id, v_org_id,
    'activity_records - DBeaver', 'dbeaver.exe',
    'productive',
    NOW() - INTERVAL '1 hour 20 minutes',
    NOW() - INTERVAL '1 hour 20 minutes' + INTERVAL '5 seconds',
    5, 'analyzed'
  );

  -- =========================================================================
  -- Step 2: Create unassigned_work_groups (what appears in the UI)
  -- =========================================================================

  -- Group 1: 8 seconds — Calculator Usage (single activity, very short)
  INSERT INTO unassigned_work_groups (
    user_id, organization_id, group_label, group_description,
    confidence_level, recommended_action, recommendation_reason,
    session_count, total_seconds, is_assigned, is_dismissed,
    clustering_metadata
  ) VALUES (
    v_user_id, v_org_id,
    'Calculator Usage',
    'Using the calculator application for calculations.',
    'medium', 'create_new_issue',
    'Quick calculation task — too brief for existing issue match.',
    1, 8, false, false,
    '{"test_data": true, "purpose": "sub-minute worklog test"}'::jsonb
  ) RETURNING id INTO v_group1;

  -- Group 2: 40 seconds — Quick Jira + Notes (two activities combined)
  INSERT INTO unassigned_work_groups (
    user_id, organization_id, group_label, group_description,
    confidence_level, recommended_action, suggested_issue_key,
    recommendation_reason,
    session_count, total_seconds, is_assigned, is_dismissed,
    clustering_metadata
  ) VALUES (
    v_user_id, v_org_id,
    'Jira Review & Notes',
    'Reviewed Jira sprint board and took notes in Notepad.',
    'high', 'assign_to_existing', 'ESW-5717',
    'Activity matches sprint planning issue ESW-5717.',
    2, 40, false, false,
    '{"test_data": true, "purpose": "sub-minute worklog test"}'::jsonb
  ) RETURNING id INTO v_group2;

  -- Group 3: 50 seconds — Code Review + DB Check (two activities)
  INSERT INTO unassigned_work_groups (
    user_id, organization_id, group_label, group_description,
    confidence_level, recommended_action,
    recommendation_reason,
    session_count, total_seconds, is_assigned, is_dismissed,
    clustering_metadata
  ) VALUES (
    v_user_id, v_org_id,
    'Code Review & DB Check',
    'Quick code review in VS Code and database check in DBeaver.',
    'medium', 'create_new_issue',
    'Brief development activity across two tools.',
    2, 50, false, false,
    '{"test_data": true, "purpose": "sub-minute worklog test"}'::jsonb
  ) RETURNING id INTO v_group3;

  -- =========================================================================
  -- Step 3: Link activity_records to groups via unassigned_group_members
  -- =========================================================================

  -- Group 1 members (Calculator — 8s)
  INSERT INTO unassigned_group_members (group_id, activity_record_id)
  VALUES (v_group1, v_ar1);

  -- Group 2 members (Jira 25s + Notepad 15s = 40s)
  INSERT INTO unassigned_group_members (group_id, activity_record_id)
  VALUES (v_group2, v_ar2);
  INSERT INTO unassigned_group_members (group_id, activity_record_id)
  VALUES (v_group2, v_ar3);

  -- Group 3 members (VS Code 45s + DBeaver 5s = 50s)
  INSERT INTO unassigned_group_members (group_id, activity_record_id)
  VALUES (v_group3, v_ar4);
  INSERT INTO unassigned_group_members (group_id, activity_record_id)
  VALUES (v_group3, v_ar5);

  RAISE NOTICE '✅ Created 5 activity_records and 3 sub-minute unassigned groups for iswarya.kolimalla';
  RAISE NOTICE '   Group 1: "Calculator Usage" — 8s (1 session)';
  RAISE NOTICE '   Group 2: "Jira Review & Notes" — 40s (2 sessions)';
  RAISE NOTICE '   Group 3: "Code Review & DB Check" — 50s (2 sessions)';
  RAISE NOTICE '   All groups are under 60 seconds to test the fix.';
END $$;


-- =============================================================================
-- CLEANUP (run this after testing to remove the test data)
-- =============================================================================
-- DELETE FROM unassigned_group_members
--   WHERE group_id IN (
--     SELECT id FROM unassigned_work_groups
--     WHERE user_id = 'dd980fc2-253b-4ee1-af4f-60835e75844b'
--       AND clustering_metadata->>'test_data' = 'true'
--   );
--
-- DELETE FROM unassigned_work_groups
--   WHERE user_id = 'dd980fc2-253b-4ee1-af4f-60835e75844b'
--     AND clustering_metadata->>'test_data' = 'true';
--
-- DELETE FROM activity_records
--   WHERE user_id = 'dd980fc2-253b-4ee1-af4f-60835e75844b'
--     AND window_title IN ('Calculator', 'Untitled - Notepad',
--         'ESW-5717 Sprint | Internal meetings - Jira',
--         'desktop_app.py - JIRAForge - Visual Studio Code',
--         'activity_records - DBeaver')
--     AND duration_seconds < 60;
