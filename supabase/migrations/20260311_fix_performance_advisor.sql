-- Migration: Fix Performance Advisor warnings
-- Date: 2026-03-11
--
-- PART 1 — auth_rls_initplan (WARN x10):
--   auth.uid() / auth.jwt() / auth.role() without (select ...) wrapper are
--   evaluated once per ROW. Wrapping in (select ...) makes PostgreSQL evaluate
--   them once per QUERY — significant improvement on large tables.
--   Affected tables: feedback, ocr_test_results, notification_logs,
--                    notification_preferences, activity_records (via part 2)
--
-- PART 2 — multiple_permissive_policies (WARN x18):
--   activity_records and application_classifications each have a FOR ALL
--   service_role policy using USING (auth.role() = 'service_role') that
--   overlaps with all their user-specific policies. This causes:
--     - Every query to evaluate BOTH the service_role policy AND the
--       user-specific policy (PostgreSQL cannot short-circuit permissive policies)
--     - auth_rls_initplan: auth.role() re-evaluated per row
--   Fix: DROP them. service_role bypasses RLS automatically in Supabase —
--   no explicit policy needed. Same pattern applied previously to:
--   feedback, worklog_sync, app_releases, project_settings.

-- ============================================================================
-- PART 1: Fix auth_rls_initplan — wrap auth.* calls with (select ...)
-- ============================================================================

-- feedback: "Users can view their own feedback"
-- (previously fixed in 20260212 but may not have been applied to this DB)
DROP POLICY IF EXISTS "Users can view their own feedback" ON public.feedback;
CREATE POLICY "Users can view their own feedback" ON public.feedback
    FOR SELECT USING (atlassian_account_id = ((SELECT auth.jwt()) ->> 'sub'));

-- ocr_test_results: SELECT
DROP POLICY IF EXISTS "Users can view own OCR test results" ON public.ocr_test_results;
CREATE POLICY "Users can view own OCR test results"
    ON public.ocr_test_results FOR SELECT
    USING (user_id = (SELECT auth.uid()));

-- ocr_test_results: INSERT
DROP POLICY IF EXISTS "Users can insert own OCR test results" ON public.ocr_test_results;
CREATE POLICY "Users can insert own OCR test results"
    ON public.ocr_test_results FOR INSERT
    WITH CHECK (user_id = (SELECT auth.uid()));

-- notification_logs: SELECT
DROP POLICY IF EXISTS "Users can view own notification logs" ON public.notification_logs;
CREATE POLICY "Users can view own notification logs"
    ON public.notification_logs FOR SELECT
    TO authenticated
    USING (user_id = (SELECT auth.uid()));

-- notification_preferences: SELECT
DROP POLICY IF EXISTS "Users can view own notification preferences" ON public.notification_preferences;
CREATE POLICY "Users can view own notification preferences"
    ON public.notification_preferences FOR SELECT
    TO authenticated
    USING (user_id = (SELECT auth.uid()));

-- notification_preferences: UPDATE
DROP POLICY IF EXISTS "Users can update own notification preferences" ON public.notification_preferences;
CREATE POLICY "Users can update own notification preferences"
    ON public.notification_preferences FOR UPDATE
    TO authenticated
    USING (user_id = (SELECT auth.uid()))
    WITH CHECK (user_id = (SELECT auth.uid()));

-- notification_preferences: INSERT
DROP POLICY IF EXISTS "Users can insert own notification preferences" ON public.notification_preferences;
CREATE POLICY "Users can insert own notification preferences"
    ON public.notification_preferences FOR INSERT
    TO authenticated
    WITH CHECK (user_id = (SELECT auth.uid()));

-- ============================================================================
-- PART 2: Fix multiple_permissive_policies — drop redundant service_role policies
-- ============================================================================
-- These FOR ALL policies using USING (auth.role() = 'service_role') are redundant
-- because service_role bypasses RLS entirely. They also cause every non-service_role
-- query to evaluate an extra policy per row, compounding with auth_rls_initplan.

DROP POLICY IF EXISTS "activity_records_service_role" ON public.activity_records;
DROP POLICY IF EXISTS "app_class_service_role" ON public.application_classifications;
