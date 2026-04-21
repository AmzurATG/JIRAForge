-- =============================================================================
-- Seed idle unassigned work groups for testing the Idle Sessions tab
-- on the Unassigned Work page.
--
-- This creates:
--   3 idle activity_records  (is_idle = true)  → 2 idle groups
--   3 work activity_records  (is_idle = false) → 1 work group (for contrast)
--
-- HOW TO RUN:
--   1. Open Supabase Dashboard → SQL Editor → New query
--   2. Run the lookup query below to get your user_id and org_id
--   3. Replace <USER_ID> and <ORG_ID> with your actual values
--   4. Run the DO $$ block
--
-- CLEANUP: Uncomment and run the DELETE block at the bottom when done.
-- =============================================================================

-- ── Step 1: Look up your user_id and organization_id ──────────────────────────
SELECT DISTINCT
  u.id              AS user_id,
  u.display_name,
  o.id              AS org_id,
  o.jira_cloud_id
FROM users u
JOIN organizations o ON o.id = u.organization_id
LIMIT 5;

-- ── Step 2: Replace <USER_ID> and <ORG_ID> below, then run ───────────────────

DO $$
DECLARE
  v_user_id UUID := '<USER_ID>';   -- ← paste your user_id here
  v_org_id  UUID := '<ORG_ID>';    -- ← paste your org_id  here

  -- Idle activity record IDs
  v_idle1 UUID := gen_random_uuid();
  v_idle2 UUID := gen_random_uuid();
  v_idle3 UUID := gen_random_uuid();

  -- Work activity record IDs (for contrast)
  v_work1 UUID := gen_random_uuid();
  v_work2 UUID := gen_random_uuid();
  v_work3 UUID := gen_random_uuid();

  -- Group IDs
  v_idle_group1 UUID;
  v_idle_group2 UUID;
  v_work_group1 UUID;
