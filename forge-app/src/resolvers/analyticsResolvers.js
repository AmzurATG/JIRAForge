/**
 * Analytics Resolvers
 * Resolver definitions for time analytics endpoints
 */

import { fetchTimeAnalytics, fetchTimeAnalyticsBatch, fetchAllAnalytics, fetchProjectAnalytics, fetchProjectTeamAnalytics, fetchTeamDayTimeline, fetchMyDayTimeline, convertIdleToWorklog, fetchMemberDayDetails, fetchMemberWeekDetails, fetchMemberMonthDetails, generateTeamExportData, generateTeamExportDataStructured } from '../services/analyticsService.js';
import { isJiraAdmin, checkUserPermissions, createJiraIssue, getIssueTransitions, transitionIssue, createJiraWorklog } from '../utils/jira.js';

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
    const { payload, context } = req;
    const accountId = context.accountId;
    const cloudId = context.cloudId;  // Multi-tenancy: Get Jira Cloud ID from context
    const clientToday = payload?.clientToday;

    try {
      // Use batch API for improved performance (reduces API calls from 8+ to 1)
      const data = USE_BATCH_API 
        ? await fetchTimeAnalyticsBatch(accountId, cloudId, clientToday)
        : await fetchTimeAnalytics(accountId, cloudId, clientToday);
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
      const perms = await checkUserPermissions(['ADMINISTER', 'ADMINISTER_PROJECTS'], projectKey);
      const adminCheck = perms.permissions?.ADMINISTER?.havePermission || false;
      const isProjectAdmin = perms.permissions?.ADMINISTER_PROJECTS?.havePermission || false;
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
      const perms = await checkUserPermissions(['ADMINISTER', 'ADMINISTER_PROJECTS'], projectKey);
      const adminCheck = perms.permissions?.ADMINISTER?.havePermission || false;
      const isProjectAdmin = perms.permissions?.ADMINISTER_PROJECTS?.havePermission || false;
      if (!adminCheck && !isProjectAdmin) {
        return { success: false, error: 'Access denied: Project Admin or Jira Administrator required' };
      }
      const data = await fetchTeamDayTimeline(accountId, cloudId, projectKey, date, { isAdmin: adminCheck, isProjectAdmin });
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
    const { idleRecordId, issueKey: existingIssueKey, reason, createNewIssue, issueSummary } = payload;
    const accountId = context.accountId;
    const cloudId = context.cloudId;

    try {
      let issueKey = existingIssueKey;

      // If creating a new issue, do it here (Forge API must run in resolver context)
      if (createNewIssue && !issueKey) {
        // Determine project key from the idle record's project or fall back
        const { getIdleRecordProjectKey } = await import('../services/analyticsService.js');
        const projectKey = await getIdleRecordProjectKey(accountId, cloudId, idleRecordId);
        if (!projectKey) {
          throw new Error('Cannot determine project for new issue. Please use "Existing Issue" instead.');
        }

        const newIssue = await createJiraIssue(projectKey, {
          summary: issueSummary || reason || 'Idle time worklog',
          issuetype: { name: 'Task' },
          assignee: { accountId },
          labels: ['idle-time-converted']
        });
        if (!newIssue || !newIssue.key) {
          throw new Error('Failed to create Jira issue');
        }
        issueKey = newIssue.key;

        // Transition the new issue to "In Progress"
        try {
          const transitions = await getIssueTransitions(issueKey);
          const inProgressTransition = transitions.find(t =>
            t.to?.name?.toLowerCase() === 'in progress'
          );
          if (inProgressTransition) {
            await transitionIssue(issueKey, inProgressTransition.id);
          }
        } catch (transErr) {
          console.warn(`[IdleConvert] Could not transition ${issueKey} to In Progress:`, transErr.message);
        }
      }

      if (!issueKey) {
        throw new Error('Issue key is required');
      }

      const data = await convertIdleToWorklog(accountId, cloudId, idleRecordId, issueKey, reason);

      // Add a Jira worklog to the issue so the time appears on the board
      try {
        if (data.durationSeconds && data.durationSeconds > 0) {
          const startedAt = data.idleStartTime || new Date().toISOString();
          await createJiraWorklog(issueKey, data.durationSeconds, startedAt);
        }
      } catch (wlErr) {
        console.warn(`[IdleConvert] Worklog created in DB but Jira worklog failed for ${issueKey}:`, wlErr.message);
      }

      return { success: true, data };
    } catch (error) {
      console.error('Error converting idle to worklog:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * Resolver for fetching member day details
   * Shows issues worked on a specific day by a team member
   */
  resolver.define('getMemberDayDetails', async (req) => {
    const { payload, context } = req;
    const { projectKey, userId, date } = payload;
    const accountId = context.accountId;
    const cloudId = context.cloudId;

    try {
      // Verify admin or project admin permissions
      const perms = await checkUserPermissions(['ADMINISTER', 'ADMINISTER_PROJECTS'], projectKey);
      const adminCheck = perms.permissions?.ADMINISTER?.havePermission || false;
      const isProjectAdmin = perms.permissions?.ADMINISTER_PROJECTS?.havePermission || false;

      if (!adminCheck && !isProjectAdmin) {
        return { success: false, error: 'Access denied: Project Admin or Jira Administrator required' };
      }

      const data = await fetchMemberDayDetails(accountId, cloudId, projectKey, userId, date);
      return { success: true, data };
    } catch (error) {
      console.error('Error fetching member day details:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * Resolver for fetching member week details
   * Shows day-by-day breakdown for a week for a team member
   */
  resolver.define('getMemberWeekDetails', async (req) => {
    const { payload, context } = req;
    const { projectKey, userId, weekStartDate } = payload;
    const accountId = context.accountId;
    const cloudId = context.cloudId;

    try {
      // Verify admin or project admin permissions
      const perms = await checkUserPermissions(['ADMINISTER', 'ADMINISTER_PROJECTS'], projectKey);
      const adminCheck = perms.permissions?.ADMINISTER?.havePermission || false;
      const isProjectAdmin = perms.permissions?.ADMINISTER_PROJECTS?.havePermission || false;

      if (!adminCheck && !isProjectAdmin) {
        return { success: false, error: 'Access denied: Project Admin or Jira Administrator required' };
      }

      const data = await fetchMemberWeekDetails(accountId, cloudId, projectKey, userId, weekStartDate);
      return { success: true, data };
    } catch (error) {
      console.error('Error fetching member week details:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * Resolver for fetching member month details
   * Shows week-by-week and day-by-day breakdown for a month for a team member
   */
  resolver.define('getMemberMonthDetails', async (req) => {
    const { payload, context } = req;
    const { projectKey, userId, month } = payload;
    const accountId = context.accountId;
    const cloudId = context.cloudId;

    try {
      // Verify admin or project admin permissions
      const perms = await checkUserPermissions(['ADMINISTER', 'ADMINISTER_PROJECTS'], projectKey);
      const adminCheck = perms.permissions?.ADMINISTER?.havePermission || false;
      const isProjectAdmin = perms.permissions?.ADMINISTER_PROJECTS?.havePermission || false;

      if (!adminCheck && !isProjectAdmin) {
        return { success: false, error: 'Access denied: Project Admin or Jira Administrator required' };
      }

      const data = await fetchMemberMonthDetails(accountId, cloudId, projectKey, userId, month);
      return { success: true, data };
    } catch (error) {
      console.error('Error fetching member month details:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * Resolver for exporting team analytics
   * Generates CSV data for download - supports multiple projects
   */
  resolver.define('exportTeamAnalytics', async (req) => {
    const { payload, context } = req;
    const { projectKey, projectKeys, startDate, endDate, format, filterUserIds } = payload;
    const accountId = context.accountId;
    const cloudId = context.cloudId;

    // Support both single projectKey (backward compat) and projectKeys array
    const keys = projectKeys && projectKeys.length > 0 ? projectKeys : (projectKey ? [projectKey] : []);

    try {
      // Verify admin permissions (check against first project, Jira admins have global access)
      const perms = await checkUserPermissions(['ADMINISTER', 'ADMINISTER_PROJECTS'], keys[0] || null);
      const adminCheck = perms.permissions?.ADMINISTER?.havePermission || false;
      const isProjectAdmin = perms.permissions?.ADMINISTER_PROJECTS?.havePermission || false;

      if (!adminCheck && !isProjectAdmin) {
        return { success: false, error: 'Access denied: Project Admin or Jira Administrator required' };
      }

      if (keys.length <= 1) {
        // Single project - original behavior
        const data = await generateTeamExportData(accountId, cloudId, keys[0] || null, startDate, endDate, filterUserIds || null);
        return { 
          success: true, 
          data,
          format: format || 'csv',
          filename: `team-analytics-${keys[0] || 'all'}-${endDate}.csv`
        };
      }

      // Multi-project: generate CSV with project sections
      let allCsvData = '';
      for (const pk of keys) {
        const data = await generateTeamExportData(accountId, cloudId, pk, startDate, endDate, filterUserIds || null);
        if (allCsvData) allCsvData += '\n\n';
        allCsvData += data;
      }

      const projectLabel = keys.length > 1 ? `${keys.length}-projects` : keys[0];
      return { 
        success: true, 
        data: allCsvData,
        format: format || 'csv',
        filename: `team-analytics-${projectLabel}-${endDate}.csv`
      };
    } catch (error) {
      console.error('Error exporting team analytics:', error);
      return { success: false, error: error.message };
    }
  });

  resolver.define('exportTeamAnalyticsExcel', async (req) => {
    const { payload, context } = req;
    const { projectKey, projectKeys, startDate, endDate, filterUserIds } = payload;
    const accountId = context.accountId;
    const cloudId = context.cloudId;

    // Support both single projectKey (backward compat) and projectKeys array
    const keys = projectKeys && projectKeys.length > 0 ? projectKeys : (projectKey ? [projectKey] : []);

    try {
      const perms = await checkUserPermissions(['ADMINISTER', 'ADMINISTER_PROJECTS'], keys[0] || null);
      const adminCheck = perms.permissions?.ADMINISTER?.havePermission || false;
      const isProjectAdmin = perms.permissions?.ADMINISTER_PROJECTS?.havePermission || false;

      if (!adminCheck && !isProjectAdmin) {
        return { success: false, error: 'Access denied: Project Admin or Jira Administrator required' };
      }

      if (keys.length <= 1) {
        // Single project - original behavior
        const data = await generateTeamExportDataStructured(accountId, cloudId, keys[0] || null, startDate, endDate, filterUserIds || null);
        return { success: true, data };
      }

      // Multi-project: gather data for each project
      const projectsData = [];
      for (const pk of keys) {
        const data = await generateTeamExportDataStructured(accountId, cloudId, pk, startDate, endDate, filterUserIds || null);
        projectsData.push(data);
      }

      return { 
        success: true, 
        data: {
          isMultiProject: true,
          projects: projectsData
        }
      };
    } catch (error) {
      console.error('Error exporting team analytics (Excel):', error);
      return { success: false, error: error.message };
    }
  });
}
