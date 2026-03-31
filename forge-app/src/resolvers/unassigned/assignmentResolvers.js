/**
 * Assignment Resolvers for Unassigned Work
 * Handles assigning work sessions to Jira issues
 */

import api, { route } from '@forge/api';
import { getSupabaseConfig, getOrCreateUser, getOrCreateOrganization, supabaseRequest } from '../../utils/supabase.js';
import { getIssueTransitions, transitionIssue } from '../../utils/jira.js';
import { formatDuration, formatJiraDate } from '../../utils/formatters.js';
import { isValidUUID, isValidIssueKey, isValidProjectKey, isValidDate, sanitizeUUIDArray } from '../../utils/validators.js';
import { getTrackingSettings } from '../../services/settingsService.js';
import { initializeRequestContext, handleResolverError, ensureArray } from './helpers.js';

// Module-level constants
const JIRA_MIN_WORKLOG_SECONDS = 60;

/**
 * Helper: Check if auto-sync is enabled for worklogs
 */
async function isAutoSyncEnabled(accountId, cloudId) {
  try {
    const trackingSettings = await getTrackingSettings(accountId, cloudId);
    return trackingSettings.jiraWorklogSyncEnabled === true;
  } catch (e) {
   console.warn('[assignmentResolvers] Error checking auto-sync settings:', e.message);
    return false;
  }
}

/**
 * Helper: Create worklog if conditions are met
 * @param {Object} options - Worklog options
 * @param {string} options.issueKey - Jira issue key
 * @param {number} options.timeToLog - Time in seconds
 * @param {number} options.sessionCount - Number of sessions
 * @param {boolean} options.autoSyncEnabled - Whether auto-sync is enabled
 * @param {string} [options.customComment] - Optional custom comment for worklog
 */
