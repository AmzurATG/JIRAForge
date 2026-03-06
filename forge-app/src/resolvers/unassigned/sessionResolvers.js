/**
 * Session Resolvers for Unassigned Work
 * Handles fetching and querying unassigned work sessions and groups
 */

import { getSupabaseConfig, getOrCreateUser, getOrCreateOrganization, supabaseRequest, generateSignedUrl } from '../../utils/supabase.js';
import { formatDuration } from '../../utils/formatters.js';
import { isValidUUID, isValidDate, sanitizeUUIDArray, toSafeInteger } from '../../utils/validators.js';
import { initializeRequestContext, handleResolverError, ensureArray } from './helpers.js';

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Validate and sanitize session IDs from request payload
 * @param {Array} sessionIds - Raw session IDs from payload
 * @param {string} functionName - Name of calling function for logging
 * @returns {{valid: boolean, validSessionIds?: string[], error?: string}}
 */
function validateSessionIds(sessionIds, functionName) {
  const validSessionIds = sanitizeUUIDArray(sessionIds);
  console.log(`[${functionName}] Received ${sessionIds?.length || 0} session IDs, ${validSessionIds.length} valid`);

  if (validSessionIds.length === 0) {
    return { valid: false, error: 'No valid session IDs provided' };
  }

  return { valid: true, validSessionIds };
}

/**
 * Generate signed URLs for a screenshot
 * @param {Object} supabaseConfig - Supabase configuration
 * @param {Object} screenshot - Screenshot object with storage_path
 * @returns {Promise<{signed_url: string|null, signed_thumbnail_url: string|null}>}
 */
async function generateScreenshotUrls(supabaseConfig, screenshot) {
  let signed_thumbnail_url = screenshot.thumbnail_url;
  let signed_url = null;

  if (screenshot.storage_path) {
    try {
      // Generate signed URL for full-size image
      signed_url = await generateSignedUrl(supabaseConfig, 'screenshots', screenshot.storage_path, 3600);

      // Generate signed URL for thumbnail
      let thumbPath;
      if (screenshot.storage_path.includes('/')) {
        const dirPath = screenshot.storage_path.substring(0, screenshot.storage_path.lastIndexOf('/'));
        const filename = screenshot.storage_path.substring(screenshot.storage_path.lastIndexOf('/') + 1);
        const thumbFilename = filename.replace('screenshot_', 'thumb_').replace('.png', '.jpg');
        thumbPath = `${dirPath}/${thumbFilename}`;
      } else {
        thumbPath = screenshot.storage_path.replace('screenshot_', 'thumb_').replace('.png', '.jpg');
      }

      signed_thumbnail_url = await generateSignedUrl(supabaseConfig, 'screenshots', thumbPath, 3600);
    } catch (err) {
      console.error('Error generating signed URL:', err);
    }
  }

  return { signed_url, signed_thumbnail_url };
}

/**
 * Fetch unassigned activities by session IDs
 * @param {Object} supabaseConfig - Supabase configuration
 * @param {string[]} validSessionIds - Array of valid session UUIDs
 * @param {string} userId - User ID for filtering
 * @param {string} selectFields - Fields to select in query
 * @returns {Promise<Array>}
 */
async function fetchActivitiesBySessionIds(supabaseConfig, validSessionIds, userId, selectFields) {
  const sessionIdsParam = validSessionIds.join(',');
  const activities = await supabaseRequest(
    supabaseConfig,
    `unassigned_activity?id=in.(${sessionIdsParam})&user_id=eq.${userId}&select=${selectFields}`
  );
  return ensureArray(activities);
}

// ============================================================================
// Resolver Functions
// ============================================================================

/**
 * Get unassigned work sessions for current user
 * Queries both activity_records (hybrid OCR) and analysis_results (legacy screenshots)
 */
