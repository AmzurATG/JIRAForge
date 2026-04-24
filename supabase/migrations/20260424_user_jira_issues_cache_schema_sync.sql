-- ============================================================================
-- Bring user_jira_issues_cache up to date in a single idempotent script.
--
-- 1. Add missing columns (priority, description, labels) that were introduced
--    in the 20260306 migration but absent from DEV_MIGRATION_COMPLETE.sql.
-- 2. Back-fill any NULL organization_id rows from the users table so the new
--    UNIQUE constraint can work correctly (Postgres treats NULLs as distinct).
-- 3. Remove duplicate (user_id, organization_id, issue_key) rows that would
--    block creating the constraint — keeps only the most recently updated row.
-- 4. Replace the old UNIQUE(user_id, issue_key) constraint with
--    UNIQUE(user_id, organization_id, issue_key) so the cacheUserIssues
--    upsert (onConflict: 'user_id,organization_id,issue_key') works correctly.
--
-- Safe to re-run: uses IF NOT EXISTS / IF EXISTS guards throughout.
-- ============================================================================

-- Step 1: Ensure all columns exist
ALTER TABLE public.user_jira_issues_cache
  ADD COLUMN IF NOT EXISTS priority     TEXT,
  ADD COLUMN IF NOT EXISTS description  TEXT,
  ADD COLUMN IF NOT EXISTS labels       JSONB DEFAULT '[]'::jsonb;

-- Step 2: Back-fill NULL organization_id from the users table
UPDATE public.user_jira_issues_cache c
SET    organization_id = u.organization_id
FROM   public.users u
WHERE  c.user_id = u.id
  AND  c.organization_id IS NULL
  AND  u.organization_id IS NOT NULL;

-- Delete any rows that still have NULL organization_id (no valid org to assign)
DELETE FROM public.user_jira_issues_cache
WHERE  organization_id IS NULL;

-- Step 3: Remove duplicates on (user_id, organization_id, issue_key),
--         keeping only the row with the latest updated_at.
DELETE FROM public.user_jira_issues_cache
WHERE  id NOT IN (
  SELECT DISTINCT ON (user_id, organization_id, issue_key) id
  FROM   public.user_jira_issues_cache
  ORDER  BY user_id, organization_id, issue_key, updated_at DESC NULLS LAST
);

-- Step 4: Drop the old two-column unique constraint
ALTER TABLE public.user_jira_issues_cache
  DROP CONSTRAINT IF EXISTS user_jira_issues_cache_user_id_issue_key_key;

-- Step 5: Create the three-column unique constraint (idempotent via DO block)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'user_jira_issues_cache_user_id_organization_id_issue_key_key'
  ) THEN
    ALTER TABLE public.user_jira_issues_cache
      ADD CONSTRAINT user_jira_issues_cache_user_id_organization_id_issue_key_key
      UNIQUE (user_id, organization_id, issue_key);
  END IF;
END
$$;
