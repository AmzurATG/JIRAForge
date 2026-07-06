/**
 * Team Analytics Service
 * Handles project-level and team analytics
 */

import { getSupabaseConfig, getOrCreateOrganization, getOrCreateUser, supabaseRequest } from '../../utils/supabase.js';
import { checkUserPermissions, getProjectsUserAdmins } from '../../utils/jira.js';
import { MAX_DAILY_SUMMARY_DAYS, MAX_ISSUES_IN_ANALYTICS, DEFAULT_TRACKING_SETTINGS, TEAM_ANALYTICS_CACHE_TTL_MS, MAX_PAGINATED_PAGES } from '../../config/constants.js';
import { isValidProjectKey } from '../../utils/validators.js';
import { kvs } from '@forge/kvs';
import api, { route } from '@forge/api';

// Supabase PostgREST max_rows is 1000 - queries returning more must paginate
const SUPABASE_PAGE_SIZE = 1000;

/**
 * Fetch all records from Supabase by paginating through results.
 * PostgREST enforces max_rows=1000, so queries expecting more must paginate.
 *
 * Page 1 is fetched first so single-page queries (the common case) don't pay
 * for speculative parallel requests. If page 1 is full, the remaining pages
 * up to `maxRecords` are fired in parallel — collapsing what used to be N
 * sequential ~300–500ms round-trips into a single round-trip's worth of
 * wall-clock latency. This is what keeps the team-analytics export inside
 * Forge's 25s synchronous-resolver budget on busy months.
 *
 * @param {Object} supabaseConfig
 * @param {string} baseEndpoint - Query string WITHOUT limit/offset (e.g. 'activity_records?org=eq.x&...')
 * @param {number} [maxRecords] - Safety cap to prevent runaway fetches
 * @returns {Promise<Array>} All matching records, in the order returned by Supabase
 */
async function supabaseRequestPaginated(supabaseConfig, baseEndpoint, maxRecords = MAX_PAGINATED_PAGES * 1000) {
  const firstPage = await supabaseRequest(
    supabaseConfig,
    `${baseEndpoint}&limit=${SUPABASE_PAGE_SIZE}&offset=0`
  );
  if (!firstPage || firstPage.length < SUPABASE_PAGE_SIZE) {
    return firstPage || [];
  }

  // Page 0 was full → there may be more. Fire all remaining pages in parallel.
  // Wasted requests on partially-filled tail pages return quickly (empty arrays),
  // so the only cost is one round-trip's worth of latency regardless of page count.
  const maxPages = Math.ceil(maxRecords / SUPABASE_PAGE_SIZE);
  const restPromises = [];
  for (let page = 1; page < maxPages; page++) {
    const offset = page * SUPABASE_PAGE_SIZE;
    restPromises.push(
      supabaseRequest(
        supabaseConfig,
        `${baseEndpoint}&limit=${SUPABASE_PAGE_SIZE}&offset=${offset}`
      ).catch(err => {
        console.warn(`[TeamAnalytics] Parallel page ${page} failed:`, err.message);
        return [];
      })
    );
  }
  const restPages = await Promise.all(restPromises);

  // Merge in page order. Stop as soon as we hit a short or empty page —
  // beyond that, parallel pages may have queried offsets past the real
  // result set (they'd return empty), and including them is wasted work.
  const allRecords = [...firstPage];
  for (const page of restPages) {
    if (!page || page.length === 0) break;
    allRecords.push(...page);
    if (page.length < SUPABASE_PAGE_SIZE) break;
  }

  if (allRecords.length >= maxRecords) {
    console.warn(`[TeamAnalytics] Paginated fetch hit maxRecords cap (${maxRecords}) for query: ${baseEndpoint.substring(0, 100)}... — export may be truncated; consider raising MAX_PAGINATED_PAGES.`);
  }

  return allRecords;
}

// Chunk the user_id IN-list so a single query never grows unbounded with team
// size. The forge-app → ai-server hop is body-encoded (no URL limit), but the
// downstream Supabase/PostgREST request still imposes practical limits on the
// IN-list size and request payload. 100 UUIDs (~3.7KB) keeps us comfortably
// under those limits and bounds Forge runtime memory per chunk.
const EXPORT_USER_CHUNK_SIZE = 100;

/**
 * CSV-side equivalent of the renderer's formatSessionRange helper. Sessions in
 * the CSV are already pre-formatted as "9:54 AM" strings (no ISO timestamps),
 * so we only need to read the first/last and append the session count when
 * multiple sessions collapse into one (date, issue) row — otherwise the
 * "9:54 AM - 11:15 PM (2m total)" line looks wrong on its face.
 */
function formatCsvSessionRange(sessions) {
  if (!sessions || sessions.length === 0) return '';
  const firstStart = sessions[0].startTime;
  const lastEnd = sessions[sessions.length - 1].endTime;
  if (!firstStart || !lastEnd) return '';
  const range = `${firstStart} - ${lastEnd}`;
  return sessions.length > 1 ? `${range} (${sessions.length} sessions)` : range;
}

/**
 * Fetch activity_records for many users at once, returning a Map keyed by
 * user_id. Replaces the legacy one-query-per-member pattern that caused
 * Forge's 25s timeout to fire on multi-project / large-team exports.
 *
 * Chunks the user_id list and runs chunks in parallel; an empty userIds array
 * returns an empty Map without making any network calls.
 *
 * @param {Object} supabaseConfig
 * @param {string} organizationId
 * @param {string[]} userIds
 * @param {string|null} projectKey - Project key (ignored when mode is 'unassignedOnly')
 * @param {string} startDate - YYYY-MM-DD
 * @param {string} endDate - YYYY-MM-DD
 * @param {string} [mode='projectWithUnassigned']
 *   - 'projectWithUnassigned': match project_key=projectKey OR project_key IS NULL (default;
 *      makes single-project export totals match the Member Summary).
 *   - 'projectOnly': match only project_key=projectKey (used in multi-project export so
 *      NULL-project records aren't duplicated into every project section).
 *   - 'unassignedOnly': match only project_key IS NULL (used to render the synthetic
 *      "Unassigned (All Projects)" section exactly once in multi-project export).
 * @returns {Promise<Map<string, Array>>}
 */
