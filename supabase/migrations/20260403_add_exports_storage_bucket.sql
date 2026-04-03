-- ============================================================================
-- Add Exports Storage Bucket for Personal Data Reporting
-- ============================================================================
-- Creates 'exports' bucket for temporary storage of user data export files
-- Files auto-expire after 7 days (configured via Supabase lifecycle policy in dashboard)
-- Created: April 3, 2026
-- ============================================================================

-- Create exports bucket
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
    'exports',
    'exports',
    false,  -- Private bucket
    104857600,  -- 100MB limit (user data exports can be large)
    ARRAY['application/json']
)
ON CONFLICT (id) DO NOTHING;

-- ============================================================================
-- Storage Policies for exports bucket
-- ============================================================================

-- Drop existing policies if any
DROP POLICY IF EXISTS "storage_exports_service_role" ON storage.objects;

-- Service role has full access (backend operations only)
CREATE POLICY "storage_exports_service_role" 
ON storage.objects FOR ALL 
TO service_role
USING (bucket_id = 'exports');

-- No user-level access policies = only service role can access
-- Users receive signed URLs with 24-hour expiry to download their export

-- ============================================================================
-- IMPORTANT: Lifecycle Policy Configuration
-- ============================================================================
-- Supabase does not support lifecycle policies via UI or SQL.
-- Instead, use the automated cleanup script:
-- 
-- Run weekly via cron/scheduler:
--   node ai-server/scripts/cleanup-old-exports.js
-- 
-- This script deletes files older than 7 days using the Storage API.
-- (well beyond the 24-hour signed URL expiry)
-- 
-- See: ai-server/scripts/cleanup-old-exports.js
-- ============================================================================

COMMENT ON TABLE storage.buckets IS 
    'Storage buckets configuration. exports bucket stores temporary user data export files with 7-day auto-cleanup.';
