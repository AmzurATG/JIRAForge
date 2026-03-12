/**
 * Permissions Resolvers
 * Resolver definitions for checking user permissions and roles
 */

import { isJiraAdmin, checkUserPermissions, getProjectsUserAdmins, getAllJiraProjectKeys } from '../utils/jira.js';

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

      // Always get projects where user is project admin.
      // NOTE: getProjectsUserAdmins() uses ?action=edit which, per Atlassian docs,
      // maps to the EDIT_ISSUES permission — not ADMINISTER_PROJECTS. This means
      // regular developers can appear in the list, causing admin tabs to show for
      // everyone. We correct this with a two-step explicit ADMINISTER_PROJECTS check.
      projectAdminProjects = await getProjectsUserAdmins();

      if (!isAdmin && projectAdminProjects.length > 0) {
        // Step 1 — global fast-fail (1 API call).
        // mypermissions without a projectKey returns havePermission:true if the user
        // holds ADMINISTER_PROJECTS on ANY project in the instance. If false, the user
        // is not a project admin anywhere and we can skip all further checks.
        const globalAdminCheck = await checkUserPermissions(['ADMINISTER_PROJECTS']);
        if (!globalAdminCheck.permissions?.ADMINISTER_PROJECTS?.havePermission) {
          // Not an admin anywhere — action=edit returned too broadly (EDIT_ISSUES holders).
          projectAdminProjects = [];
        } else {
          // Step 2 — per-project verification.
          // User IS an admin on at least one project, but action=edit still includes
          // projects where the user only has EDIT_ISSUES. Filter to the true admin set.
          const verified = await Promise.all(
            projectAdminProjects.map(async (pk) => {
              const perm = await checkUserPermissions(['ADMINISTER_PROJECTS'], pk);
              return perm.permissions?.ADMINISTER_PROJECTS?.havePermission ? pk : null;
            })
          );
          projectAdminProjects = verified.filter(Boolean);
        }
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
