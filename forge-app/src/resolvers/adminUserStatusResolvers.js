/**
 * Admin User Status Resolvers
 * Provides organization-wide desktop app adoption and activity status
 * Jira Administrator only
 */

import { isJiraAdmin } from '../utils/jira.js';
import { getSupabaseConfig, getOrCreateOrganization, supabaseRequest } from '../utils/supabase.js';

const ACTIVE_NOW_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Register admin user status resolvers
 * @param {Resolver} resolver - Forge resolver instance
 */
export function registerAdminUserStatusResolvers(resolver) {
  /**
   * Resolver for fetching all org users' desktop app status
   * Admin only — returns summary stats + per-user desktop status
   */
  resolver.define('getAdminUserStatus', async (req) => {
    const { context } = req;
    const accountId = context.accountId;
    const cloudId = context.cloudId;

    try {
      const adminCheck = await isJiraAdmin();
      if (!adminCheck) {
        return { success: false, error: 'Access denied: Jira Administrator required' };
      }

      const supabaseConfig = await getSupabaseConfig(accountId);
      if (!supabaseConfig) {
        return { success: false, error: 'Supabase not configured' };
      }

      const organization = await getOrCreateOrganization(cloudId, supabaseConfig);
      if (!organization) {
        return { success: false, error: 'Unable to get organization information' };
      }

      const users = await supabaseRequest(
        supabaseConfig,
        `users?organization_id=eq.${organization.id}&select=id,email,display_name,is_active,desktop_logged_in,desktop_last_heartbeat,desktop_app_version&order=display_name.asc`
      );

      const now = Date.now();

      const enrichedUsers = (users || []).map(u => {
        const heartbeatMs = u.desktop_last_heartbeat
          ? new Date(u.desktop_last_heartbeat).getTime()
          : null;
        const hasDesktopInstalled =
          u.desktop_logged_in === true || heartbeatMs !== null;
        const isActiveNow =
          heartbeatMs !== null && (now - heartbeatMs) < ACTIVE_NOW_THRESHOLD_MS;

        return {
          id: u.id,
          email: u.email,
          displayName: u.display_name,
          isActive: u.is_active,
          desktopInstalled: hasDesktopInstalled,
          desktopLoggedIn: u.desktop_logged_in === true,
          activeNow: isActiveNow,
          lastHeartbeat: u.desktop_last_heartbeat,
          appVersion: u.desktop_app_version,
        };
      });

      const totalUsers = enrichedUsers.length;
      const installedCount = enrichedUsers.filter(u => u.desktopInstalled).length;
      const activeNowCount = enrichedUsers.filter(u => u.activeNow).length;

      return {
        success: true,
        data: {
          summary: {
            totalUsers,
            installedCount,
            notInstalledCount: totalUsers - installedCount,
            activeNowCount
          },
          users: enrichedUsers,
          fetchedAt: new Date().toISOString()
        }
      };
    } catch (error) {
      console.error('[AdminUserStatus] Error:', error);
      return { success: false, error: error.message };
    }
  });
}
