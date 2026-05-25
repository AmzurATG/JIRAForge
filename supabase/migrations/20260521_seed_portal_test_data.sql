-- Migration: Seed Portal Admin Users (Demo/Test)
-- Created: 2026-05-21
-- Description: Create a demo organization and portal admin users for testing
-- ============================================================================
-- 1. Create Demo Organization (if needed)
-- ============================================================================
INSERT INTO organizations (id, jira_cloud_id, jira_instance_url, org_name, subscription_status, subscription_tier, is_active)
VALUES 
  ('11111111-1111-1111-1111-111111111111', 'demo-cloud-id-001', 'https://demo-company.atlassian.net', 'Demo Company', 'active', 'pro', true)
ON CONFLICT (jira_cloud_id) DO NOTHING;
-- ============================================================================
-- 2. Create Portal Admin Users
-- ============================================================================
DO $$
DECLARE
  v_org_id UUID := '11111111-1111-1111-1111-111111111111';
  v_demo_user_1 UUID := '22222222-2222-2222-2222-222222222221';
  v_demo_user_2 UUID := '22222222-2222-2222-2222-222222222222';
  v_demo_user_3 UUID := '22222222-2222-2222-2222-222222222223';
BEGIN
  -- Create Portal Admin Users
  -- Password for all users: "Password123!"
  -- Bcrypt hash (10 rounds) - VERIFIED WORKING:
  -- $2b$10$K7ZwosIgznB.IwmS8h5zXenuEkk.oUMn.K2NTBVipmBZLEQ7S6JOa
  INSERT INTO portal_admin_users (org_id, email, password_hash, display_name, role)
  VALUES 
    (v_org_id, 'admin@demo.com', '$2b$10$K7ZwosIgznB.IwmS8h5zXenuEkk.oUMn.K2NTBVipmBZLEQ7S6JOa', 'Portal Admin', 'superadmin'),
    (v_org_id, 'manager@demo.com', '$2b$10$K7ZwosIgznB.IwmS8h5zXenuEkk.oUMn.K2NTBVipmBZLEQ7S6JOa', 'Manager User', 'admin'),
    (v_org_id, 'viewer@demo.com', '$2b$10$K7ZwosIgznB.IwmS8h5zXenuEkk.oUMn.K2NTBVipmBZLEQ7S6JOa', 'Viewer User', 'viewer')
  ON CONFLICT (org_id, email) DO NOTHING;
  -- Create Demo Employee Users (for analytics pages)
  INSERT INTO users (id, atlassian_account_id, email, display_name, organization_id, is_active)
  VALUES
    (v_demo_user_1, 'demo-user-001', 'john@demo.com', 'John Doe', v_org_id, true),
    (v_demo_user_2, 'demo-user-002', 'jane@demo.com', 'Jane Smith', v_org_id, true),
    (v_demo_user_3, 'demo-user-003', 'alex@demo.com', 'Alex Johnson', v_org_id, true)
  ON CONFLICT (atlassian_account_id) DO NOTHING;
  -- Create Demo Activity Records (last 7 days)
  INSERT INTO activity_records (
    id,
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
  )
  VALUES
    ('33333333-3333-3333-3333-333333333301', v_demo_user_1, v_org_id, 'Jira Sprint Planning', 'chrome.exe', 'productive', NOW() - INTERVAL '1 day' - INTERVAL '3 hours', NOW() - INTERVAL '1 day' - INTERVAL '2 hours 20 minutes', 2400, CURRENT_DATE - 1, 'UTC', 'analyzed'),
    ('33333333-3333-3333-3333-333333333302', v_demo_user_1, v_org_id, 'YouTube', 'chrome.exe', 'non_productive', NOW() - INTERVAL '1 day' - INTERVAL '2 hours', NOW() - INTERVAL '1 day' - INTERVAL '1 hour 45 minutes', 900, CURRENT_DATE - 1, 'UTC', 'analyzed'),
    ('33333333-3333-3333-3333-333333333303', v_demo_user_2, v_org_id, 'VS Code - portal-service.js', 'Code.exe', 'productive', NOW() - INTERVAL '2 days' - INTERVAL '4 hours', NOW() - INTERVAL '2 days' - INTERVAL '2 hours 30 minutes', 5400, CURRENT_DATE - 2, 'UTC', 'analyzed'),
    ('33333333-3333-3333-3333-333333333304', v_demo_user_2, v_org_id, 'Instagram', 'chrome.exe', 'non_productive', NOW() - INTERVAL '2 days' - INTERVAL '2 hours', NOW() - INTERVAL '2 days' - INTERVAL '1 hour 40 minutes', 1200, CURRENT_DATE - 2, 'UTC', 'analyzed'),
    ('33333333-3333-3333-3333-333333333305', v_demo_user_3, v_org_id, 'Confluence Documentation', 'chrome.exe', 'productive', NOW() - INTERVAL '3 days' - INTERVAL '5 hours', NOW() - INTERVAL '3 days' - INTERVAL '3 hours 40 minutes', 4800, CURRENT_DATE - 3, 'UTC', 'analyzed'),
    ('33333333-3333-3333-3333-333333333306', v_demo_user_3, v_org_id, 'LinkedIn Feed', 'chrome.exe', 'non_productive', NOW() - INTERVAL '3 days' - INTERVAL '3 hours', NOW() - INTERVAL '3 days' - INTERVAL '2 hours 35 minutes', 1500, CURRENT_DATE - 3, 'UTC', 'analyzed'),
    ('33333333-3333-3333-3333-333333333307', v_demo_user_1, v_org_id, 'Bitbucket Pull Request', 'chrome.exe', 'productive', NOW() - INTERVAL '4 days' - INTERVAL '4 hours', NOW() - INTERVAL '4 days' - INTERVAL '2 hours 45 minutes', 4500, CURRENT_DATE - 4, 'UTC', 'analyzed'),
    ('33333333-3333-3333-3333-333333333308', v_demo_user_2, v_org_id, 'Slack Chat', 'slack.exe', 'productive', NOW() - INTERVAL '5 days' - INTERVAL '2 hours', NOW() - INTERVAL '5 days' - INTERVAL '1 hour 20 minutes', 2400, CURRENT_DATE - 5, 'UTC', 'analyzed'),
    ('33333333-3333-3333-3333-333333333309', v_demo_user_3, v_org_id, 'News Site', 'chrome.exe', 'non_productive', NOW() - INTERVAL '6 days' - INTERVAL '1 hour', NOW() - INTERVAL '6 days' - INTERVAL '40 minutes', 1200, CURRENT_DATE - 6, 'UTC', 'analyzed')
  ON CONFLICT (id) DO NOTHING;
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Portal Demo Setup Complete';
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Organization: Demo Company';
  RAISE NOTICE 'Org ID: %', v_org_id;
  RAISE NOTICE 'Portal Admins: 3';
  RAISE NOTICE 'Demo Employees: 3';
  RAISE NOTICE 'Demo Activity Records: 9';
  RAISE NOTICE '';
  RAISE NOTICE 'Login Credentials:';
  RAISE NOTICE '  Email: admin@demo.com (superadmin)';
  RAISE NOTICE '  Email: manager@demo.com (admin)';
  RAISE NOTICE '  Email: viewer@demo.com (viewer)';
  RAISE NOTICE '  Password: Password123!';
  RAISE NOTICE '  Org ID: 11111111-1111-1111-1111-111111111111';
  RAISE NOTICE '';
  RAISE NOTICE 'Portal URL: http://localhost:3002';
  RAISE NOTICE '========================================';
END $$;