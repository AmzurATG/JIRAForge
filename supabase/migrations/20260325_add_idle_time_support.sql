-- ============================================================================
-- Migration: Add idle time support to activity_records
-- Date: 2026-03-25
--
-- Adds columns to track idle periods during work hours. The desktop app
-- records idle blocks (system sleep, screen lock, or inactivity timeout)
-- which can then be displayed on the timeline and optionally converted
-- to worklogs by the user.
-- ============================================================================

-- 1. Extend classification CHECK to include 'idle'
ALTER TABLE public.activity_records
  DROP CONSTRAINT IF EXISTS activity_records_classification_check;

ALTER TABLE public.activity_records
  ADD CONSTRAINT activity_records_classification_check
  CHECK (classification IN ('productive', 'non_productive', 'private', 'unknown', 'idle'));

-- 2. Add idle-tracking columns
ALTER TABLE public.activity_records
  ADD COLUMN IF NOT EXISTS is_idle BOOLEAN DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS idle_start_time TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS idle_end_time TIMESTAMPTZ;

-- 3. Add reclassification columns (for converting idle → worklog)
ALTER TABLE public.activity_records
  ADD COLUMN IF NOT EXISTS reclassified_from TEXT,
  ADD COLUMN IF NOT EXISTS reclassified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS reclassified_by TEXT,
  ADD COLUMN IF NOT EXISTS reclassification_reason TEXT,
  ADD COLUMN IF NOT EXISTS converted_issue_key TEXT,
  ADD COLUMN IF NOT EXISTS worklog_id TEXT;

-- 4. Index for efficient idle-block queries during timeline fetch
CREATE INDEX IF NOT EXISTS idx_activity_idle_user_date
  ON public.activity_records(user_id, work_date)
  WHERE is_idle = TRUE;

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON COLUMN public.activity_records.is_idle IS 'True if this record represents an idle period (no user activity)';
COMMENT ON COLUMN public.activity_records.idle_start_time IS 'When idle period began (UTC)';
COMMENT ON COLUMN public.activity_records.idle_end_time IS 'When idle period ended (UTC) — user resumed activity';
COMMENT ON COLUMN public.activity_records.reclassified_from IS 'Original classification before user converted idle to worklog';
COMMENT ON COLUMN public.activity_records.reclassified_at IS 'When the reclassification happened';
COMMENT ON COLUMN public.activity_records.reclassified_by IS 'Atlassian account ID of user who reclassified';
COMMENT ON COLUMN public.activity_records.reclassification_reason IS 'User-provided reason when converting idle to worklog';
COMMENT ON COLUMN public.activity_records.converted_issue_key IS 'Jira issue key the idle time was assigned to';
COMMENT ON COLUMN public.activity_records.worklog_id IS 'Jira worklog ID created from this idle block';
