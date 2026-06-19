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
const SYNC_JOB_TABLE = 'unassigned_sync_jobs';
const SYNC_JOB_TYPE = 'sync_recent_unassigned_with_updated_issues';
const SYNC_JOB_STATUS = {
  QUEUED: 'queued',
  IN_PROGRESS: 'in_progress',
  COMPLETED: 'completed',
  FAILED: 'failed'
};
const MAX_SYNC_INVOCATION_BUDGET_MS = 18000;
const ACTIVE_SYNC_PROCESSING_LEASE_MS = 20000;

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

function getTimeframeBoundsIso(timeframe = 'yesterday') {
  const now = new Date();
  const todayStartUtc = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    0,
    0,
    0,
    0
  ));
  
  if (timeframe === 'last_3_days') {
    const startUtc = new Date(todayStartUtc.getTime() - (3 * 24 * 60 * 60 * 1000));
    return { startIso: startUtc.toISOString(), endIso: todayStartUtc.toISOString() };
  } else if (timeframe === 'last_one_week') {
    const startUtc = new Date(todayStartUtc.getTime() - (7 * 24 * 60 * 60 * 1000));
    return { startIso: startUtc.toISOString(), endIso: todayStartUtc.toISOString() };
  } else {
    // yesterday
    const yesterdayStartUtc = new Date(todayStartUtc.getTime() - (24 * 60 * 60 * 1000));
    return { startIso: yesterdayStartUtc.toISOString(), endIso: todayStartUtc.toISOString() };
  }
}

function chunkArray(items, chunkSize) {
  if (!Array.isArray(items) || items.length === 0) return [];
  const chunks = [];
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize));
  }
  return chunks;
}

const MAX_SESSIONS_PER_LLM_CALL = 50;
  const MIN_SESSIONS_PER_LLM_CALL = 1;

function groupAssignmentsByIssue(assignments) {
  const byIssue = new Map();
  for (const row of assignments || []) {
    if (!row?.sessionId || !row?.issueKey) continue;
    if (!byIssue.has(row.issueKey)) byIssue.set(row.issueKey, []);
    byIssue.get(row.issueKey).push(row.sessionId);
  }
  return byIssue;
}

function parseJobPayload(raw) {
  if (!raw || typeof raw !== 'object') return {};
  return raw;
}

function parseJobProgress(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      cursor: 0,
      processedSessions: 0,
      processedChunks: 0,
      matchedCount: 0,
      issuesScanned: 0,
      reason: null
    };
  }
  return {
    cursor: Number(raw.cursor) || 0,
    processedSessions: Number(raw.processedSessions) || 0,
    processedChunks: Number(raw.processedChunks) || 0,
    matchedCount: Number(raw.matchedCount) || 0,
    issuesScanned: Number(raw.issuesScanned) || 0,
    reason: raw.reason || null,
    assignments: Array.isArray(raw.assignments) ? raw.assignments : []
  };
}

function toPositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function computeDynamicChunkSize({ issuesCount, remainingSessions, elapsedMs, budgetMs }) {
  const safeIssues = Math.max(1, toPositiveInt(issuesCount, 1));
  // Keep issue x session complexity bounded per AI call.
  // Lower target complexity = smaller chunks = more processing iterations per invocation budget.
  // Conservative starting point to ensure first poll completes well under 25s Forge limit.
  const targetComplexity = 60;
  let chunkSize = Math.floor(targetComplexity / safeIssues);
  chunkSize = Math.max(MIN_SESSIONS_PER_LLM_CALL, Math.min(MAX_SESSIONS_PER_LLM_CALL, chunkSize));

  // As invocation budget is consumed, reduce chunk size proactively.
  if (elapsedMs > budgetMs * 0.5) chunkSize = Math.max(MIN_SESSIONS_PER_LLM_CALL, Math.floor(chunkSize * 0.6));
  if (elapsedMs > budgetMs * 0.75) chunkSize = Math.max(MIN_SESSIONS_PER_LLM_CALL, Math.floor(chunkSize * 0.5));

  return Math.max(1, Math.min(chunkSize, remainingSessions));
}

