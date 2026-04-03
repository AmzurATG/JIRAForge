/**
 * Team Analytics Service
 * Handles project-level and team analytics
 */

import { getSupabaseConfig, getOrCreateOrganization, getOrCreateUser, supabaseRequest } from '../../utils/supabase.js';
import { checkUserPermissions, getProjectsUserAdmins } from '../../utils/jira.js';
import { MAX_DAILY_SUMMARY_DAYS, MAX_ISSUES_IN_ANALYTICS, DEFAULT_TRACKING_SETTINGS } from '../../config/constants.js';
import { isValidProjectKey } from '../../utils/validators.js';

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Initialize Supabase context with organization
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID
 * @returns {Promise<{supabaseConfig: Object, organization: Object}>}
 */
async function initializeContext(accountId, cloudId) {
  const supabaseConfig = await getSupabaseConfig(accountId);
  if (!supabaseConfig) {
    throw new Error('Supabase not configured');
  }

  const organization = await getOrCreateOrganization(cloudId, supabaseConfig);
  if (!organization) {
    throw new Error('Unable to get organization information');
  }

  return { supabaseConfig, organization };
}

/**
 * Fetch work hours config from tracking_settings for an organization
 * Returns defaults if not found.
 */
async function fetchWorkHoursConfig(supabaseConfig, organizationId) {
  try {
    const rows = await supabaseRequest(
      supabaseConfig,
      `tracking_settings?organization_id=eq.${organizationId}&project_key=is.null&select=work_hours_start,work_hours_end,work_days&limit=1`
    );
    if (rows && rows.length > 0) {
      return {
        workHoursStart: rows[0].work_hours_start || DEFAULT_TRACKING_SETTINGS.workHoursStart,
        workHoursEnd: rows[0].work_hours_end || DEFAULT_TRACKING_SETTINGS.workHoursEnd,
        workDays: rows[0].work_days || DEFAULT_TRACKING_SETTINGS.workDays
      };
    }
  } catch (err) {
    console.log('[WorkHours] Could not fetch work hours config:', err.message);
  }
  return {
    workHoursStart: DEFAULT_TRACKING_SETTINGS.workHoursStart,
    workHoursEnd: DEFAULT_TRACKING_SETTINGS.workHoursEnd,
    workDays: DEFAULT_TRACKING_SETTINGS.workDays
  };
}

/**
 * Filter idle blocks to only include those that started within configured work hours.
 * Defense-in-depth: desktop app also filters, but this ensures consistency on the server side.
 */
function filterIdleBlocksByWorkHours(idleBlocks, workHoursConfig) {
  const { workHoursStart, workHoursEnd, workDays } = workHoursConfig;
  if (!workHoursStart || !workHoursEnd || !workDays) return idleBlocks;

  const parseTime = (str) => {
    const parts = (str || '').split(':').map(Number);
    return parts[0] * 60 + (parts[1] || 0);
  };
  const startMin = parseTime(workHoursStart);
  const endMin = parseTime(workHoursEnd);

  return idleBlocks.filter(block => {
    const dt = new Date(block.startTime);
    if (isNaN(dt.getTime())) return true; // keep if unparseable
    const dayOfWeek = dt.getDay(); // 0=Sun ... 6=Sat
    const isoDay = dayOfWeek === 0 ? 7 : dayOfWeek; // convert to ISO: 1=Mon ... 7=Sun
    const blockMin = dt.getHours() * 60 + dt.getMinutes();

    if (startMin <= endMin) {
      // Normal schedule
      return workDays.includes(isoDay) && blockMin >= startMin && blockMin <= endMin;
    } else {
      // Cross-midnight
      if (blockMin >= startMin) return workDays.includes(isoDay);
      if (blockMin <= endMin) {
        const prevDay = isoDay > 1 ? isoDay - 1 : 7;
        return workDays.includes(prevDay);
      }
      return false;
    }
  });
}

/**
 * Validate date string format (YYYY-MM-DD)
 * @param {string} date - Date string to validate
 * @throws {Error} If date format is invalid
 */
function validateDateFormat(date) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('Invalid date format. Expected YYYY-MM-DD');
  }
}

/**
 * Check if user has project admin access
 * @param {string} projectKey - Jira project key
 * @returns {Promise<{isAdmin: boolean, hasPermission: boolean}>}
 */
async function checkProjectAdminAccess(projectKey) {
  const permissions = await checkUserPermissions(['ADMINISTER', 'ADMINISTER_PROJECTS'], projectKey);
  const isAdmin = permissions.permissions?.ADMINISTER?.havePermission || false;
  const hasPermission = permissions.permissions?.ADMINISTER_PROJECTS?.havePermission || false;
  return { isAdmin, hasPermission };
}

/**
 * Sort sessions by start time
 * @param {Array} sessions - Array of session objects with startTime
 */
function sortSessionsByStartTime(sessions) {
  sessions.sort((a, b) => {
    const aTime = a.startTime ? new Date(a.startTime).getTime() : 0;
    const bTime = b.startTime ? new Date(b.startTime).getTime() : 0;
    return aTime - bTime;
  });
}

/**
 * Calculate session statistics
 * @param {Array} sessions - Array of sessions with durationSeconds
 * @returns {{totalSeconds: number, totalHours: number}}
 */
