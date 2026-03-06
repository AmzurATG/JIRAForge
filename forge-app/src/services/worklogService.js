/**
 * Worklog Service
 * Business logic for creating Jira worklogs and syncing in user context.
 */

import { createJiraWorklog, updateJiraWorklog, deleteJiraWorklog, deleteJiraWorklogAsApp } from '../utils/jira.js';
// eslint-disable-next-line deprecation/deprecation
import { getSupabaseConfig, supabaseRequest, getOrCreateOrganization, getOrCreateUser } from '../utils/supabase.js';
import { formatJiraDate } from '../utils/formatters.js';
import { isValidIssueKey } from '../utils/validators.js';

const MIN_SYNC_SECONDS = 60;

/**
 * Create a worklog entry in Jira (interactive user context).
 * @param {string} issueKey - Jira issue key (e.g., PROJ-123)
 * @param {number} timeSpentSeconds - Time spent in seconds
 * @param {string} startedAt - ISO timestamp when work started
 * @returns {Promise<Object>} Created worklog data
 */
export async function createWorklog(issueKey, timeSpentSeconds, startedAt) {
  return await createJiraWorklog(issueKey, timeSpentSeconds, startedAt);
}

/**
 * Aggregate tracked time for a user from activity_records.
 * Uses the new interval-based tracking table instead of screenshot-based analysis_results.
 * @param {Object} supabaseConfig - Supabase configuration
 * @param {string} organizationId - Organization ID
 * @param {string} userId - User ID
 * @returns {Promise<Array>} Array of {issueKey, timeTracked, lastWorkedOn}
 */
async function aggregateUserTrackedTime(supabaseConfig, organizationId, userId) {
  const PAGE_SIZE = 1000;
  const timeByIssue = {};
  const lastWorkedByIssue = {};
  let offset = 0;
  let totalFetched = 0;

  while (true) {
    // Query activity_records (interval-based tracking) instead of analysis_results (screenshot-based)
    // eslint-disable-next-line deprecation/deprecation
    const page = await supabaseRequest(
      supabaseConfig,
      `activity_records?organization_id=eq.${organizationId}&user_id=eq.${userId}&status=in.(pending,processing,analyzed)&classification=in.(productive,unknown)&user_assigned_issue_key=not.is.null&select=user_assigned_issue_key,duration_seconds,total_time_seconds,end_time&order=created_at.desc&limit=${PAGE_SIZE}&offset=${offset}`
    );

    if (!page || !Array.isArray(page) || page.length === 0) break;

    page.forEach(entry => {
      const key = entry.user_assigned_issue_key;
      if (!timeByIssue[key]) {
        timeByIssue[key] = 0;
        lastWorkedByIssue[key] = null;
      }
      // Use duration_seconds or total_time_seconds (whichever is available)
      timeByIssue[key] += entry.duration_seconds || entry.total_time_seconds || 0;
      const ts = entry.end_time;
      if (ts && (!lastWorkedByIssue[key] || ts > lastWorkedByIssue[key])) {
        lastWorkedByIssue[key] = ts;
      }
    });

    totalFetched += page.length;
    offset += page.length;
    if (page.length < PAGE_SIZE) break;
    if (totalFetched > 5000) break; // Safety limit per user
  }

  return Object.entries(timeByIssue)
    .filter(([, seconds]) => seconds >= MIN_SYNC_SECONDS)
    .map(([issueKey, seconds]) => ({
      issueKey,
      timeTracked: Math.round(seconds),
      lastWorkedOn: lastWorkedByIssue[issueKey]
    }));
}

/**
 * Clean up orphaned worklog mappings for a user
 * @param {Object} supabaseConfig - Supabase configuration
 * @param {string} organizationId - Organization ID
 * @param {string} userId - User ID
 * @param {Set} activeIssueKeys - Set of currently active issue keys
 */
async function cleanupOrphanedUserWorklogs(supabaseConfig, organizationId, userId, activeIssueKeys) {
  try {
    // eslint-disable-next-line deprecation/deprecation
    const allMappings = await supabaseRequest(
      supabaseConfig,
      `worklog_sync?organization_id=eq.${organizationId}&user_id=eq.${userId}&select=id,issue_key,jira_worklog_id`
    ) || [];

    const orphaned = allMappings.filter(m => !activeIssueKeys.has(m.issue_key));
    for (const orphan of orphaned) {
      try {
        let deleteResp = await deleteJiraWorklog(orphan.issue_key, orphan.jira_worklog_id);

        if (deleteResp.status === 403) {
          // User lacks DELETE_ALL_WORKLOGS — retry as app (which owns the worklog)
          console.log(`[UserSync] Cleanup: user delete 403 for ${orphan.issue_key}, retrying as app`);
          deleteResp = await deleteJiraWorklogAsApp(orphan.issue_key, orphan.jira_worklog_id);
        }

        if (deleteResp.status === 204 || deleteResp.status === 404) {
          // Worklog deleted (or already gone) — safe to remove mapping
          // eslint-disable-next-line deprecation/deprecation
          await supabaseRequest(supabaseConfig, `worklog_sync?id=eq.${orphan.id}`, { method: 'DELETE' });
        } else {
          // Delete failed — keep the mapping so we can retry next session
          console.warn(`[UserSync] Cleanup: delete HTTP ${deleteResp.status} for ${orphan.issue_key}, keeping mapping`);
        }
      } catch (err) {
        console.error(`[UserSync] Cleanup error for ${orphan.issue_key}:`, err.message);
      }
    }
  } catch (err) {
    console.error('[UserSync] Cleanup failed:', err.message);
  }
}

