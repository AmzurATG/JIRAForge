/**
 * Worklog Resolvers
 * Resolver definitions for Jira worklog creation endpoints
 */

import { createWorklog, syncCurrentUserWorklogs } from '../services/worklogService.js';
import { runScheduledWorklogSync } from '../services/scheduledWorklogSync.js';
import { isJiraAdmin } from '../utils/jira.js';
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
}