async function createWorklogIfNeeded({ issueKey, timeToLog, sessionCount, autoSyncEnabled, customComment }) {
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
    // Jira rejects worklogs under 60 seconds. Instead of rounding up (which
    // inflates time — e.g. ten 8s entries would become 600s instead of 80s),
    // we defer to the scheduled sync.  The sync aggregates ALL time per
    // user+issue, so these sub-minute entries get combined with other work on
    // the same issue. If the aggregated total is still < 60s the sync rounds
    // up just once (max 59s inflation total, not per entry).
    console.log(`[worklog] Deferring sub-minute worklog (${timeToLog}s < ${JIRA_MIN_WORKLOG_SECONDS}s) to scheduled sync for aggregation`);
    return {
      worklog: null,
      worklogSkipped: true,
      worklogSkippedReason: `Time is under ${JIRA_MIN_WORKLOG_SECONDS}s — deferred to scheduled sync for aggregation`
    };
  }
  
  try {
    // Use custom comment if provided, otherwise use default
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
          started: formatJiraDate()
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
 * Helper: Update sessions and analysis results
 */
async function updateSessionsAndAnalysis({ validSessionIds, issueKey, userId, organizationId, supabaseConfig, groupId }) {
  const sessionIdsParam = validSessionIds.join(',');
  
  // SECURITY: Verify sessions belong to current user and organization before updating
  const updatedActivities = await supabaseRequest(
    supabaseConfig,
    `unassigned_activity?id=in.(${sessionIdsParam})&user_id=eq.${userId}&organization_id=eq.${organizationId}&select=analysis_result_id`,
    {
      method: 'PATCH',
      headers: { 'Prefer': 'return=representation' },
      body: {
        manually_assigned: true,
        assigned_task_key: issueKey,
        assigned_by: userId,
        assigned_at: new Date().toISOString()
      }
    }
  );

  const activitiesArray = ensureArray(updatedActivities);
  const analysisResultIds = activitiesArray.map(a => a?.analysis_result_id).filter(Boolean);

  console.log(`[updateSessions] Found ${analysisResultIds.length} analysis results to update`);

  if (analysisResultIds.length > 0) {
    const analysisIdsParam = sanitizeUUIDArray(analysisResultIds).join(',');
    const updateBody = {
      active_task_key: issueKey,
      manually_assigned: true
    };

    if (isValidUUID(groupId)) {
      updateBody.assignment_group_id = groupId;
    }

    await supabaseRequest(
      supabaseConfig,
      `analysis_results?id=in.(${analysisIdsParam})`,
      { method: 'PATCH', body: updateBody }
    );
  }

  // Also update activity_records for hybrid OCR approach data
  // validSessionIds may contain activity_record IDs (from new pipeline groups)
  // Use id=in.() so only the specific sessions in this group are updated
  const projectKey = issueKey.split('-')[0];
  try {
    await supabaseRequest(
      supabaseConfig,
      `activity_records?id=in.(${sessionIdsParam})&user_id=eq.${userId}&organization_id=eq.${organizationId}`,
      {
        method: 'PATCH',
        body: {
          user_assigned_issue_key: issueKey,
          project_key: projectKey
        }
      }
    );
    console.log(`[updateSessions] Updated activity_records with issue_key ${issueKey}`);
  } catch (error) {
    console.error(`[updateSessions] Error updating activity_records:`, error);
  }
  
  return analysisResultIds.length;
}

/**
 * Helper: Mark group as assigned
 */
async function markGroupAsAssigned({ groupId, issueKey, userId, supabaseConfig }) {
  if (!isValidUUID(groupId)) {
    return false;
  }
  
  await supabaseRequest(
    supabaseConfig,
    `unassigned_work_groups?id=eq.${groupId}`,
    {
      method: 'PATCH',
      body: {
        is_assigned: true,
        assigned_to_issue_key: issueKey,
        assigned_at: new Date().toISOString(),
        assigned_by: userId
      }
    }
  );
  
  return true;
}

/**
 * Helper: Filter activities by screenshot timestamp within a time range
 * @param {Array} analysisResults - Array of analysis results with screenshots
 * @param {string} startDateTime - ISO datetime string for range start
 * @param {string} endDateTime - ISO datetime string for range end
 * @returns {Array} Filtered activities within the time range
 */
function filterActivitiesByTimeRange(analysisResults, startDateTime, endDateTime) {
  const startDate = new Date(startDateTime);
  const endDate = new Date(endDateTime);

  return (analysisResults || []).filter(result => {
    const screenshotTimestamp = result.screenshots?.timestamp;
    if (!screenshotTimestamp) return false;

    const activityTime = new Date(screenshotTimestamp);
    return activityTime >= startDate && activityTime <= endDate;
  });
}

/**
 * Assign a group of sessions to existing Jira issue
 */
export async function assignToExistingIssue(req) {
  try {
    const { sessionIds, issueKey, groupId, totalSeconds } = req.payload;

    // Validate input formats
    const validSessionIds = sanitizeUUIDArray(sessionIds);
    if (validSessionIds.length === 0) {
      return { success: false, error: 'No valid session IDs provided' };
    }

    if (!issueKey || !isValidIssueKey(issueKey)) {
      return { success: false, error: 'Valid issue key required (e.g., PROJ-123)' };
    }

    // Initialize context
    const ctx = await initializeRequestContext(req);
    if (!ctx.success) return ctx;

    const { config: supabaseConfig, organization, userId, accountId, cloudId } = ctx;

    // Validate totalSeconds - Jira requires minimum 60 seconds for worklogs
    const timeToLog = typeof totalSeconds === 'number' && totalSeconds > 0 ? totalSeconds : 0;
    console.log(`[assignToExistingIssue] Updating ${validSessionIds.length} sessions for issue ${issueKey}, totalSeconds: ${timeToLog}`);

    // Update sessions and analysis results using helper
    await updateSessionsAndAnalysis({
      validSessionIds,
      issueKey,
      userId,
      organizationId: organization.id,
      supabaseConfig,
      groupId
    });

    // Mark the group as assigned
    await markGroupAsAssigned({ groupId, issueKey, userId, supabaseConfig });

    // Create worklog using helper
    const autoSyncEnabled = await isAutoSyncEnabled(accountId, cloudId);
    const worklogResult = await createWorklogIfNeeded({
      issueKey,
      timeToLog,
      sessionCount: sessionIds.length,
      autoSyncEnabled
    });

    return {
      success: true,
      assigned_count: sessionIds.length,
      worklog_id: worklogResult.worklog?.id || null,
      worklog_skipped: worklogResult.worklogSkipped,
      worklog_skipped_reason: worklogResult.worklogSkippedReason,
      issue_key: issueKey
    };

  } catch (error) {
    return handleResolverError(error, 'assigning to existing issue');
  }
}

/**
 * Create new Jira issue and assign work group to it
 */
export async function createIssueAndAssign(req) {
  try {
    const { sessionIds, issueSummary, issueDescription, projectKey, issueType, totalSeconds, groupId, assigneeAccountId, statusName } = req.payload;

    // Validate input formats
    const validSessionIds = sanitizeUUIDArray(sessionIds);
    if (validSessionIds.length === 0) {
      return { success: false, error: 'No valid session IDs provided' };
    }

    if (!issueSummary) {
      return { success: false, error: 'Issue summary required' };
    }

    if (!projectKey || !isValidProjectKey(projectKey)) {
      return { success: false, error: 'Valid project key required' };
    }

    // Initialize context
    const ctx = await initializeRequestContext(req);
    if (!ctx.success) return ctx;

    const { config: supabaseConfig, organization, userId, accountId, cloudId } = ctx;

    // Validate totalSeconds - Jira requires minimum 60 seconds for worklogs
    const timeToLog = typeof totalSeconds === 'number' && totalSeconds > 0 ? totalSeconds : 0;

    // Build issue fields
    const issueFields = {
      project: { key: projectKey },
      summary: issueSummary,
      description: {
        type: 'doc',
        version: 1,
        content: [
          {
            type: 'paragraph',
            content: [
              {
                type: 'text',
                text: issueDescription || `Work performed across ${sessionIds.length} sessions.\n\nTotal time: ${formatDuration(totalSeconds)}\n\nCreated from time tracking data.`
              }
            ]
          }
        ]
      },
      issuetype: { name: issueType || 'Task' },
      labels: ['time-tracked', 'auto-created']
    };

    // Add assignee if provided (default to current user)
    if (assigneeAccountId) {
      issueFields.assignee = { accountId: assigneeAccountId };
    } else {
      // Default to current user
      issueFields.assignee = { accountId: accountId };
    }

    // Note: Cannot set status during creation - must transition after creation
    // Create new Jira issue
    const createIssueResponse = await api.asUser().requestJira(
      route`/rest/api/3/issue`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fields: issueFields
        })
      }
    );

    if (!createIssueResponse.ok) {
      const errorText = await createIssueResponse.text();
      throw new Error(`Failed to create issue: ${errorText}`);
    }

    const newIssue = await createIssueResponse.json();
    const newIssueKey = newIssue.key;

    // Transition issue to desired status if provided
    if (statusName) {
      try {
        // Get available transitions for the newly created issue
        const transitions = await getIssueTransitions(newIssueKey);

        // Find transition that leads to the desired status
        const targetTransition = transitions.find(t =>
          t.to?.name?.toLowerCase() === statusName.toLowerCase()
        );

        if (targetTransition) {
          // Execute the transition
          await transitionIssue(newIssueKey, targetTransition.id);
          console.log(`[createIssueAndAssign] Successfully transitioned ${newIssueKey} to ${statusName}`);
        } else {
          console.warn(`[createIssueAndAssign] Could not find transition to status "${statusName}" for ${newIssueKey}. Available transitions:`,
            transitions.map(t => t.to?.name).filter(Boolean));
          // Don't fail the whole operation if transition fails
        }
      } catch (transitionError) {
        console.warn(`[createIssueAndAssign] Failed to transition ${newIssueKey} to ${statusName}:`, transitionError.message);
        // Don't fail the whole operation if transition fails - issue was created successfully
      }
    }

    // Update sessions and analysis results using helper
    console.log(`[createIssueAndAssign] Updating ${validSessionIds.length} sessions for new issue ${newIssueKey}`);

    await updateSessionsAndAnalysis({
      validSessionIds,
      issueKey: newIssueKey,
      userId,
      organizationId: organization.id,
      supabaseConfig,
      groupId
    });

    // Mark the group as assigned
    if (await markGroupAsAssigned({ groupId, issueKey: newIssueKey, userId, supabaseConfig })) {
      console.log(`[createIssueAndAssign] Marked group ${groupId} as assigned to ${newIssueKey}`);
    }

    // Create worklog using helper
    const autoSyncEnabled = await isAutoSyncEnabled(accountId, cloudId);
    const worklogResult = await createWorklogIfNeeded({
      issueKey: newIssueKey,
      timeToLog,
      sessionCount: sessionIds.length,
      autoSyncEnabled
    });

    // Cache the new issue for future AI analysis - include organization_id for multi-tenancy
    await supabaseRequest(
      supabaseConfig,
      'user_jira_issues_cache',
      {
        method: 'POST',
        headers: { 'Prefer': 'return=representation' },
        body: {
          user_id: userId,
          organization_id: organization.id,
          issue_key: newIssueKey,
          summary: issueSummary,
          status: 'To Do',
          project_key: projectKey
        }
      }
    );

    // Log created issue - include organization_id for multi-tenancy
    const logBody = {
      user_id: userId,
      organization_id: organization.id,
      issue_key: newIssueKey,
      issue_summary: issueSummary,
      session_count: sessionIds.length,
      total_time_seconds: totalSeconds
    };

    if (isValidUUID(groupId)) {
      logBody.assignment_group_id = groupId;
    }

    await supabaseRequest(
      supabaseConfig,
      'created_issues_log',
      {
        method: 'POST',
        body: logBody
      }
    );

    return {
      success: true,
      issue_key: newIssueKey,
      issue_id: newIssue.id,
      assigned_count: sessionIds.length,
      worklog_id: worklogResult.worklog?.id,
      worklog_skipped: worklogResult.worklogSkipped,
      worklog_skipped_reason: worklogResult.worklogSkippedReason
    };

  } catch (error) {
    return handleResolverError(error, 'creating issue and assigning work');
  }
}