export async function getUnassignedWork(req) {
  try {
    const { limit: rawLimit, offset: rawOffset, dateFrom, dateTo } = req.payload || {};

    // Validate pagination parameters
    const limit = toSafeInteger(rawLimit, 50, 1, 500);
    const offset = toSafeInteger(rawOffset, 0, 0, 100000);

    // Initialize context (Supabase config, organization, user)
    const ctx = await initializeRequestContext(req);
    if (!ctx.success) return ctx;

    const { config: supabaseConfig, organization, userId } = ctx;

    // Query activity_records for unassigned work (hybrid OCR approach)
    let activityQuery = `activity_records?user_id=eq.${userId}&organization_id=eq.${organization.id}&user_assigned_issue_key=is.null&status=in.(pending,processing,analyzed)&classification=in.(productive,unknown)&select=id,window_title,application_name,start_time,end_time,duration_seconds,total_time_seconds,created_at&order=created_at.desc`;
    activityQuery += `&limit=${limit}&offset=${offset}`;
    if (dateFrom && isValidDate(dateFrom)) activityQuery += `&created_at=gte.${dateFrom}`;
    if (dateTo && isValidDate(dateTo)) activityQuery += `&created_at=lte.${dateTo}`;

    // Also query legacy analysis_results for backwards compatibility
    let legacyQuery = `analysis_results?select=*,screenshots(id,window_title,application_name,timestamp,thumbnail_url,storage_path)&user_id=eq.${userId}&organization_id=eq.${organization.id}&active_task_key=is.null&order=created_at.desc`;
    legacyQuery += `&limit=${limit}&offset=${offset}`;
    if (dateFrom && isValidDate(dateFrom)) legacyQuery += `&created_at=gte.${dateFrom}`;
    if (dateTo && isValidDate(dateTo)) legacyQuery += `&created_at=lte.${dateTo}`;

    const [activityResults, legacyResults] = await Promise.all([
      supabaseRequest(supabaseConfig, activityQuery),
      supabaseRequest(supabaseConfig, legacyQuery)
    ]);

    // Map activity_records to session format
    const activitySessions = (activityResults || []).map(record => ({
      id: record.id,
      window_title: record.window_title,
      application_name: record.application_name,
      timestamp: record.start_time || record.created_at,
      duration_seconds: record.duration_seconds || record.total_time_seconds || 0,
      source: 'activity_records'
    }));

    // Map legacy results to session format
    const legacySessions = (legacyResults || []).map(result => ({
      ...result,
      screenshot_id: result.screenshots?.id || result.screenshot_id,
      window_title: result.screenshots?.window_title,
      application_name: result.screenshots?.application_name,
      timestamp: result.screenshots?.timestamp || result.created_at,
      thumbnail_url: result.screenshots?.thumbnail_url,
      storage_path: result.screenshots?.storage_path,
      source: 'analysis_results'
    }));

    // Combine and sort by timestamp
    const allSessions = [...activitySessions, ...legacySessions]
      .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
      .slice(0, limit);

    return {
      success: true,
      sessions: allSessions,
      total: allSessions.length
    };

  } catch (error) {
    return handleResolverError(error, 'getting unassigned work');
  }
}

/**
 * Get already-clustered groups from database (AI server creates these automatically)
 * LAZY LOADING: Returns summary data only (no session_ids), with pagination
 * Full details are loaded on-demand via getGroupDetails when user expands a group
 */
