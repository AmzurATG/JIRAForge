-- ============================================================================
-- Migration: AI accuracy dashboard — add user attribution to reassignments
-- Date: 2026-05-14
--
-- Extends get_accuracy_reassignments (from 20260514_ai_accuracy_dashboard_redesign.sql)
-- to group by user_id alongside the (from, to) pair, so the Reassignments
-- panel can display which user performed each reassignment. Joins to
-- public.users for display_name and email.
--
-- Net effect on rows: a single (from, to) pair done by N different users
-- becomes N rows (one per user). Each row is therefore unambiguous about
-- attribution. Sorted by total_seconds desc within the same pair.
--
-- CREATE OR REPLACE cannot change a function's RETURNS TABLE shape, so we
-- DROP first. The v1 RPCs and the v2 summary/by-app RPCs are untouched.
--
-- Removable layer: drop alongside the rest of the AI accuracy tracking stack.
-- See plan/2026-05-14_multi-component_ai-accuracy-dashboard-redesign.md.
-- ============================================================================

DROP FUNCTION IF EXISTS public.get_accuracy_reassignments(uuid, timestamptz, int);

CREATE FUNCTION public.get_accuracy_reassignments(
  p_org   uuid        DEFAULT NULL,
  p_since timestamptz DEFAULT (now() - interval '7 days'),
  p_limit int         DEFAULT 25
)
RETURNS TABLE(
  ai_suggested_issue_key text,
  final_issue_key        text,
  is_new_issue           boolean,
  user_id                uuid,
  user_display_name      text,
  user_email             text,
  total_seconds          bigint,
  pair_count             bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    e.ai_suggested_issue_key,
    e.final_issue_key,
    bool_or((e.metadata->>'reassign_reason') = 'created_new_issue')  AS is_new_issue,
    e.user_id,
    -- MAX() is the simplest aggregate that works here — for any given
    -- e.user_id (in GROUP BY) there is exactly one display_name/email, so
    -- MAX picks the only value without forcing us to add those text columns
    -- to GROUP BY (which would break the grouping if they ever changed).
    MAX(u.display_name)                                              AS user_display_name,
    MAX(u.email)                                                     AS user_email,
    COALESCE(SUM(e.duration_seconds), 0)::bigint                     AS total_seconds,
    COUNT(*)::bigint                                                 AS pair_count
    FROM public.ai_accuracy_events e
    LEFT JOIN public.users u ON u.id = e.user_id
   WHERE e.created_at >= p_since
     AND e.ai_suggested_issue_key IS NOT NULL
     AND e.ai_suggested_issue_key <> e.final_issue_key
     AND e.event_type IN ('reassigned', 'manually_assigned')
     AND (p_org IS NULL OR e.organization_id = p_org)
   GROUP BY e.user_id, e.ai_suggested_issue_key, e.final_issue_key
   ORDER BY total_seconds DESC, pair_count DESC
   LIMIT GREATEST(p_limit, 1);
$$;

COMMENT ON FUNCTION public.get_accuracy_reassignments(uuid, timestamptz, int) IS
  'AI accuracy dashboard v2 with user attribution. REMOVABLE.';
