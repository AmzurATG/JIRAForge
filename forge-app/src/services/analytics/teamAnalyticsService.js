/**
 * Team Analytics Service
 * Handles project-level and team analytics
 */

import { getSupabaseConfig, getOrCreateOrganization, supabaseRequest } from '../../utils/supabase.js';
import { checkUserPermissions, isJiraAdmin, getProjectsUserAdmins } from '../../utils/jira.js';
import { MAX_DAILY_SUMMARY_DAYS, MAX_ISSUES_IN_ANALYTICS } from '../../config/constants.js';
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
  const isAdmin = await isJiraAdmin();
  const permissions = await checkUserPermissions(['ADMINISTER_PROJECTS'], projectKey);
  const hasPermission = permissions.permissions?.ADMINISTER_PROJECTS?.havePermission;
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
 * @returns {Promise<Object>} Team analytics data for the project
 */
export async function fetchProjectTeamAnalytics(accountId, cloudId, projectKey) {
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
  // Use UTC methods to ensure consistent date calculations regardless of server timezone
  const now = new Date();
  const formatDate = (d) => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const todayStr = formatDate(now);
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const currentMonthStr = formatDate(currentMonthStart);

  // Calculate week start (Monday)
  const weekStart = new Date(now);
  const dayOfWeek = weekStart.getUTCDay();
  const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  weekStart.setUTCDate(weekStart.getUTCDate() - daysToMonday);
  const weekStartStr = formatDate(weekStart);

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
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() - i);
    const dateStr = formatDate(date);

    const dayData = (teamDailySummary || []).filter(d => {
      const workDate = typeof d.work_date === 'string' ? d.work_date.split('T')[0] : String(d.work_date);
      return workDate === dateStr;
    });
    const totalSeconds = dayData.reduce((sum, d) => sum + (d.total_seconds || 0), 0);
    const totalHours = Math.round(totalSeconds / 3600 * 10) / 10;

    trendData.push({
      date: dateStr,
      dayOfWeek: dayNames[date.getUTCDay()],
      dayOfMonth: date.getUTCDate(),
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

/**
 * Build the activity_records query string, including project/user OR-filter
 * for project admins who need to see their own data plus their admin projects.
 */
function buildActivityQuery(orgId, date, filterByProjects, projectsToFilter, currentUserId) {
  let query = `activity_records?organization_id=eq.${orgId}&work_date=eq.${date}&select=user_id,start_time,end_time,duration_seconds,project_key&order=user_id,start_time.asc&limit=5000`;

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

export async function fetchTeamDayTimeline(accountId, cloudId, projectKey, date) {
  validateDateFormat(date);

  // Validate project key if provided
  if (projectKey && !isValidProjectKey(projectKey)) {
    throw new Error('Invalid project key format');
  }

  const isAdmin = await isJiraAdmin();
  const { hasPermission, projectAdminProjects } = await resolveTeamPermissions(isAdmin, projectKey);

  if (!hasPermission) {
    throw new Error('Access denied: You do not have permission to view team timeline');
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
    const currentUserResult = await supabaseRequest(
      supabaseConfig,
      `users?organization_id=eq.${organization.id}&atlassian_account_id=eq.${accountId}&select=id&limit=1`
    );
    currentUserId = currentUserResult?.[0]?.id || null;
  }

  // Determine projects to filter by:
  // - If specific projectKey provided, always filter by it (even for admins)
  // - Otherwise, project admins filter by their administered projects
  const projectsToFilter = projectKey ? [projectKey] : projectAdminProjects;
  const filterByProjects = !!projectKey || (!isAdmin && projectAdminProjects.length > 0);

  console.log('[TeamTimeline] Fetching timeline for date:', date, 'org:', organization.id,
    'filterByProjects:', filterByProjects, 'projectCount:', projectsToFilter.length);

  const activityQuery = buildActivityQuery(organization.id, date, filterByProjects, projectsToFilter, currentUserId);
  const legacyQuery = buildLegacyQuery(organization.id, date, isAdmin, currentUserId);

  // Run all four queries in parallel. activity_records.batch_end is updated every 5 min
  // during active tracking (vs desktop_last_heartbeat every 4h) — used to compute a more
  // accurate effectiveLastActive signal for status dots.
  const activityThreshold = new Date(Date.now() - 270 * 60 * 1000).toISOString();
  const [activityRecords, legacyScreenshots, allUsers, recentActivity] = await Promise.all([
    supabaseRequest(supabaseConfig, activityQuery),
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
        sessions: []
      };
    }

    // Add session with start_time, end_time for accurate timeline rendering
    // duration_seconds = accumulated real work time (not simply end_time - start_time)
    userTimelineMap[userId].sessions.push({
      startTime: record.start_time,
      endTime: record.end_time,
      durationSeconds: record.duration_seconds || 0
    });
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
        sessions: []
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

  return {
    date,
    projectKey: projectKey || null,
    organizationId: organization.id,
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

  // Get current user's ID from their Supabase record
  const currentUser = await supabaseRequest(
    supabaseConfig,
    `users?organization_id=eq.${organization.id}&atlassian_account_id=eq.${accountId}&select=id,display_name,email&limit=1`
  );

  if (!currentUser || currentUser.length === 0) {
    // User not found, return empty timeline
    return {
      date,
      userId: null,
      displayName: 'Unknown User',
      sessions: [],
      totalHours: 0,
      totalSessions: 0,
      firstActivity: null,
      lastActivity: null
    };
  }

  const userId = currentUser[0].id;
  const displayName = currentUser[0].display_name || currentUser[0].email || 'User';

  // Fetch activity records for current user on the specified date
  // All classifications included — timeline shows all activity to indicate user presence
  const activityQuery = `activity_records?organization_id=eq.${organization.id}&user_id=eq.${userId}&work_date=eq.${date}&select=start_time,end_time,duration_seconds&order=start_time.asc&limit=500`;

  // Also fetch legacy data from analysis_results (work_type='office' only)
  // Query analysis_results and embed screenshot data - filter by date in code
  const legacyQuery = `analysis_results?organization_id=eq.${organization.id}&user_id=eq.${userId}&work_type=eq.office&select=time_spent_seconds,screenshots(start_time,end_time,duration_seconds,timestamp,work_date,deleted_at)&order=created_at.desc&limit=500`;

  const [activityRecords, legacyRecords] = await Promise.all([
    supabaseRequest(supabaseConfig, activityQuery),
    supabaseRequest(supabaseConfig, legacyQuery)
  ]);

  // Build sessions from activity records
  const sessions = [];
  
  (activityRecords || []).forEach(record => {
    sessions.push({
      startTime: record.start_time,
      endTime: record.end_time,
      durationSeconds: record.duration_seconds || 0
    });
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

  if (sessions.length === 0) {
    return {
      date,
      userId,
      displayName,
      sessions: [],
      totalHours: 0,
      totalSessions: 0,
      firstActivity: null,
      lastActivity: null
    };
  }

  // Calculate stats
  const { totalHours } = calculateSessionStats(sessions);

  return {
    date,
    userId,
    displayName,
    sessions,
    totalHours,
    totalSessions: sessions.length,
    firstActivity: sessions[0]?.startTime || null,
    lastActivity: sessions[sessions.length - 1]?.endTime || null
  };
}
