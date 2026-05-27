-- ============================================================================
-- Description quality cache and events tables.
--
-- Purpose:
--   Backs the AI-assisted Jira ticket description enhancement feature. The
--   `description_quality_cache` table memoizes deterministic + LLM analysis
--   results keyed on a SHA-256 hash of (title || description || issueType)
--   so repeated panel opens skip the LLM call. The `description_quality_events`
--   table stores acceptance / edit / rejection analytics for tuning the
--   feature without storing the original ticket text.
--
-- Multi-tenancy:
--   Both tables are RLS-protected. Every row carries `org_id`, scoping access
--   to the Forge org that produced it. The service role bypasses RLS for
--   the AI server's internal writes.
--
-- Notes:
--   - Never modify this migration in place — add a new one to alter schema.
--   - No PII is stored in the cache: titles/descriptions are NOT persisted;
--     only the derived score, issues, suggestions, and (sanitized) improved
--     versions returned by the LLM. The content_hash makes cache lookups
--     fast without storing the source content.
-- ============================================================================

CREATE TABLE IF NOT EXISTS description_quality_cache (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          text NOT NULL,
  issue_key       text NOT NULL,
  content_hash    text NOT NULL,
  issue_type      text,
  score           integer NOT NULL CHECK (score >= 0 AND score <= 100),
  source          text NOT NULL CHECK (source IN ('deterministic', 'llm')),
  issues          jsonb NOT NULL DEFAULT '[]'::jsonb,
  suggestions     jsonb NOT NULL DEFAULT '[]'::jsonb,
  improved_title  text,
  improved_description text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT description_quality_cache_org_issue_unique UNIQUE (org_id, issue_key)
);

CREATE INDEX IF NOT EXISTS idx_dqc_org_updated
  ON description_quality_cache (org_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_dqc_hash
  ON description_quality_cache (content_hash);

CREATE TABLE IF NOT EXISTS description_quality_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id        text NOT NULL,
  account_id    text,
  issue_key     text NOT NULL,
  event_type    text NOT NULL CHECK (event_type IN ('analyze', 'improve', 'accept', 'edit', 'reject')),
  score_before  integer CHECK (score_before IS NULL OR (score_before >= 0 AND score_before <= 100)),
  score_after   integer CHECK (score_after IS NULL OR (score_after >= 0 AND score_after <= 100)),
  source        text CHECK (source IS NULL OR source IN ('deterministic', 'llm')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_dqe_org_created
  ON description_quality_events (org_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_dqe_issue
  ON description_quality_events (org_id, issue_key);

-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------

ALTER TABLE description_quality_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE description_quality_events ENABLE ROW LEVEL SECURITY;

-- Service role (used by ai-server) bypasses RLS for inserts / upserts.
CREATE POLICY description_quality_cache_service_all
  ON description_quality_cache
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY description_quality_events_service_all
  ON description_quality_events
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Authenticated callers (Forge JWT carries org_id as a custom claim) can
-- only see rows for their own org. The ai-server uses the service role and
-- never relies on this policy, but it protects against direct anon access.
CREATE POLICY description_quality_cache_org_isolation
  ON description_quality_cache
  FOR SELECT
  TO authenticated
  USING (org_id = current_setting('request.jwt.claims', true)::json->>'org_id');

CREATE POLICY description_quality_events_org_isolation
  ON description_quality_events
  FOR SELECT
  TO authenticated
  USING (org_id = current_setting('request.jwt.claims', true)::json->>'org_id');

-- ----------------------------------------------------------------------------
-- updated_at trigger
-- ----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION description_quality_cache_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_dqc_set_updated_at ON description_quality_cache;
CREATE TRIGGER trg_dqc_set_updated_at
  BEFORE UPDATE ON description_quality_cache
  FOR EACH ROW
  EXECUTE FUNCTION description_quality_cache_set_updated_at();

-- ----------------------------------------------------------------------------
-- Documentation comments
-- ----------------------------------------------------------------------------

COMMENT ON TABLE description_quality_cache IS
  'Cached AI quality analysis results for Jira tickets. Keyed on (org_id, issue_key); invalidated when content_hash diverges from current ticket content.';

COMMENT ON COLUMN description_quality_cache.content_hash IS
  'SHA-256(title || description || issue_type). Used to detect whether the ticket changed since the cached result was produced.';

COMMENT ON TABLE description_quality_events IS
  'Analytics events for the description quality feature (analyze/improve/accept/edit/reject). Used to measure adoption and tune prompts.';
