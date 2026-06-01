'use strict';

/**
 * Description Service
 *
 * Provides AI-assisted Jira ticket description quality analysis:
 * - Deterministic rule-based scoring (no LLM cost)
 * - PII sanitization before any LLM call
 * - LLM-based improvement when score < threshold or explicitly requested
 * - Schema validation + retry of LLM responses
 * - Supabase-backed result cache keyed on content hash
 */

const crypto = require('node:crypto');

const logger = require('../utils/logger');
const { chatCompletionWithFallback, isPortkeyEnabled } = require('./ai/ai-client');
const { buildMessages } = require('./ai/description-prompts');
const { extractAllDocuments } = require('./document-extractor');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LLM_GATE_THRESHOLD = 80;          // Score >= threshold skips LLM
const LLM_TIMEOUT_MS = 8000;            // 8 second LLM timeout per attempt
const LLM_MAX_TOKENS = 2000;
const LLM_TEMPERATURE = 0.3;
const TITLE_MIN = 10;
const TITLE_MAX = 80;
const DESC_MIN = 50;

const PLACEHOLDER_PATTERNS = [
  /\bTODO\b/i,
  /\bTBD\b/i,
  /\bfill[\s-]?in\b/i,
  /\[placeholder\]/i,
  /\bXXX\b/,
  /\bFIXME\b/i
];

const STEPS_PATTERNS = [
  /steps?\s+to\s+reproduce/i,
  /^\s*\d+[.)]\s+/m,        // numbered list
  /^\s*step\s*\d+/im
];

const EXPECTED_ACTUAL_PATTERNS = {
  expected: /\b(expected|should)\b/i,
  actual: /\b(actual|instead|happens|got)\b/i
};

const ACCEPTANCE_PATTERNS = [
  /acceptance\s+criteria/i,
  /\bgiven\b[\s\S]{0,200}\bwhen\b[\s\S]{0,200}\bthen\b/i,
  /\bAC[:\s]/
];

const ENV_PATTERNS = [
  /\b(windows|macos|linux|ubuntu|debian|ios|android)\b/i,
  /\b(chrome|firefox|safari|edge|opera|brave)\b/i,
  /\bversion\s*[:=]?\s*\d/i,
  /\bv\d+\.\d+/i,
  /\benvironment\b/i,
  /\b(staging|production|prod|dev|qa)\b/i
];

const ACTION_VERBS = [
  /\b(implement|add|fix|update|create|remove|refactor|investigate|verify|enable|disable|deploy|migrate|build|configure|integrate|design|test)\b/i
];

const GENERIC_TITLE_WORDS = new Set([
  'bug', 'issue', 'problem', 'error', 'task', 'todo',
  'fix', 'update', 'change', 'thing', 'something'
]);

// ---------------------------------------------------------------------------
// PII Sanitization
// ---------------------------------------------------------------------------

// Patterns must NOT use the global flag because some are reused; create per-call.
function piiPatterns() {
  return [
    { name: 'EMAIL', re: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, replacement: '[EMAIL]' },
    { name: 'JWT', re: /eyJ[A-Za-z0-9-_]+\.eyJ[A-Za-z0-9-_]+\.[A-Za-z0-9-_]+/g, replacement: '[TOKEN]' },
    { name: 'OPENAI_KEY', re: /sk-[a-zA-Z0-9]{20,}/g, replacement: '[API_KEY]' },
    { name: 'AWS_KEY', re: /AKIA[0-9A-Z]{16}/g, replacement: '[API_KEY]' },
    { name: 'CC', re: /\b(?:\d[ -]?){13,16}\b/g, replacement: '[CREDIT_CARD]' },
    { name: 'PHONE_INTL', re: /\+\d{1,3}[\s-]?\d{4,14}/g, replacement: '[PHONE]' },
    { name: 'PHONE_US', re: /\b\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/g, replacement: '[PHONE]' },
    { name: 'IP', re: /\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, replacement: '[IP_ADDRESS]' },
    // Atlassian account IDs are 24 hex chars; require word boundaries
    { name: 'ATL_ID', re: /\b[0-9a-f]{24}\b/g, replacement: '[ACCOUNT_ID]' }
  ];
}

