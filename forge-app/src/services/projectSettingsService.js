/**
 * Project Settings Service
 * Business logic for project-level settings management
 * 
 * This service handles:
 * - Fetching all Jira statuses for status selection
 * - Getting/saving project-level tracked statuses
 * - Validating project admin permissions
 */

import api, { route } from '@forge/api';
import { isJiraAdmin, checkUserPermissions, getAllJiraProjects } from '../utils/jira.js';
// eslint-disable-next-line deprecation/deprecation
import { getSupabaseConfig, supabaseRequest, getOrCreateOrganization, getOrCreateUser } from '../utils/supabase.js';

/**
 * Check if user has project admin permissions
 * @returns {Promise<boolean>} True if user is Jira admin or project admin
 */
async function hasProjectAdminPermission() {
  const isAdmin = await isJiraAdmin();
  if (isAdmin) return true;
  
  const permissions = await checkUserPermissions(['ADMINISTER_PROJECTS']);
  return permissions.permissions?.ADMINISTER_PROJECTS?.havePermission || false;
}

/**
 * Apply extra settings to project data object
 * @param {Object} projectData - Project data to modify
 * @param {Object} extraSettings - Extra settings to apply
 */
function applyExtraSettings(projectData, extraSettings) {
  if (extraSettings.batchUploadInterval !== undefined) {
    projectData.batch_upload_interval = extraSettings.batchUploadInterval;
  }
  if (extraSettings.autoWorklogEnabled !== undefined) {
    projectData.auto_worklog_enabled = extraSettings.autoWorklogEnabled;
  }
  if (extraSettings.nonWorkThreshold !== undefined) {
    projectData.non_work_threshold = extraSettings.nonWorkThreshold;
  }
}

/**
 * Upsert project settings in Supabase
 * @param {Object} supabaseConfig - Supabase configuration
 * @param {string} organizationId - Organization ID
 * @param {string} projectKey - Project key
 * @param {Object} projectData - Project data to save
 * @returns {Promise<void>}
 */
async function upsertProjectSettings(supabaseConfig, organizationId, projectKey, projectData) {
  // Check if settings already exist for this project
  // eslint-disable-next-line deprecation/deprecation
  const existingSettings = await supabaseRequest(
    supabaseConfig,
    `project_settings?organization_id=eq.${organizationId}&project_key=eq.${projectKey}&limit=1`
  );

  if (existingSettings && existingSettings.length > 0) {
    // Update existing settings
    const settingsId = existingSettings[0].id;
    // eslint-disable-next-line deprecation/deprecation
    await supabaseRequest(
      supabaseConfig,
      `project_settings?id=eq.${settingsId}`,
      { method: 'PATCH', body: projectData }
    );
    console.log(`[ProjectSettings] Updated settings for project ${projectKey}`);
  } else {
    // Insert new settings
    projectData.created_at = new Date().toISOString();
    // eslint-disable-next-line deprecation/deprecation
    await supabaseRequest(
      supabaseConfig,
      'project_settings',
      { method: 'POST', body: projectData }
    );
    console.log(`[ProjectSettings] Created settings for project ${projectKey}`);
  }
}

/**
 * Get all Jira statuses available in the system
 * This fetches from Jira API and returns all statuses with their categories
 * @returns {Promise<Array>} Array of status objects with name, id, and category
 */
export async function getJiraStatuses() {
  try {
    // Fetch all statuses from Jira API
    const response = await api.asUser().requestJira(
      route`/rest/api/3/status`,
      {
        method: 'GET',
        headers: {
          'Accept': 'application/json'
        }
      }
    );
    
    const statuses = await response.json();
    
    if (!statuses || !Array.isArray(statuses)) {
      console.log('[ProjectSettings] No statuses returned from Jira API');
      return [];
    }

    // Deduplicate statuses by name — Jira returns the same status once per issue type,
    // so "In Progress" can appear many times. Use a Map keyed by name to keep unique ones.
    const uniqueStatuses = new Map();
    statuses.forEach(status => {
      if (!uniqueStatuses.has(status.name)) {
        uniqueStatuses.set(status.name, {
          id: status.id,
          name: status.name,
          description: status.description || '',
          category: status.statusCategory?.name || 'Unknown',
          categoryKey: status.statusCategory?.key || 'undefined',
          categoryColorName: status.statusCategory?.colorName || 'default'
        });
      }
    });

    const formattedStatuses = Array.from(uniqueStatuses.values());
    console.log(`[ProjectSettings] Fetched ${statuses.length} statuses from Jira, ${formattedStatuses.length} unique`);
    return formattedStatuses;
  } catch (error) {
    console.error('[ProjectSettings] Error fetching Jira statuses:', error);
    throw new Error('Failed to fetch Jira statuses: ' + error.message);
  }
}

