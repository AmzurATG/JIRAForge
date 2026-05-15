-- ============================================================================
-- Migration: AI accuracy dashboard — reconcile reassigned bucket with the
--            wrong-pairs panel by excluding "noise" events
-- Date: 2026-05-15
--
-- BUG
-- ---
-- The `Reassigned` KPI card pulled from get_accuracy_summary_v2 was higher
-- than the sum of rows in the Reassignments panel pulled from
-- get_accuracy_reassignments. On dev (jvijitdewbypqbatfboi, last 7 days):
--   summary reassigned: 12,397 sec  (3h 26m)
--   wrong-pairs total :  5,697 sec  (1h 34m 57s)
--   difference        :  6,700 sec  (1h 51m)  — across 65 events
-- All 65 difference events were `event_type = 'manually_assigned'` with
-- `ai_suggested_issue_key = final_issue_key`. That happens when the same
-- activity record is manually-assigned a second time:
--   1. First manual assign: aiSuggested=null, final=X — Unmatched (correct).
--   2. Second manual assign: the prefetch reads user_assigned_issue_key=X
--      (set by step 1) and emits a `manually_assigned` event with
--      aiSuggestedIssueKey=X, finalIssueKey=X. AI never suggested X — that
--      was the user's prior choice masquerading as an AI suggestion.
-- The wrong-pairs RPC already filters these out via the
-- `ai_suggested_issue_key <> final_issue_key` predicate. The summary and
-- by-app RPCs did not.
--
-- FIX
-- ---
-- Add the same `ai_suggested_issue_key <> final_issue_key` predicate to the
-- "reassigned" filters in both get_accuracy_summary_v2 and
-- get_accuracy_by_app_v2 so all three panels reconcile.
--
-- Net effect: Reassigned bucket drops by exactly the count/seconds of the
-- noise events. Matched and Unmatched buckets are unchanged. The visible
-- inflation that made the Reassigned KPI ~2x the per-pair table goes away.
-- ============================================================================

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
      WHERE (event_type = 'reassigned'
             OR (event_type = 'manually_assigned' AND ai_suggested_issue_key IS NOT NULL))
        AND ai_suggested_issue_key IS DISTINCT FROM final_issue_key
    )::bigint
      AS reassigned_count,
    COALESCE(SUM(duration_seconds) FILTER (
      WHERE (event_type = 'reassigned'
             OR (event_type = 'manually_assigned' AND ai_suggested_issue_key IS NOT NULL))
        AND ai_suggested_issue_key IS DISTINCT FROM final_issue_key
    ), 0)::bigint
      AS reassigned_seconds,

    COUNT(*) FILTER (
      WHERE event_type = 'reassigned'
        AND (metadata->>'reassign_reason') = 'created_new_issue'
        AND ai_suggested_issue_key IS DISTINCT FROM final_issue_key
    )::bigint
      AS reassigned_new_issue_count,
    COALESCE(SUM(duration_seconds) FILTER (
      WHERE event_type = 'reassigned'
        AND (metadata->>'reassign_reason') = 'created_new_issue'
        AND ai_suggested_issue_key IS DISTINCT FROM final_issue_key
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
  'AI accuracy dashboard v2 (reconciled 2026-05-15). REMOVABLE.';

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
      WHERE (event_type = 'reassigned'
             OR (event_type = 'manually_assigned' AND ai_suggested_issue_key IS NOT NULL))
        AND ai_suggested_issue_key IS DISTINCT FROM final_issue_key
    )::bigint
      AS reassigned_count,
    COALESCE(SUM(duration_seconds) FILTER (
      WHERE (event_type = 'reassigned'
             OR (event_type = 'manually_assigned' AND ai_suggested_issue_key IS NOT NULL))
        AND ai_suggested_issue_key IS DISTINCT FROM final_issue_key
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

    COALESCE(SUM(duration_seconds) FILTER (
      WHERE event_type = 'approved_as_is'
         OR (event_type = 'manually_assigned' AND ai_suggested_issue_key IS NULL)
         OR ((event_type = 'reassigned'
              OR (event_type = 'manually_assigned' AND ai_suggested_issue_key IS NOT NULL))
             AND ai_suggested_issue_key IS DISTINCT FROM final_issue_key)
    ), 0)::bigint
      AS total_seconds

    FROM public.ai_accuracy_events
   WHERE created_at >= p_since
     AND (p_org IS NULL OR organization_id = p_org)
   GROUP BY LOWER(COALESCE(application_name, '(unknown)'))
   ORDER BY total_seconds DESC
   LIMIT GREATEST(p_limit, 1);
$$;

COMMENT ON FUNCTION public.get_accuracy_by_app_v2(uuid, timestamptz, int) IS
  'AI accuracy dashboard v2 (reconciled 2026-05-15). REMOVABLE.';
