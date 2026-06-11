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
import { isValidIssueKey, sanitizeUUIDArray } from '../utils/validators.js';
import { markdownToADF, validateADF, adfToText, extractMediaNodes } from '../utils/adfBuilder.js';
import { supabaseRequest } from '../utils/supabase.js';
import { initializeRequestContext, ensureArray, handleResolverError } from './unassigned/helpers.js';
import { updateSessionsAndAnalysis, markGroupAsAssigned } from './unassigned/assignmentResolvers.js';
import { createWorklogIfNeeded, isAutoSyncEnabled } from '../services/workAssignmentService.js';

const ALLOWED_ISSUE_TYPES = new Set(['Bug', 'Story', 'Task', 'Epic', 'Sub-task']);
const ALLOWED_EVENTS = new Set(['analyze', 'improve', 'accept', 'edit', 'reject']);
const RECENT_UNASSIGNED_WINDOW_MINUTES = 30;

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

function recentUnassignedCutoffIso(windowMinutes = RECENT_UNASSIGNED_WINDOW_MINUTES) {
  return new Date(Date.now() - windowMinutes * 60 * 1000).toISOString();
}

async function fetchRecentUnassignedSessions(supabaseConfig, userId, organizationId, windowMinutes = RECENT_UNASSIGNED_WINDOW_MINUTES) {
  const cutoff = recentUnassignedCutoffIso(windowMinutes);

  // Match the Unassigned Work UI: filter by when work occurred (start_time / end_time),
  // not when the DB row was created. Clustered groups can be days old while member
  // activity still falls inside the 30-minute sync window.
  const [activityResults, legacyResults] = await Promise.all([
    supabaseRequest(
      supabaseConfig,
      `activity_records?user_id=eq.${userId}&organization_id=eq.${organizationId}` +
      `&user_assigned_issue_key=is.null&status=in.(pending,processing,analyzed)` +
      `&classification=in.(productive,unknown)&clustering_dismissed=eq.false` +
      `&or=(start_time.gte.${cutoff},end_time.gte.${cutoff},created_at.gte.${cutoff})` +
      `&select=id,window_title,application_name,ocr_text,duration_seconds,total_time_seconds,start_time,end_time,created_at`
    ),
    supabaseRequest(
      supabaseConfig,
      `unassigned_activity?user_id=eq.${userId}&organization_id=eq.${organizationId}` +
      `&manually_assigned=eq.false&clustering_dismissed=eq.false` +
      `&timestamp=gte.${cutoff}` +
      `&select=id,window_title,application_name,extracted_text,time_spent_seconds`
    )
  ]);

  const sessions = [];
  const seenIds = new Set();
  for (const record of ensureArray(activityResults)) {
    if (!record?.id || seenIds.has(record.id)) continue;
    seenIds.add(record.id);
    sessions.push({
      sessionId: record.id,
      applicationName: record.application_name || '',
      windowTitle: record.window_title || '',
      screenText: (record.ocr_text || '').slice(0, 500),
      durationSeconds: record.duration_seconds || record.total_time_seconds || 0,
      source: 'activity_records'
    });
  }
  for (const record of ensureArray(legacyResults)) {
    if (!record?.id || seenIds.has(record.id)) continue;
    seenIds.add(record.id);
    sessions.push({
      sessionId: record.id,
      applicationName: record.application_name || '',
      windowTitle: record.window_title || '',
      screenText: (record.extracted_text || '').slice(0, 500),
      durationSeconds: record.time_spent_seconds || 0,
      source: 'unassigned_activity'
    });
  }
  return sessions;
}

async function sumSessionDurations(supabaseConfig, userId, organizationId, sessionIds) {
  const validIds = sanitizeUUIDArray(sessionIds);
  if (validIds.length === 0) return 0;

  const idsParam = validIds.join(',');
  const [activityRows, legacyRows] = await Promise.all([
    supabaseRequest(
      supabaseConfig,
      `activity_records?id=in.(${idsParam})&user_id=eq.${userId}` +
      `&select=duration_seconds,total_time_seconds`
    ),
    supabaseRequest(
      supabaseConfig,
      `unassigned_activity?id=in.(${idsParam})&user_id=eq.${userId}` +
      `&organization_id=eq.${organizationId}` +
      `&select=time_spent_seconds`
    )
  ]);

  let total = 0;
  for (const row of ensureArray(activityRows)) {
    total += row.duration_seconds || row.total_time_seconds || 0;
  }
  for (const row of ensureArray(legacyRows)) {
    total += row.time_spent_seconds || 0;
  }
  return total;
}

