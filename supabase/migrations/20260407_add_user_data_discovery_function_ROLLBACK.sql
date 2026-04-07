-- Rollback: Remove User Data Discovery Function
-- Date: April 7, 2026

DROP FUNCTION IF EXISTS discover_user_data_tables();
