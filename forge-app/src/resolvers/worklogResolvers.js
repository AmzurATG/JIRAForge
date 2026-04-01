/**
 * Worklog Resolvers
 * Resolver definitions for Jira worklog creation endpoints
 */

import { createWorklog, syncCurrentUserWorklogs } from '../services/worklogService.js';
import { runScheduledWorklogSync } from '../services/scheduledWorklogSync.js';
import { reassignWorklog, splitWorklog } from '../services/worklogReassignmentService.js';
import { isJiraAdmin } from '../utils/jira.js';
import { clearCache } from '../utils/cache.js';
import api, { route } from '@forge/api';

/**
 * Register worklog resolvers
 * @param {Resolver} resolver - Forge resolver instance
 */
export function registerWorklogResolvers(resolver) {
  /**
   * Resolver for creating worklog entries
   */
  resolver.define('createWorklog', async (req) => {
    const { payload } = req;
    const { issueKey, timeSpentSeconds, startedAt } = payload;

    try {
      const worklog = await createWorklog(issueKey, timeSpentSeconds, startedAt);
      return {
        success: true,
        worklog
      };
    } catch (error) {
      console.error('Error creating worklog:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });

  /**
   * Sync worklogs for the CURRENT USER in their live Jira session.
   *
   * Uses api.asUser() with no accountId arg, so Jira records the worklog
   * author as the actual user (not the app).  Any existing worklogs that
   * were previously created by the app are deleted and recreated under the
   * user's real name.
   *
   * Called automatically when the user opens the project page (with a
   * 15-minute client-side cooldown to avoid excessive calls).
   */
  resolver.define('syncMyWorklogs', async (req) => {
    const { accountId, cloudId } = req.context;
    try {
      return await syncCurrentUserWorklogs(accountId, cloudId);
    } catch (error) {
      console.error('[WorklogResolver] syncMyWorklogs error:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * Resolver to manually trigger worklog sync (admin only)
   */
  resolver.define('triggerWorklogSync', async () => {
    try {
      const isAdmin = await isJiraAdmin();
      if (!isAdmin) {
        return { success: false, error: 'Only Jira administrators can trigger worklog sync' };
      }

      const result = await runScheduledWorklogSync();
      return { success: true, ...result };
    } catch (error) {
      console.error('Error triggering worklog sync:', error);
      return { success: false, error: error.message };
    }
  });

  /**
   * Test resolver to verify the worklog author fix.
   * Creates a small 60-second worklog on a specified issue in the current user's
   * live Jira session, then checks whether Jira records the author as the user
   * (not the app). Deletes the test worklog afterwards to avoid polluting data.
   * Usage from frontend: invoke('testWorklogFix', { issueKey: 'PROJ-123' })
   */
  resolver.define('testWorklogFix', async (req) => {
    const { accountId } = req.context;
    const issueKey = req.payload?.issueKey;

    if (!issueKey) {
      return { success: false, error: 'issueKey is required (e.g., "ESW-6570")' };
    }

    const results = { issueKey, steps: [] };

    try {
      // Step 1: Create a 60-second test worklog as the current user
      const started = new Date().toISOString().replace('Z', '+0000');
      const createResponse = await api.asUser().requestJira(
        route`/rest/api/3/issue/${issueKey}/worklog?adjustEstimate=leave`,
        {
          method: 'POST',
          headers: {
            'Accept': 'application/json',
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            timeSpentSeconds: 60,
            started,
            comment: {
              type: 'doc',
              version: 1,
              content: [{
                type: 'paragraph',
                content: [{ type: 'text', text: 'TEST WORKLOG — verifying author fix (will be deleted)' }]
              }]
            }
          })
        }
      );

      if (!createResponse.ok) {
        const errText = await createResponse.text();
        return { success: false, error: `Failed to create test worklog: HTTP ${createResponse.status} — ${errText}` };
      }

      const worklog = await createResponse.json();
      results.steps.push({
        step: 'Created test worklog',
        worklogId: worklog.id,
        author: worklog.author?.displayName || 'unknown',
        authorAccountId: worklog.author?.accountId || 'unknown',
      });

      // Step 2: Check if the author matches the current user
      const authorMatchesUser = worklog.author?.accountId === accountId;
      results.steps.push({
        step: 'Author check',
        currentUserAccountId: accountId,
        worklogAuthorAccountId: worklog.author?.accountId,
        authorIsUser: authorMatchesUser,
        verdict: authorMatchesUser
          ? `PASS — worklog author is "${worklog.author?.displayName}" (the current user)`
          : `FAIL — worklog author is "${worklog.author?.displayName}" instead of the current user`,
      });

      // Step 3: Delete the test worklog to clean up
      const deleteResponse = await api.asUser().requestJira(
        route`/rest/api/3/issue/${issueKey}/worklog/${worklog.id}?adjustEstimate=leave`,
        { method: 'DELETE', headers: { 'Accept': 'application/json' } }
      );

      results.steps.push({
        step: 'Cleanup',
        deleted: deleteResponse.status === 204,
        status: deleteResponse.status,
      });

      results.success = true;
      results.fixWorking = authorMatchesUser;
      results.summary = authorMatchesUser
        ? `Fix verified — worklog author shows as "${worklog.author?.displayName}" (user's real name), not the app.`
        : `Fix NOT working — worklog author shows as "${worklog.author?.displayName}" instead of "${accountId}".`;

      return results;
    } catch (error) {
      console.error('[TestWorklogFix] Error:', error);
      return { success: false, error: error.message, steps: results.steps };
    }
  });

  /**
   * Resolver for reassigning a synced Jira worklog from one issue to another.
   * Deletes the worklog on the old issue and creates it on the new issue.
   */
  resolver.define('reassignWorklog', async (req) => {
    const { context, payload } = req;
    const accountId = context.accountId;
    const cloudId = context.cloudId;
    const { fromIssueKey, toIssueKey } = payload;

    if (!toIssueKey) {
      return { success: false, error: 'toIssueKey is required' };
    }

    if (fromIssueKey && fromIssueKey === toIssueKey) {
      return { success: false, error: 'Cannot reassign to the same issue' };
    }

    try {
      const result = await reassignWorklog(accountId, cloudId, fromIssueKey, toIssueKey);
      clearCache(); // Invalidate dashboard cache so next fetch returns fresh data
      return {
        success: true,
        fromIssueKey: result.fromIssueKey,
        toIssueKey: result.toIssueKey,
        timeSpentSeconds: result.timeSpentSeconds,
        message: result.message
      };
    } catch (error) {
      console.error(`[reassignWorklog] Error: ${error.message}`);
      return { success: false, error: error.message };
    }
  });

  /**
   * Resolver for splitting a synced Jira worklog between two issues.
   * Moves a specified amount of time from one issue to another.
   * Full move (splitSeconds == total) delegates to reassignWorklog.
   */
  resolver.define('splitWorklog', async (req) => {
    const { context, payload } = req;
    const accountId = context.accountId;
    const cloudId = context.cloudId;
    const { fromIssueKey, toIssueKey, splitSeconds } = payload;

    if (!toIssueKey) {
      return { success: false, error: 'toIssueKey is required' };
    }
    if (fromIssueKey && fromIssueKey === toIssueKey) {
      return { success: false, error: 'Cannot split to the same issue' };
    }
    if (!splitSeconds || splitSeconds <= 0 || !Number.isInteger(splitSeconds)) {
      return { success: false, error: 'splitSeconds must be a positive integer' };
    }

    try {
      const result = await splitWorklog(accountId, cloudId, fromIssueKey, toIssueKey, splitSeconds);
      clearCache(); // Invalidate dashboard cache so next fetch returns fresh data
      return {
        success: true,
        fromIssueKey: result.fromIssueKey,
        toIssueKey: result.toIssueKey,
        splitSeconds: result.splitSeconds,
        remainingSeconds: result.remainingSeconds,
        message: result.message
      };
    } catch (error) {
      console.error(`[splitWorklog] Error: ${error.message}`);
      return { success: false, error: error.message };
    }
  });
}
