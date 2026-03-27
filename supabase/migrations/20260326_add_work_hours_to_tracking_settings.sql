-- ============================================================================
-- Migration: Add working hours columns to tracking_settings
-- Date: 2026-03-26
--
-- Adds work_hours_start, work_hours_end, and work_days to tracking_settings
-- so admins can define the work window per org/project.
-- Idle blocks outside these hours are excluded from the timeline.
-- ============================================================================

ALTER TABLE public.tracking_settings
  ADD COLUMN IF NOT EXISTS work_hours_start TIME DEFAULT '09:00:00',
  ADD COLUMN IF NOT EXISTS work_hours_end TIME DEFAULT '18:00:00',
  ADD COLUMN IF NOT EXISTS work_days INTEGER[] DEFAULT '{1,2,3,4,5}';
  -- work_days: 1=Monday, 2=Tuesday, ..., 7=Sunday (ISO 8601)

-- ============================================================================
-- COMMENTS
-- ============================================================================

COMMENT ON COLUMN public.tracking_settings.work_hours_start
  IS 'Start of work day (local time). Idle outside this window is excluded from timeline.';
COMMENT ON COLUMN public.tracking_settings.work_hours_end
  IS 'End of work day (local time). Idle outside this window is excluded from timeline.';
COMMENT ON COLUMN public.tracking_settings.work_days
  IS 'Active work days (ISO: 1=Mon..7=Sun). Idle on non-work days is excluded.';
