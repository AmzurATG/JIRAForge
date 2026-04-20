-- Performance: team analytics query path
-- Adds composite index for organization + project + date filtering on activity_records.
-- Safe additive change: no table/column modification.

CREATE INDEX IF NOT EXISTS idx_activity_org_project_work_date
ON public.activity_records(organization_id, project_key, work_date);