/**
 * Get project settings for a specific project
 * @param {string} projectKey - Jira project key (e.g., "PROJ")
 * @param {string} cloudId - Jira Cloud ID for multi-tenancy
 * @param {string} accountId - Atlassian account ID
 * @returns {Promise<Object>} Project settings including tracked statuses
 */
export async function getProjectSettings(projectKey, cloudId, accountId) {
  try {
    // eslint-disable-next-line deprecation/deprecation
    const supabaseConfig = await getSupabaseConfig(accountId);
    if (!supabaseConfig) {
      console.log('[ProjectSettings] Supabase not configured, returning defaults');
      return {
        projectKey,
        trackedStatuses: ['In Progress'],
        configured: false
      };
    }

    // Get organization for multi-tenancy
    let organizationId = null;
    if (cloudId) {
      try {
        const org = await getOrCreateOrganization(cloudId, supabaseConfig);
        organizationId = org?.id;
      } catch (err) {
        console.log('[ProjectSettings] Could not get organization:', err.message);
      }
    }

    if (!organizationId) {
      return {
        projectKey,
        trackedStatuses: ['In Progress'],
        configured: false
      };
    }

    // Fetch project settings from Supabase
    // eslint-disable-next-line deprecation/deprecation
    const response = await supabaseRequest(
      supabaseConfig,
      `project_settings?organization_id=eq.${organizationId}&project_key=eq.${projectKey}&limit=1`
    );

    if (response && response.length > 0) {
      const settings = response[0];
      return {
        projectKey,
        projectName: settings.project_name || projectKey,
        trackedStatuses: settings.tracked_statuses || ['In Progress'],
        batchUploadInterval: settings.batch_upload_interval,
        autoWorklogEnabled: settings.auto_worklog_enabled,
        nonWorkThreshold: settings.non_work_threshold,
        configuredBy: settings.configured_by,
        updatedAt: settings.updated_at,
        configured: true
      };
    }

    // No settings found, return defaults
    return {
      projectKey,
      trackedStatuses: ['In Progress'],
      batchUploadInterval: null,
      autoWorklogEnabled: null,
      nonWorkThreshold: null,
      configured: false
    };
  } catch (error) {
    console.error('[ProjectSettings] Error fetching project settings:', error);
    return {
      projectKey,
      trackedStatuses: ['In Progress'],
      configured: false,
      error: error.message
    };
  }
}

/**
 * Get project settings for all projects in the organization
 * @param {string} cloudId - Jira Cloud ID for multi-tenancy
 * @param {string} accountId - Atlassian account ID
 * @returns {Promise<Array>} Array of project settings
 */
export async function getAllProjectSettings(cloudId, accountId) {
  try {
    // eslint-disable-next-line deprecation/deprecation
    const supabaseConfig = await getSupabaseConfig(accountId);
    if (!supabaseConfig) {
      return [];
    }

    // Get organization for multi-tenancy
    let organizationId = null;
    if (cloudId) {
      try {
        const org = await getOrCreateOrganization(cloudId, supabaseConfig);
        organizationId = org?.id;
      } catch (err) {
        console.log('[ProjectSettings] Could not get organization:', err.message);
        return [];
      }
    }

    if (!organizationId) {
      return [];
    }

    // Fetch all project settings for this organization
    // eslint-disable-next-line deprecation/deprecation
    const response = await supabaseRequest(
      supabaseConfig,
      `project_settings?organization_id=eq.${organizationId}&order=project_key.asc`
    );

    if (response && response.length > 0) {
      return response.map(settings => ({
        projectKey: settings.project_key,
        projectName: settings.project_name || settings.project_key,
        trackedStatuses: settings.tracked_statuses || ['In Progress'],
        batchUploadInterval: settings.batch_upload_interval,
        autoWorklogEnabled: settings.auto_worklog_enabled,
        nonWorkThreshold: settings.non_work_threshold,
        configuredBy: settings.configured_by,
        updatedAt: settings.updated_at
      }));
    }

    return [];
  } catch (error) {
    console.error('[ProjectSettings] Error fetching all project settings:', error);
    return [];
  }
}

