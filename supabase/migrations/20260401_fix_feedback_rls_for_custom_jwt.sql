-- ============================================================================
-- Migration: Fix feedback RLS policy for custom JWT
-- Date: 2026-04-01
--
-- CONTEXT:
-- The JWT `sub` claim was changed from `atlassianAccountId` (string) to
-- `dbUser.id` (UUID) to enable RLS via auth.uid() = users.id.
--
-- The feedback table's SELECT policy previously compared:
--   atlassian_account_id = auth.jwt() ->> 'sub'
-- This worked when sub was the Atlassian account ID, but now sub is a UUID
-- so the comparison will never match.
--
-- FIX:
-- Compare atlassian_account_id against the `atlassian_account_id` custom
-- claim in the JWT (NOT `sub`). This claim is set as a top-level field in
-- the JWT payload by the AI server (auth-controller.js line 628).
--
-- NOTE: Cannot use user_id = get_current_user_id() because the feedback
-- insert code (feedback-db-service.js) does not set user_id — only
-- atlassian_account_id is populated.
-- ============================================================================

-- Drop and recreate the feedback SELECT policy
DROP POLICY IF EXISTS "Users can view their own feedback" ON public.feedback;
CREATE POLICY "Users can view their own feedback" ON public.feedback
    FOR SELECT TO authenticated
    USING (atlassian_account_id = ((SELECT auth.jwt()) ->> 'atlassian_account_id'));
