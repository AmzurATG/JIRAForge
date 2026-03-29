/**
 * Jira API utility functions
 * All Jira-related operations should go through these helpers
 */

import api, { route } from '@forge/api';
import { JQL_ACTIVE_STATUSES, MAX_JIRA_SEARCH_RESULTS } from '../config/constants.js';

/**
 * Build ADF comment for a worklog.
 * When displayName is provided (scheduled sync fallback), the comment reads
 * "Uploaded from Time Tracker — Iswarya Kolimalla" so the actual person is
 * identifiable even when the Jira worklog author shows as the app.
 * @param {string|null} displayName - User's display name (optional)
 */
function buildWorklogComment(displayName) {
  const text = displayName
    ? `Uploaded from Time Tracker — ${displayName}`
    : 'Uploaded from Time Tracker';
  return {
    type: 'doc',
    version: 1,
    content: [
      {
        type: 'paragraph',
        content: [{ type: 'text', text }]
      }
    ]
  };
}

/**
 * Get user's assigned issues from Jira
 * @param {Array<string>} statuses - Issue statuses to filter (default: In Progress)
 * @param {number} maxResults - Maximum number of results
 * @returns {Promise<Object>} Jira search response
 */
export async function getUserAssignedIssues(statuses = JQL_ACTIVE_STATUSES, maxResults = MAX_JIRA_SEARCH_RESULTS) {
  const jql = `assignee = currentUser() AND (status = "${statuses.join('" OR status = "')}")ORDER BY updated DESC`;

  const response = await api.asUser().requestJira(
    route`/rest/api/3/search/jql`,
    {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        jql: jql,
        maxResults: maxResults,
        fields: ['summary', 'status', 'project', 'issuetype', 'updated']
      })
    }
  );

  return response.json();
}

/**
 * Get ALL user's assigned issues from Jira (regardless of status)
 * Uses pagination to fetch all issues (Jira API returns max 50 per request)
 * @returns {Promise<Object>} Jira search response with all issues
 */
export async function getAllUserAssignedIssues() {
  // Fetch all non-Done assigned issues across ALL project types (software, service desk, business).
  // Avoid Sprint/dueDate/rank fields — these are software-only and return nothing for JSM/business projects.
  const jql = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
  const fields = ['summary', 'status', 'project', 'issuetype', 'priority', 'updated'];

  console.log('[JIRA API] Fetching issues with JQL:', jql);

  const allIssues = [];
  let nextPageToken = null;
  const pageSize = MAX_JIRA_SEARCH_RESULTS; // 50 per page

  while (true) {
    // Build request body — only include nextPageToken if we have one (not on first request)
    const requestBody = {
      jql,
      maxResults: pageSize,
      fields
    };
    if (nextPageToken) {
      requestBody.nextPageToken = nextPageToken;
    }

    const response = await api.asUser().requestJira(
      route`/rest/api/3/search/jql`,
      {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      console.error(`[JIRA API] Search failed with status ${response.status}: ${errorBody}`);
      // Return empty result instead of crashing — caller will see 0 issues
      return { issues: allIssues, total: allIssues.length };
    }

    const result = await response.json();
    const issues = result.issues || [];

    allIssues.push(...issues);

    console.log(`[JIRA API] Fetched ${issues.length} issues (${allIssues.length} total so far)`);

    // Stop when there's no nextPageToken (last page) or empty page
    if (issues.length === 0 || !result.nextPageToken) {
      break;
    }

    nextPageToken = result.nextPageToken;

    // Safety limit to prevent infinite loops
    if (allIssues.length > 500) {
      console.warn('[JIRA API] Safety limit reached (500 issues)');
      break;
    }
  }

  console.log(`[JIRA API] Total issues fetched: ${allIssues.length}`);
  return { issues: allIssues, total: allIssues.length };
}

/**
 * Create a new Jira issue
 * @param {string} projectKey - Jira project key
 * @param {Object} issueData - Issue data (summary, description, issuetype, etc.)
 * @returns {Promise<Object>} Created issue response
 */
export async function createJiraIssue(projectKey, issueData) {
  const response = await api.asUser().requestJira(
    route`/rest/api/3/issue`,
    {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        fields: {
          project: { key: projectKey },
          ...issueData
        }
      })
    }
  );

  return response.json();
}

