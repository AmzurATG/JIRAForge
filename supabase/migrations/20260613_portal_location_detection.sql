-- ============================================================================
-- Migration: Portal employee working-location detection (periodic, GeoIP)
-- Date: 2026-06-13
-- Spec: plan/2026-06-12_cross-component_automatic-employee-location-detection.md
--
-- Records the approximate location each employee is CURRENTLY working from,
-- for a work-from-anywhere workforce. ai-server derives an approximate
-- city/region/country from the client IP of the desktop app's (already
-- ~hourly) re-authentication requests, using an OFFLINE GeoIP database
-- (geoip-lite) — the IP is never sent to a third party and the full IP is
-- never stored (only a truncated /24 or /64 prefix, for audit).
--
--   portal_employee_work_locations — one row per employee, upserted on each
--     detection (throttled to ~3h server-side). user_id is a SOFT reference
--     to public.users(id) (NO FK), same pattern as portal_employee_profiles
--     so the portal can never block/cascade a Jira-side user delete.
--
-- This is approximate (city level), consent-gated on the desktop, and a
-- portal-only feature: the table is never read by the Forge app (plan §0.1).
-- RLS is service-role-only like all portal-owned tables. Company-wide (no
-- org_id) by design, same rationale as the 20260610 migration.
-- Re-runnable (IF NOT EXISTS / DROP POLICY IF EXISTS).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.portal_employee_work_locations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL,  -- soft reference to public.users(id); intentionally NO FK
    city        TEXT,
    region      TEXT,
    country     TEXT,           -- ISO-3166-1 alpha-2 (e.g. 'IN', 'US')
    ip_prefix   TEXT,           -- truncated network prefix only (e.g. 49.207.10.0/24) — never the full IP
    source      TEXT NOT NULL DEFAULT 'geoip' CHECK (source IN ('geoip')),
    detected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT portal_employee_work_locations_user_unique UNIQUE (user_id)
);
CREATE INDEX IF NOT EXISTS idx_portal_work_locations_country ON public.portal_employee_work_locations(country);
CREATE INDEX IF NOT EXISTS idx_portal_work_locations_detected_at ON public.portal_employee_work_locations(detected_at);

CREATE OR REPLACE FUNCTION update_portal_work_locations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
ALTER FUNCTION public.update_portal_work_locations_updated_at() SET search_path = '';

DROP TRIGGER IF EXISTS trigger_portal_work_locations_updated_at ON public.portal_employee_work_locations;
CREATE TRIGGER trigger_portal_work_locations_updated_at
    BEFORE UPDATE ON public.portal_employee_work_locations
    FOR EACH ROW EXECUTE FUNCTION update_portal_work_locations_updated_at();

ALTER TABLE public.portal_employee_work_locations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS portal_work_locations_service_role ON public.portal_employee_work_locations;
CREATE POLICY portal_work_locations_service_role ON public.portal_employee_work_locations
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

COMMENT ON TABLE public.portal_employee_work_locations IS 'Approximate current working location per employee (city/region/country), derived server-side from the client IP via offline GeoIP, refreshed ~every 3h. user_id soft-references users(id); ip_prefix is a truncated prefix, never the full client IP. Portal-only; company-wide.';
