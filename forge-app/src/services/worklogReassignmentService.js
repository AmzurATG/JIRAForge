/**
 * Worklog Reassignment Service
 * Handles moving tracked time from one issue to another.
 * Works with both synced Jira worklogs and unsynced activity_records.
 */
import { getSupabaseConfig, getOrCreateUser, getOrCreateOrganization, supabaseRequest } from '../utils/supabase.js';
import { isValidIssueKey } from '../utils/validators.js';
import { createJiraWorklog, deleteJiraWorklog, updateJiraWorklog } from '../utils/jira.js';
import { formatJiraDate } from '../utils/formatters.js';

/**
 * Reassign activity_records from one issue to another when no worklog_sync exists.
 * The next scheduled sync will create the Jira worklog on the correct issue.
 */
async function reassignActivityRecordsOnly(supabaseConfig, userId, organizationId, fromIssueKey, toIssueKey) {
  const toProjectKey = toIssueKey.split('-')[0];
  const now = new Date().toISOString();

  // Build filter: match specific issue key, or NULL (unassigned)
  const issueFilter = fromIssueKey
    ? `&user_assigned_issue_key=eq.${fromIssueKey}`
    : `&user_assigned_issue_key=is.null`;

  console.log(`[WorklogReassign] Querying activity_records: userId=${userId}, orgId=${organizationId}, filter=${issueFilter}`);

  // Fetch activity_records to calculate total seconds being moved
  const records = await supabaseRequest(
    supabaseConfig,
    `activity_records?user_id=eq.${userId}&organization_id=eq.${organizationId}` +
    issueFilter +
    `&select=id,duration_seconds,total_time_seconds` +
    `&order=end_time.desc&limit=1000`
  );

  console.log(`[WorklogReassign] Found ${(records || []).length} activity_records to reassign`);

  if (!records || records.length === 0) {
    console.warn(`[WorklogReassign] No records found for reassignment. Returning 0.`);
    return 0;
  }

  const totalSeconds = (records || []).reduce(
    (sum, r) => sum + (r.duration_seconds || r.total_time_seconds || 0), 0
  );

  // Update all activity_records
  const patchResult = await supabaseRequest(
    supabaseConfig,
    `activity_records?user_id=eq.${userId}&organization_id=eq.${organizationId}` + issueFilter,
    {
      method: 'PATCH',
      body: {
        user_assigned_issue_key: toIssueKey,
        project_key: toProjectKey
      }
    }
  );

  console.log(`[WorklogReassign] PATCH result:`, JSON.stringify(patchResult)?.substring(0, 200));

  // Update analysis_results (legacy) — non-critical
  if (fromIssueKey) {
    try {
      await supabaseRequest(
        supabaseConfig,
        `analysis_results?user_id=eq.${userId}&organization_id=eq.${organizationId}&active_task_key=eq.${fromIssueKey}`,
        {
          method: 'PATCH',
          body: {
            active_task_key: toIssueKey,
            active_project_key: toProjectKey,
            reassigned_from: fromIssueKey,
            reassigned_at: now
          }
        }
      );
    } catch (err) {
      console.warn(`[WorklogReassign] Legacy analysis_results update failed: ${err.message}`);
    }
  }

  console.log(`[WorklogReassign] Activity-only reassign: ${fromIssueKey} → ${toIssueKey} (${totalSeconds}s, ${(records || []).length} records)`);
  return totalSeconds;
}

/**
 * Reassign a worklog from one issue to another.
 * If a synced Jira worklog exists, moves it in Jira.
 * If no worklog_sync record exists (not yet synced), reassigns activity_records
 * directly — the next sync cycle will create the Jira worklog on the correct issue.
 *
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID
 * @param {string} fromIssueKey - Current issue key (e.g., "PROJ-2")
 * @param {string} toIssueKey - Target issue key (e.g., "PROJ-1")
 * @returns {Promise<Object>} Result of the reassignment
 */
