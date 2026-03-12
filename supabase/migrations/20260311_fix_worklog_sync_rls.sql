-- Migration: Add missing RLS policy on worklog_sync
-- Date: 2026-03-11
-- Description:
--   worklog_sync has RLS enabled but zero policies, flagged by Supabase Security
--   Advisor as rls_enabled_no_policy.
--
-- What happened:
--   20260208_add_worklog_sync.sql: created table + enabled RLS + added
--     "Service role can manage all worklog_sync" (USING auth.role() = 'service_role')
--   20260211_fix_rls_performance.sql: correctly dropped that policy because
--     service_role bypasses RLS automatically — no explicit policy needed.
--   Result: RLS enabled, zero policies → advisor warning.
--
-- Fix:
--   Add a SELECT policy so authenticated users can view their own records.
--   No INSERT/UPDATE/DELETE policy for users — writes are intentionally
--   restricted to service_role only (the scheduled worklog sync job).
--   Consistent with the pattern used on: worklogs, activity_records, screenshots.
--
-- Access pattern (confirmed in codebase):
--   All reads/writes go through AI server → service_role key (bypasses RLS).
--   No direct authenticated user access exists today — this policy is
--   defense-in-depth and resolves the advisor warning.

DROP POLICY IF EXISTS "worklog_sync_select_own" ON public.worklog_sync;
CREATE POLICY "worklog_sync_select_own" ON public.worklog_sync
    FOR SELECT USING (
        user_id IN (SELECT id FROM public.users WHERE supabase_user_id = (SELECT auth.uid()))
    );