function calculateSessionStats(sessions) {
  const totalSeconds = sessions.reduce((sum, s) => sum + s.durationSeconds, 0);
  const totalHours = Math.round(totalSeconds / 3600 * 10) / 10;
  return { totalSeconds, totalHours };
}

/**
 * Extract session data from legacy screenshot record
 * @param {Object} screenshot - Screenshot data
 * @param {Object} record - Analysis result record
 * @returns {{startTime: string, endTime: string, durationSeconds: number}|null}
 */
function extractLegacySession(screenshot, record) {
  const endTime = screenshot.end_time || screenshot.timestamp;
  const durationSeconds = screenshot.duration_seconds || record.time_spent_seconds || 300;
  const startTime = screenshot.start_time || (endTime ? new Date(new Date(endTime).getTime() - durationSeconds * 1000).toISOString() : null);

  if (!endTime) return null;
  return { startTime, endTime, durationSeconds };
}

// ============================================================================
// PUBLIC API
// ============================================================================

/**
 * Fetch project analytics data (Project Manager only)
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID for organization filtering
 * @param {string} projectKey - Jira Project Key
 * @returns {Promise<Object>} Project analytics data
 */
export async function fetchProjectAnalytics(accountId, cloudId, projectKey) {
  // Validate project key format
  if (!isValidProjectKey(projectKey)) {
    throw new Error('Invalid project key format');
  }

  // 1. Check Project Admin Permission or Jira Admin
  const { isAdmin, hasPermission } = await checkProjectAdminAccess(projectKey);

  if (!isAdmin && !hasPermission) {
    throw new Error(`Access denied: You are not an administrator for project ${projectKey}`);
  }

  const { supabaseConfig, organization } = await initializeContext(accountId, cloudId);

  // 2. Fetch Project Data - filter by organization_id
  const timeByProject = await supabaseRequest(
    supabaseConfig,
    `project_time_summary?organization_id=eq.${organization.id}&project_key=eq.${projectKey}&order=total_seconds.desc`
  );

  // Fetch issues for this project from activity_records
  const timeByIssue = await supabaseRequest(
    supabaseConfig,
    `activity_records?organization_id=eq.${organization.id}&project_key=eq.${projectKey}&status=in.(pending,processing,analyzed)&classification=in.(productive,unknown)&select=user_assigned_issue_key,user_id,duration_seconds,total_time_seconds&order=created_at.desc&limit=100`
  );

  return {
    timeByProject: timeByProject || [],
    timeByIssue: timeByIssue || [],
    scope: 'PROJECT',
    projectKey,
    organizationId: organization.id
  };
}

/**
 * Fetch team analytics for a specific project (Project Admin only)
 * Returns aggregated team time tracking data WITHOUT individual screenshots
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID for organization filtering
 * @param {string} projectKey - Jira Project Key
 * @param {string} [clientToday] - Client's local date as YYYY-MM-DD (avoids UTC mismatch with work_date)
 * @returns {Promise<Object>} Team analytics data for the project
 */
