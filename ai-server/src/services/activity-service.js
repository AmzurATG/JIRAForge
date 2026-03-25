/**
 * Activity Service
 * Handles text-only AI analysis for the new event-based activity tracking pipeline.
 * - analyzeBatch(): Matches productive activity records to Jira issues (single LLM call)
 * - classifyUnknownApp(): Classifies unknown applications via LLM
 * - identifyAppByName(): Identifies apps by search term using LLM (for admin app classification)
 *
 * Uses the existing AI client with 3-tier fallback (Fireworks → LiteLLM).
 * No vision model needed — all analysis is text-only.
 */

const { chatCompletionWithFallback, isActivityAIEnabled } = require('./ai/ai-client');
const { formatAssignedIssues, APP_IDENTIFICATION_SYSTEM_PROMPT, buildAppIdentificationPrompt } = require('./ai/prompts');
const activityDbService = require('./db/activity-db-service');
const logger = require('../utils/logger');

// ============================================================================
// SERVER-SIDE OCR TEXT SANITIZATION (Defense-in-depth)
// ============================================================================
// Desktop app applies privacy filtering before upload, but we add a second
// layer here to catch anything that slipped through before sending to the LLM.

/**
 * Regex patterns for sensitive data that should never reach the LLM.
 * These match common formats for passwords, API keys, tokens, and PII.
 */
const SANITIZATION_PATTERNS = [
  // Passwords in URLs or config strings: password=xxx, pwd=xxx, passwd=xxx
  { pattern: /(?:password|passwd|pwd|secret|token)\s*[=:]\s*\S+/gi, replacement: '[REDACTED_CREDENTIAL]' },
  // AWS access keys (AKIA...)
  { pattern: /\bAKIA[0-9A-Z]{16}\b/g, replacement: '[REDACTED_AWS_KEY]' },
  // AWS secret keys (40 char base64)
  { pattern: /\b[A-Za-z0-9/+=]{40}\b(?=\s|$|[,;])/g, replacement: '[REDACTED_SECRET]' },
  // GitHub tokens (ghp_, gho_, ghs_, ghr_)
  { pattern: /\bgh[posru]_[A-Za-z0-9_]{36,255}\b/g, replacement: '[REDACTED_GITHUB_TOKEN]' },
  // Generic API keys (api_key=..., apikey=...)
  { pattern: /(?:api[_-]?key|apikey)\s*[=:]\s*\S+/gi, replacement: '[REDACTED_API_KEY]' },
  // Bearer tokens
  { pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*\b/gi, replacement: 'Bearer [REDACTED_TOKEN]' },
  // Credit card numbers (13-19 digits, optionally separated by spaces/dashes)
  { pattern: /\b(?:\d[ -]*?){13,19}\b/g, replacement: '[REDACTED_CARD]' },
  // SSN (US format: XXX-XX-XXXX)
  { pattern: /\b\d{3}-\d{2}-\d{4}\b/g, replacement: '[REDACTED_SSN]' },
  // Private keys
  { pattern: /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----[\s\S]*?-----END\s+(?:RSA\s+)?PRIVATE\s+KEY-----/g, replacement: '[REDACTED_PRIVATE_KEY]' },
  // Connection strings with embedded passwords
  { pattern: /(?:mongodb|postgres|mysql|redis|amqp):\/\/[^\s]+:[^\s@]+@[^\s]+/gi, replacement: '[REDACTED_CONNECTION_STRING]' },
];

/**
 * Sanitize OCR text server-side before sending to LLM.
 * This is a defense-in-depth measure — the desktop app's privacy filter
 * should have already redacted sensitive data, but we catch stragglers here.
 *
 * @param {string} text - OCR text to sanitize
 * @returns {string} Sanitized text
 */
function sanitizeOcrText(text) {
  if (!text) return text;
  let sanitized = text;
  for (const { pattern, replacement } of SANITIZATION_PATTERNS) {
    // Reset lastIndex for global regexes reused across calls
    pattern.lastIndex = 0;
    sanitized = sanitized.replace(pattern, replacement);
  }
  return sanitized;
}

// ============================================================================
// PROMPTS
// ============================================================================