async function assignMatchedSessions({
  supabaseConfig,
  userId,
  organizationId,
  accountId,
  cloudId,
  issueKey,
  sessionIds
}) {
  const validSessionIds = sanitizeUUIDArray(sessionIds);
  if (validSessionIds.length === 0) {
    return 0;
  }

  await updateSessionsAndAnalysis({
    validSessionIds,
    issueKey,
    userId,
    organizationId,
    supabaseConfig,
    groupId: null
  });

  const idsParam = validSessionIds.join(',');
  const members = ensureArray(await supabaseRequest(
    supabaseConfig,
    `unassigned_group_members?or=(activity_record_id.in.(${idsParam}),unassigned_activity_id.in.(${idsParam}))` +
    `&select=group_id,activity_record_id,unassigned_activity_id`
  ));

  const sessionIdsSet = new Set(validSessionIds);
  const groupIds = [...new Set(members.map((m) => m.group_id).filter(Boolean))];

  for (const groupId of groupIds) {
    const groupMembers = ensureArray(await supabaseRequest(
      supabaseConfig,
      `unassigned_group_members?group_id=eq.${groupId}&select=activity_record_id,unassigned_activity_id`
    ));
    const memberSessionIds = groupMembers
      .flatMap((m) => [m.activity_record_id, m.unassigned_activity_id])
      .filter(Boolean);
    if (memberSessionIds.length > 0 && memberSessionIds.every((id) => sessionIdsSet.has(id))) {
      await markGroupAsAssigned({ groupId, issueKey, userId, supabaseConfig });
    }
  }

  const timeToLog = await sumSessionDurations(supabaseConfig, userId, organizationId, validSessionIds);
  const autoSyncEnabled = await isAutoSyncEnabled(accountId, cloudId);
  await createWorklogIfNeeded({
    issueKey,
    timeToLog,
    sessionCount: validSessionIds.length,
    autoSyncEnabled,
    customComment: 'Time tracked from recent unassigned work, auto-matched after description update.'
  });

  return validSessionIds.length;
}

async function fetchRecentlyUpdatedIssueKeysFromDb(supabaseConfig, cloudId, windowMinutes = RECENT_UNASSIGNED_WINDOW_MINUTES) {
  const cutoff = recentUnassignedCutoffIso(windowMinutes);
  const [eventRows, cacheRows] = await Promise.all([
    supabaseRequest(
      supabaseConfig,
      `description_quality_events?org_id=eq.${cloudId}` +
      `&event_type=in.(accept,edit,improve)&created_at=gte.${cutoff}` +
      `&select=issue_key,created_at&order=created_at.desc`
    ),
    supabaseRequest(
      supabaseConfig,
      `description_quality_cache?org_id=eq.${cloudId}` +
      `&updated_at=gte.${cutoff}` +
      `&select=issue_key,updated_at&order=updated_at.desc`
    )
  ]);

  const seen = new Set();
  const keys = [];
  for (const row of [...ensureArray(eventRows), ...ensureArray(cacheRows)]) {
    if (!row?.issue_key || seen.has(row.issue_key)) continue;
    seen.add(row.issue_key);
    keys.push(row.issue_key);
  }
  return keys;
}

async function fetchRecentlyUpdatedIssueKeysFromJira(windowMinutes = RECENT_UNASSIGNED_WINDOW_MINUTES) {
  const jql = `assignee = currentUser() AND updated >= -${windowMinutes}m ORDER BY updated DESC`;
  try {
    const response = await api.asUser().requestJira(
      route`/rest/api/3/search/jql`,
      {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jql,
          maxResults: 20,
          fields: ['summary', 'description', 'updated']
        })
      }
    );
    if (!response.ok) {
      const text = await response.text();
      console.warn('[descriptionResolvers] Jira recent-updated search failed:', response.status, text.slice(0, 200));
      return [];
    }
    const body = await response.json();
    const issues = Array.isArray(body.issues) ? body.issues : [];
    return issues
      .map((issue) => issue?.key)
      .filter((key) => key && isValidIssueKey(key));
  } catch (err) {
    console.warn('[descriptionResolvers] Jira recent-updated search error:', err.message);
    return [];
  }
}