async function fetchActivityRecordsBatched(supabaseConfig, organizationId, userIds, projectKey, startDate, endDate, mode = 'projectWithUnassigned') {
  const recordsByUser = new Map();
  if (!userIds || userIds.length === 0) return recordsByUser;

  const chunkPromises = [];
  for (let i = 0; i < userIds.length; i += EXPORT_USER_CHUNK_SIZE) {
    const chunk = userIds.slice(i, i + EXPORT_USER_CHUNK_SIZE);
    let chunkQuery =
      `activity_records?organization_id=eq.${organizationId}` +
      `&user_id=in.(${chunk.join(',')})` +
      `&work_date=gte.${startDate}&work_date=lte.${endDate}` +
      `&status=in.(pending,processing,analyzed)` +
      `&select=user_id,user_assigned_issue_key,work_date,start_time,end_time,duration_seconds,classification` +
      `&order=user_id.asc,work_date.asc,start_time.asc,id.asc`;

    if (mode === 'unassignedOnly') {
      chunkQuery += `&project_key=is.null`;
    } else if (mode === 'projectOnly') {
      if (projectKey && projectKey !== 'null') {
        chunkQuery += `&project_key=eq.${projectKey}`;
      }
    } else {
      // 'projectWithUnassigned' (default): legacy single-project behavior
      if (projectKey && projectKey !== 'null') {
        chunkQuery += `&or=(project_key.eq.${projectKey},project_key.is.null)`;
      }
    }

    chunkPromises.push(
      supabaseRequestPaginated(supabaseConfig, chunkQuery).catch(err => {
        console.error(`[TeamExport] Batched activity_records fetch failed (chunk size ${chunk.length}):`, err.message);
        return [];
      })
    );
  }

  const chunkResults = await Promise.all(chunkPromises);
  for (const records of chunkResults) {
    for (const r of records) {
      const bucket = recordsByUser.get(r.user_id);
      if (bucket) {
        bucket.push(r);
      } else {
        recordsByUser.set(r.user_id, [r]);
      }
    }
  }

  return recordsByUser;
}

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
 * NOTE: Timestamps are stored in UTC. We must convert to the user's local timezone
 * before comparing against work hours (which are in local time).
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

    // Convert UTC time to user's local timezone for work hours comparison.
    // Forge runs in UTC, so getHours()/getDay() would return UTC values.
    const tz = block.userTimezone || 'UTC';
    let localHour, localMinute, localDay;
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: tz,
        hour: 'numeric', minute: 'numeric', weekday: 'short',
        hour12: false
      }).formatToParts(dt);
      localHour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
      localMinute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
      const weekdayStr = parts.find(p => p.type === 'weekday')?.value || '';
      const dayMap = { Sun: 7, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
      localDay = dayMap[weekdayStr] || ((dt.getUTCDay() === 0 ? 7 : dt.getUTCDay()));
    } catch {
      // Fallback to UTC if timezone is invalid
      localHour = dt.getUTCHours();
      localMinute = dt.getUTCMinutes();
      const utcDay = dt.getUTCDay();
      localDay = utcDay === 0 ? 7 : utcDay;
    }

    const blockMin = localHour * 60 + localMinute;

    if (startMin <= endMin) {
      // Normal schedule
      return workDays.includes(localDay) && blockMin >= startMin && blockMin <= endMin;
    } else {
      // Cross-midnight
      if (blockMin >= startMin) return workDays.includes(localDay);
      if (blockMin <= endMin) {
        const prevDay = localDay > 1 ? localDay - 1 : 7;
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

  // Fetch issues for this project from activity_records (all classifications)
  const timeByIssue = await supabaseRequest(
    supabaseConfig,
    `activity_records?organization_id=eq.${organization.id}&project_key=eq.${projectKey}&status=in.(pending,processing,analyzed)&select=user_assigned_issue_key,user_id,duration_seconds,total_time_seconds,classification&order=created_at.desc&limit=100`
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
 * @param {Object} [permissionsOverride] - Pre-resolved permissions from resolver to avoid duplicate Jira calls
 * @returns {Promise<Object>} Team analytics data for the project
 */
export async function fetchProjectTeamAnalytics(accountId, cloudId, projectKey, clientToday, permissionsOverride) {
  const t0 = Date.now();

  if (!isValidProjectKey(projectKey)) {
    throw new Error('Invalid project key format');
  }

  let isAdmin;
  let hasPermission;
  if (permissionsOverride) {
    isAdmin = permissionsOverride.isAdmin;
    hasPermission = permissionsOverride.hasPermission;
  } else {
    const resolved = await checkProjectAdminAccess(projectKey);
    isAdmin = resolved.isAdmin;
    hasPermission = resolved.hasPermission;
  }

  if (!isAdmin && !hasPermission) {
    throw new Error(`Access denied: You are not an administrator for project ${projectKey}`);
  }

  const now = new Date();
  const formatDateUTC = (d) => {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  };

  const todayStr = (clientToday && /^\d{4}-\d{2}-\d{2}$/.test(clientToday))
    ? clientToday
    : formatDateUTC(now);

  const cacheKey = `teamAnalytics:${cloudId}:${projectKey}:${todayStr}`;
  try {
    const cached = await kvs.get(cacheKey);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.value;
    }
  } catch {
    // Cache miss/failure; continue with live fetch.
  }

  const { supabaseConfig, organization } = await initializeContext(accountId, cloudId);

  const [teamDailySummary, allUsers, allProjectUsers, timeByIssueData] = await Promise.all([
    supabaseRequest(
      supabaseConfig,
      `daily_time_summary?organization_id=eq.${organization.id}&project_key=eq.${projectKey}&order=work_date.desc&limit=${MAX_DAILY_SUMMARY_DAYS}`
    ),
    supabaseRequest(
      supabaseConfig,
      `users?organization_id=eq.${organization.id}&select=id,display_name,email,is_active`
    ),
    supabaseRequest(
      supabaseConfig,
      `daily_time_summary?organization_id=eq.${organization.id}&project_key=eq.${projectKey}&select=user_id&order=work_date.desc&limit=1000`
    ),
    supabaseRequest(
      supabaseConfig,
      `daily_time_summary?organization_id=eq.${organization.id}&project_key=eq.${projectKey}&task_key=not.is.null&select=task_key,user_id,total_seconds&order=work_date.desc&limit=2000`
    )
  ]);

  const userById = {};
  for (const user of (allUsers || [])) {
    if (user?.id) userById[user.id] = user;
  }

  const issueAggregation = {};
  for (const result of (timeByIssueData || [])) {
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
  }

  const teamTimeByIssue = Object.values(issueAggregation)
    .map(item => {
      const contributorDetails = Array.from(item.userIds).map(userId => {
        const userInfo = userById[userId];
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

  const todayDate = new Date(todayStr + 'T00:00:00');
  const currentMonthStr = todayStr.substring(0, 7);
  const monthStartStr = `${currentMonthStr}-01`;

  const dayOfWeek = todayDate.getDay();
  const daysToMonday = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
  const weekStart = new Date(todayDate);
  weekStart.setDate(todayDate.getDate() - daysToMonday);
  const weekStartStr = `${weekStart.getFullYear()}-${String(weekStart.getMonth() + 1).padStart(2, '0')}-${String(weekStart.getDate()).padStart(2, '0')}`;

  const trendStartDate = new Date(todayDate);
  trendStartDate.setDate(todayDate.getDate() - 13);
  const trendStartStr = `${trendStartDate.getFullYear()}-${String(trendStartDate.getMonth() + 1).padStart(2, '0')}-${String(trendStartDate.getDate()).padStart(2, '0')}`;
  const queryStartStr = trendStartStr < monthStartStr ? trendStartStr : monthStartStr;

  const [teamDailySummaryFull, unassignedDailySummary] = await Promise.all([
    supabaseRequestPaginated(
      supabaseConfig,
      `daily_time_summary?organization_id=eq.${organization.id}&project_key=eq.${projectKey}&work_date=gte.${queryStartStr}&work_date=lte.${todayStr}&select=user_id,work_date,total_seconds,task_key&order=work_date.desc`
    ),
    supabaseRequestPaginated(
      supabaseConfig,
      `daily_time_summary?organization_id=eq.${organization.id}&project_key=is.null&work_date=gte.${queryStartStr}&work_date=lte.${todayStr}&select=user_id,work_date,total_seconds&order=work_date.desc`
    )
  ]);

  const summaryByUser = new Map();
  for (const item of (teamDailySummaryFull || [])) {
    const userId = item.user_id;
    if (!summaryByUser.has(userId)) summaryByUser.set(userId, []);
    summaryByUser.get(userId).push(item);
  }

  const unassignedByUser = new Map();
  for (const item of (unassignedDailySummary || [])) {
    const userId = item.user_id;
    if (!unassignedByUser.has(userId)) unassignedByUser.set(userId, []);
    unassignedByUser.get(userId).push(item);
  }

  const summaryByDate = new Map();
  for (const item of (teamDailySummaryFull || [])) {
    const workDate = typeof item.work_date === 'string' ? item.work_date.split('T')[0] : String(item.work_date);
    if (!summaryByDate.has(workDate)) summaryByDate.set(workDate, []);
    summaryByDate.get(workDate).push(item);
  }

  const projectUserIds = new Set([
    ...(teamDailySummary || []).map(d => d.user_id),
    ...(allProjectUsers || []).map(d => d.user_id),
    ...(teamDailySummaryFull || []).map(d => d.user_id)
  ]);

  const sumByDateRange = (records, startStr, endStr) => records.reduce((sum, d) => {
    const workDate = typeof d.work_date === 'string' ? d.work_date.split('T')[0] : String(d.work_date);
    return workDate >= startStr && workDate <= endStr ? sum + (d.total_seconds || 0) : sum;
  }, 0);

  const teamMemberActivity = Array.from(projectUserIds).map(userId => {
    const userInfo = userById[userId];
    const displayName = userInfo?.display_name || userInfo?.email || 'Unknown User';

    const userDailySummaries = summaryByUser.get(userId) || [];
    const userUnassignedSummaries = unassignedByUser.get(userId) || [];

    const todaySeconds = sumByDateRange(userDailySummaries, todayStr, todayStr);
    const todayUnassignedSeconds = sumByDateRange(userUnassignedSummaries, todayStr, todayStr);
    const weekSeconds = sumByDateRange(userDailySummaries, weekStartStr, todayStr);
    const weekUnassignedSeconds = sumByDateRange(userUnassignedSummaries, weekStartStr, todayStr);
    const monthSeconds = sumByDateRange(userDailySummaries, monthStartStr, todayStr);
    const monthUnassignedSeconds = sumByDateRange(userUnassignedSummaries, monthStartStr, todayStr);

    return {
      userId,
      displayName,
      todayHours: Math.round(todaySeconds / 3600 * 100) / 100,
      weekHours: Math.round(weekSeconds / 3600 * 100) / 100,
      monthHours: Math.round(monthSeconds / 3600 * 100) / 100,
      todaySeconds,
      weekSeconds,
      monthSeconds,
      todayUnassignedSeconds,
      weekUnassignedSeconds,
      monthUnassignedSeconds,
      todayNonProductiveSeconds: 0,
      weekNonProductiveSeconds: 0,
      monthNonProductiveSeconds: 0
    };
  }).sort((a, b) => b.monthSeconds - a.monthSeconds);

  const totalSecondsThisMonth = teamMemberActivity.reduce((sum, m) => sum + m.monthSeconds, 0);
  const totalHoursThisMonth = Math.round(totalSecondsThisMonth / 3600 * 10) / 10;
  const activeMembers = teamMemberActivity.filter(m => m.monthSeconds > 0).length;

  const issuesWorkedSet = new Set();
  for (const [workDate, records] of summaryByDate.entries()) {
    if (workDate < monthStartStr || workDate > todayStr) continue;
    for (const record of records) {
      if (record.task_key) issuesWorkedSet.add(record.task_key);
    }
  }

  const teamSummary = {
    totalHoursThisMonth,
    totalSecondsThisMonth,
    activeMembers,
    issuesWorked: issuesWorkedSet.size,
    avgHoursPerMember: activeMembers > 0
      ? Math.round(totalHoursThisMonth / activeMembers * 10) / 10
      : 0
  };

  const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const trendData = [];
  for (let i = 13; i >= 0; i--) {
    const date = new Date(todayDate);
    date.setDate(todayDate.getDate() - i);
    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const dayRecords = summaryByDate.get(dateStr) || [];
    const totalSeconds = dayRecords.reduce((sum, d) => sum + (d.total_seconds || 0), 0);

    trendData.push({
      date: dateStr,
      dayOfWeek: dayNames[date.getDay()],
      dayOfMonth: date.getDate(),
      totalHours: Math.round(totalSeconds / 3600 * 10) / 10
    });
  }

  const result = {
    teamSummary,
    teamMemberActivity,
    teamDailySummary: teamDailySummary || [],
    teamTimeByIssue,
    activityTrend: trendData,
    scope: 'TEAM',
    projectKey,
    organizationId: organization.id
  };

  try {
    const serialized = JSON.stringify(result);
    if (serialized.length < 200 * 1024) {
      kvs.set(cacheKey, { value: result, expiresAt: Date.now() + TEAM_ANALYTICS_CACHE_TTL_MS }).catch(() => {});
    }
  } catch {
    // Ignore cache set errors.
  }

  console.log(`[TeamAnalytics] getProjectTeamAnalytics ${projectKey} took ${Date.now() - t0}ms`);
  return result;
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

// Columns from the idle-time migration (20260325) - may not exist in older databases
const IDLE_COLUMNS = ',is_idle,idle_start_time,idle_end_time,reclassified_from,reclassification_reason,converted_issue_key,user_timezone';
const BASE_ACTIVITY_SELECT = 'id,user_id,start_time,end_time,duration_seconds,project_key,classification,user_assigned_issue_key';

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
 * Build the legacy analysis_results query string with a +/-1-day created_at buffer
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

/** Build map: user_id -> latest batch_end within the threshold window */
function buildLatestBatchByUserMap(recentActivity) {
  const latestBatchByUser = {};
  for (const r of (recentActivity || [])) {
    if (!latestBatchByUser[r.user_id] || r.batch_end > latestBatchByUser[r.user_id]) {
      latestBatchByUser[r.user_id] = r.batch_end;
    }
  }
  return latestBatchByUser;
}

/** Build lookup map: user_id -> user record, to avoid O(n^2) scanning */
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
  // during active tracking (vs desktop_last_heartbeat every 4h) - used to compute a more
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
        idleBlocks: [],
        unassignedBlocks: []
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
        reclassifiedFrom: record.reclassified_from || null,
        reason: record.reclassification_reason || null,
        userTimezone: record.user_timezone || null,
        projectKey: record.project_key || null
      });
    } else if (!record.user_assigned_issue_key) {
      // Unassigned work session
      userTimelineMap[userId].unassignedBlocks.push({
        id: record.id,
        startTime: record.start_time,
        endTime: record.end_time,
        durationSeconds: record.duration_seconds || 0,
        projectKey: record.project_key || null
      });
    } else {
      // Add session with start_time, end_time for accurate timeline rendering
      // duration_seconds = accumulated real work time (not simply end_time - start_time)
      userTimelineMap[userId].sessions.push({
        startTime: record.start_time,
        endTime: record.end_time,
        durationSeconds: record.duration_seconds || 0,
        issueKey: record.user_assigned_issue_key || null,
        id: record.id
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
        idleBlocks: [],
        unassignedBlocks: []
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
  // All classifications included - timeline shows all activity to indicate user presence
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
  const unassignedBlocks = [];
 
  (activityRecords || []).forEach(record => {
    if (record.is_idle) {
      idleBlocks.push({
        id: record.id,
        startTime: record.idle_start_time || record.start_time,
        endTime: record.idle_end_time || record.end_time,
        durationSeconds: record.duration_seconds || 0,
        classification: record.classification,
        convertedIssueKey: record.converted_issue_key || null,
        reclassifiedFrom: record.reclassified_from || null,
        reason: record.reclassification_reason || null,
        userTimezone: record.user_timezone || null,
        projectKey: record.project_key || null
      });
    } else if (!record.user_assigned_issue_key) {
      // Unassigned work session (not idle, but not assigned to issue)
      unassignedBlocks.push({
        id: record.id,
        startTime: record.start_time,
        endTime: record.end_time,
        durationSeconds: record.duration_seconds || 0,
        projectKey: record.project_key || null
      });
    } else {
      sessions.push({
        startTime: record.start_time,
        endTime: record.end_time,
        durationSeconds: record.duration_seconds || 0,
        issueKey: record.user_assigned_issue_key || null,
        id: record.id
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

  if (sessions.length === 0 && idleBlocks.length === 0 && unassignedBlocks.length === 0) {
    const workHoursConfig = await fetchWorkHoursConfig(supabaseConfig, organization.id);
    return {
      date,
      userId,
      displayName,
      sessions: [],
      idleBlocks: [],
      unassignedBlocks: [],
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
    unassignedBlocks,
    workHours: workHoursConfig,
    totalHours,
    totalSessions: sessions.length,
    firstActivity: sessions[0]?.startTime || idleBlocks[0]?.startTime || unassignedBlocks[0]?.startTime || null,
    lastActivity: sessions[sessions.length - 1]?.endTime || idleBlocks[idleBlocks.length - 1]?.endTime || unassignedBlocks[unassignedBlocks.length - 1]?.endTime || null
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

/**
 * Convert unassigned work sessions into a Jira issue
 * Handles both "assign to existing issue" and "create new issue" flows
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID
 * @param {string[]} sessionIds - Activity record IDs to convert
 * @param {Object} options - Conversion options
 * @param {string} [options.existingIssueKey] - Existing issue to assign to
 * @param {string} [options.createNewIssue] - If true, create a new issue
 * @param {string} [options.newIssueSummary] - Summary for new issue
 * @param {string} [options.newIssueDescription] - Description for new issue
 * @param {string} [options.projectKey] - Project key for new issue
 * @param {string} [options.conversionReason] - User's reason for conversion
 * @returns {Promise<Object>} Conversion result with issue key and metadata
 */
export async function convertUnassignedToWorklog(accountId, cloudId, sessionIds, options = {}) {
  const { existingIssueKey, createNewIssue, newIssueSummary, newIssueDescription, projectKey: frontendProjectKey, conversionReason } = options;

  if (!sessionIds || sessionIds.length === 0) {
    throw new Error('No sessions provided for conversion');
  }

  const { supabaseConfig, organization } = await initializeContext(accountId, cloudId);

  // Get current user
  const currentUser = await supabaseRequest(
    supabaseConfig,
    `users?organization_id=eq.${organization.id}&atlassian_account_id=eq.${accountId}&select=id&limit=1`
  );
  if (!currentUser || currentUser.length === 0) {
    throw new Error('User not found');
  }
  const userId = currentUser[0].id;

  // Verify all sessions belong to this user and are unassigned
  const sessionIdsParam = sessionIds.join(',');
  const records = await supabaseRequest(
    supabaseConfig,
    `activity_records?id=in.(${sessionIdsParam})&select=id,user_id,user_assigned_issue_key,duration_seconds`
  );

  if (!records || records.length === 0) {
    throw new Error('No matching activity records found');
  }

  // SECURITY: Verify all records belong to current user
  const unOwnedRecords = records.filter(r => r.user_id !== userId);
  if (unOwnedRecords.length > 0) {
    throw new Error('Access denied: some records do not belong to you');
  }

  // Verify all records are unassigned
  const alreadyAssigned = records.filter(r => r.user_assigned_issue_key);
  if (alreadyAssigned.length > 0) {
    throw new Error(`${alreadyAssigned.length} of ${records.length} sessions are already assigned. Skipping conversion.`);
  }

  // Calculate total time
  const totalSeconds = records.reduce((sum, r) => sum + (r.duration_seconds || 0), 0);

  // Determine target issue key (create new if requested, otherwise use existing)
  let targetIssueKey = existingIssueKey;
  if (createNewIssue && !targetIssueKey) {
    // Note: Issue creation and transition happen in the RESOLVER (Forge API context required)
    // This function returns the data needed; resolver handles Jira API calls
    throw new Error('New issue creation must be handled in resolver context. Use resolver-side flow.');
  }

  if (!targetIssueKey) {
    throw new Error('Either existingIssueKey or createNewIssue must be provided');
  }

  // Extract project key from issue (e.g., "PROJ-123" -> "PROJ")
  const issueProjectKey = targetIssueKey.split('-')[0];

  // Update activity records with issue assignment
  // Store conversion metadata in both explicit columns (if they exist) and in the metadata JSONB field
  const now = new Date().toISOString();
  const updatePayload = {
    user_assigned_issue_key: targetIssueKey,
    project_key: issueProjectKey,
    metadata: {
      conversion_reason: conversionReason || null,
      converted_at: now,
      conversion_type: 'unassigned_manual'
    }
  };

  // Try to also update the dedicated columns if they exist
  // (they'll be added in migration 20260417_add_unassigned_conversion_columns.sql)
  if (conversionReason || now) {
    updatePayload.conversion_reason = conversionReason || null;
    updatePayload.converted_at = now;
  }

  try {
    await supabaseRequest(
      supabaseConfig,
      `activity_records?id=in.(${sessionIdsParam})&user_id=eq.${userId}`,
      { method: 'PATCH', body: updatePayload }
    );
  } catch (updateErr) {
    // If columns don't exist yet, try without them (fallback to metadata-only)
    if (updateErr.message && updateErr.message.includes('conversion_reason')) {
      console.log(`[convertUnassigned] Columns not yet available, using metadata fallback`);
      const fallbackPayload = {
        user_assigned_issue_key: targetIssueKey,
        project_key: issueProjectKey,
        metadata: updatePayload.metadata
      };
      await supabaseRequest(
        supabaseConfig,
        `activity_records?id=in.(${sessionIdsParam})&user_id=eq.${userId}`,
        { method: 'PATCH', body: fallbackPayload }
      );
    } else {
      throw updateErr;
    }
  }

  console.log(`[convertUnassigned] Updated ${records.length} activity records to ${targetIssueKey}`);

  // Remove these sessions from unassigned groups and recalculate aggregates
  const groupMembers = await supabaseRequest(
    supabaseConfig,
    `unassigned_group_members?activity_record_id=in.(${sessionIdsParam})&select=id,group_id`
  );

  const membersArray = Array.isArray(groupMembers) ? groupMembers : [];
  if (membersArray.length > 0) {
    // Collect affected groups
    const affectedGroupIds = new Set(membersArray.map(m => m.group_id).filter(Boolean));
    const memberIds = membersArray.map(m => m.id).filter(Boolean);

    // Delete group memberships
    if (memberIds.length > 0) {
      const memberIdsParam = memberIds.join(',');
      await supabaseRequest(
        supabaseConfig,
        `unassigned_group_members?id=in.(${memberIdsParam})`,
        { method: 'DELETE' }
      );
      console.log(`[convertUnassigned] Removed ${membersArray.length} sessions from unassigned groups`);
    }

    // Recalculate group aggregates
    for (const groupId of affectedGroupIds) {
      try {
        const remainingMembers = await supabaseRequest(
          supabaseConfig,
          `unassigned_group_members?group_id=eq.${groupId}&select=id`
        );

        const remainingCount = Array.isArray(remainingMembers) ? remainingMembers.length : 0;

        if (remainingCount === 0) {
          // Group is now empty
          await supabaseRequest(
            supabaseConfig,
            `unassigned_work_groups?id=eq.${groupId}`,
            {
              method: 'PATCH',
              body: {
                is_assigned: true,
                session_count: 0,
                total_seconds: 0
              }
            }
          );
        } else {
          // Recalculate totals from remaining members
          const remainingData = await supabaseRequest(
            supabaseConfig,
            `unassigned_group_members?group_id=eq.${groupId}&select=activity_record_id`
          );

          const arIds = (Array.isArray(remainingData) ? remainingData : [])
            .map(m => m.activity_record_id)
            .filter(Boolean);

          if (arIds.length > 0) {
            const arIdsParam = arIds.join(',');
            const recalcRecords = await supabaseRequest(
              supabaseConfig,
              `activity_records?id=in.(${arIdsParam})&select=duration_seconds`
            );

            const recalcTotalSeconds = (Array.isArray(recalcRecords) ? recalcRecords : [])
              .reduce((sum, r) => sum + (r.duration_seconds || 0), 0);

            await supabaseRequest(
              supabaseConfig,
              `unassigned_work_groups?id=eq.${groupId}`,
              {
                method: 'PATCH',
                body: {
                  session_count: remainingCount,
                  total_seconds: recalcTotalSeconds
                }
              }
            );
          }
        }
      } catch (err) {
        console.error(`[convertUnassigned] Error updating group ${groupId}:`, err);
        // Continue despite errors
      }
    }
  }

  return {
    sessionIds,
    issueKey: targetIssueKey,
    projectKey: issueProjectKey,
    totalSeconds,
    sessionCount: records.length,
    convertedAt: now,
    conversionReason
  };
}

// ============================================================================
// TEAM ANALYTICS DETAIL FUNCTIONS (Enhanced Drill-Down)

/**
 * Fetch recommendation for converting unassigned work sessions
 * Returns suggestion from group if all sessions belong to a single group
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID
 * @param {string[]} sessionIds - Activity record IDs to get recommendation for
 * @returns {Promise<Object>} Recommendation data or null if not available
 */
export async function getUnassignedConversionRecommendation(accountId, cloudId, sessionIds) {
  if (!sessionIds || sessionIds.length === 0) {
    return null;
  }

  const { supabaseConfig, organization } = await initializeContext(accountId, cloudId);

  // Get current user
  const currentUser = await supabaseRequest(
    supabaseConfig,
    `users?organization_id=eq.${organization.id}&atlassian_account_id=eq.${accountId}&select=id&limit=1`
  );
  if (!currentUser || currentUser.length === 0) {
    return null;
  }

  try {
    const sessionIdsParam = sessionIds.join(',');

    // Find which groups contain these sessions
    const groupMembers = await supabaseRequest(
      supabaseConfig,
      `unassigned_group_members?activity_record_id=in.(${sessionIdsParam})&select=group_id`
    );

    if (!Array.isArray(groupMembers) || groupMembers.length === 0) {
      return null;
    }

    // Get unique group IDs
    const groupIds = [...new Set(groupMembers.map(m => m.group_id).filter(Boolean))];

    // If all sessions belong to a single group, return its recommendation
    if (groupIds.length === 1) {
      const groupId = groupIds[0];
      const groups = await supabaseRequest(
        supabaseConfig,
        `unassigned_work_groups?id=eq.${groupId}&select=group_label,group_description,recommended_action,suggested_issue_key,recommendation_reason,confidence_level&limit=1`
      );

      if (Array.isArray(groups) && groups.length > 0) {
        const group = groups[0];
        return {
          action: group.recommended_action || 'create_new_issue',
          summary: group.group_label || 'Unassigned work',
          description: group.group_description || null,
          suggestedIssueKey: group.suggested_issue_key || null,
          reason: group.recommendation_reason || null,
          confidence: group.confidence_level || 'low'
        };
      }
    }

    // Multiple groups or no recommendation available
    return null;
  } catch (error) {
    console.error('[getUnassignedConversionRecommendation] Error:', error);
    return null;
  }
}
// ============================================================================

/**
 * Fetch issue details from Jira API in batches
 * @param {Array<string>} issueKeys - Array of issue keys to fetch
 * @returns {Promise<Object>} Map of issueKey -> issue details
 */
async function fetchIssueDetailsBatch(issueKeys) {
  if (!issueKeys || issueKeys.length === 0) return {};
 
  try {
    const results = {};
   
    // Fetch each issue individually for reliability in Forge
    for (const issueKey of issueKeys) {
      try {
        const response = await api.asUser().requestJira(
          route`/rest/api/3/issue/${issueKey}?fields=summary,status,priority,issuetype`,
          {
            method: 'GET',
            headers: { 'Accept': 'application/json' }
          }
        );
       
        if (response.ok) {
          const issue = await response.json();
          results[issue.key] = {
            summary: issue.fields?.summary || '',
            status: issue.fields?.status?.name || 'Unknown',
            statusCategory: issue.fields?.status?.statusCategory?.key || 'new',
            priority: issue.fields?.priority?.name || 'Medium',
            issueType: issue.fields?.issuetype?.name || 'Task',
            issueTypeIconUrl: issue.fields?.issuetype?.iconUrl || ''
          };
        } else {
          console.warn(`[FetchIssueDetails] Failed to fetch ${issueKey}: ${response.status}`);
        }
      } catch (issueError) {
        console.warn(`[FetchIssueDetails] Error fetching ${issueKey}:`, issueError.message);
      }
    }
   
    return results;
  } catch (error) {
    console.error('[FetchIssueDetails] Error:', error);
    return {};
  }
}

/**
 * Fetch detailed day activity for the current user (no admin permissions required).
 * Used by Time Analytics inline drill-down when users click a day's hours.
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID
 * @param {string} date - Date string (YYYY-MM-DD)
 * @returns {Promise<Object>} Day activity details with issue breakdown
 */
export async function fetchMyDayIssueBreakdown(accountId, cloudId, date) {
  validateDateFormat(date);

  const { supabaseConfig, organization } = await initializeContext(accountId, cloudId);
  const userId = await getOrCreateUser(accountId, supabaseConfig, organization.id);
  if (!userId) {
    throw new Error('Unable to get user information');
  }

  // Headline total should come from daily_time_summary for consistency with card totals.
  const dailySummaryRecords = await supabaseRequest(
    supabaseConfig,
    `daily_time_summary?organization_id=eq.${organization.id}&user_id=eq.${userId}&work_date=eq.${date}&select=task_key,total_seconds`
  );

  const allRecords = await supabaseRequestPaginated(
    supabaseConfig,
    `activity_records?organization_id=eq.${organization.id}&user_id=eq.${userId}&work_date=eq.${date}&status=in.(pending,processing,analyzed)&select=user_assigned_issue_key,project_key,duration_seconds,start_time,end_time,classification&order=start_time.asc,id.asc`
  );

  const records = (allRecords || []).filter(r =>
    r.classification === 'productive' || r.classification === 'unknown' || !r.classification
  );

  const issueMap = {};
  records.forEach(record => {
    const key = record.user_assigned_issue_key || 'Unassigned';
    if (!issueMap[key]) {
      issueMap[key] = {
        issueKey: key,
        projectKey: record.project_key,
        totalSeconds: 0,
        sessionCount: 0,
        sessions: []
      };
    }
    issueMap[key].totalSeconds += record.duration_seconds || 0;
    issueMap[key].sessionCount += 1;
    issueMap[key].sessions.push({
      startTime: record.start_time,
      endTime: record.end_time,
      seconds: record.duration_seconds
    });
  });

  const issues = Object.values(issueMap).sort((a, b) => b.totalSeconds - a.totalSeconds);
  const issueKeys = issues.map(i => i.issueKey).filter(k => k !== 'Unassigned');
  const issueDetails = await fetchIssueDetailsBatch(issueKeys);

  issues.forEach(issue => {
    if (issue.issueKey === 'Unassigned') {
      issue.summary = 'Work not assigned to any issue';
      issue.status = '';
      issue.statusCategory = '';
      issue.priority = '';
      issue.issueType = '';
      return;
    }
    const jiraIssue = issueDetails[issue.issueKey];
    if (jiraIssue) {
      issue.summary = jiraIssue.summary;
      issue.status = jiraIssue.status;
      issue.statusCategory = jiraIssue.statusCategory;
      issue.priority = jiraIssue.priority;
      issue.issueType = jiraIssue.issueType;
      issue.issueTypeIconUrl = jiraIssue.issueTypeIconUrl;
    }
  });

  const summaryTotalSeconds = (dailySummaryRecords || []).reduce((sum, r) => sum + (r.total_seconds || 0), 0);
  const productiveSeconds = issues.reduce((sum, issue) => sum + issue.totalSeconds, 0);
  const totalSeconds = summaryTotalSeconds > 0 ? summaryTotalSeconds : productiveSeconds;

  return {
    userId,
    date,
    totalSeconds,
    totalHours: Math.round(totalSeconds / 3600 * 10) / 10,
    issueCount: issues.filter(i => i.issueKey !== 'Unassigned').length,
    issues
  };
}

/**
 * Fetch detailed day activity for a team member
 * Shows which issues they worked on and time per issue
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID
 * @param {string} projectKey - Project key (null for all projects)
 * @param {string} userId - User ID to fetch details for
 * @param {string} date - Date string (YYYY-MM-DD)
 * @returns {Promise<Object>} Day activity details with issue breakdown
 */
export async function fetchMemberDayDetails(accountId, cloudId, projectKey, userId, date) {
  validateDateFormat(date);
 
  const { supabaseConfig, organization } = await initializeContext(accountId, cloudId);
 
  // Fetch total time from daily_time_summary (same source as individual Time Analytics page)
  // This ensures the modal total matches the individual user's view exactly.
  // Include unassigned (NULL project_key) records so the modal matches the Team Analytics
  // Team Member Activity row (which already sums project + unassigned time for each member).
  let summaryQuery = `daily_time_summary?organization_id=eq.${organization.id}&user_id=eq.${userId}&work_date=eq.${date}&select=task_key,total_seconds`;
  if (projectKey && projectKey !== 'null') {
    summaryQuery += `&or=(project_key.eq.${projectKey},project_key.is.null)`;
  }
  const dailySummaryRecords = await supabaseRequest(supabaseConfig, summaryQuery);

  // Also fetch activity_records for session-level detail (start/end times)
  let baseQuery = `activity_records?organization_id=eq.${organization.id}&user_id=eq.${userId}&work_date=eq.${date}&status=in.(pending,processing,analyzed)&select=user_assigned_issue_key,project_key,duration_seconds,start_time,end_time,classification&order=start_time.asc,id.asc`;
  if (projectKey && projectKey !== 'null') {
    baseQuery += `&or=(project_key.eq.${projectKey},project_key.is.null)`;
  }
 
  const allRecords = await supabaseRequestPaginated(supabaseConfig, baseQuery);
 
  // Split into productive and non-productive
  const records = (allRecords || []).filter(r =>
    r.classification === 'productive' || r.classification === 'unknown' || !r.classification
  );
  const npRecords = (allRecords || []).filter(r =>
    r.classification === 'non_productive' || r.classification === 'private'
  );
 
  // Calculate non-productive totals from activity_records (for session details)
  const nonProductiveSeconds = (npRecords || []).reduce((sum, r) => sum + (r.duration_seconds || 0), 0);
  const nonProductiveSessions = (npRecords || []).map(r => ({
    startTime: r.start_time,
    endTime: r.end_time,
    seconds: r.duration_seconds,
    classification: r.classification
  }));
 
  // Group activity_records by issue (use "Unassigned" for records without an issue key)
  const issueMap = {};
  (records || []).forEach(record => {
    const key = record.user_assigned_issue_key || 'Unassigned';
    if (!issueMap[key]) {
      issueMap[key] = {
        issueKey: key,
        projectKey: record.project_key,
        totalSeconds: 0,
        sessionCount: 0,
        sessions: []
      };
    }
    issueMap[key].totalSeconds += record.duration_seconds || 0;
    issueMap[key].sessionCount++;
    issueMap[key].sessions.push({
      startTime: record.start_time,
      endTime: record.end_time,
      seconds: record.duration_seconds
    });
  });
 
  // Convert to array and sort by time spent (descending)
  const issues = Object.values(issueMap).sort((a, b) => b.totalSeconds - a.totalSeconds);
 
  // Fetch issue details from Jira (skip 'Unassigned' placeholder)
  const issueKeys = issues.map(i => i.issueKey).filter(k => k !== 'Unassigned');
  const issueDetails = await fetchIssueDetailsBatch(issueKeys);
 
  // Merge Jira details with time data
  issues.forEach(issue => {
    if (issue.issueKey === 'Unassigned') {
      issue.summary = 'Work not assigned to any issue';
      issue.status = '';
      issue.statusCategory = '';
      issue.priority = '';
      issue.issueType = '';
      return;
    }
    const jiraIssue = issueDetails[issue.issueKey];
    if (jiraIssue) {
      issue.summary = jiraIssue.summary;
      issue.status = jiraIssue.status;
      issue.statusCategory = jiraIssue.statusCategory;
      issue.priority = jiraIssue.priority;
      issue.issueType = jiraIssue.issueType;
    }
  });
 
  // Calculate totals: use daily_time_summary for the headline total (matches individual page)
  // Fall back to activity_records sum if daily_time_summary returns no data
  const summaryTotalSeconds = (dailySummaryRecords || []).reduce((sum, r) => sum + (r.total_seconds || 0), 0);
  const productiveSeconds = issues.reduce((sum, i) => sum + i.totalSeconds, 0);
  const totalSeconds = summaryTotalSeconds > 0 ? summaryTotalSeconds : (productiveSeconds + nonProductiveSeconds);
  const totalUnassignedSeconds = (dailySummaryRecords || [])
    .filter(r => !r.task_key)
    .reduce((sum, r) => sum + (r.total_seconds || 0), 0) || issues
    .filter(i => i.issueKey === 'Unassigned')
    .reduce((sum, i) => sum + i.totalSeconds, 0);
 
  // Get user info
  const userInfo = await supabaseRequest(
    supabaseConfig,
    `users?id=eq.${userId}&select=display_name,email&limit=1`
  );
  const displayName = userInfo[0]?.display_name || userInfo[0]?.email || 'Unknown User';
 
  return {
    userId,
    displayName,
    date,
    totalSeconds,
    totalHours: Math.round(totalSeconds / 3600 * 10) / 10,
    productiveSeconds,
    issueCount: issues.filter(i => i.issueKey !== 'Unassigned').length,
    issues,
    nonProductiveSeconds,
    nonProductiveSessions,
    totalUnassignedSeconds
  };
}

/**
 * Fetch detailed week activity for a team member
 * Shows day-by-day breakdown with issues for each day
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID
 * @param {string} projectKey - Project key (null for all projects)
 * @param {string} userId - User ID to fetch details for
 * @param {string} weekStartDate - Monday date (YYYY-MM-DD)
 * @returns {Promise<Object>} Week activity details with daily breakdown
 */
export async function fetchMemberWeekDetails(accountId, cloudId, projectKey, userId, weekStartDate) {
  validateDateFormat(weekStartDate);
 
  const { supabaseConfig, organization } = await initializeContext(accountId, cloudId);
 
  // Calculate week end date (Sunday, 6 days after Monday)
  const startDate = new Date(weekStartDate + 'T00:00:00');
  const endDate = new Date(startDate);
  endDate.setDate(startDate.getDate() + 6);
  const weekEndStr = endDate.toISOString().split('T')[0];
 
  // Get detailed breakdown from activity_records (for session-level detail: start/end times)
  // Uses pagination because PostgREST max_rows=1000 could truncate high-session-count users
  // Include unassigned (NULL project_key) records so the weekly modal matches the Team Member
  // Activity row (which sums project + unassigned time for each member).
  let baseQuery = `activity_records?organization_id=eq.${organization.id}&user_id=eq.${userId}&work_date=gte.${weekStartDate}&work_date=lte.${weekEndStr}&status=in.(pending,processing,analyzed)&select=work_date,user_assigned_issue_key,project_key,duration_seconds,start_time,end_time,classification&order=work_date.asc,start_time.asc,id.asc`;
  if (projectKey && projectKey !== 'null') {
    baseQuery += `&or=(project_key.eq.${projectKey},project_key.is.null)`;
  }

  const allRecords = await supabaseRequestPaginated(supabaseConfig, baseQuery);

  // Fetch daily_time_summary for week totals (matches individual Time Analytics page)
  let weekSummaryQuery = `daily_time_summary?organization_id=eq.${organization.id}&user_id=eq.${userId}&work_date=gte.${weekStartDate}&work_date=lte.${weekEndStr}&select=work_date,task_key,total_seconds`;
  if (projectKey && projectKey !== 'null') {
    weekSummaryQuery += `&or=(project_key.eq.${projectKey},project_key.is.null)`;
  }
  const weekDailySummary = await supabaseRequest(supabaseConfig, weekSummaryQuery);

  // Build daily_time_summary totals by date
  const summaryDayTotals = {};
  (weekDailySummary || []).forEach(r => {
    const wd = typeof r.work_date === 'string' ? r.work_date.split('T')[0] : String(r.work_date);
    summaryDayTotals[wd] = (summaryDayTotals[wd] || 0) + (r.total_seconds || 0);
  });
 
  // Split into productive and non-productive
  const records = (allRecords || []).filter(r =>
    r.classification === 'productive' || r.classification === 'unknown' || !r.classification
  );
  const npRecords = (allRecords || []).filter(r =>
    r.classification === 'non_productive' || r.classification === 'private'
  );
 
  // Build non-productive daily map
  const npDayMap = {};
  (npRecords || []).forEach(r => {
    const wd = typeof r.work_date === 'string' ? r.work_date.split('T')[0] : String(r.work_date);
    npDayMap[wd] = (npDayMap[wd] || 0) + (r.duration_seconds || 0);
  });
 
  // Group by date and then by issue
  const dayMap = {};
  (records || []).forEach(record => {
    const workDate = typeof record.work_date === 'string' ? record.work_date.split('T')[0] : String(record.work_date);
    const issueKey = record.user_assigned_issue_key || 'Unassigned';
   
    if (!dayMap[workDate]) {
      dayMap[workDate] = {};
    }
    if (!dayMap[workDate][issueKey]) {
      dayMap[workDate][issueKey] = {
        issueKey,
        projectKey: record.project_key,
        totalSeconds: 0,
        sessionCount: 0,
        sessions: []
      };
    }
    dayMap[workDate][issueKey].totalSeconds += record.duration_seconds || 0;
    dayMap[workDate][issueKey].sessionCount++;
    dayMap[workDate][issueKey].sessions.push({
      startTime: record.start_time,
      endTime: record.end_time,
      seconds: record.duration_seconds
    });
  });
 
  // Collect all unique issue keys for batch fetching (exclude 'Unassigned')
  const allIssueKeys = new Set();
  Object.values(dayMap).forEach(dayIssues => {
    Object.keys(dayIssues).forEach(key => { if (key !== 'Unassigned') allIssueKeys.add(key); });
  });
 
  // Fetch issue details from Jira
  const issueDetails = await fetchIssueDetailsBatch([...allIssueKeys]);
 
  // Build daily breakdown
  const dailyBreakdown = [];
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
 
  for (let i = 0; i < 7; i++) {
    const currentDate = new Date(startDate);
    currentDate.setDate(startDate.getDate() + i);
    const dateStr = currentDate.toISOString().split('T')[0];
    const dayOfWeek = dayNames[currentDate.getDay()];
   
    const dayIssues = dayMap[dateStr] || {};
    const issues = Object.values(dayIssues).map(issue => {
      const jiraDetails = issueDetails[issue.issueKey];
      return {
        ...issue,
        summary: issue.issueKey === 'Unassigned' ? 'Work not assigned to any issue' : (jiraDetails?.summary || ''),
        status: jiraDetails?.status || 'Unknown',
        statusCategory: jiraDetails?.statusCategory || 'new'
      };
    }).sort((a, b) => b.totalSeconds - a.totalSeconds);
   
    const productiveSeconds = issues.reduce((sum, i) => sum + i.totalSeconds, 0);
    const nonProductiveSeconds = npDayMap[dateStr] || 0;
    // Use daily_time_summary total if available (matches individual page), else fall back
    const totalSeconds = summaryDayTotals[dateStr] != null ? summaryDayTotals[dateStr] : (productiveSeconds + nonProductiveSeconds);
   
    dailyBreakdown.push({
      date: dateStr,
      dayOfWeek,
      totalSeconds,
      productiveSeconds,
      totalHours: Math.round(totalSeconds / 3600 * 100) / 100,
      issueCount: issues.filter(i => i.issueKey !== 'Unassigned').length,
      issues,
      nonProductiveSeconds
    });
  }
 
  // Calculate week totals
  const totalSeconds = dailyBreakdown.reduce((sum, day) => sum + day.totalSeconds, 0);
  const productiveSeconds = dailyBreakdown.reduce((sum, day) => sum + (day.productiveSeconds || 0), 0);
  const totalNonProductiveSeconds = dailyBreakdown.reduce((sum, day) => sum + (day.nonProductiveSeconds || 0), 0);
  const totalUnassignedSeconds = dailyBreakdown.reduce((sum, day) => {
    const dayUnassigned = (day.issues || []).filter(i => i.issueKey === 'Unassigned').reduce((s, i) => s + i.totalSeconds, 0);
    return sum + dayUnassigned;
  }, 0);
 
  // Get user info
  const userInfo = await supabaseRequest(
    supabaseConfig,
    `users?id=eq.${userId}&select=display_name,email&limit=1`
  );
  const displayName = userInfo[0]?.display_name || userInfo[0]?.email || 'Unknown User';
 
  return {
    userId,
    displayName,
    weekStart: weekStartDate,
    weekEnd: weekEndStr,
    totalSeconds,
    productiveSeconds,
    totalHours: Math.round(totalSeconds / 3600 * 10) / 10,
    nonProductiveSeconds: totalNonProductiveSeconds,
    totalUnassignedSeconds,
    dailyBreakdown
  };
}

/**
 * Fetch detailed month activity for a team member
 * Shows week-by-week and day-by-day breakdown
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID
 * @param {string} projectKey - Project key (null for all projects)
 * @param {string} userId - User ID to fetch details for
 * @param {string} month - Month string (YYYY-MM)
 * @returns {Promise<Object>} Month activity details with weekly breakdown
 */
export async function fetchMemberMonthDetails(accountId, cloudId, projectKey, userId, month) {
  // Validate month format (YYYY-MM)
  if (!/^\d{4}-\d{2}$/.test(month)) {
    throw new Error('Invalid month format. Expected YYYY-MM');
  }
 
  const { supabaseConfig, organization } = await initializeContext(accountId, cloudId);
 
  // Calculate month start and end dates
  const [year, monthNum] = month.split('-').map(Number);
  const monthStart = new Date(year, monthNum - 1, 1);
  const monthEnd = new Date(year, monthNum, 0); // Last day of month
 
  const monthStartStr = monthStart.toISOString().split('T')[0];
  const monthEndStr = monthEnd.toISOString().split('T')[0];
 
  // Get detailed breakdown from activity_records (for session-level detail)
  // Uses pagination because PostgREST max_rows=1000 could truncate high-session-count users
  let baseQuery = `activity_records?organization_id=eq.${organization.id}&user_id=eq.${userId}&work_date=gte.${monthStartStr}&work_date=lte.${monthEndStr}&status=in.(pending,processing,analyzed)&select=work_date,user_assigned_issue_key,project_key,duration_seconds,start_time,end_time,classification&order=work_date.asc,start_time.asc,id.asc`;
  if (projectKey && projectKey !== 'null') {
    // Include project's records AND records with NULL project_key (unassigned work)
    baseQuery += `&or=(project_key.eq.${projectKey},project_key.is.null)`;
  }

  const allRecords = await supabaseRequestPaginated(supabaseConfig, baseQuery);

  // Fetch daily_time_summary for month totals (matches individual Time Analytics page)
  let monthSummaryQuery = `daily_time_summary?organization_id=eq.${organization.id}&user_id=eq.${userId}&work_date=gte.${monthStartStr}&work_date=lte.${monthEndStr}&select=work_date,task_key,total_seconds`;
  if (projectKey && projectKey !== 'null') {
    // Include project's records AND records with NULL project_key (unassigned work)
    monthSummaryQuery += `&or=(project_key.eq.${projectKey},project_key.is.null)`;
  }
  const monthDailySummary = await supabaseRequest(supabaseConfig, monthSummaryQuery);

  // Build daily_time_summary totals by date
  const monthSummaryDayTotals = {};
  (monthDailySummary || []).forEach(r => {
    const wd = typeof r.work_date === 'string' ? r.work_date.split('T')[0] : String(r.work_date);
    monthSummaryDayTotals[wd] = (monthSummaryDayTotals[wd] || 0) + (r.total_seconds || 0);
  });
 
  // Split into productive and non-productive
  const records = (allRecords || []).filter(r =>
    r.classification === 'productive' || r.classification === 'unknown' || !r.classification
  );
  const npRecords = (allRecords || []).filter(r =>
    r.classification === 'non_productive' || r.classification === 'private'
  );
 
  // Build non-productive daily map
  const npDayMap = {};
  (npRecords || []).forEach(r => {
    const wd = typeof r.work_date === 'string' ? r.work_date.split('T')[0] : String(r.work_date);
    npDayMap[wd] = (npDayMap[wd] || 0) + (r.duration_seconds || 0);
  });
 
  // Group by date and then by issue
  const dayMap = {};
  (records || []).forEach(record => {
    const workDate = typeof record.work_date === 'string' ? record.work_date.split('T')[0] : String(record.work_date);
    const issueKey = record.user_assigned_issue_key || 'Unassigned';
   
    if (!dayMap[workDate]) {
      dayMap[workDate] = {};
    }
    if (!dayMap[workDate][issueKey]) {
      dayMap[workDate][issueKey] = {
        issueKey,
        projectKey: record.project_key,
        totalSeconds: 0,
        sessions: []
      };
    }
    dayMap[workDate][issueKey].totalSeconds += record.duration_seconds || 0;
    dayMap[workDate][issueKey].sessions.push({
      startTime: record.start_time,
      endTime: record.end_time,
      seconds: record.duration_seconds
    });
  });
 
  // Collect all unique issue keys for batch fetching (exclude 'Unassigned')
  const allIssueKeys = new Set();
  Object.values(dayMap).forEach(dayIssues => {
    Object.keys(dayIssues).forEach(key => { if (key !== 'Unassigned') allIssueKeys.add(key); });
  });
 
  // Fetch issue details from Jira
  const issueDetails = await fetchIssueDetailsBatch([...allIssueKeys]);
 
  // Build weekly breakdown - only include days within the actual month (1st to last day)
  const weeklyBreakdown = [];
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
 
  // Start from the 1st of the month, group into Mon-Sun weeks
  let weekDays = [];
  let weekNum = 0;
 
  for (let d = new Date(monthStart); d <= monthEnd; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split('T')[0];
    const dayOfWeek = dayNames[d.getDay()];
    const dayIssues = dayMap[dateStr] || {};
    const issues = Object.values(dayIssues).map(issue => {
      const jiraDetails = issueDetails[issue.issueKey];
      return {
        ...issue,
        summary: issue.issueKey === 'Unassigned' ? 'Work not assigned to any issue' : (jiraDetails?.summary || ''),
        status: jiraDetails?.status || 'Unknown'
      };
    }).sort((a, b) => b.totalSeconds - a.totalSeconds);
   
    const productiveSeconds = issues.reduce((sum, i) => sum + i.totalSeconds, 0);
    const nonProductiveSeconds = npDayMap[dateStr] || 0;
    // Use daily_time_summary total if available (matches individual page), else fall back
    const totalSeconds = monthSummaryDayTotals[dateStr] != null ? monthSummaryDayTotals[dateStr] : (productiveSeconds + nonProductiveSeconds);
   
    weekDays.push({
      date: dateStr,
      dayOfWeek,
      totalSeconds,
      productiveSeconds,
      totalHours: Math.round(totalSeconds / 3600 * 100) / 100,
      issueCount: issues.filter(i => i.issueKey !== 'Unassigned').length,
      issues,
      nonProductiveSeconds
    });
   
    // End of week (Sunday) or last day of month - flush the week
    const isLastDayOfMonth = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1) > monthEnd;
    if (d.getDay() === 0 || isLastDayOfMonth) {
      weekNum++;
      const weekTotalSeconds = weekDays.reduce((sum, day) => sum + day.totalSeconds, 0);
      const weekProductiveSeconds = weekDays.reduce((sum, day) => sum + (day.productiveSeconds || 0), 0);
      const weekNPSeconds = weekDays.reduce((sum, day) => sum + (day.nonProductiveSeconds || 0), 0);
     
      weeklyBreakdown.push({
        weekStart: weekDays[0].date,
        weekEnd: weekDays[weekDays.length - 1].date,
        totalSeconds: weekTotalSeconds,
        productiveSeconds: weekProductiveSeconds,
        totalHours: Math.round(weekTotalSeconds / 3600 * 10) / 10,
        nonProductiveSeconds: weekNPSeconds,
        dailyBreakdown: weekDays
      });
      weekDays = [];
    }
  }
 
  // Calculate month totals
  const totalSeconds = weeklyBreakdown.reduce((sum, week) => sum + week.totalSeconds, 0);
  const productiveSeconds = weeklyBreakdown.reduce((sum, week) => sum + (week.productiveSeconds || 0), 0);
  const totalNonProductiveSeconds = weeklyBreakdown.reduce((sum, week) => sum + (week.nonProductiveSeconds || 0), 0);
  const totalUnassignedSeconds = weeklyBreakdown.reduce((sum, week) => {
    return sum + (week.dailyBreakdown || []).reduce((ds, day) => {
      return ds + (day.issues || []).filter(i => i.issueKey === 'Unassigned').reduce((s, i) => s + i.totalSeconds, 0);
    }, 0);
  }, 0);
 
  // Get user info
  const userInfo = await supabaseRequest(
    supabaseConfig,
    `users?id=eq.${userId}&select=display_name,email&limit=1`
  );
  const displayName = userInfo[0]?.display_name || userInfo[0]?.email || 'Unknown User';
 
  return {
    userId,
    displayName,
    month,
    totalSeconds,
    productiveSeconds,
    totalHours: Math.round(totalSeconds / 3600 * 10) / 10,
    nonProductiveSeconds: totalNonProductiveSeconds,
    totalUnassignedSeconds,
    weeklyBreakdown
  };
}

/**
 * Generate exportable team analytics data
 * Creates CSV/Excel-ready data structure
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID
 * @param {string} projectKey - Project key
 * @param {string} startDate - Start date (YYYY-MM-DD)
 * @param {string} endDate - End date (YYYY-MM-DD)
 * @returns {Promise<string>} CSV formatted string
 */
export async function generateTeamExportData(accountId, cloudId, projectKey, startDate, endDate, filterUserIds, options = {}) {
  validateDateFormat(startDate);
  validateDateFormat(endDate);

  const mode = options.mode || 'projectWithUnassigned';
  const isUnassignedSection = mode === 'unassignedOnly';

  if (!isUnassignedSection && projectKey && !isValidProjectKey(projectKey)) {
    throw new Error('Invalid project key format');
  }

  const { supabaseConfig, organization } = await initializeContext(accountId, cloudId);

  let members;
  let teamAnalytics;
  if (isUnassignedSection) {
    members = options.presetMembers || [];
  } else {
    teamAnalytics = await fetchProjectTeamAnalytics(accountId, cloudId, projectKey, endDate);
    members = teamAnalytics.teamMemberActivity || [];
  }

  if (filterUserIds && filterUserIds.length > 0) {
    members = members.filter(m => filterUserIds.includes(m.userId));
  }

  const displayProjectKey = options.displayProjectKey || projectKey;

  const lines = [];
 
  // Helper: format seconds to show exact seconds
  const fmtDur = (secs) => {
    if (!secs || secs <= 0) return '0s';
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = secs % 60;
    if (h > 0 && m > 0 && s > 0) return `${h}h ${m}m ${s}s`;
    if (h > 0 && m > 0) return `${h}h ${m}m`;
    if (h > 0 && s > 0) return `${h}h ${s}s`;
    if (h > 0) return `${h}h`;
    if (m > 0 && s > 0) return `${m}m ${s}s`;
    if (m > 0) return `${m}m`;
    return `${s}s`;
  };

  // Helper: format short duration for individual sessions
  const fmtShort = (secs) => {
    if (!secs || secs <= 0) return '0s';
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    if (m > 0 && s > 0) return `${m}m ${s}s`;
    if (m > 0) return `${m}m`;
    return `${s}s`;
  };

  const memberNames = members.map(m => m.displayName).join(', ');

  // === HEADER ===
  lines.push(`Team Analytics - ${displayProjectKey || 'All Projects'} | ${startDate} to ${endDate} | ${memberNames}`);
  lines.push(`Generated,${new Date().toLocaleString()}`);
  lines.push('');

  // === DETAILED ACTIVITY PER MEMBER ===
  // All entries collected for Time by Issue section
  const allIssueSeconds = {};

  // Only members with recorded work get a detailed-activity block.
  const activeMembers = members.filter(m => m.monthHours > 0);

  // Single batched fetch (chunked, parallel) for all active members at once,
  // so total Supabase round trips scale with chunk count instead of team size.
  // `mode` controls whether NULL-project-key records are included (default), excluded
  // (multi-project per-project section), or are the only thing returned (synthetic
  // "Unassigned (All Projects)" section).
  const recordsByUser = await fetchActivityRecordsBatched(
    supabaseConfig,
    organization.id,
    activeMembers.map(m => m.userId),
    projectKey,
    startDate,
    endDate,
    mode
  );

  for (const member of activeMembers) {
    lines.push(`DETAILED ACTIVITY - ${member.displayName}`);
    lines.push('Member,Date,Issue Key,Classification,Total Time,Time (Start - End)');
    let memberTotalSeconds = 0;

    const memberRecords = recordsByUser.get(member.userId) || [];

    const records = memberRecords.filter(r =>
      r.classification === 'productive' || r.classification === 'unknown' || !r.classification
    );
    const npRecords = memberRecords.filter(r =>
      r.classification === 'non_productive' || r.classification === 'private'
    );

    // Group by date + issue key
    const grouped = {};
    records.forEach(record => {
      const workDate = typeof record.work_date === 'string' ? record.work_date.split('T')[0] : String(record.work_date);
      const issueKey = record.user_assigned_issue_key || 'Unassigned';
      const key = `${workDate}||${issueKey}`;
      if (!grouped[key]) {
        grouped[key] = { date: workDate, issueKey: issueKey, sessions: [], totalSeconds: 0 };
      }
      const dur = record.duration_seconds || 0;
      const startTime = record.start_time ? new Date(record.start_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) : '';
      const endTime = record.end_time ? new Date(record.end_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) : '';
      if (startTime && endTime && dur > 0) {
        grouped[key].sessions.push({ startTime, endTime, dur });
      }
      grouped[key].totalSeconds += dur;
    });

    Object.values(grouped).forEach(entry => {
      memberTotalSeconds += entry.totalSeconds;
      allIssueSeconds[entry.issueKey] = (allIssueSeconds[entry.issueKey] || 0) + entry.totalSeconds;

      const timingStr = formatCsvSessionRange(entry.sessions);
      lines.push(`${member.displayName},${entry.date},${entry.issueKey},Productive,${fmtDur(entry.totalSeconds)},"${timingStr}"`);
    });

    if (npRecords.length > 0) {
      const npGrouped = {};
      npRecords.forEach(record => {
        const workDate = typeof record.work_date === 'string' ? record.work_date.split('T')[0] : String(record.work_date);
        const issueKey = record.user_assigned_issue_key || 'Unassigned';
        const key = `${workDate}||${issueKey}`;
        if (!npGrouped[key]) {
          npGrouped[key] = { date: workDate, issueKey, sessions: [], totalSeconds: 0, classification: record.classification };
        }
        const dur = record.duration_seconds || 0;
        const startTime = record.start_time ? new Date(record.start_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) : '';
        const endTime = record.end_time ? new Date(record.end_time).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) : '';
        if (startTime && endTime && dur > 0) {
          npGrouped[key].sessions.push({ startTime, endTime, dur });
        }
        npGrouped[key].totalSeconds += dur;
      });
      Object.values(npGrouped).forEach(entry => {
        memberTotalSeconds += entry.totalSeconds;
        allIssueSeconds[entry.issueKey] = (allIssueSeconds[entry.issueKey] || 0) + entry.totalSeconds;
        const timingStr = formatCsvSessionRange(entry.sessions);
        const classLabel = entry.classification === 'private' ? 'Private' : 'Non-Productive';
        lines.push(`${member.displayName},${entry.date},${entry.issueKey},${classLabel},${fmtDur(entry.totalSeconds)},"${timingStr}"`);
      });
    }

    // Member total row (includes all classifications)
    lines.push(`TOTAL,,,,${fmtDur(memberTotalSeconds)},`);

    lines.push('');
  }
 
  // === TIME BY ISSUE ===
  lines.push('TIME BY ISSUE');
  lines.push('Issue Key,Total Time (min),Total Time,% of Total');
 
  const issueArray = Object.entries(allIssueSeconds)
    .map(([key, sec]) => ({ issueKey: key, totalSeconds: sec }))
    .sort((a, b) => b.totalSeconds - a.totalSeconds);
  const grandTotalSec = issueArray.reduce((s, i) => s + i.totalSeconds, 0);
 
  issueArray.forEach(issue => {
    const totalMin = Math.round(issue.totalSeconds / 60);
    const pct = grandTotalSec > 0 ? ((issue.totalSeconds / grandTotalSec) * 100).toFixed(1) : '0.0';
    lines.push(`${issue.issueKey},${totalMin},${fmtDur(issue.totalSeconds)},${pct}%`);
  });
  // Trailing % column blank: a TOTAL is by definition 100% of itself.
  lines.push(`TOTAL,${Math.round(grandTotalSec / 60)},${fmtDur(grandTotalSec)},`);
  lines.push('');
 
  // For modes that break out Unassigned into its own section, suppress the
  // duplicated Unassigned columns (always 0 then).
  const stripUnassigned = mode === 'projectOnly' || isUnassignedSection;
  const zero = (v) => stripUnassigned ? 0 : (v || 0);

  // Issues Worked: for the synthetic Unassigned section there's no teamAnalytics
  // to read from — derive from the distinct issue keys collected above.
  const issuesWorked = isUnassignedSection
    ? Object.keys(allIssueSeconds).length
    : (teamAnalytics?.teamSummary?.issuesWorked ?? 0);

  // === SUMMARY ===
  lines.push('SUMMARY');
  lines.push('Metric,Value');
  lines.push(`Active Members,${activeMembers.length}`);
  // Total Hours is summed across all members (inactive ones contribute 0).
  // Average is computed over ACTIVE members only — an org with 100 rostered
  // users where 3 actually worked should report avg = total/3, not total/100.
  const totalMemberHours = members.reduce((sum, m) => sum + m.monthHours, 0);
  lines.push(`Total Hours,${Math.round(totalMemberHours * 10) / 10}h`);
  lines.push(`Issues Worked,${issuesWorked}`);
  lines.push(`Average Hours/Member,${activeMembers.length > 0 ? Math.round(totalMemberHours / activeMembers.length * 10) / 10 : 0}h`);
  lines.push('');

  lines.push('MEMBER SUMMARY');
  lines.push('Member Name,Today,Today Unassigned,Today Non-Productive,This Week,Week Unassigned,Week Non-Productive,This Month,Month Unassigned,Month Non-Productive,% of Total');
  members.forEach(member => {
    const percentage = totalMemberHours > 0 ? Math.round((member.monthHours / totalMemberHours) * 100) : 0;
    lines.push(`"${member.displayName}",${fmtDur(member.todaySeconds)},${fmtDur(zero(member.todayUnassignedSeconds))},${fmtDur(member.todayNonProductiveSeconds || 0)},${fmtDur(member.weekSeconds)},${fmtDur(zero(member.weekUnassignedSeconds))},${fmtDur(member.weekNonProductiveSeconds || 0)},${fmtDur(member.monthSeconds)},${fmtDur(zero(member.monthUnassignedSeconds))},${fmtDur(member.monthNonProductiveSeconds || 0)},${percentage}%`);
  });
  const todayTotalSec = members.reduce((s, m) => s + (m.todaySeconds || 0), 0);
  const weekTotalSec = members.reduce((s, m) => s + (m.weekSeconds || 0), 0);
  const monthTotalSec = members.reduce((s, m) => s + (m.monthSeconds || 0), 0);
  const todayNpTotal = members.reduce((s, m) => s + (m.todayNonProductiveSeconds || 0), 0);
  const weekNpTotal = members.reduce((s, m) => s + (m.weekNonProductiveSeconds || 0), 0);
  const monthNpTotal = members.reduce((s, m) => s + (m.monthNonProductiveSeconds || 0), 0);
  const todayUnassignedTotal = members.reduce((s, m) => s + zero(m.todayUnassignedSeconds), 0);
  const weekUnassignedTotal = members.reduce((s, m) => s + zero(m.weekUnassignedSeconds), 0);
  const monthUnassignedTotal = members.reduce((s, m) => s + zero(m.monthUnassignedSeconds), 0);
  // Trailing % column blank — see TOTAL-row note above.
  lines.push(`"TOTAL",${fmtDur(todayTotalSec)},${fmtDur(todayUnassignedTotal)},${fmtDur(todayNpTotal)},${fmtDur(weekTotalSec)},${fmtDur(weekUnassignedTotal)},${fmtDur(weekNpTotal)},${fmtDur(monthTotalSec)},${fmtDur(monthUnassignedTotal)},${fmtDur(monthNpTotal)},`);

  return lines.join('\n');
}

/**
 * Generate structured export data for Excel generation on the frontend
 * Returns JSON with grouped sessions by date + issue
 *
 * @param {Object} [options]
 * @param {string} [options.mode='projectWithUnassigned'] - see fetchActivityRecordsBatched
 * @param {Array}  [options.presetMembers] - For 'unassignedOnly' mode: pre-built member
 *                  list (no fetchProjectTeamAnalytics call). Each member should already
 *                  have monthSeconds/monthUnassignedSeconds populated as desired.
 * @param {string} [options.displayProjectKey] - Override the projectKey reported in the
 *                  returned data (used to label the synthetic Unassigned section).
 */
export async function generateTeamExportDataStructured(accountId, cloudId, projectKey, startDate, endDate, filterUserIds, options = {}) {
  validateDateFormat(startDate);
  validateDateFormat(endDate);

  const mode = options.mode || 'projectWithUnassigned';
  const isUnassignedSection = mode === 'unassignedOnly';

  if (!isUnassignedSection && projectKey && !isValidProjectKey(projectKey)) {
    throw new Error('Invalid project key format');
  }

  const { supabaseConfig, organization } = await initializeContext(accountId, cloudId);

  let members;
  let teamAnalytics;
  if (isUnassignedSection) {
    // Caller pre-computes the union of users (across all selected projects) and
    // hands them in. fetchProjectTeamAnalytics doesn't apply — there's no project.
    members = options.presetMembers || [];
  } else {
    teamAnalytics = await fetchProjectTeamAnalytics(accountId, cloudId, projectKey, endDate);
    members = teamAnalytics.teamMemberActivity || [];
  }

  if (filterUserIds && filterUserIds.length > 0) {
    members = members.filter(m => filterUserIds.includes(m.userId));
  }

  const memberDetails = [];

  // Only members with recorded work get a detailed-activity block.
  const activeMembers = members.filter(m => m.monthHours > 0);

  // isSingleUser drives the `timeByIssue` shape in the returned payload.
  // It must reflect the contributors actually present in the report (active),
  // not the full project roster (which can include long-inactive users).
  const isSingleUser = activeMembers.length === 1;

  // Fetch all activity records for all active members in chunked, parallel queries.
  // One query per ~100 users instead of one per user keeps the Forge 25s budget
  // bounded by chunk count rather than by team size.
  const recordsByUser = await fetchActivityRecordsBatched(
    supabaseConfig,
    organization.id,
    activeMembers.map(m => m.userId),
    projectKey,
    startDate,
    endDate,
    mode
  );

  for (const member of activeMembers) {
    const memberData = {
      // userId enables the frontend renderer to dedupe by stable identity
      // (e.g. for cross-project unique-member counts) rather than display name.
      userId: member.userId,
      displayName: member.displayName,
      todayHours: member.todayHours,
      weekHours: member.weekHours,
      monthHours: member.monthHours,
      todaySeconds: member.todaySeconds || 0,
      weekSeconds: member.weekSeconds || 0,
      monthSeconds: member.monthSeconds || 0,
      todayUnassignedSeconds: member.todayUnassignedSeconds || 0,
      weekUnassignedSeconds: member.weekUnassignedSeconds || 0,
      monthUnassignedSeconds: member.monthUnassignedSeconds || 0,
      todayNonProductiveSeconds: member.todayNonProductiveSeconds || 0,
      weekNonProductiveSeconds: member.weekNonProductiveSeconds || 0,
      monthNonProductiveSeconds: member.monthNonProductiveSeconds || 0,
      entries: [], // {date, issueKey, totalSeconds, sessions:[{startTime, endTime, durationSeconds}]}
      nonProductiveEntries: [],
      totalSeconds: 0,
      nonProductiveTotalSeconds: 0
    };

    const memberRecords = recordsByUser.get(member.userId) || [];

    const records = memberRecords.filter(r =>
      r.classification === 'productive' || r.classification === 'unknown' || !r.classification
    );
    const npRecords = memberRecords.filter(r =>
      r.classification === 'non_productive' || r.classification === 'private'
    );

    const grouped = {};
    records.forEach(record => {
      const workDate = typeof record.work_date === 'string' ? record.work_date.split('T')[0] : String(record.work_date);
      const issueKey = record.user_assigned_issue_key || 'Unassigned';
      const key = `${workDate}||${issueKey}`;
      if (!grouped[key]) {
        grouped[key] = { date: workDate, issueKey: issueKey, sessions: [], totalSeconds: 0 };
      }
      grouped[key].sessions.push({
        startTime: record.start_time || null,
        endTime: record.end_time || null,
        durationSeconds: record.duration_seconds || 0
      });
      grouped[key].totalSeconds += record.duration_seconds || 0;
    });

    memberData.entries = Object.values(grouped);
    memberData.totalSeconds = memberData.entries.reduce((s, e) => s + e.totalSeconds, 0);

    if (npRecords.length > 0) {
      const npGrouped = {};
      npRecords.forEach(record => {
        const workDate = typeof record.work_date === 'string' ? record.work_date.split('T')[0] : String(record.work_date);
        const issueKey = record.user_assigned_issue_key || 'Unassigned';
        const key = `${workDate}||${issueKey}`;
        if (!npGrouped[key]) {
          npGrouped[key] = { date: workDate, issueKey, sessions: [], totalSeconds: 0, classification: record.classification };
        }
        npGrouped[key].sessions.push({
          startTime: record.start_time || null,
          endTime: record.end_time || null,
          durationSeconds: record.duration_seconds || 0
        });
        npGrouped[key].totalSeconds += record.duration_seconds || 0;
      });
      memberData.nonProductiveEntries = Object.values(npGrouped);
      memberData.nonProductiveTotalSeconds = memberData.nonProductiveEntries.reduce((s, e) => s + e.totalSeconds, 0);
      // Add non-productive to total seconds so export totals match the table
      memberData.totalSeconds += memberData.nonProductiveTotalSeconds;
    }

    memberDetails.push(memberData);
  }
 
  // Summary data
  const totalMemberHours = members.reduce((sum, m) => sum + m.monthHours, 0);

  // For mode='projectOnly': zero-out the Unassigned breakdown fields so per-project
  // member rows don't display NULL-project time that's now broken out into the
  // synthetic Unassigned section. Detailed-activity totals will then match the
  // Member Summary's "This Month" column for that project.
  // For mode='unassignedOnly': zero-out the same fields so the synthetic Unassigned
  // section doesn't show a redundant "Unassigned (Month)" breakdown (the whole
  // section is already unassigned).
  const stripUnassigned = mode === 'projectOnly' || isUnassignedSection;
  const zero = (v) => stripUnassigned ? 0 : (v || 0);

  // Update memberDetails (per-section summary rows in Sheet 1) so the "⚠ Unassigned"
  // breakdown line is 0 in projectOnly mode.
  if (stripUnassigned) {
    for (const md of memberDetails) {
      md.todayUnassignedSeconds = 0;
      md.weekUnassignedSeconds = 0;
      md.monthUnassignedSeconds = 0;
    }
  }

  // For unassigned section: the summary "issuesWorked" is just the count of
  // distinct issueKeys in entries (effectively 1 since all are 'Unassigned').
  const issuesWorked = isUnassignedSection
    ? (() => {
        const set = new Set();
        for (const md of memberDetails) {
          for (const e of md.entries) set.add(e.issueKey);
          for (const e of md.nonProductiveEntries) set.add(e.issueKey);
        }
        return set.size;
      })()
    : (teamAnalytics?.teamSummary?.issuesWorked ?? 0);

  return {
    projectKey: options.displayProjectKey || projectKey,
    isUnassignedSection,
    startDate,
    endDate,
    generatedAt: new Date().toISOString(),
    isSingleUser,
    memberDetails,
    summary: {
      activeMembers: activeMembers.length,
      totalHours: Math.round(totalMemberHours * 10) / 10,
      issuesWorked,
      // Divide by ACTIVE members so the average reflects people who actually
      // contributed; dividing by the full roster understates productivity for
      // teams with many inactive accounts.
      avgHoursPerMember: activeMembers.length > 0 ? Math.round(totalMemberHours / activeMembers.length * 10) / 10 : 0
    },
    memberSummary: members.map(m => ({
      userId: m.userId,
      displayName: m.displayName,
      todayHours: m.todayHours,
      weekHours: m.weekHours,
      monthHours: m.monthHours,
      todaySeconds: m.todaySeconds || 0,
      weekSeconds: m.weekSeconds || 0,
      monthSeconds: m.monthSeconds || 0,
      todayUnassignedSeconds: zero(m.todayUnassignedSeconds),
      weekUnassignedSeconds: zero(m.weekUnassignedSeconds),
      monthUnassignedSeconds: zero(m.monthUnassignedSeconds),
      todayNonProductiveSeconds: m.todayNonProductiveSeconds || 0,
      weekNonProductiveSeconds: m.weekNonProductiveSeconds || 0,
      monthNonProductiveSeconds: m.monthNonProductiveSeconds || 0,
      percentage: totalMemberHours > 0 ? Math.round((m.monthHours / totalMemberHours) * 100) : 0
    })),
    timeByIssue: !isSingleUser && !isUnassignedSection ? (teamAnalytics.teamTimeByIssue || []).map(issue => {
      const totalSeconds = teamAnalytics.teamTimeByIssue.reduce((sum, i) => sum + i.totalSeconds, 0);
      return {
        issueKey: issue.issueKey,
        totalSeconds: issue.totalSeconds,
        contributors: (issue.contributorDetails || []).map(c => c.displayName),
        percentage: totalSeconds > 0 ? Math.round((issue.totalSeconds / totalSeconds) * 100) : 0
      };
    }) : null
  };
}