BEGIN

  -- ===========================================================================
  -- IDLE activity_records (is_idle = true)
  -- ===========================================================================

  -- Idle record 1: 15-minute idle block this morning
  INSERT INTO activity_records (
    id, user_id, organization_id,
    window_title, application_name,
    classification, is_idle,
    idle_start_time, idle_end_time,
    start_time, end_time,
    duration_seconds, total_time_seconds,
    work_date, status,
    metadata, created_at, updated_at
  ) VALUES (
    v_idle1, v_user_id, v_org_id,
    '[Idle: idle timeout]', 'System',
    'idle', TRUE,
    (CURRENT_DATE + INTERVAL '9 hours')::timestamptz,
    (CURRENT_DATE + INTERVAL '9 hours 15 minutes')::timestamptz,
    (CURRENT_DATE + INTERVAL '9 hours')::timestamptz,
    (CURRENT_DATE + INTERVAL '9 hours 15 minutes')::timestamptz,
    900, 900,
    CURRENT_DATE, 'analyzed',
    '{"idle_reason": "idle timeout", "test_record": true}'::jsonb,
    NOW(), NOW()
  );

  -- Idle record 2: 20-minute idle block mid-morning (same cluster as idle 1)
  INSERT INTO activity_records (
    id, user_id, organization_id,
    window_title, application_name,
    classification, is_idle,
    idle_start_time, idle_end_time,
    start_time, end_time,
    duration_seconds, total_time_seconds,
    work_date, status,
    metadata, created_at, updated_at
  ) VALUES (
    v_idle2, v_user_id, v_org_id,
    '[Idle: idle timeout]', 'System',
    'idle', TRUE,
    (CURRENT_DATE + INTERVAL '10 hours')::timestamptz,
    (CURRENT_DATE + INTERVAL '10 hours 20 minutes')::timestamptz,
    (CURRENT_DATE + INTERVAL '10 hours')::timestamptz,
    (CURRENT_DATE + INTERVAL '10 hours 20 minutes')::timestamptz,
    1200, 1200,
    CURRENT_DATE, 'analyzed',
    '{"idle_reason": "idle timeout", "test_record": true}'::jsonb,
    NOW(), NOW()
  );

  -- Idle record 3: 10-minute afternoon idle block (separate cluster)
  INSERT INTO activity_records (
    id, user_id, organization_id,
    window_title, application_name,
    classification, is_idle,
    idle_start_time, idle_end_time,
    start_time, end_time,
    duration_seconds, total_time_seconds,
    work_date, status,
    metadata, created_at, updated_at
  ) VALUES (
    v_idle3, v_user_id, v_org_id,
    '[Idle: screen locked]', 'System',
    'idle', TRUE,
    (CURRENT_DATE + INTERVAL '14 hours')::timestamptz,
    (CURRENT_DATE + INTERVAL '14 hours 10 minutes')::timestamptz,
    (CURRENT_DATE + INTERVAL '14 hours')::timestamptz,
    (CURRENT_DATE + INTERVAL '14 hours 10 minutes')::timestamptz,
    600, 600,
    CURRENT_DATE, 'analyzed',
    '{"idle_reason": "screen locked", "test_record": true}'::jsonb,
    NOW(), NOW()
  );

  -- ===========================================================================
  -- WORK activity_records (is_idle = false) — for contrast on the Work tab
  -- ===========================================================================

  INSERT INTO activity_records (
    id, user_id, organization_id,
    window_title, application_name,
    classification, is_idle,
    start_time, end_time,
    duration_seconds, total_time_seconds,
    work_date, status,
    metadata, created_at, updated_at
  ) VALUES
  (
    v_work1, v_user_id, v_org_id,
    'UnassignedWork.js - JIRAForge - Visual Studio Code', 'Code.exe',
    'productive', FALSE,
    (CURRENT_DATE + INTERVAL '11 hours')::timestamptz,
    (CURRENT_DATE + INTERVAL '11 hours 30 minutes')::timestamptz,
    1800, 1800,
    CURRENT_DATE, 'analyzed',
    '{"test_record": true}'::jsonb,
    NOW(), NOW()
  ),
  (
    v_work2, v_user_id, v_org_id,
    'JIRAForge · GitHub - Google Chrome', 'chrome.exe',
    'productive', FALSE,
    (CURRENT_DATE + INTERVAL '11 hours 35 minutes')::timestamptz,
    (CURRENT_DATE + INTERVAL '12 hours 5 minutes')::timestamptz,
    1800, 1800,
    CURRENT_DATE, 'analyzed',
    '{"test_record": true}'::jsonb,
    NOW(), NOW()
  ),
  (
    v_work3, v_user_id, v_org_id,
    'Slack - General', 'slack.exe',
    'productive', FALSE,
    (CURRENT_DATE + INTERVAL '12 hours 10 minutes')::timestamptz,
    (CURRENT_DATE + INTERVAL '12 hours 25 minutes')::timestamptz,
    900, 900,
    CURRENT_DATE, 'analyzed',
    '{"test_record": true}'::jsonb,
    NOW(), NOW()
  );

  -- ===========================================================================
  -- IDLE GROUP 1: Morning idle (records 1 + 2, 35 min total)
  -- No AI recommendation — appears under "Needs Review" quick filter
  -- ===========================================================================
  INSERT INTO unassigned_work_groups (
    user_id, organization_id,
    group_label, group_description,
    confidence_level,
    session_count, total_seconds,
    is_assigned, is_dismissed,
    clustering_metadata
  ) VALUES (
    v_user_id, v_org_id,
    'Morning Idle Time',
    'Idle periods detected during morning hours — no activity recorded.',
    'low',
    2, 2100,
    false, false,
    '{"test_data": true, "purpose": "idle unassigned separation test"}'::jsonb
  ) RETURNING id INTO v_idle_group1;

  -- ===========================================================================
  -- IDLE GROUP 2: Afternoon idle (record 3, 10 min total)
  -- Has AI recommendation — appears under "AI Recommended" quick filter
  -- ===========================================================================
  INSERT INTO unassigned_work_groups (
    user_id, organization_id,
    group_label, group_description,
    confidence_level, recommended_action, recommendation_reason,
    session_count, total_seconds,
    is_assigned, is_dismissed,
    clustering_metadata
  ) VALUES (
    v_user_id, v_org_id,
    'Afternoon Screen Lock',
    'Screen locked during afternoon — possibly a short break or away-from-desk period.',
    'medium', 'create_new_issue',
    'Short idle block during typical break window. Consider logging as break time.',
    1, 600,
    false, false,
    '{"test_data": true, "purpose": "idle unassigned separation test"}'::jsonb
  ) RETURNING id INTO v_idle_group2;

  -- ===========================================================================
  -- WORK GROUP 1: VS Code + Chrome + Slack (records 1–3, 75 min total)
  -- Has AI recommendation — appears on Work tab with "AI Recommended" filter
  -- ===========================================================================
  INSERT INTO unassigned_work_groups (
    user_id, organization_id,
    group_label, group_description,
    confidence_level, recommended_action, recommendation_reason,
    session_count, total_seconds,
    is_assigned, is_dismissed,
    clustering_metadata
  ) VALUES (
    v_user_id, v_org_id,
    'Frontend Development Work',
    'Development activity across VS Code, GitHub, and Slack — likely feature work.',
    'high', 'assign_to_existing',
    'Active coding and review session pattern detected. Assign to current sprint task.',
    3, 4500,
    false, false,
    '{"test_data": true, "purpose": "idle unassigned separation test"}'::jsonb
  ) RETURNING id INTO v_work_group1;

  -- ===========================================================================
  -- Link activity_records to groups via unassigned_group_members
  -- ===========================================================================

  -- Idle group 1 members
  INSERT INTO unassigned_group_members (group_id, activity_record_id)
  VALUES (v_idle_group1, v_idle1);
  INSERT INTO unassigned_group_members (group_id, activity_record_id)
  VALUES (v_idle_group1, v_idle2);

  -- Idle group 2 member
  INSERT INTO unassigned_group_members (group_id, activity_record_id)
  VALUES (v_idle_group2, v_idle3);

  -- Work group 1 members
  INSERT INTO unassigned_group_members (group_id, activity_record_id)
  VALUES (v_work_group1, v_work1);
  INSERT INTO unassigned_group_members (group_id, activity_record_id)
  VALUES (v_work_group1, v_work2);
  INSERT INTO unassigned_group_members (group_id, activity_record_id)
  VALUES (v_work_group1, v_work3);

  RAISE NOTICE '✅ Idle + Work test groups created successfully.';
  RAISE NOTICE '   IDLE GROUP 1: "Morning Idle Time"     — 35 min, 2 sessions, no recommendation';
  RAISE NOTICE '   IDLE GROUP 2: "Afternoon Screen Lock" — 10 min, 1 session, AI recommended';
  RAISE NOTICE '   WORK GROUP 1: "Frontend Development Work" — 75 min, 3 sessions, AI recommended';
  RAISE NOTICE '';
  RAISE NOTICE '   Open the Unassigned Work page and verify:';
  RAISE NOTICE '   • "All" tab shows all 3 groups';
  RAISE NOTICE '   • "Idle Sessions" tab shows only 2 groups';
  RAISE NOTICE '   • "Unassigned Work" tab shows only 1 group';
  RAISE NOTICE '   • "AI Recommended" filter shows 2 groups (1 idle + 1 work)';
  RAISE NOTICE '   • "Needs Review" filter shows 1 group (idle, no recommendation)';