export async function fetchProjectTeamAnalytics(accountId, cloudId, projectKey, clientToday) {
  // Validate project key format
  if (!isValidProjectKey(projectKey)) {
    throw new Error('Invalid project key format');
  }

  // 1. Check Project Admin Permission or Jira Admin
  const { isAdmin, hasPermission } = await checkProjectAdminAccess(projectKey);

  if (!isAdmin && !hasPermission) {
    throw new Error(`Access denied: You are not an administrator for project ${projectKey}`);
  }

  const { supabaseConfig, organization } = await initializeContext(accountId, cloudId);

  // 2. Fetch Team Data - filter by organization_id
  const teamDailySummary = await supabaseRequest(
    supabaseConfig,
    `daily_time_summary?organization_id=eq.${organization.id}&project_key=eq.${projectKey}&order=work_date.desc&limit=${MAX_DAILY_SUMMARY_DAYS}`
  );

  const allUsers = await supabaseRequest(
    supabaseConfig,
    `users?organization_id=eq.${organization.id}&select=id,display_name,email,is_active`
  );

  // Get all unique users who have ever worked on this project (not just last 30 days)
  const allProjectUsers = await supabaseRequest(
    supabaseConfig,
    `daily_time_summary?organization_id=eq.${organization.id}&project_key=eq.${projectKey}&select=user_id&order=work_date.desc&limit=1000`
  );

  // Get time by issue from daily_time_summary (properly aggregated)
  const timeByIssueData = await supabaseRequest(
    supabaseConfig,
    `daily_time_summary?organization_id=eq.${organization.id}&project_key=eq.${projectKey}&task_key=not.is.null&select=task_key,user_id,total_seconds&order=work_date.desc&limit=2000`
  );

  // Aggregate time by issue (across all team members)
  const issueAggregation = {};
  (timeByIssueData || []).forEach(result => {
    const key = result.task_key;
    if (!issueAggregation[key]) {
      issueAggregation[key] = {
        issueKey: key,
        totalSeconds: 0,
        userIds: new Set()
      };
    }
    issueAggregation[key].totalSeconds += result.total_seconds || 0;
    if (result.user_id) {
      issueAggregation[key].userIds.add(result.user_id);
    }
  });

  const teamTimeByIssue = Object.values(issueAggregation)
    .map(item => {
      // Map user IDs to display names
      const contributorDetails = Array.from(item.userIds).map(userId => {
        const userInfo = (allUsers || []).find(u => u.id === userId);
        return {
          userId,
          displayName: userInfo?.display_name || userInfo?.email || 'Unknown User'
        };
      });
      
      return {
        issueKey: item.issueKey,
        totalSeconds: item.totalSeconds,
        contributors: item.userIds.size,
        contributorDetails
      };
    })
    .sort((a, b) => b.totalSeconds - a.totalSeconds)
    .slice(0, MAX_ISSUES_IN_ANALYTICS);

  // === Calculate Team Summary KPIs ===
  // Use client-provided date to avoid UTC vs local-date mismatch.
  // work_date in daily_time_summary stores the user's local date, so server-side
  // UTC calculations can be off by ±1 day near midnight.
  const now = new Date();
  const formatDateUTC = (d) => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  // Prefer client-supplied date; fall back to UTC for backwards compatibility
  const todayStr = (clientToday && /^\d{4}-\d{2}-\d{2}$/.test(clientToday))
    ? clientToday
    : formatDateUTC(now);
  const todayDate = new Date(todayStr + 'T00:00:00');
  const currentMonthStr = todayStr.substring(0, 7); // YYYY-MM

  // Calculate week start (Monday) from todayStr
  const dayOfWeek = todayDate.getDay();
  const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = new Date(todayDate);
  weekStart.setDate(todayDate.getDate() - daysToMonday);
  const weekStartStr = `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, '0')}-${String(weekStart.getDate()).padStart(2, '0')}`;

  // Filter data for this month
  const thisMonthData = (teamDailySummary || []).filter(day => {
    const workDate = typeof day.work_date === 'string' ? day.work_date.split('T')[0] : String(day.work_date);
    return workDate >= currentMonthStr;
  });

  // Total hours this month
  const totalSecondsThisMonth = thisMonthData.reduce((sum, d) => sum + (d.total_seconds || 0), 0);
  const totalHoursThisMonth = Math.round(totalSecondsThisMonth / 3600 * 10) / 10;

  // Active members (unique users who tracked time this month)
  const activeMembers = new Set(thisMonthData.map(d => d.user_id)).size;

  // Issues worked (unique issues this month)
  // Note: column is now 'task_key' in the view (was 'active_task_key')
  const issuesWorked = new Set(thisMonthData.map(d => d.task_key || d.active_task_key).filter(Boolean)).size;

  // Average hours per member
  const avgHoursPerMember = activeMembers > 0
    ? Math.round(totalHoursThisMonth / activeMembers * 10) / 10
    : 0;

  const teamSummary = {
    totalHoursThisMonth,
    activeMembers,
    issuesWorked,
    avgHoursPerMember
  };

  // === Calculate Team Member Activity (Today/Week/Month) ===
  // Use all project users, not just those in the last 30 days
  const projectUserIds = new Set([
    ...(teamDailySummary || []).map(d => d.user_id),
    ...(allProjectUsers || []).map(d => d.user_id)
  ]);

  const teamMemberActivity = Array.from(projectUserIds).map(userId => {
    const userInfo = (allUsers || []).find(u => u.id === userId);
    const displayName = userInfo?.display_name || userInfo?.email || 'Unknown User';

    const userDailyData = (teamDailySummary || []).filter(d => d.user_id === userId);

    // Today's hours
    const todayData = userDailyData.filter(d => {
      const workDate = typeof d.work_date === 'string' ? d.work_date.split('T')[0] : String(d.work_date);
      return workDate === todayStr;
    });
    const todaySeconds = todayData.reduce((sum, d) => sum + (d.total_seconds || 0), 0);
    const todayHours = Math.round(todaySeconds / 3600 * 10) / 10;

    // This week's hours
    const weekData = userDailyData.filter(d => {
      const workDate = typeof d.work_date === 'string' ? d.work_date.split('T')[0] : String(d.work_date);
      return workDate >= weekStartStr && workDate <= todayStr;
    });
    const weekSeconds = weekData.reduce((sum, d) => sum + (d.total_seconds || 0), 0);
    const weekHours = Math.round(weekSeconds / 3600 * 10) / 10;

    // This month's hours
    const monthData = userDailyData.filter(d => {
      const workDate = typeof d.work_date === 'string' ? d.work_date.split('T')[0] : String(d.work_date);
      return workDate >= currentMonthStr;
    });
    const monthSeconds = monthData.reduce((sum, d) => sum + (d.total_seconds || 0), 0);
    const monthHours = Math.round(monthSeconds / 3600 * 10) / 10;

    return {
      userId,
      displayName,
      todayHours,
      weekHours,
      monthHours
    };
  }).sort((a, b) => b.monthHours - a.monthHours);

  // === Calculate Daily Trend (Last 14 days) ===
  const trendDays = 14;
  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const trendData = [];
  for (let i = trendDays - 1; i >= 0; i--) {
    const date = new Date(todayDate);
    date.setDate(todayDate.getDate() - i);
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

    const dayData = (teamDailySummary || []).filter(d => {
      const workDate = typeof d.work_date === 'string' ? d.work_date.split('T')[0] : String(d.work_date);
      return workDate === dateStr;
    });
    const totalSeconds = dayData.reduce((sum, d) => sum + (d.total_seconds || 0), 0);
    const totalHours = Math.round(totalSeconds / 3600 * 10) / 10;

    trendData.push({
      date: dateStr,
      dayOfWeek: dayNames[date.getDay()],
      dayOfMonth: date.getDate(),
      totalHours
    });
  }

  return {
    teamSummary,
    teamMemberActivity,
    teamDailySummary: teamDailySummary || [],
    teamTimeByIssue,
    activityTrend: trendData,
    scope: 'TEAM',
    projectKey,
    organizationId: organization.id
  };
}

