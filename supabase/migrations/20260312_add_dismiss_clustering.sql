-- Migration: Add soft-delete (dismiss) support for unassigned work clustering
-- Users can dismiss a whole cluster or individual sessions from a cluster.
-- Dismissed items are NOT permanently deleted; they are excluded from future clustering.

-- 1. Dismissal flag on unassigned_work_groups (whole cluster dismiss)
ALTER TABLE unassigned_work_groups
  ADD COLUMN IF NOT EXISTS is_dismissed     BOOLEAN   NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS dismissed_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS dismissed_by     UUID REFERENCES users(id);

-- 2. Dismissal flag on activity_records (new pipeline - per-session dismiss)
ALTER TABLE activity_records
  ADD COLUMN IF NOT EXISTS clustering_dismissed     BOOLEAN   NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS clustering_dismissed_at  TIMESTAMPTZ;

-- 3. Dismissal flag on unassigned_activity (legacy pipeline - per-session dismiss)
ALTER TABLE unassigned_activity
  ADD COLUMN IF NOT EXISTS clustering_dismissed     BOOLEAN   NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS clustering_dismissed_at  TIMESTAMPTZ;

-- Indexes: clustering queries filter on clustering_dismissed=false constantly
CREATE INDEX IF NOT EXISTS idx_activity_records_not_dismissed
  ON activity_records(user_id, organization_id, clustering_dismissed)
  WHERE clustering_dismissed = FALSE;

CREATE INDEX IF NOT EXISTS idx_unassigned_activity_not_dismissed
  ON unassigned_activity(user_id, organization_id, clustering_dismissed)
  WHERE clustering_dismissed = FALSE;

CREATE INDEX IF NOT EXISTS idx_unassigned_groups_not_dismissed
  ON unassigned_work_groups(user_id, organization_id, is_dismissed)
  WHERE is_dismissed = FALSE;
