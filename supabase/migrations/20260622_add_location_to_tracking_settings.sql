-- ============================================================================
-- Migration: Add location detection settings to tracking_settings
-- Date: 2026-06-22
--
-- Adds three columns read by the desktop app's _location_log_loop():
--   location_detection_enabled  — org-level on/off toggle
--   office_ssid_names           — WiFi SSIDs that identify office networks
--   office_subnet_prefixes      — CIDR ranges that identify office LANs
--
-- No RLS changes — existing tracking_settings policies cover these columns.
-- ============================================================================

ALTER TABLE public.tracking_settings
    ADD COLUMN IF NOT EXISTS location_detection_enabled BOOLEAN  NOT NULL DEFAULT TRUE,
    ADD COLUMN IF NOT EXISTS office_ssid_names          TEXT[]   NOT NULL DEFAULT '{}'::TEXT[],
    ADD COLUMN IF NOT EXISTS office_subnet_prefixes     TEXT[]   NOT NULL DEFAULT '{}'::TEXT[];

COMMENT ON COLUMN public.tracking_settings.location_detection_enabled IS
    'When FALSE, the desktop app skips all location detection for this org. '
    'Use in jurisdictions with strict monitoring laws (e.g., Germany works councils). '
    'Default TRUE — opt-out, not opt-in, because location collection is disclosed in the consent page.';

COMMENT ON COLUMN public.tracking_settings.office_ssid_names IS
    'WiFi SSID names that identify office locations. Case-sensitive. '
    'Example: {"Amzur-Office","Amzur-5G"}. '
    'Desktop app matches the connected SSID against this list. '
    'Leave empty if office WiFi detection is not needed.';

COMMENT ON COLUMN public.tracking_settings.office_subnet_prefixes IS
    'CIDR subnet prefixes that identify office LAN ranges (covers wired Ethernet). '
    'Example: {"10.0.0.0/8","192.168.100.0/24"}. '
    'Desktop app checks local IP against these ranges via Python ipaddress module. '
    'Leave empty if subnet detection is not needed.';
