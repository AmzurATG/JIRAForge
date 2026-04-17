/**
 * Work Assignment Service
 * Centralized logic for issue creation, worklog management, and session assignment
 * Used by idle-time conversion, unassigned-work assignment, and timeline conversions
 */

import api, { route } from '@forge/api';
import { getTrackingSettings } from './settingsService.js';
import { supabaseRequest } from '../utils/supabase.js';
import { formatDuration } from '../utils/formatters.js';
import { sanitizeUUIDArray, isValidUUID } from '../utils/validators.js';

const JIRA_MIN_WORKLOG_SECONDS = 60;

/**
 * Create worklog if conditions met (respects sub-minute deferral policy)
 * Used across all assignment flows
 * @param {Object} options - Worklog options
 * @param {string} options.issueKey - Jira issue key
 * @param {number} options.timeToLog - Time in seconds
 * @param {number} options.sessionCount - Number of sessions
 * @param {boolean} options.autoSyncEnabled - Whether auto-sync is enabled
 * @param {string} [options.customComment] - Optional custom comment
 * @returns {Promise<{worklog: Object, worklogSkipped: boolean, worklogSkippedReason: string}>}
 */
export async function createWorklogIfNeeded({ issueKey, timeToLog, sessionCount, autoSyncEnabled, customComment }) {
  if (autoSyncEnabled) {
    console.log(`[worklog] Skipping worklog - auto-sync is enabled`);
    return {
      worklog: null,
      worklogSkipped: true,
      worklogSkippedReason: 'Auto-sync enabled; scheduled sync will create the worklog'
    };
  }

  if (!timeToLog || timeToLog <= 0) {
    console.log(`[worklog] Skipping worklog — no time to log (${timeToLog}s)`);
    return {
      worklog: null,
      worklogSkipped: true,
      worklogSkippedReason: 'No time to log'
    };
  }

  if (timeToLog < JIRA_MIN_WORKLOG_SECONDS) {
    console.log(`[worklog] Deferring sub-minute worklog (${timeToLog}s < ${JIRA_MIN_WORKLOG_SECONDS}s) to scheduled sync for aggregation`);
    return {
      worklog: null,
      worklogSkipped: true,
      worklogSkippedReason: `Time is under ${JIRA_MIN_WORKLOG_SECONDS}s — deferred to scheduled sync for aggregation`
    };
  }

  try {
    const commentText = customComment || `Time tracked from ${sessionCount} work session(s), grouped and assigned manually.`;

    const worklogResponse = await api.asUser().requestJira(
      route`/rest/api/3/issue/${issueKey}/worklog?adjustEstimate=leave`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          timeSpentSeconds: timeToLog,
          comment: {
            type: 'doc',
            version: 1,
            content: [
              {
                type: 'paragraph',
                content: [
                  {
                    type: 'text',
                    text: commentText
                  }
                ]
              }
            ]
          },
          started: new Date().toISOString()
        })
      }
    );

    if (worklogResponse.ok) {
      const worklog = await worklogResponse.json();
      console.log(`[worklog] Created worklog ${worklog.id} for ${issueKey}: ${timeToLog}s`);
      return { worklog, worklogSkipped: false, worklogSkippedReason: null };
    } else {
      const errorText = await worklogResponse.text();
      console.error(`[worklog] Failed to create worklog for ${issueKey}:`, errorText);
      return {
        worklog: null,
        worklogSkipped: true,
        worklogSkippedReason: `Jira API error: ${errorText}`
      };
    }
  } catch (error) {
    console.error(`[worklog] Error creating worklog:`, error);
    return {
      worklog: null,
      worklogSkipped: true,
      worklogSkippedReason: error.message
    };
  }
}

/**
 * Update activity records with issue assignment
 * Sets user_assigned_issue_key and project_key for conversion tracking
 * @param {Object} supabaseConfig - Supabase config
 * @param {string[]} sessionIds - Activity record IDs to update
 * @param {string} issueKey - Target issue key
 * @param {string} userId - User ID for validation
 * @returns {Promise<number>} Number of records updated
 */
export async function updateActivityRecordsWithIssueAssignment(supabaseConfig, sessionIds, issueKey, userId) {
  if (!sessionIds || sessionIds.length === 0) {
    return 0;
  }

  const validIds = sanitizeUUIDArray(sessionIds);
  if (validIds.length === 0) {
    return 0;
  }

  const projectKey = issueKey.split('-')[0];
  const sessionIdsParam = validIds.join(',');

  try {
    // SECURITY: Only update records belonging to current user
    const updated = await supabaseRequest(
      supabaseConfig,
      `activity_records?id=in.(${sessionIdsParam})&user_id=eq.${userId}`,
      {
        method: 'PATCH',
        headers: { 'Prefer': 'return=representation' },
        body: {
          user_assigned_issue_key: issueKey,
          project_key: projectKey
        }
      }
    );

    const count = Array.isArray(updated) ? updated.length : 0;
    console.log(`[updateActivityRecords] Updated ${count} activity records with issue key ${issueKey}`);
    return count;
  } catch (error) {
    console.error(`[updateActivityRecords] Error updating activity records:`, error);
    throw error;
  }
}

