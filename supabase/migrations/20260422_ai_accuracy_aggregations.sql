-- ============================================================================
-- Migration: AI accuracy dashboard aggregation functions (REMOVABLE LAYER)
-- Date: 2026-04-22
--
-- Replaces the prior controller pattern of pulling tens of thousands of raw
-- event rows into Node and aggregating in JS.  Each function aggregates at
-- the database, with optional org and date-window filters, so the dashboard
-- stays correct as the events table grows.
--
-- All functions are STABLE (no side effects), idempotent (CREATE OR REPLACE),
-- and run with the caller's privileges (no SECURITY DEFINER).  They are
-- invoked from the AI server via the service-role key, which bypasses RLS.
--
-- Removal: drop these alongside the rest of the AI accuracy tracking layer.
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Distinct organizations that have ever produced events
--
-- Replaces a SELECT organization_id LIMIT 10000 + JS dedup that silently
-- truncated the dropdown once total event count exceeded 10k.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_accuracy_event_orgs()
RETURNS TABLE(organization_id uuid)
LANGUAGE sql
STABLE
AS $$
  SELECT DISTINCT organization_id
    FROM public.ai_accuracy_events
   WHERE organization_id IS NOT NULL;
$$;

-- ----------------------------------------------------------------------------
-- 2. Per-event-type counts and durations within a window
--
-- Returns one row per (event_type, has_suggestion) bucket so the controller
-- can split manually_assigned into "with AI suggestion" vs "AI never tried"
-- without re-scanning the data.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_accuracy_summary(
  p_org   uuid        DEFAULT NULL,
  p_since timestamptz DEFAULT (now() - interval '7 days')
)
RETURNS TABLE(
  event_type     text,
  has_suggestion boolean,
  event_count    bigint,
  total_seconds  bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    event_type,
    (ai_suggested_issue_key IS NOT NULL)         AS has_suggestion,
    COUNT(*)::bigint                              AS event_count,
    COALESCE(SUM(duration_seconds), 0)::bigint    AS total_seconds
    FROM public.ai_accuracy_events
   WHERE created_at >= p_since
     AND (p_org IS NULL OR organization_id = p_org)
   GROUP BY event_type, (ai_suggested_issue_key IS NOT NULL);
$$;

-- ----------------------------------------------------------------------------
-- 3. Top wrong pairs (AI guess -> what the user actually picked)
--
-- Includes BOTH 'reassigned' events and 'manually_assigned' events that had
-- a non-null AI suggestion — both indicate the AI got it wrong.  Excludes
-- self-pairs (AI guess == final) which can occur on edge cases.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_accuracy_wrong_pairs(
  p_org   uuid        DEFAULT NULL,
  p_since timestamptz DEFAULT (now() - interval '7 days'),
  p_limit int         DEFAULT 25
)
RETURNS TABLE(
  ai_suggested_issue_key text,
  final_issue_key        text,
  pair_count             bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    ai_suggested_issue_key,
    final_issue_key,
    COUNT(*)::bigint AS pair_count
    FROM public.ai_accuracy_events
   WHERE created_at >= p_since
     AND ai_suggested_issue_key IS NOT NULL
     AND ai_suggested_issue_key <> final_issue_key
     AND event_type IN ('reassigned', 'manually_assigned')
     AND (p_org IS NULL OR organization_id = p_org)
   GROUP BY ai_suggested_issue_key, final_issue_key
   ORDER BY pair_count DESC
   LIMIT GREATEST(p_limit, 1);
$$;

-- ----------------------------------------------------------------------------
-- 4. Right/wrong/manually-assigned counts per application_name
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_accuracy_by_app(
  p_org   uuid        DEFAULT NULL,
  p_since timestamptz DEFAULT (now() - interval '7 days'),
  p_limit int         DEFAULT 25
)
RETURNS TABLE(
  application_name        text,
  right_count             bigint,
  wrong_count             bigint,
  manually_assigned_count bigint
)
LANGUAGE sql
STABLE
AS $$
  SELECT
    LOWER(COALESCE(application_name, '(unknown)')) AS application_name,
    SUM(CASE WHEN event_type = 'approved_as_is'    THEN 1 ELSE 0 END)::bigint AS right_count,
    SUM(CASE WHEN event_type = 'reassigned'        THEN 1 ELSE 0 END)::bigint AS wrong_count,
    SUM(CASE WHEN event_type = 'manually_assigned' THEN 1 ELSE 0 END)::bigint AS manually_assigned_count
    FROM public.ai_accuracy_events
   WHERE created_at >= p_since
     AND (p_org IS NULL OR organization_id = p_org)
   GROUP BY LOWER(COALESCE(application_name, '(unknown)'))
   ORDER BY wrong_count DESC, right_count DESC
   LIMIT GREATEST(p_limit, 1);
$$;

-- ----------------------------------------------------------------------------
-- 5. Confidence calibration buckets (10 x 0.1-wide buckets covering [0, 1])
--
-- Includes 'manually_assigned' events that had a non-null AI suggestion —
-- those are valid "AI was wrong" signals at the captured confidence.  This
-- is a deliberate change from the original controller, which only counted
-- approved_as_is + reassigned and missed the manually-assigned case.
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_accuracy_calibration(
  p_org   uuid        DEFAULT NULL,
  p_since timestamptz DEFAULT (now() - interval '7 days')
)
RETURNS TABLE(
  bucket       int,
  sample_count bigint,
  right_count  bigint
)
LANGUAGE sql
STABLE
AS $$
  WITH eligible AS (
    SELECT
      CASE
        WHEN ai_confidence_score >= 1 THEN 9
        WHEN ai_confidence_score < 0 THEN 0
        ELSE FLOOR(ai_confidence_score * 10)::int
      END AS bucket,
      CASE WHEN event_type = 'approved_as_is' THEN 1 ELSE 0 END AS is_right
      FROM public.ai_accuracy_events
     WHERE created_at >= p_since
       AND ai_confidence_score IS NOT NULL
       AND (
         event_type IN ('approved_as_is', 'reassigned')
         OR (event_type = 'manually_assigned' AND ai_suggested_issue_key IS NOT NULL)
       )
       AND (p_org IS NULL OR organization_id = p_org)
  )
  SELECT
    bucket,
    COUNT(*)::bigint   AS sample_count,
    SUM(is_right)::bigint AS right_count
    FROM eligible
   GROUP BY bucket
   ORDER BY bucket;
$$;

-- ----------------------------------------------------------------------------
-- Comments — keep the removal grep-friendly.
-- ----------------------------------------------------------------------------

COMMENT ON FUNCTION public.get_accuracy_event_orgs()       IS 'AI accuracy dashboard. REMOVABLE.';
COMMENT ON FUNCTION public.get_accuracy_summary(uuid, timestamptz)        IS 'AI accuracy dashboard. REMOVABLE.';
COMMENT ON FUNCTION public.get_accuracy_wrong_pairs(uuid, timestamptz, int) IS 'AI accuracy dashboard. REMOVABLE.';
COMMENT ON FUNCTION public.get_accuracy_by_app(uuid, timestamptz, int)      IS 'AI accuracy dashboard. REMOVABLE.';
COMMENT ON FUNCTION public.get_accuracy_calibration(uuid, timestamptz)      IS 'AI accuracy dashboard. REMOVABLE.';
