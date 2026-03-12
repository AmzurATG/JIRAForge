-- Migration: Fix multiple_permissive_policies on SELECT for activity_records
--            and application_classifications
-- Date: 2026-03-11
--
-- Root cause:
--   Each table has two separate FOR SELECT permissive policies. PostgreSQL
--   already evaluates multiple permissive policies with OR between them, so
--   having two separate policies is functionally identical to one merged policy
--   but costs twice the evaluation overhead per query.
--
-- Fix: Merge each pair of SELECT policies into one combined policy using OR.
--   The merged condition is logically identical to the original two policies —
--   no access rules change, only query execution overhead is reduced.
--
-- activity_records:
--   BEFORE: select_own  → user_id = get_current_user_id()
--           select_org  → organization_id IN (user's orgs)
--   AFTER:  select      → user_id = get_current_user_id() OR org IN (user's orgs)
--
-- application_classifications:
--   BEFORE: select_defaults → is_default = TRUE AND organization_id IS NULL
--           select_org      → organization_id IN (user's orgs)
--   AFTER:  select          → (is_default = TRUE AND org IS NULL) OR org IN (user's orgs)

-- ============================================================================
-- activity_records: merge select_own + select_org → select
-- ============================================================================

DROP POLICY IF EXISTS "activity_records_select_own" ON public.activity_records;
DROP POLICY IF EXISTS "activity_records_select_org" ON public.activity_records;

CREATE POLICY "activity_records_select" ON public.activity_records
    FOR SELECT
    USING (
        user_id = (SELECT get_current_user_id())
        OR
        organization_id IN (
            SELECT organization_id FROM public.organization_members
            WHERE user_id = (SELECT get_current_user_id())
        )
    );

-- ============================================================================
-- application_classifications: merge select_defaults + select_org → select
-- ============================================================================

DROP POLICY IF EXISTS "app_class_select_defaults" ON public.application_classifications;
DROP POLICY IF EXISTS "app_class_select_org" ON public.application_classifications;

CREATE POLICY "app_class_select" ON public.application_classifications
    FOR SELECT
    USING (
        (is_default = TRUE AND organization_id IS NULL)
        OR
        organization_id IN (
            SELECT organization_id FROM public.organization_members
            WHERE user_id = (SELECT get_current_user_id())
        )
    );