export async function getUnassignedGroups(req) {
  try {
    const { limit: rawLimit = 10, offset: rawOffset = 0 } = req.payload || {};

    // Validate pagination parameters
    const limit = toSafeInteger(rawLimit, 10, 1, 100);
    const offset = toSafeInteger(rawOffset, 0, 0, 100000);

    // Initialize context (Supabase config, organization, user)
    const ctx = await initializeRequestContext(req);
    if (!ctx.success) return ctx;

    const { config: supabaseConfig, organization, userId } = ctx;

    // First, get total count for pagination info
    const countResult = await supabaseRequest(
      supabaseConfig,
      `unassigned_work_groups?user_id=eq.${userId}&organization_id=eq.${organization.id}&is_assigned=eq.false&select=id`,
      { headers: { 'Prefer': 'count=exact' } }
    );
    const totalCount = ensureArray(countResult).length;

    // LAZY LOADING: Fetch only summary data (no members/activities) with pagination
    // Session details loaded on-demand via getGroupDetails
    const groups = await supabaseRequest(
      supabaseConfig,
      `unassigned_work_groups?user_id=eq.${userId}&organization_id=eq.${organization.id}&is_assigned=eq.false&order=created_at.desc&limit=${limit}&offset=${offset}&select=id,group_label,group_description,session_count,total_seconds,confidence_level,recommended_action,suggested_issue_key,recommendation_reason,created_at`
    );

    if (!groups || groups.length === 0) {
      return { success: true, groups: [], total_groups: totalCount, has_more: false };
    }

    console.log(`[getUnassignedGroups] Loaded ${groups.length} groups (offset: ${offset}, total: ${totalCount})`);

    // Transform groups with minimal processing (no additional API calls)
    const enrichedGroups = groups.map((group) => {
      // Use DB values directly - no recalculation needed for summary view
      const totalTimeFormatted = formatDuration(group.total_seconds || 0);

      // Format recommendation data
      const recommendation = group.recommended_action ? {
        action: group.recommended_action,
        suggested_issue_key: group.suggested_issue_key || null,
        reason: group.recommendation_reason || ''
      } : null;

      return {
        id: group.id,
        label: group.group_label,
        description: group.group_description,
        session_count: group.session_count || 0,
        total_seconds: group.total_seconds || 0,
        total_time_formatted: totalTimeFormatted,
        confidence: group.confidence_level || 'medium',
        recommendation: recommendation,
        created_at: group.created_at,
        // Note: session_ids NOT included - loaded on-demand via getGroupDetails
        // This flag indicates details need to be fetched when expanded
        details_loaded: false
      };
    });

    // Filter out groups with 0 sessions (data inconsistency)
    const validGroups = enrichedGroups.filter(g => g.session_count > 0);

    return {
      success: true,
      groups: validGroups,
      total_groups: totalCount,
      has_more: offset + limit < totalCount,
      next_offset: offset + limit
    };

  } catch (error) {
    return handleResolverError(error, 'getting unassigned groups');
  }
}

/**
 * Get detailed data for a specific group (session_ids, recalculated totals)
 * LAZY LOADING: Called when user expands a group to see details
 */
export async function getGroupDetails(req) {
  try {
    const { groupId } = req.payload;

    if (!groupId || !isValidUUID(groupId)) {
      return { success: false, error: 'Valid Group ID required' };
    }

    // Initialize context (Supabase config, organization, user)
    const ctx = await initializeRequestContext(req);
    if (!ctx.success) return ctx;

    const { config: supabaseConfig } = ctx;

    console.log(`[getGroupDetails] Loading details for group: ${groupId}`);

    // Fetch group members with activity data in a single query
    // IMPORTANT: Use screenshots.duration_seconds (source of truth) instead of unassigned_activity.time_spent_seconds (stale)
    const members = await supabaseRequest(
      supabaseConfig,
      `unassigned_group_members?group_id=eq.${groupId}&select=id,unassigned_activity_id,unassigned_activity(id,window_title,application_name,timestamp,screenshot_id,screenshots(duration_seconds))`
    );

    const membersArray = ensureArray(members);

    // Calculate accurate total_seconds from screenshots.duration_seconds (source of truth)
    let totalSeconds = 0;
    membersArray.forEach(member => {
      const durationSeconds = member?.unassigned_activity?.screenshots?.duration_seconds;
      if (durationSeconds) {
        totalSeconds += durationSeconds;
      }
    });

    // Extract valid session IDs
    const sessionIds = membersArray
      .map(m => m?.unassigned_activity_id)
      .filter(id => {
        if (!id || typeof id !== 'string' || id.trim() === '') return false;
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id.trim());
      });

    console.log(`[getGroupDetails] Group ${groupId}: ${sessionIds.length} sessions, ${totalSeconds}s total`);

    return {
      success: true,
      groupId,
      session_ids: sessionIds,
      session_count: sessionIds.length,
      total_seconds: totalSeconds,
      total_time_formatted: formatDuration(totalSeconds),
      has_valid_sessions: sessionIds.length > 0
    };

  } catch (error) {
    return handleResolverError(error, 'getting group details');
  }
}

/**
 * Get screenshots for unassigned work group
 */