function toJobResponse(jobRow) {
  const payload = parseJobPayload(jobRow?.payload);
  const progress = parseJobProgress(jobRow?.progress);
  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  const issues = Array.isArray(payload.issues) ? payload.issues : [];
  const matchedSessions = (progress.assignments || jobRow?.result?.assignments || []).map(a => {
    const session = sessions.find(s => s.sessionId === a.sessionId) || {};
    return {
      sessionId: a.sessionId,
      issueKey: a.issueKey,
      windowTitle: session.windowTitle || '',
      applicationName: session.applicationName || '',
      durationSeconds: session.durationSeconds || 0
    };
  });

  return {
    success: true,
    jobId: jobRow?.id,
    status: jobRow?.status,
    matchedCount: progress.matchedCount,
    sessionsScanned: sessions.length,
    sessionsProcessed: progress.processedSessions,
    issuesScanned: issues.length,
    processedChunks: progress.processedChunks,
    reason: progress.reason || jobRow?.result?.reason || null,
    error: jobRow?.error || null,
    matchedSessions
  };
}

async function insertSyncJob({ supabaseConfig, userId, organizationId, payload, progress }) {
  const rows = ensureArray(await supabaseRequest(
    supabaseConfig,
    `${SYNC_JOB_TABLE}?select=*`,
    {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: {
        user_id: userId,
        organization_id: organizationId,
        job_type: SYNC_JOB_TYPE,
        status: SYNC_JOB_STATUS.QUEUED,
        payload,
        progress,
        started_at: null,
        completed_at: null,
        last_heartbeat_at: new Date().toISOString()
      }
    }
  ));
  return rows[0] || null;
}

async function updateSyncJob({ supabaseConfig, jobId, patch }) {
  const rows = ensureArray(await supabaseRequest(
    supabaseConfig,
    `${SYNC_JOB_TABLE}?id=eq.${jobId}&select=*`,
    {
      method: 'PATCH',
      headers: { Prefer: 'return=representation' },
      body: {
        ...patch,
        last_heartbeat_at: new Date().toISOString()
      }
    }
  ));
  return rows[0] || null;
}

async function getSyncJobById({ supabaseConfig, jobId, userId, organizationId }) {
  const rows = ensureArray(await supabaseRequest(
    supabaseConfig,
    `${SYNC_JOB_TABLE}?id=eq.${jobId}&user_id=eq.${userId}&organization_id=eq.${organizationId}&select=*`
  ));
  return rows[0] || null;
}

function hasFreshHeartbeat(heartbeatAt, maxAgeMs = ACTIVE_SYNC_PROCESSING_LEASE_MS) {
  if (!heartbeatAt) return false;
  const heartbeatMs = Date.parse(heartbeatAt);
  if (Number.isNaN(heartbeatMs)) return false;
  return (Date.now() - heartbeatMs) < maxAgeMs;
}

function isSyncJobActivelyProcessing(jobRow) {
  const progress = parseJobProgress(jobRow?.progress);
  return jobRow?.status === SYNC_JOB_STATUS.IN_PROGRESS
    && progress.reason === 'processing'
    && hasFreshHeartbeat(jobRow?.last_heartbeat_at);
}

