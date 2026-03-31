-- ============================================================
-- Admin Dashboard Tables
-- Status Report dashboard with CRUD capabilities
-- All tables scoped by organization_id for multi-tenancy
-- ============================================================

-- 1. Header Metrics (Total Users, Active Users, etc.)
CREATE TABLE IF NOT EXISTS dashboard_header_metrics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  metric_key TEXT NOT NULL,
  metric_label TEXT NOT NULL,
  metric_value INTEGER NOT NULL DEFAULT 0,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(organization_id, metric_key)
);

ALTER TABLE dashboard_header_metrics ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON dashboard_header_metrics FOR ALL USING (true);

-- 2. Users Per Organization & Team
CREATE TABLE IF NOT EXISTS dashboard_organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  user_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(organization_id, name)
);

ALTER TABLE dashboard_organizations ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON dashboard_organizations FOR ALL USING (true);

-- 3. Tickets Raised Per Team
CREATE TABLE IF NOT EXISTS dashboard_tickets_per_team (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  team_name TEXT NOT NULL,
  tickets_raised INTEGER NOT NULL DEFAULT 0,
  started_date TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE dashboard_tickets_per_team ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON dashboard_tickets_per_team FOR ALL USING (true);

-- 4. Ticket Status Summary
CREATE TABLE IF NOT EXISTS dashboard_ticket_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  status TEXT NOT NULL,
  status_color TEXT DEFAULT '#000000',
  count INTEGER NOT NULL DEFAULT 0,
  team_breakdown TEXT,
  release_for_signoff TEXT,
  sort_order INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE dashboard_ticket_status ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Service role full access" ON dashboard_ticket_status FOR ALL USING (true);

-- 5. View: Tickets summary with auto-calculated percentage
CREATE OR REPLACE VIEW dashboard_tickets_summary AS
SELECT
  t.id,
  t.organization_id,
  t.team_name,
  t.tickets_raised,
  CASE
    WHEN tot.total > 0
    THEN ROUND((t.tickets_raised::NUMERIC / tot.total) * 100, 1)
    ELSE 0
  END AS percent_of_total,
  t.started_date,
  t.created_at,
  t.updated_at
FROM dashboard_tickets_per_team t
CROSS JOIN LATERAL (
  SELECT COALESCE(SUM(tickets_raised), 0) AS total
  FROM dashboard_tickets_per_team
  WHERE organization_id = t.organization_id
) tot;

-- 6. Auto-update updated_at trigger function
CREATE OR REPLACE FUNCTION update_dashboard_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply triggers
CREATE TRIGGER dashboard_header_metrics_updated_at
  BEFORE UPDATE ON dashboard_header_metrics
  FOR EACH ROW EXECUTE FUNCTION update_dashboard_updated_at();

CREATE TRIGGER dashboard_organizations_updated_at
  BEFORE UPDATE ON dashboard_organizations
  FOR EACH ROW EXECUTE FUNCTION update_dashboard_updated_at();

CREATE TRIGGER dashboard_tickets_per_team_updated_at
  BEFORE UPDATE ON dashboard_tickets_per_team
  FOR EACH ROW EXECUTE FUNCTION update_dashboard_updated_at();

CREATE TRIGGER dashboard_ticket_status_updated_at
  BEFORE UPDATE ON dashboard_ticket_status
  FOR EACH ROW EXECUTE FUNCTION update_dashboard_updated_at();

-- 7. Indexes for query performance
CREATE INDEX idx_dashboard_header_metrics_org ON dashboard_header_metrics(organization_id);
CREATE INDEX idx_dashboard_organizations_org ON dashboard_organizations(organization_id);
CREATE INDEX idx_dashboard_tickets_per_team_org ON dashboard_tickets_per_team(organization_id);
CREATE INDEX idx_dashboard_ticket_status_org ON dashboard_ticket_status(organization_id);
