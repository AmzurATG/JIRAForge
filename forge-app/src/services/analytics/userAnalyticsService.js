/**
 * User Analytics Service
 * Handles time analytics for individual users
 */

import { getSupabaseConfig, getOrCreateUser, getOrCreateOrganization, getUserOrganizationMembership, supabaseRequest } from '../../utils/supabase.js';
import { isJiraAdmin, checkUserPermissions, getProjectsUserAdmins } from '../../utils/jira.js';
import { MAX_DAILY_SUMMARY_DAYS, MAX_WEEKLY_SUMMARY_WEEKS, MAX_ISSUES_IN_ANALYTICS } from '../../config/constants.js';
import { fetchDashboardData } from '../../utils/remote.js';

/**
 * Fetch time analytics data using the optimized batch API
 * This replaces 8+ individual API calls with a single batch request
 * Recommended for production use - significantly improves performance
 * 
 * @param {string} accountId - Atlassian account ID  
 * @param {string} cloudId - Jira Cloud ID for organization filtering
 * @returns {Promise<Object>} Analytics data (daily, weekly, by project, by issue)
 */
export async function fetchTimeAnalyticsBatch(accountId, cloudId) {
  // Determine user permissions for data filtering on server-side
  const isAdmin = await isJiraAdmin();
  const permissions = await checkUserPermissions(['ADMINISTER_PROJECTS']);
  const isProjectAdmin = permissions.permissions?.ADMINISTER_PROJECTS?.havePermission;
  
  // Get the list of projects this user administers (for project admins)
  // Jira admins see all data, project admins see only their projects
  let projectKeys = null;
  if (!isAdmin && isProjectAdmin) {
    projectKeys = await getProjectsUserAdmins();
    // If getProjectsUserAdmins() returns empty array (API error or no projects),
    // treat as "no access" rather than "all access" for safety
    if (!Array.isArray(projectKeys) || projectKeys.length === 0) {
      console.log('[Analytics] Project admin has no discoverable projects - returning empty data');
      // Return empty data structure instead of potentially exposing all org data
      return {
        organizationId: null,
        organizationName: null,
        userId: null,
        userDisplayName: null,
        userEmail: null,
        membership: null,
        canViewAllUsers: false,
        dailySummary: [],
        weeklySummary: [],
        timeByProject: [],
        timeByIssue: [],
        allUsers: []
      };
    }
    console.log('[Analytics] Project admin - filtering to projects:', projectKeys.length, 'projects');
  }
  
  // User can view team data if Jira admin or project admin
  const canViewAllUsers = isAdmin || isProjectAdmin;

  console.log('[Analytics] Using batch endpoint with canViewAllUsers:', canViewAllUsers, 'isJiraAdmin:', isAdmin);

  // Single batch request replaces 8+ individual calls
  const dashboardData = await fetchDashboardData({
    canViewAllUsers,
    isJiraAdmin: isAdmin,
    projectKeys: projectKeys, // null for Jira admins (see all), array for project admins
    maxDailySummaryDays: MAX_DAILY_SUMMARY_DAYS,
    maxWeeklySummaryWeeks: MAX_WEEKLY_SUMMARY_WEEKS,
    maxIssuesInAnalytics: MAX_ISSUES_IN_ANALYTICS
  });

  return dashboardData;
}

/**
 * Fetch time analytics data for a user (Legacy - individual API calls)
 * Consider using fetchTimeAnalyticsBatch() for better performance
 * 
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID for organization filtering
 * @returns {Promise<Object>} Analytics data (daily, weekly, by project, by issue)
 * @deprecated Use fetchTimeAnalyticsBatch() for improved performance
 */
