-- Migration: Add request_id column for idempotency
-- Date: 2026-05-07
-- Purpose: Prevent duplicate activity submissions from network retries
--
-- Context: The AI server currently has no protection against duplicate activity
-- submissions. When the desktop app retries a failed HTTP POST due to network
-- flakiness, each retry creates a new row in activity_records, inflating user
-- totals by 3-4x. This migration adds a request_id UUID column that the desktop
-- app will populate with a unique identifier for each submission. The AI server
-- will check for existing request_id before inserting, returning success without
-- creating duplicate records.

-- Add nullable request_id column to activity_records table
-- Nullable to allow existing records without request_id
ALTER TABLE activity_records 
ADD COLUMN IF NOT EXISTS request_id UUID;

-- Create unique index on request_id (only for non-null values)
-- This enforces uniqueness while allowing existing records to remain NULL
CREATE UNIQUE INDEX IF NOT EXISTS idx_activity_request_id 
ON activity_records(request_id) 
WHERE request_id IS NOT NULL;

-- Add documentation comment
COMMENT ON COLUMN activity_records.request_id IS 
  'Unique request identifier for idempotency. Desktop app generates UUID per submission. Server checks this before inserting to prevent duplicate records from network retries.';
