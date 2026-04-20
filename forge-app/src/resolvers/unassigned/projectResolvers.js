/**
 * Project Resolvers for Unassigned Work
 * Handles fetching projects, issues, and statuses for assignment dropdowns
 */

import api, { route } from '@forge/api';
import { getAllUserAssignedIssues as getAllUserAssignedIssuesUtil, formatIssuesData } from '../../utils/jira.js';

/**
 * Get user's projects (for create issue dropdown)
 */
export async function getUserProjects(req) {
  const t0 = Date.now();
  try {
    const response = await api.asUser().requestJira(
      route`/rest/api/3/project`,
      { method: 'GET' }
    );

    if (!response.ok) {
      throw new Error('Failed to fetch projects');
    }

    const projects = await response.json();

    const result = {
      success: true,
      projects: projects.map(p => ({
        key: p.key,
        name: p.name,
        id: p.id
      }))
    };
    console.log(`[UnassignedResolver] getUserProjects took ${Date.now() - t0}ms`);
    return result;

  } catch (error) {
    console.error('Error getting user projects:', error);
    return { success: false, error: error.message };
  }
}

/**
 * Get ALL user's assigned issues (for assign to existing issue dropdown)
 * Returns all issues regardless of status
 */
export async function getAllUserAssignedIssues(req) {
  const t0 = Date.now();
  try {
    const jiraData = await getAllUserAssignedIssuesUtil(50); // Max 50 issues for dropdown

    const result = {
      success: true,
      issues: formatIssuesData(jiraData.issues || []).map(issue => ({
        key: issue.key,
        summary: issue.summary,
        status: issue.status
      }))
    };
    console.log(`[UnassignedResolver] getAllUserAssignedIssues took ${Date.now() - t0}ms`);
    return result;

  } catch (error) {
    console.error('Error getting all user assigned issues:', error);
    return {
      success: false,
      error: error.message,
      issues: []
    };
  }
}

/**
 * Get available statuses for a project (for create issue dropdown)
 */
export async function getProjectStatuses(req) {
  const t0 = Date.now();
  try {
    const { projectKey } = req.payload;

    if (!projectKey) {
      return { success: false, error: 'Project key required' };
    }

    // Get available statuses for this project
    const statusResponse = await api.asUser().requestJira(
      route`/rest/api/3/project/${projectKey}/statuses`,
      { method: 'GET' }
    );

    if (!statusResponse.ok) {
      // Fallback: return common statuses
      return {
        success: true,
        statuses: [
          { name: 'To Do', id: '1' },
          { name: 'In Progress', id: '3' },
          { name: 'Done', id: '10001' }
        ]
      };
    }

    const statusesData = await statusResponse.json();

    // Extract unique statuses from all issue types
    const statusMap = new Map();
    statusesData.forEach(issueTypeStatus => {
      issueTypeStatus.statuses.forEach(status => {
        if (!statusMap.has(status.name)) {
          statusMap.set(status.name, {
            name: status.name,
            id: status.id
          });
        }
      });
    });

    const result = {
      success: true,
      statuses: Array.from(statusMap.values())
    };
    console.log(`[UnassignedResolver] getProjectStatuses took ${Date.now() - t0}ms`);
    return result;

  } catch (error) {
    console.error('Error getting project statuses:', error);
    // Return common statuses as fallback
    return {
      success: true,
      statuses: [
        { name: 'To Do', id: '1' },
        { name: 'In Progress', id: '3' },
        { name: 'Done', id: '10001' }
      ]
    };
  }
}

/**
 * Register project resolvers
 */
export function registerProjectResolvers(resolver) {
  resolver.define('getUserProjects', getUserProjects);
  resolver.define('getAllUserAssignedIssues', getAllUserAssignedIssues);
  resolver.define('getProjectStatuses', getProjectStatuses);
}
