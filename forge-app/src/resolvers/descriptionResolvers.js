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
import { markdownToADF, validateADF, adfToText, extractMediaNodes } from '../utils/adfBuilder.js';

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
  const response = await api
    .asUser()
    .requestJira(route`/rest/api/3/issue/${issueKey}?fields=summary,description,issuetype,project,parent,attachment,issuelinks`, {
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
  const rawIssueLinks = issue.fields?.issuelinks || [];

  console.log(`[descriptionResolvers] fetchIssueForAnalysis: issue=${issueKey} parent=${parentKey || 'none'} attachmentField=${issue.fields?.attachment !== undefined ? 'present' : 'MISSING'} count=${rawAttachments.length} links=${rawIssueLinks.length}`);

  return { title, description, issueType, projectKey, parentKey, rawAttachments, rawIssueLinks };
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
    console.log('[descriptionResolvers] fetchImageAttachments: no rawAttachments to process');
    return [];
  }

  console.log(`[descriptionResolvers] fetchImageAttachments: count=${rawAttachments.length}, items: ${JSON.stringify(rawAttachments.map(a => ({filename: a.filename, mimeType: a.mimeType, size: a.size, id: a.id})))}`);

  // Filter to supported image types under size limit, prefer most recent
  const candidates = rawAttachments
    .filter(att => {
      const typeOk = att.mimeType && ALLOWED_IMAGE_TYPES.has(att.mimeType);
      if (!typeOk) console.log(`[descriptionResolvers] Filtered out ${att.filename}: mimeType=${att.mimeType} not in allowed set`);
      return typeOk;
    })
    .filter(att => {
      // Accept if size is missing/0 (some Jira responses omit it) or under limit
      const size = Number(att.size) || 0;
      const sizeOk = size === 0 || size <= MAX_IMAGE_SIZE;
      if (!sizeOk) console.log(`[descriptionResolvers] Filtered out ${att.filename}: size=${size} exceeds limit`);
      return sizeOk;
    })
    .sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0))
    .slice(0, MAX_IMAGES);

  if (candidates.length === 0) {
    console.log('[descriptionResolvers] fetchImageAttachments: No candidates after filtering');
    return [];
  }

  console.log(`[descriptionResolvers] fetchImageAttachments: ${candidates.length} candidate(s): ${candidates.map(a => `${a.filename}(id=${a.id},mime=${a.mimeType})`).join(', ')}`);

  const results = [];
  for (const att of candidates) {
    try {
      // Use redirect=false query param so Jira returns content directly (200)
      // instead of a 303 redirect to CDN which Forge proxy can't follow
      const response = await api
        .asUser()
        .requestJira(route`/rest/api/3/attachment/content/${att.id}?redirect=false`, {
          headers: { Accept: '*/*' }
        });
      console.log(`[descriptionResolvers] Attachment ${att.id} response: HTTP ${response.status}`);
      if (!response.ok) {
        console.warn(`[descriptionResolvers] Attachment ${att.id} download failed: HTTP ${response.status}`);
        continue;
      }
      const buffer = await response.arrayBuffer();
      console.log(`[descriptionResolvers] Attachment ${att.id} arrayBuffer size: ${buffer.byteLength} bytes`);
      // Convert ArrayBuffer to base64
      const uint8 = new Uint8Array(buffer);
      let base64 = '';
      // Use chunks to avoid call stack overflow on large arrays
      const CHUNK = 8192;
      for (let i = 0; i < uint8.length; i += CHUNK) {
        base64 += String.fromCharCode.apply(null, uint8.slice(i, i + CHUNK));
      }
      base64 = btoa(base64);
      console.log(`[descriptionResolvers] Attachment ${att.id} base64 length: ${base64.length} chars`);
      results.push({
        data: base64,
        mimeType: att.mimeType,
        filename: att.filename || 'attachment'
      });
    } catch (err) {
      console.error(`[descriptionResolvers] Failed to fetch attachment ${att.id}: ${err.message}`, err.stack);
    }
  }
  console.log(`[descriptionResolvers] fetchImageAttachments: returning ${results.length} image(s)`);
  return results;
}

const ALLOWED_DOCUMENT_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
  'text/csv'
]);
const MAX_DOCUMENT_SIZE = 2 * 1024 * 1024; // 2 MB raw
const MAX_DOCUMENTS = 3;

/**
 * Download up to MAX_DOCUMENTS document attachments from the issue and return
 * base64-encoded data for server-side text extraction.
 * Supported: PDF, DOCX, plain text, markdown, CSV.
 * Best-effort — silently skips failures.
 */
