/**
 * Clustering Scheduling Service
 * Runs daily clustering of unassigned activities at a scheduled time
 * Also runs on startup if clustering hasn't happened in the last 24 hours
 */

const supabaseService = require('./supabase-service');
const clusteringService = require('./clustering-service');
const logger = require('../utils/logger');

// Configuration (can be overridden via environment variables)
const CLUSTERING_SCHEDULE_HOUR = Number.parseInt(process.env.CLUSTERING_SCHEDULE_HOUR || '2', 10); // 2 AM
const CLUSTERING_SCHEDULE_MINUTE = Number.parseInt(process.env.CLUSTERING_SCHEDULE_MINUTE || '0', 10); // 0 minutes
const MIN_SESSIONS_FOR_CLUSTERING = 2; // Need at least 2 sessions to cluster

let scheduledTimeoutId = null;
let isRunning = false;

/**
 * Main clustering function - processes all users with unassigned activities
 * @returns {Promise<boolean>} True if clustering completed successfully
 */
async function runClustering() {
  if (isRunning) {
    logger.warn('[Clustering] Clustering is already running, skipping');
    return false;
  }

  isRunning = true;
  const startTime = Date.now();

  try {
    logger.info('[Clustering] Starting daily clustering job...');

    // 1. Get all users who have unassigned activities
    const usersWithUnassigned = await supabaseService.getUsersWithUnassignedWork();

    if (usersWithUnassigned.length === 0) {
      logger.info('[Clustering] No users with unassigned work found');
      return true;
    }

    logger.info(`[Clustering] Found ${usersWithUnassigned.length} users with unassigned work`);

    let successCount = 0;
    let errorCount = 0;

    // 2. Process each user separately
    for (const user of usersWithUnassigned) {
      try {
        await processUserUnassignedWork(user.id, user.organization_id);
        successCount++;
      } catch (error) {
        errorCount++;
        logger.error(`[Clustering] Error processing user ${user.id}:`, error);
        // Continue with next user even if one fails
      }
    }

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    logger.info(`[Clustering] Daily clustering completed in ${duration}s - ${successCount} users processed, ${errorCount} errors`);

    return true;
  } catch (error) {
    logger.error('[Clustering] Error in clustering job:', error);
    return false;
  } finally {
    isRunning = false;
  }
}

/**
 * Process unassigned work for a single user within an organization
 * @param {string} userId - User ID to process
 * @param {string} organizationId - Organization ID for multi-tenancy filtering
 */
async function processUserUnassignedWork(userId, organizationId) {
  logger.info(`[Clustering] Processing user ${userId} in org ${organizationId}`);

  // 1. Get unassigned activities for this user - filter by organization
  const sessions = await supabaseService.getUnassignedActivities(userId, organizationId);

  if (sessions.length < MIN_SESSIONS_FOR_CLUSTERING) {
    logger.info(`[Clustering] User ${userId} has only ${sessions.length} unassigned sessions (need ${MIN_SESSIONS_FOR_CLUSTERING}), skipping`);
    return;
  }

  logger.info(`[Clustering] User ${userId} has ${sessions.length} unassigned sessions, starting clustering...`);

  // 2. Get user's active Jira issues for better AI recommendations
  const userIssues = await supabaseService.getUserActiveIssues(userId, organizationId);
  logger.info(`[Clustering] Found ${userIssues.length} active issues for user ${userId}`);

  // 3. Cluster sessions using GPT-4
  const clusteringResult = await clusteringService.clusterUnassignedWork(sessions, userIssues);

  if (!clusteringResult?.groups?.length) {
    logger.warn(`[Clustering] No groups created for user ${userId}`);
    return;
  }

  logger.info(`[Clustering] Created ${clusteringResult.groups.length} groups for user ${userId}`);

  // 4. Deduplicate session_ids across all groups (prevent same activity in multiple groups)
  const deduplicatedGroups = deduplicateSessionsAcrossGroups(clusteringResult.groups);

  // 5. Save each group to database
  for (const group of deduplicatedGroups) {
    await saveGroupToDatabase(userId, organizationId, group);
  }

  logger.info(`[Clustering] Successfully saved ${deduplicatedGroups.length} groups for user ${userId}`);
}

