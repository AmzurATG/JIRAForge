/**
 * User Analytics Service
 * Handles time analytics for individual users
 */

import { getSupabaseConfig, getOrCreateUser, getOrCreateOrganization, getUserOrganizationMembership, supabaseRequest } from '../../utils/supabase.js';
import { checkUserPermissions, getProjectsUserAdmins } from '../../utils/jira.js';
import { MAX_DAILY_SUMMARY_DAYS, MAX_WEEKLY_SUMMARY_WEEKS, MAX_ISSUES_IN_ANALYTICS } from '../../config/constants.js';
import { fetchDashboardData, syncCacheFromBatchResponse } from '../../utils/remote.js';
import { kvs } from '@forge/kvs';

// Permission cache TTL (5 minutes) — balances freshness with latency savings
const PERM_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Get cached Jira permissions from Forge KVS.
 * Returns null if cache miss, expired, or error.
 */
async function getCachedPermissions(accountId) {
  try {
    const entry = await kvs.get(`analytics:perms:${accountId}`);
    if (entry && Date.now() < entry.expiresAt) return entry.value;
  } catch { /* cache miss */ }
  return null;
}

/**
 * Save Jira permissions to Forge KVS (fire-and-forget).
 */
function setCachedPermissions(accountId, data) {
  kvs.set(`analytics:perms:${accountId}`, {
    value: data,
    expiresAt: Date.now() + PERM_CACHE_TTL_MS
  }).catch(() => {});
}

/**
 * Resolve Jira permissions for the current user.
 * Uses KVS cache to avoid the expensive Jira API call on subsequent loads.
 * Returns { isAdmin, isProjectAdmin, projectKeys }
 */
async function resolvePermissions(accountId) {
  // Try cache first (KVS survives cold starts, unlike in-memory)
  const cached = await getCachedPermissions(accountId);
  if (cached) {
    console.log('[Analytics] Using cached permissions for', accountId);
    return cached;
  }

  // Cache miss — call Jira API
  const permissions = await checkUserPermissions(['ADMINISTER', 'ADMINISTER_PROJECTS']);
  const isAdmin = permissions.permissions?.ADMINISTER?.havePermission || false;
  const isProjectAdmin = permissions.permissions?.ADMINISTER_PROJECTS?.havePermission || false;

  let projectKeys = null;
  if (!isAdmin && isProjectAdmin) {
    projectKeys = await getProjectsUserAdmins();
    if (!Array.isArray(projectKeys) || projectKeys.length === 0) {
      projectKeys = [];
    }
  }

  const result = { isAdmin, isProjectAdmin, projectKeys };
  setCachedPermissions(accountId, result);
  return result;
}

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
  const t0 = Date.now();

  // Resolve permissions (cached in KVS — saves ~3-5s on subsequent loads)
  const { isAdmin, isProjectAdmin, projectKeys } = await resolvePermissions(accountId);
  console.log(`[Analytics] Permission resolve took ${Date.now() - t0}ms, isAdmin:`, isAdmin, 'isProjectAdmin:', isProjectAdmin);

  // Project admin with no discoverable projects — return empty data for safety
  if (!isAdmin && isProjectAdmin && (!Array.isArray(projectKeys) || projectKeys.length === 0)) {
    console.log('[Analytics] Project admin has no discoverable projects - returning empty data');
    return {
      organizationId: null, organizationName: null,
      userId: null, userDisplayName: null, userEmail: null,
      membership: null, canViewAllUsers: false,
      dailySummary: [], weeklySummary: [], timeByProject: [], timeByIssue: [], allUsers: []
    };
  }
  
  // User can view team data if Jira admin or project admin
  const canViewAllUsers = isAdmin || isProjectAdmin;

  console.log('[Analytics] Using batch endpoint with canViewAllUsers:', canViewAllUsers, 'isJiraAdmin:', isAdmin);

  // Single batch request replaces 8+ individual calls
  const t1 = Date.now();
  const dashboardData = await fetchDashboardData({
    canViewAllUsers,
    isJiraAdmin: isAdmin,
    projectKeys: isProjectAdmin ? projectKeys : null,
    maxDailySummaryDays: MAX_DAILY_SUMMARY_DAYS,
    maxWeeklySummaryWeeks: MAX_WEEKLY_SUMMARY_WEEKS,
    maxIssuesInAnalytics: MAX_ISSUES_IN_ANALYTICS
  });
  console.log(`[Analytics] Dashboard batch took ${Date.now() - t1}ms, total elapsed ${Date.now() - t0}ms`);
  console.log('[Analytics] Batch API orgId:', dashboardData.organizationId, 'userId:', dashboardData.userId, 'allUsers:', dashboardData.allUsers?.length, 'dailySummary:', dashboardData.dailySummary?.length);

  // Sync Forge caches with the authoritative values from the batch API.
  // This prevents stale org/user IDs from causing timeline and worklog operations to fail.
  syncCacheFromBatchResponse(cloudId, accountId, dashboardData);

  // Enforce Forge-computed permission — never trust the AI server's canViewAllUsers
  dashboardData.canViewAllUsers = canViewAllUsers;

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

  // Check if user is admin or project admin in Jira (single API call)
  const permissions = await checkUserPermissions(['ADMINISTER', 'ADMINISTER_PROJECTS']);
  const isAdmin = permissions.permissions?.ADMINISTER?.havePermission || false;
  const isProjectAdmin = permissions.permissions?.ADMINISTER_PROJECTS?.havePermission;

  // Get membership for reference but do NOT use can_view_team_analytics to widen access.
  // Only Jira admins and project admins (verified via Jira API) should see team data.
  const membership = await getUserOrganizationMembership(userId, organization.id, supabaseConfig);

  // User can view all users only if Jira admin or project admin
  const canViewAllUsers = isAdmin || isProjectAdmin;

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
