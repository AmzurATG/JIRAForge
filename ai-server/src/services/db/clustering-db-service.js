/**
 * Clustering Database Service Module
 * Handles unassigned work clustering and grouping operations
 */

const { getClient } = require('./supabase-client');
const logger = require('../../utils/logger');
const { toUTCISOString } = require('../../utils/datetime');

// Minimum session duration (seconds) to include in clustering.
// Sessions shorter than this are noise (brief window switches that slipped past
// the desktop app's 5-second upload filter) and waste LLM tokens.
const MIN_CLUSTERING_SESSION_SECONDS = 10;

/**
 * Compute whether a group should be classified as idle-only
 * Returns true only if ALL members are activity_records AND all have is_idle = true
 * Legacy members (from unassigned_activity) are treated as work (no is_idle field)
 * @param {Array} sessions - Array of session objects from both pipelines
 * @returns {boolean} True if all sessions are idle activity_records, false otherwise
 */
function computeIsIdleOnly(sessions) {
  // Guard clauses for invalid input
  if (!sessions || !Array.isArray(sessions) || sessions.length === 0) {
    return false;
  }

  // Filter to only activity_records (source field indicates pipeline)
  const activityRecords = sessions.filter(s => s.source === 'activity_records');

  // If no activity_records, group contains only legacy members → work group
  // OR if there are mixed members (some legacy, some activity_records) → work group
  if (activityRecords.length === 0 || activityRecords.length !== sessions.length) {
    return false;
  }

  // Check if ALL activity_records have is_idle = true (strict boolean check)
  return activityRecords.every(record => record.is_idle === true);
}

/**
 * Get all users who have UNGROUPED unassigned activities (grouped by user and organization)
 * Checks both legacy unassigned_activity table and new activity_records table.
 * @returns {Promise<Array>} Array of user objects with ungrouped unassigned work and their organization
 */
async function getUsersWithUnassignedWork() {
  try {
    const supabase = getClient();

    // Step 1: Get all IDs already in groups (both legacy and new pipeline)
    const { data: groupedMembers, error: groupedError } = await supabase
      .from('unassigned_group_members')
      .select('unassigned_activity_id, activity_record_id');

    if (groupedError) {
      throw groupedError;
    }

    const groupedLegacyIdSet = new Set(
      (groupedMembers || []).map(g => g.unassigned_activity_id).filter(Boolean)
    );
    const groupedActivityRecordIdSet = new Set(
      (groupedMembers || []).map(g => g.activity_record_id).filter(Boolean)
    );

    // Step 2a: Get ungrouped legacy unassigned_activity records
    const { data: legacyData, error: legacyError } = await supabase
      .from('unassigned_activity')
      .select('id, user_id, organization_id')
      .eq('manually_assigned', false)
      .eq('clustering_dismissed', false)
      .order('timestamp', { ascending: false });

    if (legacyError) {
      throw legacyError;
    }

    const ungroupedLegacy = (legacyData || []).filter(a => !groupedLegacyIdSet.has(a.id));

    // Step 2b: Get ungrouped new-pipeline activity_records
    const { data: arData, error: arError } = await supabase
      .from('activity_records')
      .select('id, user_id, organization_id')
      .is('user_assigned_issue_key', null)
      .in('status', ['pending', 'processing', 'analyzed'])
      .in('classification', ['productive', 'unknown'])
      .eq('clustering_dismissed', false);

    if (arError) {
      logger.warn('Error fetching activity_records for clustering:', arError);
    }

    const ungroupedActivityRecords = (arData || []).filter(r => !groupedActivityRecordIdSet.has(r.id));

    // Step 3: Merge both sources into unique user+org combinations
    const uniqueCombos = new Map();
    for (const item of [...ungroupedLegacy, ...ungroupedActivityRecords]) {
      const key = `${item.user_id}_${item.organization_id}`;
      if (!uniqueCombos.has(key)) {
        uniqueCombos.set(key, { id: item.user_id, organization_id: item.organization_id });
      }
    }

    return Array.from(uniqueCombos.values());
  } catch (error) {
    logger.error('Error fetching users with unassigned work:', error);
    return [];
  }
}

/**
 * Get UNGROUPED unassigned activities for a specific user within an organization
 * Only returns activities that haven't been clustered into groups yet.
 * Returns sessions from BOTH legacy unassigned_activity and new activity_records tables.
 * @param {string} userId - User ID
 * @param {string} organizationId - Organization ID for multi-tenancy filtering
 * @returns {Promise<Array>} Array of ungrouped unassigned activity sessions
 */
