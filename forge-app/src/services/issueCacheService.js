/**
 * Issue Cache Service
 * Handles avi:jira:updated:issue trigger events.
 * When an issue is updated (assignee change, status change, etc.), fetches the
 * affected user's full issue list from Jira and caches it in Supabase via the AI server.
 *
 * This removes the need for the desktop app to call Jira directly for issue fetching.
 */

import api, { route } from '@forge/api';
import { remoteRequest } from '../utils/remote.js';

// Cache ALL assigned issues except completed (Done).
// This broad cache supports project-level status filtering done by the desktop app.
// Different projects may have different tracked_statuses (admin-configured), so the cache
// must be inclusive. The desktop app reads project_settings from Supabase and filters
// the cached issues client-side based on each project's configured tracked_statuses.
// 
// Why not "To Do"? We exclude backlog items (statusCategory = "To Do") because they create
// 87% error rates in AI matching (20:3 noise ratio from bug analysis). Backlog items are
// not active work, so they should never be tracked regardless of project settings.
const CACHE_JQL = 'assignee = currentUser() AND resolution = EMPTY AND statusCategory NOT IN ("To Do", "Done") ORDER BY updated DESC';
const MAX_ISSUES = 50;

/**
 * Main trigger handler for avi:jira:updated:issue events.
 * Called by Forge when any issue is updated.
 * @param {Object} event - Forge event payload
 * @param {Object} context - Forge invocation context
 */
export async function handleIssueUpdateEvent(event, context) {
  try {
    // Collect the set of Atlassian account IDs whose cache needs refreshing.
    // We always refresh the current assignee. If the assignee just changed,
    // we also refresh the previous assignee (who lost the issue).
    const accountsToRefresh = new Set();

    const currentAssigneeId = event.issue?.fields?.assignee?.accountId;
    if (currentAssigneeId) {
      accountsToRefresh.add(currentAssigneeId);
    }

    // Detect assignee change in changelog — refresh old assignee too
    const changelogItems = event.changelog?.items || [];
    for (const item of changelogItems) {
      if (item.field === 'assignee' && item.fromAccountId) {
        accountsToRefresh.add(item.fromAccountId);
      }
    }

    if (accountsToRefresh.size === 0) {
      console.log('[IssueCache] Issue updated but no assignee — skipping cache update');
      return { success: true, skipped: true };
    }

    console.log(`[IssueCache] Refreshing issue cache for ${accountsToRefresh.size} account(s)`);

    const results = [];
    for (const accountId of accountsToRefresh) {
      const result = await refreshCacheForUser(accountId);
      results.push({ accountId, ...result });
    }

    return { success: true, results };
  } catch (error) {
    console.error('[IssueCache] Trigger handler error:', error.message);
    // Do not throw — trigger failures should not block Jira
    return { success: false, error: error.message };
  }
}

/**
 * Fetch a user's current Jira issues and push them to the AI server for caching.
 * Uses api.asUser(accountId) offline impersonation (requires allowImpersonation: true
 * on read:jira-work in manifest.yml — already configured).
 * @param {string} accountId - Atlassian account ID
 */
async function refreshCacheForUser(accountId) {
  try {
    // Fetch user's active issues from Jira using offline impersonation
    const response = await api.asUser(accountId).requestJira(
      route`/rest/api/3/search/jql`,
      {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          jql: CACHE_JQL,
          maxResults: MAX_ISSUES,
          fields: ['summary', 'status', 'project', 'issuetype', 'priority', 'description', 'labels', 'updated']
        })
      }
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[IssueCache] Jira API failed for ${accountId}: ${response.status} — ${errorText}`);
      return { success: false, error: `Jira ${response.status}` };
    }

    const data = await response.json();
    const issues = data.issues || [];

    console.log(`[IssueCache] Fetched ${issues.length} issues for account ${accountId}`);

    // Push to AI server — even when issues=[] so stale rows get cleared — it will UPSERT into user_jira_issues_cache in Supabase
    await remoteRequest('/api/forge/issues/cache', {
      method: 'POST',
      body: { accountId, issues }
    });

    return { success: true, issueCount: issues.length };
  } catch (error) {
    console.error(`[IssueCache] Failed to refresh cache for ${accountId}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Scheduled handler for periodic issue cache refresh.
 * Fetches recently active users from the AI server, then refreshes their Jira
 * issue caches. Runs every 30 minutes via a Forge scheduled trigger.
 */
export async function scheduledIssueCacheRefresh() {
  try {
    // Ask the AI server which users had recent activity
    const activeData = await remoteRequest('/api/forge/issues/active-accounts?minutes=60', {
      method: 'GET'
    });

    const accountIds = activeData?.accountIds || [];
    if (accountIds.length === 0) {
      console.log('[IssueCache] No recently active users — skipping scheduled refresh');
      return { success: true, skipped: true, reason: 'no_active_users' };
    }

    console.log(`[IssueCache] Scheduled refresh: refreshing cache for ${accountIds.length} active user(s)`);

    const results = [];
    for (const accountId of accountIds) {
      const result = await refreshCacheForUser(accountId);
      results.push({ accountId, ...result });
    }

    const successCount = results.filter(r => r.success).length;
    console.log(`[IssueCache] Scheduled refresh complete: ${successCount}/${results.length} succeeded`);

    return { success: true, results };
  } catch (error) {
    console.error('[IssueCache] Scheduled cache refresh error:', error.message);
    return { success: false, error: error.message };
  }
}
