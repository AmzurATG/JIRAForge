/**
 * Analytics Resolvers
 * Resolver definitions for time analytics endpoints
 */

import { fetchTimeAnalytics, fetchTimeAnalyticsBatch, fetchAllAnalytics, fetchProjectAnalytics, fetchProjectTeamAnalytics, fetchTeamDayTimeline, fetchMyDayTimeline, convertIdleToWorklog } from '../services/analyticsService.js';
import { isJiraAdmin, checkUserPermissions } from '../utils/jira.js';

// Feature flag for using batch API (set to true for production)
const USE_BATCH_API = true;

/**
 * Register analytics resolvers
 * @param {Resolver} resolver - Forge resolver instance
 */
export function registerAnalyticsResolvers(resolver) {
  /**
   * Resolver for fetching time analytics data from Supabase
   * Uses optimized batch API to reduce API calls from 8+ to 1
   */
  resolver.define('getTimeAnalytics', async (req) => {
    const { context } = req;
    const accountId = context.accountId;
    const cloudId = context.cloudId;  // Multi-tenancy: Get Jira Cloud ID from context

    try {
      // Use batch API for improved performance (reduces API calls from 8+ to 1)
      const data = USE_BATCH_API 
        ? await fetchTimeAnalyticsBatch(accountId, cloudId)
        : await fetchTimeAnalytics(accountId, cloudId);
      return {
        success: true,
        data
      };
    } catch (error) {
      console.error('Error fetching time analytics:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });

  /**
   * Resolver for fetching all analytics (Admin only)
   */
  resolver.define('getAllAnalytics', async (req) => {
    const { payload, context } = req;
    const accountId = context.accountId;
    const cloudId = context.cloudId;
    const clientToday = payload?.clientToday;

    try {
      const adminCheck = await isJiraAdmin();
      if (!adminCheck) {
        return { success: false, error: 'Access denied: Jira Administrator required' };
      }
      const data = await fetchAllAnalytics(accountId, cloudId, clientToday);
      return { success: true, data };
    } catch (error) {
      console.error('Error fetching all analytics:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * Resolver for fetching project analytics (Project Manager only)
   */
  resolver.define('getProjectAnalytics', async (req) => {
    const { payload, context } = req;
    const { projectKey } = payload;
    const accountId = context.accountId;
    const cloudId = context.cloudId;  // Multi-tenancy: Get Jira Cloud ID from context

    try {
      const data = await fetchProjectAnalytics(accountId, cloudId, projectKey);
      return {
        success: true,
        data
      };
    } catch (error) {
      console.error('Error fetching project analytics:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });

  /**
   * Resolver for fetching team analytics for a project (Project Admin only)
   * Returns aggregated team time tracking WITHOUT individual screenshots
   */
  resolver.define('getProjectTeamAnalytics', async (req) => {
    const { payload, context } = req;
    const { projectKey, clientToday } = payload;
    const accountId = context.accountId;
    const cloudId = context.cloudId;

    try {
      const [adminCheck, projectPerms] = await Promise.all([
        isJiraAdmin(),
        checkUserPermissions(['ADMINISTER_PROJECTS'], projectKey)
      ]);
      const isProjectAdmin = projectPerms.permissions?.ADMINISTER_PROJECTS?.havePermission || false;
      if (!adminCheck && !isProjectAdmin) {
        return { success: false, error: 'Access denied: Project Admin or Jira Administrator required' };
      }
      const data = await fetchProjectTeamAnalytics(accountId, cloudId, projectKey, clientToday);
      return { success: true, data };
    } catch (error) {
      console.error('Error fetching team analytics:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * Resolver for fetching team day timeline (Project Admin only)
   * Returns screenshot timestamps for timeline visualization
   * Cost-efficient: uses indexed work_date column, minimal data transfer
   */
  resolver.define('getTeamDayTimeline', async (req) => {
    const { payload, context } = req;
    const { projectKey, date } = payload;
    const accountId = context.accountId;
    const cloudId = context.cloudId;

    try {
      const [adminCheck, projectPerms] = await Promise.all([
        isJiraAdmin(),
        checkUserPermissions(['ADMINISTER_PROJECTS'], projectKey)
      ]);
      const isProjectAdmin = projectPerms.permissions?.ADMINISTER_PROJECTS?.havePermission || false;
      if (!adminCheck && !isProjectAdmin) {
        return { success: false, error: 'Access denied: Project Admin or Jira Administrator required' };
      }
      const data = await fetchTeamDayTimeline(accountId, cloudId, projectKey, date);
      return { success: true, data };
    } catch (error) {
      console.error('Error fetching team day timeline:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * Resolver for fetching current user's own day timeline (Available to ALL users)
   * Returns the current user's screenshot timestamps for timeline visualization
   * Cost-efficient: uses indexed work_date column, minimal data transfer
   */
  resolver.define('getMyDayTimeline', async (req) => {
    const { payload, context } = req;
    const { date } = payload;
    const accountId = context.accountId;
    const cloudId = context.cloudId;

    try {
      const data = await fetchMyDayTimeline(accountId, cloudId, date);
      return {
        success: true,
        data
      };
    } catch (error) {
      console.error('Error fetching my day timeline:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });

  /**
   * Resolver for converting an idle block to a worklog
   * Available to ALL users - converts only the user's own idle blocks
   */
  resolver.define('convertIdleToWorklog', async (req) => {
    const { payload, context } = req;
    const { idleRecordId, issueKey, reason } = payload;
    const accountId = context.accountId;
    const cloudId = context.cloudId;

    try {
      const data = await convertIdleToWorklog(accountId, cloudId, idleRecordId, issueKey, reason);
      return { success: true, data };
    } catch (error) {
      console.error('Error converting idle to worklog:', error);
      return { success: false, error: error.message };
    }
  });
}
