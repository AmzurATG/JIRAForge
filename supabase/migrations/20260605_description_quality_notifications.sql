-- ============================================================================
-- Description Quality Notifications — multi-channel nudge ledger
--
-- Purpose:
--   Tracks per-(user, issue, channel) notification history for the description
--   quality nudge scheduler (Enhancement #13). Used for:
--     1. Cross-channel dedupe so a user is not nudged twice for the same ticket
--        within the configured cooldown window (default 24 h).
--     2. Desktop-app polling — the python-desktop-app reads pending rows where
--        channel = 'desktop' AND acknowledged_at IS NULL and renders a popup.
--     3. Acknowledgement bookkeeping (viewed / opened / dismissed / snoozed).
--
-- Multi-tenancy:
--   org_id (jira cloud id) on every row, RLS enabled. The ai-server uses the
--   service role and bypasses RLS for writes; authenticated callers can only
--   read/update their own org's rows.
--
-- Notes:
--   - No `description` / body text is ever stored — only key, summary, score,
--     and pre-built deep-link URLs in `payload` (privacy guardrail, §11 of plan).
--   - 24 h cooldown is enforced in code, NOT by a unique constraint on
--     (org_id, account_id, issue_key, channel) so historical analytics stay
--     intact and snooze flows can re-create rows.
--   - Never modify this file once shipped — add a new migration.
-- ============================================================================

CREATE TABLE IF NOT EXISTS description_quality_notifications (
  id              bigserial PRIMARY KEY,
  org_id          text NOT NULL,
  account_id      text NOT NULL,
  cloud_id        text NOT NULL,
  issue_key       text NOT NULL,
  score_at_notify smallint NOT NULL CHECK (score_at_notify >= 0 AND score_at_notify <= 100),
  channel         text NOT NULL CHECK (channel IN ('jira', 'desktop', 'email')),
  payload         jsonb,
  notified_at     timestamptz NOT NULL DEFAULT now(),
  acknowledged_at timestamptz,
  ack_action      text CHECK (
    ack_action IS NULL OR ack_action IN ('viewed', 'opened-in-jira', 'dismissed', 'snoozed')
  ),
  snooze_until    timestamptz
);

-- Lookup index for dedupe / cooldown checks (per user+issue across channels).
CREATE INDEX IF NOT EXISTS dqn_org_user_issue_idx
  ON description_quality_notifications (org_id, account_id, issue_key);

-- Pending-desktop-nudges partial index — drives the desktop poll endpoint hot path.
CREATE INDEX IF NOT EXISTS dqn_pending_desktop_idx
  ON description_quality_notifications (org_id, account_id)
  WHERE channel = 'desktop' AND acknowledged_at IS NULL;

-- Analytics index — recent activity per org.
CREATE INDEX IF NOT EXISTS dqn_org_recent_idx
  ON description_quality_notifications (org_id, notified_at DESC);

-- ----------------------------------------------------------------------------
-- Row Level Security
-- ----------------------------------------------------------------------------

ALTER TABLE description_quality_notifications ENABLE ROW LEVEL SECURITY;

-- Service role (used by ai-server) bypasses RLS for all writes.
CREATE POLICY dqn_service_all
  ON description_quality_notifications
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Authenticated callers can only see / update rows in their own org.
-- Forge JWT carries `org_id` as a custom claim. The ai-server uses the service
-- role and never relies on this policy, but it protects against direct anon
-- access if a caller ever reaches the table with an end-user JWT.
CREATE POLICY dqn_select_own_org
  ON description_quality_notifications
  FOR SELECT
  TO authenticated
  USING (org_id = current_setting('request.jwt.claims', true)::json ->> 'org_id');

CREATE POLICY dqn_update_own_org
  ON description_quality_notifications
  FOR UPDATE
  TO authenticated
  USING (org_id = current_setting('request.jwt.claims', true)::json ->> 'org_id');

-- ============================================================================
-- Per-user nudge channel preferences
--
-- Stores opt-in/opt-out toggles for the bell (Jira-notify) and popup (desktop)
-- channels. Defaults are TRUE for both (default opt-in, default visible).
-- Mirrored client-side by the desktop app but the server is source of truth.
-- ============================================================================

CREATE TABLE IF NOT EXISTS description_quality_nudge_preferences (
  account_id    text NOT NULL,
  org_id        text NOT NULL,
  bell_enabled  boolean NOT NULL DEFAULT true,
  popup_enabled boolean NOT NULL DEFAULT true,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, org_id)
);

ALTER TABLE description_quality_nudge_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY dqnp_service_all
  ON description_quality_nudge_preferences
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY dqnp_select_own_org
  ON description_quality_nudge_preferences
  FOR SELECT
  TO authenticated
  USING (org_id = current_setting('request.jwt.claims', true)::json ->> 'org_id');
