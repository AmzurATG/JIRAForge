'use strict';

/**
 * Description Quality Controller
 *
 * POST /api/forge/description/analyze
 *   Analyzes a Jira ticket's title + description, returns quality score,
 *   issues, suggestions, and optionally an AI-improved version.
 *
 * POST /api/forge/description/event
 *   Records an analytics event (accept / edit / reject) from the Forge UI.
 *
 * Both endpoints are gated by forgeAuthMiddleware (FIT token) before they
 * reach this controller. req.forgeContext = { cloudId, accountId }.
 */

const logger = require('../utils/logger');
const descriptionService = require('../services/description-service');

const ISSUE_KEY_RE = /^[A-Z][A-Z0-9]+-\d+$/;
const PROJECT_KEY_RE = /^[A-Z][A-Z0-9]+$/;
const ALLOWED_ISSUE_TYPES = new Set(['Bug', 'Story', 'Task', 'Epic', 'Sub-task']);
const ALLOWED_EVENTS = new Set(['analyze', 'improve', 'accept', 'edit', 'reject']);

const MAX_TITLE_LEN = 500;
const MAX_DESCRIPTION_LEN = 50000;
const MAX_PROJECT_KEY_LEN = 20;
const MAX_ISSUE_KEY_LEN = 50;
const MAX_ATTACHMENTS = 3;
const MAX_ATTACHMENT_SIZE = 2 * 1024 * 1024; // 2 MB base64
const MAX_DOCUMENTS = 3;
const MAX_DOCUMENT_SIZE = 3 * 1024 * 1024; // 3 MB base64 (docs can be larger)
const MAX_PARENT_DESC_LEN = 5000;
const MAX_LINKED_ISSUES = 5;
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/gif']);
const ALLOWED_DOCUMENT_TYPES = new Set([
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
  'text/csv'
]);

function badRequest(res, message) {
  return res.status(400).json({ success: false, error: message });
}

function validateAnalyzePayload(body) {
  if (!body || typeof body !== 'object') return 'Request body must be a JSON object';

  const { issueKey, title, description, issueType, projectKey, requestImprovement, parentContext, attachments } = body;

  if (typeof issueKey !== 'string' || issueKey.length === 0) return 'Missing required field: issueKey';
  if (issueKey.length > MAX_ISSUE_KEY_LEN || !ISSUE_KEY_RE.test(issueKey)) return 'Invalid issueKey format';

  if (typeof title !== 'string' || title.length === 0) return 'Missing required field: title';
  if (title.length > MAX_TITLE_LEN) return `title exceeds max length (${MAX_TITLE_LEN})`;

  if (typeof description !== 'string') return 'Missing required field: description';
  if (description.length > MAX_DESCRIPTION_LEN) return `description exceeds max length (${MAX_DESCRIPTION_LEN})`;

  if (typeof issueType !== 'string' || !ALLOWED_ISSUE_TYPES.has(issueType)) return 'Invalid issueType';

  if (typeof projectKey !== 'string' || projectKey.length === 0) return 'Missing required field: projectKey';
  if (projectKey.length > MAX_PROJECT_KEY_LEN || !PROJECT_KEY_RE.test(projectKey)) return 'Invalid projectKey format';

  if (requestImprovement !== undefined && typeof requestImprovement !== 'boolean') {
    return 'requestImprovement must be a boolean';
  }

  // Validate parentContext (optional)
  if (parentContext !== undefined && parentContext !== null) {
    if (typeof parentContext !== 'object') return 'parentContext must be an object or null';
    if (parentContext.key && (typeof parentContext.key !== 'string' || !ISSUE_KEY_RE.test(parentContext.key))) {
      return 'parentContext.key has invalid format';
    }
    if (parentContext.description && typeof parentContext.description === 'string' && parentContext.description.length > MAX_PARENT_DESC_LEN) {
      return `parentContext.description exceeds max length (${MAX_PARENT_DESC_LEN})`;
    }
  }

  // Validate attachments (optional)
  if (attachments !== undefined && attachments !== null) {
    if (!Array.isArray(attachments)) return 'attachments must be an array or null';
    if (attachments.length > MAX_ATTACHMENTS) return `attachments exceeds max count (${MAX_ATTACHMENTS})`;
    for (let i = 0; i < attachments.length; i++) {
      const att = attachments[i];
      if (!att || typeof att !== 'object') return `attachments[${i}] must be an object`;
      if (typeof att.data !== 'string' || att.data.length === 0) return `attachments[${i}].data is required`;
      if (att.data.length > MAX_ATTACHMENT_SIZE) return `attachments[${i}].data exceeds max size (2 MB)`;
      if (!att.mimeType || !ALLOWED_IMAGE_TYPES.has(att.mimeType)) {
        return `attachments[${i}].mimeType must be one of: ${[...ALLOWED_IMAGE_TYPES].join(', ')}`;
      }
    }
  }

  // Validate documents (optional) — PDF, DOCX, text files
  const { documents, linkedIssues } = body;
  if (documents !== undefined && documents !== null) {
    if (!Array.isArray(documents)) return 'documents must be an array or null';
    if (documents.length > MAX_DOCUMENTS) return `documents exceeds max count (${MAX_DOCUMENTS})`;
    for (let i = 0; i < documents.length; i++) {
      const doc = documents[i];
      if (!doc || typeof doc !== 'object') return `documents[${i}] must be an object`;
      if (typeof doc.data !== 'string' || doc.data.length === 0) return `documents[${i}].data is required`;
      if (doc.data.length > MAX_DOCUMENT_SIZE) return `documents[${i}].data exceeds max size (3 MB)`;
      if (!doc.mimeType || !ALLOWED_DOCUMENT_TYPES.has(doc.mimeType)) {
        return `documents[${i}].mimeType must be one of: ${[...ALLOWED_DOCUMENT_TYPES].join(', ')}`;
      }
      if (!doc.filename || typeof doc.filename !== 'string') return `documents[${i}].filename is required`;
    }
  }

  // Validate linkedIssues (optional)
  if (linkedIssues !== undefined && linkedIssues !== null) {
    if (!Array.isArray(linkedIssues)) return 'linkedIssues must be an array or null';
    if (linkedIssues.length > MAX_LINKED_ISSUES) return `linkedIssues exceeds max count (${MAX_LINKED_ISSUES})`;
    for (let i = 0; i < linkedIssues.length; i++) {
      const link = linkedIssues[i];
      if (!link || typeof link !== 'object') return `linkedIssues[${i}] must be an object`;
      if (!link.key || typeof link.key !== 'string') return `linkedIssues[${i}].key is required`;
      if (!ISSUE_KEY_RE.test(link.key)) return `linkedIssues[${i}].key has invalid format`;
      if (!link.linkType || typeof link.linkType !== 'string') return `linkedIssues[${i}].linkType is required`;
    }
  }

  return null;
}

