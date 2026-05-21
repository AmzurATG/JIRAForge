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
BEGIN
  -- Create Portal Admin Users
  -- Password for all users: "Password123!"
  -- Bcrypt hash (10 rounds): $2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy
  
  INSERT INTO portal_admin_users (org_id, email, password_hash, display_name, role)
  VALUES 
    (v_org_id, 'admin@demo.com', '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', 'Portal Admin', 'superadmin'),
    (v_org_id, 'manager@demo.com', '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', 'Manager User', 'admin'),
    (v_org_id, 'viewer@demo.com', '$2b$10$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy', 'Viewer User', 'viewer')
  ON CONFLICT (org_id, email) DO NOTHING;

  RAISE NOTICE '========================================';
  RAISE NOTICE 'Portal Demo Setup Complete';
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Organization: Demo Company';
  RAISE NOTICE 'Org ID: %', v_org_id;
  RAISE NOTICE 'Portal Admins: 3';
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
