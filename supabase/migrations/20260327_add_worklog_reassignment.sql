-- Add reassignment audit columns to worklog_sync
ALTER TABLE worklog_sync
  ADD COLUMN IF NOT EXISTS reassigned_from TEXT,
  ADD COLUMN IF NOT EXISTS reassigned_at TIMESTAMPTZ;

-- Index for querying reassignment history
CREATE INDEX IF NOT EXISTS idx_worklog_sync_reassigned
  ON worklog_sync (reassigned_from)
  WHERE reassigned_from IS NOT NULL;

-- Add reassignment audit columns to activity_records (if not already present)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'activity_records' AND column_name = 'reassigned_from'
  ) THEN
    ALTER TABLE activity_records
      ADD COLUMN reassigned_from TEXT,
      ADD COLUMN reassigned_at TIMESTAMPTZ;
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_activity_records_reassigned
  ON activity_records (reassigned_from)
  WHERE reassigned_from IS NOT NULL;
