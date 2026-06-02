-- ============================================================================
-- Migration: Portal LOB — Supabase advisor fixes (search_path + FK indexes)
-- Date: 2026-06-02
-- Follow-up to 20260602_add_portal_lob_segmentation.sql (kept separate because
-- that migration may already be applied — never edit an applied migration).
--
-- Addresses two Supabase advisor classes the repo already standardised on in
-- 20260212_fix_function_search_paths.sql:
--   1. function_search_path_mutable  -> set an immutable empty search_path on
--      the new updated_at trigger functions.
--   2. unindexed_foreign_keys        -> index the created_by / added_by /
--      assigned_by FK columns (the lob_id / admin_id / app_id / user_id FKs are
--      already indexed by the create migration).
--
-- Re-runnable. ALTER FUNCTION targets exist because the create migration sorts
-- before this file. NOW() still resolves under search_path='' (pg_catalog is
-- always implicitly searched).
-- ============================================================================

-- 1. Immutable search_path on the trigger functions
ALTER FUNCTION public.update_portal_lobs_updated_at() SET search_path = '';
ALTER FUNCTION public.update_portal_app_catalog_updated_at() SET search_path = '';
ALTER FUNCTION public.update_portal_lob_app_class_updated_at() SET search_path = '';

-- 2. Indexes on the audit FK columns (referencing portal_admin_users)
CREATE INDEX IF NOT EXISTS idx_portal_lobs_created_by
    ON public.portal_lobs(created_by);
CREATE INDEX IF NOT EXISTS idx_portal_app_catalog_created_by
    ON public.portal_app_catalog(created_by);
CREATE INDEX IF NOT EXISTS idx_portal_lob_employees_added_by
    ON public.portal_lob_employees(added_by);
CREATE INDEX IF NOT EXISTS idx_portal_lob_heads_assigned_by
    ON public.portal_lob_heads(assigned_by);
CREATE INDEX IF NOT EXISTS idx_portal_lob_app_class_created_by
    ON public.portal_lob_app_classifications(created_by);