/**
 * Fetch team day timeline data for visualization
 * Returns screenshot timestamps grouped by user for a specific date
 * Uses the optimized idx_screenshots_org_user_work_date index
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID for organization filtering
 * @param {string} projectKey - Jira Project Key (optional, filters by project if provided)
 * @param {string} date - Date string in YYYY-MM-DD format
 * @returns {Promise<Object>} Timeline data with users and their activity sessions
 */

/**
 * Resolve whether the current user has permission to view the team timeline,
 * and return the list of projects they administer (empty for Jira admins).
 * User can view team timeline if they are Jira admin, project admin for the
 * specific project (if projectKey provided), or project admin for any project.
 */
async function resolveTeamPermissions(isAdmin, projectKey) {
  let hasPermission = isAdmin;
  let projectAdminProjects = [];

  if (!isAdmin) {
    const permissions = await checkUserPermissions(['ADMINISTER_PROJECTS'], projectKey || null);
    hasPermission = permissions.permissions?.ADMINISTER_PROJECTS?.havePermission;

    if (hasPermission) {
      projectAdminProjects = await getProjectsUserAdmins() || [];
      console.log('[TeamTimeline] Project admin projects:', projectAdminProjects);
    }
  }

  return { hasPermission, projectAdminProjects };
}

// Columns from the idle-time migration (20260325) — may not exist in older databases
const IDLE_COLUMNS = ',is_idle,idle_start_time,idle_end_time,reclassified_from,converted_issue_key';
const BASE_ACTIVITY_SELECT = 'id,user_id,start_time,end_time,duration_seconds,project_key,classification';

/**
 * Build the activity_records query string, including project/user OR-filter
 * for project admins who need to see their own data plus their admin projects.
 * @param {boolean} [includeIdleColumns=true] - Include idle-time columns in select
 */
function buildActivityQuery(orgId, date, filterByProjects, projectsToFilter, currentUserId, includeIdleColumns = true) {
  const selectClause = includeIdleColumns
    ? `${BASE_ACTIVITY_SELECT}${IDLE_COLUMNS}`
    : BASE_ACTIVITY_SELECT;
  let query = `activity_records?organization_id=eq.${orgId}&work_date=eq.${date}&select=${selectClause}&order=user_id,start_time.asc&limit=5000`;

  if (filterByProjects && projectsToFilter.length > 0) {
    if (currentUserId) {
      // Project admin: user's own records OR records from admin projects
      query += `&or=(user_id.eq.${currentUserId},project_key.in.(${projectsToFilter.join(',')}))`;
    } else {
      // Fallback: just filter by project (shouldn't happen)
      query += `&project_key=in.(${projectsToFilter.join(',')})`;
    }
  }

  return query;
}

/**
 * Build the legacy analysis_results query string with a ±1-day created_at buffer
 * for timezone differences. Scopes to the current user for non-admins.
 */
function buildLegacyQuery(orgId, date, isAdmin, currentUserId) {
  const legacyDateStart = new Date(`${date}T00:00:00.000Z`);
  legacyDateStart.setDate(legacyDateStart.getDate() - 1);
  const legacyDateEnd = new Date(`${date}T23:59:59.999Z`);
  legacyDateEnd.setDate(legacyDateEnd.getDate() + 1);

  let query = `analysis_results?organization_id=eq.${orgId}&work_type=eq.office&created_at=gte.${legacyDateStart.toISOString()}&created_at=lte.${legacyDateEnd.toISOString()}&select=user_id,time_spent_seconds,created_at,screenshots(start_time,end_time,duration_seconds,timestamp,work_date,project_key,deleted_at)&order=created_at.desc&limit=5000`;

  // For non-admins (project admins): restrict to their own records only.
  // Project-key filtering on the embedded screenshot data is applied in post-processing.
  if (!isAdmin && currentUserId) {
    query += `&user_id=eq.${currentUserId}`;
  }

  return query;
}

/** Build map: user_id → latest batch_end within the threshold window */
function buildLatestBatchByUserMap(recentActivity) {
  const latestBatchByUser = {};
  for (const r of (recentActivity || [])) {
    if (!latestBatchByUser[r.user_id] || r.batch_end > latestBatchByUser[r.user_id]) {
      latestBatchByUser[r.user_id] = r.batch_end;
    }
  }
  return latestBatchByUser;
}

/** Build lookup map: user_id → user record, to avoid O(n²) scanning */
function buildUserByIdMap(allUsers) {
  const userById = {};
  for (const u of (allUsers || [])) {
    if (u && u.id) userById[u.id] = u;
  }
  return userById;
}

