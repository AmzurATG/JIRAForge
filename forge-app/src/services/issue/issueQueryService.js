/**
 * Issue Query Service
 * Handles fetching and querying Jira issues
 */

import { getUserAssignedIssues, getAllUserAssignedIssues, formatIssuesData } from '../../utils/jira.js';
import { getSupabaseConfig, getOrCreateUser, getOrCreateOrganization, supabaseRequest } from '../../utils/supabase.js';
import { JQL_ACTIVE_STATUSES } from '../../config/constants.js';

/**
 * Get user's assigned Jira issues
 * @param {string} accountId - Atlassian account ID
 * @returns {Promise<Object>} Issues data
 */
export async function getAssignedIssues(accountId) {
  const data = await getUserAssignedIssues(JQL_ACTIVE_STATUSES);

  // Format issues for AI analysis
  const issues = formatIssuesData(data.issues);

  return {
    issues,
    total: data.total || 0
  };
}

/**
 * Get user's active issues with time tracking data
 * Fetches assigned issues from Jira and enriches with time tracking from Supabase
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID for organization filtering
 * @returns {Promise<Object>} Issues with time tracking data
 */
export async function getActiveIssuesWithTime(accountId, cloudId) {
  // Fetch ALL assigned issues from Jira (regardless of status)
  const jiraData = await getAllUserAssignedIssues();
  console.log('[BACKEND] Jira returned issues:', jiraData.issues?.length || 0);
  const issues = jiraData.issues || [];

  // Get Supabase config to fetch time tracking data
  const supabaseConfig = await getSupabaseConfig(accountId);
  if (!supabaseConfig) {
    // If Supabase not configured, return issues without time tracking
    return {
      issues: formatIssuesWithoutTime(issues),
      total: issues.length
    };
  }

  // Get or create organization first (multi-tenancy)
  const organization = await getOrCreateOrganization(cloudId, supabaseConfig);
  if (!organization) {
    return {
      issues: formatIssuesWithoutTime(issues),
      total: issues.length
    };
  }

  // Get or create user record
  const userId = await getOrCreateUser(accountId, supabaseConfig, organization.id);
  if (!userId) {
    return {
      issues: formatIssuesWithoutTime(issues),
      total: issues.length
    };
  }

  // Fetch time tracking data for all issues using pagination
  const PAGE_SIZE = 1000;
  const allTimeTrackingData = [];
  let queryOffset = 0;

  while (true) {
    const page = await supabaseRequest(
      supabaseConfig,
      `analysis_results?user_id=eq.${userId}&organization_id=eq.${organization.id}&work_type=eq.office&active_task_key=not.is.null&select=id,screenshot_id,active_task_key,created_at,screenshots(id,timestamp,duration_seconds,storage_path,window_title,application_name,work_date)&order=created_at.desc&limit=${PAGE_SIZE}&offset=${queryOffset}`
    );

    if (!page || !Array.isArray(page) || page.length === 0) {
      break;
    }

    allTimeTrackingData.push(...page);
    queryOffset += page.length;

    if (page.length < PAGE_SIZE) {
      break;
    }

    // Safety limit to prevent infinite loops
    if (allTimeTrackingData.length > 50000) {
      console.warn(`[getActiveIssuesWithTime] Safety limit reached (50000 records) for user ${userId}`);
      break;
    }
  }

  console.log(`[getActiveIssuesWithTime] Fetched ${allTimeTrackingData.length} time tracking records for user ${userId}`);

  // Also fetch from activity_records (event-based tracking)
  // This captures time from the desktop app's interval-only mode
  const allActivityRecords = [];
  let activityOffset = 0;

  while (true) {
    const page = await supabaseRequest(
      supabaseConfig,
      `activity_records?user_id=eq.${userId}&organization_id=eq.${organization.id}&status=eq.analyzed&user_assigned_issue_key=not.is.null&select=id,user_assigned_issue_key,total_time_seconds,duration_seconds,start_time,end_time,work_date,window_title,application_name,classification,created_at&order=created_at.desc&limit=${PAGE_SIZE}&offset=${activityOffset}`
    );

    if (!page || !Array.isArray(page) || page.length === 0) {
      break;
    }

    allActivityRecords.push(...page);
    activityOffset += page.length;

    if (page.length < PAGE_SIZE) {
      break;
    }

    if (allActivityRecords.length > 50000) {
      console.warn(`[getActiveIssuesWithTime] Activity records safety limit reached for user ${userId}`);
      break;
    }
  }

  console.log(`[getActiveIssuesWithTime] Fetched ${allActivityRecords.length} activity records for user ${userId}`);

  // Aggregate time by issue key and build work sessions
  const timeByIssue = {};
  const lastWorkedByIssue = {};
  const sessionsByIssue = {};

  // Extend an existing session with a new entry (mutates lastSession in place)
  function extendExistingSession(lastSession, endTime, timeSpent, entry) {
    lastSession.endTime = endTime.toISOString();
    lastSession.duration += timeSpent;
    if (!lastSession.analysisResultIds) {
      lastSession.analysisResultIds = [];
    }
    lastSession.analysisResultIds.push(entry.id);
    if (!lastSession.screenshots) {
      lastSession.screenshots = [];
    }
    if (entry.screenshots) {
      lastSession.screenshots.push({
        id: entry.screenshots.id,
        timestamp: entry.screenshots.timestamp,
        storagePath: entry.screenshots.storage_path,
        windowTitle: entry.screenshots.window_title,
        applicationName: entry.screenshots.application_name
      });
    }
  }

  if (allTimeTrackingData.length > 0) {
    // Sort by screenshot timestamp ascending to build sessions chronologically
    const sortedData = allTimeTrackingData.sort((a, b) => {
      const timeA = a.screenshots?.timestamp || a.created_at;
      const timeB = b.screenshots?.timestamp || b.created_at;
      return new Date(timeA) - new Date(timeB);
    });

    sortedData.forEach(entry => {
      const issueKey = entry.active_task_key;

      // Initialize issue data
      if (!timeByIssue[issueKey]) {
        timeByIssue[issueKey] = 0;
        lastWorkedByIssue[issueKey] = entry.created_at;
        sessionsByIssue[issueKey] = [];
      }

      // Add to total time
      timeByIssue[issueKey] += entry.screenshots?.duration_seconds || 0;

      // Update last worked timestamp
      if (entry.created_at > lastWorkedByIssue[issueKey]) {
        lastWorkedByIssue[issueKey] = entry.created_at;
      }

      // Build sessions - group consecutive work periods
      const screenshotTimestamp = entry.screenshots?.timestamp || entry.created_at;
      const workTime = new Date(screenshotTimestamp);
      const timeSpent = entry.screenshots?.duration_seconds || 0;

      const endTime = workTime;
      const startTime = new Date(workTime.getTime() - (timeSpent * 1000));

      // Check if this entry belongs to an existing session (within 10 minutes gap)
      const sessions = sessionsByIssue[issueKey];
      let addedToSession = false;

      if (sessions.length > 0) {
        const lastSession = sessions[sessions.length - 1];
        const timeSinceLastSession = startTime - new Date(lastSession.endTime);

        // If within 10 minutes, extend the session
        if (timeSinceLastSession <= 10 * 60 * 1000) {
          extendExistingSession(lastSession, endTime, timeSpent, entry);
          addedToSession = true;
        }
      }

      // If not added to existing session, create new session
      if (!addedToSession) {
        const newSession = {
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          duration: timeSpent,
          date: entry.screenshots?.work_date || startTime.toISOString().split('T')[0],
          analysisResultIds: [entry.id],
          screenshots: []
        };
        if (entry.screenshots) {
          newSession.screenshots.push({
            id: entry.screenshots.id,
            timestamp: entry.screenshots.timestamp,
            storagePath: entry.screenshots.storage_path,
            windowTitle: entry.screenshots.window_title,
            applicationName: entry.screenshots.application_name
          });
        }
        sessions.push(newSession);
      }
    });
  }

  // Process activity records (event-based tracking from interval-only mode)
  if (allActivityRecords.length > 0) {
    // Sort by start_time ascending to build sessions chronologically
    const sortedActivityData = allActivityRecords.sort((a, b) => {
      const timeA = a.start_time || a.created_at;
      const timeB = b.start_time || b.created_at;
      return new Date(timeA) - new Date(timeB);
    });

    sortedActivityData.forEach(entry => {
      const issueKey = entry.user_assigned_issue_key;
      if (!issueKey) return;

      // Initialize issue data if not already set by screenshot-based tracking
      if (!timeByIssue[issueKey]) {
        timeByIssue[issueKey] = 0;
        lastWorkedByIssue[issueKey] = entry.created_at;
        sessionsByIssue[issueKey] = [];
      }

      // Add to total time (prefer total_time_seconds, fallback to duration_seconds)
      const timeSpent = entry.total_time_seconds || entry.duration_seconds || 0;
      timeByIssue[issueKey] += timeSpent;

      // Update last worked timestamp
      if (entry.created_at > lastWorkedByIssue[issueKey]) {
        lastWorkedByIssue[issueKey] = entry.created_at;
      }

      // Build sessions from activity records
      const startTime = entry.start_time ? new Date(entry.start_time) : new Date(entry.created_at);
      const endTime = entry.end_time ? new Date(entry.end_time) : new Date(startTime.getTime() + (timeSpent * 1000));

      // Check if this entry belongs to an existing session (within 10 minutes gap)
      const sessions = sessionsByIssue[issueKey];
      let addedToSession = false;

      if (sessions.length > 0) {
        const lastSession = sessions[sessions.length - 1];
        const timeSinceLastSession = startTime - new Date(lastSession.endTime);

        // If within 10 minutes, extend the session
        if (timeSinceLastSession <= 10 * 60 * 1000) {
          lastSession.endTime = endTime.toISOString();
          lastSession.duration += timeSpent;
          if (!lastSession.activityRecordIds) {
            lastSession.activityRecordIds = [];
          }
          lastSession.activityRecordIds.push(entry.id);
          addedToSession = true;
        }
      }

      // If not added to existing session, create new session
      if (!addedToSession) {
        const newSession = {
          startTime: startTime.toISOString(),
          endTime: endTime.toISOString(),
          duration: timeSpent,
          date: entry.work_date || startTime.toISOString().split('T')[0],
          activityRecordIds: [entry.id],
          screenshots: [],
          // Include app info for session display
          windowTitle: entry.window_title,
          applicationName: entry.application_name
        };
        sessions.push(newSession);
      }
    });
  }

  // Enrich issues with time tracking data and sessions
  const enrichedIssues = issues.map(issue => ({
    key: issue.key,
    summary: issue.fields.summary || '',
    status: issue.fields.status?.name || 'Unknown',
    statusCategory: issue.fields.status?.statusCategory?.key || 'new',
    priority: issue.fields.priority?.name || 'Medium',
    priorityIconUrl: issue.fields.priority?.iconUrl || '',
    issueType: issue.fields.issuetype?.name || 'Task',
    issueTypeIconUrl: issue.fields.issuetype?.iconUrl || '',
    projectKey: issue.fields.project?.key || '',
    timeTracked: timeByIssue[issue.key] || 0,
    lastWorkedOn: lastWorkedByIssue[issue.key] || null,
    sessions: sessionsByIssue[issue.key] || []
  }));

  // Sort issues: In Progress first, then other statuses, then Done
  const statusOrder = (status) => {
    const lowerStatus = (status || '').toLowerCase();
    if (lowerStatus === 'in progress') return 0;
    if (lowerStatus === 'done') return 2;
    return 1; // All other statuses (To Do, etc.) in the middle
  };

  enrichedIssues.sort((a, b) => {
    const statusDiff = statusOrder(a.status) - statusOrder(b.status);
    if (statusDiff !== 0) return statusDiff;
    // Secondary sort by time tracked (most time first) within same status
    return (b.timeTracked || 0) - (a.timeTracked || 0);
  });

  return {
    issues: enrichedIssues,
    total: enrichedIssues.length
  };
}

/**
 * Format issues without time tracking data
 * @param {Array} issues - Raw Jira issues
 * @returns {Array} Formatted issues
 */
function formatIssuesWithoutTime(issues) {
  return issues.map(issue => ({
    key: issue.key,
    summary: issue.fields.summary || '',
    status: issue.fields.status?.name || 'Unknown',
    statusCategory: issue.fields.status?.statusCategory?.key || 'new',
    priority: issue.fields.priority?.name || 'Medium',
    priorityIconUrl: issue.fields.priority?.iconUrl || '',
    issueType: issue.fields.issuetype?.name || 'Task',
    issueTypeIconUrl: issue.fields.issuetype?.iconUrl || '',
    projectKey: issue.fields.project?.key || '',
    timeTracked: 0,
    lastWorkedOn: null
  }));
}
