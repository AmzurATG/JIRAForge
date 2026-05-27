/**
 * Analytics Resolvers
 * Resolver definitions for time analytics endpoints
 */

import { fetchTimeAnalytics, fetchTimeAnalyticsBatch, fetchAllAnalytics, fetchProjectAnalytics, fetchProjectTeamAnalytics, fetchTeamDayTimeline, fetchMyDayTimeline, fetchMyDayIssueBreakdown, convertIdleToWorklog, fetchMemberDayDetails, fetchMemberWeekDetails, fetchMemberMonthDetails, generateTeamExportData, generateTeamExportDataStructured } from '../services/analyticsService.js';
import { isJiraAdmin, checkUserPermissions, createJiraIssue, getIssueTransitions, transitionIssue, createJiraWorklog, textToADF } from '../utils/jira.js';
import { getDailyWorkTotal, getWeeklyWorkTotal, getOrCreateOrganization, getOrCreateUser } from '../utils/remote.js';

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
      // Pass resolved permissions into the service so it doesn't repeat the Jira API call.
      const data = await fetchProjectTeamAnalytics(accountId, cloudId, projectKey, clientToday, {
        isAdmin: adminCheck,
        hasPermission: isProjectAdmin
      });
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
   * Resolver for fetching current user's issue-level details for a specific day
   * Available to ALL users - returns only the caller's own data
   */
  resolver.define('getMyDayIssueBreakdown', async (req) => {
    const { payload, context } = req;
    const { date } = payload;
    const accountId = context.accountId;
    const cloudId = context.cloudId;

    try {
      const data = await fetchMyDayIssueBreakdown(accountId, cloudId, date);
      return {
        success: true,
        data
      };
    } catch (error) {
      console.error('Error fetching my day issue breakdown:', error);
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
    const { idleRecordId, issueKey: existingIssueKey, reason, createNewIssue, issueSummary, projectKey: frontendProjectKey } = payload;
    const accountId = context.accountId;
    const cloudId = context.cloudId;

    try {
      let issueKey = existingIssueKey;

      // If creating a new issue, do it here (Forge API must run in resolver context)
      if (createNewIssue && !issueKey) {
        // Use the project key from the frontend (the project the user is viewing)
        // and fall back to the idle record's stored project key
        let projectKey = frontendProjectKey;
        if (!projectKey) {
          const { getIdleRecordProjectKey } = await import('../services/analyticsService.js');
          projectKey = await getIdleRecordProjectKey(accountId, cloudId, idleRecordId);
        }
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
   * Resolver for converting unassigned work sessions to a Jira issue
   * Supports both "assign to existing issue" and "create new issue" modes
   * Handles group membership cleanup and worklog creation
   */
  resolver.define('convertUnassignedToWorklog', async (req) => {
    const { payload, context } = req;
    const { sessionIds, issueKey: existingIssueKey, createNewIssue, newIssueSummary, newIssueDescription, projectKey: frontendProjectKey, conversionReason } = payload;
    const accountId = context.accountId;
    const cloudId = context.cloudId;
    let createdIssueKey = null;

    try {
      let issueKey = existingIssueKey;

      // If creating a new issue, do it here (Forge API context required)
      if (createNewIssue && !issueKey) {
        if (!frontendProjectKey) {
          throw new Error('Project key is required for creating a new issue');
        }

        const newIssue = await createJiraIssue(frontendProjectKey, {
          summary: newIssueSummary || 'Unassigned work - Auto-created',
            description: textToADF(newIssueDescription || 'Work sessions converted from unassigned time'),
          issuetype: { name: 'Task' },
          assignee: { accountId },
          labels: ['unassigned-work-converted']
        });

        if (!newIssue || !newIssue.key) {
          throw new Error('Failed to create Jira issue');
        }
        issueKey = newIssue.key;
        createdIssueKey = issueKey;

        // Transition the new issue to "In Progress"
        try {
          const transitions = await getIssueTransitions(issueKey);
          const inProgressTransition = transitions.find(t =>
            t.to?.name?.toLowerCase() === 'in progress'
          );
          if (inProgressTransition) {
            await transitionIssue(issueKey, inProgressTransition.id);
            console.log(`[UnassignedConvert] Transitioned ${issueKey} to In Progress`);
          }
        } catch (transErr) {
          console.warn(`[UnassignedConvert] Could not transition ${issueKey} to In Progress:`, transErr.message);
        }
      }

      if (!issueKey) {
        throw new Error('Issue key is required');
      }

      // Service layer handles: activity record updates, group cleanup, aggregate recalculation
      const { convertUnassignedToWorklog } = await import('../services/analyticsService.js');
      const data = await convertUnassignedToWorklog(accountId, cloudId, sessionIds, {
        existingIssueKey: issueKey,
        conversionReason
      });

      // Handle worklog creation
      try {
        if (data.totalSeconds && data.totalSeconds > 0) {
          const { createWorklogIfNeeded, isAutoSyncEnabled } = await import('../services/workAssignmentService.js');
          const autoSyncEnabled = await isAutoSyncEnabled(accountId, cloudId);

          // Build worklog comment with reason if provided
          let customComment = `Time tracked from ${data.sessionCount} unassigned work session(s), manually assigned.`;
          if (data.conversionReason) {
            customComment += ` Reason: ${data.conversionReason}`;
          }

          const worklogResult = await createWorklogIfNeeded({
            issueKey,
            timeToLog: data.totalSeconds,
            sessionCount: data.sessionCount,
            autoSyncEnabled,
            customComment
          });

          console.log(`[UnassignedConvert] Worklog: ${worklogResult.worklogSkipped ? 'SKIPPED (' + worklogResult.worklogSkippedReason + ')' : 'CREATED'}`);
          data.worklogInfo = worklogResult;
        }
      } catch (wlErr) {
        console.warn(`[UnassignedConvert] Worklog creation failed for ${issueKey}:`, wlErr.message);
        // Don't fail the whole conversion if worklog fails
      }

      return {
        success: true,
        data: {
          ...data,
          issueKey,
          createdIssueKey,
          createdNewIssue: !!createdIssueKey
        }
      };
    } catch (error) {
      console.error('Error converting unassigned to worklog:', error);
      return {
        success: false,
        error: error.message,
        createdIssueKey
      };
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
   * Resolver for fetching conversion recommendation for unassigned sessions
   * Returns group suggestion if all sessions belong to a single group
   */
  resolver.define('getUnassignedConversionRecommendation', async (req) => {
    const { payload, context } = req;
    const { sessionIds } = payload;
    const accountId = context.accountId;
    const cloudId = context.cloudId;

    try {
      const { getUnassignedConversionRecommendation } = await import('../services/analyticsService.js');
      const recommendation = await getUnassignedConversionRecommendation(accountId, cloudId, sessionIds);
      return { success: true, data: recommendation };
    } catch (error) {
      console.error('Error fetching unassigned conversion recommendation:', error);
      return { success: true, data: null }; // Return null recommendation instead of error
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
   * Authorize an export request: caller must be a global Jira admin OR
   * a project admin on EVERY selected project. Returns null if authorized,
   * or an error response object if denied.
   */
  async function authorizeExport(keys) {
    if (!keys || keys.length === 0) {
      return { success: false, error: 'At least one project must be selected' };
    }
    // First, check global admin once (cheap) — if true, no per-project checks needed.
    const globalCheck = await checkUserPermissions(['ADMINISTER'], keys[0]);
    if (globalCheck.permissions?.ADMINISTER?.havePermission) {
      return null;
    }
    // Otherwise require ADMINISTER_PROJECTS on every selected project (parallel).
    const projectChecks = await Promise.all(
      keys.map(k => checkUserPermissions(['ADMINISTER_PROJECTS'], k))
    );
    const hasAdminOnAll = projectChecks.every(p =>
      p.permissions?.ADMINISTER_PROJECTS?.havePermission || false
    );
    if (!hasAdminOnAll) {
      return { success: false, error: 'Access denied: Project Admin or Jira Administrator required on every selected project' };
    }
    return null;
  }

  /**
   * Build the synthetic "Unassigned (All Projects)" member list by unioning
   * teamMemberActivity across the selected projects. A user active in N projects
   * contributes one entry.
   *
   * Unassigned seconds (today/week/month) come from `project_key IS NULL` queries,
   * which are user-org-wide — every project's copy carries the same value, so
   * picking any project's row is fine.
   *
   * The returned member shape uses `monthSeconds = monthUnassignedSeconds` etc.
   * so the export generator's "This Month" column reflects the unassigned total,
   * and so the `member.monthHours > 0` activeMembers filter inside the generator
   * works correctly.
   */
  function unionMembersForUnassignedSection(teamMembersByProject, filterUserIds) {
    const memberMap = new Map();
    for (const memberList of teamMembersByProject) {
      for (const m of (memberList || [])) {
        if (!m.userId || memberMap.has(m.userId)) continue;
        if (filterUserIds && filterUserIds.length > 0 && !filterUserIds.includes(m.userId)) continue;
        memberMap.set(m.userId, {
          userId: m.userId,
          displayName: m.displayName,
          todayHours: Math.round((m.todayUnassignedSeconds || 0) / 3600 * 10) / 10,
          weekHours: Math.round((m.weekUnassignedSeconds || 0) / 3600 * 10) / 10,
          monthHours: Math.round((m.monthUnassignedSeconds || 0) / 3600 * 10) / 10,
          todaySeconds: m.todayUnassignedSeconds || 0,
          weekSeconds: m.weekUnassignedSeconds || 0,
          monthSeconds: m.monthUnassignedSeconds || 0,
          todayUnassignedSeconds: m.todayUnassignedSeconds || 0,
          weekUnassignedSeconds: m.weekUnassignedSeconds || 0,
          monthUnassignedSeconds: m.monthUnassignedSeconds || 0,
          todayNonProductiveSeconds: 0,
          weekNonProductiveSeconds: 0,
          monthNonProductiveSeconds: 0,
        });
      }
    }
    return Array.from(memberMap.values());
  }

  /**
   * For a multi-project export, run per-project generators in parallel AND collect
   * the team-member rosters needed to build the synthetic Unassigned section.
   *
   * The per-project call inside `runProject` invokes `fetchProjectTeamAnalytics`
   * internally (which caches under `cloudId:projectKey:endDate`). The pre-fetch
   * below hits the same cache key so it's effectively free after the first call,
   * but it gives the resolver direct access to the un-stripped member rows.
   *
   * @param {string} accountId
   * @param {string} cloudId
   * @param {string[]} keys
   * @param {string} endDate
   * @param {(pk: string, mode: string) => Promise<any>} runProject
   * @returns {Promise<{projectsData: any[], teamMembersByProject: any[][]}>}
   */
  async function buildMultiProjectExport(accountId, cloudId, keys, endDate, runProject) {
    // Fire per-project generators and a parallel cache-warming/membership read.
    // Both depend on fetchProjectTeamAnalytics with the same key, so only one
    // network round trip is paid per project.
    const [projectsData, teamMembersByProject] = await Promise.all([
      Promise.all(keys.map(pk => runProject(pk, 'projectOnly'))),
      Promise.all(keys.map(pk =>
        fetchProjectTeamAnalytics(accountId, cloudId, pk, endDate)
          .then(t => t.teamMemberActivity || [])
          .catch(err => {
            console.warn(`[ExportUnassignedUnion] fetchProjectTeamAnalytics failed for ${pk}:`, err.message);
            return [];
          })
      )),
    ]);
    return { projectsData, teamMembersByProject };
  }

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
      const denied = await authorizeExport(keys);
      if (denied) return denied;

      if (keys.length === 1) {
        const data = await generateTeamExportData(accountId, cloudId, keys[0], startDate, endDate, filterUserIds || null);
        return {
          success: true,
          data,
          format: format || 'csv',
          filename: `team-analytics-${keys[0]}-${endDate}.csv`
        };
      }

      // Multi-project: per-project sections exclude NULL-project_key records, and we
      // append one synthetic "Unassigned (All Projects)" section so the same record
      // is never counted in multiple project sections (fixes Bug 1 — Grand Totals
      // inflation from duplicated Unassigned).
      const runProject = (pk, mode) =>
        generateTeamExportData(accountId, cloudId, pk, startDate, endDate, filterUserIds || null, { mode });

      const { projectsData, teamMembersByProject } = await buildMultiProjectExport(
        accountId, cloudId, keys, endDate, runProject
      );

      const unassignedMembers = unionMembersForUnassignedSection(teamMembersByProject, filterUserIds)
        .filter(m => m.monthHours > 0);

      let allCsvData = projectsData.join('\n\n');

      if (unassignedMembers.length > 0) {
        const unassignedCsv = await generateTeamExportData(
          accountId, cloudId, null, startDate, endDate, filterUserIds || null,
          {
            mode: 'unassignedOnly',
            presetMembers: unassignedMembers,
            displayProjectKey: 'Unassigned (All Projects)'
          }
        );
        allCsvData += '\n\n' + unassignedCsv;
      }

      const projectLabel = `${keys.length}-projects`;
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
      const denied = await authorizeExport(keys);
      if (denied) return denied;

      if (keys.length === 1) {
        const data = await generateTeamExportDataStructured(accountId, cloudId, keys[0], startDate, endDate, filterUserIds || null);
        return { success: true, data };
      }

      // Multi-project: per-project sections exclude NULL-project_key records, and we
      // append one synthetic "Unassigned (All Projects)" section so the same record
      // is never counted in multiple project sections (fixes Bug 1 — Grand Totals
      // inflation from duplicated Unassigned).
      const runProject = (pk, mode) =>
        generateTeamExportDataStructured(accountId, cloudId, pk, startDate, endDate, filterUserIds || null, { mode });

      const { projectsData, teamMembersByProject } = await buildMultiProjectExport(
        accountId, cloudId, keys, endDate, runProject
      );

      const unassignedMembers = unionMembersForUnassignedSection(teamMembersByProject, filterUserIds)
        .filter(m => m.monthHours > 0);

      const allProjects = [...projectsData];
      if (unassignedMembers.length > 0) {
        const unassignedData = await generateTeamExportDataStructured(
          accountId, cloudId, null, startDate, endDate, filterUserIds || null,
          {
            mode: 'unassignedOnly',
            presetMembers: unassignedMembers,
            displayProjectKey: 'Unassigned (All Projects)'
          }
        );
        allProjects.push(unassignedData);
      }

      return {
        success: true,
        data: {
          isMultiProject: true,
          projects: allProjects
        }
      };
    } catch (error) {
      console.error('Error exporting team analytics (Excel):', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * Resolver for fetching worklog summary (unified aggregation service)
   * 
   * AC4 & AC8: Uses unified aggregation service to ensure consistency across all surfaces.
   * Returns same value as dashboard, issue panel, and other surfaces.
   */
  resolver.define('getWorklogSummary', async (req) => {
    const { payload, context } = req;
    const { date, timezone, period } = payload;
    const accountId = context.accountId;
    const cloudId = context.cloudId;

    try {
      // Get or create organization and user
      const organization = await getOrCreateOrganization(cloudId);
      if (!organization) {
        return { success: false, error: 'Unable to get organization information' };
      }

      const userId = await getOrCreateUser(accountId, organization.id);
      if (!userId) {
        return { success: false, error: 'Unable to get user information' };
      }

      // Call unified aggregation service
      if (period === 'weekly') {
        const data = await getWeeklyWorkTotal(
          organization.id,
          userId,
          date, // week_start date
          timezone || 'UTC'
        );
        return { success: true, data };
      } else {
        // Default to daily
        const data = await getDailyWorkTotal(
          organization.id,
          userId,
          date,
          timezone || 'UTC'
        );
        return { success: true, data };
      }
    } catch (error) {
      console.error('Error fetching worklog summary:', error);
      return { success: false, error: error.message };
    }
  });
}
