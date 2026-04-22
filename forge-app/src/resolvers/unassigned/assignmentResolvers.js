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
// REMOVABLE: AI accuracy tracking layer.
import { recordAccuracyEvents, isAccuracyTrackingEnabled } from '../../services/accuracy/accuracyTracking.js';

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

  // REMOVABLE: pre-fetch activity_records context for AI accuracy events.
  // Fetched BEFORE the PATCH so we can capture the AI's prior suggestion
  // (user_assigned_issue_key) before it's overwritten.  Skipped entirely when
  // tracking is disabled so production cost is zero.
  let priorActivityRows = [];
  if (isAccuracyTrackingEnabled()) {
    try {
      priorActivityRows = ensureArray(await supabaseRequest(
        supabaseConfig,
        `activity_records?id=in.(${sessionIdsParam})&user_id=eq.${userId}` +
        `&select=id,user_assigned_issue_key,duration_seconds,total_time_seconds,window_title,application_name,classification,metadata`
      ));
    } catch (err) {
      // Pre-fetch failure must not block the assignment.  Just skip events.
      console.warn('[updateSessions] accuracy pre-fetch failed (non-fatal):', err.message);
      priorActivityRows = [];
    }
  }

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
    const projectKey = issueKey.split('-')[0]; // Extract project key from issue key
    const updateBody = {
      active_task_key: issueKey,
      active_project_key: projectKey,  // FIX: Set project key to prevent orphaned records
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
  // NOTE: No organization_id filter to handle org mismatch cases (like worklog sync)
  const projectKey = issueKey.split('-')[0];
  try {
    await supabaseRequest(
      supabaseConfig,
      `activity_records?id=in.(${sessionIdsParam})&user_id=eq.${userId}`,
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

  // REMOVABLE: emit one accuracy event per activity record that the user just
  // assigned to an issue.  ai_suggested_issue_key may be NULL (AI never
  // classified this work) or non-null (AI suggested but user picked something
  // different in the unassigned-work flow). The dashboard distinguishes these
  // two cases when computing "AI never classified" vs "AI classified wrong".
  if (priorActivityRows.length > 0) {
    const events = priorActivityRows.map(r => ({
      organizationId,
      userId,
      eventType: 'manually_assigned',
      activityRecordId: r.id,
      aiSuggestedIssueKey: r.user_assigned_issue_key || null,
      aiConfidenceScore: r.metadata?.confidenceScore ?? null,
      finalIssueKey: issueKey,
      durationSeconds: r.duration_seconds || r.total_time_seconds || 0,
      windowTitle: r.window_title,
      applicationName: r.application_name,
      classification: r.classification,
      metadata: groupId ? { group_id: groupId } : null
    }));
    await recordAccuracyEvents(supabaseConfig, events);
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
 * Helper: Compute overlap-based pro-rated time attribution for a record vs window.
 *
 * Activity records are aggregated (one row per window+app session, with `total_time_seconds`
 * representing summed focus time across visits, NOT wall-clock span). When the record only
 * partially overlaps the user's selected window, we attribute time proportionally:
 *
 *   attributed = total_time_seconds * (overlap_ms / span_ms)
 *
 * For NULL `end_time` (in-progress sessions), we proxy the end as `start_time + total_time_seconds`.
 *
 * @returns {{attributed: number, partial: boolean, overlapsWindow: boolean}|null}
 */
function computeAttribution(record, windowStartMs, windowEndMs) {
  const startMs = record.start_time ? new Date(record.start_time).getTime() : null;
  if (startMs === null) return null;

  const recordSeconds = record.total_time_seconds || record.duration_seconds || 0;
  const endMs = record.end_time
    ? new Date(record.end_time).getTime()
    : startMs + recordSeconds * 1000;

  if (startMs >= windowEndMs) return { attributed: 0, partial: false, overlapsWindow: false };
  if (endMs <= windowStartMs) return { attributed: 0, partial: false, overlapsWindow: false };

  const overlapStart = Math.max(startMs, windowStartMs);
  const overlapEnd = Math.min(endMs, windowEndMs);
  const overlapMs = Math.max(0, overlapEnd - overlapStart);
  const spanMs = Math.max(1, endMs - startMs);
  const ratio = Math.min(1, overlapMs / spanMs);

  return {
    attributed: Math.round(recordSeconds * ratio),
    partial: overlapMs < spanMs,
    overlapsWindow: true
  };
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
 * Multi-group variant: assign a user-picked mix of sessions (possibly spanning
 * multiple groups) to one existing Jira issue.
 *
 * Differences vs assignToExistingIssue:
 *   - Accepts an array of groupIds (not a single one).
 *   - For each group: only marks it fully assigned if every one of its members
 *     is in sessionIds. Otherwise leaves the group in place so its remaining
 *     intervals stay visible as unassigned.
 *   - Emits one worklog for the combined totalSeconds.
 */
export async function assignSelectionToExistingIssue(req) {
  try {
    const { sessionIds, groupIds, issueKey, totalSeconds } = req.payload;

    const validSessionIds = sanitizeUUIDArray(sessionIds);
    if (validSessionIds.length === 0) {
      return { success: false, error: 'No valid session IDs provided' };
    }

    const validGroupIds = sanitizeUUIDArray(groupIds);
    if (validGroupIds.length === 0) {
      return { success: false, error: 'No valid group IDs provided' };
    }

    if (!issueKey || !isValidIssueKey(issueKey)) {
      return { success: false, error: 'Valid issue key required (e.g., PROJ-123)' };
    }

    const ctx = await initializeRequestContext(req);
    if (!ctx.success) return ctx;

    const { config: supabaseConfig, organization, userId, accountId, cloudId } = ctx;

    const timeToLog = typeof totalSeconds === 'number' && totalSeconds > 0 ? totalSeconds : 0;
    console.log(`[assignSelectionToExistingIssue] ${validSessionIds.length} sessions across ${validGroupIds.length} groups -> ${issueKey}, totalSeconds: ${timeToLog}`);

    // One batch PATCH for every selected session — covers unassigned_activity,
    // analysis_results, and activity_records regardless of which group they belong to.
    // groupId is omitted because selection spans multiple groups (the helper only
    // uses it to stamp analysis_results.assignment_group_id, which is ambiguous here).
    await updateSessionsAndAnalysis({
      validSessionIds,
      issueKey,
      userId,
      organizationId: organization.id,
      supabaseConfig,
      groupId: null
    });

    // Decide per-group whether to mark it assigned or leave it as a partial remainder.
    // A group is "fully covered" only if every one of its members is in the user's
    // session selection. Members can live in either pipeline table, so we collect
    // both id columns.
    const sessionIdsSet = new Set(validSessionIds);
    const fullyAssignedGroups = [];
    const partialGroups = [];

    for (const groupId of validGroupIds) {
      const members = ensureArray(await supabaseRequest(
        supabaseConfig,
        `unassigned_group_members?group_id=eq.${groupId}&select=activity_record_id,unassigned_activity_id`
      ));

      const memberSessionIds = members
        .flatMap(m => [m.activity_record_id, m.unassigned_activity_id])
        .filter(Boolean);

      if (memberSessionIds.length === 0) {
        // No members — treat as nothing to mark, skip.
        continue;
      }

      const fullyCovered = memberSessionIds.every(id => sessionIdsSet.has(id));

      if (fullyCovered) {
        await markGroupAsAssigned({ groupId, issueKey, userId, supabaseConfig });
        fullyAssignedGroups.push(groupId);
      } else {
        partialGroups.push(groupId);
      }
    }

    // One worklog for the whole selection — avoids N sub-minute calls that would
    // all get deferred individually.
    const autoSyncEnabled = await isAutoSyncEnabled(accountId, cloudId);
    const worklogResult = await createWorklogIfNeeded({
      issueKey,
      timeToLog,
      sessionCount: validSessionIds.length,
      autoSyncEnabled
    });

    return {
      success: true,
      assigned_count: validSessionIds.length,
      fully_assigned_groups: fullyAssignedGroups,
      partial_groups: partialGroups,
      worklog_id: worklogResult.worklog?.id || null,
      worklog_skipped: worklogResult.worklogSkipped,
      worklog_skipped_reason: worklogResult.worklogSkippedReason,
      issue_key: issueKey
    };

  } catch (error) {
    return handleResolverError(error, 'assigning selection to existing issue');
  }
}

/**
 * Multi-group variant: create a new Jira issue for a user-picked mix of sessions
 * (possibly spanning multiple groups).
 *
 * Differences vs createIssueAndAssign:
 *   - Accepts an array of groupIds (not a single one).
 *   - For each group: only marks it fully assigned if every one of its members
 *     is in sessionIds. Partial groups stay in the unassigned list.
 *   - Emits one worklog for the combined totalSeconds.
 */
export async function createIssueAndAssignSelection(req) {
  try {
    const {
      sessionIds,
      groupIds,
      issueSummary,
      issueDescription,
      projectKey,
      issueType,
      totalSeconds,
      assigneeAccountId,
      assignToSelf,
      statusName
    } = req.payload;

    const validSessionIds = sanitizeUUIDArray(sessionIds);
    if (validSessionIds.length === 0) {
      return { success: false, error: 'No valid session IDs provided' };
    }

    const validGroupIds = sanitizeUUIDArray(groupIds);
    if (validGroupIds.length === 0) {
      return { success: false, error: 'No valid group IDs provided' };
    }

    if (!issueSummary) {
      return { success: false, error: 'Issue summary required' };
    }

    if (!projectKey || !isValidProjectKey(projectKey)) {
      return { success: false, error: 'Valid project key required' };
    }

    const ctx = await initializeRequestContext(req);
    if (!ctx.success) return ctx;

    const { config: supabaseConfig, organization, userId, accountId, cloudId } = ctx;

    const timeToLog = typeof totalSeconds === 'number' && totalSeconds > 0 ? totalSeconds : 0;

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
                text: issueDescription || `Work performed across ${validSessionIds.length} session(s) from ${validGroupIds.length} group(s).\n\nTotal time: ${formatDuration(totalSeconds)}\n\nCreated from time tracking data.`
              }
            ]
          }
        ]
      },
      issuetype: { name: issueType || 'Task' },
      labels: ['time-tracked', 'auto-created']
    };

    // Assignee resolution:
    //   - explicit assigneeAccountId wins
    //   - otherwise assignToSelf=true (or undefined, for back-compat) -> current user
    //   - assignToSelf=false -> omit assignee so Jira uses the project default
    if (assigneeAccountId) {
      issueFields.assignee = { accountId: assigneeAccountId };
    } else if (assignToSelf !== false) {
      issueFields.assignee = { accountId };
    }

    const createResp = await api.asUser().requestJira(
      route`/rest/api/3/issue`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fields: issueFields })
      }
    );

    if (!createResp.ok) {
      const errorText = await createResp.text();
      throw new Error(`Failed to create issue: ${errorText}`);
    }

    const newIssue = await createResp.json();
    const newIssueKey = newIssue.key;

    // Transition to desired status if provided — same best-effort pattern as
    // createIssueAndAssign: failure here doesn't abort the whole operation.
    if (statusName) {
      try {
        const transitions = await getIssueTransitions(newIssueKey);
        const target = transitions.find(t =>
          t.to?.name?.toLowerCase() === statusName.toLowerCase()
        );
        if (target) {
          await transitionIssue(newIssueKey, target.id);
          console.log(`[createIssueAndAssignSelection] Transitioned ${newIssueKey} to ${statusName}`);
        } else {
          console.warn(`[createIssueAndAssignSelection] No transition to "${statusName}" for ${newIssueKey}`);
        }
      } catch (transitionError) {
        console.warn(`[createIssueAndAssignSelection] Status transition failed:`, transitionError.message);
      }
    }

    // Batch PATCH — groupId=null because the selection spans multiple groups
    // (the helper only uses it to stamp analysis_results.assignment_group_id).
    await updateSessionsAndAnalysis({
      validSessionIds,
      issueKey: newIssueKey,
      userId,
      organizationId: organization.id,
      supabaseConfig,
      groupId: null
    });

    // Per-group partial-vs-full detection (same as assignSelectionToExistingIssue).
    const sessionIdsSet = new Set(validSessionIds);
    const fullyAssignedGroups = [];
    const partialGroups = [];

    for (const groupId of validGroupIds) {
      const members = ensureArray(await supabaseRequest(
        supabaseConfig,
        `unassigned_group_members?group_id=eq.${groupId}&select=activity_record_id,unassigned_activity_id`
      ));

      const memberSessionIds = members
        .flatMap(m => [m.activity_record_id, m.unassigned_activity_id])
        .filter(Boolean);

      if (memberSessionIds.length === 0) continue;

      if (memberSessionIds.every(id => sessionIdsSet.has(id))) {
        await markGroupAsAssigned({ groupId, issueKey: newIssueKey, userId, supabaseConfig });
        fullyAssignedGroups.push(groupId);
      } else {
        partialGroups.push(groupId);
      }
    }

    // One worklog for the combined total — avoids N sub-minute calls that would
    // each get deferred to scheduled sync individually.
    const autoSyncEnabled = await isAutoSyncEnabled(accountId, cloudId);
    const worklogResult = await createWorklogIfNeeded({
      issueKey: newIssueKey,
      timeToLog,
      sessionCount: validSessionIds.length,
      autoSyncEnabled
    });

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

    // created_issues_log entry — no assignment_group_id since the selection spans
    // multiple groups (that column is a single FK).
    await supabaseRequest(
      supabaseConfig,
      'created_issues_log',
      {
        method: 'POST',
        body: {
          user_id: userId,
          organization_id: organization.id,
          issue_key: newIssueKey,
          issue_summary: issueSummary,
          session_count: validSessionIds.length,
          total_time_seconds: totalSeconds
        }
      }
    );

    return {
      success: true,
      issue_key: newIssueKey,
      issue_id: newIssue.id,
      assigned_count: validSessionIds.length,
      fully_assigned_groups: fullyAssignedGroups,
      partial_groups: partialGroups,
      worklog_id: worklogResult.worklog?.id || null,
      worklog_skipped: worklogResult.worklogSkipped,
      worklog_skipped_reason: worklogResult.worklogSkippedReason
    };

  } catch (error) {
    return handleResolverError(error, 'creating issue and assigning selection');
  }
}