export async function fetchTeamDayTimeline(accountId, cloudId, projectKey, date, permissionsOverride) {
  validateDateFormat(date);

  // Validate project key if provided
  if (projectKey && !isValidProjectKey(projectKey)) {
    throw new Error('Invalid project key format');
  }

  // Use pre-resolved permissions from the resolver when available to avoid duplicate Jira API calls.
  // Falls back to checking permissions directly if called without permissionsOverride.
  let isAdmin, isProjectAdmin;
  if (permissionsOverride) {
    isAdmin = permissionsOverride.isAdmin;
    isProjectAdmin = permissionsOverride.isProjectAdmin;
  } else {
    const perms = await checkUserPermissions(['ADMINISTER', 'ADMINISTER_PROJECTS'], projectKey || null);
    isAdmin = perms.permissions?.ADMINISTER?.havePermission || false;
    isProjectAdmin = perms.permissions?.ADMINISTER_PROJECTS?.havePermission || false;
  }

  if (!isAdmin && !isProjectAdmin) {
    throw new Error('Access denied: You do not have permission to view team timeline');
  }

  // For project admins, fetch their administered projects
  let projectAdminProjects = [];
  if (!isAdmin && isProjectAdmin) {
    projectAdminProjects = await getProjectsUserAdmins() || [];
    console.log('[TeamTimeline] Project admin projects:', projectAdminProjects);
  }

  const { supabaseConfig, organization } = await initializeContext(accountId, cloudId);

  // Security: If project admin but projectAdminProjects is empty, return empty results
  // to prevent accidental exposure of org-wide data when project discovery fails
  if (!isAdmin && projectAdminProjects.length === 0) {
    console.log('[TeamTimeline] Project admin with no discoverable projects - returning empty');
    return {
      date,
      projectKey: projectKey || null,
      organizationId: organization.id,
      usersWithActivity: [],
      usersWithoutActivity: [],
      totalUsers: 0,
      activeUsers: 0
    };
  }

  // Get current user's ID for filtering (project admins should always see their own data)
  let currentUserId = null;
  if (!isAdmin) {
    try {
      currentUserId = await getOrCreateUser(accountId, supabaseConfig, organization.id);
    } catch (err) {
      console.warn('[TeamTimeline] Could not resolve current user:', err.message);
    }
    console.log('[TeamTimeline] Current user resolved:', { orgId: organization.id, accountId, currentUserId });
  }

  // Determine projects to filter by:
  // - If specific projectKey provided, always filter by it (even for admins)
  // - Otherwise, project admins filter by their administered projects
  const projectsToFilter = projectKey ? [projectKey] : projectAdminProjects;
  const filterByProjects = !!projectKey || (!isAdmin && projectAdminProjects.length > 0);

  console.log('[TeamTimeline] Fetching timeline for date:', date, 'org:', organization.id,
    'filterByProjects:', filterByProjects, 'projectCount:', projectsToFilter.length,
    'currentUserId:', currentUserId, 'projectsToFilter:', projectsToFilter);

  const activityQuery = buildActivityQuery(organization.id, date, filterByProjects, projectsToFilter, currentUserId);
  const legacyQuery = buildLegacyQuery(organization.id, date, isAdmin, currentUserId);

  // Run all four queries in parallel. activity_records.batch_end is updated every 5 min
  // during active tracking (vs desktop_last_heartbeat every 4h) — used to compute a more
  // accurate effectiveLastActive signal for status dots.
  const activityThreshold = new Date(Date.now() - 270 * 60 * 1000).toISOString();

  // Fetch activity records with fallback: if idle-time columns don't exist yet
  // (migration 20260325 not applied), retry with base columns only.
  let activityRecords;
  try {
    activityRecords = await supabaseRequest(supabaseConfig, activityQuery);
  } catch (err) {
    console.warn('[TeamTimeline] Activity query failed (idle columns may not exist), retrying with base columns:', err.message);
    const fallbackQuery = buildActivityQuery(organization.id, date, filterByProjects, projectsToFilter, currentUserId, false);
    activityRecords = await supabaseRequest(supabaseConfig, fallbackQuery).catch(() => []);
  }

  const [legacyScreenshots, allUsers, recentActivity] = await Promise.all([
    supabaseRequest(supabaseConfig, legacyQuery),
    supabaseRequest(
      supabaseConfig,
      `users?organization_id=eq.${organization.id}&select=id,display_name,email,desktop_logged_in,desktop_last_heartbeat`
    ),
    supabaseRequest(
      supabaseConfig,
      `activity_records?organization_id=eq.${organization.id}&batch_end=gt.${activityThreshold}&select=user_id,batch_end`
    )
  ]);

  console.log('[TeamTimeline] Found activity records count:', activityRecords?.length || 0);
  console.log('[TeamTimeline] Found legacy screenshots count:', legacyScreenshots?.length || 0);
  console.log('[TeamTimeline] Found users count:', allUsers?.length || 0);

  const latestBatchByUser = buildLatestBatchByUserMap(recentActivity);
  const userById = buildUserByIdMap(allUsers);

  // Helper: effective last active = MAX(desktop_last_heartbeat, latest batch_end)
  const getEffectiveLastActive = (userId, heartbeat) => {
    const hb = heartbeat ? new Date(heartbeat) : null;
    const ba = latestBatchByUser[userId] ? new Date(latestBatchByUser[userId]) : null;
    if (hb && ba) return new Date(Math.max(hb.getTime(), ba.getTime())).toISOString();
    return (hb || ba)?.toISOString() || null;
  };

  // Group activity records by user
  const userTimelineMap = {};

  (activityRecords || []).forEach(record => {
    const userId = record.user_id;

    if (!userTimelineMap[userId]) {
      const userInfo = userById[userId];
      userTimelineMap[userId] = {
        userId,
        displayName: userInfo?.display_name || userInfo?.email || 'Unknown User',
        desktopLoggedIn: userInfo?.desktop_logged_in || false,
        lastHeartbeat: userInfo?.desktop_last_heartbeat,
        effectiveLastActive: getEffectiveLastActive(userId, userInfo?.desktop_last_heartbeat),
        sessions: [],
        idleBlocks: []
      };
    }

    // Separate idle blocks from work sessions
    if (record.is_idle) {
      userTimelineMap[userId].idleBlocks.push({
        id: record.id,
        startTime: record.idle_start_time || record.start_time,
        endTime: record.idle_end_time || record.end_time,
        durationSeconds: record.duration_seconds || 0,
        classification: record.classification,
        convertedIssueKey: record.converted_issue_key || null,
        reclassifiedFrom: record.reclassified_from || null
      });
    } else {
      // Add session with start_time, end_time for accurate timeline rendering
      // duration_seconds = accumulated real work time (not simply end_time - start_time)
      userTimelineMap[userId].sessions.push({
        startTime: record.start_time,
        endTime: record.end_time,
        durationSeconds: record.duration_seconds || 0
      });
    }
  });

  // Also process legacy data from analysis_results (with embedded screenshots)
  // The query returns analysis_results with nested screenshots object
  // We filter by date here since PostgREST nested filtering is limited
  const targetDateStart = new Date(`${date}T00:00:00Z`).getTime();
  const targetDateEnd = new Date(`${date}T23:59:59Z`).getTime();
  
  (legacyScreenshots || []).forEach(record => {
    const userId = record.user_id;
    const screenshot = record.screenshots; // Embedded screenshot data
    
    if (!screenshot) return; // Skip if no screenshot data
    if (screenshot.deleted_at) return; // Skip deleted screenshots
    
    // Filter by date: check work_date first, then timestamp
    const screenshotWorkDate = screenshot.work_date;
    const screenshotTimestamp = screenshot.timestamp ? new Date(screenshot.timestamp).getTime() : null;
    
    // Match if work_date equals target date, OR timestamp is within target date range
    const matchesDate = (screenshotWorkDate && screenshotWorkDate === date) || 
                        (!screenshotWorkDate && screenshotTimestamp && 
                         screenshotTimestamp >= targetDateStart && screenshotTimestamp <= targetDateEnd);
    
    if (!matchesDate) return; // Skip if not matching target date

    // Apply project filter in post-processing for admins who requested a specific project view.
    // (Non-admin queries are already scoped to user_id server-side, so no additional filter needed.)
    if (isAdmin && filterByProjects && projectsToFilter.length > 0) {
      const projectKey = screenshot.project_key;
      if (!projectKey || !projectsToFilter.includes(projectKey)) return;
    }

    if (!userTimelineMap[userId]) {
      const userInfo = userById[userId];
      userTimelineMap[userId] = {
        userId,
        displayName: userInfo?.display_name || userInfo?.email || 'Unknown User',
        desktopLoggedIn: userInfo?.desktop_logged_in || false,
        lastHeartbeat: userInfo?.desktop_last_heartbeat,
        effectiveLastActive: getEffectiveLastActive(userId, userInfo?.desktop_last_heartbeat),
        sessions: [],
        idleBlocks: []
      };
    }

    // Extract session data from legacy screenshot
    const session = extractLegacySession(screenshot, record);
    if (session) {
      userTimelineMap[userId].sessions.push(session);
    }
  });

  // Convert to array and calculate stats
  const userTimelines = Object.values(userTimelineMap).map(user => {
    // Sort sessions by start time to ensure correct timeline order
    sortSessionsByStartTime(user.sessions);

    // Calculate total tracked time for the day
    const { totalHours } = calculateSessionStats(user.sessions);

    // Find first and last activity
    const firstSession = user.sessions[0];
    const lastSession = user.sessions[user.sessions.length - 1];

    return {
      ...user,
      totalHours,
      totalSessions: user.sessions.length,
      firstActivity: firstSession?.startTime || null,
      lastActivity: lastSession?.endTime || null
    };
  });

  // Sort by total hours (most active first)
  userTimelines.sort((a, b) => b.totalHours - a.totalHours);

  // Log aggregate stats only - avoid PII (user IDs, names, emails) in logs
  const totalSessionsAcrossUsers = userTimelines.reduce((sum, u) => sum + (u.totalSessions || 0), 0);
  console.log('[TeamTimeline] Users with activity:', userTimelines.length, 'Total sessions:', totalSessionsAcrossUsers);

  // Also include users who haven't tracked time but are in the organization
  // For project admins, don't show all inactive users - only show users with activity on their projects
  const usersWithActivity = new Set(userTimelines.map(u => u.userId));
  let inactiveUsers = [];
  
  if (!filterByProjects) {
    // Jira admins see all inactive organization users
    inactiveUsers = (allUsers || [])
      .filter(u => !usersWithActivity.has(u.id))
      .map(u => ({
        userId: u.id,
        displayName: u.display_name || u.email || 'Unknown User',
        desktopLoggedIn: u.desktop_logged_in || false,
        lastHeartbeat: u.desktop_last_heartbeat,
        effectiveLastActive: getEffectiveLastActive(u.id, u.desktop_last_heartbeat),
        sessions: [],
        totalHours: 0,
        totalSessions: 0,
        firstActivity: null,
        lastActivity: null
      }));
  }
  // Project admins: inactive users list is empty - they only see users with activity on their projects

  console.log('[TeamTimeline] Users without activity:', inactiveUsers.length);

  // Fetch work hours config for the timeline response and server-side filtering
  const workHoursConfig = await fetchWorkHoursConfig(supabaseConfig, organization.id);

  // Filter idle blocks by work hours (defense-in-depth)
  userTimelines.forEach(user => {
    user.idleBlocks = filterIdleBlocksByWorkHours(user.idleBlocks || [], workHoursConfig);
  });

  return {
    date,
    projectKey: projectKey || null,
    organizationId: organization.id,
    workHours: workHoursConfig,
    usersWithActivity: userTimelines,
    usersWithoutActivity: inactiveUsers,
    totalUsers: userTimelines.length + inactiveUsers.length,
    activeUsers: userTimelines.length
  };
}

