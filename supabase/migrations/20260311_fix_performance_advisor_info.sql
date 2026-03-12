-- Migration: Fix Performance Advisor INFO warnings
-- Date: 2026-03-11
--
-- PART 1 — unindexed_foreign_keys (INFO x1):
--   notification_preferences.organization_id has a FK to organizations(id)
--   but no covering index. PostgreSQL must do a full table scan to resolve
--   ON DELETE CASCADE from organizations to notification_preferences.
--   Fix: add a B-tree index on organization_id.
--
-- PART 2 — unused_index (INFO x4):
--   ocr_test_results has 4 indexes that have never been scanned.
--   This table is explicitly temporary ("will be merged into screenshots table
--   later" — see 20240218_create_ocr_test_table.sql). No application code
--   queries it in production; it was used only during early OCR engine testing.
--   The indexes add write overhead and storage cost with zero query benefit.
--   Fix: drop all 4 indexes.
--
-- NOTE — remaining unused_index warnings (80+):
--   All other "unused" indexes are on active production tables
--   (activity_records, screenshots, analysis_results, worklogs,
--    organization_members, user_jira_issues_cache, etc.).
--   These are flagged because the database has low-traffic / short history
--   since statistics were last reset — NOT because they are unneeded.
--   Dropping indexes on active tables based on zero-scan stats from a new DB
--   is high-risk (query plans degrade permanently on large tables).
--   Recommendation: reassess after 30+ days of production traffic.

-- ============================================================================
-- PART 1: Add missing FK index on notification_preferences.organization_id
-- ============================================================================
-- The FK notification_preferences_organization_id_fkey references organizations(id).
-- Without this index, DELETE/UPDATE on organizations causes a full scan of
-- notification_preferences to find rows to cascade.

CREATE INDEX IF NOT EXISTS idx_notification_preferences_org_id
    ON public.notification_preferences(organization_id);

-- ============================================================================
-- PART 2: Drop unused indexes on ocr_test_results (temporary test table)
-- ============================================================================
-- ocr_test_results was created in 2024-02-18 for early OCR engine testing.
-- Its migration explicitly states: "Temporary table for testing OCR functionality.
-- Will be merged into screenshots table later."
-- No production code path writes to or reads from this table.
-- All 4 indexes have 0 scans and only add overhead.

DROP INDEX IF EXISTS public.idx_ocr_test_user_id;
DROP INDEX IF EXISTS public.idx_ocr_test_timestamp;
DROP INDEX IF EXISTS public.idx_ocr_test_method;
DROP INDEX IF EXISTS public.idx_ocr_test_created_at;
