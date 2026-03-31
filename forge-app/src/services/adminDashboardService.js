/**
 * Admin Dashboard Service
 * Supabase CRUD operations for the admin status report dashboard.
 * All queries are scoped by organization_id for multi-tenancy.
 */

import { supabaseQuery } from '../utils/remote.js';

// ──────────────────────────────────────────────
// Helper: build org filter
// ──────────────────────────────────────────────
function orgFilter(organizationId) {
  return { eq: { organization_id: organizationId } };
}

// ──────────────────────────────────────────────
// READ — fetch all dashboard data in parallel
// ──────────────────────────────────────────────

export async function fetchDashboardData(organizationId) {
  const [metrics, organizations, ticketsPerTeam, ticketStatuses] = await Promise.all([
    supabaseQuery('dashboard_header_metrics', {
      method: 'GET',
      query: { ...orgFilter(organizationId), order: { column: 'sort_order', ascending: true } }
    }),
    supabaseQuery('dashboard_organizations', {
      method: 'GET',
      query: { ...orgFilter(organizationId), order: { column: 'created_at', ascending: true } }
    }),
    supabaseQuery('dashboard_tickets_summary', {
      method: 'GET',
      query: { ...orgFilter(organizationId), order: { column: 'created_at', ascending: true } }
    }),
    supabaseQuery('dashboard_ticket_status', {
      method: 'GET',
      query: { ...orgFilter(organizationId), order: { column: 'sort_order', ascending: true } }
    })
  ]);

  return { metrics, organizations, ticketsPerTeam, ticketStatuses };
}

// ──────────────────────────────────────────────
// HEADER METRICS
// ──────────────────────────────────────────────

export async function addHeaderMetric(organizationId, data) {
  return supabaseQuery('dashboard_header_metrics', {
    method: 'POST',
    body: {
      organization_id: organizationId,
      metric_key: data.metricKey,
      metric_label: data.metricLabel,
      metric_value: data.metricValue ?? 0,
      sort_order: data.sortOrder ?? 0
    },
    select: '*'
  });
}

export async function updateHeaderMetric(id, data) {
  const updates = {};
  if (data.metricLabel !== undefined) updates.metric_label = data.metricLabel;
  if (data.metricValue !== undefined) updates.metric_value = data.metricValue;
  if (data.sortOrder !== undefined) updates.sort_order = data.sortOrder;

  return supabaseQuery('dashboard_header_metrics', {
    method: 'PATCH',
    query: { eq: { id } },
    body: updates,
    select: '*'
  });
}

export async function deleteHeaderMetric(id) {
  return supabaseQuery('dashboard_header_metrics', {
    method: 'DELETE',
    query: { eq: { id } }
  });
}

// ──────────────────────────────────────────────
// ORGANIZATIONS (Users Per Org & Team)
// ──────────────────────────────────────────────

export async function addOrganization(organizationId, data) {
  return supabaseQuery('dashboard_organizations', {
    method: 'POST',
    body: {
      organization_id: organizationId,
      name: data.name,
      user_count: data.userCount ?? 0
    },
    select: '*'
  });
}

export async function updateOrganization(id, data) {
  const updates = {};
  if (data.name !== undefined) updates.name = data.name;
  if (data.userCount !== undefined) updates.user_count = data.userCount;

  return supabaseQuery('dashboard_organizations', {
    method: 'PATCH',
    query: { eq: { id } },
    body: updates,
    select: '*'
  });
}

export async function deleteOrganization(id) {
  return supabaseQuery('dashboard_organizations', {
    method: 'DELETE',
    query: { eq: { id } }
  });
}

// ──────────────────────────────────────────────
// TICKETS PER TEAM
// ──────────────────────────────────────────────

export async function addTicketTeam(organizationId, data) {
  return supabaseQuery('dashboard_tickets_per_team', {
    method: 'POST',
    body: {
      organization_id: organizationId,
      team_name: data.teamName,
      tickets_raised: data.ticketsRaised ?? 0,
      started_date: data.startedDate ?? ''
    },
    select: '*'
  });
}

export async function updateTicketTeam(id, data) {
  const updates = {};
  if (data.teamName !== undefined) updates.team_name = data.teamName;
  if (data.ticketsRaised !== undefined) updates.tickets_raised = data.ticketsRaised;
  if (data.startedDate !== undefined) updates.started_date = data.startedDate;

  return supabaseQuery('dashboard_tickets_per_team', {
    method: 'PATCH',
    query: { eq: { id } },
    body: updates,
    select: '*'
  });
}

export async function deleteTicketTeam(id) {
  return supabaseQuery('dashboard_tickets_per_team', {
    method: 'DELETE',
    query: { eq: { id } }
  });
}

// ──────────────────────────────────────────────
// TICKET STATUS SUMMARY
// ──────────────────────────────────────────────

export async function addTicketStatus(organizationId, data) {
  return supabaseQuery('dashboard_ticket_status', {
    method: 'POST',
    body: {
      organization_id: organizationId,
      status: data.status,
      status_color: data.statusColor ?? '#000000',
      count: data.count ?? 0,
      team_breakdown: data.teamBreakdown ?? '',
      release_for_signoff: data.releaseForSignoff ?? '',
      sort_order: data.sortOrder ?? 0
    },
    select: '*'
  });
}

export async function updateTicketStatus(id, data) {
  const updates = {};
  if (data.status !== undefined) updates.status = data.status;
  if (data.statusColor !== undefined) updates.status_color = data.statusColor;
  if (data.count !== undefined) updates.count = data.count;
  if (data.teamBreakdown !== undefined) updates.team_breakdown = data.teamBreakdown;
  if (data.releaseForSignoff !== undefined) updates.release_for_signoff = data.releaseForSignoff;
  if (data.sortOrder !== undefined) updates.sort_order = data.sortOrder;

  return supabaseQuery('dashboard_ticket_status', {
    method: 'PATCH',
    query: { eq: { id } },
    body: updates,
    select: '*'
  });
}

export async function deleteTicketStatus(id) {
  return supabaseQuery('dashboard_ticket_status', {
    method: 'DELETE',
    query: { eq: { id } }
  });
}
