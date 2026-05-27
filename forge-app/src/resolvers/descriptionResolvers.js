/**
 * Description Resolvers
 *
 * Backend handlers for the AI-assisted Jira ticket description enhancement
 * feature. Exposed to the React issue panel via @forge/bridge `invoke()`.
 *
 *   - analyzeDescription({issueKey, requestImprovement})
 *       Reads the ticket from Jira, calls the AI server to score / improve it.
 *   - updateDescription({issueKey, improvedTitle, improvedDescription,
 *                       updateTitle, updateDescription})
 *       Writes accepted improvements back to Jira via PUT /rest/api/3/issue/{key}.
 *   - wasDescriptionChanged({issueKey})
 *       Looks at the issue changelog to detect whether the description was
 *       just edited (used by analytics).
 *   - recordDescriptionEvent({issueKey, eventType, scoreBefore, scoreAfter, source})
 *       Best-effort analytics event recorder.
 */

import api, { route } from '@forge/api';
import { remoteRequest } from '../utils/remote.js';
import { isValidIssueKey } from '../utils/validators.js';
import { markdownToADF, validateADF, adfToText } from '../utils/adfBuilder.js';

const ALLOWED_ISSUE_TYPES = new Set(['Bug', 'Story', 'Task', 'Epic', 'Sub-task']);
const ALLOWED_EVENTS = new Set(['analyze', 'improve', 'accept', 'edit', 'reject']);

function failure(message) {
  return { success: false, error: message };
}

/**
 * Fetch a Jira issue and reduce it to the fields the analyzer needs.
 * @returns {Promise<{title: string, description: string, issueType: string,
 *                   projectKey: string}>}
 */
