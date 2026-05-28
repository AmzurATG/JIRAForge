-- Quick Script to Add Portal Test Data
-- Run this in Supabase SQL Editor
-- ============================================================================
-- INSTRUCTIONS:
-- 1. Replace 'YOUR_ORG_ID_HERE' with your actual organization ID
-- 2. Run this entire script in Supabase SQL Editor
-- 3. Refresh the portal to see data
-- ============================================================================

DO $$
DECLARE
  v_org_id UUID := 'YOUR_ORG_ID_HERE';  -- ⚠️ REPLACE THIS WITH YOUR ACTUAL ORG ID
  v_user_1 UUID;
  v_user_2 UUID;
  v_user_3 UUID;
BEGIN
  -- Check if organization exists
  IF NOT EXISTS (SELECT 1 FROM organizations WHERE id = v_org_id) THEN
    RAISE EXCEPTION 'Organization % does not exist. Please update v_org_id with your actual organization ID.', v_org_id;
  END IF;

  -- Create test users if they don't exist
  INSERT INTO users (atlassian_account_id, email, display_name, organization_id, is_active)
  VALUES
    ('test-emp-001', 'employee1@test.com', 'Sarah Wilson', v_org_id, true),
    ('test-emp-002', 'employee2@test.com', 'Mike Chen', v_org_id, true),
    ('test-emp-003', 'employee3@test.com', 'Emily Brown', v_org_id, true)
  ON CONFLICT (atlassian_account_id) DO NOTHING
  RETURNING id INTO v_user_1;

  -- Get user IDs
  SELECT id INTO v_user_1 FROM users WHERE email = 'employee1@test.com' AND organization_id = v_org_id;
  SELECT id INTO v_user_2 FROM users WHERE email = 'employee2@test.com' AND organization_id = v_org_id;
  SELECT id INTO v_user_3 FROM users WHERE email = 'employee3@test.com' AND organization_id = v_org_id;

  -- Create activity records for the last 14 days
  INSERT INTO activity_records (
    user_id,
    organization_id,
    window_title,
    application_name,
    classification,
    start_time,
    end_time,
    duration_seconds,
    work_date,
    user_timezone,
    status
  ) VALUES
    -- TODAY (May 25, 2026)
    (v_user_1, v_org_id, 'JIRA - Sprint Planning', 'chrome.exe', 'productive', CURRENT_TIMESTAMP - INTERVAL '2 hours', CURRENT_TIMESTAMP - INTERVAL '1 hour', 3600, CURRENT_DATE, 'UTC', 'analyzed'),
    (v_user_2, v_org_id, 'VS Code - React Development', 'Code.exe', 'productive', CURRENT_TIMESTAMP - INTERVAL '3 hours', CURRENT_TIMESTAMP - INTERVAL '1 hour 30 minutes', 5400, CURRENT_DATE, 'UTC', 'analyzed'),
    (v_user_3, v_org_id, 'Confluence - Documentation', 'chrome.exe', 'productive', CURRENT_TIMESTAMP - INTERVAL '4 hours', CURRENT_TIMESTAMP - INTERVAL '2 hours', 7200, CURRENT_DATE, 'UTC', 'analyzed'),
    (v_user_1, v_org_id, 'YouTube', 'chrome.exe', 'non_productive', CURRENT_TIMESTAMP - INTERVAL '1 hour', CURRENT_TIMESTAMP - INTERVAL '45 minutes', 900, CURRENT_DATE, 'UTC', 'analyzed'),
    
    -- YESTERDAY (May 24)
    (v_user_1, v_org_id, 'IntelliJ IDEA - Java Project', 'idea64.exe', 'productive', CURRENT_DATE - INTERVAL '1 day' + INTERVAL '9 hours', CURRENT_DATE - INTERVAL '1 day' + INTERVAL '12 hours', 10800, CURRENT_DATE - 1, 'UTC', 'analyzed'),
    (v_user_2, v_org_id, 'GitHub Pull Request Review', 'chrome.exe', 'productive', CURRENT_DATE - INTERVAL '1 day' + INTERVAL '10 hours', CURRENT_DATE - INTERVAL '1 day' + INTERVAL '11 hours 30 minutes', 5400, CURRENT_DATE - 1, 'UTC', 'analyzed'),
    (v_user_3, v_org_id, 'Slack - Team Communication', 'slack.exe', 'productive', CURRENT_DATE - INTERVAL '1 day' + INTERVAL '14 hours', CURRENT_DATE - INTERVAL '1 day' + INTERVAL '15 hours', 3600, CURRENT_DATE - 1, 'UTC', 'analyzed'),
    (v_user_2, v_org_id, 'Reddit', 'chrome.exe', 'non_productive', CURRENT_DATE - INTERVAL '1 day' + INTERVAL '15 hours', CURRENT_DATE - INTERVAL '1 day' + INTERVAL '15 hours 20 minutes', 1200, CURRENT_DATE - 1, 'UTC', 'analyzed'),
    
    -- MAY 23
    (v_user_1, v_org_id, 'Bitbucket Code Review', 'chrome.exe', 'productive', CURRENT_DATE - INTERVAL '2 days' + INTERVAL '9 hours', CURRENT_DATE - INTERVAL '2 days' + INTERVAL '11 hours', 7200, CURRENT_DATE - 2, 'UTC', 'analyzed'),
    (v_user_2, v_org_id, 'PostgreSQL Database Work', 'pgAdmin4.exe', 'productive', CURRENT_DATE - INTERVAL '2 days' + INTERVAL '13 hours', CURRENT_DATE - INTERVAL '2 days' + INTERVAL '15 hours', 7200, CURRENT_DATE - 2, 'UTC', 'analyzed'),
    (v_user_3, v_org_id, 'Microsoft Teams Meeting', 'Teams.exe', 'productive', CURRENT_DATE - INTERVAL '2 days' + INTERVAL '10 hours', CURRENT_DATE - INTERVAL '2 days' + INTERVAL '11 hours', 3600, CURRENT_DATE - 2, 'UTC', 'analyzed'),
    (v_user_3, v_org_id, 'Twitter', 'chrome.exe', 'non_productive', CURRENT_DATE - INTERVAL '2 days' + INTERVAL '16 hours', CURRENT_DATE - INTERVAL '2 days' + INTERVAL '16 hours 30 minutes', 1800, CURRENT_DATE - 2, 'UTC', 'analyzed'),
    
    -- MAY 22
    (v_user_1, v_org_id, 'API Documentation', 'chrome.exe', 'productive', CURRENT_DATE - INTERVAL '3 days' + INTERVAL '8 hours', CURRENT_DATE - INTERVAL '3 days' + INTERVAL '10 hours', 7200, CURRENT_DATE - 3, 'UTC', 'analyzed'),
    (v_user_2, v_org_id, 'Postman API Testing', 'Postman.exe', 'productive', CURRENT_DATE - INTERVAL '3 days' + INTERVAL '11 hours', CURRENT_DATE - INTERVAL '3 days' + INTERVAL '13 hours', 7200, CURRENT_DATE - 3, 'UTC', 'analyzed'),
    (v_user_3, v_org_id, 'Excel Report Analysis', 'EXCEL.EXE', 'productive', CURRENT_DATE - INTERVAL '3 days' + INTERVAL '9 hours', CURRENT_DATE - INTERVAL '3 days' + INTERVAL '12 hours', 10800, CURRENT_DATE - 3, 'UTC', 'analyzed'),
    
    -- MAY 21
    (v_user_1, v_org_id, 'Git Merge Conflicts', 'Code.exe', 'productive', CURRENT_DATE - INTERVAL '4 days' + INTERVAL '10 hours', CURRENT_DATE - INTERVAL '4 days' + INTERVAL '11 hours 30 minutes', 5400, CURRENT_DATE - 4, 'UTC', 'analyzed'),
    (v_user_2, v_org_id, 'Jenkins Build Pipeline', 'chrome.exe', 'productive', CURRENT_DATE - INTERVAL '4 days' + INTERVAL '14 hours', CURRENT_DATE - INTERVAL '4 days' + INTERVAL '15 hours 20 minutes', 4800, CURRENT_DATE - 4, 'UTC', 'analyzed'),
    (v_user_3, v_org_id, 'Design Review - Figma', 'chrome.exe', 'productive', CURRENT_DATE - INTERVAL '4 days' + INTERVAL '9 hours', CURRENT_DATE - INTERVAL '4 days' + INTERVAL '11 hours', 7200, CURRENT_DATE - 4, 'UTC', 'analyzed'),
    (v_user_1, v_org_id, 'LinkedIn', 'chrome.exe', 'non_productive', CURRENT_DATE - INTERVAL '4 days' + INTERVAL '16 hours', CURRENT_DATE - INTERVAL '4 days' + INTERVAL '16 hours 25 minutes', 1500, CURRENT_DATE - 4, 'UTC', 'analyzed'),
    
    -- MAY 20
    (v_user_1, v_org_id, 'Code Review Meeting', 'zoom.exe', 'productive', CURRENT_DATE - INTERVAL '5 days' + INTERVAL '10 hours', CURRENT_DATE - INTERVAL '5 days' + INTERVAL '11 hours', 3600, CURRENT_DATE - 5, 'UTC', 'analyzed'),
    (v_user_2, v_org_id, 'Unit Test Writing', 'Code.exe', 'productive', CURRENT_DATE - INTERVAL '5 days' + INTERVAL '9 hours', CURRENT_DATE - INTERVAL '5 days' + INTERVAL '12 hours', 10800, CURRENT_DATE - 5, 'UTC', 'analyzed'),
    (v_user_3, v_org_id, 'Sprint Retrospective', 'msteams.exe', 'productive', CURRENT_DATE - INTERVAL '5 days' + INTERVAL '15 hours', CURRENT_DATE - INTERVAL '5 days' + INTERVAL '16 hours', 3600, CURRENT_DATE - 5, 'UTC', 'analyzed'),
    
    -- MAY 19
    (v_user_1, v_org_id, 'Database Migration Script', 'Code.exe', 'productive', CURRENT_DATE - INTERVAL '6 days' + INTERVAL '8 hours', CURRENT_DATE - INTERVAL '6 days' + INTERVAL '10 hours', 7200, CURRENT_DATE - 6, 'UTC', 'analyzed'),
    (v_user_2, v_org_id, 'Docker Container Setup', 'WindowsTerminal.exe', 'productive', CURRENT_DATE - INTERVAL '6 days' + INTERVAL '11 hours', CURRENT_DATE - INTERVAL '6 days' + INTERVAL '13 hours', 7200, CURRENT_DATE - 6, 'UTC', 'analyzed'),
    (v_user_3, v_org_id, 'Security Audit Review', 'chrome.exe', 'productive', CURRENT_DATE - INTERVAL '6 days' + INTERVAL '14 hours', CURRENT_DATE - INTERVAL '6 days' + INTERVAL '16 hours', 7200, CURRENT_DATE - 6, 'UTC', 'analyzed'),
    (v_user_2, v_org_id, 'Instagram', 'chrome.exe', 'non_productive', CURRENT_DATE - INTERVAL '6 days' + INTERVAL '16 hours', CURRENT_DATE - INTERVAL '6 days' + INTERVAL '16 hours 30 minutes', 1800, CURRENT_DATE - 6, 'UTC', 'analyzed'),
    
    -- MAY 18
    (v_user_1, v_org_id, 'Customer Support Ticket', 'chrome.exe', 'productive', CURRENT_DATE - INTERVAL '7 days' + INTERVAL '9 hours', CURRENT_DATE - INTERVAL '7 days' + INTERVAL '10 hours 30 minutes', 5400, CURRENT_DATE - 7, 'UTC', 'analyzed'),
    (v_user_2, v_org_id, 'Performance Optimization', 'Code.exe', 'productive', CURRENT_DATE - INTERVAL '7 days' + INTERVAL '10 hours', CURRENT_DATE - INTERVAL '7 days' + INTERVAL '13 hours', 10800, CURRENT_DATE - 7, 'UTC', 'analyzed'),
    (v_user_3, v_org_id, 'Technical Documentation', 'chrome.exe', 'productive', CURRENT_DATE - INTERVAL '7 days' + INTERVAL '11 hours', CURRENT_DATE - INTERVAL '7 days' + INTERVAL '14 hours', 10800, CURRENT_DATE - 7, 'UTC', 'analyzed');

  RAISE NOTICE '========================================';
  RAISE NOTICE '✓ Test Data Created Successfully!';
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Organization ID: %', v_org_id;
  RAISE NOTICE 'Employees Created: 3';
  RAISE NOTICE '  • Sarah Wilson (employee1@test.com)';
  RAISE NOTICE '  • Mike Chen (employee2@test.com)';
  RAISE NOTICE '  • Emily Brown (employee3@test.com)';
  RAISE NOTICE '';
  RAISE NOTICE 'Activity Records: 28';
  RAISE NOTICE 'Date Range: May 18-25, 2026 (last 8 days)';
  RAISE NOTICE '';
  RAISE NOTICE 'Now refresh your portal at http://localhost:3002/employees';
  RAISE NOTICE '========================================';
END $$;
