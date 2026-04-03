-- ============================================================================
-- Rollback Script for Exports Storage Bucket
-- ============================================================================
-- Reverts changes from 20260403_add_exports_storage_bucket.sql
-- WARNING: This will delete all export files in the bucket
-- Created: April 3, 2026
-- ============================================================================

-- Drop storage policies
DROP POLICY IF EXISTS "storage_exports_service_role" ON storage.objects;

-- Delete all objects in the bucket (if any)
DELETE FROM storage.objects WHERE bucket_id = 'exports';

-- Delete the bucket
DELETE FROM storage.buckets WHERE id = 'exports';