export async function reassignWorklog(accountId, cloudId, fromIssueKey, toIssueKey) {
  // --- 1. Validate inputs ---
  if (fromIssueKey && !isValidIssueKey(fromIssueKey)) throw new Error('Invalid source issue key format');
  if (!isValidIssueKey(toIssueKey)) throw new Error('Invalid target issue key format');
  if (fromIssueKey && fromIssueKey === toIssueKey) throw new Error('Source and target issue must be different');

  const supabaseConfig = await getSupabaseConfig(accountId);
  if (!supabaseConfig) throw new Error('Supabase not configured');

  const organization = await getOrCreateOrganization(cloudId, supabaseConfig);
  if (!organization) throw new Error('Unable to get organization');

  const userId = await getOrCreateUser(accountId, supabaseConfig, organization.id);
  if (!userId) throw new Error('Unable to get user');

  console.log(`[WorklogReassign] Resolved: orgId=${organization.id}, userId=${userId}, from=${fromIssueKey || 'null'}, to=${toIssueKey}`);

  // --- 2. Fetch worklog_sync record (skip for unassigned — they have no sync) ---
  let syncRecords = null;
  if (fromIssueKey) {
    syncRecords = await supabaseRequest(
      supabaseConfig,
      `worklog_sync?organization_id=eq.${organization.id}&user_id=eq.${userId}&issue_key=eq.${fromIssueKey}`,
      { method: 'GET' }
    );
  }

  // --- 2b. No worklog_sync → reassign activity_records only ---
  if (!syncRecords || syncRecords.length === 0) {
    const totalSeconds = await reassignActivityRecordsOnly(
      supabaseConfig, userId, organization.id, fromIssueKey, toIssueKey
    );
    return {
      success: true,
      fromIssueKey,
      toIssueKey,
      timeSpentSeconds: totalSeconds,
      oldWorklogId: null,
      newWorklogId: null,
      message: `Activity records reassigned from ${fromIssueKey} to ${toIssueKey} (${totalSeconds}s, worklog will sync on next cycle)`
    };
  }

  const syncRecord = syncRecords[0];
  const { jira_worklog_id, last_synced_seconds, started_at, id: syncId } = syncRecord;

  // --- 2c. Pending worklog_sync (no Jira worklog yet) → reassign records + update mapping ---
  if (!jira_worklog_id) {
    const toProjectKey = toIssueKey.split('-')[0];
    const now = new Date().toISOString();
    const totalSeconds = await reassignActivityRecordsOnly(
      supabaseConfig, userId, organization.id, fromIssueKey, toIssueKey
    );
    // Update the pending worklog_sync mapping to point to the new issue
    await supabaseRequest(
      supabaseConfig,
      `worklog_sync?id=eq.${syncId}`,
      {
        method: 'PATCH',
        body: {
          issue_key: toIssueKey,
          project_key: toProjectKey,
          reassigned_from: fromIssueKey,
          reassigned_at: now
        }
      }
    );
    return {
      success: true,
      fromIssueKey,
      toIssueKey,
      timeSpentSeconds: totalSeconds,
      oldWorklogId: null,
      newWorklogId: null,
      message: `Pending worklog reassigned from ${fromIssueKey} to ${toIssueKey} (${totalSeconds}s)`
    };
  }

  const toProjectKey = toIssueKey.split('-')[0];
  const timeSpentSeconds = last_synced_seconds || 0;
  // Format date for Jira API compatibility (use +0000 instead of Z)
  const worklogStartedAt = started_at ? formatJiraDate(new Date(started_at)) : formatJiraDate();
  const worklogDate = worklogStartedAt.split('T')[0]; // Extract YYYY-MM-DD
  
  // Check for existing worklogs on target issue
  const existingTargetWorklogs = await supabaseRequest(
    supabaseConfig,
    `worklog_sync?organization_id=eq.${organization.id}&user_id=eq.${userId}&issue_key=eq.${toIssueKey}`,
    { method: 'GET' }
  );

  if (existingTargetWorklogs && existingTargetWorklogs.length > 0) {
    // Check if any are from the SAME DATE (can't merge same-day worklogs)
    const sameDayWorklogs = existingTargetWorklogs.filter(wl => {
      const wlDate = wl.started_at ? wl.started_at.split('T')[0] : null;
      return wlDate === worklogDate;
    });

    if (sameDayWorklogs.length > 0) {
      throw new Error(`A worklog already exists for issue ${toIssueKey} on ${worklogDate}. Merge is not supported — reassign activity records first.`);
    }

    // Delete worklogs from different dates (they're already synced to Jira)
    console.log(`[WorklogReassign] Deleting ${existingTargetWorklogs.length} old worklog_sync record(s) for ${toIssueKey}`);
    await supabaseRequest(
      supabaseConfig,
      `worklog_sync?organization_id=eq.${organization.id}&user_id=eq.${userId}&issue_key=eq.${toIssueKey}`,
      { method: 'DELETE' }
    );
  }

  // --- 3. Delete Jira worklog on OLD issue ---
  const deleteResponse = await deleteJiraWorklog(fromIssueKey, jira_worklog_id);

  if (!deleteResponse.ok && deleteResponse.status !== 404) {
    throw new Error(`Failed to delete worklog from ${fromIssueKey}: ${deleteResponse.status}`);
  }

  // --- 4. Create Jira worklog on NEW issue ---
  let newWorklogId;
  try {
    const createResult = await createJiraWorklog(toIssueKey, timeSpentSeconds, worklogStartedAt);
    newWorklogId = createResult.id;

    if (!newWorklogId) {
      // Attempt to re-create on old issue to rollback
      await rollbackWorklog(fromIssueKey, timeSpentSeconds, worklogStartedAt);
      throw new Error(`Failed to create worklog on ${toIssueKey}: no worklog ID returned`);
    }
  } catch (error) {
    if (!error.message.includes('Failed to create worklog')) {
      await rollbackWorklog(fromIssueKey, timeSpentSeconds, worklogStartedAt);
    }
    throw error;
  }

  const now = new Date().toISOString();

  // --- 5. Update worklog_sync record ---
  await supabaseRequest(
    supabaseConfig,
    `worklog_sync?id=eq.${syncId}`,
    {
      method: 'PATCH',
      body: {
        issue_key: toIssueKey,
        project_key: toProjectKey,
        jira_worklog_id: newWorklogId,
        reassigned_from: fromIssueKey,
        reassigned_at: now
      }
    }
  );

  // --- 6. Update activity_records ---
  await supabaseRequest(
    supabaseConfig,
    `activity_records?user_id=eq.${userId}&organization_id=eq.${organization.id}&user_assigned_issue_key=eq.${fromIssueKey}`,
    {
      method: 'PATCH',
      body: {
        user_assigned_issue_key: toIssueKey,
        project_key: toProjectKey
      }
    }
  );

  // --- 7. Update analysis_results (legacy) ---
  try {
    await supabaseRequest(
      supabaseConfig,
      `analysis_results?user_id=eq.${userId}&organization_id=eq.${organization.id}&active_task_key=eq.${fromIssueKey}`,
      {
        method: 'PATCH',
        body: {
          active_task_key: toIssueKey,
          active_project_key: toProjectKey,
          reassigned_from: fromIssueKey,
          reassigned_at: now
        }
      }
    );
  } catch (err) {
    // Non-critical — legacy table may not have matching records
    console.warn(`[WorklogReassign] Legacy analysis_results update failed: ${err.message}`);
  }

  console.log(`[WorklogReassign] Success: ${fromIssueKey} → ${toIssueKey} (${timeSpentSeconds}s, worklog ${jira_worklog_id} → ${newWorklogId})`);

  return {
    success: true,
    fromIssueKey,
    toIssueKey,
    timeSpentSeconds,
    oldWorklogId: jira_worklog_id,
    newWorklogId,
    message: `Worklog reassigned from ${fromIssueKey} to ${toIssueKey} (${timeSpentSeconds}s)`
  };
}

