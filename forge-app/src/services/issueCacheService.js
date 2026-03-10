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

// JQL must match the one used by getAllUserAssignedIssues() in jira.js
// so the cache and live Jira queries return the same issue set
const CACHE_JQL = 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC';
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
          fields: ['summary', 'status', 'project', 'issuetype', 'priority', 'description', 'labels']
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
