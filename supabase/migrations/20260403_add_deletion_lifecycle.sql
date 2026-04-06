-- ============================================================================
-- Add Deletion Lifecycle Columns and Functions
-- ============================================================================
-- Purpose: Enable automatic data deletion when app is uninstalled from Jira site
-- Compliance: GDPR Right to Erasure, Privacy Policy requirements
-- Created: 2026-04-03
-- Related: APP_UNINSTALL_DATA_DELETION_PLAN.md
-- ============================================================================

-- ============================================================================
-- PART 1: Add columns to organizations table for deletion tracking
-- ============================================================================

-- Add status column (active, pending_deletion, deleted)
ALTER TABLE public.organizations
ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'active'
CHECK (status IN ('active', 'pending_deletion', 'deleted'));

-- Add scheduled deletion timestamp
ALTER TABLE public.organizations
ADD COLUMN IF NOT EXISTS scheduled_deletion_at TIMESTAMPTZ;

-- Add uninstalled timestamp (audit trail)
ALTER TABLE public.organizations
ADD COLUMN IF NOT EXISTS uninstalled_at TIMESTAMPTZ;

-- Add comments
COMMENT ON COLUMN public.organizations.status IS 'Organization status: active, pending_deletion (30-day grace), or deleted';
COMMENT ON COLUMN public.organizations.scheduled_deletion_at IS 'When organization data should be permanently deleted (30 days after uninstall)';
COMMENT ON COLUMN public.organizations.uninstalled_at IS 'When the app was uninstalled from this Jira site';

-- Index for cleanup queries (only index rows that need cleanup)
DROP INDEX IF EXISTS public.idx_orgs_pending_deletion;
CREATE INDEX idx_orgs_pending_deletion
ON public.organizations (status, scheduled_deletion_at)
WHERE status = 'pending_deletion';

-- ============================================================================
-- PART 2: Create deletion audit log table
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.deletion_audit_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    jira_cloud_id TEXT NOT NULL,
    org_name TEXT NOT NULL,
    initiated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    scheduled_for TIMESTAMPTZ NOT NULL,
    completed_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'in_progress', 'completed', 'failed', 'cancelled')),
    deletion_summary JSONB DEFAULT '{}'::jsonb,
    error_details JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for monitoring
DROP INDEX IF EXISTS public.idx_deletion_audit_status;
DROP INDEX IF EXISTS public.idx_deletion_audit_org_id;

CREATE INDEX idx_deletion_audit_status
ON public.deletion_audit_log (status, scheduled_for);

CREATE INDEX idx_deletion_audit_org_id
ON public.deletion_audit_log (organization_id);

-- Comments
COMMENT ON TABLE public.deletion_audit_log IS 'Audit trail for organization data deletion operations';
COMMENT ON COLUMN public.deletion_audit_log.organization_id IS 'UUID of the organization being deleted';
COMMENT ON COLUMN public.deletion_audit_log.deletion_summary IS 'JSON summary of deleted records (e.g., {users: 10, screenshots: 500})';
COMMENT ON COLUMN public.deletion_audit_log.error_details IS 'JSON error details if deletion failed';

-- ============================================================================
-- PART 3: Create function to discover org-scoped tables
-- ============================================================================
-- This function enables automatic discovery of tables containing org data
-- When new tables are added with organization_id, they are auto-included

CREATE OR REPLACE FUNCTION public.get_org_scoped_tables()
RETURNS TABLE(table_name TEXT) AS $$
BEGIN
  RETURN QUERY
  SELECT c.table_name::TEXT
  FROM information_schema.columns c
  WHERE c.table_schema = 'public'
    AND c.column_name = 'organization_id'
    AND c.table_name NOT IN ('organizations', 'deletion_audit_log')  -- Exclude these
    AND c.table_name NOT LIKE 'pg_%'  -- Exclude PostgreSQL system tables
    AND c.table_name NOT LIKE 'sql_%'  -- Exclude SQL standard tables
  GROUP BY c.table_name
  ORDER BY c.table_name;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.get_org_scoped_tables() IS 
  'Discovers all tables with organization_id column for automatic deletion. 
   Called by deletion service to ensure new tables are automatically included.';

-- Grant execute permission only to service role (backend operations only)
GRANT EXECUTE ON FUNCTION public.get_org_scoped_tables() TO service_role;

-- ============================================================================
-- PART 4: Create function to discover org-scoped materialized views
-- ============================================================================

