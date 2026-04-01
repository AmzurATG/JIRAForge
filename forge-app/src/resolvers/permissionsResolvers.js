/**
 * Permissions Resolvers
 * Resolver definitions for checking user permissions and roles
 */

import { isJiraAdmin, checkUserPermissions, getVerifiedAdminProjectKeys, getAllJiraProjectKeys } from '../utils/jira.js';

/**
 * Register permissions resolvers
 * @param {Resolver} resolver - Forge resolver instance
 */
export function registerPermissionsResolvers(resolver) {
  /**
   * Resolver for getting user's permissions and role information
   * This is called by the frontend to determine which UI elements to show
   */
  resolver.define('getUserPermissions', async (req) => {
    const { context } = req;
    const accountId = context.accountId;

    try {
      // Check if user is Jira Administrator
      const isAdmin = await isJiraAdmin();

      // Get list of projects where user is Project Admin
      // Always fetch projectAdminProjects for all users (including Jira Admins)
      let projectAdminProjects = [];
      let allProjectKeys = [];

      if (!isAdmin) {
        // Use the verified helper that does the 2-step ADMINISTER_PROJECTS check,
        // filtering out projects where the user only has EDIT_ISSUES.
        projectAdminProjects = await getVerifiedAdminProjectKeys();
      }

      // For Jira Admins, also get all project keys for Team Analytics
      if (isAdmin) {
        const projectKeysSet = await getAllJiraProjectKeys();
        allProjectKeys = Array.from(projectKeysSet);
      }

      // Check basic issue permissions (useful for future features)
      const issuePermissions = await checkUserPermissions(['CREATE_ISSUES', 'EDIT_ISSUES']);

      return {
        success: true,
        permissions: {
          isJiraAdmin: isAdmin,
          projectAdminProjects: projectAdminProjects || [],
          allProjectKeys: allProjectKeys || [],
          canCreateIssues: issuePermissions.permissions?.CREATE_ISSUES?.havePermission || false,
          canEditIssues: issuePermissions.permissions?.EDIT_ISSUES?.havePermission || false
        }
      };
    } catch (error) {
      console.error('Error fetching user permissions:', error);
      return {
        success: false,
        error: error.message,
        permissions: {
          isJiraAdmin: false,
          projectAdminProjects: [],
          allProjectKeys: [],
          canCreateIssues: false,
          canEditIssues: false
        }
      };
    }
  });
}