export async function fetchTimeAnalytics(accountId, cloudId) {
  const supabaseConfig = await getSupabaseConfig(accountId);
  if (!supabaseConfig) {
    throw new Error('Supabase not configured. Please configure in Settings.');
  }

  // Get or create organization first
  const organization = await getOrCreateOrganization(cloudId, supabaseConfig);
  if (!organization) {
    throw new Error('Unable to get organization information');
  }

  const userId = await getOrCreateUser(accountId, supabaseConfig, organization.id);
  if (!userId) {
    throw new Error('Unable to get user information');
  }

  // Check if user is admin or project admin in Jira
  const isAdmin = await isJiraAdmin();
  const permissions = await checkUserPermissions(['ADMINISTER_PROJECTS']);
  const isProjectAdmin = permissions.permissions?.ADMINISTER_PROJECTS?.havePermission;

  // Also check organization-level permissions
  const membership = await getUserOrganizationMembership(userId, organization.id, supabaseConfig);
  const canViewTeamAnalytics = membership?.can_view_team_analytics || false;

  // User can view all users if Jira admin, project admin, OR has organization permission
  const canViewAllUsers = isAdmin || isProjectAdmin || canViewTeamAnalytics;

  // Fetch daily summary - filter by organization_id, and by user if not admin
  const dailySummaryQuery = canViewAllUsers
    ? `daily_time_summary?organization_id=eq.${organization.id}&order=work_date.desc&limit=${MAX_DAILY_SUMMARY_DAYS}`
    : `daily_time_summary?user_id=eq.${userId}&organization_id=eq.${organization.id}&order=work_date.desc&limit=${MAX_DAILY_SUMMARY_DAYS}`;

  const dailySummary = await supabaseRequest(supabaseConfig, dailySummaryQuery);

  // Fetch weekly summary
  const weeklySummaryQuery = canViewAllUsers
    ? `weekly_time_summary?organization_id=eq.${organization.id}&order=week_start.desc&limit=${MAX_WEEKLY_SUMMARY_WEEKS}`
    : `weekly_time_summary?user_id=eq.${userId}&organization_id=eq.${organization.id}&order=week_start.desc&limit=${MAX_WEEKLY_SUMMARY_WEEKS}`;

  const weeklySummary = await supabaseRequest(supabaseConfig, weeklySummaryQuery);

  // Fetch project time summary
  const timeByProject = await supabaseRequest(
    supabaseConfig,
    `project_time_summary?organization_id=eq.${organization.id}&order=total_seconds.desc`
  );

  // Fetch time by issue (from activity_records - hybrid OCR approach)
  const timeByIssueQuery = canViewAllUsers
    ? `activity_records?organization_id=eq.${organization.id}&status=in.(pending,processing,analyzed)&classification=in.(productive,unknown)&user_assigned_issue_key=not.is.null&select=user_assigned_issue_key,project_key,duration_seconds,total_time_seconds&order=created_at.desc`
    : `activity_records?user_id=eq.${userId}&organization_id=eq.${organization.id}&status=in.(pending,processing,analyzed)&classification=in.(productive,unknown)&user_assigned_issue_key=not.is.null&select=user_assigned_issue_key,project_key,duration_seconds,total_time_seconds&order=created_at.desc`;

  const timeByIssue = await supabaseRequest(supabaseConfig, timeByIssueQuery);

  // Aggregate time by issue
  const issueAggregation = {};
  timeByIssue.forEach(result => {
    const key = result.user_assigned_issue_key;
    if (!issueAggregation[key]) {
      issueAggregation[key] = {
        issueKey: key,
        projectKey: result.project_key,
        totalSeconds: 0
      };
    }
    issueAggregation[key].totalSeconds += result.duration_seconds || result.total_time_seconds || 0;
  });

  const timeByIssueArray = Object.values(issueAggregation)
    .sort((a, b) => b.totalSeconds - a.totalSeconds)
    .slice(0, MAX_ISSUES_IN_ANALYTICS);

  // Fetch all active users for team view
  let allUsers = [];
  if (canViewAllUsers) {
    allUsers = await supabaseRequest(
      supabaseConfig,
      `users?organization_id=eq.${organization.id}&is_active=eq.true&select=id,display_name,email`
    );
  } else {
    const currentUser = await supabaseRequest(
      supabaseConfig,
      `users?id=eq.${userId}&select=id,display_name,email`
    );
    allUsers = currentUser || [];
  }

  return {
    dailySummary: dailySummary || [],
    weeklySummary: weeklySummary || [],
    timeByProject: timeByProject || [],
    timeByIssue: timeByIssueArray,
    allUsers: allUsers || [],
    canViewAllUsers,
    organizationId: organization.id,
    organizationName: organization.org_name
  };
}