/**
 * Attempt to re-create worklog on old issue if new creation fails (rollback).
 */
async function rollbackWorklog(issueKey, timeSpentSeconds, startedAt) {
  try {
    await createJiraWorklog(issueKey, timeSpentSeconds, startedAt);
    console.log(`[WorklogReassign] Rollback: re-created worklog on ${issueKey}`);
  } catch (err) {
    console.error(`[WorklogReassign] CRITICAL: rollback failed for ${issueKey}:`, err.message);
  }
}

/**
 * Split a worklog — move a portion of time from one issue to another.
 * If a synced Jira worklog exists, splits it in Jira.
 * If no worklog_sync record exists, reassigns activity_records directly.
 * For full moves (splitSeconds == total), delegates to reassignWorklog().
 * For partial splits with a synced worklog, uses PUT on source + POST on target.
 *
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID
 * @param {string} fromIssueKey - Source issue key (e.g., "PROJ-2")
 * @param {string} toIssueKey - Target issue key (e.g., "PROJ-1")
 * @param {number} splitSeconds - Seconds to move to target issue
 * @returns {Promise<Object>} Result of the split
 */
export async function splitWorklog(accountId, cloudId, fromIssueKey, toIssueKey, splitSeconds) {
  // --- 1. Validate inputs ---
  if (fromIssueKey && !isValidIssueKey(fromIssueKey)) throw new Error('Invalid source issue key format');
  if (!isValidIssueKey(toIssueKey)) throw new Error('Invalid target issue key format');
  if (fromIssueKey && fromIssueKey === toIssueKey) throw new Error('Source and target issue must be different');
  if (!splitSeconds || splitSeconds <= 0 || !Number.isInteger(splitSeconds)) {
    throw new Error('splitSeconds must be a positive integer');
  }

  const supabaseConfig = await getSupabaseConfig(accountId);
  if (!supabaseConfig) throw new Error('Supabase not configured');

  const organization = await getOrCreateOrganization(cloudId, supabaseConfig);
  if (!organization) throw new Error('Unable to get organization');

  const userId = await getOrCreateUser(accountId, supabaseConfig, organization.id);
  if (!userId) throw new Error('Unable to get user');

  console.log(`[WorklogSplit] Resolved: orgId=${organization.id}, userId=${userId}, from=${fromIssueKey || 'null'}, to=${toIssueKey}, splitSeconds=${splitSeconds}`);

  // --- 2. Fetch worklog_sync record for source issue (skip for unassigned) ---
  let syncRecords = null;
  if (fromIssueKey) {
    syncRecords = await supabaseRequest(
      supabaseConfig,
      `worklog_sync?organization_id=eq.${organization.id}&user_id=eq.${userId}&issue_key=eq.${fromIssueKey}`,
      { method: 'GET' }
    );
  }

  // --- 2b. No worklog_sync → reassign activity_records proportionally ---
  if (!syncRecords || syncRecords.length === 0) {
    console.log(`[WorklogSplit] No worklog_sync for ${fromIssueKey || 'unassigned'}, reassigning activity_records directly`);
    const moveResult = await reassignProportionalActivityRecords(
      supabaseConfig, userId, organization.id, fromIssueKey, toIssueKey, splitSeconds
    );
    const movedCount = moveResult?.movedCount || 0;
    const movedSeconds = moveResult?.movedSeconds || 0;
    console.log(`[WorklogSplit] Activity-only result: movedCount=${movedCount}, movedSeconds=${movedSeconds}`);
    if (movedCount === 0) {
      throw new Error(`No activity records found to reassign from ${fromIssueKey || 'unassigned'}. Check that tracked time exists for today.`);
    }
    return {
      success: true,
      fromIssueKey,
      toIssueKey,
      splitSeconds,
      remainingSeconds: null,
      oldWorklogId: null,
      newWorklogId: null,
      message: `Activity records split: ${movedSeconds}s moved (${movedCount} records) from ${fromIssueKey || 'unassigned'} to ${toIssueKey}`
    };
  }

  const syncRecord = syncRecords[0];
  const { jira_worklog_id, last_synced_seconds, started_at, id: syncId } = syncRecord;
  const totalSeconds = last_synced_seconds || 0;

  // --- 2c. Pending worklog_sync (no Jira worklog yet) → reassign activity_records ---
  if (!jira_worklog_id) {
    console.log(`[WorklogSplit] Pending worklog_sync for ${fromIssueKey}, reassigning activity_records directly`);
    await reassignProportionalActivityRecords(
      supabaseConfig, userId, organization.id, fromIssueKey, toIssueKey, splitSeconds
    );
    return {
      success: true,
      fromIssueKey,
      toIssueKey,
      splitSeconds,
      remainingSeconds: totalSeconds > splitSeconds ? totalSeconds - splitSeconds : 0,
      oldWorklogId: null,
      newWorklogId: null,
      message: `Pending worklog split: ${splitSeconds}s from ${fromIssueKey} to ${toIssueKey}`
    };
  }

  if (splitSeconds > totalSeconds) {
    throw new Error(`splitSeconds (${splitSeconds}) exceeds worklog total (${totalSeconds}s)`);
  }

  // --- 3. Full move: delegate to existing reassignWorklog ---
  const remainingSeconds = totalSeconds - splitSeconds;
  if (remainingSeconds === 0) {
    const result = await reassignWorklog(accountId, cloudId, fromIssueKey, toIssueKey);
    return {
      ...result,
      splitSeconds: totalSeconds,
      remainingSeconds: 0,
      message: `Worklog fully moved from ${fromIssueKey} to ${toIssueKey} (${totalSeconds}s)`
    };
  }

  const toProjectKey = toIssueKey.split('-')[0];
  // Format date for Jira API compatibility (use +0000 instead of Z)
  const worklogStartedAt = started_at ? formatJiraDate(new Date(started_at)) : formatJiraDate();
  const worklogDate = worklogStartedAt.split('T')[0]; // Extract YYYY-MM-DD
  
  // --- 4. Check for existing worklogs on target issue ---
  const existingTargetWorklogs = await supabaseRequest(
    supabaseConfig,
    `worklog_sync?organization_id=eq.${organization.id}&user_id=eq.${userId}&issue_key=eq.${toIssueKey}`,
    { method: 'GET' }
  );

  if (existingTargetWorklogs && existingTargetWorklogs.length > 0) {
    // Check if any are from the SAME DATE (can't merge same-day worklogs)
    const sameDayWorklogs = existingTargetWorklogs.filter(wl => {
      const wlDate = wl.started_at ? wl.started_at.split('T')[0] : null;
      return wlDate === worklogDate;
    });

    if (sameDayWorklogs.length > 0) {
      throw new Error(`A worklog already exists for issue ${toIssueKey} on ${worklogDate}. Merge is not supported — reassign activity records first.`);
    }

    // Delete worklogs from different dates (they're already synced to Jira)
    console.log(`[WorklogSplit] Deleting ${existingTargetWorklogs.length} old worklog_sync record(s) for ${toIssueKey}`);
    await supabaseRequest(
      supabaseConfig,
      `worklog_sync?organization_id=eq.${organization.id}&user_id=eq.${userId}&issue_key=eq.${toIssueKey}`,
      { method: 'DELETE' }
    );
  }

  // --- 5a. UPDATE source Jira worklog (reduce to remainingSeconds) ---
  const updateResponse = await updateJiraWorklog(fromIssueKey, jira_worklog_id, remainingSeconds);
  if (updateResponse.status !== 200) {
    throw new Error(`Failed to update worklog on ${fromIssueKey}: HTTP ${updateResponse.status}`);
  }

  // --- 5b. CREATE target Jira worklog (splitSeconds) ---
  let newWorklogId;
  try {
    console.log(`[WorklogSplit] Creating worklog on ${toIssueKey}: ${splitSeconds}s at ${worklogStartedAt}`);
    const createResult = await createJiraWorklog(toIssueKey, splitSeconds, worklogStartedAt);
    newWorklogId = createResult.id;
    console.log(`[WorklogSplit] Successfully created worklog ${newWorklogId} on ${toIssueKey}`);
  } catch (error) {
    console.error(`[WorklogSplit] Error creating worklog on ${toIssueKey}:`, error.message);
    // Rollback: restore source worklog to original total
    try {
      await updateJiraWorklog(fromIssueKey, jira_worklog_id, totalSeconds);
      console.log(`[WorklogSplit] Rollback: restored ${fromIssueKey} to ${totalSeconds}s`);
    } catch (rollbackErr) {
      console.error(`[WorklogSplit] CRITICAL: rollback failed for ${fromIssueKey}:`, rollbackErr.message);
    }
    throw error;
  }

  const now = new Date().toISOString();

  // --- 5c. Update source worklog_sync (reduce seconds) ---
  await supabaseRequest(
    supabaseConfig,
    `worklog_sync?id=eq.${syncId}`,
    {
      method: 'PATCH',
      body: {
        last_synced_seconds: remainingSeconds,
        updated_at: now
      }
    }
  );

  // --- 5d. Create target worklog_sync record ---
  await supabaseRequest(
    supabaseConfig,
    'worklog_sync',
    {
      method: 'POST',
      body: {
        organization_id: organization.id,
        user_id: userId,
        issue_key: toIssueKey,
        jira_worklog_id: String(newWorklogId),
        last_synced_seconds: splitSeconds,
        started_at: worklogStartedAt,
        created_as_user: true,
        reassigned_from: fromIssueKey,
        reassigned_at: now,
        created_at: now,
        updated_at: now
      }
    }
  );

  // --- 5e. Reassign proportional activity_records ---
  await reassignProportionalActivityRecords(
    supabaseConfig, userId, organization.id, fromIssueKey, toIssueKey, splitSeconds
  );

  console.log(`[WorklogSplit] Success: ${fromIssueKey} (${remainingSeconds}s remaining) → ${toIssueKey} (${splitSeconds}s split, worklog ${newWorklogId})`);

  return {
    success: true,
    fromIssueKey,
    toIssueKey,
    splitSeconds,
    remainingSeconds,
    oldWorklogId: jira_worklog_id,
    newWorklogId,
    message: `Split ${splitSeconds}s from ${fromIssueKey} to ${toIssueKey} (${remainingSeconds}s remaining on ${fromIssueKey})`
  };
}

