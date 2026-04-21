-- ============================================================================
-- Migration: Add approval_status column to activity_records
-- Date: 2026-04-21
--
-- Introduces a human-in-the-loop approval dimension for AI-assigned time.
-- When the AI server confidently picks a Jira issue for a captured activity
-- (activity-db-service.js updateActivityRecordAnalysis), the record is
-- stamped 'pending_approval' and blocked from Jira worklog sync until the
-- owning user explicitly approves it via the Needs Review panel.
--
-- This is an additive change:
--   * New nullable column with CHECK constraint
--   * New audit columns (approved_at, approved_by, approval_notes)
--   * Partial index optimised for "show me my pending approvals"
--
-- Historical rows keep approval_status = NULL, which downstream readers
-- treat as "not applicable" (COALESCE to 'approved' when filtering), so
-- all existing data remains visible in summaries and worklog sync.
--
-- 'rejected' is deliberately omitted from the CHECK constraint for now;
-- the reject action will be designed separately and introduced via a
-- later migration that widens the constraint.
-- ============================================================================

ALTER TABLE public.activity_records
  ADD COLUMN IF NOT EXISTS approval_status TEXT
    CHECK (approval_status IS NULL OR approval_status IN ('pending_approval', 'approved')),
  ADD COLUMN IF NOT EXISTS approved_at    TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS approved_by    UUID REFERENCES public.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS approval_notes TEXT;

-- Hot query: fetch a user's pending-approval records ordered by start_time.
-- Partial index keeps both storage and lookup cost minimal.
CREATE INDEX IF NOT EXISTS idx_activity_approval_pending
  ON public.activity_records(user_id, organization_id, start_time)
  WHERE approval_status = 'pending_approval';

COMMENT ON COLUMN public.activity_records.approval_status IS
  'Human review state for AI-assigned records: NULL (n/a), pending_approval, approved. Rejected is reserved for future use.';
COMMENT ON COLUMN public.activity_records.approved_at IS
  'Timestamp when the user approved (or reassigned-and-approved) this record.';
COMMENT ON COLUMN public.activity_records.approved_by IS
  'User who performed the approval action. Typically equals user_id (self-approval).';
COMMENT ON COLUMN public.activity_records.approval_notes IS
  'Optional free-text note captured during reassign-and-approve flows.';