const BATCH_ANALYSIS_SYSTEM_PROMPT = `You are an expert at analyzing work activity from text. You match activity records to Jira issues based on window titles, application names, and OCR-extracted text. You focus on understanding the CONTENT and matching it semantically to issue descriptions. You understand that Jira keys may appear in window titles or extracted text.

MATCHING GUIDELINES:
1. If a window title or OCR text contains a Jira key (like ABC-123), prioritize that match
2. If the user is in a development tool (VS Code, IntelliJ, PyCharm, etc.) working on code related to a project, match to the most relevant "In Progress" issue from that project
3. If the window title mentions specific features (login, auth, UI, API, etc.), match to issues with similar features
4. When OCR text is unavailable (shows "no text extracted"), rely heavily on window title context
5. Browser activity on documentation, Stack Overflow, or technical sites related to an issue topic should be matched
6. Code editors with file/folder names visible in title should be matched based on what the code likely relates to

WHEN TO RETURN null (no match):
- Generic system activities: Task Manager, File Explorer (browsing files), Windows Settings, Control Panel, system utilities
- Generic browsing: download history, general search, social media, news sites (unless content clearly relates to an issue)
- Activities with NO semantic connection to any assigned issue — do NOT force-match just because the user has issues assigned
- When the only connection is that both are "technical" or "work-related" — that is NOT enough for a match

CRITICAL RULES:
- ONLY use task keys from the user's assigned issues list. NEVER invent or fabricate issue keys from OCR text, window titles, or any other source.
- Return null when there is no clear semantic connection between the activity and a specific issue
- A match requires a meaningful content relationship, not just both being work-related

CONFIDENCE SCORING:
- 0.8-1.0: Direct match (Jira key visible, explicit feature match)
- 0.6-0.7: Strong contextual match (same project area, related functionality)
- 0.4-0.5: Reasonable match (working in project, related to general area)
- 0.2-0.3: Weak match (only project matches, specific task unclear)
- 0.0-0.1: No match possible`;

const APP_CLASSIFICATION_SYSTEM_PROMPT = `You are an expert at classifying desktop applications and websites into work categories. You determine whether an application is productive (work-related), non_productive (entertainment/personal), or private (sensitive personal data like banking, healthcare, passwords). You base your classification on the application name, window title, and any visible text content.`;

/**
 * Build the batch analysis prompt for multiple activity records.
 * Sends all records in a single prompt for efficient LLM usage.
 *
 * @param {Array} records - Activity records with OCR text
 * @param {string} assignedIssuesText - Formatted list of user's Jira issues
 * @returns {string} Complete user prompt
 */
function buildBatchAnalysisPrompt(records, assignedIssuesText) {
  const recordDescriptions = records.map((record, index) => {
    const ocrSnippet = record.ocr_text
      ? sanitizeOcrText(record.ocr_text.substring(0, 500))
      : '(no text extracted)';

    return `Record ${index}: [${record.application_name}] ${record.window_title}
  Time: ${record.total_time_seconds}s | ${record.start_time} → ${record.end_time}
  OCR Text: ${ocrSnippet}`;
  }).join('\n\n');

  return `Analyze these activity records and match each to the most relevant Jira issue.
Match based on MEANING, not just keywords. If a window title contains a Jira key, use it. If OCR text references specific features or code related to an issue, match it.

IMPORTANT: When OCR text shows "(no text extracted)", you must rely on:
- The application name (Code.exe = VS Code, chrome.exe = browser, etc.)
- The window title (which often contains file names, project names, or page titles)
- Context from the project key and issue summaries

For development tools with project/file names in the title, match to relevant "In Progress" issues.
For browsers with technical sites in the title, match based on the topic being researched.

CRITICAL: You must ONLY use task keys from the assigned issues list below. NEVER invent, fabricate, or extract issue keys from OCR text, window titles, or any other source. If no assigned issue is a clear semantic match, return taskKey as null. Generic activities (Task Manager, File Explorer, Windows Settings, system utilities, download history) should return null unless they clearly relate to a specific issue.

User's Assigned Issues (from Jira):
${assignedIssuesText}

Activity Records:
${recordDescriptions}

For EACH record, determine:
1. Which Jira issue is the user most likely working on? Return null if the activity has no clear connection to any specific issue.
2. Is this office work or non-office?
3. How confident are you in the match?

Return ONLY valid JSON (no markdown code blocks, no extra text). Your response must be exactly one JSON array:
[
  {
    "recordIndex": 0,
    "taskKey": "PROJECT-123" or null,
    "projectKey": "PROJECT" or null,
    "confidenceScore": 0.0-1.0,
    "workType": "office" or "non-office",
    "reasoning": "Brief explanation"
  }
]
Include one entry per record, in order.`;
}