/**
 * Create new Jira issue and assign work group to it
 */
export async function createIssueAndAssign(req) {
  try {
    const { sessionIds, issueSummary, issueDescription, projectKey, issueType, totalSeconds, groupId, assigneeAccountId, assignToSelf, statusName } = req.payload;

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

    // Assignee resolution:
    //   - explicit assigneeAccountId wins
    //   - otherwise assignToSelf=true (or undefined, for back-compat) -> current user
    //   - assignToSelf=false -> omit assignee so Jira uses the project default
    if (assigneeAccountId) {
      issueFields.assignee = { accountId: assigneeAccountId };
    } else if (assignToSelf !== false) {
      issueFields.assignee = { accountId };
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
 * Preview activities within a time interval for bulk reassignment.
 *
 * Single source of truth: activity_records (the legacy screenshots/analysis_results
 * pipeline is no longer queried — desktop app stopped writing screenshots in production).
 *
 * Time math uses overlap semantics with pro-rating: a record that partially overlaps
 * the window contributes a proportional share of its total_time_seconds. See
 * computeAttribution() for the formula.
 */
export async function previewBulkReassign(req) {
  try {
    const { selectedDate, startTime, endTime, windowStartUtc, windowEndUtc } = req.payload;

    if (!selectedDate || !isValidDate(selectedDate)) {
      return { success: false, error: 'Valid date is required (YYYY-MM-DD)' };
    }

    if (!startTime || !endTime) {
      return { success: false, error: 'Start and end time are required' };
    }

    const timeRegex = /^\d{2}:\d{2}$/;
    if (!timeRegex.test(startTime) || !timeRegex.test(endTime)) {
      return { success: false, error: 'Invalid time format (expected HH:mm)' };
    }

    if (startTime >= endTime) {
      return { success: false, error: 'End time must be after start time on the same day' };
    }

    // The browser converts the user's local date+time into UTC ISO before invoking,
    // because the resolver runs in UTC and has no way to know the user's wall-clock zone.
    // Reject the call if these are missing — silently falling back to local-as-UTC
    // re-introduces the very bug this param exists to fix.
    if (!windowStartUtc || !windowEndUtc) {
      return { success: false, error: 'windowStartUtc and windowEndUtc are required' };
    }

    const windowStartMs = new Date(windowStartUtc).getTime();
    const windowEndMs = new Date(windowEndUtc).getTime();
    if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs) || windowStartMs >= windowEndMs) {
      return { success: false, error: 'Invalid UTC window timestamps' };
    }

    const ctx = await initializeRequestContext(req);
    if (!ctx.success) return ctx;

    const { config: supabaseConfig, organization, userId } = ctx;

    console.log(`[previewBulkReassign] Window ${windowStartUtc} to ${windowEndUtc} (user picked ${startTime}-${endTime} on ${selectedDate} local)`);

    // Query by start_time range, not work_date. When the user's local window
    // straddles a UTC date boundary (common for timezones far from UTC), the
    // relevant records live on the adjacent UTC date and a work_date=selectedDate
    // filter silently drops them. A 1-day lower buffer covers records that
    // started before windowStart but still overlap it. The client-side
    // computeAttribution does the precise overlap check.
    const dayMs = 24 * 60 * 60 * 1000;
    const queryLowerUtc = encodeURIComponent(new Date(windowStartMs - dayMs).toISOString());
    const queryUpperUtc = encodeURIComponent(new Date(windowEndMs).toISOString());

    const records = ensureArray(await supabaseRequest(
      supabaseConfig,
      `activity_records?user_id=eq.${userId}&organization_id=eq.${organization.id}` +
      `&start_time=gte.${queryLowerUtc}` +
      `&start_time=lt.${queryUpperUtc}` +
      `&status=in.(pending,processing,analyzed)` +
      `&classification=in.(productive,unknown)` +
      `&clustering_dismissed=eq.false` +
      `&select=id,user_assigned_issue_key,window_title,application_name,start_time,end_time,total_time_seconds,duration_seconds` +
      `&order=start_time.asc&limit=1000`
    ));

    const overlapping = [];
    let totalAttributed = 0;
    let partialCount = 0;

    for (const r of records) {
      const attribution = computeAttribution(r, windowStartMs, windowEndMs);
      if (!attribution || !attribution.overlapsWindow) continue;

      if (attribution.partial) partialCount++;
      totalAttributed += attribution.attributed;

      overlapping.push({
        id: r.id,
        timestamp: r.start_time,
        end_time: r.end_time,
        window_title: r.window_title,
        application_name: r.application_name,
        current_issue_key: r.user_assigned_issue_key,
        record_seconds: r.total_time_seconds || r.duration_seconds || 0,
        attributed_seconds: attribution.attributed,
        partial: attribution.partial,
        is_unassigned: r.user_assigned_issue_key === null
      });
    }

    const wronglyTracked = overlapping.filter(a => a.current_issue_key !== null);
    const unassigned = overlapping.filter(a => a.current_issue_key === null);
    const currentlyAssignedIssues = [...new Set(wronglyTracked.map(a => a.current_issue_key))];

    return {
      success: true,
      preview: {
        total_activities: overlapping.length,
        wrongly_tracked_count: wronglyTracked.length,
        unassigned_count: unassigned.length,
        partial_count: partialCount,
        total_seconds: totalAttributed,
        total_time_formatted: formatDuration(totalAttributed),
        currently_assigned_issues: currentlyAssignedIssues,
        activities: overlapping,
        time_range: {
          start: windowStartUtc,
          end: windowEndUtc,
          date: selectedDate
        }
      }
    };

  } catch (error) {
    return handleResolverError(error, 'previewing bulk reassign');
  }
}

/**
 * Bulk reassign all activity_records within a time interval to a specific issue.
 *
 * Single source of truth: activity_records (legacy paths removed). Uses the same
 * overlap+pro-rate semantics as previewBulkReassign so the worklog total matches
 * what the user saw in the preview.
 *
 * Validates target issue access before any DB write so users can't reassign work
 * to issues they cannot view.
 */
export async function bulkReassignByTimeInterval(req) {
  try {
    const { selectedDate, startTime, endTime, windowStartUtc, windowEndUtc, targetIssueKey, createWorklog = true } = req.payload;

    if (!selectedDate || !isValidDate(selectedDate)) {
      return { success: false, error: 'Valid date is required (YYYY-MM-DD)' };
    }

    const timeRegex = /^\d{2}:\d{2}$/;
    if (!startTime || !endTime || !timeRegex.test(startTime) || !timeRegex.test(endTime)) {
      return { success: false, error: 'Valid start and end time required (HH:mm)' };
    }

    if (startTime >= endTime) {
      return { success: false, error: 'End time must be after start time on the same day' };
    }

    // See previewBulkReassign for why these are required (browser-computed UTC window).
    if (!windowStartUtc || !windowEndUtc) {
      return { success: false, error: 'windowStartUtc and windowEndUtc are required' };
    }

    if (!targetIssueKey || !isValidIssueKey(targetIssueKey)) {
      return { success: false, error: 'Valid target issue key required (e.g., PROJ-123)' };
    }

    const ctx = await initializeRequestContext(req);
    if (!ctx.success) return ctx;

    const { config: supabaseConfig, organization, userId, accountId, cloudId } = ctx;

    // Verify the user can actually access the target issue. Catches typos, deleted
    // issues, and permission gaps before we touch the database.
    try {
      const issueResp = await api.asUser().requestJira(
        route`/rest/api/3/issue/${targetIssueKey}?fields=summary,status`
      );
      if (!issueResp.ok) {
        if (issueResp.status === 404 || issueResp.status === 403) {
          return { success: false, error: `Cannot access target issue ${targetIssueKey}` };
        }
        return { success: false, error: `Target issue check failed (HTTP ${issueResp.status})` };
      }
    } catch (e) {
      return { success: false, error: `Failed to verify target issue: ${e.message}` };
    }

    const windowStartMs = new Date(windowStartUtc).getTime();
    const windowEndMs = new Date(windowEndUtc).getTime();
    if (!Number.isFinite(windowStartMs) || !Number.isFinite(windowEndMs) || windowStartMs >= windowEndMs) {
      return { success: false, error: 'Invalid UTC window timestamps' };
    }

    console.log(`[bulkReassignByTimeInterval] Window ${windowStartUtc} to ${windowEndUtc} -> ${targetIssueKey} (user picked ${startTime}-${endTime} on ${selectedDate} local)`);

    const targetProjectKey = targetIssueKey.split('-')[0];

    // See previewBulkReassign for why start_time range replaces work_date=eq.
    // Must use the identical filter here — preview and execute need to see the
    // same record set, otherwise the logged worklog total wouldn't match the
    // preview the user confirmed.
    const dayMs = 24 * 60 * 60 * 1000;
    const queryLowerUtc = encodeURIComponent(new Date(windowStartMs - dayMs).toISOString());
    const queryUpperUtc = encodeURIComponent(new Date(windowEndMs).toISOString());

    const records = ensureArray(await supabaseRequest(
      supabaseConfig,
      `activity_records?user_id=eq.${userId}&organization_id=eq.${organization.id}` +
      `&start_time=gte.${queryLowerUtc}` +
      `&start_time=lt.${queryUpperUtc}` +
      `&status=in.(pending,processing,analyzed)` +
      `&classification=in.(productive,unknown)` +
      `&clustering_dismissed=eq.false` +
      `&select=id,user_assigned_issue_key,start_time,end_time,total_time_seconds,duration_seconds` +
      `&order=start_time.asc&limit=1000`
    ));

    const matchedIds = [];
    let totalAttributed = 0;
    let previouslyAssignedCount = 0;

    for (const r of records) {
      const attribution = computeAttribution(r, windowStartMs, windowEndMs);
      if (!attribution || !attribution.overlapsWindow) continue;

      totalAttributed += attribution.attributed;
      if (r.user_assigned_issue_key !== null) previouslyAssignedCount++;
      matchedIds.push(r.id);
    }

    if (matchedIds.length === 0) {
      return { success: false, error: 'No activities found in the specified time range' };
    }

    const previouslyUnassignedCount = matchedIds.length - previouslyAssignedCount;

    // PATCH only activity_records, with defense-in-depth user/org filters in case
    // the source query is ever modified to return cross-tenant rows.
    const idsParam = sanitizeUUIDArray(matchedIds).join(',');
    await supabaseRequest(
      supabaseConfig,
      `activity_records?id=in.(${idsParam})&user_id=eq.${userId}&organization_id=eq.${organization.id}`,
      {
        method: 'PATCH',
        body: {
          user_assigned_issue_key: targetIssueKey,
          project_key: targetProjectKey
        }
      }
    );
    console.log(`[bulkReassignByTimeInterval] Updated ${matchedIds.length} activity_records`);

    // Worklog uses the pro-rated total so logged time matches what the preview showed.
    const autoSyncEnabled = await isAutoSyncEnabled(accountId, cloudId);
    let worklogResult = { worklog: null, worklogSkipped: false, worklogSkippedReason: null };
    if (createWorklog) {
      const customComment = `Bulk time correction: ${matchedIds.length} activities (${formatDuration(totalAttributed)}) from ${startTime} to ${endTime} on ${selectedDate} reassigned to this issue.`;
      worklogResult = await createWorklogIfNeeded({
        issueKey: targetIssueKey,
        timeToLog: totalAttributed,
        sessionCount: matchedIds.length,
        autoSyncEnabled,
        customComment
      });
    }

    return {
      success: true,
      result: {
        total_reassigned: matchedIds.length,
        previously_tracked: previouslyAssignedCount,
        previously_unassigned: previouslyUnassignedCount,
        total_seconds: totalAttributed,
        total_time_formatted: formatDuration(totalAttributed),
        target_issue_key: targetIssueKey,
        worklog_id: worklogResult.worklog?.id || null,
        worklog_skipped: worklogResult.worklogSkipped,
        worklog_skipped_reason: worklogResult.worklogSkippedReason,
        time_range: {
          start: windowStartUtc,
          end: windowEndUtc
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

    if (membersArray.length === 0) {
      console.warn(`[dismissUnassignedGroup] No members found for group ${groupId}`);
      return { success: false, error: 'Group has no members' };
    }

    const activityRecordIds = sanitizeUUIDArray(
      membersArray.map(m => m.activity_record_id).filter(Boolean)
    );
    const unassignedActivityIds = sanitizeUUIDArray(
      membersArray.map(m => m.unassigned_activity_id).filter(Boolean)
    );

    // Step 2: Mark new-pipeline activity_records as clustering_dismissed
    if (activityRecordIds.length > 0) {
      try {
        const arResult = await supabaseRequest(
          supabaseConfig,
          `activity_records?id=in.(${activityRecordIds.join(',')})&user_id=eq.${userId}`,
          {
            method: 'PATCH',
            body: { clustering_dismissed: true, clustering_dismissed_at: now }
          }
        );
        const arUpdated = ensureArray(arResult).length;
        console.log(`[dismissUnassignedGroup] Updated ${arUpdated}/${activityRecordIds.length} activity_records (idle or work)`);
        
        if (arUpdated === 0 && activityRecordIds.length > 0) {
          console.warn(`[dismissUnassignedGroup] WARNING: No activity_records were updated. Possible RLS policy block or records already dismissed.`);
        }
      } catch (err) {
        console.error(`[dismissUnassignedGroup] Error updating activity_records:`, err.message);
        throw new Error(`Failed to dismiss activity records: ${err.message}`);
      }
    }

    // Step 3: Mark legacy unassigned_activity records as clustering_dismissed
    if (unassignedActivityIds.length > 0) {
      try {
        const uaResult = await supabaseRequest(
          supabaseConfig,
          `unassigned_activity?id=in.(${unassignedActivityIds.join(',')})&user_id=eq.${userId}&organization_id=eq.${organization.id}`,
          {
            method: 'PATCH',
            body: { clustering_dismissed: true, clustering_dismissed_at: now }
          }
        );
        const uaUpdated = ensureArray(uaResult).length;
        console.log(`[dismissUnassignedGroup] Updated ${uaUpdated}/${unassignedActivityIds.length} unassigned_activity records`);
      } catch (err) {
        console.error(`[dismissUnassignedGroup] Error updating unassigned_activity:`, err.message);
        // Don't throw — legacy pipeline is optional
      }
    }

    // Step 4: Mark the group itself as dismissed (critical step)
    try {
      const groupResult = await supabaseRequest(
        supabaseConfig,
        `unassigned_work_groups?id=eq.${groupId}&user_id=eq.${userId}&organization_id=eq.${organization.id}`,
        {
          method: 'PATCH',
          body: { is_dismissed: true, dismissed_at: now, dismissed_by: userId }
        }
      );
      const groupUpdated = ensureArray(groupResult).length;
      
      if (groupUpdated === 0) {
        console.error(`[dismissUnassignedGroup] CRITICAL: Failed to mark group as dismissed. Group may not exist or RLS blocked the update.`);
        return { success: false, error: 'Failed to dismiss group. Check permissions.' };
      }
      
      console.log(`[dismissUnassignedGroup] ✓ Group ${groupId} dismissed successfully (${membersArray.length} members, 1 group)`);
    } catch (err) {
      console.error(`[dismissUnassignedGroup] Error updating group:`, err.message);
      throw new Error(`Failed to dismiss group: ${err.message}`);
    }

    return {
      success: true,
      dismissed_sessions: membersArray.length
    };

  } catch (error) {
    console.error(`[dismissUnassignedGroup] Fatal error:`, error);
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
    try {
      if (source === 'activity_records') {
        const result = await supabaseRequest(
          supabaseConfig,
          `activity_records?id=eq.${sessionId}&user_id=eq.${userId}`,
          {
            method: 'PATCH',
            body: { clustering_dismissed: true, clustering_dismissed_at: now }
          }
        );
        const updated = ensureArray(result).length;
        console.log(`[dismissGroupMember] Marked activity_record ${sessionId} as clustering_dismissed (${updated} rows updated)`);
        if (updated === 0) {
          console.warn(`[dismissGroupMember] WARNING: Activity record ${sessionId} not updated. May be RLS blocked.`);
        }
      } else {
        const result = await supabaseRequest(
          supabaseConfig,
          `unassigned_activity?id=eq.${sessionId}&user_id=eq.${userId}&organization_id=eq.${organization.id}`,
          {
            method: 'PATCH',
            body: { clustering_dismissed: true, clustering_dismissed_at: now }
          }
        );
        const updated = ensureArray(result).length;
        console.log(`[dismissGroupMember] Marked unassigned_activity ${sessionId} as clustering_dismissed (${updated} rows updated)`);
      }
    } catch (err) {
      console.error(`[dismissGroupMember] Error marking record as dismissed:`, err.message);
      throw err;
    }

    // Step 3: Remove from unassigned_group_members (session no longer belongs to this group)
    try {
      const delResult = await supabaseRequest(
        supabaseConfig,
        `unassigned_group_members?id=eq.${memberRow.id}`,
        { method: 'DELETE' }
      );
      console.log(`[dismissGroupMember] Deleted group member link ${memberRow.id}`);
    } catch (err) {
      console.error(`[dismissGroupMember] Error deleting group member:`, err.message);
      throw err;
    }

    // Step 4: Decrement session_count on the group so the UI stays accurate
    try {
      const groupRows = ensureArray(await supabaseRequest(
        supabaseConfig,
        `unassigned_work_groups?id=eq.${groupId}&user_id=eq.${userId}&organization_id=eq.${organization.id}&select=id,session_count`
      ));
      if (groupRows.length > 0) {
        const newCount = Math.max(0, (groupRows[0].session_count || 1) - 1);
        const updateResult = await supabaseRequest(
          supabaseConfig,
          `unassigned_work_groups?id=eq.${groupId}&user_id=eq.${userId}&organization_id=eq.${organization.id}`,
          { method: 'PATCH', body: { session_count: newCount } }
        );
        const updated = ensureArray(updateResult).length;
        console.log(`[dismissGroupMember] Updated group session_count to ${newCount} (${updated} rows updated)`);
      }
    } catch (err) {
      console.error(`[dismissGroupMember] Error updating group count:`, err.message);
      throw err;
    }

    console.log(`[dismissGroupMember] ✓ Session ${sessionId} (${source}) removed from group ${groupId} and marked clustering_dismissed`);

    return {
      success: true,
      session_id: sessionId,
      source
    };

  } catch (error) {
    console.error(`[dismissGroupMember] Fatal error:`, error);
    return handleResolverError(error, 'dismissing group member');
  }
}

/**
 * Register assignment resolvers
 */
export function registerAssignmentResolvers(resolver) {
  resolver.define('assignToExistingIssue', assignToExistingIssue);
  resolver.define('assignSelectionToExistingIssue', assignSelectionToExistingIssue);
  resolver.define('createIssueAndAssign', createIssueAndAssign);
  resolver.define('createIssueAndAssignSelection', createIssueAndAssignSelection);
  resolver.define('previewBulkReassign', previewBulkReassign);
  resolver.define('bulkReassignByTimeInterval', bulkReassignByTimeInterval);
  resolver.define('dismissUnassignedGroup', dismissUnassignedGroup);
  resolver.define('dismissGroupMember', dismissGroupMember);
}