async function processSyncJobWithinBudget({
  supabaseConfig,
  userId,
  organizationId,
  accountId,
  cloudId,
  jobRow,
  budgetMs = MAX_SYNC_INVOCATION_BUDGET_MS
}) {
  const startedAt = Date.now();
  const payload = parseJobPayload(jobRow?.payload);
  const progress = parseJobProgress(jobRow?.progress);

  const sessions = Array.isArray(payload.sessions) ? payload.sessions : [];
  const issues = Array.isArray(payload.issues) ? payload.issues : [];

  if (sessions.length === 0 || issues.length === 0) {
    return await updateSyncJob({
      supabaseConfig,
      jobId: jobRow.id,
      patch: {
        status: SYNC_JOB_STATUS.COMPLETED,
        completed_at: new Date().toISOString(),
        progress: { ...progress, reason: sessions.length === 0 ? 'no_previous_day_sessions' : 'no_in_progress_issues' },
        result: { reason: sessions.length === 0 ? 'no_previous_day_sessions' : 'no_in_progress_issues' }
      }
    });
  }

  let cursor = Math.min(progress.cursor, sessions.length);
  let processedSessions = progress.processedSessions;
  let processedChunks = progress.processedChunks;
  let matchedCount = progress.matchedCount;
  const autoSyncEnabled = await isAutoSyncEnabled(accountId, cloudId);

  let updatedRow = jobRow;
  updatedRow = await updateSyncJob({
    supabaseConfig,
    jobId: jobRow.id,
    patch: {
      status: SYNC_JOB_STATUS.IN_PROGRESS,
      started_at: jobRow.started_at || new Date().toISOString(),
      payload: { ...payload, cursor },
      progress: {
        ...progress,
        cursor,
        processedSessions,
        processedChunks,
        matchedCount,
        issuesScanned: issues.length,
        reason: 'processing'
      }
    }
  }) || updatedRow;

  try {
    while (cursor < sessions.length) {
      const elapsedMs = Date.now() - startedAt;
      // Leave headroom for DB writes + resolver response marshalling.
      if (elapsedMs >= budgetMs - 1500) {
        updatedRow = await updateSyncJob({
          supabaseConfig,
          jobId: jobRow.id,
          patch: {
            status: SYNC_JOB_STATUS.IN_PROGRESS,
            progress: {
              ...progress,
              cursor,
              processedSessions,
              processedChunks,
              matchedCount,
              issuesScanned: issues.length,
              reason: 'partial_timeout_budget'
            },
            payload: { ...payload, cursor }
          }
        }) || updatedRow;
        return updatedRow;
      }

      const remaining = sessions.length - cursor;
      const chunkSize = computeDynamicChunkSize({
        issuesCount: issues.length,
        remainingSessions: remaining,
        elapsedMs,
        budgetMs
      });
      const sessionChunk = sessions.slice(cursor, cursor + chunkSize);

      const matchData = await remoteRequest('/api/forge/description/sync-all-unassigned', {
        method: 'POST',
        body: { issues, sessions: sessionChunk }
      });
      const assignments = Array.isArray(matchData?.assignments) ? matchData.assignments : [];
      const byIssue = groupAssignmentsByIssue(assignments);

      for (const [issueKey, sessionIds] of byIssue.entries()) {
        matchedCount += await assignMatchedSessions({
          supabaseConfig,
          userId,
          organizationId,
          accountId,
          cloudId,
          issueKey,
          sessionIds,
          autoSyncEnabledOverride: autoSyncEnabled
        });
      }

      const allAssignments = [...(progress.assignments || []), ...assignments];

      cursor += sessionChunk.length;
      processedSessions += sessionChunk.length;
      processedChunks += 1;

      updatedRow = await updateSyncJob({
        supabaseConfig,
        jobId: jobRow.id,
        patch: {
          status: cursor >= sessions.length ? SYNC_JOB_STATUS.COMPLETED : SYNC_JOB_STATUS.IN_PROGRESS,
          completed_at: cursor >= sessions.length ? new Date().toISOString() : null,
          payload: { ...payload, cursor },
          progress: {
            ...progress,
            cursor,
            processedSessions,
            processedChunks,
            matchedCount,
            issuesScanned: issues.length,
            assignments: allAssignments,
            reason: cursor >= sessions.length
              ? (matchedCount > 0 ? 'assigned' : 'no_llm_matches')
              : 'processing'
          },
          result: cursor >= sessions.length
            ? {
                matchedCount,
                sessionsScanned: sessions.length,
                issuesScanned: issues.length,
                reason: matchedCount > 0 ? 'assigned' : 'no_llm_matches',
                assignments: allAssignments
              }
            : null
        }
      }) || updatedRow;

      if (cursor >= sessions.length) {
        return updatedRow;
      }
    }

    return updatedRow;
  } catch (err) {
    updatedRow = await updateSyncJob({
      supabaseConfig,
      jobId: jobRow.id,
      patch: {
        status: SYNC_JOB_STATUS.FAILED,
        completed_at: new Date().toISOString(),
        error: err.message || 'sync job failed',
        progress: {
          ...progress,
          cursor,
          processedSessions,
          processedChunks,
          matchedCount,
          issuesScanned: issues.length,
          reason: 'failed'
        }
      }
    }) || updatedRow;
    return updatedRow;
  }
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

async function fetchPreviousDayUnassignedSessions(supabaseConfig, userId, organizationId, options = {}) {
  const { startIso, endIso } = getTimeframeBoundsIso(options.timeframe);
  const maxSessions = Number.isFinite(options.maxSessions) && options.maxSessions > 0
    ? Math.floor(options.maxSessions)
    : Number.POSITIVE_INFINITY;

  // 1. Fetch activities in the timeframe
  const activityRows = ensureArray(await supabaseRequest(
    supabaseConfig,
    `activity_records?user_id=eq.${userId}&organization_id=eq.${organizationId}` +
    `&user_assigned_issue_key=is.null&status=in.(pending,processing,analyzed)` +
    `&classification=in.(productive,unknown)&clustering_dismissed=eq.false` +
    `&start_time=gte.${startIso}&start_time=lt.${endIso}` +
    `&select=id,window_title,application_name,ocr_text,duration_seconds,total_time_seconds`
  ));

  const legacyRows = ensureArray(await supabaseRequest(
    supabaseConfig,
    `unassigned_activity?user_id=eq.${userId}&organization_id=eq.${organizationId}` +
    `&manually_assigned=eq.false&clustering_dismissed=eq.false` +
    `&timestamp=gte.${startIso}&timestamp=lt.${endIso}` +
    `&select=id,window_title,application_name,extracted_text,time_spent_seconds`
  ));

  const activityIds = sanitizeUUIDArray(activityRows.map(r => r.id));
  const legacyIds = sanitizeUUIDArray(legacyRows.map(r => r.id));

  if (activityIds.length === 0 && legacyIds.length === 0) return [];

  const ID_QUERY_CHUNK_SIZE = 300;
  const chunkIds = (ids) => {
    const chunks = [];
    for (let i = 0; i < ids.length; i += ID_QUERY_CHUNK_SIZE) {
      chunks.push(ids.slice(i, i + ID_QUERY_CHUNK_SIZE));
    }
    return chunks;
  };

  // 2. Map IDs to group members
  const members = [];
  for (const chunk of chunkIds(activityIds)) {
    const rows = await supabaseRequest(
      supabaseConfig,
      `unassigned_group_members?activity_record_id=in.(${chunk.join(',')})&select=group_id,activity_record_id`
    );
    members.push(...ensureArray(rows));
  }
  for (const chunk of chunkIds(legacyIds)) {
    const rows = await supabaseRequest(
      supabaseConfig,
      `unassigned_group_members?unassigned_activity_id=in.(${chunk.join(',')})&select=group_id,unassigned_activity_id`
    );
    members.push(...ensureArray(rows));
  }

  const groupIdsToVerify = sanitizeUUIDArray([...new Set(members.map(m => m.group_id).filter(Boolean))]);
  if (groupIdsToVerify.length === 0) return [];

  // 3. Verify which groups are still unassigned and undismissed
  const validGroups = [];
  for (const chunk of chunkIds(groupIdsToVerify)) {
    const rows = await supabaseRequest(
      supabaseConfig,
      `unassigned_work_groups?id=in.(${chunk.join(',')})&user_id=eq.${userId}&organization_id=eq.${organizationId}` +
      `&is_assigned=eq.false&is_dismissed=eq.false&select=id`
    );
    validGroups.push(...ensureArray(rows));
  }

  const validGroupIds = new Set(validGroups.map(g => g.id));

  // 4. Build ID to Group ID map (only for valid groups)
  const idToGroupId = new Map();
  for (const m of members) {
    if (m.group_id && validGroupIds.has(m.group_id)) {
      if (m.activity_record_id) idToGroupId.set(m.activity_record_id, m.group_id);
      if (m.unassigned_activity_id) idToGroupId.set(m.unassigned_activity_id, m.group_id);
    }
  }

  // 5. Construct final sessions, limiting to maxSessions
  const sessions = [];

  for (const record of activityRows) {
    if (!record?.id || !idToGroupId.has(record.id)) continue;
    sessions.push({
      sessionId: record.id,
      groupId: idToGroupId.get(record.id),
      applicationName: record.application_name || '',
      windowTitle: record.window_title || '',
      screenText: (record.ocr_text || '').slice(0, 500),
      durationSeconds: record.duration_seconds || record.total_time_seconds || 0,
      source: 'activity_records'
    });
    if (sessions.length >= maxSessions) return sessions;
  }

  for (const record of legacyRows) {
    if (!record?.id || !idToGroupId.has(record.id)) continue;
    sessions.push({
      sessionId: record.id,
      groupId: idToGroupId.get(record.id),
      applicationName: record.application_name || '',
      windowTitle: record.window_title || '',
      screenText: (record.extracted_text || '').slice(0, 500),
      durationSeconds: record.time_spent_seconds || 0,
      source: 'unassigned_activity'
    });
    if (sessions.length >= maxSessions) return sessions;
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
  sessionIds,
  autoSyncEnabledOverride
}) {
  const validSessionIds = sanitizeUUIDArray(sessionIds);
  if (validSessionIds.length === 0) return 0;

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

  let groupMembersByGroupId = new Map();
  if (groupIds.length > 0) {
    const groupIdsParam = groupIds.join(',');
    const allGroupMembers = ensureArray(await supabaseRequest(
      supabaseConfig,
      `unassigned_group_members?group_id=in.(${groupIdsParam})&select=group_id,activity_record_id,unassigned_activity_id`
    ));

    groupMembersByGroupId = allGroupMembers.reduce((acc, member) => {
      if (!member?.group_id) {
        return acc;
      }
      const existing = acc.get(member.group_id) || [];
      existing.push(member);
      acc.set(member.group_id, existing);
      return acc;
    }, new Map());
  }

  for (const groupId of groupIds) {
    const groupMembers = groupMembersByGroupId.get(groupId) || [];
    const memberSessionIds = groupMembers
      .flatMap((m) => [m.activity_record_id, m.unassigned_activity_id])
      .filter(Boolean);
    if (memberSessionIds.length > 0 && memberSessionIds.every((id) => sessionIdsSet.has(id))) {
      await markGroupAsAssigned({ groupId, issueKey, userId, supabaseConfig });
    }
  }

  const timeToLog = await sumSessionDurations(supabaseConfig, userId, organizationId, validSessionIds);
  const autoSyncEnabled = typeof autoSyncEnabledOverride === 'boolean'
    ? autoSyncEnabledOverride
    : await isAutoSyncEnabled(accountId, cloudId);
  await createWorklogIfNeeded({
    issueKey,
    timeToLog,
    sessionCount: validSessionIds.length,
    autoSyncEnabled,
    customComment: 'Time tracked from unassigned work, auto-matched during Jira sync.'
  });

  return validSessionIds.length;
}

async function fetchInProgressIssueKeysFromJira() {
  const jql = 'assignee = currentUser() AND resolution = EMPTY AND statusCategory = "In Progress" ORDER BY updated DESC';
  try {
    const response = await api.asUser().requestJira(
      route`/rest/api/3/search/jql`,
      {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jql,
          maxResults: 50,
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

function buildAttachmentContext(rawAttachments) {
  if (!Array.isArray(rawAttachments) || rawAttachments.length === 0) return '';

  return rawAttachments
    .slice(0, 8)
    .map((att) => {
      const filename = att?.filename || 'unnamed';
      const mimeType = att?.mimeType || 'unknown';
      const size = Number(att?.size) || 0;
      const sizeText = size > 0 ? `${size} bytes` : 'size unknown';
      return `${filename} (${mimeType}, ${sizeText})`;
    })
    .join('\n');
}

async function fetchIssuesFromJira(issueKeys) {
  const issues = [];
  for (const issueKey of issueKeys) {
    try {
      const { title, description, rawAttachments } = await fetchIssueForAnalysis(issueKey);
      issues.push({
        issueKey,
        title,
        description,
        attachmentContext: buildAttachmentContext(rawAttachments)
      });
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
        requestImprovement,
        parentContext,
        attachments,
        documents,
        linkedIssues,
        accountId: context?.accountId,
        cloudId: context?.cloudId
      };

      const data = await remoteRequest('/api/forge/description/analyze', {
        method: 'POST',
        body
      });

      // remoteRequest unwraps { success, data } when the upstream uses that
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
      const sessions = await fetchPreviousDayUnassignedSessions(supabaseConfig, userId, organization.id, {
        maxSessions: 100
      });
      if (sessions.length === 0) {
        return { success: true, matchedCount: 0 };
      }

      const { title, description, rawAttachments } = await fetchIssueForAnalysis(issueKey);
      const attachmentContext = buildAttachmentContext(rawAttachments);
      const sessionChunks = chunkArray(sessions, MAX_SESSIONS_PER_LLM_CALL);
      const matchedSessionIdSet = new Set();

      for (const sessionChunk of sessionChunks) {
        const matchData = await remoteRequest('/api/forge/description/sync-issue-unassigned', {
          method: 'POST',
          body: { issueKey, title, description, attachmentContext, sessions: sessionChunk }
        });
        const chunkMatchedSessionIds = Array.isArray(matchData?.matchedSessionIds)
          ? matchData.matchedSessionIds
          : [];
        for (const sessionId of chunkMatchedSessionIds) {
          matchedSessionIdSet.add(sessionId);
        }
      }

      const matchedSessionIds = Array.from(matchedSessionIdSet);
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
        fetchPreviousDayUnassignedSessions(supabaseConfig, userId, organization.id, {
          maxSessions: 100
        }),
        fetchInProgressIssueKeysFromJira()
      ]);

      console.log(
        '[descriptionResolvers] syncRecentUnassignedWorkWithAllUpdatedIssues: previousDaySessions=%d inProgressIssues=%d',
        sessions.length,
        issueKeys.length
      );

      if (sessions.length === 0) {
        return {
          success: true,
          matchedCount: 0,
          reason: 'no_previous_day_sessions',
          sessionsScanned: 0,
          issuesScanned: 0
        };
      }

      if (issueKeys.length === 0) {
        return {
          success: true,
          matchedCount: 0,
          reason: 'no_in_progress_issues',
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

      const sessionChunks = chunkArray(sessions, MAX_SESSIONS_PER_LLM_CALL);
      const assignments = [];
      for (const sessionChunk of sessionChunks) {
        const matchData = await remoteRequest('/api/forge/description/sync-all-unassigned', {
          method: 'POST',
          body: { issues, sessions: sessionChunk }
        });
        const chunkAssignments = Array.isArray(matchData?.assignments) ? matchData.assignments : [];
        assignments.push(...chunkAssignments);
      }

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

  resolver.define('startUnassignedSyncWithJiraJob', async (req) => {
    try {
      const ctx = await initializeRequestContext(req);
      if (!ctx.success) return ctx;

      const { config: supabaseConfig, organization, userId, accountId, cloudId } = ctx;
      const { timeframe = 'yesterday' } = req.payload || {};
      const [sessions, issueKeys] = await Promise.all([
        fetchPreviousDayUnassignedSessions(supabaseConfig, userId, organization.id, {
          maxSessions: 100,
          timeframe
        }),
        fetchInProgressIssueKeysFromJira()
      ]);

      if (sessions.length === 0) {
        return {
          success: true,
          status: SYNC_JOB_STATUS.COMPLETED,
          matchedCount: 0,
          reason: 'no_previous_day_sessions',
          sessionsScanned: 0,
          sessionsProcessed: 0,
          issuesScanned: 0
        };
      }

      if (issueKeys.length === 0) {
        return {
          success: true,
          status: SYNC_JOB_STATUS.COMPLETED,
          matchedCount: 0,
          reason: 'no_in_progress_issues',
          sessionsScanned: sessions.length,
          sessionsProcessed: 0,
          issuesScanned: 0
        };
      }

      const issues = await fetchIssuesFromJira(issueKeys);
      if (issues.length === 0) {
        return {
          success: true,
          status: SYNC_JOB_STATUS.COMPLETED,
          matchedCount: 0,
          reason: 'no_issue_details',
          sessionsScanned: sessions.length,
          sessionsProcessed: 0,
          issuesScanned: 0
        };
      }

      const totalSessions = sessions.length;
      const totalIssues = issues.length;
      let jobRow = await insertSyncJob({
        supabaseConfig,
        userId,
        organizationId: organization.id,
        payload: {
          sessions,
          issues,
          cursor: 0,
          totalSessions,
          totalIssues
        },
        progress: {
          cursor: 0,
          processedSessions: 0,
          processedChunks: 0,
          matchedCount: 0,
          issuesScanned: totalIssues,
          reason: 'queued'
        }
      });

      if (!jobRow?.id) {
        return failure('Failed to create sync job');
      }

      // Return immediately with queued job. UI polling will handle all processing.
      return toJobResponse(jobRow);
    } catch (err) {
      console.error('[descriptionResolvers] startUnassignedSyncWithJiraJob failed:', err.message);
      return handleResolverError(err, 'starting async unassigned sync job');
    }
  });

  resolver.define('getUnassignedSyncWithJiraJobStatus', async (req) => {
    try {
      const ctx = await initializeRequestContext(req);
      if (!ctx.success) return ctx;
      const { config: supabaseConfig, organization, userId, accountId, cloudId } = ctx;
      const jobId = req.payload?.jobId;
      if (!jobId) return failure('Missing jobId');

      let jobRow = await getSyncJobById({
        supabaseConfig,
        jobId,
        userId,
        organizationId: organization.id
      });

      if (!jobRow) {
        return failure('Sync job not found');
      }

      if (isSyncJobActivelyProcessing(jobRow)) {
        return toJobResponse(jobRow);
      }

      if (jobRow.status === SYNC_JOB_STATUS.QUEUED || jobRow.status === SYNC_JOB_STATUS.IN_PROGRESS) {
        jobRow = await processSyncJobWithinBudget({
          supabaseConfig,
          userId,
          organizationId: organization.id,
          accountId,
          cloudId,
          jobRow,
          budgetMs: MAX_SYNC_INVOCATION_BUDGET_MS
        });
      }

      return toJobResponse(jobRow);
    } catch (err) {
      console.error('[descriptionResolvers] getUnassignedSyncWithJiraJobStatus failed:', err.message);
      return handleResolverError(err, 'getting async unassigned sync job status');
    }
  });

  resolver.define('getUnassignedSyncCounts', async (req) => {
    try {
      const ctx = await initializeRequestContext(req);
      if (!ctx.success) return ctx;

      const { config: supabaseConfig, organization, userId } = ctx;
      const { timeframe = 'yesterday' } = req.payload || {};

      const sessions = await fetchPreviousDayUnassignedSessions(supabaseConfig, userId, organization.id, {
        timeframe,
        maxSessions: Number.POSITIVE_INFINITY
      });

      const activeGroupIds = new Set();
      for (const s of sessions) {
        if (s.groupId) activeGroupIds.add(s.groupId);
      }

      return { success: true, groupCount: activeGroupIds.size, memberCount: sessions.length };
    } catch (err) {
      console.error('[descriptionResolvers] getUnassignedSyncCounts failed:', err.message);
      return handleResolverError(err, 'getting unassigned sync counts');
    }
  });
}