/**
 * Deduplicate session_ids across all groups to prevent same activity appearing in multiple groups
 * This handles the case where AI might return overlapping sessions in different groups
 * @param {Array} groups - Array of group objects from AI clustering
 * @returns {Array} Groups with deduplicated session_ids (empty groups removed)
 */
function deduplicateSessionsAcrossGroups(groups) {
  const seenSessionIds = new Set();
  let totalDuplicatesRemoved = 0;

  const deduplicatedGroups = groups.map(group => {
    const originalSessionIds = group.session_ids || [];
    const uniqueSessionIds = [];

    for (const sessionId of originalSessionIds) {
      if (seenSessionIds.has(sessionId)) {
        totalDuplicatesRemoved++;
        logger.warn(`[Clustering] Removing duplicate session ${sessionId} from group "${group.label}"`);
      } else {
        seenSessionIds.add(sessionId);
        uniqueSessionIds.push(sessionId);
      }
    }

    // If no sessions were removed, return the original group
    if (uniqueSessionIds.length === originalSessionIds.length) {
      return group;
    }

    // Calculate new total_seconds proportionally (rough estimate)
    const ratio = uniqueSessionIds.length / originalSessionIds.length;
    const newTotalSeconds = Math.round((group.total_seconds || 0) * ratio);

    return {
      ...group,
      session_ids: uniqueSessionIds,
      session_count: uniqueSessionIds.length,
      total_seconds: newTotalSeconds
    };
  }).filter(group => group.session_count > 0); // Remove empty groups

  if (totalDuplicatesRemoved > 0) {
    logger.info(`[Clustering] Removed ${totalDuplicatesRemoved} duplicate session assignments across groups`);
  }

  return deduplicatedGroups;
}

// Valid values for recommended_action (must match database check constraint)
const VALID_RECOMMENDED_ACTIONS = new Set(['assign_to_existing', 'create_new_issue']);

/**
 * Validate and normalize the recommended_action value
 * Maps invalid values (like 'none', 'ignore') to valid database values
 * @param {string} action - Raw action from AI
 * @returns {string} Valid action for database
 */
function normalizeRecommendedAction(action) {
  if (!action) {
    return 'create_new_issue';
  }

  const normalizedAction = action.toLowerCase().trim();

  // If it's a valid action, use it
  if (VALID_RECOMMENDED_ACTIONS.has(normalizedAction)) {
    return normalizedAction;
  }

  // Map common invalid values to valid ones
  // 'none', 'ignore', 'skip', 'dismiss' etc. -> 'create_new_issue' (for idle/break time)
  logger.warn(`[Clustering] Invalid recommended_action "${action}", defaulting to "create_new_issue"`);
  return 'create_new_issue';
}

/**
 * Save a clustered group to the database
 * @param {string} userId - User ID
 * @param {string} organizationId - Organization ID for multi-tenancy
 * @param {Object} group - Group data from AI clustering
 */
async function saveGroupToDatabase(userId, organizationId, group) {
  try {
    logger.info(`[Clustering] Saving group "${group.label}" with ${group.session_count} sessions`);

    // Validate and normalize the recommended action
    const recommendedAction = normalizeRecommendedAction(group.recommendation?.action);

    // 1. Create the group record
    const groupRecord = await supabaseService.createUnassignedGroup({
      user_id: userId,
      organization_id: organizationId,
      group_label: group.label,
      group_description: group.description,
      confidence_level: group.confidence,
      recommended_action: recommendedAction,
      suggested_issue_key: group.recommendation?.suggested_issue_key || null,
      recommendation_reason: group.recommendation?.reason || '',
      session_count: group.session_count,
      total_seconds: group.total_seconds,
      clustering_metadata: {
        session_indices: group.session_indices,
        total_time_formatted: group.total_time_formatted,
        full_group_data: group
      }
    });

    // 2. Add each session as a group member
    const sessionIds = group.session_ids || [];
    for (const sessionId of sessionIds) {
      try {
        await supabaseService.addGroupMember({
          group_id: groupRecord.id,
          unassigned_activity_id: sessionId
        });
      } catch (error) {
        logger.error(`[Clustering] Error adding session ${sessionId} to group ${groupRecord.id}:`, error);
        // Continue with other sessions even if one fails
      }
    }

    logger.info(`[Clustering] Successfully saved group ${groupRecord.id} with ${sessionIds.length} members`);
    return groupRecord;
  } catch (error) {
    logger.error(`[Clustering] Error saving group to database:`, error);
    throw error;
  }
}

