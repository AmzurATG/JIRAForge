/**
 * Organization Analytics Service
 * Handles organization-wide analytics (Admin only)
 */

import { getSupabaseConfig, getOrCreateOrganization, supabaseRequest } from '../../utils/supabase.js';
import { isJiraAdmin, getAllJiraProjectKeys } from '../../utils/jira.js';
import {
  formatDate,
  getWorkDateStr,
  secondsToHours,
  sumTotalSeconds,
  filterByDateRange,
  filterByDateFrom,
  filterByExactDate,
  getActiveProjectCount,
  daysAgoStr,
  getWeekStartUTC,
  computeHoursInRange,
  formatDateDisplay
} from './analyticsUtils.js';

/**
 * Fetch all analytics data (Admin only)
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID for organization filtering
 * @param {string} [clientToday] - Client's local date as YYYY-MM-DD (avoids UTC mismatch with work_date)
 * @returns {Promise<Object>} All analytics data
 */
export async function fetchAllAnalytics(accountId, cloudId, clientToday) {
  // 1. Check Admin Permission
  const isAdmin = await isJiraAdmin();
  if (!isAdmin) {
    throw new Error('Access denied: Requires Jira Administrator permission');
  }

  const supabaseConfig = await getSupabaseConfig(accountId);
  if (!supabaseConfig) {
    throw new Error('Supabase not configured');
  }

  // Get organization
  const organization = await getOrCreateOrganization(cloudId, supabaseConfig);
  if (!organization) {
    throw new Error('Unable to get organization information');
  }

  // 2. Fetch All Data - filter by organization_id for multi-tenancy
  const dailySummary = await supabaseRequest(
    supabaseConfig,
    `daily_time_summary?organization_id=eq.${organization.id}&order=work_date.desc&limit=60`
  );

  const timeByProject = await supabaseRequest(
    supabaseConfig,
    `project_time_summary?organization_id=eq.${organization.id}&order=total_seconds.desc`
  );

  const allUsers = await supabaseRequest(
    supabaseConfig,
    `users?organization_id=eq.${organization.id}&select=id,display_name,email,is_active`
  );

  // Calculate date ranges
  // Prefer client-supplied date to avoid UTC vs local-date mismatch.
  // work_date stores the user's local date, so UTC can be ±1 day off near midnight.
  const now = new Date();
  const todayStr = (clientToday && /^\d{4}-\d{2}-\d{2}$/.test(clientToday))
    ? clientToday
    : formatDate(now);
  const todayDate = new Date(todayStr + 'T00:00:00');
  const currentMonthStart = new Date(todayDate.getFullYear(), todayDate.getMonth(), 1);
  const lastMonthStart = new Date(todayDate.getFullYear(), todayDate.getMonth() - 1, 1);
  const lastMonthEnd = new Date(todayDate.getFullYear(), todayDate.getMonth(), 0);

  const currentMonthStr = `${currentMonthStart.getFullYear()}-${String(currentMonthStart.getMonth() + 1).padStart(2, '0')}-01`;
  const lastMonthStartStr = `${lastMonthStart.getFullYear()}-${String(lastMonthStart.getMonth() + 1).padStart(2, '0')}-${String(lastMonthStart.getDate()).padStart(2, '0')}`;
  const lastMonthEndStr = `${lastMonthEnd.getFullYear()}-${String(lastMonthEnd.getMonth() + 1).padStart(2, '0')}-${String(lastMonthEnd.getDate()).padStart(2, '0')}`;

  const thisMonthData = filterByDateFrom(dailySummary || [], currentMonthStr);
  const lastMonthData = filterByDateRange(dailySummary || [], lastMonthStartStr, lastMonthEndStr);

  const totalSecondsThisMonth = sumTotalSeconds(thisMonthData);
  const totalHoursThisMonth = secondsToHours(totalSecondsThisMonth);
  const totalSecondsLastMonth = sumTotalSeconds(lastMonthData);
  const totalHoursLastMonth = secondsToHours(totalSecondsLastMonth);

  const hoursChange = totalHoursLastMonth > 0
    ? Math.round((totalHoursThisMonth - totalHoursLastMonth) / totalHoursLastMonth * 100)
    : 0;

  const activeUsersThisMonth = new Set(thisMonthData.map(d => d.user_id)).size;
  const activeUsersLastMonth = new Set(lastMonthData.map(d => d.user_id)).size;
  const activeUsersChange = activeUsersThisMonth - activeUsersLastMonth;

  const totalUsers = (allUsers || []).filter(u => u.is_active !== false).length;
  const adoptionRate = totalUsers > 0 ? Math.round(activeUsersThisMonth / totalUsers * 100) : 0;

  const validJiraProjectKeys = await getAllJiraProjectKeys();
  console.log('[Analytics] Valid Jira project keys:', Array.from(validJiraProjectKeys));

  const activeProjectsThisMonth = getActiveProjectCount(thisMonthData, validJiraProjectKeys);
  const activeProjectsLastMonth = getActiveProjectCount(lastMonthData, validJiraProjectKeys);
  const projectsChange = activeProjectsThisMonth - activeProjectsLastMonth;

  const sevenDaysAgoStr = daysAgoStr(now, 7);
  const thirtyDaysAgoStr = daysAgoStr(now, 30);

  // Build project portfolio with contributor counts and activity-based status
  const projectPortfolio = (timeByProject || [])
    .filter(project => {
      const isValid = validJiraProjectKeys.has(project.project_key);
      if (!isValid) {
        console.log(`[Analytics] Filtering out invalid project: ${project.project_key}`);
      }
      return isValid;
    })
    .map(project => {
      const projectAllTime = (dailySummary || []).filter(d => d.project_key === project.project_key);
      const lastActivityRecord = projectAllTime.length > 0 ? projectAllTime[0] : null;
      const lastActiveDate = lastActivityRecord ? formatDateDisplay(getWorkDateStr(lastActivityRecord)) : null;

      let activityStatus = 'inactive';
      if (lastActivityRecord) {
        const lastDate = getWorkDateStr(lastActivityRecord);
        if (lastDate >= sevenDaysAgoStr) activityStatus = 'active';
        else if (lastDate >= thirtyDaysAgoStr) activityStatus = 'moderate';
      }

      const totalHours = secondsToHours(project.total_seconds || 0);
      const contributorCount = project.unique_users || 0;
      const issueCount = new Set(projectAllTime.map(d => d.task_key || d.active_task_key).filter(Boolean)).size;

      return {
        projectKey: project.project_key,
        totalHours,
        totalSeconds: project.total_seconds || 0,
        contributorCount,
        issueCount,
        lastActiveDate,
        activityStatus
      };
    }).filter(p => p.totalHours > 0 || p.totalSeconds > 0);

  const orgSummary = {
    totalHours: totalHoursThisMonth,
    totalHoursChange: hoursChange,
    activeProjects: activeProjectsThisMonth,
    projectsChange: projectsChange,
    activeUsers: activeUsersThisMonth,
    activeUsersChange: activeUsersChange,
    totalUsers: totalUsers,
    adoptionRate: adoptionRate
  };

  const todayStrForUser = todayStr;
  // Compute week start (Monday) from client-aware todayDate
  const dayOfWeek = todayDate.getDay();
  const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStartDate = new Date(todayDate);
  weekStartDate.setDate(todayDate.getDate() - daysToMonday);
  const weekStartStr = `${weekStartDate.getFullYear()}-${String(weekStartDate.getMonth() + 1).padStart(2, '0')}-${String(weekStartDate.getDate()).padStart(2, '0')}`;

  const userActivity = (allUsers || [])
    .filter(user => user.is_active !== false)
    .map(user => {
      const userDailyData = (dailySummary || []).filter(d => d.user_id === user.id);
      const todayHours = secondsToHours(sumTotalSeconds(filterByExactDate(userDailyData, todayStrForUser)));
      const weekHours = computeHoursInRange(userDailyData, weekStartStr, todayStrForUser);
      const monthHours = computeHoursInRange(userDailyData, currentMonthStr, todayStrForUser);

      return {
        userId: user.id,
        displayName: user.display_name || user.email || 'Unknown User',
        todayHours,
        weekHours,
        monthHours
      };
    })
    .sort((a, b) => b.monthHours - a.monthHours);

  return {
    dailySummary: dailySummary || [],
    timeByProject: timeByProject || [],
    orgSummary,
    projectPortfolio,
    userActivity,
    scope: 'GLOBAL',
    organizationId: organization.id,
    organizationName: organization.org_name
  };
}