/**
 * Build the app classification prompt for an unknown application.
 *
 * @param {string} appName - Application/process name
 * @param {string} windowTitle - Window title
 * @param {string} ocrText - OCR-extracted text from the app
 * @returns {string} Complete user prompt
 */
function buildClassificationPrompt(appName, windowTitle, ocrText) {
  const textSnippet = ocrText
    ? sanitizeOcrText(ocrText.substring(0, 800))
    : '(no text available)';

  return `Classify this application into one of three categories:

- **productive**: Work-related apps (IDEs, office suites, design tools, project management, communication tools, browsers on work sites, development tools, cloud consoles, documentation)
- **non_productive**: Entertainment and personal distractions (streaming, social media, gaming, shopping, music, news/memes)
- **private**: Sensitive personal apps where no data should be captured (banking, healthcare, personal finance, password managers, personal messaging, tax software, account management)

Application Details:
- Process Name: ${appName}
- Window Title: ${windowTitle}
- Screen Text: ${textSnippet}

Rules:
- If the app handles sensitive personal/financial/health data → classify as "private"
- If the app is clearly entertainment/personal → classify as "non_productive"
- If the app could be work-related or is ambiguous → classify as "productive"
- Consider the window title and text content for context (e.g., a browser on a banking site is "private")

Return ONLY valid JSON (no markdown, no extra text):
{
  "classification": "productive" or "non_productive" or "private",
  "confidence": 0.0-1.0,
  "reasoning": "Brief explanation of why this classification was chosen",
  "suggestedDisplayName": "Human-readable app name"
}`;
}

// ============================================================================
// HELPERS
// ============================================================================

/**
 * Parse and validate a single JSON object candidate from the salvage scan.
 * Returns the parsed object if it has a numeric recordIndex, otherwise null.
 * @param {string} objectStr - Candidate JSON object string
 * @returns {Object|null}
 */
function tryParseJsonObject(objectStr) {
  if (!objectStr.includes('"recordIndex"')) return null;
  try {
    const parsed = JSON.parse(objectStr);
    return typeof parsed.recordIndex === 'number' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * Attempt to salvage a truncated JSON array by extracting complete objects.
 * When max_tokens cuts off the LLM response mid-JSON, this recovers
 * any fully-formed objects from the partial output.
 */
function salvageTruncatedJsonArray(truncatedJson) {
  // Iterate through string to find balanced {...} blocks (no regex)
  const salvaged = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < truncatedJson.length; i++) {
    const char = truncatedJson[i];

    if (char === '{') {
      if (depth === 0) start = i;
      depth++;
      continue;
    }

    if (char !== '}') continue;

    depth--;
    if (depth === 0 && start !== -1) {
      const parsed = tryParseJsonObject(truncatedJson.slice(start, i + 1));
      if (parsed) salvaged.push(parsed);
      start = -1;
    }
  }

  if (salvaged.length === 0) {
    throw new Error('Failed to parse AI response — no complete records found in truncated JSON');
  }

  logger.warn(`[ActivityService] Salvaged ${salvaged.length} records from truncated JSON response`);
  return salvaged;
}

// ============================================================================
// SERVICE METHODS
// ============================================================================

/**
 * Parses the raw AI batch response into a JSON array.
 * Handles direct JSON, markdown code blocks, and truncated responses.
 */
function parseAnalysisResponse(content) {
  try {
    return JSON.parse(content);
  } catch (error) {
    logger.debug('[ActivityService] Direct JSON parse failed, trying markdown extraction: %s', error.message);
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      logger.error('[ActivityService] Failed to parse batch analysis response: %s', content.substring(0, 200));
      throw new Error('Failed to parse AI response as JSON array');
    }
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (error_) {
      // JSON may be truncated by max_tokens — try to salvage complete entries
      logger.debug('[ActivityService] Markdown JSON parse failed, salvaging truncated response: %s', error_.message);
      return salvageTruncatedJsonArray(jsonMatch[0]);
    }
  }
}

/**
 * Clears task keys hallucinated by the AI (not present in the user's assigned issues).
 */
function validateAnalysisKeys(analyses, userAssignedIssues) {
  const validKeys = new Set(userAssignedIssues.map(i => i.key));
  for (const analysis of analyses) {
    if (analysis.taskKey && !validKeys.has(analysis.taskKey)) {
      logger.warn(`[ActivityService] AI returned invalid task key: ${analysis.taskKey}`);
      analysis.taskKey = null;
      analysis.projectKey = null;
      analysis.confidenceScore = Math.min(analysis.confidenceScore || 0, 0.3);
    }
  }
}