/**
 * Sanitize text by redacting common PII patterns.
 * Safe on empty / null / non-string input (returns empty string).
 * @param {string} text
 * @returns {string}
 */
function sanitizePII(text) {
  if (!text || typeof text !== 'string') return '';
  let out = text;
  for (const p of piiPatterns()) {
    out = out.replace(p.re, p.replacement);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Deterministic scorer
// ---------------------------------------------------------------------------

/**
 * The full criteria definition with default weights. Weight redistribution
 * happens at scoring time for criteria that don't apply to the issue type.
 */
const CRITERIA = [
  { id: 'title_length', weight: 10, appliesTo: 'all' },
  { id: 'title_specific', weight: 10, appliesTo: 'all' },
  { id: 'desc_length', weight: 15, appliesTo: 'all' },
  { id: 'steps_to_reproduce', weight: 15, appliesTo: 'Bug' },
  { id: 'expected_actual', weight: 15, appliesTo: 'Bug' },
  { id: 'acceptance_criteria', weight: 15, appliesTo: 'Story' },
  { id: 'no_placeholder', weight: 10, appliesTo: 'all' },
  { id: 'environment', weight: 10, appliesTo: 'all' },
  { id: 'actionability', weight: 15, appliesTo: 'all' }
];

function criteriaApply(c, issueType) {
  if (c.appliesTo === 'all') return true;
  return c.appliesTo === issueType;
}

function isGenericTitle(title) {
  const words = title.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  if (words.length <= 2 && words.every(w => GENERIC_TITLE_WORDS.has(w))) return true;
  return false;
}

function evaluateCriterion(id, title, description) {
  const text = `${title || ''}\n${description || ''}`;
  switch (id) {
    case 'title_length': {
      const len = (title || '').trim().length;
      return len >= TITLE_MIN && len <= TITLE_MAX;
    }
    case 'title_specific':
      return !isGenericTitle(title || '');
    case 'desc_length':
      return (description || '').trim().length >= DESC_MIN;
    case 'steps_to_reproduce':
      return STEPS_PATTERNS.some(re => re.test(description || ''));
    case 'expected_actual':
      return EXPECTED_ACTUAL_PATTERNS.expected.test(description || '') &&
             EXPECTED_ACTUAL_PATTERNS.actual.test(description || '');
    case 'acceptance_criteria':
      return ACCEPTANCE_PATTERNS.some(re => re.test(description || ''));
    case 'no_placeholder':
      return !PLACEHOLDER_PATTERNS.some(re => re.test(text));
    case 'environment':
      return ENV_PATTERNS.some(re => re.test(description || ''));
    case 'actionability':
      return ACTION_VERBS.some(re => re.test(text));
    default:
      return false;
  }
}

const ISSUE_FOR_CRITERION = {
  title_length: 'Title is too short or too long (target 10–80 characters)',
  title_specific: 'Title is too generic and does not describe the specific problem',
  desc_length: 'Description is too short — add more detail (minimum 50 characters)',
  steps_to_reproduce: 'Missing steps to reproduce',
  expected_actual: 'Missing expected and/or actual behavior',
  acceptance_criteria: 'Missing acceptance criteria',
  no_placeholder: 'Contains placeholder text (TODO, TBD, fill in, etc.)',
  environment: 'Missing environment / context details (OS, browser, version)',
  actionability: 'No clear action — add verbs that describe what needs to be done'
};

const SUGGESTION_FOR_CRITERION = {
  title_length: 'Make the title between 10 and 80 characters and avoid one-word titles',
  title_specific: 'Make the title specific: include the affected area, action, and observed symptom',
  desc_length: 'Expand the description with context, repro steps, or acceptance criteria',
  steps_to_reproduce: 'Add a numbered "Steps to Reproduce" section with concrete actions',
  expected_actual: 'Add "Expected Result" and "Actual Result" sections side by side',
  acceptance_criteria: 'Add testable acceptance criteria, ideally in Given/When/Then format',
  no_placeholder: 'Replace placeholder text with real content or remove it',
  environment: 'Specify environment: OS, browser/device, app version, region',
  actionability: 'State a clear next action or deliverable using an active verb'
};

/**
 * Run the deterministic scorer and return a normalized result. Non-applicable
 * criteria have their weight redistributed pro-rata to the criteria that DO
 * apply so the final score always sits on a 0..100 scale.
 *
 * @param {Object} params
 * @param {string} params.title
 * @param {string} params.description
 * @param {string} params.issueType
 * @returns {{score: number, issues: string[], suggestions: string[],
 *           failedCriteria: string[], applicableCriteria: string[]}}
 */
function scoreDeterministic({ title, description, issueType }) {
  const applicable = CRITERIA.filter(c => criteriaApply(c, issueType));
  const totalApplicableWeight = applicable.reduce((sum, c) => sum + c.weight, 0);
  // Guard against zero (shouldn't happen given the schema) — fall back to 1.
  const denom = totalApplicableWeight > 0 ? totalApplicableWeight : 1;

  let earnedNormalized = 0;
  const failed = [];
  const passed = [];

  for (const c of applicable) {
    const passes = evaluateCriterion(c.id, title, description);
    if (passes) {
      passed.push(c.id);
      earnedNormalized += c.weight;
    } else {
      failed.push(c.id);
    }
  }

  // Scale to /100
  const score = Math.round((earnedNormalized / denom) * 100);

  const issues = failed.map(id => ISSUE_FOR_CRITERION[id]).filter(Boolean);
  const suggestions = failed.map(id => SUGGESTION_FOR_CRITERION[id]).filter(Boolean);

  return {
    score: Math.max(0, Math.min(100, score)),
    issues,
    suggestions,
    failedCriteria: failed,
    applicableCriteria: applicable.map(c => c.id),
    passedCriteria: passed
  };
}

// ---------------------------------------------------------------------------
// Content hash (for cache invalidation)
// ---------------------------------------------------------------------------

function generateContentHash(title, description, issueType) {
  const content = `${title || ''}\n${description || ''}\n${issueType || ''}`;
  return crypto.createHash('sha256').update(content).digest('hex');
}

// ---------------------------------------------------------------------------
// LLM response validation
// ---------------------------------------------------------------------------

function validateLLMResponse(parsed) {
  if (!parsed || typeof parsed !== 'object') return false;
  if (!Number.isFinite(parsed.score)) return false;
  if (parsed.score < 0 || parsed.score > 100) return false;
  if (!Array.isArray(parsed.issues) || parsed.issues.length < 1 || parsed.issues.length > 5) return false;
  if (!parsed.issues.every(s => typeof s === 'string' && s.length > 0)) return false;
  if (!Array.isArray(parsed.suggestions) || parsed.suggestions.length < 1 || parsed.suggestions.length > 5) return false;
  if (!parsed.suggestions.every(s => typeof s === 'string' && s.length > 0)) return false;
  if (typeof parsed.improved_title !== 'string' || parsed.improved_title.length === 0 || parsed.improved_title.length > 200) return false;
  if (typeof parsed.improved_description !== 'string' || parsed.improved_description.length === 0) return false;
  return true;
}

function parseLLMContent(content) {
  if (!content || typeof content !== 'string') return null;
  // Try direct JSON parse first; fall back to extracting the first {...} block.
  try {
    return JSON.parse(content);
  } catch {
    const match = content.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

// ---------------------------------------------------------------------------
// LLM invocation with timeout + one retry on malformed JSON
// ---------------------------------------------------------------------------

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

async function invokeLLMOnce({ title, description, issueType, stricterJson, parentContext, attachments, documentTexts, linkedIssues }) {
  const messages = buildMessages({ title, description, issueType, stricterJson, parentContext, attachments, documentTexts, linkedIssues });
  const hasImages = Array.isArray(attachments) && attachments.length > 0;
  const { response } = await withTimeout(
    chatCompletionWithFallback({
      messages,
      max_tokens: LLM_MAX_TOKENS,
      temperature: LLM_TEMPERATURE,
      isVision: hasImages,
      response_format: { type: 'json_object' }
    }),
    LLM_TIMEOUT_MS,
    'LLM'
  );
  const content = response?.choices?.[0]?.message?.content || '';
  return parseLLMContent(content);
}

/**
 * Run an LLM analysis with up to one retry on malformed/invalid JSON.
 * Returns null if both attempts fail or LLM is unavailable.
 */
async function runLLMAnalysis({ sanitizedTitle, sanitizedDescription, issueType, parentContext, attachments, documentTexts, linkedIssues }) {
  if (!isPortkeyEnabled()) {
    logger.warn('[DescQuality] LLM unavailable: Portkey not enabled');
    return null;
  }

  try {
    const first = await invokeLLMOnce({
      title: sanitizedTitle,
      description: sanitizedDescription,
      issueType,
      stricterJson: false,
      parentContext,
      attachments,
      documentTexts,
      linkedIssues
    });
    if (validateLLMResponse(first)) return first;

    logger.warn('[DescQuality] LLM response malformed on first attempt — retrying with stricter JSON instruction');
    const second = await invokeLLMOnce({
      title: sanitizedTitle,
      description: sanitizedDescription,
      issueType,
      stricterJson: true,
      parentContext,
      attachments,
      documentTexts,
      linkedIssues
    });
    if (validateLLMResponse(second)) return second;

    logger.warn('[DescQuality] LLM response still malformed after retry — falling back to deterministic result');
    return null;
  } catch (err) {
    logger.error('[DescQuality] LLM call failed: %s', err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cache layer (Supabase)
// ---------------------------------------------------------------------------

const CACHE_TABLE = 'description_quality_cache';

async function getSupabaseClient(getClientFn) {
  // Allow dependency injection for tests; default to real client.
  if (getClientFn) return getClientFn();
  // Lazy require so unit tests that mock the module don't need supabase env vars.
  const { getClient } = require('./db/supabase-client');
  return getClient();
}

async function readCache({ orgId, issueKey, contentHash, getClientFn }) {
  if (!orgId || !issueKey || !contentHash) return null;
  try {
    const supabase = await getSupabaseClient(getClientFn);
    if (!supabase) return null;
    const { data, error } = await supabase
      .from(CACHE_TABLE)
      .select('score, source, issues, suggestions, improved_title, improved_description, content_hash')
      .eq('org_id', orgId)
      .eq('issue_key', issueKey)
      .maybeSingle();
    if (error) {
      logger.warn('[DescQuality] Cache read error: %s', error.message || error);
      return null;
    }
    if (!data || data.content_hash !== contentHash) return null;
    return data;
  } catch (err) {
    logger.warn('[DescQuality] Cache read threw: %s', err.message);
    return null;
  }
}

async function writeCache({ orgId, issueKey, contentHash, issueType, result, getClientFn }) {
  if (!orgId || !issueKey || !contentHash) return;
  try {
    const supabase = await getSupabaseClient(getClientFn);
    if (!supabase) return;
    const row = {
      org_id: orgId,
      issue_key: issueKey,
      content_hash: contentHash,
      issue_type: issueType,
      score: result.score,
      source: result.source,
      issues: result.issues,
      suggestions: result.suggestions,
      improved_title: result.improved_title || null,
      improved_description: result.improved_description || null,
      updated_at: new Date().toISOString()
    };
    const { error } = await supabase
      .from(CACHE_TABLE)
      .upsert(row, { onConflict: 'org_id,issue_key' });
    if (error) {
      logger.warn('[DescQuality] Cache write error: %s', error.message || error);
    }
  } catch (err) {
    logger.warn('[DescQuality] Cache write threw: %s', err.message);
  }
}

async function recordEvent({ orgId, accountId, issueKey, eventType, scoreBefore, scoreAfter, source, getClientFn }) {
  if (!orgId || !issueKey || !eventType) return;
  try {
    const supabase = await getSupabaseClient(getClientFn);
    if (!supabase) return;
    await supabase.from('description_quality_events').insert({
      org_id: orgId,
      account_id: accountId || null,
      issue_key: issueKey,
      event_type: eventType,
      score_before: typeof scoreBefore === 'number' ? scoreBefore : null,
      score_after: typeof scoreAfter === 'number' ? scoreAfter : null,
      source: source || null
    });
  } catch (err) {
    // Analytics is best-effort; never throw.
    logger.debug('[DescQuality] recordEvent skipped: %s', err.message);
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Analyze a Jira ticket description for quality.
 *
 * @param {Object} params
 * @param {string} params.issueKey
 * @param {string} params.title
 * @param {string} params.description
 * @param {string} params.issueType
 * @param {string} [params.projectKey]
 * @param {boolean} [params.requestImprovement]
 * @param {string} [params.orgId]                 - For cache scoping
 * @param {string} [params.accountId]             - For analytics scoping
 * @param {Object} [params.deps]                  - DI hooks for tests
 * @param {Function} [params.deps.getClient]
 * @param {Function} [params.deps.runLLM]
 * @returns {Promise<Object>} Public analysis result
 */
async function analyzeDescription(params) {
  const {
    issueKey,
    title = '',
    description = '',
    issueType = 'Task',
    requestImprovement = false,
    orgId,
    accountId,
    parentContext = null,
    attachments = null,
    documents = null,
    linkedIssues = null,
    deps = {}
  } = params || {};

  const getClientFn = deps.getClient;
  const runLLM = deps.runLLM || runLLMAnalysis;

  // Deterministic pass
  const det = scoreDeterministic({ title, description, issueType });

  let result = {
    score: det.score,
    source: 'deterministic',
    cached: false,
    issues: det.issues,
    suggestions: det.suggestions,
    improved_title: null,
    improved_description: null
  };

  const shouldInvokeLLM = requestImprovement || det.score < LLM_GATE_THRESHOLD;
  if (shouldInvokeLLM) {
    const sanitizedTitle = sanitizePII(title);
    const sanitizedDescription = sanitizePII(description);
    // Sanitize parent context description (title is less likely to have PII but sanitize anyway)
    const sanitizedParent = parentContext ? {
      ...parentContext,
      title: sanitizePII(parentContext.title || ''),
      description: sanitizePII(parentContext.description || '')
    } : null;

    // Extract text from document attachments (PDF, DOCX, text files)
    let documentTexts = null;
    if (Array.isArray(documents) && documents.length > 0) {
      try {
        const extracted = await extractAllDocuments(documents);
        if (extracted.length > 0) {
          documentTexts = extracted.map(d => ({
            filename: d.filename,
            text: sanitizePII(d.text)
          }));
          logger.info('[DescQuality] Extracted text from %d/%d documents for %s', documentTexts.length, documents.length, issueKey);
        }
      } catch (docErr) {
        logger.warn('[DescQuality] Document extraction failed for %s: %s', issueKey, docErr.message);
      }
    }

    // Sanitize linked issues context
    const sanitizedLinkedIssues = Array.isArray(linkedIssues) && linkedIssues.length > 0
      ? linkedIssues.map(li => ({
          ...li,
          title: sanitizePII(li.title || ''),
          description: sanitizePII(li.description || '')
        }))
      : null;

    const llm = await runLLM({
      sanitizedTitle,
      sanitizedDescription,
      issueType,
      parentContext: sanitizedParent,
      attachments,
      documentTexts,
      linkedIssues: sanitizedLinkedIssues
    });
    if (llm) {
      // Only adopt the LLM score when the LLM was invoked for scoring purposes
      // (i.e. the deterministic score was below the gate threshold).
      // When the user explicitly requested improvement on an already-good ticket
      // (det.score >= gate), keep the deterministic score to prevent confusing
      // score regression: clicking "Improve with AI" must never lower the score.
      const llmInvokedForScoring = det.score < LLM_GATE_THRESHOLD;
      result = {
        score: llmInvokedForScoring ? llm.score : det.score,
        source: llmInvokedForScoring ? 'llm' : 'deterministic',
        cached: false,
        issues: llm.issues,
        suggestions: llm.suggestions,
        improved_title: llm.improved_title,
        improved_description: llm.improved_description
      };
    }
  }

  // Best-effort analytics event
  recordEvent({
    orgId,
    accountId,
    issueKey,
    eventType: shouldInvokeLLM ? 'improve' : 'analyze',
    scoreBefore: det.score,
    scoreAfter: result.score,
    source: result.source,
    getClientFn
  });

  return result;
}

module.exports = {
  // Public
  analyzeDescription,
  recordEvent,
  // Internals exposed for unit tests
  sanitizePII,
  scoreDeterministic,
  validateLLMResponse,
  parseLLMContent,
  generateContentHash,
  runLLMAnalysis,
  LLM_GATE_THRESHOLD
};