/**
 * Preview activities within a time interval for bulk reassignment
 * Returns activities that would be affected by the bulk reassignment
 */
export async function previewBulkReassign(req) {
  try {
    const { selectedDate, startTime, endTime } = req.payload;

    if (!selectedDate || !isValidDate(selectedDate)) {
      return { success: false, error: 'Valid date is required (YYYY-MM-DD)' };
    }

    if (!startTime || !endTime) {
      return { success: false, error: 'Start and end time are required' };
    }

    // Validate time format (HH:mm)
    const timeRegex = /^\d{2}:\d{2}$/;
    if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
      return { success: false, error: 'Invalid time format (expected HH:mm)' };
    }

    // Initialize context
    const ctx = await initializeRequestContext(req);
    if (!ctx.success) return ctx;

    const { config: supabaseConfig, organization, userId } = ctx;

    // Build datetime range from selected date and times
    // Append 'Z' to explicitly treat as UTC — screenshot timestamps in DB are stored as UTC
    const startDateTime = `${selectedDate}T${startTime}:00Z`;
    const endDateTime = `${selectedDate}T${endTime}:00Z`;

    console.log(`[previewBulkReassign] Previewing activities from ${startDateTime} to ${endDateTime}`);

    // Query activity_records within the time range (hybrid OCR approach)
    const activityRecords = await supabaseRequest(
      supabaseConfig,
      `activity_records?user_id=eq.${userId}&organization_id=eq.${organization.id}&status=in.(pending,processing,analyzed)&classification=in.(productive,unknown)&start_time=gte.${startDateTime}&end_time=lte.${endDateTime}&select=id,user_assigned_issue_key,window_title,application_name,start_time,duration_seconds,total_time_seconds&order=start_time.asc`
    );

    // Also query legacy analysis_results for backwards compatibility
    // Use screenshots.timestamp for accurate time-based filtering
    const analysisResults = await supabaseRequest(
      supabaseConfig,
      `analysis_results?select=id,active_task_key,confidence_score,work_type,manually_assigned,screenshots(id,timestamp,window_title,application_name,thumbnail_url,duration_seconds)&user_id=eq.${userId}&organization_id=eq.${organization.id}&work_type=eq.office&order=created_at.asc`
    );

    // Filter legacy results by screenshot timestamp within the time range
    const legacyActivitiesInRange = filterActivitiesByTimeRange(analysisResults, startDateTime, endDateTime);

    // Map activity_records to common format
    const activityRecordsFormatted = (activityRecords || []).map(a => ({
      id: a.id,
      timestamp: a.start_time,
      window_title: a.window_title,
      application_name: a.application_name,
      current_issue_key: a.user_assigned_issue_key,
      time_spent_seconds: a.duration_seconds || a.total_time_seconds || 0,
      is_unassigned: a.user_assigned_issue_key === null,
      source: 'activity_records'
    }));

    // Map legacy results to common format
    const legacyActivitiesFormatted = legacyActivitiesInRange.map(a => ({
      id: a.id,
      screenshot_id: a.screenshots?.id,
      timestamp: a.screenshots?.timestamp,
      window_title: a.screenshots?.window_title,
      application_name: a.screenshots?.application_name,
      thumbnail_url: a.screenshots?.thumbnail_url,
      current_issue_key: a.active_task_key,
      time_spent_seconds: a.screenshots?.duration_seconds || 0,
      is_unassigned: a.active_task_key === null,
      source: 'analysis_results'
    }));

    // Combine all activities
    const allActivities = [...activityRecordsFormatted, ...legacyActivitiesFormatted];

    // Separate into currently assigned (wrongly tracked) and unassigned
    const wronglyTracked = allActivities.filter(a => a.current_issue_key !== null);
    const unassigned = allActivities.filter(a => a.current_issue_key === null);

    // Calculate totals
    const totalSeconds = allActivities.reduce((sum, a) => sum + (a.time_spent_seconds || 0), 0);

    // Get unique issue keys that are currently assigned
    const currentlyAssignedIssues = [...new Set(wronglyTracked.map(a => a.current_issue_key).filter(Boolean))];

    return {
      success: true,
      preview: {
        total_activities: allActivities.length,
        wrongly_tracked_count: wronglyTracked.length,
        unassigned_count: unassigned.length,
        total_seconds: totalSeconds,
        total_time_formatted: formatDuration(totalSeconds),
        currently_assigned_issues: currentlyAssignedIssues,
        activities: allActivities,
        time_range: {
          start: startDateTime,
          end: endDateTime,
          date: selectedDate
        }
      }
    };

  } catch (error) {
    return handleResolverError(error, 'previewing bulk reassign');
  }
}