export async function getGroupScreenshots(req) {
  try {
    const { sessionIds } = req.payload;

    // Validate sessionIds as UUID array
    const validation = validateSessionIds(sessionIds, 'getGroupScreenshots');
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }
    const { validSessionIds } = validation;

    // Initialize context (Supabase config, organization, user)
    const ctx = await initializeRequestContext(req);
    if (!ctx.success) return ctx;

    const { config: supabaseConfig, userId } = ctx;

    // Get unassigned_activity records with their screenshot information
    console.log(`[getGroupScreenshots] Querying unassigned_activity with ${validSessionIds.length} IDs`);
    const activitiesArray = await fetchActivitiesBySessionIds(
      supabaseConfig,
      validSessionIds,
      userId,
      'id,analysis_result_id,window_title,application_name,timestamp,screenshot_id,screenshots(duration_seconds)'
    );

    console.log(`[getGroupScreenshots] Found ${activitiesArray.length} unassigned_activity records`);

    if (activitiesArray.length === 0) {
      console.log('[getGroupScreenshots] No activities found');
      return { success: true, screenshots: [] };
    }

    // Get analysis_result_ids to fetch screenshot details
    const analysisResultIds = sanitizeUUIDArray(activitiesArray.map(a => a.analysis_result_id));

    console.log(`[getGroupScreenshots] Found ${analysisResultIds.length} analysis_result_ids`);

    if (analysisResultIds.length === 0) {
      console.log('[getGroupScreenshots] No analysis result IDs found');
      return { success: true, screenshots: [] };
    }

    // Fetch analysis_results with screenshot data
    const analysisIdsParam = analysisResultIds.join(',');
    console.log(`[getGroupScreenshots] Querying analysis_results with ${analysisResultIds.length} IDs`);
    const analysisResults = await supabaseRequest(
      supabaseConfig,
      `analysis_results?id=in.(${analysisIdsParam})&select=id,screenshot_id,screenshots(id,timestamp,storage_path,thumbnail_url,window_title,application_name,duration_seconds)`
    );

    const resultsArray = ensureArray(analysisResults);
    console.log(`[getGroupScreenshots] Found ${resultsArray.length} analysis_results with screenshots`);

    // Generate signed URLs for screenshots in batches to avoid rate limiting
    const BATCH_SIZE = 10;
    const screenshotsWithUrls = [];

    for (let i = 0; i < resultsArray.length; i += BATCH_SIZE) {
      const batch = resultsArray.slice(i, i + BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(async (result) => {
          const screenshot = result.screenshots;
          if (!screenshot) return null;

          const { signed_url, signed_thumbnail_url } = await generateScreenshotUrls(supabaseConfig, screenshot);

          return {
            id: screenshot.id,
            timestamp: screenshot.timestamp,
            window_title: screenshot.window_title,
            application_name: screenshot.application_name,
            signed_thumbnail_url,
            signed_url
          };
        })
      );
      screenshotsWithUrls.push(...batchResults);

      // Small delay between batches to avoid rate limiting
      if (i + BATCH_SIZE < resultsArray.length) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    const validScreenshots = screenshotsWithUrls.filter(Boolean);

    // Sort screenshots by timestamp in descending order (latest first)
    validScreenshots.sort((a, b) => {
      const dateA = a.timestamp ? new Date(a.timestamp) : new Date(0);
      const dateB = b.timestamp ? new Date(b.timestamp) : new Date(0);
      return dateB - dateA;
    });

    return {
      success: true,
      screenshots: validScreenshots
    };

  } catch (error) {
    return handleResolverError(error, 'getting group screenshots');
  }
}

/**
 * Get work sessions for unassigned work group (grouped by date like Dashboard)
 */