/**
 * Create a worklog entry for a Jira issue
 * @param {string} issueKey - Jira issue key (e.g., PROJ-123)
 * @param {number} timeSpentSeconds - Time spent in seconds
 * @param {string} startedAt - ISO timestamp when work started
 * @returns {Promise<Object>} Created worklog response
 */
export async function createJiraWorklog(issueKey, timeSpentSeconds, startedAt) {
  // Jira requires minimum 60 seconds for worklogs — round up sub-minute values
  const effectiveSeconds = Math.max(timeSpentSeconds, 60);
  const response = await api.asUser().requestJira(
    route`/rest/api/3/issue/${issueKey}/worklog?adjustEstimate=leave`,
    {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        timeSpentSeconds: effectiveSeconds,
        started: startedAt,
        comment: buildWorklogComment(null)
      })
    }
  );

  return response.json();
}

/**
 * Delete a worklog entry for a Jira issue in the current user's interactive context.
 * Use this in resolvers (not scheduled triggers) where api.asUser() has the live session.
 * @param {string} issueKey - Jira issue key (e.g., PROJ-123)
 * @param {string} worklogId - Worklog ID to delete
 * @returns {Promise<Response>} Raw response (caller checks status)
 */
export async function deleteJiraWorklog(issueKey, worklogId) {
  const response = await api.asUser().requestJira(
    route`/rest/api/3/issue/${issueKey}/worklog/${worklogId}?adjustEstimate=leave`,
    {
      method: 'DELETE',
      headers: { 'Accept': 'application/json' }
    }
  );
  return response;
}

/**
 * Update an existing worklog entry for a Jira issue
 * @param {string} issueKey - Jira issue key (e.g., PROJ-123)
 * @param {string} worklogId - Existing worklog ID to update
 * @param {number} timeSpentSeconds - Updated time spent in seconds
 * @returns {Promise<Response>} Raw response (caller checks status)
 */
export async function updateJiraWorklog(issueKey, worklogId, timeSpentSeconds) {
  // Jira requires minimum 60 seconds for worklogs — round up sub-minute values
  const effectiveSeconds = Math.max(timeSpentSeconds, 60);
  const response = await api.asUser().requestJira(
    route`/rest/api/3/issue/${issueKey}/worklog/${worklogId}?adjustEstimate=leave`,
    {
      method: 'PUT',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ timeSpentSeconds: effectiveSeconds })
    }
  );
  return response;
}

/**
 * Create a worklog entry for a Jira issue as a specific user (offline impersonation).
 * Worklogs will appear with the user's name (e.g. "Gayatri Alluri") instead of the app.
 * Requires allowImpersonation: true on write:jira-work in manifest.
 * @param {string} accountId - Atlassian account ID of the user
 * @param {string} issueKey - Jira issue key (e.g., PROJ-123)
 * @param {number} timeSpentSeconds - Time spent in seconds
 * @param {string} startedAt - ISO timestamp when work started
 * @returns {Promise<Object>} Created worklog response
 */
export async function createJiraWorklogAsUser(accountId, issueKey, timeSpentSeconds, startedAt, displayName = null) {
  // Jira requires minimum 60 seconds for worklogs — round up sub-minute values
  const effectiveSeconds = Math.max(timeSpentSeconds, 60);
  const response = await api.asUser(accountId).requestJira(
    route`/rest/api/3/issue/${issueKey}/worklog?adjustEstimate=leave`,
    {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        timeSpentSeconds: effectiveSeconds,
        started: startedAt,
        comment: buildWorklogComment(displayName)
      })
    }
  );

  return response.json();
}

/**
 * Update an existing worklog entry as a specific user (offline impersonation).
 * @param {string} accountId - Atlassian account ID of the user
 * @param {string} issueKey - Jira issue key
 * @param {string} worklogId - Existing worklog ID to update
 * @param {number} timeSpentSeconds - Updated time spent in seconds
 * @returns {Promise<Response>} Raw response (caller checks status)
 */
export async function updateJiraWorklogAsUser(accountId, issueKey, worklogId, timeSpentSeconds) {
  // Jira requires minimum 60 seconds for worklogs — round up sub-minute values
  const effectiveSeconds = Math.max(timeSpentSeconds, 60);
  const response = await api.asUser(accountId).requestJira(
    route`/rest/api/3/issue/${issueKey}/worklog/${worklogId}?adjustEstimate=leave`,
    {
      method: 'PUT',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ timeSpentSeconds: effectiveSeconds })
    }
  );

  return response;
}