async function getUnassignedActivities(userId, organizationId) {
  try {
    const supabase = getClient();

    // Step 1: Get all activity IDs that are already in groups (both pipelines)
    const { data: groupedActivities, error: groupedError } = await supabase
      .from('unassigned_group_members')
      .select('unassigned_activity_id, activity_record_id');

    if (groupedError) {
      throw groupedError;
    }

    const groupedLegacyIdSet = new Set(
      (groupedActivities || []).map(g => g.unassigned_activity_id).filter(Boolean)
    );
    const groupedActivityRecordIdSet = new Set(
      (groupedActivities || []).map(g => g.activity_record_id).filter(Boolean)
    );

    // Step 2a: Get legacy unassigned_activity records with screenshot data
    // IMPORTANT: JOIN with screenshots to get duration_seconds (source of truth)
    // instead of using unassigned_activity.time_spent_seconds (stale)
    // Limit to most recent 2000 to prevent timeout on large datasets
    let legacyQuery = supabase
      .from('unassigned_activity')
      .select(`
        id,
        screenshot_id,
        timestamp,
        window_title,
        application_name,
        extracted_text,
        reason,
        confidence_score,
        metadata,
        analysis_result_id,
        organization_id,
        screenshots(duration_seconds)
      `)
      .eq('user_id', userId)
      .eq('manually_assigned', false)
      .eq('clustering_dismissed', false)
      .order('timestamp', { ascending: false })
      .limit(2000);

    if (organizationId) {
      legacyQuery = legacyQuery.eq('organization_id', organizationId);
    }

    const { data: legacyData, error: legacyError } = await legacyQuery;

    if (legacyError) {
      throw legacyError;
    }

    // Filter out activities that are already grouped
    const ungroupedLegacy = (legacyData || []).filter(a => !groupedLegacyIdSet.has(a.id));

    // Fetch analysis_metadata for each ungrouped legacy activity to get AI reasoning
    const enrichedLegacy = await Promise.all(
      ungroupedLegacy.map(async (activity) => {
        const { data: analysisData } = await supabase
          .from('analysis_results')
          .select('analysis_metadata')
          .eq('id', activity.analysis_result_id)
          .single();

        return {
          ...activity,
          // Use screenshots.duration_seconds (legacy) or direct duration fields (hybrid OCR)
          time_spent_seconds: activity.screenshots?.duration_seconds || activity.duration_seconds || activity.total_time_seconds || 0,
          reasoning: analysisData?.analysis_metadata?.reasoning || 'No description available',
          source: 'unassigned_activity'
        };
      })
    );

    // Step 2b: Get new-pipeline activity_records that have no assigned issue
    // Limit to most recent 2000 to prevent timeout on large datasets
    let arQuery = supabase
      .from('activity_records')
      .select('id, window_title, application_name, ocr_text, duration_seconds, total_time_seconds, organization_id, start_time, is_idle')
      .eq('user_id', userId)
      .is('user_assigned_issue_key', null)
      .in('status', ['pending', 'processing', 'analyzed'])
      .in('classification', ['productive', 'unknown'])
      .eq('clustering_dismissed', false)
      .order('start_time', { ascending: false })
      .limit(2000);

    if (organizationId) {
      arQuery = arQuery.eq('organization_id', organizationId);
    }

    const { data: arData, error: arError } = await arQuery;

    if (arError) {
      logger.warn('Error fetching activity_records for clustering:', arError);
    }

    const ungroupedAR = (arData || []).filter(r => !groupedActivityRecordIdSet.has(r.id));

    // Map activity_records to the same session format used by clustering-service.js
    const mappedAR = ungroupedAR.map(record => ({
      id: record.id,
      timestamp: record.start_time,
      window_title: record.window_title || '',
      application_name: record.application_name || '',
      extracted_text: record.ocr_text || '',
      time_spent_seconds: record.duration_seconds || record.total_time_seconds || 0,
      reasoning: record.window_title || 'Activity record',
      organization_id: record.organization_id,
      source: 'activity_records',
      is_idle: record.is_idle  // Include is_idle for computeIsIdleOnly
    }));

    const allSessions = [...enrichedLegacy, ...mappedAR];

    // Filter out very short sessions that are noise and waste LLM tokens.
    // Brief visits (< 10s) have no meaningful OCR content for clustering.
    const before = allSessions.length;
    const filtered = allSessions.filter(s => (s.time_spent_seconds || 0) >= MIN_CLUSTERING_SESSION_SECONDS);
    if (before > filtered.length) {
      logger.info(`[Clustering] Filtered ${before - filtered.length} short sessions (< ${MIN_CLUSTERING_SESSION_SECONDS}s) for user ${userId}`);
    }

    return filtered;
  } catch (error) {
    logger.error('Error fetching unassigned activities:', error);
    throw new Error(`Failed to fetch unassigned activities: ${error.message}`);
  }
}