async function fetchIssueForAnalysis(issueKey) {
  const fields = 'summary,description,issuetype,project';
  const response = await api
    .asUser()
    .requestJira(route`/rest/api/3/issue/${issueKey}?fields=${fields}`, {
      headers: { Accept: 'application/json' }
    });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Jira responded ${response.status}: ${text.slice(0, 200)}`);
  }

  const issue = await response.json();
  const title = issue.fields?.summary || '';
  const description = issue.fields?.description ? adfToText(issue.fields.description) : '';
  const issueType = issue.fields?.issuetype?.name || 'Task';
  const projectKey = issue.fields?.project?.key || '';

  return { title, description, issueType, projectKey };
}

/**
 * Issue types not in the supported set are normalized to Task to avoid an
 * upstream 400. (Some Jira sites have custom issue types that map well to
 * Task for prompt purposes.)
 */
function normalizeIssueType(type) {
  return ALLOWED_ISSUE_TYPES.has(type) ? type : 'Task';
}

export function registerDescriptionResolvers(resolver) {
  resolver.define('analyzeDescription', async (req) => {
    const { payload, context } = req;
    const issueKey = payload?.issueKey;
    const requestImprovement = !!payload?.requestImprovement;

    if (!issueKey || !isValidIssueKey(issueKey)) {
      return failure('Invalid or missing issueKey');
    }

    try {
      const { title, description, issueType, projectKey } = await fetchIssueForAnalysis(issueKey);

      const data = await remoteRequest('/api/forge/description/analyze', {
        method: 'POST',
        body: {
          issueKey,
          title,
          description,
          issueType: normalizeIssueType(issueType),
          projectKey,
          requestImprovement
        }
      });

      // remoteRequest unwraps { success, data } when the upstream uses that
      // shape. The description controller returns the analysis fields directly
      // on the response object, so `data` here may be undefined if the server
      // returned a plain { success: true, ... } payload. Fall back to a sane
      // shape so the UI always sees the expected keys.
      const result = data || {};

      return {
        success: true,
        issueKey,
        issueType: normalizeIssueType(issueType),
        originalTitle: title,
        originalDescription: description,
        score: result.score ?? null,
        source: result.source ?? null,
        cached: !!result.cached,
        issues: result.issues || [],
        suggestions: result.suggestions || [],
        improved_title: result.improved_title || null,
        improved_description: result.improved_description || null
      };
    } catch (err) {
      console.error('[descriptionResolvers] analyzeDescription failed:', err.message);
      return failure(err.message || 'Failed to analyze description');
    }
  });

  resolver.define('updateDescription', async (req) => {
    const { payload } = req;
    const {
      issueKey,
      improvedTitle,
      improvedDescription,
      updateTitle = true,
      updateDescription: shouldUpdateDescription = true
    } = payload || {};

    if (!issueKey || !isValidIssueKey(issueKey)) {
      return failure('Invalid or missing issueKey');
    }
    if (!updateTitle && !shouldUpdateDescription) {
      return failure('Nothing to update');
    }

    const fields = {};
    if (updateTitle) {
      if (typeof improvedTitle !== 'string' || improvedTitle.trim().length === 0) {
        return failure('improvedTitle is required when updateTitle is true');
      }
      if (improvedTitle.length > 255) {
        return failure('improvedTitle exceeds 255 characters');
      }
      fields.summary = improvedTitle.trim();
    }
    if (shouldUpdateDescription) {
      if (typeof improvedDescription !== 'string' || improvedDescription.trim().length === 0) {
        return failure('improvedDescription is required when updateDescription is true');
      }
      const adf = markdownToADF(improvedDescription);
      if (!validateADF(adf)) {
        return failure('Failed to build a valid ADF document');
      }
      fields.description = adf;
    }

    try {
      const response = await api
        .asUser()
        .requestJira(route`/rest/api/3/issue/${issueKey}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json'
          },
          body: JSON.stringify({ fields })
        });

      if (!response.ok) {
        const text = await response.text();
        console.error('[descriptionResolvers] PUT issue failed:', response.status, text);
        return failure(`Jira rejected the update (${response.status})`);
      }

      return { success: true };
    } catch (err) {
      console.error('[descriptionResolvers] updateDescription threw:', err.message);
      return failure(err.message || 'Failed to update description');
    }
  });

  resolver.define('wasDescriptionChanged', async (req) => {
    const { payload } = req;
    const issueKey = payload?.issueKey;
    if (!issueKey || !isValidIssueKey(issueKey)) {
      return failure('Invalid or missing issueKey');
    }

    try {
      const response = await api
        .asUser()
        .requestJira(route`/rest/api/3/issue/${issueKey}/changelog`, {
          headers: { Accept: 'application/json' }
        });

      if (!response.ok) {
        return { success: true, changed: false };
      }

      const body = await response.json();
      const histories = Array.isArray(body.values) ? body.values : [];
      // Inspect just the most recent few entries — anything older is irrelevant
      // for "did the user just change the description after our suggestion".
      const recent = histories.slice(-3);
      const changed = recent.some(h =>
        (h.items || []).some(item => item.field === 'description')
      );
      return { success: true, changed };
    } catch (err) {
      console.error('[descriptionResolvers] wasDescriptionChanged failed:', err.message);
      return { success: true, changed: false };
    }
  });

  resolver.define('recordDescriptionEvent', async (req) => {
    const { payload } = req;
    const { issueKey, eventType, scoreBefore, scoreAfter, source } = payload || {};

    if (!issueKey || !isValidIssueKey(issueKey)) return failure('Invalid issueKey');
    if (!ALLOWED_EVENTS.has(eventType)) return failure('Invalid eventType');

    try {
      await remoteRequest('/api/forge/description/event', {
        method: 'POST',
        body: { issueKey, eventType, scoreBefore, scoreAfter, source }
      });
      return { success: true };
    } catch (err) {
      // Analytics is best-effort — never surface failures to the UI.
      console.warn('[descriptionResolvers] recordDescriptionEvent skipped:', err.message);
      return { success: true };
    }
  });
}
