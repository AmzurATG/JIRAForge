/**
 * Scheduled Worklog Sync
 * Runs on a Forge scheduled trigger to sync all users' tracked time to Jira worklogs.
 *
 * Uses api.asUser(accountId) (offline impersonation) so worklogs appear with each user's
 * name. When impersonation fails or doesn't take effect, saves a pending record
 * (jira_worklog_id = NULL, created_as_user = false) instead of falling back to asApp().
 * The user-context sync (syncMyWorklogs) picks up pending records and creates the
 * worklog under the user's real name when they next open the app.
 */

import {
  createJiraWorklogAsUser,
  createJiraWorklogAsApp,
  updateJiraWorklogAsUser,
  updateJiraWorklogAsApp,
  deleteJiraWorklogAsUser,
  deleteJiraWorklogAsApp
} from '../utils/jira.js';
// eslint-disable-next-line deprecation/deprecation
import { getSupabaseConfig, supabaseRequest } from '../utils/supabase.js';
import { formatJiraDate } from '../utils/formatters.js';
import { isValidIssueKey } from '../utils/validators.js';

const SYNC_BATCH_LIMIT = 10; // Max issues per user per run
const MIN_SYNC_SECONDS = 60;
const PENDING_WORKLOG_ID = 'PENDING'; // Sentinel for worklog_sync rows awaiting user-context sync

/**
 * Format a DB timestamp for Jira's worklog `started` field.
 * Timestamps are stored as proper UTC, so we parse and format via formatJiraDate.
 */
function formatStartedForJira(timestamp) {
  if (!timestamp) return formatJiraDate();
  return formatJiraDate(new Date(timestamp));
}

/**
 * Build a map of project-level sync settings per organization.
 * @param {Array} allSettings - All tracking_settings records
 * @returns {Object} Map: { orgId: { orgEnabled: boolean, projects: { projectKey: boolean } } }
 */
function buildProjectSyncMap(allSettings) {
  const syncMap = {};

  for (const setting of allSettings) {
    const orgId = setting.organization_id;
    if (!orgId) continue;

    if (!syncMap[orgId]) {
      syncMap[orgId] = { orgEnabled: false, projects: {} };
    }

    if (setting.project_key) {
      // Project-level setting
      syncMap[orgId].projects[setting.project_key] = setting.jira_worklog_sync_enabled === true;
    } else {
      // Org-level setting (project_key is NULL)
      syncMap[orgId].orgEnabled = setting.jira_worklog_sync_enabled === true;
    }
  }

  return syncMap;
}

/**
 * Get list of projects to exclude from sync for an organization.
 * A project is excluded if:
 * - Org sync is enabled but project explicitly disabled
 * @param {Object} orgSyncConfig - The org's sync configuration from buildProjectSyncMap
 * @returns {Array<string>} Array of project keys to exclude
 */
function getExcludedProjects(orgSyncConfig) {
  if (!orgSyncConfig || !orgSyncConfig.orgEnabled) return [];
  
  const excluded = [];
  for (const [projectKey, enabled] of Object.entries(orgSyncConfig.projects)) {
    if (!enabled) {
      excluded.push(projectKey);
    }
  }
  return excluded;
}

/**
 * Get list of projects explicitly enabled for sync when org-level is disabled.
 * @param {Object} orgSyncConfig - The org's sync configuration from buildProjectSyncMap
 * @returns {Array<string>} Array of project keys to include (when org disabled)
 */
function getExplicitlyEnabledProjects(orgSyncConfig) {
  if (!orgSyncConfig || orgSyncConfig.orgEnabled) return [];
  
  const enabled = [];
  for (const [projectKey, isEnabled] of Object.entries(orgSyncConfig.projects)) {
    if (isEnabled) {
      enabled.push(projectKey);
    }
  }
  return enabled;
}

/**
 * Resolve the correct organization ID for activity_records.
 * The tracking_settings may reference a different org ID than what the desktop
 * app uses for activity_records (duplicate org problem). When the settings org
 * has no data, look up the org's jira_cloud_id and find the sibling org that
 * actually contains activity records.
 * @returns {Promise<string>} The organization ID to use for querying activity_records
 */
