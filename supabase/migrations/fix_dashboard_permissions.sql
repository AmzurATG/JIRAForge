-- ============================================================
-- Fix Dashboard Permissions for PostgREST API Access
-- Run this in Supabase SQL Editor to resolve PGRST205 errors
-- ============================================================

-- Grant schema usage to all roles
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;

-- Grant SELECT on all dashboard tables to all roles
GRANT SELECT ON dashboard_header_metrics TO anon, authenticated, service_role;
GRANT SELECT ON dashboard_organizations TO anon, authenticated, service_role;
GRANT SELECT ON dashboard_tickets_per_team TO anon, authenticated, service_role;
GRANT SELECT ON dashboard_ticket_status TO anon, authenticated, service_role;

-- Grant ALL permissions to service_role for CRUD operations
GRANT ALL ON dashboard_header_metrics TO service_role;
GRANT ALL ON dashboard_organizations TO service_role;
GRANT ALL ON dashboard_tickets_per_team TO service_role;
GRANT ALL ON dashboard_ticket_status TO service_role;

-- Grant SELECT on the view to all roles
GRANT SELECT ON dashboard_tickets_summary TO anon, authenticated, service_role;

-- Ensure sequences can be used (for INSERT operations)
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

-- Update RLS policies to allow service_role full access
DROP POLICY IF EXISTS "Service role full access" ON dashboard_header_metrics;
CREATE POLICY "Service role full access" ON dashboard_header_metrics 
FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access" ON dashboard_organizations;
CREATE POLICY "Service role full access" ON dashboard_organizations 
FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access" ON dashboard_tickets_per_team;
CREATE POLICY "Service role full access" ON dashboard_tickets_per_team 
FOR ALL TO service_role USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Service role full access" ON dashboard_ticket_status;
CREATE POLICY "Service role full access" ON dashboard_ticket_status 
FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Also allow read access to authenticated users if needed
DROP POLICY IF EXISTS "Allow read access to dashboard_header_metrics" ON dashboard_header_metrics;
CREATE POLICY "Allow read access to dashboard_header_metrics" 
ON dashboard_header_metrics FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Allow read access to dashboard_organizations" ON dashboard_organizations;
CREATE POLICY "Allow read access to dashboard_organizations" 
ON dashboard_organizations FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Allow read access to dashboard_tickets_per_team" ON dashboard_tickets_per_team;
CREATE POLICY "Allow read access to dashboard_tickets_per_team" 
ON dashboard_tickets_per_team FOR SELECT TO authenticated USING (true);

DROP POLICY IF EXISTS "Allow read access to dashboard_ticket_status" ON dashboard_ticket_status;
CREATE POLICY "Allow read access to dashboard_ticket_status" 
ON dashboard_ticket_status FOR SELECT TO authenticated USING (true);

-- Force PostgREST to reload its schema cache
NOTIFY pgrst, 'reload schema';
NOTIFY pgrst, 'reload config';

-- Verify tables are accessible (should return empty results, not errors)
SELECT 'Testing dashboard_header_metrics' as test;
SELECT * FROM dashboard_header_metrics LIMIT 1;

SELECT 'Testing dashboard_organizations' as test;
SELECT * FROM dashboard_organizations LIMIT 1;

SELECT 'Testing dashboard_tickets_per_team' as test;
SELECT * FROM dashboard_tickets_per_team LIMIT 1;

SELECT 'Testing dashboard_ticket_status' as test;
SELECT * FROM dashboard_ticket_status LIMIT 1;

SELECT 'Testing dashboard_tickets_summary view' as test;
SELECT * FROM dashboard_tickets_summary LIMIT 1;

SELECT '✓ All dashboard tables and views are accessible!' as result;
