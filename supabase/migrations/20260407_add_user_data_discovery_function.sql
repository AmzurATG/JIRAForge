-- Migration: Add User Data Discovery Function
-- Date: April 7, 2026
-- Purpose: Dynamic discovery of tables containing user data for GDPR compliance
-- This ensures new tables are automatically included in export/deletion operations

-- Function to discover all tables with user_id column
CREATE OR REPLACE FUNCTION discover_user_data_tables()
RETURNS TABLE (
  table_name TEXT,
  column_name TEXT,
  data_type TEXT,
  is_nullable TEXT
) 
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN QUERY
  SELECT DISTINCT
    t.table_name::TEXT,
    c.column_name::TEXT,
    c.data_type::TEXT,
    c.is_nullable::TEXT
  FROM information_schema.tables t
  INNER JOIN information_schema.columns c 
    ON t.table_name = c.table_name 
    AND t.table_schema = c.table_schema
  WHERE t.table_schema = 'public'
    AND t.table_type = 'BASE TABLE'
    AND c.column_name = 'user_id'
    AND t.table_name NOT LIKE 'pg_%'  -- Exclude PostgreSQL system tables
    AND t.table_name NOT LIKE 'sql_%' -- Exclude SQL standard tables
  ORDER BY t.table_name;
END;
$$;

-- Grant execute permission to authenticated users (via service role in practice)
GRANT EXECUTE ON FUNCTION discover_user_data_tables() TO authenticated;
GRANT EXECUTE ON FUNCTION discover_user_data_tables() TO service_role;

-- Comment
COMMENT ON FUNCTION discover_user_data_tables() IS 
  'Discovers all tables in the public schema that contain a user_id column. 
   Used for dynamic GDPR compliance - automatically includes new tables in 
   export and deletion operations.';
