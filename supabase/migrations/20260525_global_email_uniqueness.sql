-- Migration: Global Email Uniqueness for Portal Admin Users
-- Date: 2026-05-25
-- Issue: #3 - Multi-Tenancy Data Leak Risk
-- 
-- Problem: Email lookups were global but constraint was org-scoped, causing potential
-- cross-org data leaks. This migration makes emails globally unique across all organizations.
--
-- Prerequisites: Run check-duplicate-emails.js script to ensure no duplicates exist
-- 
-- Rollback: If needed, drop the global constraint and recreate the org-scoped one:
--   ALTER TABLE portal_admin_users DROP CONSTRAINT IF EXISTS portal_admin_users_email_key;
--   ALTER TABLE portal_admin_users ADD CONSTRAINT portal_admin_users_org_id_email_key UNIQUE (org_id, email);

-- Drop the old org-scoped unique constraint (org_id, email)
ALTER TABLE portal_admin_users
DROP CONSTRAINT IF EXISTS portal_admin_users_org_id_email_key;

-- Add new global unique constraint on email only
ALTER TABLE portal_admin_users
ADD CONSTRAINT portal_admin_users_email_key UNIQUE (email);

-- Update table comment to reflect the change
COMMENT ON TABLE portal_admin_users IS 
'Portal admin users. Email is globally unique across all organizations. Users belong to a single org (org_id), but emails cannot be reused in different orgs.';

-- Update email column comment
COMMENT ON COLUMN portal_admin_users.email IS 
'User email address. Globally unique across all organizations (not just within org_id).';

-- Verify the constraint exists
DO $$
DECLARE
  constraint_exists boolean;
BEGIN
  SELECT EXISTS (
    SELECT 1 
    FROM information_schema.table_constraints 
    WHERE constraint_name = 'portal_admin_users_email_key'
    AND table_name = 'portal_admin_users'
  ) INTO constraint_exists;
  
  IF constraint_exists THEN
    RAISE NOTICE '✅ Global email uniqueness constraint successfully created';
  ELSE
    RAISE EXCEPTION '❌ Failed to create global email uniqueness constraint';
  END IF;
END $$;