/**
 * Sync the CURRENT USER's tracked time to Jira worklogs.
 *
 * This runs in the user's live Jira session (api.asUser() with no accountId arg),
 * so Jira records the worklog author as the actual user — not the app.
 *
 * Key behaviour:
 *  - If an existing worklog was created by the app (created_as_user = FALSE),
 *    it is deleted and recreated under the user's real name.
 *  - If time hasn't changed since the last sync, the entry is skipped.
 *  - Orphaned worklog mappings (time reassigned away) are cleaned up.
 *
 * Called from the syncMyWorklogs resolver whenever the user opens the
 * project page (with a 15-minute client-side cooldown).
 *
 * @param {string} accountId - Current user's Atlassian account ID
 * @param {string} cloudId   - Jira Cloud ID
 * @returns {Promise<{success: boolean, synced?: number, errors?: number, error?: string, message?: string}>}
 */
export async function syncCurrentUserWorklogs(accountId, cloudId) {
  // eslint-disable-next-line deprecation/deprecation
  const supabaseConfig = await getSupabaseConfig(accountId);
  if (!supabaseConfig) {
    return { success: false, error: 'Supabase not configured' };
  }

  // Check if worklog sync is enabled for this org
  const organization = await getOrCreateOrganization(cloudId, supabaseConfig);
  if (!organization) {
    return { success: false, error: 'Organization not found' };
  }
  const organizationId = organization.id;

  // eslint-disable-next-line deprecation/deprecation
  const syncSettings = await supabaseRequest(
    supabaseConfig,
    `tracking_settings?organization_id=eq.${organizationId}&jira_worklog_sync_enabled=eq.true&select=id&limit=1`
  );
  if (!syncSettings || syncSettings.length === 0) {
    return { success: true, synced: 0, errors: 0, message: 'Worklog sync not enabled' };
  }

  const userId = await getOrCreateUser(accountId, supabaseConfig, organizationId);
  if (!userId) {
    return { success: false, error: 'User not found' };
  }

  // Aggregate tracked time for this user across all issues
  const entries = await aggregateUserTrackedTime(supabaseConfig, organizationId, userId);

  // Fetch existing worklog_sync mappings for this user
  let existingMappings = [];
  if (entries.length > 0) {
    const issueKeys = entries.map(e => e.issueKey).filter(isValidIssueKey);
    if (issueKeys.length > 0) {
      // eslint-disable-next-line deprecation/deprecation
      existingMappings = await supabaseRequest(
        supabaseConfig,
        `worklog_sync?organization_id=eq.${organizationId}&user_id=eq.${userId}&issue_key=in.(${issueKeys.join(',')})&select=id,issue_key,jira_worklog_id,last_synced_seconds,created_as_user`
      ) || [];
    }
  }

  const mappingByKey = {};
  existingMappings.forEach(m => { mappingByKey[m.issue_key] = m; });

  let synced = 0;
  let errors = 0;

  for (const entry of entries) {
    try {
      const didSync = await syncSingleEntryAsCurrentUser(
        supabaseConfig, organizationId, userId, entry, mappingByKey[entry.issueKey]
      );
      if (didSync) synced++;
    } catch (err) {
      console.error(`[UserSync] Error on ${entry.issueKey}:`, err.message);
      errors++;
    }
  }

  // Cleanup orphaned mappings for this user (time reassigned away from issue)
  const activeIssueKeys = new Set(entries.map(e => e.issueKey));
  await cleanupOrphanedUserWorklogs(supabaseConfig, organizationId, userId, activeIssueKeys);

  console.log(`[UserSync] Done for user ${userId}. Synced: ${synced}, Errors: ${errors}`);
  return { success: true, synced, errors };
}

/**
 * Migrate an app-authored worklog to user-authored
 * @param {string} issueKey - Issue key
 * @param {string} worklogId - Jira worklog ID
 * @param {string} mappingId - Database mapping ID
 * @param {Object} supabaseConfig - Supabase configuration
 * @returns {Promise<boolean>} true if migration succeeded
 */
