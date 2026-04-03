-- ============================================================================
-- Rollback Script for Personal Data Reporting API
-- ============================================================================
-- Reverts changes from 20260403_add_data_requests_table.sql
-- Created: April 3, 2026
-- ============================================================================

-- Drop trigger
DROP TRIGGER IF EXISTS data_requests_updated_at_trigger ON public.data_requests;

-- Drop trigger function
DROP FUNCTION IF EXISTS update_data_requests_updated_at();

-- Drop indexes
DROP INDEX IF EXISTS idx_data_requests_active_unique;
DROP INDEX IF EXISTS idx_data_requests_requested_at;
DROP INDEX IF EXISTS idx_data_requests_status;
DROP INDEX IF EXISTS idx_data_requests_account_cloud;

-- Drop table
DROP TABLE IF EXISTS public.data_requests;
