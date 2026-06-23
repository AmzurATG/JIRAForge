-- ============================================================================
-- Migration: Portal company holidays
-- Date: 2026-06-23
-- Spec: plan/2026-06-23_web-productivity-portal_holidays-legal-hours-and-category-percentages.md
--
-- Adds the portal-owned, COMPANY-WIDE holiday list used to:
--   * let superadmins manage holidays in the portal (Holidays page), and
--   * compute "legal hours" for the monthly (Employee Summary) report =
--     (Mon-Fri working days in range - active holidays in range) x hours/day.
--
-- Global by design (no org_id, no location/LOB scope) — same single-tenant
-- rationale as portal_locations / portal_lobs. holiday_date is UNIQUE so the
-- list holds one row per calendar day.
--
-- RLS: the portal uses the service-role key; authorization is enforced in
-- ai-server code. The service_role policy below is defense-in-depth only.
-- Re-runnable (IF NOT EXISTS / DROP POLICY IF EXISTS).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.portal_holidays (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    holiday_date DATE NOT NULL,
    name         TEXT NOT NULL,
    is_active    BOOLEAN NOT NULL DEFAULT TRUE,
    created_by   UUID REFERENCES public.portal_admin_users(id) ON DELETE SET NULL,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT portal_holidays_date_unique UNIQUE (holiday_date)
);
CREATE INDEX IF NOT EXISTS idx_portal_holidays_date      ON public.portal_holidays(holiday_date);
CREATE INDEX IF NOT EXISTS idx_portal_holidays_is_active ON public.portal_holidays(is_active);

CREATE OR REPLACE FUNCTION update_portal_holidays_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
ALTER FUNCTION public.update_portal_holidays_updated_at() SET search_path = '';

DROP TRIGGER IF EXISTS trigger_portal_holidays_updated_at ON public.portal_holidays;
CREATE TRIGGER trigger_portal_holidays_updated_at
    BEFORE UPDATE ON public.portal_holidays
    FOR EACH ROW EXECUTE FUNCTION update_portal_holidays_updated_at();

ALTER TABLE public.portal_holidays ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS portal_holidays_service_role ON public.portal_holidays;
CREATE POLICY portal_holidays_service_role ON public.portal_holidays
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

COMMENT ON TABLE public.portal_holidays IS 'Company-wide portal holiday list (superadmin-managed). Drives legal-hours on the monthly report. Portal-owned; no org_id.';
