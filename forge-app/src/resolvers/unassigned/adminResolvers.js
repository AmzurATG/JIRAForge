/**
 * Admin Resolvers for Unassigned Work
 * Handles admin-only operations like clustering and role management
 */

import { fetch } from '@forge/api';
import { getSupabaseConfig, getOrCreateUser, getOrCreateOrganization, getUserOrganizationMembership } from '../../utils/supabase.js';
import { getUserSettings } from '../../services/settingsService.js';

/**
 * Trigger clustering for the organization (Admin only)
 * Calls the AI server to group unassigned activities
 */
export async function triggerClustering(req) {
  const t0 = Date.now();
  try {
    const { accountId, cloudId } = req.context;

    const supabaseConfig = await getSupabaseConfig(accountId);
    if (!supabaseConfig) {
      return { success: false, error: 'Supabase not configured' };
    }

    // Get or create organization first (multi-tenancy)
    const organization = await getOrCreateOrganization(cloudId, supabaseConfig);
    if (!organization) {
      return { success: false, error: 'Unable to get organization information' };
    }

    const userId = await getOrCreateUser(accountId, supabaseConfig, organization.id);

    // Check if user is admin/owner
    const membership = await getUserOrganizationMembership(userId, organization.id, supabaseConfig);
    if (!membership || !['owner', 'admin'].includes(membership.role)) {
      return {
        success: false,
        error: 'Access denied. Only organization admins can trigger clustering.'
      };
    }

    // Get AI server settings
    const settings = await getUserSettings(accountId);
    if (!settings.aiServerUrl) {
      return { success: false, error: 'AI Server URL not configured. Please configure it in Settings.' };
    }

    console.log(`[triggerClustering] Admin ${accountId} triggering clustering for org ${organization.id}`);

    // Call AI server to trigger organization-wide clustering
    const response = await fetch(`${settings.aiServerUrl}/api/trigger-org-clustering`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${settings.aiServerApiKey || ''}`
      },
      body: JSON.stringify({
        organizationId: organization.id
      })
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      console.error('[triggerClustering] AI server error:', errorData);
      return {
        success: false,
        error: errorData.error || `AI server returned status ${response.status}`
      };
    }

    const result = await response.json();
    console.log('[triggerClustering] AI server response:', result);

    return {
      success: true,
      message: result.message || 'Clustering completed successfully',
      usersProcessed: result.usersProcessed || 0,
      errors: result.errors || 0
    };

  } catch (error) {
    console.error('Error triggering clustering:', error);
    return { success: false, error: error.message };
  } finally {
    console.log(`[UnassignedResolver] triggerClustering took ${Date.now() - t0}ms`);
  }
}

/**
 * Get user's role and permissions for the current organization
 */
export async function getUserRole(req) {
  const t0 = Date.now();
  console.log('[getUserRole] Starting...');
  try {
    const { accountId, cloudId } = req.context;
    console.log('[getUserRole] accountId:', accountId, 'cloudId:', cloudId);

    const supabaseConfig = await getSupabaseConfig(accountId);
    if (!supabaseConfig) {
      console.log('[getUserRole] Supabase not configured');
      return { success: false, error: 'Supabase not configured' };
    }

    // Get or create organization first (multi-tenancy)
    const organization = await getOrCreateOrganization(cloudId, supabaseConfig);
    if (!organization) {
      console.log('[getUserRole] Unable to get organization');
      return { success: false, error: 'Unable to get organization information' };
    }
    console.log('[getUserRole] Organization:', organization.id);

    const userId = await getOrCreateUser(accountId, supabaseConfig, organization.id);
    console.log('[getUserRole] User ID:', userId);

    // Get user's membership
    const membership = await getUserOrganizationMembership(userId, organization.id, supabaseConfig);
    console.log('[getUserRole] Membership:', JSON.stringify(membership));

    const role = membership?.role || 'member';
    const canTriggerClustering = ['owner', 'admin'].includes(role);
    console.log('[getUserRole] Role:', role, 'canTriggerClustering:', canTriggerClustering);

    return {
      success: true,
      role: role,
      permissions: {
        canManageSettings: membership?.can_manage_settings || false,
        canViewTeamAnalytics: membership?.can_view_team_analytics || false,
        canManageMembers: membership?.can_manage_members || false,
        canTriggerClustering: canTriggerClustering
      }
    };

  } catch (error) {
    console.error('Error getting user role:', error);
    return { success: false, error: error.message };
  } finally {
    console.log(`[UnassignedResolver] getUserRole took ${Date.now() - t0}ms`);
  }
}

/**
 * Register admin resolvers
 */
export function registerAdminResolvers(resolver) {
  resolver.define('triggerClustering', triggerClustering);
  resolver.define('getUserRole', getUserRole);
}
