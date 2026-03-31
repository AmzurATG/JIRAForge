/**
 * Worklog Reassignment Service
 * Handles moving synced Jira worklogs from one issue to another.
 */
import { getSupabaseConfig, getOrCreateUser, getOrCreateOrganization, supabaseRequest } from '../utils/supabase.js';
import { isValidIssueKey } from '../utils/validators.js';
import { createJiraWorklog, deleteJiraWorklog, updateJiraWorklog } from '../utils/jira.js';

/**
 * Reassign a synced worklog from one issue to another.
 * This is an atomic operation that:
 *  1. Deletes the Jira worklog on the old issue
 *  2. Creates a new Jira worklog on the new issue
 *  3. Updates worklog_sync mapping
 *  4. Updates underlying activity_records & analysis_results
 *
 * @param {string} accountId - Atlassian account ID
 * @param {string} cloudId - Jira Cloud ID
 * @param {string} fromIssueKey - Current issue key (e.g., "PROJ-2")
 * @param {string} toIssueKey - Target issue key (e.g., "PROJ-1")
 * @returns {Promise<Object>} Result of the reassignment
 */
export async function reassignWorklog(accountId, cloudId, fromIssueKey, toIssueKey) {
  // --- 1. Validate inputs ---
  if (!isValidIssueKey(fromIssueKey)) throw new Error('Invalid source issue key format');
  if (!isValidIssueKey(toIssueKey)) throw new Error('Invalid target issue key format');
  if (fromIssueKey === toIssueKey) throw new Error('Source and target issue must be different');

  const supabaseConfig = await getSupabaseConfig(accountId);
  if (!supabaseConfig) throw new Error('Supabase not configured');

  const organization = await getOrCreateOrganization(cloudId, supabaseConfig);
  if (!organization) throw new Error('Unable to get organization');

  const userId = await getOrCreateUser(accountId, supabaseConfig, organization.id);
  if (!userId) throw new Error('Unable to get user');

  // --- 2. Fetch worklog_sync record ---
  const syncRecords = await supabaseRequest(
    supabaseConfig,
    `worklog_sync?organization_id=eq.${organization.id}&user_id=eq.${userId}&issue_key=eq.${fromIssueKey}`,
    { method: 'GET' }
  );

  if (!syncRecords || syncRecords.length === 0) {
    throw new Error(`No synced worklog found for issue ${fromIssueKey}`);
  }

  const syncRecord = syncRecords[0];
  const { jira_worklog_id, last_synced_seconds, started_at, id: syncId } = syncRecord;

  if (!jira_worklog_id) {
    throw new Error('Worklog has not been synced to Jira yet (pending state)');
  }

  // Check for existing worklog on target issue (prevent duplicates)
  const existingTarget = await supabaseRequest(
    supabaseConfig,
    `worklog_sync?organization_id=eq.${organization.id}&user_id=eq.${userId}&issue_key=eq.${toIssueKey}`,
    { method: 'GET' }
  );

  if (existingTarget && existingTarget.length > 0) {
    throw new Error(`A worklog already exists for issue ${toIssueKey}. Merge is not supported — reassign activity records first.`);
  }

  const toProjectKey = toIssueKey.split('-')[0];
  const timeSpentSeconds = last_synced_seconds || 0;
  const worklogStartedAt = started_at || new Date().toISOString();

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
        project_key: toProjectKey,
        reassigned_from: fromIssueKey,
        reassigned_at: now
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
 * Split a synced worklog — move a portion of time from one issue to another.
 * For full moves (splitSeconds == total), delegates to reassignWorklog().
 * For partial splits, uses PUT on source + POST on target.
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
  if (!isValidIssueKey(fromIssueKey)) throw new Error('Invalid source issue key format');
  if (!isValidIssueKey(toIssueKey)) throw new Error('Invalid target issue key format');
  if (fromIssueKey === toIssueKey) throw new Error('Source and target issue must be different');
  if (!splitSeconds || splitSeconds <= 0 || !Number.isInteger(splitSeconds)) {
    throw new Error('splitSeconds must be a positive integer');
  }

  const supabaseConfig = await getSupabaseConfig(accountId);
  if (!supabaseConfig) throw new Error('Supabase not configured');

  const organization = await getOrCreateOrganization(cloudId, supabaseConfig);
  if (!organization) throw new Error('Unable to get organization');

  const userId = await getOrCreateUser(accountId, supabaseConfig, organization.id);
  if (!userId) throw new Error('Unable to get user');

  // --- 2. Fetch worklog_sync record for source issue ---
  const syncRecords = await supabaseRequest(
    supabaseConfig,
    `worklog_sync?organization_id=eq.${organization.id}&user_id=eq.${userId}&issue_key=eq.${fromIssueKey}`,
    { method: 'GET' }
  );

  if (!syncRecords || syncRecords.length === 0) {
    throw new Error(`No synced worklog found for issue ${fromIssueKey}`);
  }

  const syncRecord = syncRecords[0];
  const { jira_worklog_id, last_synced_seconds, started_at, id: syncId } = syncRecord;
  const totalSeconds = last_synced_seconds || 0;

  if (!jira_worklog_id) {
    throw new Error('Worklog has not been synced to Jira yet (pending state)');
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

  // --- 4. Check target doesn't already have a worklog ---
  const existingTarget = await supabaseRequest(
    supabaseConfig,
    `worklog_sync?organization_id=eq.${organization.id}&user_id=eq.${userId}&issue_key=eq.${toIssueKey}`,
    { method: 'GET' }
  );

  if (existingTarget && existingTarget.length > 0) {
    throw new Error(`A worklog already exists for issue ${toIssueKey}. Merge is not supported — reassign activity records first.`);
  }

  const toProjectKey = toIssueKey.split('-')[0];
  const worklogStartedAt = started_at || new Date().toISOString();

  // --- 5a. UPDATE source Jira worklog (reduce to remainingSeconds) ---
  const updateResponse = await updateJiraWorklog(fromIssueKey, jira_worklog_id, remainingSeconds);
  if (updateResponse.status !== 200) {
    throw new Error(`Failed to update worklog on ${fromIssueKey}: HTTP ${updateResponse.status}`);
  }

  // --- 5b. CREATE target Jira worklog (splitSeconds) ---
  let newWorklogId;
  try {
    const createResult = await createJiraWorklog(toIssueKey, splitSeconds, worklogStartedAt);
    newWorklogId = createResult.id;

    if (!newWorklogId) {
      // Rollback: restore source worklog to original total
      await updateJiraWorklog(fromIssueKey, jira_worklog_id, totalSeconds);
      throw new Error(`Failed to create worklog on ${toIssueKey}: no worklog ID returned`);
    }
  } catch (error) {
    if (!error.message.includes('Failed to create worklog')) {
      // Rollback: restore source worklog to original total
      try {
        await updateJiraWorklog(fromIssueKey, jira_worklog_id, totalSeconds);
        console.log(`[WorklogSplit] Rollback: restored ${fromIssueKey} to ${totalSeconds}s`);
      } catch (rollbackErr) {
        console.error(`[WorklogSplit] CRITICAL: rollback failed for ${fromIssueKey}:`, rollbackErr.message);
      }
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

  // --- 5d. Create target worklog_sync ---
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
    const records = await supabaseRequest(
      supabaseConfig,
      `activity_records?user_id=eq.${userId}&organization_id=eq.${organizationId}` +
      `&user_assigned_issue_key=eq.${fromIssueKey}` +
      `&select=id,duration_seconds,total_time_seconds` +
      `&order=end_time.desc&limit=500`
    );

    if (!records || records.length === 0) return;

    // Accumulate records until we cover splitSeconds
    let accumulated = 0;
    const idsToMove = [];

    for (const record of records) {
      if (accumulated >= splitSeconds) break;
      const duration = record.duration_seconds || record.total_time_seconds || 0;
      idsToMove.push(record.id);
      accumulated += duration;
    }

    if (idsToMove.length === 0) return;

    // Batch update
    await supabaseRequest(
      supabaseConfig,
      `activity_records?id=in.(${idsToMove.join(',')})`,
      {
        method: 'PATCH',
        body: {
          user_assigned_issue_key: toIssueKey,
          project_key: toProjectKey,
          reassigned_from: fromIssueKey,
          reassigned_at: now
        }
      }
    );

    console.log(`[WorklogSplit] Moved ${idsToMove.length} activity records (${accumulated}s) from ${fromIssueKey} to ${toIssueKey}`);
  } catch (err) {
    // Non-critical — worklog_sync is the source of truth
    console.warn(`[WorklogSplit] Activity records reassignment failed: ${err.message}`);
  }
}
