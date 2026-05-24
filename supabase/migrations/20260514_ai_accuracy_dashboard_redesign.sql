-- ============================================================================
-- Migration: AI accuracy dashboard redesign — time-weighted aggregations (v2)
-- Date: 2026-05-14
--
-- Adds v2 aggregation RPCs that return TIME data (duration_seconds) alongside
-- event counts, and unify on the "Matched / Reassigned / Unmatched" bucket
-- model so every dashboard panel reports consistent numbers.
--
-- Bucket definitions (used identically across all v2 RPCs):
--   matched     -> event_type = 'approved_as_is'
--   reassigned  -> event_type = 'reassigned'
--                  OR (event_type = 'manually_assigned' AND ai_suggested_issue_key IS NOT NULL)
--   unmatched   -> event_type = 'manually_assigned' AND ai_suggested_issue_key IS NULL
--
-- The v1 RPCs from 20260422_ai_accuracy_aggregations.sql remain in place for
-- the cut-over. Drop them in a follow-up migration once the controller and
-- frontend are confirmed on v2.
--
-- All functions are STABLE (no side effects) and idempotent (CREATE OR REPLACE).
-- Invoked from the AI server via the service-role key, which bypasses RLS.
--
-- Removable layer: drop alongside the rest of the AI accuracy tracking stack.
-- See plan/2026-05-14_multi-component_ai-accuracy-dashboard-redesign.md.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Summary v2 — single row with the three time buckets, plus the
--    "reassigned-to-brand-new-issue" subset (sourced from
--    metadata->>'reassign_reason' = 'created_new_issue', stamped by
--    approvalResolvers.createIssueAndApproveRecords).
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_accuracy_summary_v2(
  p_org   uuid        DEFAULT NULL,
  p_since timestamptz DEFAULT (now() - interval '7 days')
)
RETURNS TABLE(
  matched_count                bigint,
  matched_seconds              bigint,
  reassigned_count             bigint,
  reassigned_seconds           bigint,
  reassigned_new_issue_count   bigint,
  reassigned_new_issue_seconds bigint,
  unmatched_count              bigint,
  unmatched_seconds            bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    COUNT(*) FILTER (WHERE event_type = 'approved_as_is')::bigint
      AS matched_count,
    COALESCE(SUM(duration_seconds) FILTER (WHERE event_type = 'approved_as_is'), 0)::bigint
      AS matched_seconds,

    COUNT(*) FILTER (
      WHERE event_type = 'reassigned'
         OR (event_type = 'manually_assigned' AND ai_suggested_issue_key IS NOT NULL)
    )::bigint
      AS reassigned_count,
    COALESCE(SUM(duration_seconds) FILTER (
      WHERE event_type = 'reassigned'
         OR (event_type = 'manually_assigned' AND ai_suggested_issue_key IS NOT NULL)
    ), 0)::bigint
      AS reassigned_seconds,

    COUNT(*) FILTER (
      WHERE event_type = 'reassigned'
        AND (metadata->>'reassign_reason') = 'created_new_issue'
    )::bigint
      AS reassigned_new_issue_count,
    COALESCE(SUM(duration_seconds) FILTER (
      WHERE event_type = 'reassigned'
        AND (metadata->>'reassign_reason') = 'created_new_issue'
    ), 0)::bigint
      AS reassigned_new_issue_seconds,

    COUNT(*) FILTER (
      WHERE event_type = 'manually_assigned' AND ai_suggested_issue_key IS NULL
    )::bigint
      AS unmatched_count,
    COALESCE(SUM(duration_seconds) FILTER (
      WHERE event_type = 'manually_assigned' AND ai_suggested_issue_key IS NULL
    ), 0)::bigint
      AS unmatched_seconds

  FROM public.ai_accuracy_events
  WHERE created_at >= p_since
    AND (p_org IS NULL OR organization_id = p_org);
$$;

COMMENT ON FUNCTION public.get_accuracy_summary_v2(uuid, timestamptz) IS
  'AI accuracy dashboard v2. REMOVABLE.';

-- ----------------------------------------------------------------------------
-- 2. Reassignments — wrong-pair shape extended with total_seconds and an
--    is_new_issue flag derived from metadata.reassign_reason.
--    Sorted by total_seconds desc so high-impact mistakes surface first.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_accuracy_reassignments(
  p_org   uuid        DEFAULT NULL,
  p_since timestamptz DEFAULT (now() - interval '7 days'),
  p_limit int         DEFAULT 25
)
RETURNS TABLE(
  ai_suggested_issue_key text,
  final_issue_key        text,
  is_new_issue           boolean,
  total_seconds          bigint,
  pair_count             bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    ai_suggested_issue_key,
    final_issue_key,
    bool_or((metadata->>'reassign_reason') = 'created_new_issue')   AS is_new_issue,
    COALESCE(SUM(duration_seconds), 0)::bigint                       AS total_seconds,
    COUNT(*)::bigint                                                 AS pair_count
    FROM public.ai_accuracy_events
   WHERE created_at >= p_since
     AND ai_suggested_issue_key IS NOT NULL
     AND ai_suggested_issue_key <> final_issue_key
     AND event_type IN ('reassigned', 'manually_assigned')
     AND (p_org IS NULL OR organization_id = p_org)
   GROUP BY ai_suggested_issue_key, final_issue_key
   ORDER BY total_seconds DESC, pair_count DESC
   LIMIT GREATEST(p_limit, 1);
$$;

COMMENT ON FUNCTION public.get_accuracy_reassignments(uuid, timestamptz, int) IS
  'AI accuracy dashboard v2. REMOVABLE.';

-- ----------------------------------------------------------------------------
-- 3. By-app v2 — matched / reassigned / unmatched as both event count AND
--    duration_seconds. Sorted by total_seconds desc so high-volume apps
--    surface first regardless of their accuracy.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_accuracy_by_app_v2(
  p_org   uuid        DEFAULT NULL,
  p_since timestamptz DEFAULT (now() - interval '7 days'),
  p_limit int         DEFAULT 25
)
RETURNS TABLE(
  application_name   text,
  matched_count      bigint,
  matched_seconds    bigint,
  reassigned_count   bigint,
  reassigned_seconds bigint,
  unmatched_count    bigint,
  unmatched_seconds  bigint,
  total_seconds      bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    LOWER(COALESCE(application_name, '(unknown)')) AS application_name,

    COUNT(*) FILTER (WHERE event_type = 'approved_as_is')::bigint
      AS matched_count,
    COALESCE(SUM(duration_seconds) FILTER (WHERE event_type = 'approved_as_is'), 0)::bigint
      AS matched_seconds,

    COUNT(*) FILTER (
      WHERE event_type = 'reassigned'
         OR (event_type = 'manually_assigned' AND ai_suggested_issue_key IS NOT NULL)
    )::bigint
      AS reassigned_count,
    COALESCE(SUM(duration_seconds) FILTER (
      WHERE event_type = 'reassigned'
         OR (event_type = 'manually_assigned' AND ai_suggested_issue_key IS NOT NULL)
    ), 0)::bigint
      AS reassigned_seconds,

    COUNT(*) FILTER (
      WHERE event_type = 'manually_assigned' AND ai_suggested_issue_key IS NULL
    )::bigint
      AS unmatched_count,
    COALESCE(SUM(duration_seconds) FILTER (
      WHERE event_type = 'manually_assigned' AND ai_suggested_issue_key IS NULL
    ), 0)::bigint
      AS unmatched_seconds,

    COALESCE(SUM(duration_seconds), 0)::bigint
      AS total_seconds

    FROM public.ai_accuracy_events
   WHERE created_at >= p_since
     AND (p_org IS NULL OR organization_id = p_org)
   GROUP BY LOWER(COALESCE(application_name, '(unknown)'))
   ORDER BY total_seconds DESC
   LIMIT GREATEST(p_limit, 1);
$$;

COMMENT ON FUNCTION public.get_accuracy_by_app_v2(uuid, timestamptz, int) IS
  'AI accuracy dashboard v2. REMOVABLE.';