/**
 * Persists each analysis result back to the database.
 * Logs individual update failures without stopping the rest of the batch.
 */
async function persistAnalysisResults(analyses, records, provider, model) {
  for (const analysis of analyses) {
    const recordIndex = analysis.recordIndex;
    if (recordIndex >= 0 && recordIndex < records.length && records[recordIndex].id) {
      try {
        await activityDbService.updateActivityRecordAnalysis(records[recordIndex].id, {
          taskKey: analysis.taskKey,
          projectKey: analysis.projectKey,
          metadata: {
            workType: analysis.workType || 'office',
            confidenceScore: analysis.confidenceScore,
            reasoning: analysis.reasoning,
            aiProvider: provider,
            aiModel: model
          }
        });
      } catch (updateErr) {
        logger.error(`[ActivityService] Failed to update record ${records[recordIndex].id}:`, updateErr);
      }
    }
  }
}

/**
 * Analyze a batch of productive activity records using text-only LLM.
 * Sends a single API call with all records for efficiency.
 *
 * @param {Array} records - Activity records with OCR text
 * @param {Array} userAssignedIssues - User's assigned Jira issues
 * @param {string} userId - User ID
 * @param {string} organizationId - Organization ID
 * @returns {Promise<Object>} Analysis results
 */
async function analyzeBatch(records, userAssignedIssues, userId, organizationId) {
  if (!isActivityAIEnabled()) {
    throw new Error('AI client not initialized - check API keys');
  }

  const assignedIssuesText = formatAssignedIssues(userAssignedIssues);
  const userPrompt = buildBatchAnalysisPrompt(records, assignedIssuesText);
  const messages = [
    { role: 'system', content: BATCH_ANALYSIS_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt }
  ];

  try {
    // Each record needs ~150 tokens for JSON output; add buffer for array structure
    const maxTokens = Math.max(1500, records.length * 150 + 200);

    const { response, provider, model } = await chatCompletionWithFallback({
      messages,
      temperature: 0.3,
      max_tokens: maxTokens,
      isVision: false,
      reasoningEffort: 'none',
      userId,
      organizationId,
      apiCallName: 'batch-analysis'
    });

    const content = response.choices[0].message.content.trim();
    logger.info(`[ActivityService] Batch analysis done | ${provider} (${model}) | ${records.length} records`);

    const analyses = parseAnalysisResponse(content);
    if (!Array.isArray(analyses)) {
      throw new TypeError('AI response is not a JSON array');
    }

    validateAnalysisKeys(analyses, userAssignedIssues);
    await persistAnalysisResults(analyses, records, provider, model);

    return { analyses, recordsProcessed: records.length, provider, model };

  } catch (error) {
    logger.error('[ActivityService] Batch analysis failed: %s', error.message);
    throw error;
  }
}

/**
 * Classify an unknown application using LLM.
 *
 * @param {string} appName - Application/process name
 * @param {string} windowTitle - Window title
 * @param {string} ocrText - OCR-extracted text
 * @param {string} userId - User ID for LiteLLM tracking (optional)
 * @param {string} organizationId - Organization ID for cost tracking (optional)
 * @returns {Promise<Object>} Classification result
 */
async function classifyUnknownApp(appName, windowTitle, ocrText, userId = null, organizationId = null) {
  if (!isActivityAIEnabled()) {
    throw new Error('AI client not initialized - check API keys');
  }

  const userPrompt = buildClassificationPrompt(appName, windowTitle, ocrText);

  const messages = [
    { role: 'system', content: APP_CLASSIFICATION_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt }
  ];

  try {
    const { response, provider, model } = await chatCompletionWithFallback({
      messages,
      temperature: 0.2,
      max_tokens: 300,
      isVision: false,
      reasoningEffort: 'none',
      userId,
      organizationId,
      apiCallName: 'app-classification'
    });

    const content = response.choices[0].message.content.trim();
    logger.info(`[ActivityService] App classification done | ${provider} (${model}) | ${appName}`);

    // Parse JSON response
    let result;
    try {
      result = JSON.parse(content);
    } catch (error) {
      logger.debug('[ActivityService] Direct JSON parse failed, trying regex extraction: %s', error.message);
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        result = JSON.parse(jsonMatch[0]);
      } else {
        logger.error('[ActivityService] Failed to parse classification response: %s', content.substring(0, 200));
        throw new Error('Failed to parse AI classification response');
      }
    }

    // Validate classification value
    const validClassifications = ['productive', 'non_productive', 'private'];
    if (!validClassifications.includes(result.classification)) {
      logger.warn(`[ActivityService] Invalid classification: ${result.classification}, defaulting to productive`);
      result.classification = 'productive';
    }

    return {
      classification: result.classification,
      confidence: result.confidence || 0.5,
      reasoning: result.reasoning || '',
      suggestedDisplayName: result.suggestedDisplayName || appName,
      aiProvider: provider,
      aiModel: model
    };

  } catch (error) {
    logger.error('[ActivityService] App classification failed: %s', error.message);
    // Default to productive on failure (safest — will trigger OCR + AI analysis)
    return {
      classification: 'productive',
      confidence: 0,
      reasoning: 'Classification failed, defaulting to productive',
      suggestedDisplayName: appName,
      error: error.message
    };
  }
}

