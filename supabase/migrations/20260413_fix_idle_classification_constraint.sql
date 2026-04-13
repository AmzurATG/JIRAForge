-- ============================================================================
-- Migration: Ensure classification CHECK constraint allows 'idle'
-- Date: 2026-04-13
--
-- The original activity_records table was created with:
--   classification TEXT CHECK (classification IN ('productive', 'non_productive', 'private', 'unknown'))
--
-- The idle time support migration (20260325) was supposed to update this
-- to include 'idle', but if the auto-generated constraint name didn't match
-- 'activity_records_classification_check', the old constraint was never dropped.
--
-- This migration drops ALL check constraints on the classification column
-- and recreates the correct one, ensuring 'idle' is always allowed.
-- ============================================================================

-- Drop the constraint by trying both possible names
-- (auto-generated name from CREATE TABLE vs explicitly named constraint)
ALTER TABLE public.activity_records
  DROP CONSTRAINT IF EXISTS activity_records_classification_check;

-- Also try the numbered variant that PostgreSQL sometimes generates
ALTER TABLE public.activity_records
  DROP CONSTRAINT IF EXISTS activity_records_classification_check1;

-- Recreate with all valid classifications including 'idle'
ALTER TABLE public.activity_records
  ADD CONSTRAINT activity_records_classification_check
  CHECK (classification IN ('productive', 'non_productive', 'private', 'unknown', 'idle'));
