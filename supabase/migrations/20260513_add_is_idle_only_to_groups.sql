-- ============================================================================
-- Migration: Add is_idle_only Column to unassigned_work_groups
-- Date: 2026-05-13
-- Purpose: Precompute group type (idle vs work) to eliminate expensive 
--          activity_records queries during pagination. This fixes the 503 
--          "fetch failed" errors when loading 70+ unassigned work groups.
--
-- Context: Previously, getUnassignedGroups() queried activity_records for 
--          every page load to determine if groups are idle-only. With 10 
--          groups per page, each having 50+ members, this resulted in queries 
--          with 500+ UUIDs in the IN clause (~18,500 characters), exceeding 
--          URL length limits and causing network failures.
--
-- Solution: Add is_idle_only BOOLEAN column that is computed once at group 
--           creation and maintained via trigger when members change.
--
-- Related: 
--   - docs/UNASSIGNED_WORK_LOAD_MORE_503_ROOT_CAUSE_ANALYSIS.md
--   - plan/2026-05-13_unassigned_work_load_more_503_fix.md
-- ============================================================================

-- 1. Add is_idle_only column to unassigned_work_groups
-- This column indicates whether ALL activity_record members in the group 
-- have is_idle = TRUE. Groups with legacy members (unassigned_activity_id 
-- only) are treated as work groups.
ALTER TABLE public.unassigned_work_groups
  ADD COLUMN IF NOT EXISTS is_idle_only BOOLEAN DEFAULT FALSE;

-- 2. Add index for efficient filtering by idle status
-- This index supports queries that filter groups by user, org, and idle status
-- when is_assigned = FALSE (the primary use case for the unassigned work page)
CREATE INDEX IF NOT EXISTS idx_unassigned_groups_is_idle_only
  ON public.unassigned_work_groups (user_id, organization_id, is_idle_only)
  WHERE is_assigned = FALSE AND is_dismissed = FALSE;

-- 3. Backfill existing groups (one-time operation)
-- This updates all existing unassigned groups to set their is_idle_only flag
-- based on current member composition. Groups with no activity_record members
-- or any non-idle activity_record members are set to FALSE (work groups).
UPDATE public.unassigned_work_groups uwg
SET is_idle_only = (
  SELECT COALESCE(
    -- BOOL_AND returns TRUE only if ALL rows are TRUE
    -- Returns NULL if no rows, hence COALESCE to FALSE
    BOOL_AND(
      COALESCE(ar.is_idle, FALSE)  -- NULL or FALSE = not idle
    ),
    FALSE  -- Default to work group if no activity_record members
  )
  FROM public.unassigned_group_members ugm
  LEFT JOIN public.activity_records ar ON ar.id = ugm.activity_record_id
  WHERE ugm.group_id = uwg.id
    AND ugm.activity_record_id IS NOT NULL  -- Ignore legacy members
)
WHERE is_assigned = FALSE;  -- Only update unassigned groups (performance)

-- 4. Create trigger function to maintain is_idle_only on member changes
-- This function recalculates is_idle_only for the parent group whenever
-- members are added, removed, or updated. It ensures the column stays
-- synchronized with the actual member composition.
CREATE OR REPLACE FUNCTION public.update_group_idle_status()
RETURNS TRIGGER AS $$
BEGIN
  -- Update the parent group's is_idle_only flag
  -- Uses COALESCE to handle edge cases (no members, all NULL activity_record_ids)
  UPDATE public.unassigned_work_groups
  SET is_idle_only = (
    SELECT COALESCE(
      BOOL_AND(
        COALESCE(ar.is_idle, FALSE)
      ),
      FALSE
    )
    FROM public.unassigned_group_members ugm
    LEFT JOIN public.activity_records ar ON ar.id = ugm.activity_record_id
    WHERE ugm.group_id = COALESCE(NEW.group_id, OLD.group_id)
      AND ugm.activity_record_id IS NOT NULL
  ),
  updated_at = NOW()  -- Touch updated_at timestamp
  WHERE id = COALESCE(NEW.group_id, OLD.group_id);
  
  -- Return appropriate row based on operation
  RETURN COALESCE(NEW, OLD);
END;
$$ LANGUAGE plpgsql;

-- 5. Create trigger to automatically maintain is_idle_only
-- Fires after any INSERT, UPDATE, or DELETE on unassigned_group_members
-- This ensures is_idle_only is always accurate without manual intervention
DROP TRIGGER IF EXISTS maintain_group_idle_status ON public.unassigned_group_members;

CREATE TRIGGER maintain_group_idle_status
AFTER INSERT OR UPDATE OR DELETE ON public.unassigned_group_members
FOR EACH ROW
EXECUTE FUNCTION public.update_group_idle_status();

-- 6. Add column comment for documentation
COMMENT ON COLUMN public.unassigned_work_groups.is_idle_only IS 
  'TRUE when all activity_record members have is_idle=TRUE. FALSE for groups with any work records or legacy-only members. Updated automatically via trigger on unassigned_group_members changes. Used to avoid expensive activity_records queries during pagination.';

-- ============================================================================
-- Verification Queries (for manual testing after migration)
-- ============================================================================
-- 
-- -- Check column exists and has correct type
-- SELECT column_name, data_type, is_nullable, column_default
-- FROM information_schema.columns
-- WHERE table_schema = 'public' 
--   AND table_name = 'unassigned_work_groups'
--   AND column_name = 'is_idle_only';
--
-- -- Check index exists
-- SELECT indexname, indexdef
-- FROM pg_indexes
-- WHERE schemaname = 'public'
--   AND tablename = 'unassigned_work_groups'
--   AND indexname = 'idx_unassigned_groups_is_idle_only';
--
-- -- Check trigger exists
-- SELECT trigger_name, event_manipulation, event_object_table
-- FROM information_schema.triggers
-- WHERE trigger_schema = 'public'
--   AND trigger_name = 'maintain_group_idle_status';
--
-- -- Verify backfill worked (should show mix of TRUE/FALSE)
-- SELECT is_idle_only, COUNT(*) as count
-- FROM public.unassigned_work_groups
-- WHERE is_assigned = FALSE
-- GROUP BY is_idle_only
-- ORDER BY is_idle_only;
--
-- -- Test trigger functionality (create test group and verify is_idle_only updates)
-- -- See plan/2026-05-13_unassigned_work_load_more_503_fix.md for full test suite
-- ============================================================================