/**
 * Calculate milliseconds until the next scheduled time
 * @returns {number} Milliseconds until next scheduled run
 */
function getMillisecondsUntilScheduledTime() {
  const now = new Date();
  const scheduledTime = new Date();

  scheduledTime.setHours(CLUSTERING_SCHEDULE_HOUR, CLUSTERING_SCHEDULE_MINUTE, 0, 0);

  // If scheduled time has passed today, schedule for tomorrow
  if (scheduledTime <= now) {
    scheduledTime.setDate(scheduledTime.getDate() + 1);
  }

  return scheduledTime.getTime() - now.getTime();
}

/**
 * Schedule the next clustering run
 */
function scheduleNextRun() {
  const msUntilNextRun = getMillisecondsUntilScheduledTime();
  const hoursUntilNextRun = (msUntilNextRun / (1000 * 60 * 60)).toFixed(2);

  const nextRunTime = new Date(Date.now() + msUntilNextRun);
  logger.info(`[Clustering] Next scheduled run at ${nextRunTime.toLocaleString()} (in ${hoursUntilNextRun} hours)`);

  scheduledTimeoutId = setTimeout(async () => {
    await runClustering();
    scheduleNextRun(); // Schedule the next day's run
  }, msUntilNextRun);
}

/**
 * Run clustering on startup if it hasn't run in the last 24 hours
 * @returns {Promise<boolean>} True if startup clustering was needed and completed
 */
async function runStartupClusteringIfNeeded() {
  try {
    logger.info('[Clustering] Checking if startup clustering is needed...');

    const hasRunRecently = await supabaseService.hasClusteringRunRecently(24);

    if (hasRunRecently) {
      const lastRunTime = await supabaseService.getLastClusteringRunTime();
      logger.info(`[Clustering] Clustering has already run recently (last run: ${lastRunTime?.toLocaleString()}), skipping startup clustering`);
      return false;
    }

    // Check if there are any unassigned activities to cluster
    const ungroupedCount = await supabaseService.getUngroupedActivityCount();
    if (ungroupedCount < MIN_SESSIONS_FOR_CLUSTERING) {
      logger.info(`[Clustering] Only ${ungroupedCount} ungrouped activities found (need ${MIN_SESSIONS_FOR_CLUSTERING}), skipping startup clustering`);
      return false;
    }

    logger.info(`[Clustering] Clustering hasn't run in 24 hours and ${ungroupedCount} ungrouped activities found, running startup clustering...`);

    const success = await runClustering();
    return success;
  } catch (error) {
    logger.error('[Clustering] Error in startup clustering check:', error);
    return false;
  }
}

/**
 * Start the clustering service
 * Runs startup clustering if needed, then schedules daily runs
 * @returns {Promise<void>}
 */
async function start() {
  logger.info('[Clustering] Starting clustering service...');
  logger.info(`[Clustering] Scheduled time: ${CLUSTERING_SCHEDULE_HOUR}:${CLUSTERING_SCHEDULE_MINUTE.toString().padStart(2, '0')}`);

  // Run startup clustering if needed (this blocks until complete)
  await runStartupClusteringIfNeeded();

  // Schedule the daily run
  scheduleNextRun();

  logger.info('[Clustering] Clustering service started successfully');
}

/**
 * Stop the clustering service
 */
function stop() {
  if (scheduledTimeoutId) {
    clearTimeout(scheduledTimeoutId);
    scheduledTimeoutId = null;
    logger.info('[Clustering] Clustering service stopped');
  }
}

/**
 * Check if clustering is currently running
 * @returns {boolean}
 */
function isClusteringRunning() {
  return isRunning;
}

module.exports = {
  start,
  stop,
  runClustering, // Exported for manual triggering
  runStartupClusteringIfNeeded, // Exported for startup sequence
  isClusteringRunning,
  processUserUnassignedWork // Exported for testing
};