/**
 * Create a worklog entry for a Jira issue (as app — fallback when user impersonation unavailable)
 * @param {string} issueKey - Jira issue key (e.g., PROJ-123)
 * @param {number} timeSpentSeconds - Time spent in seconds
 * @param {string} startedAt - ISO timestamp when work started
 * @returns {Promise<Object>} Created worklog response
 */
export async function createJiraWorklogAsApp(issueKey, timeSpentSeconds, startedAt, displayName = null) {
  // Jira requires minimum 60 seconds for worklogs — round up sub-minute values
  const effectiveSeconds = Math.max(timeSpentSeconds, 60);
  const response = await api.asApp().requestJira(
    route`/rest/api/3/issue/${issueKey}/worklog?adjustEstimate=leave`,
    {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        timeSpentSeconds: effectiveSeconds,
        started: startedAt,
        comment: buildWorklogComment(displayName)
      })
    }
  );
  return response.json();
}

/**
 * Update an existing worklog entry (as app — for scheduled jobs)
 * @param {string} issueKey - Jira issue key (e.g., PROJ-123)
 * @param {string} worklogId - Existing worklog ID to update
 * @param {number} timeSpentSeconds - Updated time spent in seconds
 * @returns {Promise<Response>} Raw response (caller checks status)
 */
export async function updateJiraWorklogAsApp(issueKey, worklogId, timeSpentSeconds) {
  // Jira requires minimum 60 seconds for worklogs — round up sub-minute values
  const effectiveSeconds = Math.max(timeSpentSeconds, 60);
  const response = await api.asApp().requestJira(
    route`/rest/api/3/issue/${issueKey}/worklog/${worklogId}?adjustEstimate=leave`,
    {
      method: 'PUT',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ timeSpentSeconds: effectiveSeconds })
    }
  );
  return response;
}

/**
 * Delete a worklog as a specific user (offline impersonation).
 * Use when the worklog was created via createJiraWorklogAsUser.
 */
export async function deleteJiraWorklogAsUser(accountId, issueKey, worklogId) {
  const response = await api.asUser(accountId).requestJira(
    route`/rest/api/3/issue/${issueKey}/worklog/${worklogId}?adjustEstimate=leave`,
    {
      method: 'DELETE',
      headers: { 'Accept': 'application/json' }
    }
  );
  return response;
}

export async function deleteJiraWorklogAsApp(issueKey, worklogId) {
  const response = await api.asApp().requestJira(
    route`/rest/api/3/issue/${issueKey}/worklog/${worklogId}?adjustEstimate=leave`,
    {
      method: 'DELETE',
      headers: { 'Accept': 'application/json' }
    }
  );
  return response;
}

/**
 * Check if current user has specific Jira permissions
 * @param {Array<string>} permissions - Permission keys to check (e.g., ['ADMINISTER', 'CREATE_ISSUES'])
 * @param {string} projectKey - Optional project key for project-specific permissions
 * @returns {Promise<Object>} Permissions object with havePermission flags
 */
export async function checkUserPermissions(permissions, projectKey = null) {
  const permissionsParam = permissions.join(',');
  const endpoint = projectKey
    ? route`/rest/api/3/mypermissions?permissions=${permissionsParam}&projectKey=${projectKey}`
    : route`/rest/api/3/mypermissions?permissions=${permissionsParam}`;

  const response = await api.asUser().requestJira(endpoint, {
    method: 'GET',
    headers: {
      'Accept': 'application/json'
    }
  });

  return response.json();
}

/**
 * Check if current user is a Jira administrator
 * @returns {Promise<boolean>} True if user is Jira admin
 */
export async function isJiraAdmin() {
  try {
    const permissions = await checkUserPermissions(['ADMINISTER']);
    return permissions.permissions?.ADMINISTER?.havePermission || false;
  } catch (error) {
    console.error('Error checking admin status:', error);
    return false;
  }
}

/**
 * Get all Jira projects accessible to the current user
 * Uses pagination to fetch ALL projects (Jira API returns max 50 per request)
 * @returns {Promise<Array<Object>>} Array of project objects with key and name
 */