async function fetchRecentlyUpdatedIssueCandidates(supabaseConfig, cloudId, windowMinutes = RECENT_UNASSIGNED_WINDOW_MINUTES) {
  const [dbKeys, jiraKeys] = await Promise.all([
    fetchRecentlyUpdatedIssueKeysFromDb(supabaseConfig, cloudId, windowMinutes),
    fetchRecentlyUpdatedIssueKeysFromJira(windowMinutes)
  ]);

  const seen = new Set();
  const keys = [];
  for (const key of [...dbKeys, ...jiraKeys]) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

async function fetchIssuesFromJira(issueKeys) {
  const issues = [];
  for (const issueKey of issueKeys) {
    try {
      const { title, description } = await fetchIssueForAnalysis(issueKey);
      issues.push({ issueKey, title, description });
    } catch (err) {
      console.warn(`[descriptionResolvers] Skipping issue ${issueKey}: ${err.message}`);
    }
  }
  return issues;
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

  resolver.define('syncRecentUnassignedWorkForIssue', async (req) => {
    const issueKey = req.payload?.issueKey;
    if (!issueKey || !isValidIssueKey(issueKey)) {
      return failure('Invalid or missing issueKey');
    }

    try {
      const ctx = await initializeRequestContext(req);
      if (!ctx.success) return ctx;

      const { config: supabaseConfig, organization, userId, accountId, cloudId } = ctx;
      const sessions = await fetchRecentUnassignedSessions(supabaseConfig, userId, organization.id);
      if (sessions.length === 0) {
        return { success: true, matchedCount: 0 };
      }

      const { title, description } = await fetchIssueForAnalysis(issueKey);
      const matchData = await remoteRequest('/api/forge/description/sync-issue-unassigned', {
        method: 'POST',
        body: { issueKey, title, description, sessions }
      });
      const matchedSessionIds = matchData?.matchedSessionIds || [];
      if (matchedSessionIds.length === 0) {
        return { success: true, matchedCount: 0 };
      }

      const matchedCount = await assignMatchedSessions({
        supabaseConfig,
        userId,
        organizationId: organization.id,
        accountId,
        cloudId,
        issueKey,
        sessionIds: matchedSessionIds
      });

      return { success: true, matchedCount };
    } catch (err) {
      console.error('[descriptionResolvers] syncRecentUnassignedWorkForIssue failed:', err.message);
      return failure(err.message || 'Failed to sync recent unassigned work');
    }
  });

  resolver.define('syncRecentUnassignedWorkWithAllUpdatedIssues', async (req) => {
    try {
      const ctx = await initializeRequestContext(req);
      if (!ctx.success) return ctx;

      const { config: supabaseConfig, organization, userId, accountId, cloudId } = ctx;
      const [sessions, issueKeys] = await Promise.all([
        fetchRecentUnassignedSessions(supabaseConfig, userId, organization.id),
        fetchRecentlyUpdatedIssueCandidates(supabaseConfig, cloudId)
      ]);

      console.log(
        '[descriptionResolvers] syncRecentUnassignedWorkWithAllUpdatedIssues: sessions=%d issueCandidates=%d',
        sessions.length,
        issueKeys.length
      );

      if (sessions.length === 0) {
        return {
          success: true,
          matchedCount: 0,
          reason: 'no_recent_sessions',
          sessionsScanned: 0,
          issuesScanned: 0
        };
      }

      if (issueKeys.length === 0) {
        return {
          success: true,
          matchedCount: 0,
          reason: 'no_recent_updated_issues',
          sessionsScanned: sessions.length,
          issuesScanned: 0
        };
      }

      const issues = await fetchIssuesFromJira(issueKeys);
      if (issues.length === 0) {
        return {
          success: true,
          matchedCount: 0,
          reason: 'no_issue_details',
          sessionsScanned: sessions.length,
          issuesScanned: 0
        };
      }

      console.log(
        '[descriptionResolvers] Invoking LLM match for %d sessions against %d issues',
        sessions.length,
        issues.length
      );

      const matchData = await remoteRequest('/api/forge/description/sync-all-unassigned', {
        method: 'POST',
        body: { issues, sessions }
      });
      const assignments = Array.isArray(matchData?.assignments) ? matchData.assignments : [];
      if (assignments.length === 0) {
        return {
          success: true,
          matchedCount: 0,
          reason: 'no_llm_matches',
          sessionsScanned: sessions.length,
          issuesScanned: issues.length
        };
      }

      const byIssue = new Map();
      for (const row of assignments) {
        if (!row?.sessionId || !row?.issueKey) continue;
        if (!byIssue.has(row.issueKey)) byIssue.set(row.issueKey, []);
        byIssue.get(row.issueKey).push(row.sessionId);
      }

      let matchedCount = 0;
      for (const [issueKey, sessionIds] of byIssue.entries()) {
        matchedCount += await assignMatchedSessions({
          supabaseConfig,
          userId,
          organizationId: organization.id,
          accountId,
          cloudId,
          issueKey,
          sessionIds
        });
      }

      return {
        success: true,
        matchedCount,
        reason: matchedCount > 0 ? 'assigned' : 'no_llm_matches',
        sessionsScanned: sessions.length,
        issuesScanned: issues.length
      };
    } catch (err) {
      console.error('[descriptionResolvers] syncRecentUnassignedWorkWithAllUpdatedIssues failed:', err.message);
      return handleResolverError(err, 'syncing recent unassigned work with updated issues');
    }
  });
}