/**
 * Fetch current user's own day timeline data for visualization
 * Available to ALL users - shows only their own data
 * Uses the optimized idx_screenshots_org_user_work_date index
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID for organization filtering
 * @param {string} date - Date string in YYYY-MM-DD format
 * @returns {Promise<Object>} Timeline data for the current user
 */
export async function fetchMyDayTimeline(accountId, cloudId, date) {
  validateDateFormat(date);

  const { supabaseConfig, organization } = await initializeContext(accountId, cloudId);

  // Get current user's ID using the reliable getOrCreateUser helper
  // (raw users table query can fail when user's organization_id is stale)
  let userId;
  try {
    userId = await getOrCreateUser(accountId, supabaseConfig, organization.id);
  } catch (err) {
    console.warn('[MyTimeline] Could not resolve current user:', err.message);
  }

  if (!userId) {
    // User not found, return empty timeline
    return {
      date,
      userId: null,
      displayName: 'Unknown User',
      sessions: [],
      idleBlocks: [],
      totalHours: 0,
      totalSessions: 0,
      firstActivity: null,
      lastActivity: null
    };
  }

  // Fetch display name separately (getOrCreateUser only returns the UUID)
  let displayName = 'User';
  try {
    const userInfo = await supabaseRequest(
      supabaseConfig,
      `users?id=eq.${userId}&select=display_name,email&limit=1`
    );
    if (userInfo?.[0]) {
      displayName = userInfo[0].display_name || userInfo[0].email || 'User';
    }
  } catch (err) {
    console.warn('[MyTimeline] Could not fetch user display name:', err.message);
  }

  // Fetch activity records for current user on the specified date
  // All classifications included — timeline shows all activity to indicate user presence
  const idleSelect = `${BASE_ACTIVITY_SELECT}${IDLE_COLUMNS}`.replace('user_id,', '');
  const baseSelect = BASE_ACTIVITY_SELECT.replace('user_id,', '');
  const activityQuery = `activity_records?organization_id=eq.${organization.id}&user_id=eq.${userId}&work_date=eq.${date}&select=${idleSelect}&order=start_time.asc&limit=500`;
  const activityFallbackQuery = `activity_records?organization_id=eq.${organization.id}&user_id=eq.${userId}&work_date=eq.${date}&select=${baseSelect}&order=start_time.asc&limit=500`;

  // Also fetch legacy data from analysis_results (work_type='office' only)
  // Query analysis_results and embed screenshot data - filter by date in code
  const legacyQuery = `analysis_results?organization_id=eq.${organization.id}&user_id=eq.${userId}&work_type=eq.office&select=time_spent_seconds,screenshots(start_time,end_time,duration_seconds,timestamp,work_date,deleted_at)&order=created_at.desc&limit=500`;

  // Fetch activity records with fallback: if idle-time columns don't exist yet
  // (migration 20260325 not applied), retry with base columns only.
  let activityRecords;
  try {
    activityRecords = await supabaseRequest(supabaseConfig, activityQuery);
  } catch (err) {
    console.warn('[MyTimeline] Activity query failed (idle columns may not exist), retrying with base columns:', err.message);
    activityRecords = await supabaseRequest(supabaseConfig, activityFallbackQuery).catch(() => []);
  }

  const [legacyRecords] = await Promise.all([
    supabaseRequest(supabaseConfig, legacyQuery)
  ]);

  // Build sessions and idle blocks from activity records
  const sessions = [];
  const idleBlocks = [];
  
  (activityRecords || []).forEach(record => {
    if (record.is_idle) {
      idleBlocks.push({
        id: record.id,
        startTime: record.idle_start_time || record.start_time,
        endTime: record.idle_end_time || record.end_time,
        durationSeconds: record.duration_seconds || 0,
        classification: record.classification,
        convertedIssueKey: record.converted_issue_key || null,
        reclassifiedFrom: record.reclassified_from || null
      });
    } else {
      sessions.push({
        startTime: record.start_time,
        endTime: record.end_time,
        durationSeconds: record.duration_seconds || 0
      });
    }
  });

  // Add legacy sessions from analysis_results (with embedded screenshots)
  // Filter by date in code since PostgREST nested filtering is limited
  const targetDateStart = new Date(`${date}T00:00:00Z`).getTime();
  const targetDateEnd = new Date(`${date}T23:59:59Z`).getTime();
  
  (legacyRecords || []).forEach(record => {
    const screenshot = record.screenshots; // Embedded screenshot data
    if (!screenshot) return;
    if (screenshot.deleted_at) return; // Skip deleted screenshots
    
    // Filter by date: check work_date first, then timestamp
    const screenshotWorkDate = screenshot.work_date;
    const screenshotTimestamp = screenshot.timestamp ? new Date(screenshot.timestamp).getTime() : null;
    
    const matchesDate = (screenshotWorkDate && screenshotWorkDate === date) || 
                        (!screenshotWorkDate && screenshotTimestamp && 
                         screenshotTimestamp >= targetDateStart && screenshotTimestamp <= targetDateEnd);
    
    if (!matchesDate) return;
    
    // Extract session data from legacy screenshot
    const session = extractLegacySession(screenshot, record);
    if (session) {
      sessions.push(session);
    }
  });

  // Sort sessions by start time
  sortSessionsByStartTime(sessions);

  if (sessions.length === 0 && idleBlocks.length === 0) {
    const workHoursConfig = await fetchWorkHoursConfig(supabaseConfig, organization.id);
    return {
      date,
      userId,
      displayName,
      sessions: [],
      idleBlocks: [],
      workHours: workHoursConfig,
      totalHours: 0,
      totalSessions: 0,
      firstActivity: null,
      lastActivity: null
    };
  }

  // Calculate stats
  const { totalHours } = calculateSessionStats(sessions);

  // Fetch work hours config and filter idle blocks (defense-in-depth)
  const workHoursConfig = await fetchWorkHoursConfig(supabaseConfig, organization.id);
  const filteredIdleBlocks = filterIdleBlocksByWorkHours(idleBlocks, workHoursConfig);

  return {
    date,
    userId,
    displayName,
    sessions,
    idleBlocks: filteredIdleBlocks,
    workHours: workHoursConfig,
    totalHours,
    totalSessions: sessions.length,
    firstActivity: sessions[0]?.startTime || null,
    lastActivity: sessions[sessions.length - 1]?.endTime || null
  };
}

