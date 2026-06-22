-- ============================================================================
-- Migration: Add precise geolocation columns to user_location_log
-- Date: 2026-06-22
--
-- Adds latitude / longitude / accuracy_m for Windows precise geolocation
-- (Windows.Devices.Geolocation), and widens work_location_source to allow
-- 'win_geo'.
--
-- Additive and backward-compatible:
--   * New columns are nullable — existing rows are untouched.
--   * The CHECK is WIDENED (not narrowed), so older desktop builds that only
--     write 'ssid' / 'subnet' / 'ip_geo' keep working unchanged.
-- Re-runnable (IF NOT EXISTS / DROP CONSTRAINT IF EXISTS).
-- ============================================================================

ALTER TABLE public.user_location_log
    ADD COLUMN IF NOT EXISTS latitude   DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS longitude  DOUBLE PRECISION,
    ADD COLUMN IF NOT EXISTS accuracy_m DOUBLE PRECISION;

-- Widen the source CHECK to include Windows precise geolocation ('win_geo').
ALTER TABLE public.user_location_log
    DROP CONSTRAINT IF EXISTS user_location_log_work_location_source_check;
ALTER TABLE public.user_location_log
    ADD CONSTRAINT user_location_log_work_location_source_check
    CHECK (work_location_source IN ('ssid', 'subnet', 'ip_geo', 'win_geo'));

COMMENT ON COLUMN public.user_location_log.latitude IS
    'Device latitude from Windows precise geolocation (win_geo); null for other sources.';
COMMENT ON COLUMN public.user_location_log.longitude IS
    'Device longitude from Windows precise geolocation (win_geo); null for other sources.';
COMMENT ON COLUMN public.user_location_log.accuracy_m IS
    'Reported accuracy radius in metres for the win_geo fix (smaller = more precise).';