/**
 * Bulk reassign all activities within a time interval to a specific issue
 * Handles both already-tracked (wrongly assigned) and unassigned activities
 */
export async function bulkReassignByTimeInterval(req) {
  try {
    const { selectedDate, startTime, endTime, targetIssueKey, createWorklog = true } = req.payload;

    if (!selectedDate || !isValidDate(selectedDate)) {
      return { success: false, error: 'Valid date is required (YYYY-MM-DD)' };
    }

    // Validate time format (HH:mm)
    const timeRegex = /^\d{2}:\d{2}$/;
    if (!startTime || !endTime || !timeRegex.test(startTime) || !timeRegex.test(endTime)) {
      return { success: false, error: 'Valid start and end time required (HH:mm)' };
    }

    if (!targetIssueKey || !isValidIssueKey(targetIssueKey)) {
      return { success: false, error: 'Valid target issue key required (e.g., PROJ-123)' };
    }

    // Initialize context
    const ctx = await initializeRequestContext(req);
    if (!ctx.success) return ctx;

    const { config: supabaseConfig, organization, userId, accountId, cloudId } = ctx;

    // Build datetime range
    // Append 'Z' to explicitly treat as UTC — screenshot timestamps in DB are stored as UTC
    const startDateTime = `${selectedDate}T${startTime}:00Z`;
    const endDateTime = `${selectedDate}T${endTime}:00Z`;

    console.log(`[bulkReassignByTimeInterval] Reassigning activities from ${startDateTime} to ${endDateTime} to ${targetIssueKey}`);

    // Extract project key from target issue key (e.g., SCRUM-5 -> SCRUM)
    const targetProjectKey = targetIssueKey.split('-')[0];

    // Query activity_records in the time range (hybrid OCR approach)
    const activityRecords = await supabaseRequest(
      supabaseConfig,
      `activity_records?user_id=eq.${userId}&organization_id=eq.${organization.id}&status=in.(pending,processing,analyzed)&classification=in.(productive,unknown)&start_time=gte.${startDateTime}&end_time=lte.${endDateTime}&select=id,user_assigned_issue_key,duration_seconds,total_time_seconds`
    );

    // Also query legacy analysis_results in the time range
    const analysisResults = await supabaseRequest(
      supabaseConfig,
      `analysis_results?select=id,active_task_key,screenshot_id,screenshots(id,timestamp,duration_seconds)&user_id=eq.${userId}&organization_id=eq.${organization.id}&work_type=eq.office`
    );

    // Filter legacy by screenshot timestamp
    const legacyActivitiesInRange = filterActivitiesByTimeRange(analysisResults, startDateTime, endDateTime);

    // Calculate totals from both sources
    const activityRecordsArray = activityRecords || [];
    const activityRecordsSeconds = activityRecordsArray.reduce((sum, a) => sum + (a.duration_seconds || a.total_time_seconds || 0), 0);
    const legacySeconds = legacyActivitiesInRange.reduce((sum, a) => sum + (a.screenshots?.duration_seconds || 0), 0);
    const totalSeconds = activityRecordsSeconds + legacySeconds;

    const totalActivities = activityRecordsArray.length + legacyActivitiesInRange.length;

    if (totalActivities === 0) {
      return { success: false, error: 'No activities found in the specified time range' };
    }

    const previouslyAssignedCount = 
      activityRecordsArray.filter(a => a.user_assigned_issue_key !== null).length +
      legacyActivitiesInRange.filter(a => a.active_task_key !== null).length;
    const previouslyUnassignedCount = totalActivities - previouslyAssignedCount;

    console.log(`[bulkReassignByTimeInterval] Found ${totalActivities} activities (${activityRecordsArray.length} activity_records + ${legacyActivitiesInRange.length} legacy)`);

    // Update activity_records to point to the target issue
    if (activityRecordsArray.length > 0) {
      const activityIds = sanitizeUUIDArray(activityRecordsArray.map(a => a.id)).join(',');
      await supabaseRequest(
        supabaseConfig,
        `activity_records?id=in.(${activityIds})`,
        {
          method: 'PATCH',
          body: {
            user_assigned_issue_key: targetIssueKey,
            project_key: targetProjectKey
          }
        }
      );
      console.log(`[bulkReassignByTimeInterval] Updated ${activityRecordsArray.length} activity_records`);
    }

    // Update legacy analysis_results to point to the target issue
    if (legacyActivitiesInRange.length > 0) {
      const analysisResultIds = sanitizeUUIDArray(legacyActivitiesInRange.map(a => a.id));
      const analysisIdsParam = analysisResultIds.join(',');
      await supabaseRequest(
        supabaseConfig,
        `analysis_results?id=in.(${analysisIdsParam})`,
        {
          method: 'PATCH',
          body: {
            active_task_key: targetIssueKey,
            manually_assigned: true,
            assignment_group_id: null // Clear any previous group assignment
          }
        }
      );

      // Also update unassigned_activity table for any activities that exist there
      const unassignedActivities = await supabaseRequest(
        supabaseConfig,
        `unassigned_activity?analysis_result_id=in.(${analysisIdsParam})&select=id`
      );

      const unassignedArray = ensureArray(unassignedActivities);

      if (unassignedArray.length > 0) {
        const unassignedIds = sanitizeUUIDArray(unassignedArray.map(u => u.id)).join(',');
        await supabaseRequest(
          supabaseConfig,
          `unassigned_activity?id=in.(${unassignedIds})`,
          {
            method: 'PATCH',
            body: {
              manually_assigned: true,
              assigned_task_key: targetIssueKey,
              assigned_by: userId,
              assigned_at: new Date().toISOString()
            }
          }
        );
        console.log(`[bulkReassignByTimeInterval] Updated ${unassignedArray.length} unassigned_activity records`);
      }

      // Mark any unassigned_work_groups that contained these legacy activities as assigned
      const legacyUnassignedIds = sanitizeUUIDArray(unassignedArray.map(u => u.id));
      const groupMembers = legacyUnassignedIds.length > 0
        ? await supabaseRequest(
            supabaseConfig,
            `unassigned_group_members?unassigned_activity_id=in.(${legacyUnassignedIds.join(',')})&select=group_id`
          )
        : [];

      const groupMembersArray = ensureArray(groupMembers);
      const uniqueGroupIds = sanitizeUUIDArray([...new Set(groupMembersArray.map(m => m.group_id).filter(Boolean))]);

      if (uniqueGroupIds.length > 0) {
        const groupIdsParam = uniqueGroupIds.join(',');
        await supabaseRequest(
          supabaseConfig,
          `unassigned_work_groups?id=in.(${groupIdsParam})`,
          {
            method: 'PATCH',
            body: {
              is_assigned: true,
              assigned_to_issue_key: targetIssueKey,
              assigned_at: new Date().toISOString(),
              assigned_by: userId
            }
          }
        );
        console.log(`[bulkReassignByTimeInterval] Marked ${uniqueGroupIds.length} groups as assigned`);
      }
    }

    // Create worklog using helper (respects auto-sync and minimum time threshold)
    const autoSyncEnabled = await isAutoSyncEnabled(accountId, cloudId);
    
    let worklogResult = { worklog: null, worklogSkipped: false, worklogSkippedReason: null };
    if (createWorklog) {
      const customComment = `Bulk time correction: ${totalActivities} activities (${formatDuration(totalSeconds)}) from ${startTime} to ${endTime} on ${selectedDate} reassigned to this issue.`;
      worklogResult = await createWorklogIfNeeded({
        issueKey: targetIssueKey,
        timeToLog: totalSeconds,
        sessionCount: totalActivities,
        autoSyncEnabled,
        customComment
      });
    }

    return {
      success: true,
      result: {
        total_reassigned: totalActivities,
        previously_tracked: previouslyAssignedCount,
        previously_unassigned: previouslyUnassignedCount,
        total_seconds: totalSeconds,
        total_time_formatted: formatDuration(totalSeconds),
        target_issue_key: targetIssueKey,
        worklog_id: worklogResult.worklog?.id || null,
        worklog_skipped: worklogResult.worklogSkipped,
        worklog_skipped_reason: worklogResult.worklogSkippedReason,
        time_range: {
          start: startDateTime,
          end: endDateTime
        }
      }
    };

  } catch (error) {
    return handleResolverError(error, 'bulk reassigning');
  }
}