/**
 * Check if user has recent groups (to avoid re-clustering too frequently)
 * @param {string} userId - User ID
 * @param {number} hoursAgo - How many hours ago to check
 * @param {string} organizationId - Organization ID for multi-tenancy filtering
 * @returns {Promise<Array>} Recent groups
 */
async function getRecentGroups(userId, hoursAgo = 24, organizationId = null) {
  try {
    const supabase = getClient();
    const cutoffTime = toUTCISOString(new Date(Date.now() - hoursAgo * 60 * 60 * 1000));

    let query = supabase
      .from('unassigned_work_groups')
      .select('id, created_at')
      .eq('user_id', userId)
      .gte('created_at', cutoffTime);

    // Filter by organization if provided
    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    return data || [];
  } catch (error) {
    logger.error('Error fetching recent groups:', error);
    return [];
  }
}

/**
 * Create a new unassigned work group
 * @param {Object} groupData - Group data from AI clustering (should include organization_id)
 * @returns {Promise<Object>} Created group record
 */
async function createUnassignedGroup(groupData) {
  try {
    const supabase = getClient();
    const { data, error } = await supabase
      .from('unassigned_work_groups')
      .insert({
        user_id: groupData.user_id,
        organization_id: groupData.organization_id,
        group_label: groupData.group_label,
        group_description: groupData.group_description,
        confidence_level: groupData.confidence_level,
        recommended_action: groupData.recommended_action,
        suggested_issue_key: groupData.suggested_issue_key,
        recommendation_reason: groupData.recommendation_reason,
        session_count: groupData.session_count,
        total_seconds: groupData.total_seconds,
        clustering_metadata: groupData.clustering_metadata || {},
        is_idle_only: groupData.is_idle_only || false  // Phase 2: Precomputed idle classification
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    logger.info(`Created unassigned group: ${data.id} for user ${groupData.user_id} in org ${groupData.organization_id} (idle_only: ${data.is_idle_only})`);
    return data;
  } catch (error) {
    logger.error('Error creating unassigned group:', error);
    throw new Error(`Failed to create unassigned group: ${error.message}`);
  }
}

/**
 * Add a member to an unassigned work group
 * Supports both legacy unassigned_activity_id and new activity_record_id
 * @param {Object} memberData - Member data
 * @param {string} memberData.group_id - Group ID
 * @param {string} [memberData.unassigned_activity_id] - Legacy activity ID (mutually exclusive with activity_record_id)
 * @param {string} [memberData.activity_record_id] - New pipeline activity record ID (mutually exclusive with unassigned_activity_id)
 * @returns {Promise<Object|null>} Created member record or null if duplicate
 */
async function addGroupMember(memberData) {
  try {
    const supabase = getClient();

    const insertRow = { group_id: memberData.group_id };
    if (memberData.activity_record_id) {
      insertRow.activity_record_id = memberData.activity_record_id;
    } else {
      insertRow.unassigned_activity_id = memberData.unassigned_activity_id;
    }

    const { data, error } = await supabase
      .from('unassigned_group_members')
      .insert(insertRow)
      .select()
      .single();

    if (error) {
      // Handle duplicate key errors gracefully - activity may already be in a group
      if (error.code === '23505') { // PostgreSQL unique violation code
        const id = memberData.activity_record_id || memberData.unassigned_activity_id;
        logger.warn(`Activity ${id} already assigned to a group, skipping`);
        return null;
      }
      throw error;
    }

    return data;
  } catch (error) {
    logger.error('Error adding group member:', error);
    throw new Error(`Failed to add group member: ${error.message}`);
  }
}

/**
 * Get the timestamp of the most recent clustering run
 * Uses the latest unassigned_work_groups created_at as a proxy
 * @returns {Promise<Date|null>} Last clustering run time or null if never run
 */
async function getLastClusteringRunTime() {
  try {
    const supabase = getClient();
    const { data, error } = await supabase
      .from('unassigned_work_groups')
      .select('created_at')
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      // No groups exist yet - clustering has never run
      if (error.code === 'PGRST116') {
        return null;
      }
      throw error;
    }

    return data ? new Date(data.created_at) : null;
  } catch (error) {
    logger.error('Error getting last clustering run time:', error);
    return null;
  }
}

/**
 * Check if clustering has run within the specified hours
 * @param {number} hours - Number of hours to check
 * @returns {Promise<boolean>} True if clustering has run within the specified hours
 */
async function hasClusteringRunRecently(hours = 24) {
  try {
    const lastRunTime = await getLastClusteringRunTime();

    if (!lastRunTime) {
      return false; // Never run
    }

    const cutoffTime = new Date();
    cutoffTime.setHours(cutoffTime.getHours() - hours);

    return lastRunTime > cutoffTime;
  } catch (error) {
    logger.error('Error checking clustering run time:', error);
    return false; // Assume not run recently on error
  }
}

/**
 * Get count of unassigned activities that haven't been grouped yet
 * Counts from both legacy unassigned_activity and new activity_records tables.
 * @returns {Promise<number>} Count of ungrouped unassigned activities
 */
async function getUngroupedActivityCount() {
  try {
    const supabase = getClient();

    // Step 1: Get all IDs already in groups (both pipelines)
    const { data: groupedActivities, error: groupedError } = await supabase
      .from('unassigned_group_members')
      .select('unassigned_activity_id, activity_record_id');

    if (groupedError) {
      throw groupedError;
    }

    const groupedLegacyIdSet = new Set(
      (groupedActivities || []).map(g => g.unassigned_activity_id).filter(Boolean)
    );
    const groupedActivityRecordIdSet = new Set(
      (groupedActivities || []).map(g => g.activity_record_id).filter(Boolean)
    );

    // Step 2a: Count ungrouped legacy unassigned_activity records
    const { data: legacyData, error: legacyError } = await supabase
      .from('unassigned_activity')
      .select('id')
      .eq('manually_assigned', false)
      .eq('clustering_dismissed', false);

    if (legacyError) {
      throw legacyError;
    }

    const ungroupedLegacyCount = (legacyData || []).filter(a => !groupedLegacyIdSet.has(a.id)).length;

    // Step 2b: Count ungrouped new-pipeline activity_records
    const { data: arData, error: arError } = await supabase
      .from('activity_records')
      .select('id')
      .is('user_assigned_issue_key', null)
      .in('status', ['pending', 'processing', 'analyzed'])
      .in('classification', ['productive', 'unknown'])
      .eq('clustering_dismissed', false);

    if (arError) {
      logger.warn('Error counting activity_records for ungrouped count:', arError);
    }

    const ungroupedARCount = (arData || []).filter(r => !groupedActivityRecordIdSet.has(r.id)).length;

    return ungroupedLegacyCount + ungroupedARCount;
  } catch (error) {
    logger.error('Error getting ungrouped activity count:', error);
    return 0;
  }
}

/**
 * Get unassigned work groups for a user
 * @param {string} userId - User ID
 * @param {string} organizationId - Organization ID
 * @returns {Promise<Array>} Array of groups with their members
 */
async function getUnassignedWorkGroups(userId, organizationId = null) {
  try {
    const supabase = getClient();
    let query = supabase
      .from('unassigned_work_groups')
      .select(`
        *,
        unassigned_group_members (
          id,
          unassigned_activity_id,
          activity_record_id
        )
      `)
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (organizationId) {
      query = query.eq('organization_id', organizationId);
    }

    const { data, error } = await query;

    if (error) {
      throw error;
    }

    return data || [];
  } catch (error) {
    logger.error('Error fetching unassigned work groups:', error);
    return [];
  }
}

module.exports = {
  getUsersWithUnassignedWork,
  getUnassignedActivities,
  getRecentGroups,
  createUnassignedGroup,
  addGroupMember,
  getLastClusteringRunTime,
  hasClusteringRunRecently,
  getUngroupedActivityCount,
  getUnassignedWorkGroups,
  computeIsIdleOnly,  // Exported for testing
};