CREATE OR REPLACE FUNCTION public.get_org_scoped_materialized_views()
RETURNS TABLE(matview_name TEXT) AS $$
BEGIN
  RETURN QUERY
  SELECT mv.matviewname::TEXT
  FROM pg_matviews mv
  WHERE mv.schemaname = 'public'
    AND EXISTS (
      SELECT 1
      FROM information_schema.columns c
      WHERE c.table_schema = 'public'
        AND c.table_name = mv.matviewname
        AND c.column_name = 'organization_id'
    )
  ORDER BY mv.matviewname;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.get_org_scoped_materialized_views() IS 
  'Discovers all materialized views with organization_id column.
   These should be refreshed or dropped during org deletion.';

-- Grant execute permission only to service role (backend operations only)
GRANT EXECUTE ON FUNCTION public.get_org_scoped_materialized_views() TO service_role;

-- ============================================================================
-- PART 5: Create helper function to refresh materialized views
-- ============================================================================
-- Used by deletion service to refresh materialized views after org deletion

CREATE OR REPLACE FUNCTION public.refresh_matview(view_name TEXT)
RETURNS VOID AS $$
BEGIN
  EXECUTE format('REFRESH MATERIALIZED VIEW %I', view_name);
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

COMMENT ON FUNCTION public.refresh_matview(TEXT) IS 
  'Refreshes a materialized view by name. Called during org deletion to update views.';

-- Grant execute permission only to service role (backend operations only)
-- This function can refresh any materialized view by name - restrict to backend only
GRANT EXECUTE ON FUNCTION public.refresh_matview(TEXT) TO service_role;

-- ============================================================================
-- PART 6: Row Level Security (RLS) for deletion_audit_log
-- ============================================================================

-- Enable RLS
ALTER TABLE public.deletion_audit_log ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if they exist (for re-running migration)
DROP POLICY IF EXISTS "Service role full access to deletion_audit_log" ON public.deletion_audit_log;
DROP POLICY IF EXISTS "Users can view their org deletion status" ON public.deletion_audit_log;

-- Policy: Service role can do everything (for deletion service)
CREATE POLICY "Service role full access to deletion_audit_log"
ON public.deletion_audit_log
FOR ALL
TO service_role
USING (true)
WITH CHECK (true);

-- Policy: Authenticated users can view their own org's deletion status
CREATE POLICY "Users can view their org deletion status"
ON public.deletion_audit_log
FOR SELECT
TO authenticated
USING (
  organization_id IN (
    SELECT organization_id 
    FROM public.users 
    WHERE atlassian_account_id = current_setting('request.jwt.claims', true)::json->>'sub'
  )
);

-- ============================================================================
-- PART 7: Create update_modified_column function (if not exists)
-- ============================================================================
-- This function automatically updates the updated_at column

CREATE OR REPLACE FUNCTION public.update_modified_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION public.update_modified_column() IS 
  'Trigger function to automatically update updated_at column on row updates';

-- ============================================================================
-- PART 8: Create updated_at trigger for deletion_audit_log
-- ============================================================================

-- Drop existing trigger if it exists (for re-running migration)
DROP TRIGGER IF EXISTS set_deletion_audit_log_updated_at ON public.deletion_audit_log;

CREATE TRIGGER set_deletion_audit_log_updated_at
BEFORE UPDATE ON public.deletion_audit_log
FOR EACH ROW
EXECUTE FUNCTION public.update_modified_column();

-- ============================================================================
-- PART 9: VERIFICATION QUERIES (for manual testing)
-- ============================================================================
-- Uncomment these to test after migration:

-- Test 1: Verify new columns exist
-- SELECT column_name, data_type 
-- FROM information_schema.columns 
-- WHERE table_name = 'organizations' 
-- AND column_name IN ('status', 'scheduled_deletion_at', 'uninstalled_at');

-- Test 2: Verify deletion_audit_log table exists
-- SELECT table_name FROM information_schema.tables 
-- WHERE table_name = 'deletion_audit_log';

-- Test 3: Test org-scoped table discovery
-- SELECT * FROM get_org_scoped_tables();

-- Test 4: Test materialized view discovery
-- SELECT * FROM get_org_scoped_materialized_views();

-- ============================================================================
-- PART 10: ROLLBACK INSTRUCTIONS
-- ============================================================================
-- If you need to rollback this migration, run the companion rollback file:
-- 20260403_add_deletion_lifecycle_ROLLBACK.sql
