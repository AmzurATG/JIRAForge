/**
 * Admin Dashboard Resolvers
 * CRUD resolver definitions for the status report dashboard.
 * Every resolver checks isJiraAdmin() and scopes by organization_id.
 */

import { isJiraAdmin } from '../utils/jira.js';
import { getOrCreateOrganization } from '../utils/supabase.js';
import {
  fetchDashboardData,
  addHeaderMetric, updateHeaderMetric, deleteHeaderMetric,
  addOrganization, updateOrganization, deleteOrganization,
  addTicketTeam, updateTicketTeam, deleteTicketTeam,
  addTicketStatus, updateTicketStatus, deleteTicketStatus
} from '../services/adminDashboardService.js';

/**
 * Guard: reject non-admins with a consistent error shape
 */
async function requireAdmin() {
  const isAdmin = await isJiraAdmin();
  if (!isAdmin) {
    return { success: false, error: 'Access denied: Jira Administrator required' };
  }
  return null;
}

/**
 * Resolve the current Jira Cloud organization ID
 */
async function resolveOrgId(context) {
  const org = await getOrCreateOrganization(context.cloudId);
  return org.id;
}

/**
 * Register all admin-dashboard resolvers on the shared Forge resolver
 */
export function registerAdminDashboardResolvers(resolver) {

  // ── READ ────────────────────────────────────
  resolver.define('getDashboardData', async (req) => {
    const denied = await requireAdmin();
    if (denied) return denied;
    try {
      const orgId = await resolveOrgId(req.context);
      const data = await fetchDashboardData(orgId);
      return { success: true, data };
    } catch (error) {
      console.error('[AdminDashboard] getDashboardData error:', error);
      return { success: false, error: error.message };
    }
  });

  // ── HEADER METRICS ──────────────────────────
  resolver.define('addDashboardMetric', async (req) => {
    const denied = await requireAdmin();
    if (denied) return denied;
    try {
      const orgId = await resolveOrgId(req.context);
      const result = await addHeaderMetric(orgId, req.payload);
      return { success: true, data: result };
    } catch (error) {
      console.error('[AdminDashboard] addDashboardMetric error:', error);
      return { success: false, error: error.message };
    }
  });

  resolver.define('updateDashboardMetric', async (req) => {
    const denied = await requireAdmin();
    if (denied) return denied;
    try {
      const { id, ...data } = req.payload;
      const result = await updateHeaderMetric(id, data);
      return { success: true, data: result };
    } catch (error) {
      console.error('[AdminDashboard] updateDashboardMetric error:', error);
      return { success: false, error: error.message };
    }
  });

  resolver.define('deleteDashboardMetric', async (req) => {
    const denied = await requireAdmin();
    if (denied) return denied;
    try {
      await deleteHeaderMetric(req.payload.id);
      return { success: true };
    } catch (error) {
      console.error('[AdminDashboard] deleteDashboardMetric error:', error);
      return { success: false, error: error.message };
    }
  });

  // ── ORGANIZATIONS ───────────────────────────
  resolver.define('addDashboardOrg', async (req) => {
    const denied = await requireAdmin();
    if (denied) return denied;
    try {
      const orgId = await resolveOrgId(req.context);
      const result = await addOrganization(orgId, req.payload);
      return { success: true, data: result };
    } catch (error) {
      console.error('[AdminDashboard] addDashboardOrg error:', error);
      return { success: false, error: error.message };
    }
  });

  resolver.define('updateDashboardOrg', async (req) => {
    const denied = await requireAdmin();
    if (denied) return denied;
    try {
      const { id, ...data } = req.payload;
      const result = await updateOrganization(id, data);
      return { success: true, data: result };
    } catch (error) {
      console.error('[AdminDashboard] updateDashboardOrg error:', error);
      return { success: false, error: error.message };
    }
  });

  resolver.define('deleteDashboardOrg', async (req) => {
    const denied = await requireAdmin();
    if (denied) return denied;
    try {
      await deleteOrganization(req.payload.id);
      return { success: true };
    } catch (error) {
      console.error('[AdminDashboard] deleteDashboardOrg error:', error);
      return { success: false, error: error.message };
    }
  });

  // ── TICKETS PER TEAM ────────────────────────
  resolver.define('addDashboardTicketTeam', async (req) => {
    const denied = await requireAdmin();
    if (denied) return denied;
    try {
      const orgId = await resolveOrgId(req.context);
      const result = await addTicketTeam(orgId, req.payload);
      return { success: true, data: result };
    } catch (error) {
      console.error('[AdminDashboard] addDashboardTicketTeam error:', error);
      return { success: false, error: error.message };
    }
  });

  resolver.define('updateDashboardTicketTeam', async (req) => {
    const denied = await requireAdmin();
    if (denied) return denied;
    try {
      const { id, ...data } = req.payload;
      const result = await updateTicketTeam(id, data);
      return { success: true, data: result };
    } catch (error) {
      console.error('[AdminDashboard] updateDashboardTicketTeam error:', error);
      return { success: false, error: error.message };
    }
  });

  resolver.define('deleteDashboardTicketTeam', async (req) => {
    const denied = await requireAdmin();
    if (denied) return denied;
    try {
      await deleteTicketTeam(req.payload.id);
      return { success: true };
    } catch (error) {
      console.error('[AdminDashboard] deleteDashboardTicketTeam error:', error);
      return { success: false, error: error.message };
    }
  });

  // ── TICKET STATUS ───────────────────────────
  resolver.define('addDashboardTicketStatus', async (req) => {
    const denied = await requireAdmin();
    if (denied) return denied;
    try {
      const orgId = await resolveOrgId(req.context);
      const result = await addTicketStatus(orgId, req.payload);
      return { success: true, data: result };
    } catch (error) {
      console.error('[AdminDashboard] addDashboardTicketStatus error:', error);
      return { success: false, error: error.message };
    }
  });

  resolver.define('updateDashboardTicketStatus', async (req) => {
    const denied = await requireAdmin();
    if (denied) return denied;
    try {
      const { id, ...data } = req.payload;
      const result = await updateTicketStatus(id, data);
      return { success: true, data: result };
    } catch (error) {
      console.error('[AdminDashboard] updateDashboardTicketStatus error:', error);
      return { success: false, error: error.message };
    }
  });

  resolver.define('deleteDashboardTicketStatus', async (req) => {
    const denied = await requireAdmin();
    if (denied) return denied;
    try {
      await deleteTicketStatus(req.payload.id);
      return { success: true };
    } catch (error) {
      console.error('[AdminDashboard] deleteDashboardTicketStatus error:', error);
      return { success: false, error: error.message };
    }
  });
}
