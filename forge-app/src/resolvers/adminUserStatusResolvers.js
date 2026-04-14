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

      // Today's date in YYYY-MM-DD (UTC) for the time summary query
      const today = new Date().toISOString().split('T')[0];

      const [users, dailySummary] = await Promise.all([
        supabaseRequest(
          supabaseConfig,
          `users?organization_id=eq.${organization.id}&select=id,display_name,is_active,desktop_logged_in,desktop_last_heartbeat,desktop_app_version&order=display_name.asc`
        ),
        supabaseRequest(
          supabaseConfig,
          `daily_time_summary?organization_id=eq.${organization.id}&work_date=eq.${today}&select=user_id,total_seconds`
        )
      ]);

      // Aggregate total seconds per user from the daily summary (view has multiple rows per user per project/task)
      const timeTodayByUser = {};
      (dailySummary || []).forEach(row => {
        timeTodayByUser[row.user_id] = (timeTodayByUser[row.user_id] || 0) + (row.total_seconds || 0);
      });

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
          displayName: u.display_name,
          isActive: u.is_active,
          desktopInstalled: hasDesktopInstalled,
          desktopLoggedIn: u.desktop_logged_in === true,
          activeNow: isActiveNow,
          lastHeartbeat: u.desktop_last_heartbeat,
          appVersion: u.desktop_app_version,
          timeTodaySeconds: timeTodayByUser[u.id] || 0,
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
