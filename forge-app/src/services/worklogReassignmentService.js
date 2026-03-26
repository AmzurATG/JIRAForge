/**
 * Worklog Reassignment Service
 * Handles moving synced Jira worklogs from one issue to another.
 */
import { getSupabaseConfig, getOrCreateUser, getOrCreateOrganization, supabaseRequest } from '../utils/supabase.js';
import { isValidIssueKey } from '../utils/validators.js';
import { createJiraWorklog, deleteJiraWorklog } from '../utils/jira.js';

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
