-- ============================================================================
-- Migration: Add unassigned work conversion tracking columns
-- Date: 2026-04-17
--
-- Adds columns to track when unassigned work is manually converted to a Jira issue,
-- including the user-provided reason for audit trail purposes.
-- ============================================================================

-- Add conversion_reason and converted_at columns to activity_records
ALTER TABLE public.activity_records
ADD COLUMN IF NOT EXISTS conversion_reason TEXT,
ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ;

-- Add comment for new columns
COMMENT ON COLUMN public.activity_records.conversion_reason IS 'User-provided reason when manually converting unassigned work to a Jira issue';
COMMENT ON COLUMN public.activity_records.converted_at IS 'Timestamp when unassigned work was manually converted to a Jira issue';

-- Add index for converted_at for queries filtering by conversion time
CREATE INDEX IF NOT EXISTS idx_activity_converted_at ON public.activity_records(converted_at);

-- ============================================================================
-- Now also add these columns to idle conversions (reclassified entries)
-- If an idle record becomes productive via reclassification, track the reason
-- ============================================================================

-- These columns already exist from the idle conversion feature:
-- - reclassified_from (previous classification)
-- - reclassified_at (timestamp)
-- - reclassified_by (who reclassified)
-- - reclassification_reason (why it was reclassified)
-- No action needed for idle conversions
