-- ============================================================================
-- ROLLBACK: Add Deletion Lifecycle Columns and Functions
-- ============================================================================
-- Purpose: Rollback the deletion lifecycle migration
-- Created: 2026-04-03
-- Related: 20260403_add_deletion_lifecycle.sql
-- ============================================================================

-- WARNING: This will remove all deletion audit logs!
-- Make sure you have a backup before running this.

-- Drop functions
DROP FUNCTION IF EXISTS public.refresh_matview(TEXT);
DROP FUNCTION IF EXISTS public.get_org_scoped_materialized_views();
DROP FUNCTION IF EXISTS public.get_org_scoped_tables();

-- Drop deletion_audit_log table
DROP TABLE IF EXISTS public.deletion_audit_log;

-- Remove indexes from organizations table
DROP INDEX IF EXISTS public.idx_orgs_pending_deletion;

-- Remove columns from organizations table
ALTER TABLE public.organizations
DROP COLUMN IF EXISTS uninstalled_at;

ALTER TABLE public.organizations
DROP COLUMN IF EXISTS scheduled_deletion_at;

ALTER TABLE public.organizations
DROP COLUMN IF EXISTS status;

-- Verification
SELECT 'Rollback completed. Deletion lifecycle features removed.' AS message;