/**
 * Remove converted sessions from unassigned groups
 * Updates group membership and aggregate counters
 * @param {Object} supabaseConfig - Supabase config
 * @param {string[]} sessionIds - Activity record IDs that were converted
 * @param {string} userId - User ID for scope
 * @returns {Promise<{removedCount: number, updatedGroupIds: string[]}>}
 */
export async function removeConvertedSessionsFromGroups(supabaseConfig, sessionIds, userId) {
  if (!sessionIds || sessionIds.length === 0) {
    return { removedCount: 0, updatedGroupIds: [] };
  }

  const validIds = sanitizeUUIDArray(sessionIds);
  if (validIds.length === 0) {
    return { removedCount: 0, updatedGroupIds: [] };
  }

  try {
    const sessionIdsParam = validIds.join(',');

    // Find which groups contain these sessions
    console.log(`[removeFromGroups] Finding groups for ${validIds.length} sessions`);
    const groupMembers = await supabaseRequest(
      supabaseConfig,
      `unassigned_group_members?activity_record_id=in.(${sessionIdsParam})&select=id,group_id,activity_record_id`
    );

    const membersArray = Array.isArray(groupMembers) ? groupMembers : [];
    console.log(`[removeFromGroups] Found ${membersArray.length} group memberships to remove`);

    if (membersArray.length === 0) {
      return { removedCount: 0, updatedGroupIds: [] };
    }

    // Collect affected group IDs
    const affectedGroupIds = new Set(membersArray.map(m => m.group_id).filter(Boolean));
    const memberIds = membersArray.map(m => m.id).filter(Boolean);

    // Delete group membership records
    if (memberIds.length > 0) {
      const memberIdsParam = sanitizeUUIDArray(memberIds).join(',');
      await supabaseRequest(
        supabaseConfig,
        `unassigned_group_members?id=in.(${memberIdsParam})`,
        { method: 'DELETE' }
      );
      console.log(`[removeFromGroups] Deleted ${memberIds.length} group member rows`);
    }

    // Recalculate aggregates for each affected group
    const updatedGroupIds = [];
    for (const groupId of affectedGroupIds) {
      if (!isValidUUID(groupId)) continue;

      try {
        // Count remaining members
        const remainingMembers = await supabaseRequest(
          supabaseConfig,
          `unassigned_group_members?group_id=eq.${groupId}&select=id`
        );

        const remainingCount = Array.isArray(remainingMembers) ? remainingMembers.length : 0;

        if (remainingCount === 0) {
          // Group is now empty, mark as consumed/hide it
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
          console.log(`[removeFromGroups] Marked group ${groupId} as fully consumed (empty)`);
        } else {
          // Recalculate group totals from remaining members
          const remainingData = await supabaseRequest(
            supabaseConfig,
            `unassigned_group_members?group_id=eq.${groupId}&select=activity_record_id`
          );

          const arIds = (Array.isArray(remainingData) ? remainingData : [])
            .map(m => m.activity_record_id)
            .filter(Boolean);

          if (arIds.length > 0) {
            const arIdsParam = sanitizeUUIDArray(arIds).join(',');
            const recalcRecords = await supabaseRequest(
              supabaseConfig,
              `activity_records?id=in.(${arIdsParam})&select=duration_seconds,total_time_seconds`
            );

            const totalSeconds = (Array.isArray(recalcRecords) ? recalcRecords : [])
              .reduce((sum, r) => sum + (r.duration_seconds || r.total_time_seconds || 0), 0);

            await supabaseRequest(
              supabaseConfig,
              `unassigned_work_groups?id=eq.${groupId}`,
              {
                method: 'PATCH',
                body: {
                  session_count: remainingCount,
                  total_seconds: totalSeconds
                }
              }
            );
            console.log(`[removeFromGroups] Updated group ${groupId}: ${remainingCount} sessions, ${formatDuration(totalSeconds)}`);
          }
        }

        updatedGroupIds.push(groupId);
      } catch (err) {
        console.error(`[removeFromGroups] Error updating group ${groupId}:`, err);
        // Continue with next group despite errors
      }
    }

    return {
      removedCount: memberIds.length,
      updatedGroupIds
    };
  } catch (error) {
    console.error(`[removeFromGroups] Error in removeConvertedSessionsFromGroups:`, error);
    throw error;
  }
}

/**
 * Get auto-sync enabled status for account
 */
export async function isAutoSyncEnabled(accountId, cloudId) {
  try {
    const trackingSettings = await getTrackingSettings(accountId, cloudId);
    return trackingSettings.jiraWorklogSyncEnabled === true;
  } catch (e) {
    console.warn('[workAssignmentService] Error checking auto-sync settings:', e.message);
    return false;
  }
}
