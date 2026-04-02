-- ============================================================================
-- Migration: Fix ambiguous "user_id" variable in user_has_permission()
-- Date: 2026-04-02
--
-- CONTEXT:
-- The user_has_permission() function declares a PL/pgSQL variable named
-- "user_id" which collides with the organization_members.user_id column,
-- causing PostgreSQL error 42702: "column reference user_id is ambiguous".
--
-- This bug was previously masked because the desktop app used the service
-- role key (which bypasses RLS entirely). Now that the desktop app uses
-- anon key + custom JWT, RLS policies are enforced and this function is
-- called during SELECT queries on the users table.
--
-- FIX:
-- Rename the variable from "user_id" to "v_user_id" (matching the pattern
-- already used in user_is_admin()).
-- ============================================================================

CREATE OR REPLACE FUNCTION public.user_has_permission(permission_name text)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_user_org_id UUID;
  v_user_id UUID;
  has_perm BOOLEAN;
BEGIN
  v_user_id := public.get_current_user_id();
  v_user_org_id := public.get_current_user_organization_id();

  IF v_user_id IS NULL OR v_user_org_id IS NULL THEN
    RETURN false;
  END IF;

  -- Check based on permission type
  CASE permission_name
    WHEN 'view_team_analytics' THEN
      SELECT can_view_team_analytics INTO has_perm
      FROM public.organization_members
      WHERE organization_members.user_id = v_user_id AND organization_members.organization_id = v_user_org_id;

    WHEN 'manage_settings' THEN
      SELECT can_manage_settings INTO has_perm
      FROM public.organization_members
      WHERE organization_members.user_id = v_user_id AND organization_members.organization_id = v_user_org_id;

    WHEN 'manage_members' THEN
      SELECT can_manage_members INTO has_perm
      FROM public.organization_members
      WHERE organization_members.user_id = v_user_id AND organization_members.organization_id = v_user_org_id;

    WHEN 'delete_screenshots' THEN
      SELECT can_delete_screenshots INTO has_perm
      FROM public.organization_members
      WHERE organization_members.user_id = v_user_id AND organization_members.organization_id = v_user_org_id;

    WHEN 'manage_billing' THEN
      SELECT can_manage_billing INTO has_perm
      FROM public.organization_members
      WHERE organization_members.user_id = v_user_id AND organization_members.organization_id = v_user_org_id;

    ELSE
      RETURN false;
  END CASE;

  RETURN COALESCE(has_perm, false);
END;
$function$;