async function fetchDocumentAttachments(rawAttachments) {
  if (!Array.isArray(rawAttachments) || rawAttachments.length === 0) return [];

  const candidates = rawAttachments
    .filter(att => att.mimeType && ALLOWED_DOCUMENT_TYPES.has(att.mimeType))
    .filter(att => {
      const size = Number(att.size) || 0;
      return size === 0 || size <= MAX_DOCUMENT_SIZE;
    })
    .sort((a, b) => new Date(b.created || 0) - new Date(a.created || 0))
    .slice(0, MAX_DOCUMENTS);

  if (candidates.length === 0) return [];

  console.log(`[descriptionResolvers] fetchDocumentAttachments: ${candidates.length} candidate(s): ${candidates.map(a => `${a.filename}(id=${a.id},mime=${a.mimeType})`).join(', ')}`);

  const results = [];
  for (const att of candidates) {
    try {
      const response = await api
        .asUser()
        .requestJira(route`/rest/api/3/attachment/content/${att.id}?redirect=false`, {
          headers: { Accept: '*/*' }
        });
      if (!response.ok) {
        console.warn(`[descriptionResolvers] Document ${att.id} download failed: HTTP ${response.status}`);
        continue;
      }
      const buffer = await response.arrayBuffer();
      const uint8 = new Uint8Array(buffer);
      let base64 = '';
      const CHUNK = 8192;
      for (let i = 0; i < uint8.length; i += CHUNK) {
        base64 += String.fromCharCode.apply(null, uint8.slice(i, i + CHUNK));
      }
      base64 = btoa(base64);
      results.push({
        data: base64,
        mimeType: att.mimeType,
        filename: att.filename || 'document'
      });
    } catch (err) {
      console.error(`[descriptionResolvers] Failed to fetch document ${att.id}: ${err.message}`);
    }
  }
  console.log(`[descriptionResolvers] fetchDocumentAttachments: returning ${results.length} document(s)`);
  return results;
}

const MAX_LINKED_ISSUES = 5;

/**
 * Process raw Jira issue links into a normalized context array.
 * Fetches summary + description for each linked issue (best-effort).
 * Returns up to MAX_LINKED_ISSUES links with title, description, status, etc.
 */
async function fetchLinkedIssuesContext(rawIssueLinks) {
  if (!Array.isArray(rawIssueLinks) || rawIssueLinks.length === 0) return [];

  // Normalize the link structure: each link has either inwardIssue or outwardIssue
  const links = rawIssueLinks
    .map(link => {
      const linkedIssue = link.inwardIssue || link.outwardIssue;
      if (!linkedIssue) return null;
      const direction = link.inwardIssue ? 'inward' : 'outward';
      const linkTypeName = direction === 'inward'
        ? (link.type?.inward || link.type?.name || 'relates to')
        : (link.type?.outward || link.type?.name || 'relates to');
      return {
        key: linkedIssue.key,
        linkType: linkTypeName,
        title: linkedIssue.fields?.summary || '',
        status: linkedIssue.fields?.status?.name || '',
        issueType: linkedIssue.fields?.issuetype?.name || ''
      };
    })
    .filter(Boolean)
    .slice(0, MAX_LINKED_ISSUES);

  if (links.length === 0) return [];

  // Fetch descriptions for linked issues in parallel (best-effort)
  const enriched = await Promise.all(links.map(async (link) => {
    try {
      const response = await api
        .asUser()
        .requestJira(route`/rest/api/3/issue/${link.key}?fields=description`, {
          headers: { Accept: 'application/json' }
        });
      if (response.ok) {
        const data = await response.json();
        const desc = data.fields?.description ? adfToText(data.fields.description) : '';
        return { ...link, description: desc.slice(0, 500) };
      }
    } catch {
      // best-effort
    }
    return link;
  }));

  console.log(`[descriptionResolvers] fetchLinkedIssuesContext: returning ${enriched.length} linked issue(s)`);
  return enriched;
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
      const { title, description, issueType, projectKey, parentKey, rawAttachments, rawIssueLinks } = await fetchIssueForAnalysis(issueKey);

      console.log(`[descriptionResolvers] issue=${issueKey} parentKey=${parentKey || 'none'} attachments=${rawAttachments?.length || 0} links=${rawIssueLinks?.length || 0}`);

      // Fetch parent/grandparent context, image attachments, document attachments,
      // and linked issues in parallel (all best-effort)
      const [parentContext, attachments, documents, linkedIssues] = await Promise.all([
        buildParentContext(parentKey),
        fetchImageAttachments(rawAttachments),
        fetchDocumentAttachments(rawAttachments),
        fetchLinkedIssuesContext(rawIssueLinks)
      ]);

      console.log(`[descriptionResolvers] parentContext=${parentContext ? parentContext.key : 'null'} images=${attachments.length} documents=${documents.length} linkedIssues=${linkedIssues.length}`);

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
      if (documents && documents.length > 0) body.documents = documents;
      if (linkedIssues && linkedIssues.length > 0) body.linkedIssues = linkedIssues;

      const bodySize = JSON.stringify(body).length;
      console.log(`[descriptionResolvers] Sending to ai-server: bodySize=${bodySize} bytes, hasParent=${!!body.parentContext}, hasAttachments=${!!body.attachments}, attachmentCount=${body.attachments?.length || 0}, documents=${body.documents?.length || 0}, linkedIssues=${body.linkedIssues?.length || 0}`);

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

      // Preserve inline media (images) from the original description.
      // Fetch the current ADF, extract mediaSingle/mediaGroup nodes, and
      // append them to the new ADF so attached images remain visible.
      try {
        const origResponse = await api
          .asUser()
          .requestJira(route`/rest/api/3/issue/${issueKey}?fields=description`, {
            headers: { Accept: 'application/json' }
          });
        if (origResponse.ok) {
          const origIssue = await origResponse.json();
          const originalAdf = origIssue.fields?.description;
          const mediaNodes = extractMediaNodes(originalAdf);
          if (mediaNodes.length > 0) {
            console.log(`[descriptionResolvers] Preserving ${mediaNodes.length} media node(s) from original description`);
            adf.content.push(...mediaNodes);
          }
        }
      } catch (mediaErr) {
        // Best-effort — if we can't fetch the original, proceed without media
        console.warn('[descriptionResolvers] Could not fetch original description for media preservation:', mediaErr.message);
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
