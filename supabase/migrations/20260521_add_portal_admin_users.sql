-- Migration: Add portal_admin_users table
-- Created: 2026-05-21
-- Description: Creates portal_admin_users table for web productivity portal authentication

-- Create portal_admin_users table
CREATE TABLE IF NOT EXISTS portal_admin_users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email VARCHAR(255) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  display_name VARCHAR(255) NOT NULL,
  role VARCHAR(20) NOT NULL CHECK (role IN ('superadmin', 'admin', 'viewer')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_login_at TIMESTAMPTZ,
  
  -- Unique constraint: email is unique per organization
  CONSTRAINT portal_admin_users_org_email_unique UNIQUE (org_id, email)
);

-- Create index for faster lookups
CREATE INDEX IF NOT EXISTS idx_portal_admin_users_org_id ON portal_admin_users(org_id);
CREATE INDEX IF NOT EXISTS idx_portal_admin_users_email ON portal_admin_users(email);

-- Enable Row Level Security
ALTER TABLE portal_admin_users ENABLE ROW LEVEL SECURITY;

-- RLS Policy: Portal admins can only access their own organization's data
CREATE POLICY portal_admin_users_select_policy ON portal_admin_users
  FOR SELECT
  USING (org_id = current_setting('app.current_org_id', true)::uuid);

CREATE POLICY portal_admin_users_insert_policy ON portal_admin_users
  FOR INSERT
  WITH CHECK (org_id = current_setting('app.current_org_id', true)::uuid);

CREATE POLICY portal_admin_users_update_policy ON portal_admin_users
  FOR UPDATE
  USING (org_id = current_setting('app.current_org_id', true)::uuid);

CREATE POLICY portal_admin_users_delete_policy ON portal_admin_users
  FOR DELETE
  USING (org_id = current_setting('app.current_org_id', true)::uuid);

-- Add comment
COMMENT ON TABLE portal_admin_users IS 'Portal administrator users for web productivity portal (email/password auth, no Jira integration)';
