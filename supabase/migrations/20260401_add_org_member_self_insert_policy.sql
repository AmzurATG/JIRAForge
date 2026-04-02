-- ============================================================================
-- Migration: Add self-insert policy for organization_members
-- Date: 2026-04-01
--
-- CONTEXT:
-- The desktop app creates organization membership for the current user
-- during first login (ensure_user_exists → _ensure_organization_membership).
-- With the service role key removed from the desktop app, it needs an RLS
-- policy allowing authenticated users to insert their OWN membership record.
--
-- SECURITY:
-- Users can only insert a row where user_id matches their own database ID
-- (resolved via get_current_user_id()). The policy also enforces:
--   - role must be 'member' (prevents self-promotion to owner/admin)
--   - all permission flags must be false (prevents privilege escalation)
-- The first-user-is-owner logic runs on the AI server with service role,
-- which bypasses RLS entirely.
-- ============================================================================

-- Ensure RLS is enabled on the table
ALTER TABLE public.organization_members ENABLE ROW LEVEL SECURITY;

-- Allow authenticated users to insert their own membership record
-- Role and permissions are locked down to prevent privilege escalation
DROP POLICY IF EXISTS "org_members_self_insert" ON public.organization_members;
CREATE POLICY "org_members_self_insert" ON public.organization_members
    FOR INSERT TO authenticated
    WITH CHECK (
        user_id = (SELECT public.get_current_user_id())
        AND role = 'member'
        AND can_manage_settings = false
        AND can_view_team_analytics = false
        AND can_manage_members = false
        AND can_delete_screenshots = false
        AND can_manage_billing = false
    );