END $$;


-- =============================================================================
-- VERIFICATION: Run after seeding to confirm data looks correct
-- =============================================================================
SELECT
  g.id,
  g.group_label,
  g.session_count,
  g.total_seconds,
  g.recommended_action,
  COUNT(m.id) AS linked_members,
  BOOL_AND(ar.is_idle) AS all_members_idle
FROM unassigned_work_groups g
JOIN unassigned_group_members m ON m.group_id = g.id
JOIN activity_records ar ON ar.id = m.activity_record_id
WHERE g.clustering_metadata->>'purpose' = 'idle unassigned separation test'
GROUP BY g.id, g.group_label, g.session_count, g.total_seconds, g.recommended_action
ORDER BY g.group_label;


-- =============================================================================
-- CLEANUP: Uncomment and run this block when done testing
-- =============================================================================
/*
DELETE FROM unassigned_group_members
  WHERE group_id IN (
    SELECT id FROM unassigned_work_groups
    WHERE clustering_metadata->>'purpose' = 'idle unassigned separation test'
  );

DELETE FROM unassigned_work_groups
  WHERE clustering_metadata->>'purpose' = 'idle unassigned separation test';

DELETE FROM activity_records
  WHERE metadata->>'test_record' = 'true'
    AND metadata->>'purpose' IS NULL
    AND work_date = CURRENT_DATE;
*/
