-- ============================================================================
-- Extend user_jira_issues_cache with description and labels
-- These fields are needed by the desktop app for AI issue matching context
-- ============================================================================

ALTER TABLE public.user_jira_issues_cache
  ADD COLUMN IF NOT EXISTS description TEXT,
  ADD COLUMN IF NOT EXISTS labels JSONB DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS priority TEXT;