async function resolveActivityOrgId(supabaseConfig, settingsOrgId) {
  // Quick check: does the settings org have any activity records?
  // eslint-disable-next-line deprecation/deprecation
  const probe = await supabaseRequest(
    supabaseConfig,
    `activity_records?organization_id=eq.${settingsOrgId}&select=id&limit=1`
  );
  if (probe && probe.length > 0) {
    return settingsOrgId; // Settings org has data — no mismatch
  }

  // Settings org has no data — look up its jira_cloud_id
  console.warn(`[ScheduledSync] Org ${settingsOrgId} has no activity_records, checking for sibling orgs...`);
  // eslint-disable-next-line deprecation/deprecation
  const settingsOrg = await supabaseRequest(
    supabaseConfig,
    `organizations?id=eq.${settingsOrgId}&select=id,jira_cloud_id&limit=1`
  );
  const cloudId = settingsOrg?.[0]?.jira_cloud_id;
  if (!cloudId) {
    console.warn(`[ScheduledSync] Could not find jira_cloud_id for org ${settingsOrgId}, checking all activity orgs...`);
    // Org doesn't exist in organizations table — fall through to broad search
    // eslint-disable-next-line deprecation/deprecation
    const anyRecords = await supabaseRequest(
      supabaseConfig,
      `activity_records?select=organization_id&limit=10`
    );
    const otherOrgIds = [...new Set((anyRecords || []).map(r => r.organization_id))];
    if (otherOrgIds.length === 1) {
      console.warn(`[ScheduledSync] Org mismatch: settings=${settingsOrgId}, activity_records=${otherOrgIds[0]} — using activity org`);
      return otherOrgIds[0];
    }
    if (otherOrgIds.length > 1) {
      console.warn(`[ScheduledSync] Multiple orgs with data: ${JSON.stringify(otherOrgIds)} — cannot auto-resolve`);
    }
    return settingsOrgId;
  }

  // Find ALL orgs with this jira_cloud_id (handles duplicates)
  // eslint-disable-next-line deprecation/deprecation
  const siblingOrgs = await supabaseRequest(
    supabaseConfig,
    `organizations?jira_cloud_id=eq.${cloudId}&select=id`
  );
  if (!siblingOrgs || siblingOrgs.length <= 1) {
    // No siblings — check if ANY org has data (desktop app might use a different cloud_id)
    // eslint-disable-next-line deprecation/deprecation
    const anyRecords = await supabaseRequest(
      supabaseConfig,
      `activity_records?select=organization_id&limit=10`
    );
    const otherOrgIds = [...new Set((anyRecords || []).map(r => r.organization_id))];
    if (otherOrgIds.length === 1) {
      console.warn(`[ScheduledSync] Org mismatch: settings=${settingsOrgId}, activity_records=${otherOrgIds[0]} — using activity org`);
      return otherOrgIds[0];
    }
    console.warn(`[ScheduledSync] Multiple or no orgs with data: ${JSON.stringify(otherOrgIds)}`);
    return settingsOrgId;
  }

  // Check which sibling has activity records
  for (const sibling of siblingOrgs) {
    if (sibling.id === settingsOrgId) continue;
    // eslint-disable-next-line deprecation/deprecation
    const check = await supabaseRequest(
      supabaseConfig,
      `activity_records?organization_id=eq.${sibling.id}&select=id&limit=1`
    );
    if (check && check.length > 0) {
      console.warn(`[ScheduledSync] Org mismatch: settings=${settingsOrgId}, sibling with data=${sibling.id} — using sibling`);
      return sibling.id;
    }
  }

  return settingsOrgId;
}

/**
 * Main entry point for the scheduled trigger.
 * Iterates over all organizations and users, syncing worklogs for each.
 * Supports project-level sync configuration.
 */