/**
 * Move a subset of activity_records from source → target to cover splitSeconds.
 * Uses newest-first ordering so the most recent work gets reassigned.
 */
async function reassignProportionalActivityRecords(
  supabaseConfig, userId, organizationId, fromIssueKey, toIssueKey, splitSeconds
) {
  const toProjectKey = toIssueKey.split('-')[0];
  const now = new Date().toISOString();

  try {
    // Build filter: match specific issue key, or NULL (unassigned)
    const issueFilter = fromIssueKey
      ? `&user_assigned_issue_key=eq.${fromIssueKey}`
      : `&user_assigned_issue_key=is.null`;

    console.log(`[WorklogSplit] Proportional query: userId=${userId}, orgId=${organizationId}, filter=${issueFilter}, splitSeconds=${splitSeconds}`);

    const records = await supabaseRequest(
      supabaseConfig,
      `activity_records?user_id=eq.${userId}&organization_id=eq.${organizationId}` +
      issueFilter +
      `&select=id,duration_seconds,total_time_seconds` +
      `&order=end_time.desc&limit=500`
    );

    console.log(`[WorklogSplit] Found ${(records || []).length} records to split from`);

    if (!records || records.length === 0) {
      console.warn(`[WorklogSplit] No records found for proportional split. userId=${userId}, orgId=${organizationId}, issueFilter=${issueFilter}`);
      return { movedCount: 0, movedSeconds: 0 };
    }

    // Accumulate records until we cover splitSeconds
    let accumulated = 0;
    const idsToMove = [];

    for (const record of records) {
      if (accumulated >= splitSeconds) break;
      const duration = record.duration_seconds || record.total_time_seconds || 0;
      idsToMove.push(record.id);
      accumulated += duration;
    }

    if (idsToMove.length === 0) return { movedCount: 0, movedSeconds: 0 };

    // Batch update
    const patchResult = await supabaseRequest(
      supabaseConfig,
      `activity_records?id=in.(${idsToMove.join(',')})`,
      {
        method: 'PATCH',
        body: {
          user_assigned_issue_key: toIssueKey,
          project_key: toProjectKey
        }
      }
    );

    console.log(`[WorklogSplit] Moved ${idsToMove.length} activity records (${accumulated}s) from ${fromIssueKey || 'unassigned'} to ${toIssueKey}. PATCH result count: ${(patchResult || []).length}`);
    return { movedCount: idsToMove.length, movedSeconds: accumulated };
  } catch (err) {
    console.error(`[WorklogSplit] Activity records reassignment failed: ${err.message}`);
    throw err;
  }
}