/**
 * Identify an application by name/search term using LLM.
 * Used when admin searches for an app that:
 * 1. Is not in the database
 * 2. Is not currently running (psutil can't find it)
 *
 * LLM identifies the executable name and display name only.
 * Classification is determined by which section the admin is searching in.
 *
 * @param {string} searchTerm - App name or search term from admin
 * @returns {Promise<Object>} Identification result with identifier, display_name
 */
async function identifyAppByName(searchTerm) {
  logger.info('[ActivityService] ========== identifyAppByName START ==========');
  logger.info(`[ActivityService] Search term: "${searchTerm}"`);
  
  const aiEnabled = isActivityAIEnabled();
  logger.info(`[ActivityService] AI enabled check: ${aiEnabled}`);
  
  if (!aiEnabled) {
    logger.error('[ActivityService] AI client not initialized - check API keys');
    throw new Error('AI client not initialized - check API keys');
  }

  const userPrompt = buildAppIdentificationPrompt(searchTerm);
  logger.info('[ActivityService] Built user prompt: %s', userPrompt);

  const messages = [
    { role: 'system', content: APP_IDENTIFICATION_SYSTEM_PROMPT },
    { role: 'user', content: userPrompt }
  ];

  logger.info('[ActivityService] Calling chatCompletionWithFallback...');
  
  try {
    const { response, provider, model } = await chatCompletionWithFallback({
      messages,
      temperature: 0.2,
      max_tokens: 150,
      isVision: false,
      reasoningEffort: 'none',
      apiCallName: 'app-identification'
    });

    const content = response.choices[0].message.content.trim();
    logger.info(`[ActivityService] LLM Response received | Provider: ${provider} | Model: ${model}`);
    logger.info(`[ActivityService] Raw LLM content: ${content}`);

    // Parse JSON response
    let result;
    try {
      result = JSON.parse(content);
      logger.info('[ActivityService] Parsed JSON result: %s', JSON.stringify(result));
    } catch (error) {
      logger.warn('[ActivityService] Direct JSON parse failed, trying regex extraction: %s', error.message);
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        result = JSON.parse(jsonMatch[0]);
        logger.info('[ActivityService] Regex extracted JSON: %s', JSON.stringify(result));
      } else {
        logger.error('[ActivityService] Failed to parse app identification response: %s', content.substring(0, 200));
        throw new Error('Failed to parse AI response');
      }
    }

    if (!result.identified) {
      logger.info('[ActivityService] LLM says app NOT identified');
      logger.info('[ActivityService] ========== identifyAppByName END (not identified) ==========');
      return {
        identified: false,
        source: 'llm',
        aiProvider: provider,
        aiModel: model
      };
    }

    logger.info(`[ActivityService] LLM identified app: identifier="${result.identifier}", display_name="${result.display_name}"`);
    logger.info('[ActivityService] ========== identifyAppByName END (success) ==========');
    
    return {
      identified: true,
      identifier: result.identifier,
      display_name: result.display_name,
      confidence: result.confidence || 0.7,
      source: 'llm',
      aiProvider: provider,
      aiModel: model
    };

  } catch (error) {
    logger.error('[ActivityService] App identification FAILED');
    logger.error('[ActivityService] Error message: %s', error.message);
    logger.error('[ActivityService] Stack trace: %s', error.stack);
    logger.info('[ActivityService] ========== identifyAppByName END (error) ==========');
    return {
      identified: false,
      source: 'llm',
      error: error.message
    };
  }
}

module.exports = {
  analyzeBatch,
  classifyUnknownApp,
  identifyAppByName,
  // Exported for testing
  sanitizeOcrText,
  _buildBatchAnalysisPrompt: buildBatchAnalysisPrompt,
  _buildClassificationPrompt: buildClassificationPrompt,
};