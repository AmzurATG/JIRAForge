-- ============================================================================
-- Unassigned Sync Jobs
--
-- Purpose:
--   Persist timeout-safe async job state for the Unassigned Work "Sync with Jira"
--   flow so Forge invocations can return partial progress and resume via polling.
--
-- Notes:
--   - Jobs are scoped by (organization_id, user_id).
--   - payload stores immutable inputs (issues/sessions/cursor seed).
--   - progress stores mutable counters (cursor/processed/matched/reason).
--   - Never modify this migration in place; add new migration files for changes.
-- ============================================================================

CREATE TABLE IF NOT EXISTS public.unassigned_sync_jobs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  organization_id   uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  job_type          text NOT NULL DEFAULT 'sync_recent_unassigned_with_updated_issues',
  status            text NOT NULL CHECK (status IN ('queued', 'in_progress', 'completed', 'failed')),
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  progress          jsonb NOT NULL DEFAULT '{}'::jsonb,
  result            jsonb,
  error             text,
  started_at        timestamptz,
  completed_at      timestamptz,
  last_heartbeat_at timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_unassigned_sync_jobs_user_org_created
  ON public.unassigned_sync_jobs (user_id, organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_unassigned_sync_jobs_status
  ON public.unassigned_sync_jobs (status, created_at DESC);

ALTER TABLE public.unassigned_sync_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY unassigned_sync_jobs_service_all
  ON public.unassigned_sync_jobs
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

CREATE POLICY unassigned_sync_jobs_select_own_org
  ON public.unassigned_sync_jobs
  FOR SELECT
  TO authenticated
  USING (organization_id::text = current_setting('request.jwt.claims', true)::json ->> 'org_id');

CREATE POLICY unassigned_sync_jobs_update_own_org
  ON public.unassigned_sync_jobs
  FOR UPDATE
  TO authenticated
  USING (organization_id::text = current_setting('request.jwt.claims', true)::json ->> 'org_id');

CREATE OR REPLACE FUNCTION public.unassigned_sync_jobs_set_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_unassigned_sync_jobs_set_updated_at ON public.unassigned_sync_jobs;
CREATE TRIGGER trg_unassigned_sync_jobs_set_updated_at
  BEFORE UPDATE ON public.unassigned_sync_jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.unassigned_sync_jobs_set_updated_at();