function validateEventPayload(body) {
  if (!body || typeof body !== 'object') return 'Request body must be a JSON object';
  const { issueKey, eventType, scoreBefore, scoreAfter, source } = body;

  if (typeof issueKey !== 'string' || !ISSUE_KEY_RE.test(issueKey)) return 'Invalid issueKey';
  if (typeof eventType !== 'string' || !ALLOWED_EVENTS.has(eventType)) return 'Invalid eventType';

  if (scoreBefore !== undefined && (typeof scoreBefore !== 'number' || scoreBefore < 0 || scoreBefore > 100)) {
    return 'scoreBefore must be a number 0-100';
  }
  if (scoreAfter !== undefined && (typeof scoreAfter !== 'number' || scoreAfter < 0 || scoreAfter > 100)) {
    return 'scoreAfter must be a number 0-100';
  }
  if (source !== undefined && !['deterministic', 'llm'].includes(source)) {
    return 'Invalid source';
  }
  return null;
}

async function analyze(req, res) {
  const validationError = validateAnalyzePayload(req.body);
  if (validationError) return badRequest(res, validationError);

  const { issueKey, title, description, issueType, projectKey, requestImprovement, parentContext, attachments, documents, linkedIssues } = req.body;
  const { cloudId, accountId } = req.forgeContext || {};

  logger.info('[DescQuality] analyze | issue=%s project=%s type=%s improve=%s parent=%s attachments=%d documents=%d linkedIssues=%d',
    issueKey, projectKey, issueType, !!requestImprovement,
    parentContext?.key || 'none', (attachments || []).length,
    (documents || []).length, (linkedIssues || []).length);

  try {
    const result = await descriptionService.analyzeDescription({
      issueKey,
      title,
      description,
      issueType,
      projectKey,
      requestImprovement: !!requestImprovement,
      orgId: cloudId,
      accountId,
      parentContext: parentContext || null,
      attachments: attachments || null,
      documents: documents || null,
      linkedIssues: linkedIssues || null
    });

    return res.json({
      success: true,
      data: result
    });
  } catch (err) {
    logger.error('[DescQuality] analyze failed for %s: %s', issueKey, err.message);
    return res.status(500).json({ success: false, error: 'Internal server error' });
  }
}

async function recordEvent(req, res) {
  const validationError = validateEventPayload(req.body);
  if (validationError) return badRequest(res, validationError);

  const { issueKey, eventType, scoreBefore, scoreAfter, source } = req.body;
  const { cloudId, accountId } = req.forgeContext || {};

  try {
    await descriptionService.recordEvent({
      orgId: cloudId,
      accountId,
      issueKey,
      eventType,
      scoreBefore,
      scoreAfter,
      source
    });
    return res.json({ success: true });
  } catch (err) {
    logger.warn('[DescQuality] recordEvent failed for %s: %s', issueKey, err.message);
    // Analytics failures should not break the UX.
    return res.json({ success: true });
  }
}

module.exports = {
  analyze,
  recordEvent
};
