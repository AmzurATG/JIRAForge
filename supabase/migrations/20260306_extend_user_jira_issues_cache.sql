-- ============================================================================
-- Ensure user_jira_issues_cache has all required columns.
-- Uses ADD COLUMN IF NOT EXISTS so this is safe to re-run even if some
-- columns already exist (e.g. on dev vs prod databases that were set up
-- from different schema versions).
-- ============================================================================

ALTER TABLE public.user_jira_issues_cache
  ADD COLUMN IF NOT EXISTS issue_summary  TEXT,
  ADD COLUMN IF NOT EXISTS project_key    TEXT,
  ADD COLUMN IF NOT EXISTS project_name   TEXT,
  ADD COLUMN IF NOT EXISTS issue_type     TEXT,
  ADD COLUMN IF NOT EXISTS status         TEXT,
  ADD COLUMN IF NOT EXISTS description    TEXT,
  ADD COLUMN IF NOT EXISTS labels         JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS priority       TEXT,
  ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS cached_at      TIMESTAMPTZ DEFAULT NOW();
