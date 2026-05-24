-- ============================================================================
-- Relax the NOT NULL constraint on user_jira_issues_cache.summary
--
-- Background:
--   Production has both `summary` (NOT NULL, no default) and `issue_summary`
--   (nullable) columns. The cacheUserIssues upsert path
--   (forge-proxy-controller.js) only writes `issue_summary`, so every upsert
--   currently fails with:
--     null value in column "summary" violates not-null constraint (23502)
--
--   Readers already handle the dual-column transitional state:
--     screenshot-webhook, activity-webhook, user-db-service all do
--     `issue.issue_summary || issue.summary` — so allowing NULL summary on
--     new rows is safe (the value comes from issue_summary instead).
--
-- Effect:
--   - Existing rows untouched.
--   - New upserts will land with summary = NULL (or '' via the default).
--   - Readers transparently fall back to issue_summary.
--
-- Lock impact:
--   ALTER ... DROP NOT NULL / SET DEFAULT are metadata-only in Postgres 11+
--   (no table rewrite). lock_timeout guards against pile-up if a long-running
--   transaction is holding a row lock.
--
-- Rollback:
--   ALTER TABLE public.user_jira_issues_cache ALTER COLUMN summary DROP DEFAULT;
--   ALTER TABLE public.user_jira_issues_cache ALTER COLUMN summary SET NOT NULL;
--   (SET NOT NULL will fail if any rows have NULL summary by then.)
-- ============================================================================

SET lock_timeout = '5s';

ALTER TABLE public.user_jira_issues_cache
  ALTER COLUMN summary DROP NOT NULL;

ALTER TABLE public.user_jira_issues_cache
  ALTER COLUMN summary SET DEFAULT '';