/**
 * Dismiss (soft-delete) an entire unassigned work group.
 * Marks the group as dismissed and flags all its sessions so they are never re-clustered.
 * The underlying data is NOT deleted from Supabase.
 */
export async function dismissUnassignedGroup(req) {
  try {
    const { groupId } = req.payload;

    if (!groupId || !isValidUUID(groupId)) {
      return { success: false, error: 'Valid group ID required' };
    }

    const ctx = await initializeRequestContext(req);
    if (!ctx.success) return ctx;

    const { config: supabaseConfig, organization, userId } = ctx;
    const now = new Date().toISOString();

    // Step 1: Fetch all group members to get source record IDs for both pipelines
    const members = await supabaseRequest(
      supabaseConfig,
      `unassigned_group_members?group_id=eq.${groupId}&select=id,activity_record_id,unassigned_activity_id`
    );
    const membersArray = ensureArray(members);

    const activityRecordIds = sanitizeUUIDArray(
      membersArray.map(m => m.activity_record_id).filter(Boolean)
    );
    const unassignedActivityIds = sanitizeUUIDArray(
      membersArray.map(m => m.unassigned_activity_id).filter(Boolean)
    );

    // Step 2: Mark new-pipeline activity_records as clustering_dismissed
    if (activityRecordIds.length > 0) {
      await supabaseRequest(
        supabaseConfig,
        `activity_records?id=in.(${activityRecordIds.join(',')})&user_id=eq.${userId}&organization_id=eq.${organization.id}`,
        {
          method: 'PATCH',
          body: { clustering_dismissed: true, clustering_dismissed_at: now }
        }
      );
    }

    // Step 3: Mark legacy unassigned_activity records as clustering_dismissed
    if (unassignedActivityIds.length > 0) {
      await supabaseRequest(
        supabaseConfig,
        `unassigned_activity?id=in.(${unassignedActivityIds.join(',')})&user_id=eq.${userId}&organization_id=eq.${organization.id}`,
        {
          method: 'PATCH',
          body: { clustering_dismissed: true, clustering_dismissed_at: now }
        }
      );
    }

    // Step 4: Mark the group itself as dismissed
    await supabaseRequest(
      supabaseConfig,
      `unassigned_work_groups?id=eq.${groupId}&user_id=eq.${userId}&organization_id=eq.${organization.id}`,
      {
        method: 'PATCH',
        body: { is_dismissed: true, dismissed_at: now, dismissed_by: userId }
      }
    );

    console.log(`[dismissUnassignedGroup] Group ${groupId} dismissed (${membersArray.length} sessions marked clustering_dismissed)`);

    return {
      success: true,
      dismissed_sessions: membersArray.length
    };

  } catch (error) {
    return handleResolverError(error, 'dismissing unassigned group');
  }
}

