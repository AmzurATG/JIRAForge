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
 * Includes parent key and attachment metadata for context enrichment.
 * @returns {Promise<{title: string, description: string, issueType: string,
 *                   projectKey: string, parentKey: string|null, attachments: Array}>}
 */
async function fetchIssueForAnalysis(issueKey) {
  const fields = 'summary,description,issuetype,project,parent,attachment';
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
  const parentKey = issue.fields?.parent?.key || null;
  const rawAttachments = issue.fields?.attachment || [];

  return { title, description, issueType, projectKey, parentKey, rawAttachments };
}

/**
 * Fetch a parent/grandparent issue's title + description for LLM context.
 * Returns null on any failure (best-effort).
 */
async function fetchParentContext(parentKey) {
  if (!parentKey) return null;
  try {
    const response = await api
      .asUser()
      .requestJira(route`/rest/api/3/issue/${parentKey}?fields=summary,description,issuetype,parent`, {
        headers: { Accept: 'application/json' }
      });
    if (!response.ok) return null;
    const parent = await response.json();
    return {
      key: parentKey,
      title: parent.fields?.summary || '',
      description: parent.fields?.description ? adfToText(parent.fields.description) : '',
      issueType: parent.fields?.issuetype?.name || '',
      parentKey: parent.fields?.parent?.key || null
    };
  } catch {
    return null;
  }
}

/**
 * Build hierarchical parent context (up to 2 levels: parent + grandparent).
 * Concatenates parent and grandparent descriptions with a separator.
 * Total context is capped at 3000 characters.
 */
async function buildParentContext(parentKey) {
  if (!parentKey) return null;
  const parent = await fetchParentContext(parentKey);
  if (!parent) return null;

  let combinedDescription = parent.description || '';
  let contextLabel = `${parent.issueType} ${parent.key}`;

  // If the parent itself has a parent (grandparent), fetch one more level
  if (parent.parentKey && parent.issueType !== 'Epic') {
    const grandparent = await fetchParentContext(parent.parentKey);
    if (grandparent && grandparent.description) {
      contextLabel = `${grandparent.issueType} ${grandparent.key} > ${parent.issueType} ${parent.key}`;
      combinedDescription = `[${grandparent.issueType} ${grandparent.key}: ${grandparent.title}]\n${grandparent.description.slice(0, 1500)}\n\n[${parent.issueType} ${parent.key}: ${parent.title}]\n${parent.description}`;
    }
  }

  return {
    key: parent.key,
    title: parent.title,
    description: combinedDescription.slice(0, 3000),
    issueType: parent.issueType,
    hierarchy: contextLabel
  };
}

const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const MAX_IMAGE_SIZE = 1.5 * 1024 * 1024; // 1.5 MB raw — fits in Forge Remote payload
const MAX_IMAGES = 2;

/**
 * Download up to MAX_IMAGES image attachments from the issue and return
 * base64-encoded data. Only selects recent, reasonably-sized images.
 * Best-effort — silently skips failures.
 */
async function fetchImageAttachments(rawAttachments) {
  if (!Array.isArray(rawAttachments) || rawAttachments.length === 0) {
    console.log('[descriptionResolvers] No rawAttachments to process');
    return [];
  }

  console.log(`[descriptionResolvers] rawAttachments count=${rawAttachments.length}, types: ${rawAttachments.map(a => `${a.filename}(${a.mimeType},${a.size}b)`).join(', ')}`);

  // Filter to supported image types under size limit, prefer most recent
  const candidates = rawAttachments
    .filter(att => att.mimeType && ALLOWED_IMAGE_TYPES.has(att.mimeType))
    .filter(att => {
      // Accept if size is missing/0 (some Jira responses omit it) or under limit
      const size = Number(att.size) || 0;
      return size === 0 || size <= MAX_IMAGE_SIZE;
    })
    .sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0))
    .slice(0, MAX_IMAGES);

  if (candidates.length === 0) {
    console.log('[descriptionResolvers] No candidates after filtering');
    return [];
  }

  console.log(`[descriptionResolvers] ${candidates.length} image candidate(s): ${candidates.map(a => `${a.filename}(id=${a.id})`).join(', ')}`);

  const results = [];
  for (const att of candidates) {
    try {
      // Jira attachment content endpoint may return a redirect to the CDN
      const response = await api
        .asUser()
        .requestJira(route`/rest/api/3/attachment/content/${att.id}`, {
          headers: { Accept: att.mimeType },
          redirect: 'follow'
        });
      console.log(`[descriptionResolvers] Attachment ${att.id} response: HTTP ${response.status}, type=${response.headers?.get?.('content-type') || 'unknown'}`);
      if (!response.ok) {
        console.warn(`[descriptionResolvers] Attachment ${att.id} download failed: HTTP ${response.status}`);
        continue;
      }
      const buffer = await response.arrayBuffer();
      const base64 = Buffer.from(buffer).toString('base64');
      console.log(`[descriptionResolvers] Downloaded ${att.filename}: ${base64.length} base64 chars`);
      results.push({
        data: base64,
        mimeType: att.mimeType,
        filename: att.filename || 'attachment'
      });
    } catch (err) {
      console.warn(`[descriptionResolvers] Failed to fetch attachment ${att.id}: ${err.message}`);
    }
  }
  return results;
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
      const { title, description, issueType, projectKey, parentKey, rawAttachments } = await fetchIssueForAnalysis(issueKey);

      console.log(`[descriptionResolvers] issue=${issueKey} parentKey=${parentKey || 'none'} attachments=${rawAttachments?.length || 0}`);

      // Fetch parent/grandparent context and image attachments in parallel (best-effort)
      const [parentContext, attachments] = await Promise.all([
        buildParentContext(parentKey),
        fetchImageAttachments(rawAttachments)
      ]);

      console.log(`[descriptionResolvers] parentContext=${parentContext ? parentContext.key : 'null'} images=${attachments.length}`);

      const body = {
        issueKey,
        title,
        description,
        issueType: normalizeIssueType(issueType),
        projectKey,
        requestImprovement
      };

      // Only include optional context fields if they have data (saves payload size)
      if (parentContext) body.parentContext = parentContext;
      if (attachments && attachments.length > 0) body.attachments = attachments;

      const data = await remoteRequest('/api/forge/description/analyze', {
        method: 'POST',
        body
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
