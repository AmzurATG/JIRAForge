-- ============================================================================
-- Migration: Portal LOB Segmentation & RBAC — all tables (Phase 1)
-- Date: 2026-06-02
-- Spec: plan/2026-06-01_web-productivity-portal_lob-segmentation-rbac.md §6.1
--
-- Creates all PORTAL-OWNED tables for the LOB feature in dependency order
-- (single file so apply-order is guaranteed regardless of filename sorting):
--   1. portal_lobs
--   2. portal_app_catalog
--   3. portal_lob_employees            (FK -> portal_lobs)
--   4. portal_lob_heads                (FK -> portal_lobs, portal_admin_users)
--   5. portal_lob_app_classifications  (FK -> portal_lobs, portal_app_catalog)
--
-- No Jira-owned table (users, activity_records, organizations,
-- application_classifications) is created, altered, or FK-referenced.
-- user_id in portal_lob_employees is a SOFT reference to users(id) (no FK),
-- so portal data can never block/cascade a Jira-side user delete.
--
-- RLS note: the portal uses the Supabase service-role key, so authorization is
-- enforced in ai-server application code; the service_role policies below are
-- defense-in-depth only. Re-runnable (IF NOT EXISTS / DROP POLICY IF EXISTS).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. portal_lobs
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.portal_lobs (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name        VARCHAR(255) NOT NULL,
    description TEXT,
    is_active   BOOLEAN NOT NULL DEFAULT TRUE,
    created_by  UUID REFERENCES public.portal_admin_users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT portal_lobs_name_unique UNIQUE (name)
);
CREATE INDEX IF NOT EXISTS idx_portal_lobs_is_active ON public.portal_lobs(is_active);

CREATE OR REPLACE FUNCTION update_portal_lobs_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_portal_lobs_updated_at ON public.portal_lobs;
CREATE TRIGGER trigger_portal_lobs_updated_at
    BEFORE UPDATE ON public.portal_lobs
    FOR EACH ROW EXECUTE FUNCTION update_portal_lobs_updated_at();

ALTER TABLE public.portal_lobs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS portal_lobs_service_role ON public.portal_lobs;
CREATE POLICY portal_lobs_service_role ON public.portal_lobs
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

COMMENT ON TABLE public.portal_lobs IS 'Portal Line-of-Business groupings (company-wide, superadmin-managed). Not tied to Jira organizations.';

-- ---------------------------------------------------------------------------
-- 2. portal_app_catalog
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.portal_app_catalog (
    id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    identifier             TEXT NOT NULL,
    display_name           TEXT NOT NULL,
    match_by               TEXT NOT NULL CHECK (match_by IN ('process', 'url')),
    default_classification TEXT CHECK (default_classification IN ('productive', 'non_productive', 'private', 'neutral')),
    is_seed                BOOLEAN NOT NULL DEFAULT FALSE,
    is_active              BOOLEAN NOT NULL DEFAULT TRUE,
    created_by             UUID REFERENCES public.portal_admin_users(id) ON DELETE SET NULL,
    created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT portal_app_catalog_unique UNIQUE (identifier, match_by)
);
CREATE INDEX IF NOT EXISTS idx_portal_app_catalog_match_by  ON public.portal_app_catalog(match_by);
CREATE INDEX IF NOT EXISTS idx_portal_app_catalog_is_active ON public.portal_app_catalog(is_active);

CREATE OR REPLACE FUNCTION update_portal_app_catalog_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_portal_app_catalog_updated_at ON public.portal_app_catalog;
CREATE TRIGGER trigger_portal_app_catalog_updated_at
    BEFORE UPDATE ON public.portal_app_catalog
    FOR EACH ROW EXECUTE FUNCTION update_portal_app_catalog_updated_at();

ALTER TABLE public.portal_app_catalog ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS portal_app_catalog_service_role ON public.portal_app_catalog;
CREATE POLICY portal_app_catalog_service_role ON public.portal_app_catalog
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

COMMENT ON TABLE public.portal_app_catalog IS 'Shared portal application catalog (desktop/process + browser/url). Superadmin-managed; portal-only, independent of Jira application_classifications.';

