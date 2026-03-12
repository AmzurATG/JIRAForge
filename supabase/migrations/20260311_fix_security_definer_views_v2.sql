-- Migration: Fix Security Advisor warnings (v2)
-- Date: 2026-03-11
-- Description:
--   Addresses all remaining Supabase Security Advisor ERRORs and WARNs.
--
-- PART 1 — security_definer_view (ERROR x11):
--   Re-applies SECURITY INVOKER to all flagged views. These views lost the
--   security_invoker setting when the database was rebuilt from a schema export
--   (pg_dump does not preserve view options like security_invoker).
--   Supersedes: 20260211_fix_security_definer_views.sql
--
-- PART 2 — function_search_path_mutable (WARN x7):
--   Sets immutable search_path = '' on all newly-flagged functions.
--   Supersedes: 20260212_fix_function_search_paths.sql (covered older functions)
--   All function bodies already use fully-qualified names or built-ins, so
--   setting search_path = '' has no functional impact.
--
-- PART 3 — rls_policy_always_true (WARN x1):
--   Drops the redundant "USING (true)" service_role policy on ocr_test_results.
--   service_role bypasses RLS automatically in Supabase — no explicit policy needed.
--   Same pattern already applied to feedback, worklog_sync, app_releases, etc.
--   in migration 20260212_fix_function_search_paths.sql.

-- ============================================================================
-- PART 1: Fix SECURITY DEFINER views → SECURITY INVOKER
-- ============================================================================

ALTER VIEW public.activity_sessions           SET (security_invoker = on);
ALTER VIEW public.daily_time_summary          SET (security_invoker = on);
ALTER VIEW public.monthly_time_summary        SET (security_invoker = on);
ALTER VIEW public.ocr_test_summary            SET (security_invoker = on);
ALTER VIEW public.project_time_summary        SET (security_invoker = on);
ALTER VIEW public.team_analytics_summary      SET (security_invoker = on);
ALTER VIEW public.team_work_type_analytics    SET (security_invoker = on);
ALTER VIEW public.unassigned_activity_summary SET (security_invoker = on);
ALTER VIEW public.user_activity_summary       SET (security_invoker = on);
ALTER VIEW public.weekly_time_summary         SET (security_invoker = on);
ALTER VIEW public.work_type_analytics         SET (security_invoker = on);

-- ============================================================================
-- PART 2: Fix mutable search_path on functions
-- ============================================================================
-- Safe because all function bodies already use schema-qualified names or
-- built-in functions (NOW(), CURRENT_DATE, current_setting(), etc.) that do
-- not depend on search_path. net.http_post() in notify_activity_webhook is
-- already schema-qualified.

ALTER FUNCTION public.update_app_classifications_updated_at()        SET search_path = '';
ALTER FUNCTION public.update_activity_records_updated_at()           SET search_path = '';
ALTER FUNCTION public.compute_activity_work_date()                   SET search_path = '';
ALTER FUNCTION public.update_notification_logs_updated_at()          SET search_path = '';
ALTER FUNCTION public.update_notification_preferences_updated_at()   SET search_path = '';
ALTER FUNCTION public.update_notification_cooldown(UUID, TEXT)       SET search_path = '';
ALTER FUNCTION public.notify_activity_webhook()                      SET search_path = '';

-- ============================================================================
-- PART 3: Drop over-permissive RLS policy on ocr_test_results
-- ============================================================================
-- The "USING (true) WITH CHECK (true)" policy on ALL operations is flagged as
-- rls_policy_always_true. service_role bypasses RLS automatically, so this
-- policy is redundant. The existing per-user SELECT and INSERT policies remain.

DROP POLICY IF EXISTS "Service role has full access to OCR test results" ON public.ocr_test_results;
