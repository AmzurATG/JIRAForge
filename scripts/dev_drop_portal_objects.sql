-- ============================================================================
-- One-off script: Drop HR/Web Productivity Portal objects — DEV ONLY
-- Target: dev Supabase project jvijitdewbypqbatfboi. Do NOT run on prod.
-- Date: 2026-09-29
--
-- Kept out of supabase/migrations/ on purpose so `supabase db push` / replay
-- never applies it to prod.
--
-- The portal has moved to its own repository and its own database; its code
-- has been removed from this repo. This drops the DB objects that only the
-- portal used.
--
-- Deliberately KEPT (still used by the timetracker):
--   org_email_domains    -> forge-app emailDomainService, ai-server Google auth
--   user_location_log    -> python-desktop-app location reporting
--   users.auth_provider / users.google_sub -> Google (non-Jira) sign-in
--
-- Safety: no CASCADE anywhere. If any object outside this list depends on a
-- dropped object, the statement errors and the whole transaction rolls back.
-- Verified before writing (dev, jvijitdewbypqbatfboi): no non-portal table has
-- a foreign key into a portal_* table, and no view is defined on them.
--
-- Rollback: re-run the original portal migrations (20260521_add_portal_admin_users
-- ... 20260702_portal_employee_presence). Data is NOT recoverable — take a
-- backup / pg_dump of the portal_* tables first if you need it.
-- ============================================================================

BEGIN;

-- 1. Portal analytics RPCs (read activity_records/users; nothing calls them now)
DROP FUNCTION IF EXISTS public.portal_dashboard_summary(date, date, uuid[]);
DROP FUNCTION IF EXISTS public.portal_employee_summary(date, date, uuid[]);
DROP FUNCTION IF EXISTS public.portal_app_usage_summary(date, date, uuid[], text);
DROP FUNCTION IF EXISTS public.portal_employee_presence(date, uuid[]);

-- 2. Tables, children before parents (FK order)
DROP TABLE IF EXISTS public.portal_lob_app_classifications;
DROP TABLE IF EXISTS public.portal_lob_expected_members;
DROP TABLE IF EXISTS public.portal_lob_employees;
DROP TABLE IF EXISTS public.portal_lob_heads;
DROP TABLE IF EXISTS public.portal_employee_profiles;
DROP TABLE IF EXISTS public.portal_app_catalog;
DROP TABLE IF EXISTS public.portal_lobs;
DROP TABLE IF EXISTS public.portal_locations;
DROP TABLE IF EXISTS public.portal_holidays;
DROP TABLE IF EXISTS public.portal_admin_users;

-- 3. updated_at trigger functions (their triggers went with the tables)
DROP FUNCTION IF EXISTS public.update_portal_lobs_updated_at();
DROP FUNCTION IF EXISTS public.update_portal_app_catalog_updated_at();
DROP FUNCTION IF EXISTS public.update_portal_lob_app_class_updated_at();
DROP FUNCTION IF EXISTS public.update_portal_locations_updated_at();
DROP FUNCTION IF EXISTS public.update_portal_employee_profiles_updated_at();
DROP FUNCTION IF EXISTS public.update_portal_holidays_updated_at();
DROP FUNCTION IF EXISTS public.update_portal_lob_expected_members_updated_at();

COMMIT;

-- ----------------------------------------------------------------------------
-- 4. OPTIONAL, run separately (CONCURRENTLY cannot run inside a transaction).
-- Covering index on activity_records added only for the portal RPCs above.
-- Dropping it does not change any query result; it only frees disk/write cost.
-- Leave it if you want zero risk to activity_records query plans.
--
--   DROP INDEX CONCURRENTLY IF EXISTS public.idx_activity_portal_analytics;
-- ----------------------------------------------------------------------------
