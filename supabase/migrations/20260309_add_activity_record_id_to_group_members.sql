-- Migration: Add activity_record_id FK to unassigned_group_members
-- Enables the clustering service to group activity_records (new pipeline)
-- alongside legacy unassigned_activity records

-- 1. Drop NOT NULL on unassigned_activity_id so rows can use either FK column
ALTER TABLE public.unassigned_group_members
  ALTER COLUMN unassigned_activity_id DROP NOT NULL;

-- 2. Add new FK column for activity_records (new pipeline)
ALTER TABLE public.unassigned_group_members
  ADD COLUMN IF NOT EXISTS activity_record_id UUID REFERENCES public.activity_records(id) ON DELETE CASCADE;

-- 3. Unique constraint: prevents the same activity_record from being in the same group twice
--    (mirrors the existing unassigned_group_members_group_activity_unique constraint for legacy records)
--    PostgreSQL ignores NULLs in unique indexes, so rows with NULL activity_record_id are unaffected.
CREATE UNIQUE INDEX IF NOT EXISTS unassigned_group_members_group_ar_unique
  ON public.unassigned_group_members (group_id, activity_record_id)
  WHERE activity_record_id IS NOT NULL;

-- 4. Index for fast lookups by activity_record_id
CREATE INDEX IF NOT EXISTS idx_unassigned_group_members_activity_record_id
  ON public.unassigned_group_members (activity_record_id)
  WHERE activity_record_id IS NOT NULL;