async function migrateAppWorklogToUser(issueKey, worklogId, mappingId, supabaseConfig) {
  console.log(`[UserSync] Migrating app-authored worklog for ${issueKey} to user name`);
  let deleteResp = await deleteJiraWorklog(issueKey, worklogId);

  if (deleteResp.status === 403) {
    // User lacks DELETE_ALL_WORKLOGS — the worklog is owned by the app, so delete as app
    console.log(`[UserSync] User delete returned 403 for ${issueKey}, retrying as app`);
    deleteResp = await deleteJiraWorklogAsApp(issueKey, worklogId);
  }

  if (deleteResp.status !== 204 && deleteResp.status !== 404) {
    // Still cannot delete — leave as-is and retry next session
    console.warn(`[UserSync] Cannot migrate ${issueKey}: delete returned HTTP ${deleteResp.status}`);
    return false;
  }

  // eslint-disable-next-line deprecation/deprecation
  await supabaseRequest(supabaseConfig, `worklog_sync?id=eq.${mappingId}`, { method: 'DELETE' });
  return true;
}

/**
 * Update existing user-created worklog
 * @param {string} issueKey - Issue key
 * @param {string} worklogId - Jira worklog ID
 * @param {number} timeTracked - Time tracked in seconds
 * @param {string} mappingId - Database mapping ID
 * @param {Object} supabaseConfig - Supabase configuration
 * @returns {Promise<boolean>} true if update succeeded
 */
async function updateExistingWorklog(issueKey, worklogId, timeTracked, mappingId, supabaseConfig) {
  const updateResp = await updateJiraWorklog(issueKey, worklogId, timeTracked);

  if (updateResp.status === 200) {
    // eslint-disable-next-line deprecation/deprecation
    await supabaseRequest(
      supabaseConfig,
      `worklog_sync?id=eq.${mappingId}`,
      { method: 'PATCH', body: { last_synced_seconds: timeTracked, updated_at: new Date().toISOString() } }
    );
    console.log(`[UserSync] Updated ${issueKey}: ${timeTracked}s`);
    return true;
  }

  if (updateResp.status === 404) {
    // Stale mapping, delete it
    // eslint-disable-next-line deprecation/deprecation
    await supabaseRequest(supabaseConfig, `worklog_sync?id=eq.${mappingId}`, { method: 'DELETE' });
    return false; // Will fall through to recreate
  }

  console.error(`[UserSync] Update failed for ${issueKey}: HTTP ${updateResp.status}`);
  return false;
}

/**
 * Create new worklog in user context
 * @param {string} issueKey - Issue key
 * @param {number} timeTracked - Time tracked in seconds
 * @param {string} startedAt - Jira-formatted start time
 * @param {Object} supabaseConfig - Supabase configuration
 * @param {string} organizationId - Organization ID
 * @param {string} userId - User ID
 * @returns {Promise<boolean>} true if creation succeeded
 */
async function createUserWorklog(issueKey, timeTracked, startedAt, supabaseConfig, organizationId, userId) {
  const worklogResult = await createJiraWorklog(issueKey, timeTracked, startedAt);

  if (worklogResult?.id) {
    const now = new Date().toISOString();
    // eslint-disable-next-line deprecation/deprecation
    await supabaseRequest(
      supabaseConfig,
      'worklog_sync',
      {
        method: 'POST',
        body: {
          organization_id: organizationId,
          user_id: userId,
          issue_key: issueKey,
          jira_worklog_id: String(worklogResult.id),
          last_synced_seconds: timeTracked,
          started_at: startedAt,
          created_as_user: true,  // Created in interactive user context
          created_at: now,
          updated_at: now
        }
      }
    );
    console.log(`[UserSync] Created worklog for ${issueKey}: ${timeTracked}s`);
    return true;
  }

  if (worklogResult?.errorMessages?.length > 0) {
    console.warn(`[UserSync] Skipping ${issueKey}: ${worklogResult.errorMessages.join(', ')}`);
    return false;
  }

  throw new Error(`Failed to create worklog for ${issueKey}: ${JSON.stringify(worklogResult)}`);
}

/**
 * Sync a single issue entry for the current user.
 * Uses api.asUser() (no accountId) — the live Jira session — so the worklog
 * author is the real user, not the app.
 */
async function syncSingleEntryAsCurrentUser(supabaseConfig, organizationId, userId, entry, existingMapping) {
  const { issueKey, timeTracked, lastWorkedOn } = entry;
  const startedAt = formatJiraDate(lastWorkedOn ? new Date(lastWorkedOn) : new Date());

  if (existingMapping) {
    // Worklog was created by the app (scheduled trigger) — delete and recreate as user
    if (existingMapping.created_as_user === false) {
      const migrated = await migrateAppWorklogToUser(
        issueKey,
        existingMapping.jira_worklog_id,
        existingMapping.id,
        supabaseConfig
      );
      if (!migrated) {
        return false; // Migration failed, retry next session
      }
      // Fall through to create fresh worklog as user
    } else if (existingMapping.last_synced_seconds === timeTracked) {
      return false; // No change, skip
    } else {
      // Update existing user-created worklog
      const updated = await updateExistingWorklog(
        issueKey,
        existingMapping.jira_worklog_id,
        timeTracked,
        existingMapping.id,
        supabaseConfig
      );
      if (updated) {
        return true;
      }
      // If update returned false (404), fall through to recreate
    }
  }

  // Create new worklog in the user's live session
  return await createUserWorklog(issueKey, timeTracked, startedAt, supabaseConfig, organizationId, userId);
}
