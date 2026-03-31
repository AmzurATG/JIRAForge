/**
 * Admin Dashboard DB Service
 * Direct Supabase CRUD operations for the admin status report dashboard.
 * All queries are scoped by organization_id for multi-tenancy.
 */

const { getClient } = require('./supabase-client');
const logger = require('../../utils/logger');

// ──────────────────────────────────────────────
// READ — fetch all dashboard data in parallel
// ──────────────────────────────────────────────

async function fetchDashboardData(organizationId) {
  const supabase = getClient();
  if (!supabase) throw new Error('Database not configured');

  const [metrics, organizations, ticketsPerTeam, ticketStatuses] = await Promise.all([
    supabase.from('dashboard_header_metrics')
      .select('*')
      .eq('organization_id', organizationId)
      .order('sort_order', { ascending: true }),
    supabase.from('dashboard_organizations')
      .select('*')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: true }),
    supabase.from('dashboard_tickets_summary')
      .select('*')
      .eq('organization_id', organizationId)
      .order('created_at', { ascending: true }),
    supabase.from('dashboard_ticket_status')
      .select('*')
      .eq('organization_id', organizationId)
      .order('sort_order', { ascending: true })
  ]);

  if (metrics.error) throw metrics.error;
  if (organizations.error) throw organizations.error;
  if (ticketsPerTeam.error) throw ticketsPerTeam.error;
  if (ticketStatuses.error) throw ticketStatuses.error;

  return {
    metrics: metrics.data,
    organizations: organizations.data,
    ticketsPerTeam: ticketsPerTeam.data,
    ticketStatuses: ticketStatuses.data
  };
}

// ──────────────────────────────────────────────
// HEADER METRICS
// ──────────────────────────────────────────────

async function addHeaderMetric(organizationId, data) {
  const supabase = getClient();
  if (!supabase) throw new Error('Database not configured');

  const { data: result, error } = await supabase
    .from('dashboard_header_metrics')
    .insert({
      organization_id: organizationId,
      metric_key: data.metricKey,
      metric_label: data.metricLabel,
      metric_value: data.metricValue ?? 0,
      sort_order: data.sortOrder ?? 0
    })
    .select('*')
    .single();

  if (error) throw error;
  return result;
}

async function updateHeaderMetric(id, data) {
  const supabase = getClient();
  if (!supabase) throw new Error('Database not configured');

  const updates = {};
  if (data.metricLabel !== undefined) updates.metric_label = data.metricLabel;
  if (data.metricValue !== undefined) updates.metric_value = data.metricValue;
  if (data.sortOrder !== undefined) updates.sort_order = data.sortOrder;

  const { data: result, error } = await supabase
    .from('dashboard_header_metrics')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();

  if (error) throw error;
  return result;
}

async function deleteHeaderMetric(id) {
  const supabase = getClient();
  if (!supabase) throw new Error('Database not configured');

  const { error } = await supabase
    .from('dashboard_header_metrics')
    .delete()
    .eq('id', id);

  if (error) throw error;
}

// ──────────────────────────────────────────────
// ORGANIZATIONS (Users Per Org & Team)
// ──────────────────────────────────────────────

async function addOrganization(organizationId, data) {
  const supabase = getClient();
  if (!supabase) throw new Error('Database not configured');

  const { data: result, error } = await supabase
    .from('dashboard_organizations')
    .insert({
      organization_id: organizationId,
      name: data.name,
      user_count: data.userCount ?? 0
    })
    .select('*')
    .single();

  if (error) throw error;
  return result;
}

async function updateOrganization(id, data) {
  const supabase = getClient();
  if (!supabase) throw new Error('Database not configured');

  const updates = {};
  if (data.name !== undefined) updates.name = data.name;
  if (data.userCount !== undefined) updates.user_count = data.userCount;

  const { data: result, error } = await supabase
    .from('dashboard_organizations')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();

  if (error) throw error;
  return result;
}

async function deleteOrganization(id) {
  const supabase = getClient();
  if (!supabase) throw new Error('Database not configured');

  const { error } = await supabase
    .from('dashboard_organizations')
    .delete()
    .eq('id', id);

  if (error) throw error;
}

// ──────────────────────────────────────────────
// TICKETS PER TEAM
// ──────────────────────────────────────────────

async function addTicketTeam(organizationId, data) {
  const supabase = getClient();
  if (!supabase) throw new Error('Database not configured');

  const { data: result, error } = await supabase
    .from('dashboard_tickets_per_team')
    .insert({
      organization_id: organizationId,
      team_name: data.teamName,
      tickets_raised: data.ticketsRaised ?? 0,
      started_date: data.startedDate ?? ''
    })
    .select('*')
    .single();

  if (error) throw error;
  return result;
}

async function updateTicketTeam(id, data) {
  const supabase = getClient();
  if (!supabase) throw new Error('Database not configured');

  const updates = {};
  if (data.teamName !== undefined) updates.team_name = data.teamName;
  if (data.ticketsRaised !== undefined) updates.tickets_raised = data.ticketsRaised;
  if (data.startedDate !== undefined) updates.started_date = data.startedDate;

  const { data: result, error } = await supabase
    .from('dashboard_tickets_per_team')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();

  if (error) throw error;
  return result;
}

async function deleteTicketTeam(id) {
  const supabase = getClient();
  if (!supabase) throw new Error('Database not configured');

  const { error } = await supabase
    .from('dashboard_tickets_per_team')
    .delete()
    .eq('id', id);

  if (error) throw error;
}

// ──────────────────────────────────────────────
// TICKET STATUS SUMMARY
// ──────────────────────────────────────────────

async function addTicketStatus(organizationId, data) {
  const supabase = getClient();
  if (!supabase) throw new Error('Database not configured');

  const { data: result, error } = await supabase
    .from('dashboard_ticket_status')
    .insert({
      organization_id: organizationId,
      status: data.status,
      status_color: data.statusColor ?? '#000000',
      count: data.count ?? 0,
      team_breakdown: data.teamBreakdown ?? '',
      release_for_signoff: data.releaseForSignoff ?? '',
      sort_order: data.sortOrder ?? 0
    })
    .select('*')
    .single();

  if (error) throw error;
  return result;
}

async function updateTicketStatus(id, data) {
  const supabase = getClient();
  if (!supabase) throw new Error('Database not configured');

  const updates = {};
  if (data.status !== undefined) updates.status = data.status;
  if (data.statusColor !== undefined) updates.status_color = data.statusColor;
  if (data.count !== undefined) updates.count = data.count;
  if (data.teamBreakdown !== undefined) updates.team_breakdown = data.teamBreakdown;
  if (data.releaseForSignoff !== undefined) updates.release_for_signoff = data.releaseForSignoff;
  if (data.sortOrder !== undefined) updates.sort_order = data.sortOrder;

  const { data: result, error } = await supabase
    .from('dashboard_ticket_status')
    .update(updates)
    .eq('id', id)
    .select('*')
    .single();

  if (error) throw error;
  return result;
}

async function deleteTicketStatus(id) {
  const supabase = getClient();
  if (!supabase) throw new Error('Database not configured');

  const { error } = await supabase
    .from('dashboard_ticket_status')
    .delete()
    .eq('id', id);

  if (error) throw error;
}

module.exports = {
  fetchDashboardData,
  addHeaderMetric, updateHeaderMetric, deleteHeaderMetric,
  addOrganization, updateOrganization, deleteOrganization,
  addTicketTeam, updateTicketTeam, deleteTicketTeam,
  addTicketStatus, updateTicketStatus, deleteTicketStatus
};