export async function getAllJiraProjects() {
  try {
    const allProjects = [];
    let startAt = 0;
      const maxResults = 50;
    let hasMore = true;

    while (hasMore) {
      const response = await api.asUser().requestJira(
        route`/rest/api/3/project/search?startAt=${startAt}&maxResults=${maxResults}`,
        {
          method: 'GET',
          headers: {
            'Accept': 'application/json'
          }
        }
      );

      const data = await response.json();
      const projects = data.values || [];

      if (Array.isArray(projects) && projects.length > 0) {
        allProjects.push(...projects);
        startAt += projects.length;
        hasMore = data.isLast === false || (data.total && startAt < data.total);
      } else {
        hasMore = false;
      }

      // Safety limit to prevent infinite loops
      if (startAt > 1000) {
        console.warn('[getAllJiraProjects] Safety limit reached (1000 projects)');
        break;
      }
    }

    console.log(`[getAllJiraProjects] Fetched ${allProjects.length} total projects`);
    return allProjects.map(p => ({
      key: p.key,
      name: p.name
    }));
  } catch (error) {
    console.error('Error fetching Jira projects:', error);
    return [];
  }
}

/**
 * Get all Jira project keys accessible to the current user
 * @returns {Promise<Set<string>>} Set of project keys
 */
export async function getAllJiraProjectKeys() {
  const projects = await getAllJiraProjects();
  return new Set(projects.map(p => p.key));
}

/**
 * Get list of projects where current user is a Project Administrator
 * Uses action=edit parameter to filter projects where user has ADMINISTER_PROJECTS
 * or ADMINISTER (Jira Admin) permission - much faster than checking each project
 * @returns {Promise<Array<string>>} Array of project keys
 */
export async function getProjectsUserAdmins() {
  try {
    const adminProjects = [];
    let startAt = 0;
    const maxResults = 50;
    let hasMore = true;

    while (hasMore) {
      // action=edit returns only projects where user has Administer Projects
      // or Administer Jira permission - no need for separate permission checks
      const response = await api.asUser().requestJira(
        route`/rest/api/3/project/search?action=edit&startAt=${startAt}&maxResults=${maxResults}`,
        {
          method: 'GET',
          headers: {
            'Accept': 'application/json'
          }
        }
      );

      const data = await response.json();
      const projects = data.values || [];

      if (Array.isArray(projects) && projects.length > 0) {
        adminProjects.push(...projects.map(p => p.key));
        startAt += projects.length;
        hasMore = data.isLast === false || (data.total && startAt < data.total);
      } else {
        hasMore = false;
      }

      // Safety limit to prevent infinite loops
      if (startAt > 500) {
        console.warn('[getProjectsUserAdmins] Safety limit reached (500 projects)');
        break;
      }
    }

    console.log(`[getProjectsUserAdmins] Found ${adminProjects.length} admin projects`);
    return adminProjects;
  } catch (error) {
    console.error('Error getting user admin projects:', error);
    return [];
  }
}

/**
 * Format issue data for consistent output
 * @param {Object} issue - Raw Jira issue object
 * @returns {Object} Formatted issue object
 */
export function formatIssueData(issue) {
  return {
    key: issue.key,
    summary: issue.fields?.summary || '',
    status: issue.fields?.status?.name || 'Unknown',
    project: issue.fields?.project?.key || '',
    issueType: issue.fields?.issuetype?.name || 'Task',
    updated: issue.fields?.updated || issue.fields?.created
  };
}

/**
 * Format multiple issues
 * @param {Array<Object>} issues - Array of raw Jira issues
 * @returns {Array<Object>} Array of formatted issues
 */
export function formatIssuesData(issues) {
  return (issues || []).map(formatIssueData);
}

/**
 * Get available transitions for a Jira issue
 * @param {string} issueKey - Jira issue key (e.g., PROJ-123)
 * @returns {Promise<Array>} Array of available transitions
 */
export async function getIssueTransitions(issueKey) {
  const response = await api.asUser().requestJira(
    route`/rest/api/3/issue/${issueKey}/transitions`,
    {
      method: 'GET',
      headers: {
        'Accept': 'application/json'
      }
    }
  );

  const data = await response.json();
  return data.transitions || [];
}

/**
 * Transition a Jira issue to a new status
 * @param {string} issueKey - Jira issue key (e.g., PROJ-123)
 * @param {string} transitionId - Transition ID to execute
 * @returns {Promise<Object>} Transition response
 */
export async function transitionIssue(issueKey, transitionId) {
  const response = await api.asUser().requestJira(
    route`/rest/api/3/issue/${issueKey}/transitions`,
    {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        transition: {
          id: transitionId
        }
      })
    }
  );

  if (response.status === 204) {
    // Success - 204 No Content is expected response
    return { success: true };
  }

  return response.json();
}
