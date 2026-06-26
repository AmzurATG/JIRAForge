-- ============================================================================
-- Migration: Portal LOB expected-member roster (adoption tracking)
-- Date: 2026-06-26
-- Spec: plan/2026-06-26_web-productivity-portal_lob-roster-adoption.md
--
-- Email-keyed "intended team" per LOB, imported from Excel/CSV by a superadmin.
-- Installed-vs-not is DERIVED at read time by matching email -> users.email; this
-- table is NEVER written when a user installs. Portal-owned; soft reference to
-- users by EMAIL only (no FK), so it can never block/cascade a Jira-side user
-- delete. RLS service_role only (portal uses the service-role key; authorization
-- is enforced in ai-server code). Re-runnable (IF NOT EXISTS / DROP IF EXISTS).
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.portal_lob_expected_members (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lob_id      UUID NOT NULL REFERENCES public.portal_lobs(id) ON DELETE CASCADE,
    email       TEXT NOT NULL,                 -- stored normalized: lower(trim(email))
    full_name   TEXT,
    imported_by UUID REFERENCES public.portal_admin_users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT portal_lob_expected_members_unique UNIQUE (lob_id, email)
);
CREATE INDEX IF NOT EXISTS idx_portal_lob_expected_members_lob   ON public.portal_lob_expected_members(lob_id);
CREATE INDEX IF NOT EXISTS idx_portal_lob_expected_members_email ON public.portal_lob_expected_members(email);

CREATE OR REPLACE FUNCTION update_portal_lob_expected_members_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_portal_lob_expected_members_updated_at ON public.portal_lob_expected_members;
CREATE TRIGGER trigger_portal_lob_expected_members_updated_at
    BEFORE UPDATE ON public.portal_lob_expected_members
    FOR EACH ROW EXECUTE FUNCTION update_portal_lob_expected_members_updated_at();

ALTER TABLE public.portal_lob_expected_members ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS portal_lob_expected_members_service_role ON public.portal_lob_expected_members;
CREATE POLICY portal_lob_expected_members_service_role ON public.portal_lob_expected_members
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

COMMENT ON TABLE public.portal_lob_expected_members IS
  'Per-LOB imported expected roster (email-keyed). Install status is derived by matching email against users.email at read time; never written on install. Portal-owned, no FK to Jira users.';
