/**
 * Settings Resolvers
 * Resolver definitions for user settings endpoints
 */

import {
  getUserSettings,
  saveUserSettings,
  getTrackingSettings,
  saveTrackingSettings
} from '../services/settingsService.js';

import {
  getJiraStatuses,
  getJiraProjects,
  getProjectSettings,
  getAllProjectSettings,
  saveProjectSettings,
  deleteProjectSettings
} from '../services/projectSettingsService.js';

import {
  getSuggestedDomain,
  getEmailDomains,
  addEmailDomain,
  removeEmailDomain
} from '../services/emailDomainService.js';

import { isJiraAdmin, checkUserPermissions, getVerifiedAdminProjectKeys } from '../utils/jira.js';

/**
 * Register settings resolvers
 * @param {Resolver} resolver - Forge resolver instance
 */
export function registerSettingsResolvers(resolver) {
  /**
   * Resolver for getting user settings
   */
  resolver.define('getSettings', async (req) => {
    const { context } = req;
    const accountId = context.accountId;

    try {
      const settings = await getUserSettings(accountId);
      return {
        success: true,
        settings
      };
    } catch (error) {
      console.error('Error getting settings:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });

  /**
   * Resolver for saving user settings
   */
  resolver.define('saveSettings', async (req) => {
    const { payload, context } = req;
    const { settings } = payload;
    const accountId = context.accountId;

    try {
      await saveUserSettings(accountId, settings);
      return {
        success: true,
        message: 'Settings saved successfully'
      };
    } catch (error) {
      console.error('Error saving settings:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });

  /**
   * Resolver for getting tracking/timesheet settings
   * These settings control screenshot monitoring, whitelisted/blacklisted apps, etc.
   * Can fetch project-level or organization-level settings
   */
  resolver.define('getTrackingSettings', async (req) => {
    const { payload, context } = req;
    const { projectKey } = payload || {};
    const accountId = context.accountId;
    const cloudId = context.cloudId;  // Multi-tenancy: Get Jira Cloud ID from context

    try {
      const settings = await getTrackingSettings(accountId, cloudId, projectKey);
      return {
        success: true,
        settings
      };
    } catch (error) {
      console.error('Error getting tracking settings:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });

  /**
   * Resolver for saving tracking/timesheet settings
   * Only admins/project admins can save these settings
   * Can save at project-level or organization-level
   */
  resolver.define('saveTrackingSettings', async (req) => {
    const { payload, context } = req;
    const { settings, projectKey } = payload;
    const accountId = context.accountId;
    const cloudId = context.cloudId;  // Multi-tenancy: Get Jira Cloud ID from context

    try {
      await saveTrackingSettings(accountId, cloudId, settings, projectKey);
      const level = projectKey ? `project ${projectKey}` : 'organization';
      return {
        success: true,
        message: `Tracking settings saved successfully for ${level}`
      };
    } catch (error) {
      console.error('Error saving tracking settings:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });

  // ============================================================================
  // NON-JIRA EMAIL DOMAIN RESOLVERS (Google SSO self-signup allowlist)
  // Admin-only. Maps a company email domain -> this organization.
  // ============================================================================

  /** Suggested company domain (derived from the admin's own email) for the UI to pre-fill. */
  resolver.define('getSuggestedEmailDomain', async () => {
    try {
      const domain = await getSuggestedDomain();
      return { success: true, domain };
    } catch (error) {
      console.error('Error getting suggested email domain:', error);
      return { success: false, error: error.message, domain: null };
    }
  });

  /** List the company email domains registered for this org. */
  resolver.define('getEmailDomains', async (req) => {
    const { cloudId } = req.context;
    try {
      const domains = await getEmailDomains(cloudId);
      return { success: true, domains };
    } catch (error) {
      console.error('Error getting email domains:', error);
      return { success: false, error: error.message, domains: [] };
    }
  });

  /** Register a company email domain for non-Jira Google SSO (admin only). */
  resolver.define('addEmailDomain', async (req) => {
    const { payload, context } = req;
    try {
      const domain = await addEmailDomain(context.cloudId, payload?.domain);
      return { success: true, domain };
    } catch (error) {
      console.error('Error adding email domain:', error);
      return { success: false, error: error.message };
    }
  });

  /** Remove a registered company email domain (admin only). */
  resolver.define('removeEmailDomain', async (req) => {
    const { payload, context } = req;
    try {
      const domain = await removeEmailDomain(context.cloudId, payload?.domain);
      return { success: true, domain };
    } catch (error) {
      console.error('Error removing email domain:', error);
      return { success: false, error: error.message };
    }
  });

  // ============================================================================
  // PROJECT SETTINGS RESOLVERS (Tracked Statuses per Project)
  // ============================================================================

  /**
   * Resolver for getting all available Jira statuses
   * Used to populate the status selection UI
   */
  resolver.define('getJiraStatuses', async (req) => {
    try {
      const statuses = await getJiraStatuses();
      return {
        success: true,
        statuses
      };
    } catch (error) {
      console.error('Error getting Jira statuses:', error);
      return {
        success: false,
        error: error.message,
        statuses: []
      };
    }
  });

  /**
   * Resolver for getting Jira projects the user can administer
   * Jira Admins see all projects; Project Admins see only their admin projects
   * Normal users get an empty list (server-side enforcement)
   */
  resolver.define('getJiraProjects', async (req) => {
    try {
      const allProjects = await getJiraProjects();
      const isAdmin = await isJiraAdmin();

      if (isAdmin) {
        // Jira admin — return all projects
        return { success: true, projects: allProjects };
      }

      // Non-admin — only return projects where user has ADMINISTER_PROJECTS
      const adminKeys = await getVerifiedAdminProjectKeys();
      if (adminKeys.length === 0) {
        return { success: true, projects: [] };
      }

      const adminKeySet = new Set(adminKeys);
      const filteredProjects = allProjects.filter(p => adminKeySet.has(p.key));
      return { success: true, projects: filteredProjects };
    } catch (error) {
      console.error('Error getting Jira projects:', error);
      return {
        success: false,
        error: error.message,
        projects: []
      };
    }
  });

  /**
   * Resolver for getting project settings (tracked statuses)
   * Only project admins or Jira admins can read these settings
   */
  resolver.define('getProjectSettings', async (req) => {
    const { payload, context } = req;
    const { projectKey } = payload;
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

      const settings = await getProjectSettings(projectKey, cloudId, accountId);
      return {
        success: true,
        settings
      };
    } catch (error) {
      console.error('Error getting project settings:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });

  /**
   * Resolver for getting all project settings in the organization
   * Only project admins or Jira admins can read the full org-wide settings list
   */
  resolver.define('getAllProjectSettings', async (req) => {
    const { context } = req;
    const accountId = context.accountId;
    const cloudId = context.cloudId;

    try {
      const [adminCheck, projectPerms] = await Promise.all([
        isJiraAdmin(),
        checkUserPermissions(['ADMINISTER_PROJECTS'])
      ]);
      const hasProjectAdmin = projectPerms.permissions?.ADMINISTER_PROJECTS?.havePermission || false;
      if (!adminCheck && !hasProjectAdmin) {
        return { success: false, error: 'Access denied: Project Admin or Jira Administrator required', projectSettings: [] };
      }

      const allSettings = await getAllProjectSettings(cloudId, accountId);
      return {
        success: true,
        projectSettings: allSettings
      };
    } catch (error) {
      console.error('Error getting all project settings:', error);
      return {
        success: false,
        error: error.message,
        projectSettings: []
      };
    }
  });

  /**
   * Resolver for saving project settings (tracked statuses)
   * Only project admins can save these settings
   */
  resolver.define('saveProjectSettings', async (req) => {
    const { payload, context } = req;
    const { projectKey, projectName, trackedStatuses } = payload;
    const accountId = context.accountId;
    const cloudId = context.cloudId;

    try {
      const result = await saveProjectSettings(projectKey, projectName, trackedStatuses, cloudId, accountId);
      return {
        success: true,
        message: result.message,
        trackedStatuses: result.trackedStatuses
      };
    } catch (error) {
      console.error('Error saving project settings:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });

  /**
   * Resolver for deleting project settings
   * Resets project to use default status tracking
   */
  resolver.define('deleteProjectSettings', async (req) => {
    const { payload, context } = req;
    const { projectKey } = payload;
    const accountId = context.accountId;
    const cloudId = context.cloudId;

    try {
      const result = await deleteProjectSettings(projectKey, cloudId, accountId);
      return {
        success: true,
        message: result.message
      };
    } catch (error) {
      console.error('Error deleting project settings:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });
  /**
   * Resolver to register UI modification contexts dynamically via REST API
   */
  resolver.define('registerUim', async (req) => {
    try {
      const api = require('@forge/api').default;
      const { route } = require('@forge/api');

      // Get all projects
      const projRes = await api.asApp().requestJira(route`/rest/api/3/project`);
      const projects = await projRes.json();

      // Get all issue types
      const itRes = await api.asApp().requestJira(route`/rest/api/3/issuetype`);
      const issueTypes = await itRes.json();

      const contexts = [];
      for (const it of issueTypes) {
        if (contexts.length < 900 && it.id) {
          contexts.push({
            projectId: null,
            issueTypeId: it.id,
            viewType: 'GIC'
          });
        }
      }

      const res = await api.asApp().requestJira(route`/rest/api/3/uiModifications`, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          name: 'Real-Time Description Scoring',
          contexts: contexts
        })
      });

      const responseData = await res.json();
      console.log('UI Modification registered:', responseData);
      return { success: true, data: responseData };
    } catch (error) {
      console.error('Error registering UIM:', error);
      return { success: false, error: error.message };
    }
  });
}