/**
 * Save project settings (tracked statuses) for a project
 * Only project admins or Jira admins can save these settings
 * @param {string} projectKey - Jira project key
 * @param {string} projectName - Jira project name (for display)
 * @param {Array} trackedStatuses - Array of status names to track
 * @param {string} cloudId - Jira Cloud ID for multi-tenancy
 * @param {string} accountId - Atlassian account ID
 * @returns {Promise<Object>} Result of save operation
 */
export async function saveProjectSettings(projectKey, projectName, trackedStatuses, cloudId, accountId, extraSettings = {}) {
  // Check if user is Jira Administrator or Project Admin
  const canSave = await hasProjectAdminPermission();
  if (!canSave) {
    throw new Error('Access denied: Only Jira Administrators or Project Administrators can configure project settings');
  }

  // Validate tracked statuses
  if (!Array.isArray(trackedStatuses) || trackedStatuses.length === 0) {
    throw new Error('At least one status must be selected for tracking');
  }

  // eslint-disable-next-line deprecation/deprecation
  const supabaseConfig = await getSupabaseConfig(accountId);
  if (!supabaseConfig) {
    throw new Error('Supabase not configured. Please configure in Settings first.');
  }

  // Get organization ID for multi-tenancy
  const org = await getOrCreateOrganization(cloudId, supabaseConfig);
  const organizationId = org?.id;
  if (!organizationId) {
    throw new Error('Organization not found');
  }

  // Get user ID
  const userId = accountId ? await getOrCreateUser(accountId, supabaseConfig, organizationId) : null;

  // Prepare data for Supabase
  const projectData = {
    organization_id: organizationId,
    project_key: projectKey,
    project_name: projectName || projectKey,
    tracked_statuses: trackedStatuses,
    configured_by: userId,
    updated_at: new Date().toISOString()
  };

  // Add optional settings
  applyExtraSettings(projectData, extraSettings);

  // Upsert settings
  await upsertProjectSettings(supabaseConfig, organizationId, projectKey, projectData);

  return {
    success: true,
    message: `Tracked statuses saved for project ${projectKey}`,
    trackedStatuses
  };
}

/**
 * Delete project settings for a project
 * @param {string} projectKey - Jira project key
 * @param {string} cloudId - Jira Cloud ID for multi-tenancy
 * @param {string} accountId - Atlassian account ID
 * @returns {Promise<Object>} Result of delete operation
 */
export async function deleteProjectSettings(projectKey, cloudId, accountId) {
  // Check if user is Jira Administrator or Project Admin
  const canDelete = await hasProjectAdminPermission();
  if (!canDelete) {
    throw new Error('Access denied: Only Jira Administrators or Project Administrators can delete project settings');
  }

  // eslint-disable-next-line deprecation/deprecation
  const supabaseConfig = await getSupabaseConfig(accountId);
  if (!supabaseConfig) {
    throw new Error('Supabase not configured');
  }

  // Get organization
  const org = await getOrCreateOrganization(cloudId, supabaseConfig);
  const organizationId = org?.id;
  if (!organizationId) {
    throw new Error('Organization not found');
  }

  // Delete project settings
  // eslint-disable-next-line deprecation/deprecation
  await supabaseRequest(
    supabaseConfig,
    `project_settings?organization_id=eq.${organizationId}&project_key=eq.${projectKey}`,
    { method: 'DELETE' }
  );

  console.log(`[ProjectSettings] Deleted settings for project ${projectKey}`);
  return {
    success: true,
    message: `Settings deleted for project ${projectKey}`
  };
}

/**
 * Get list of Jira projects the current user has access to
 * @returns {Promise<Array>} Array of project objects
 */
export async function getJiraProjects() {
  try {
    // Use the existing getAllJiraProjects function from jira.js
    const projects = await getAllJiraProjects();
    console.log(`[ProjectSettings] Fetched ${projects.length} projects from Jira`);
    return projects;
  } catch (error) {
    console.error('[ProjectSettings] Error fetching Jira projects:', error);
    throw new Error('Failed to fetch Jira projects: ' + error.message);
  }
}