-- ---------------------------------------------------------------------------
-- 3. portal_lob_employees (M:N LOB <-> employee; soft ref to users)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.portal_lob_employees (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lob_id     UUID NOT NULL REFERENCES public.portal_lobs(id) ON DELETE CASCADE,
    user_id    UUID NOT NULL,  -- soft reference to public.users(id); intentionally NO FK
    added_by   UUID REFERENCES public.portal_admin_users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT portal_lob_employees_unique UNIQUE (lob_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_portal_lob_employees_lob  ON public.portal_lob_employees(lob_id);
CREATE INDEX IF NOT EXISTS idx_portal_lob_employees_user ON public.portal_lob_employees(user_id);

ALTER TABLE public.portal_lob_employees ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS portal_lob_employees_service_role ON public.portal_lob_employees;
CREATE POLICY portal_lob_employees_service_role ON public.portal_lob_employees
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

COMMENT ON TABLE public.portal_lob_employees IS 'M:N mapping of tracked employees (users.id, soft reference) to portal LOBs.';

-- ---------------------------------------------------------------------------
-- 4. portal_lob_heads (M:N LOB <-> portal admin head)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.portal_lob_heads (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lob_id      UUID NOT NULL REFERENCES public.portal_lobs(id) ON DELETE CASCADE,
    admin_id    UUID NOT NULL REFERENCES public.portal_admin_users(id) ON DELETE CASCADE,
    role        TEXT NOT NULL DEFAULT 'head' CHECK (role IN ('head', 'viewer')),
    assigned_by UUID REFERENCES public.portal_admin_users(id) ON DELETE SET NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT portal_lob_heads_unique UNIQUE (lob_id, admin_id)
);
CREATE INDEX IF NOT EXISTS idx_portal_lob_heads_admin ON public.portal_lob_heads(admin_id);
CREATE INDEX IF NOT EXISTS idx_portal_lob_heads_lob   ON public.portal_lob_heads(lob_id);

ALTER TABLE public.portal_lob_heads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS portal_lob_heads_service_role ON public.portal_lob_heads;
CREATE POLICY portal_lob_heads_service_role ON public.portal_lob_heads
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

COMMENT ON TABLE public.portal_lob_heads IS 'M:N assignment of portal admins as heads of LOBs. role column reserved for a future viewer tier.';

-- ---------------------------------------------------------------------------
-- 5. portal_lob_app_classifications (per-LOB classification of catalog apps)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.portal_lob_app_classifications (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lob_id         UUID NOT NULL REFERENCES public.portal_lobs(id) ON DELETE CASCADE,
    app_id         UUID NOT NULL REFERENCES public.portal_app_catalog(id) ON DELETE CASCADE,
    classification TEXT NOT NULL CHECK (classification IN ('productive', 'non_productive', 'private', 'neutral')),
    created_by     UUID REFERENCES public.portal_admin_users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT portal_lob_app_class_unique UNIQUE (lob_id, app_id)
);
CREATE INDEX IF NOT EXISTS idx_portal_lob_app_class_lob ON public.portal_lob_app_classifications(lob_id);
CREATE INDEX IF NOT EXISTS idx_portal_lob_app_class_app ON public.portal_lob_app_classifications(app_id);

CREATE OR REPLACE FUNCTION update_portal_lob_app_class_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trigger_portal_lob_app_class_updated_at ON public.portal_lob_app_classifications;
CREATE TRIGGER trigger_portal_lob_app_class_updated_at
    BEFORE UPDATE ON public.portal_lob_app_classifications
    FOR EACH ROW EXECUTE FUNCTION update_portal_lob_app_class_updated_at();

ALTER TABLE public.portal_lob_app_classifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS portal_lob_app_class_service_role ON public.portal_lob_app_classifications;
CREATE POLICY portal_lob_app_class_service_role ON public.portal_lob_app_classifications
    FOR ALL USING (auth.role() = 'service_role') WITH CHECK (auth.role() = 'service_role');

COMMENT ON TABLE public.portal_lob_app_classifications IS 'Per-LOB classification (productive/non_productive/private/neutral) of catalog apps. Same app may differ per LOB.';