export async function runScheduledWorklogSync() {
  console.log('[ScheduledSync] Starting scheduled worklog sync');

  try {
    // eslint-disable-next-line deprecation/deprecation
    const supabaseConfig = await getSupabaseConfig();

    // Fetch ALL tracking settings (org-level and project-level)
    // eslint-disable-next-line deprecation/deprecation
    const allSettings = await supabaseRequest(
      supabaseConfig,
      'tracking_settings?select=organization_id,project_key,jira_worklog_sync_enabled'
    );

    if (!allSettings || allSettings.length === 0) {
      console.log('[ScheduledSync] No tracking settings found, skipping');
      return { success: true, message: 'No tracking settings configured' };
    }

    // Build project sync map for all organizations
    const projectSyncMap = buildProjectSyncMap(allSettings);

    // Find organizations that need sync (either org-enabled or have project-level enables)
    const orgsToSync = [];
    for (const [orgId, config] of Object.entries(projectSyncMap)) {
      if (config.orgEnabled) {
        orgsToSync.push(orgId);
      } else {
        // Check if any project is explicitly enabled
        const explicitlyEnabled = getExplicitlyEnabledProjects(config);
        if (explicitlyEnabled.length > 0) {
          orgsToSync.push(orgId);
        }
      }
    }

    if (orgsToSync.length === 0) {
      console.log('[ScheduledSync] No organizations have worklog sync enabled, skipping');
      return { success: true, message: 'Sync not enabled for any organization' };
    }

    console.log(`[ScheduledSync] Found ${orgsToSync.length} organizations with sync enabled`);

    let totalSynced = 0;
    let totalErrors = 0;

    for (const orgId of orgsToSync) {
      try {
        const orgConfig = projectSyncMap[orgId];
        const result = await syncOrganization(supabaseConfig, orgId, orgConfig);
        totalSynced += result.synced;
        totalErrors += result.errors;
      } catch (orgError) {
        console.error(`[ScheduledSync] Failed to sync org ${orgId}:`, orgError.message);
        totalErrors++;
      }
    }

    console.log(`[ScheduledSync] Completed. Synced: ${totalSynced}, Errors: ${totalErrors}`);
    return { success: true, synced: totalSynced, errors: totalErrors };
  } catch (error) {
    console.error('[ScheduledSync] Fatal error:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Aggregate time tracked per user/issue from activity_records.
 * Uses the new interval-based tracking table instead of screenshot-based analysis_results.
 * Supports project-level filtering for sync settings.
 * @param {Object} supabaseConfig - Supabase configuration
 * @param {string} organizationId - Organization ID
 * @param {Object} projectFilter - Optional project filter { excludedProjects: [], onlyProjects: [] }
 * @returns {Promise<Object>} Object with timeByUserIssue and lastWorkedByUserIssue maps
 */
async function aggregateTrackedTime(supabaseConfig, organizationId, projectFilter = {}) {
  const PAGE_SIZE = 1000;
  const timeByUserIssue = {};
  const lastWorkedByUserIssue = {};
  let offset = 0;
  let totalFetched = 0;

  // Diagnostic: count ALL records for this org to detect data/filter mismatches
  try {
    // eslint-disable-next-line deprecation/deprecation
    const allCount = await supabaseRequest(
      supabaseConfig,
      `activity_records?organization_id=eq.${organizationId}&status=in.(pending,processing,analyzed)&select=id,user_assigned_issue_key,classification&limit=5`
    );
    const total = allCount?.length ?? 0;
    const withIssueKey = (allCount || []).filter(r => r.user_assigned_issue_key).length;
    const classifications = [...new Set((allCount || []).map(r => r.classification))];
    console.log(`[ScheduledSync] Diagnostic for org ${organizationId}: sample=${total}, withIssueKey=${withIssueKey}, classifications=${JSON.stringify(classifications)}`);

    if (total === 0) {
      // org_id returns nothing — check if there are ANY records at all (across all orgs)
      // eslint-disable-next-line deprecation/deprecation
      const anyRecords = await supabaseRequest(
        supabaseConfig,
        `activity_records?status=in.(pending,processing,analyzed)&select=organization_id&limit=10`
      );
      const orgIds = [...new Set((anyRecords || []).map(r => r.organization_id))];
      console.warn(`[ScheduledSync] ZERO records for org ${organizationId}! Other org_ids with data: ${JSON.stringify(orgIds)}`);
    }

    if (total > 0 && withIssueKey === 0) {
      console.warn(`[ScheduledSync] All records have NULL user_assigned_issue_key — worklog sync needs fallback matching`);
    }
  } catch (diagErr) {
    console.warn(`[ScheduledSync] Diagnostic query failed:`, diagErr.message);
  }

  // Build project filter clause for the query
  let projectClause = '';
  if (projectFilter.excludedProjects && projectFilter.excludedProjects.length > 0) {
    // Exclude specific projects (org enabled, but these projects disabled)
    const excluded = projectFilter.excludedProjects.join(',');
    projectClause = `&project_key=not.in.(${excluded})`;
    console.log(`[ScheduledSync] Excluding projects: ${excluded}`);
  } else if (projectFilter.onlyProjects && projectFilter.onlyProjects.length > 0) {
    // Only include specific projects (org disabled, but these projects enabled)
    const only = projectFilter.onlyProjects.join(',');
    projectClause = `&project_key=in.(${only})`;
    console.log(`[ScheduledSync] Only syncing projects: ${only}`);
  }

  while (true) {
    // Query activity_records — fetch ALL records (with and without user_assigned_issue_key).
    // Records without an assigned issue key are aggregated by project_key for
    // later fallback matching by the interactive sync path.
    // eslint-disable-next-line deprecation/deprecation
    const page = await supabaseRequest(
      supabaseConfig,
      `activity_records?organization_id=eq.${organizationId}&status=in.(pending,processing,analyzed)&classification=in.(productive,unknown)${projectClause}&select=user_id,user_assigned_issue_key,project_key,duration_seconds,total_time_seconds,end_time&order=created_at.desc&limit=${PAGE_SIZE}&offset=${offset}`
    );

    if (!page || !Array.isArray(page) || page.length === 0) {
      break;
    }

    page.forEach(entry => {
      const issueKey = entry.user_assigned_issue_key;
      if (!issueKey) return; // Skip unassigned records — handled by interactive sync fallback
      const key = `${entry.user_id}::${issueKey}`;
      if (!timeByUserIssue[key]) {
        timeByUserIssue[key] = 0;
        lastWorkedByUserIssue[key] = null;
      }
      // Use duration_seconds or total_time_seconds (whichever is available)
      timeByUserIssue[key] += entry.duration_seconds || entry.total_time_seconds || 0;
      const ts = entry.end_time;
      if (ts && (!lastWorkedByUserIssue[key] || ts > lastWorkedByUserIssue[key])) {
        lastWorkedByUserIssue[key] = ts;
      }
    });

    totalFetched += page.length;
    offset += page.length;

    // Stop if we got fewer results than page size (last page)
    if (page.length < PAGE_SIZE) {
      break;
    }

    // Safety limit to prevent infinite loops
    if (totalFetched > 50000) {
      console.warn(`[ScheduledSync] Safety limit reached (50000 records) for org ${organizationId}`);
      break;
    }
  }

  if (totalFetched === 0) {
    console.log(`[ScheduledSync] No time data for org ${organizationId}`);
  } else {
    const issueCount = Object.keys(timeByUserIssue).length;
    console.log(`[ScheduledSync] Fetched ${totalFetched} records for org ${organizationId}, ${issueCount} user-issue pairs with assigned issue keys`);
  }

  return { timeByUserIssue, lastWorkedByUserIssue };
}

/**
 * Sync all users' worklogs for a single organization.
 * Supports project-level sync configuration.
 * @param {Object} supabaseConfig - Supabase configuration
 * @param {string} organizationId - Organization ID
 * @param {Object} orgConfig - Project sync configuration { orgEnabled: boolean, projects: {} }
 */
async function syncOrganization(supabaseConfig, organizationId, orgConfig = { orgEnabled: true, projects: {} }) {
  // Resolve the correct org ID for activity_records (handles duplicate org problem
  // where tracking_settings and activity_records reference different org UUIDs)
  const activityOrgId = await resolveActivityOrgId(supabaseConfig, organizationId);

  // Determine project filter based on org and project-level settings
  let projectFilter = {};
  
  if (orgConfig.orgEnabled) {
    // Org sync is enabled - exclude any explicitly disabled projects
    const excludedProjects = getExcludedProjects(orgConfig);
    if (excludedProjects.length > 0) {
      projectFilter = { excludedProjects };
      console.log(`[ScheduledSync] Org ${organizationId}: sync enabled, excluding ${excludedProjects.length} projects`);
    }
  } else {
    // Org sync is disabled - only sync explicitly enabled projects
    const onlyProjects = getExplicitlyEnabledProjects(orgConfig);
    if (onlyProjects.length === 0) {
      console.log(`[ScheduledSync] Org ${organizationId}: sync disabled and no projects enabled, skipping`);
      return { synced: 0, errors: 0 };
    }
    projectFilter = { onlyProjects };
    console.log(`[ScheduledSync] Org ${organizationId}: sync disabled, only syncing ${onlyProjects.length} projects`);
  }

  // Fetch activity_records using the resolved org ID (may differ from tracking_settings org)
  const { timeByUserIssue, lastWorkedByUserIssue } = await aggregateTrackedTime(supabaseConfig, activityOrgId, projectFilter);

  // Build list of {userId, issueKey, timeTracked, lastWorkedOn}
  // Build entries from aggregated time. Round up sub-60s totals to Jira's
  // minimum instead of discarding — prevents silent time loss. The aggregation
  // already sums all records per user+issue, so this rounding applies only to
  // the final total (max 59s inflation per issue, not per record).
  const entries = Object.entries(timeByUserIssue)
    .filter(([, seconds]) => seconds > 0)
    .map(([key, seconds]) => {
      const [userId, issueKey] = key.split('::');
      const rounded = Math.round(seconds);
      return {
        userId,
        issueKey,
        timeTracked: rounded < MIN_SYNC_SECONDS ? MIN_SYNC_SECONDS : rounded,
        lastWorkedOn: lastWorkedByUserIssue[key]
      };
    });

  let synced = 0;
  let errors = 0;

  // Sync active entries (skip if none above minimum threshold)
  if (entries.length > 0) {
    const userIds = [...new Set(entries.map(e => e.userId))];

    // Process per user (batch limit applies per user)
    for (const userId of userIds) {
      const userEntries = entries
        .filter(e => e.userId === userId)
        .slice(0, SYNC_BATCH_LIMIT);

      try {
        const result = await syncUserIssues(supabaseConfig, organizationId, userId, userEntries);
        synced += result.synced;
        errors += result.errors;
      } catch (userError) {
        console.error(`[ScheduledSync] Failed for user ${userId}:`, userError.message);
        errors++;
      }
    }
  }

  // Always cleanup orphaned worklogs (time reassigned away or dropped below minimum)
  try {
    await cleanupOrphanedWorklogs(supabaseConfig, organizationId, entries);
  } catch (cleanupError) {
    console.error(`[ScheduledSync] Cleanup failed for org ${organizationId}:`, cleanupError.message);
  }

  return { synced, errors };
}

/**
 * Sync a single user's issues to Jira worklogs.
 */
async function syncUserIssues(supabaseConfig, organizationId, userId, entries) {
  // Fetch user's Atlassian account ID and display name.
  // accountId is used for api.asUser(accountId) impersonation (may not affect authorship in
  // scheduled trigger context — see syncCurrentUserWorklogs for the reliable user-context path).
  // displayName is embedded in the worklog comment so the person is identifiable even when
  // the Jira worklog author shows as the app.
  // eslint-disable-next-line deprecation/deprecation
  const userRows = await supabaseRequest(
    supabaseConfig,
    `users?id=eq.${userId}&select=atlassian_account_id,display_name&limit=1`
  );
  const accountId = userRows?.[0]?.atlassian_account_id || null;
  const displayName = userRows?.[0]?.display_name || null;
  if (!accountId) {
    console.warn(`[ScheduledSync] No atlassian_account_id for user ${userId} — worklogs will show as app`);
  }

  // Fetch existing mappings for this user (include created_as_user for migration detection)
  const issueKeys = entries.map(e => e.issueKey).filter(isValidIssueKey);
  const keysList = issueKeys.join(',');
  // eslint-disable-next-line deprecation/deprecation
  const existingMappings = keysList
    ? await supabaseRequest(
        supabaseConfig,
        `worklog_sync?organization_id=eq.${organizationId}&user_id=eq.${userId}&issue_key=in.(${keysList})&select=id,issue_key,jira_worklog_id,last_synced_seconds,created_as_user`
      )
    : [];

  const mappingByKey = {};
  if (existingMappings && Array.isArray(existingMappings)) {
    existingMappings.forEach(m => { mappingByKey[m.issue_key] = m; });
  }

  let synced = 0;
  let errors = 0;

  for (const entry of entries) {
    try {
      const mapping = mappingByKey[entry.issueKey];
      const didSync = await syncSingleEntry(supabaseConfig, organizationId, userId, accountId, displayName, entry, mapping);
      if (didSync) synced++;
    } catch (err) {
      console.error(`[ScheduledSync] Error syncing ${entry.issueKey} for user ${userId}:`, err.message);
      errors++;
    }
  }

  return { synced, errors };
}

/**
 * Sync a single user+issue entry to Jira via the scheduled trigger.
 * Uses api.asUser(accountId) when available (offline impersonation), but in
 * scheduled trigger context Jira may still record the author as the app.
 * The displayName is embedded in the worklog comment as a fallback identifier.
 * @returns {Promise<boolean>} true if an actual Jira API call was made
 */
async function syncSingleEntry(supabaseConfig, organizationId, userId, accountId, displayName, entry, existingMapping) {
  const { issueKey, timeTracked, lastWorkedOn } = entry;

  if (existingMapping) {
    // Never touch user-authored worklogs from the scheduled trigger.
    // The interactive syncMyWorklogs path owns these — it runs in the user's
    // live session and can update/recreate with proper user attribution.
    if (existingMapping.created_as_user === true) {
      if (existingMapping.last_synced_seconds === timeTracked) {
        return false; // No change
      }
      // Time changed but worklog was created as user — still skip.
      // The interactive sync will pick this up on the user's next visit.
      console.log(`[ScheduledSync] Skipping ${issueKey} for user ${userId} — worklog is user-authored (created_as_user=true), deferring to interactive sync`);
      return false;
    }

    // Pending record (no Jira worklog yet) — create via asApp now, regardless of time change
    if (!existingMapping.jira_worklog_id || existingMapping.jira_worklog_id === PENDING_WORKLOG_ID) {
      console.log(`[ScheduledSync] Converting pending record ${issueKey} for user ${userId} to real worklog via asApp`);
      try {
        const startedAt = formatStartedForJira(lastWorkedOn);
        const result = await createJiraWorklogAsApp(issueKey, timeTracked, startedAt, displayName);
        if (result?.id) {
          // eslint-disable-next-line deprecation/deprecation
          await supabaseRequest(
            supabaseConfig,
            `worklog_sync?id=eq.${existingMapping.id}`,
            { method: 'PATCH', body: {
              jira_worklog_id: String(result.id),
              last_synced_seconds: timeTracked,
              created_as_user: false,
              updated_at: new Date().toISOString()
            } }
          );
          console.log(`[ScheduledSync] Converted pending → worklog ${result.id} for ${issueKey}: ${timeTracked}s`);
          return true;
        }
      } catch (appErr) {
        console.error(`[ScheduledSync] Failed to convert pending for ${issueKey}:`, appErr.message);
        return false;
      }
      return false;
    }

    if (existingMapping.last_synced_seconds === timeTracked) {
      return false; // No change for non-pending record
    }

    // Try to update existing worklog (as user when possible, else as app)
    let updateResponse;
    if (accountId) {
      try {
        updateResponse = await updateJiraWorklogAsUser(accountId, issueKey, existingMapping.jira_worklog_id, timeTracked);
      } catch (impersonationErr) {
        if (impersonationErr.message?.includes('AUTH_TYPE_UNAVAILABLE')) {
          console.warn(`[ScheduledSync] asUser unavailable for update ${issueKey}, falling back to asApp`);
          updateResponse = await updateJiraWorklogAsApp(issueKey, existingMapping.jira_worklog_id, timeTracked);
        } else {
          throw impersonationErr;
        }
      }
    } else {
      updateResponse = await updateJiraWorklogAsApp(issueKey, existingMapping.jira_worklog_id, timeTracked);
    }

    if (updateResponse.status === 200) {
      // eslint-disable-next-line deprecation/deprecation
      await supabaseRequest(
        supabaseConfig,
        `worklog_sync?id=eq.${existingMapping.id}`,
        { method: 'PATCH', body: { last_synced_seconds: timeTracked, updated_at: new Date().toISOString() } }
      );
      console.log(`[ScheduledSync] Updated ${issueKey} for user ${userId}: ${timeTracked}s`);
      return true;
    }

    if (updateResponse.status === 404) {
      // Stale mapping — delete and re-create
      // eslint-disable-next-line deprecation/deprecation
      await supabaseRequest(
        supabaseConfig,
        `worklog_sync?id=eq.${existingMapping.id}`,
        { method: 'DELETE' }
      );
    } else {
      console.error(`[ScheduledSync] Update failed for ${issueKey}: HTTP ${updateResponse.status}`);
      return false;
    }
  }

  // Create new worklog — format date for Jira (requires yyyy-MM-dd'T'HH:mm:ss.SSS+0000)
  // Uses formatStartedForJira to format the UTC timestamp from the DB into Jira's expected format
  const startedAt = formatStartedForJira(lastWorkedOn);
  let worklogResult;
  let usedAsUser = false;
  if (accountId) {
    try {
      worklogResult = await createJiraWorklogAsUser(accountId, issueKey, timeTracked, startedAt, displayName);
      usedAsUser = true;
      console.log(`[ScheduledSync] asUser(${accountId}) call succeeded for ${issueKey}`);
    } catch (impersonationErr) {
      console.error(`[ScheduledSync] asUser(${accountId}) failed for ${issueKey}:`,
        impersonationErr.message,
        impersonationErr.name,
        impersonationErr.status || 'no-status');
      if (impersonationErr.message?.includes('AUTH_TYPE_UNAVAILABLE')) {
        // Impersonation not available — fall back to asApp() so time is visible
        // in Jira immediately. The worklog comment includes the user's display
        // name for identification even though the author shows as the app.
        console.warn(`[ScheduledSync] asUser unavailable for ${issueKey}, falling back to asApp`);
        try {
          worklogResult = await createJiraWorklogAsApp(issueKey, timeTracked, startedAt, displayName);
          console.log(`[ScheduledSync] Created worklog via asApp for ${issueKey}: ${timeTracked}s`);
        } catch (appErr) {
          console.error(`[ScheduledSync] asApp also failed for ${issueKey}:`, appErr.message);
          throw appErr;
        }
      } else {
        throw impersonationErr;
      }
    }
  } else {
    // No accountId — create via asApp with display name in comment
    console.warn(`[ScheduledSync] No accountId for ${issueKey}, creating via asApp`);
    worklogResult = await createJiraWorklogAsApp(issueKey, timeTracked, startedAt, displayName);
  }

  if (worklogResult?.id) {
    // Check if impersonation actually worked by comparing the worklog author
    // to the intended user. Jira returns author.accountId in the response.
    const actuallyCreatedAsUser = usedAsUser &&
      worklogResult.author?.accountId === accountId;

    if (usedAsUser && !actuallyCreatedAsUser) {
      // Impersonation didn't take effect — worklog created by app. Keep it so
      // time is visible in Jira. The worklog comment includes the user's
      // display name for identification.
      console.warn(`[ScheduledSync] Impersonation did not take effect for ${issueKey} — keeping app-authored worklog (author: ${worklogResult.author?.displayName || 'app'})`);
    }

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
          created_as_user: actuallyCreatedAsUser,
          created_at: now,
          updated_at: now
        }
      }
    );
    console.log(`[ScheduledSync] Created worklog for ${issueKey} user ${userId}: ${timeTracked}s (as_user: ${actuallyCreatedAsUser})`);
    return true;
  }

  // Jira returned an error response (issue deleted, no permission, etc.) — skip gracefully
  if (worklogResult?.errorMessages?.length > 0) {
    console.warn(`[ScheduledSync] Skipping ${issueKey} — ${worklogResult.errorMessages.join(', ')}`);
    return false;
  }

  throw new Error(`Failed to create worklog: ${JSON.stringify(worklogResult)}`);
}