export async function getGroupWorkSessions(req) {
  try {
    const { sessionIds } = req.payload;

    // Validate sessionIds as UUID array
    const validation = validateSessionIds(sessionIds, 'getGroupWorkSessions');
    if (!validation.valid) {
      return { success: false, error: validation.error };
    }
    const { validSessionIds } = validation;

    // Initialize context (Supabase config, organization, user)
    const ctx = await initializeRequestContext(req);
    if (!ctx.success) return ctx;

    const { config: supabaseConfig, userId } = ctx;

    // Get unassigned_activity records with screenshot timing data
    const sessionIdsParam = validSessionIds.join(',');
    const activities = await supabaseRequest(
      supabaseConfig,
      `unassigned_activity?id=in.(${sessionIdsParam})&user_id=eq.${userId}&select=id,analysis_result_id,window_title,application_name,timestamp,screenshot_id,screenshots(id,timestamp,start_time,end_time,duration_seconds,storage_path,work_date)&order=timestamp.asc`
    );

    if (!activities || activities.length === 0) {
      return { success: true, workSessions: [], sessionsByDate: {} };
    }

    const activitiesArray = ensureArray(activities);

    // Build work sessions similar to Dashboard logic
    const workSessions = [];
    const SESSION_GAP_THRESHOLD = 10 * 60 * 1000; // 10 minutes in milliseconds

    // Sort by timestamp
    const sortedActivities = [...activitiesArray].sort((a, b) => {
      const timeA = a.screenshots?.timestamp || a.timestamp;
      const timeB = b.screenshots?.timestamp || b.timestamp;
      return new Date(timeA) - new Date(timeB);
    });

    for (const activity of sortedActivities) {
      const screenshot = activity.screenshots;
      if (!screenshot) continue;

      const screenshotTimestamp = screenshot.timestamp || activity.timestamp;
      const durationSeconds = screenshot.duration_seconds || 0;

      // Calculate start and end time
      // IMPORTANT: Always calculate startTime from endTime - durationSeconds for accurate display
      const endTime = new Date(screenshotTimestamp);
      const startTime = new Date(endTime.getTime() - (durationSeconds * 1000));

      // Check if this can be merged with the last session
      if (workSessions.length > 0) {
        const lastSession = workSessions[workSessions.length - 1];
        const timeSinceLastSession = startTime - new Date(lastSession.endTime);

        if (timeSinceLastSession <= SESSION_GAP_THRESHOLD) {
          // Extend existing session - update end time and accumulate actual duration
          lastSession.endTime = endTime.toISOString();
          lastSession.activityIds.push(activity.id);
          lastSession.screenshotIds.push(screenshot.id);
          lastSession.durationSeconds = (lastSession.durationSeconds || 0) + durationSeconds;
          continue;
        }
      }

      // Create new session with actual duration tracking
      workSessions.push({
        startTime: startTime.toISOString(),
        endTime: endTime.toISOString(),
        date: screenshot.work_date || startTime.toISOString().split('T')[0],
        activityIds: [activity.id],
        screenshotIds: [screenshot.id],
        durationSeconds: durationSeconds
      });
    }

    // Recalculate startTime for merged sessions so displayed time range matches duration
    workSessions.forEach(session => {
      const end = new Date(session.endTime);
      session.startTime = new Date(end.getTime() - (session.durationSeconds * 1000)).toISOString();
    });

    // Group sessions by date
    const sessionsByDate = {};
    workSessions.forEach(session => {
      const dateKey = session.date;
      if (!sessionsByDate[dateKey]) {
        sessionsByDate[dateKey] = [];
      }
      sessionsByDate[dateKey].push(session);
    });

    // Calculate totals for each date using actual duration (not time span)
    const dateGroups = Object.keys(sessionsByDate)
      .sort((a, b) => new Date(b) - new Date(a)) // Most recent first
      .map(dateKey => {
        const sessions = sessionsByDate[dateKey];
        const totalSeconds = sessions.reduce((sum, s) => {
          return sum + (s.durationSeconds || 0);
        }, 0);

        return {
          date: dateKey,
          sessions: sessions,
          totalSeconds: totalSeconds,
          totalFormatted: formatDuration(totalSeconds)
        };
      });

    return {
      success: true,
      workSessions: workSessions,
      dateGroups: dateGroups
    };

  } catch (error) {
    return handleResolverError(error, 'getting group work sessions');
  }
}

/**
 * Register session resolvers
 */
export function registerSessionResolvers(resolver) {
  resolver.define('getUnassignedWork', getUnassignedWork);
  resolver.define('getUnassignedGroups', getUnassignedGroups);
  resolver.define('getGroupDetails', getGroupDetails);
  resolver.define('getGroupScreenshots', getGroupScreenshots);
  resolver.define('getGroupWorkSessions', getGroupWorkSessions);
}
