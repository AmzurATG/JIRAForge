-- ============================================================================
-- Migration: Portal employee profiles + managed locations (WS-B)
-- Date: 2026-06-10
-- Spec: plan/2026-06-10_web-productivity-portal_ux-improvements.md §6.1
--
-- Adds the portal-owned "Employee Location" attribute:
--   1. portal_locations          — managed list of locations (superadmin CRUD)
--   2. portal_employee_profiles  — per-employee portal attributes; user_id is a
--                                  SOFT reference to public.users(id) (NO FK),
--                                  same pattern as portal_lob_employees, so the
--                                  portal can never block/cascade a Jira-side
--                                  user delete. location_id ON DELETE RESTRICT
--                                  (the API returns 409 before attempting it).
--
-- Both tables are portal-owned and company-wide (no org_id) by design — the
-- portal is a single-tenant deployment reading across the company's Jira orgs
-- (LOB plan §0.6); same rationale as portal_lobs.
--
-- RLS: the portal uses the service-role key; authorization is enforced in
-- ai-server code. The service_role policies below are defense-in-depth only.
-- Re-runnable (IF NOT EXISTS / DROP POLICY IF EXISTS).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. portal_locations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.portal_locations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(120) NOT NULL,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_by  UUID REFERENCES public.portal_admin_users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT portal_locations_name_unique UNIQUE (name)
);
CREATE INDEX IF NOT EXISTS idx_portal_locations_is_active ON public.portal_locations(is_active);
CREATE INDEX IF NOT EXISTS idx_portal_locations_created_by ON public.portal_locations(created_by);

CREATE OR REPLACE FUNCTION update_portal_locations_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
ALTER FUNCTION public.update_portal_locations_updated_at() SET search_path = '';

DROP TRIGGER IF EXISTS trigger_portal_locations_updated_at ON public.portal_locations;
CREATE TRIGGER trigger_portal_locations_updated_at
    BEFORE UPDATE ON public.portal_locations
    FOR EACH ROW EXECUTE FUNCTION update_portal_locations_updated_at();

ALTER TABLE public.portal_locations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS portal_locations_service_role ON public.portal_locations;
CREATE POLICY portal_locations_service_role ON public.portal_locations
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

COMMENT ON TABLE public.portal_locations IS 'Managed list of employee locations for the portal (superadmin CRUD). Portal-owned; company-wide.';

-- ---------------------------------------------------------------------------
-- 2. portal_employee_profiles
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.portal_employee_profiles (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     UUID NOT NULL,  -- soft reference to public.users(id); intentionally NO FK
    location_id UUID REFERENCES public.portal_locations(id) ON DELETE RESTRICT,
    updated_by  UUID REFERENCES public.portal_admin_users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT portal_employee_profiles_user_unique UNIQUE (user_id)
);
CREATE INDEX IF NOT EXISTS idx_portal_employee_profiles_location ON public.portal_employee_profiles(location_id);
CREATE INDEX IF NOT EXISTS idx_portal_employee_profiles_updated_by ON public.portal_employee_profiles(updated_by);

CREATE OR REPLACE FUNCTION update_portal_employee_profiles_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;
ALTER FUNCTION public.update_portal_employee_profiles_updated_at() SET search_path = '';

DROP TRIGGER IF EXISTS trigger_portal_employee_profiles_updated_at ON public.portal_employee_profiles;
CREATE TRIGGER trigger_portal_employee_profiles_updated_at
    BEFORE UPDATE ON public.portal_employee_profiles
    FOR EACH ROW EXECUTE FUNCTION update_portal_employee_profiles_updated_at();

ALTER TABLE public.portal_employee_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS portal_employee_profiles_service_role ON public.portal_employee_profiles;
CREATE POLICY portal_employee_profiles_service_role ON public.portal_employee_profiles
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

COMMENT ON TABLE public.portal_employee_profiles IS 'Portal-owned per-employee attributes (currently location). user_id soft-references users(id); Department/Shift can be added as columns later.';