/**
 * Clean up orphaned worklog_sync mappings.
 * When time is reassigned away from an issue, the mapping becomes stale.
 * This finds mappings with no corresponding tracked time and deletes both
 * the Jira worklog and the mapping row.
 */
async function cleanupOrphanedWorklogs(supabaseConfig, organizationId, activeEntries) {
  // Build a set of active user::issueKey pairs
  const activeKeys = new Set(activeEntries.map(e => `${e.userId}::${e.issueKey}`));

  // Fetch all worklog_sync mappings for this org
  // eslint-disable-next-line deprecation/deprecation
  const allMappings = await supabaseRequest(
    supabaseConfig,
    `worklog_sync?organization_id=eq.${organizationId}&select=id,user_id,issue_key,jira_worklog_id`
  );

  if (!allMappings || !Array.isArray(allMappings) || allMappings.length === 0) {
    return;
  }

  // Find orphaned mappings (no longer have active tracked time)
  const orphaned = allMappings.filter(m => !activeKeys.has(`${m.user_id}::${m.issue_key}`));

  if (orphaned.length === 0) {
    return;
  }

  // Build user_id -> atlassian_account_id map for orphaned users
  const userIds = [...new Set(orphaned.map(m => m.user_id))];
  // eslint-disable-next-line deprecation/deprecation
  const userRows = await supabaseRequest(
    supabaseConfig,
    `users?id=in.(${userIds.join(',')})&select=id,atlassian_account_id`
  );
  const accountIdByUserId = {};
  if (userRows && Array.isArray(userRows)) {
    userRows.forEach(u => { accountIdByUserId[u.id] = u.atlassian_account_id; });
  }

  console.log(`[ScheduledSync] Found ${orphaned.length} orphaned worklog mappings to clean up`);

  for (const mapping of orphaned) {
    try {
      // Pending records (no Jira worklog created yet) — just delete the DB mapping
      if (!mapping.jira_worklog_id || mapping.jira_worklog_id === PENDING_WORKLOG_ID) {
        // eslint-disable-next-line deprecation/deprecation
        await supabaseRequest(
          supabaseConfig,
          `worklog_sync?id=eq.${mapping.id}`,
          { method: 'DELETE' }
        );
        console.log(`[ScheduledSync] Cleaned up pending mapping for ${mapping.issue_key} (user ${mapping.user_id})`);
        continue;
      }

      const accountId = accountIdByUserId[mapping.user_id];
      let deleteResponse;
      if (accountId) {
        try {
          deleteResponse = await deleteJiraWorklogAsUser(accountId, mapping.issue_key, mapping.jira_worklog_id);
        } catch (impersonationErr) {
          if (impersonationErr.message?.includes('AUTH_TYPE_UNAVAILABLE')) {
            console.warn(`[ScheduledSync] asUser unavailable for cleanup ${mapping.issue_key}, falling back to asApp`);
            deleteResponse = await deleteJiraWorklogAsApp(mapping.issue_key, mapping.jira_worklog_id);
          } else {
            throw impersonationErr;
          }
        }
      } else {
        deleteResponse = await deleteJiraWorklogAsApp(mapping.issue_key, mapping.jira_worklog_id);
      }
      if (deleteResponse.status !== 204 && deleteResponse.status !== 404) {
        console.warn(`[ScheduledSync] Failed to delete Jira worklog ${mapping.jira_worklog_id} for ${mapping.issue_key}: HTTP ${deleteResponse.status}`);
      }

      // Delete the mapping row
      // eslint-disable-next-line deprecation/deprecation
      await supabaseRequest(
        supabaseConfig,
        `worklog_sync?id=eq.${mapping.id}`,
        { method: 'DELETE' }
      );
      console.log(`[ScheduledSync] Cleaned up orphaned worklog for ${mapping.issue_key} (user ${mapping.user_id})`);
    } catch (err) {
      console.error(`[ScheduledSync] Cleanup error for ${mapping.issue_key}:`, err.message);
    }
  }
}