/**
 * Convert an idle block into a worklog by updating the activity record
 * and optionally syncing to Jira.
 * @param {string} accountId - Atlassian account ID (must own the record)
 * @param {string} cloudId - Jira Cloud ID
 * @param {string} idleRecordId - UUID of the idle activity_record
 * @param {string} issueKey - Jira issue key to assign the worklog to
 * @param {string} reason - User-provided reason / work description
 * @returns {Promise<Object>} Updated record info
 */
export async function convertIdleToWorklog(accountId, cloudId, idleRecordId, issueKey, reason) {
  if (!idleRecordId || !issueKey || !reason) {
    throw new Error('idleRecordId, issueKey, and reason are required');
  }

  const { supabaseConfig, organization } = await initializeContext(accountId, cloudId);

  // Get the current user's Supabase ID
  const currentUser = await supabaseRequest(
    supabaseConfig,
    `users?organization_id=eq.${organization.id}&atlassian_account_id=eq.${accountId}&select=id&limit=1`
  );
  if (!currentUser || currentUser.length === 0) {
    throw new Error('User not found');
  }
  const userId = currentUser[0].id;

  // Fetch the idle record and verify ownership
  const records = await supabaseRequest(
    supabaseConfig,
    `activity_records?id=eq.${idleRecordId}&select=id,user_id,is_idle,classification,duration_seconds,idle_start_time,idle_end_time,reclassified_from`
  );
  if (!records || records.length === 0) {
    throw new Error('Idle record not found');
  }
  const record = records[0];
  if (record.user_id !== userId) {
    throw new Error('Access denied: you can only convert your own idle blocks');
  }
  if (!record.is_idle) {
    throw new Error('Record is not an idle block');
  }
  if (record.reclassified_from) {
    throw new Error('This idle block has already been converted');
  }

  // Update the activity record
  const now = new Date().toISOString();
  const updatePayload = {
    classification: 'productive',
    reclassified_from: record.classification,
    reclassified_at: now,
    reclassified_by: accountId,
    reclassification_reason: reason,
    converted_issue_key: issueKey
  };

  const updateResult = await supabaseRequest(
    supabaseConfig,
    `activity_records?id=eq.${idleRecordId}`,
    { method: 'PATCH', body: updatePayload }
  );

  return {
    id: idleRecordId,
    issueKey,
    durationSeconds: record.duration_seconds,
    idleStartTime: record.idle_start_time || null,
    convertedAt: now
  };
}

/**
 * Get the project_key of an idle record so the resolver can create an issue in the right project.
 */
export async function getIdleRecordProjectKey(accountId, cloudId, idleRecordId) {
  const { supabaseConfig } = await initializeContext(accountId, cloudId);
  const records = await supabaseRequest(
    supabaseConfig,
    `activity_records?id=eq.${idleRecordId}&select=project_key&limit=1`
  );
  return records?.[0]?.project_key || null;
}