/**
 * Remove a single session from an unassigned work group.
 * Marks the session as excluded from future clustering and removes it from the group.
 * The underlying activity record is NOT deleted from Supabase.
 */
export async function dismissGroupMember(req) {
  try {
    const { groupId, sessionId } = req.payload;

    if (!groupId || !isValidUUID(groupId)) {
      return { success: false, error: 'Valid group ID required' };
    }
    if (!sessionId || !isValidUUID(sessionId)) {
      return { success: false, error: 'Valid session ID required' };
    }

    const ctx = await initializeRequestContext(req);
    if (!ctx.success) return ctx;

    const { config: supabaseConfig, organization, userId } = ctx;
    const now = new Date().toISOString();

    // Step 1: Find the member row — sessionId may be activity_record_id or unassigned_activity_id
    let memberRow = null;
    let source = null;

    const arMembers = ensureArray(await supabaseRequest(
      supabaseConfig,
      `unassigned_group_members?group_id=eq.${groupId}&activity_record_id=eq.${sessionId}&select=id,activity_record_id,unassigned_activity_id`
    ));
    if (arMembers.length > 0) {
      memberRow = arMembers[0];
      source = 'activity_records';
    } else {
      const legacyMembers = ensureArray(await supabaseRequest(
        supabaseConfig,
        `unassigned_group_members?group_id=eq.${groupId}&unassigned_activity_id=eq.${sessionId}&select=id,activity_record_id,unassigned_activity_id`
      ));
      if (legacyMembers.length > 0) {
        memberRow = legacyMembers[0];
        source = 'unassigned_activity';
      }
    }

    if (!memberRow) {
      return { success: false, error: 'Session not found in this group' };
    }

    // Step 2: Mark the source record as clustering_dismissed
    if (source === 'activity_records') {
      await supabaseRequest(
        supabaseConfig,
        `activity_records?id=eq.${sessionId}&user_id=eq.${userId}&organization_id=eq.${organization.id}`,
        {
          method: 'PATCH',
          body: { clustering_dismissed: true, clustering_dismissed_at: now }
        }
      );
    } else {
      await supabaseRequest(
        supabaseConfig,
        `unassigned_activity?id=eq.${sessionId}&user_id=eq.${userId}&organization_id=eq.${organization.id}`,
        {
          method: 'PATCH',
          body: { clustering_dismissed: true, clustering_dismissed_at: now }
        }
      );
    }

    // Step 3: Remove from unassigned_group_members (session no longer belongs to this group)
    await supabaseRequest(
      supabaseConfig,
      `unassigned_group_members?id=eq.${memberRow.id}`,
      { method: 'DELETE' }
    );

    // Step 4: Decrement session_count on the group so the UI stays accurate
    const groupRows = ensureArray(await supabaseRequest(
      supabaseConfig,
      `unassigned_work_groups?id=eq.${groupId}&user_id=eq.${userId}&organization_id=eq.${organization.id}&select=id,session_count`
    ));
    if (groupRows.length > 0) {
      const newCount = Math.max(0, (groupRows[0].session_count || 1) - 1);
      await supabaseRequest(
        supabaseConfig,
        `unassigned_work_groups?id=eq.${groupId}&user_id=eq.${userId}&organization_id=eq.${organization.id}`,
        { method: 'PATCH', body: { session_count: newCount } }
      );
    }

    console.log(`[dismissGroupMember] Session ${sessionId} (${source}) removed from group ${groupId} and marked clustering_dismissed`);

    return {
      success: true,
      session_id: sessionId,
      source
    };

  } catch (error) {
    return handleResolverError(error, 'dismissing group member');
  }
}

/**
 * Register assignment resolvers
 */
export function registerAssignmentResolvers(resolver) {
  resolver.define('assignToExistingIssue', assignToExistingIssue);
  resolver.define('createIssueAndAssign', createIssueAndAssign);
  resolver.define('previewBulkReassign', previewBulkReassign);
  resolver.define('bulkReassignByTimeInterval', bulkReassignByTimeInterval);
  resolver.define('dismissUnassignedGroup', dismissUnassignedGroup);
  resolver.define('dismissGroupMember', dismissGroupMember);
}
