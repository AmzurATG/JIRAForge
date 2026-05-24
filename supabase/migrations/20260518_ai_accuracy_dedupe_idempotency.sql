-- ============================================================================
-- Migration: AI accuracy dashboard — one event per activity_record (dedupe +
--            idempotency guard at the row level)
-- Date: 2026-05-18
--
-- BUG
-- ---
-- ai_accuracy_events is meant to be append-only with ONE row per activity
-- record (the AI's verdict for that record). In practice the unassigned-work
-- manual-assign path (forge-app/src/resolvers/unassigned/assignmentResolvers.js,
-- updateSessionsAndAnalysis ~L132 and bulkReassignByTimeInterval ~L1199) does
-- not guard against re-emission: when a record is manually assigned a second
-- time, the pre-fetch reads its own prior user_assigned_issue_key (set by the
-- first assign), labels it as the AI's suggestion, and emits another event
-- with aiSuggested = (the user's previous choice).
--
-- On prod (bzdoztgfozxkhkvctvdk) at the time of writing this produced 707
-- duplicate "manually_assigned" events with ai_suggested = final across 381
-- distinct records (326 of those records were re-assigned 3+ times). The
-- 20260515 reconcile filter hides them from the Reassigned KPI, but the
-- duration (~15h 42m) still vanishes from "Total reviewed time" because the
-- excluded events fall into no bucket.
--
-- ROOT CAUSE
-- ----------
-- The schema overloads `activity_records.user_assigned_issue_key`: the AI
-- writes its classification there (ai-server/src/services/db/activity-db-service.js
-- ~L80), and any subsequent user action overwrites it with the user's final
-- pick. Once overwritten, the AI's original suggestion is gone from
-- activity_records; the only place it survives is the FIRST row in
-- ai_accuracy_events for that record. So the right contract is "one event per
-- activity_record, the first one wins."
--
-- The approval-flow resolvers (approvalResolvers.js — approveRecords,
-- reassignAndApproveRecords, createIssueAndApproveRecords) already cannot
-- emit twice on the same record by construction: every PATCH carries
-- `approval_status=eq.pending_approval` as a WHERE guard, so once a record is
-- approved the next call matches zero rows and emits nothing. Path B has no
-- equivalent guard. This trigger backstops Path B without touching Path A.
--
-- FIX
-- ---
-- 1. Dedupe existing rows — keep the OLDEST event per activity_record_id, which
--    is the one that captured the AI's actual verdict (before any user
--    overwrites). This removes the 707 phantom events on prod (zero-impact on
--    Dev — Dev has no duplicates today).
--
-- 2. Install a BEFORE INSERT trigger that returns NULL when an event already
--    exists for the same activity_record_id. Returning NULL silently skips
--    that row WITHOUT failing the rest of a batch insert — critical because
--    recordAccuracyEvents (forge-app/src/services/accuracy/accuracyTracking.js)
--    writes events in batches and an all-or-nothing failure would lose
--    legitimate first-time events for other records in the same batch.
--
-- Why a trigger, not a UNIQUE INDEX:
--   The forge-app → ai-server proxy (forge-proxy-controller.js:executeInsert)
--   calls `supabase.from(t).insert(body).select()` with no upsert/onConflict
--   plumbed through. A unique-constraint violation would throw and abort the
--   whole batch insert — caught by the existing try/catch in
--   accuracyTracking.js but losing every event in that batch, not just the
--   duplicate. The trigger sidesteps that: per-row skip, batch survives.
--
-- Why `activity_record_id IS NOT NULL` guard:
--   Current emitters always pass a UUID (validated above; prod has zero NULL
--   rows in this column). The guard makes the trigger correct even if a
--   future caller emits without a record id — those rows pass through
--   untouched, matching the column's nullable schema.
--
-- TRADE-OFFS
-- ----------
-- Race safety: under READ COMMITTED, two simultaneous inserts on the same
-- activity_record_id could both pass the EXISTS check and both succeed. In
-- practice this table sees no such concurrency — the 707 prod duplicates are
-- all sequential per-record (different user actions over time). If a future
-- workload introduces racing emitters, add a UNIQUE INDEX as well; the trigger
-- + index combo will catch races at the cost of occasional batch failure (the
-- existing try/catch in accuracyTracking.js already swallows that).
--
-- Net effect: dashboards' bucket numbers are unchanged (the 20260515 filter
-- already excluded the 707 events from totals). What changes is that "Total
-- reviewed time" becomes the actual total — no more ~15h of phantom events
-- hidden behind the filter. The 20260515 RPC filter becomes redundant safety
-- net (leave it in place).
--
-- Removable layer: drop alongside the rest of the AI accuracy tracking stack
-- (table drops cascade to the trigger and function automatically).
-- ============================================================================

-- ----------------------------------------------------------------------------
-- 1. Backfill: collapse existing duplicates to the oldest event per record
-- ----------------------------------------------------------------------------

DELETE FROM public.ai_accuracy_events a
USING public.ai_accuracy_events b
WHERE a.activity_record_id = b.activity_record_id
  AND a.activity_record_id IS NOT NULL
  AND a.created_at > b.created_at;

-- ----------------------------------------------------------------------------
-- 2. Per-row idempotency trigger
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.ai_accuracy_events_skip_dup()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.activity_record_id IS NOT NULL
     AND EXISTS (
       SELECT 1
         FROM public.ai_accuracy_events
        WHERE activity_record_id = NEW.activity_record_id
     )
  THEN
    -- Silently skip this row. Other rows in the same batch insert proceed.
    RETURN NULL;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS ai_accuracy_events_skip_dup ON public.ai_accuracy_events;

CREATE TRIGGER ai_accuracy_events_skip_dup
  BEFORE INSERT ON public.ai_accuracy_events
  FOR EACH ROW
  EXECUTE FUNCTION public.ai_accuracy_events_skip_dup();

COMMENT ON FUNCTION public.ai_accuracy_events_skip_dup() IS
  'AI accuracy dashboard. Enforces "one event per activity_record" by silently '
  'skipping duplicate inserts. REMOVABLE.';
