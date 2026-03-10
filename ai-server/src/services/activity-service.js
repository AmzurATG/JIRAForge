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
// PROMPTS
// ============================================================================

const BATCH_ANALYSIS_SYSTEM_PROMPT = `You are an expert at analyzing work activity from text. You match activity records to Jira issues based on window titles, application names, and OCR-extracted text. You focus on understanding the CONTENT and matching it semantically to issue descriptions. You understand that Jira keys may appear in window titles or extracted text.`;

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
      ? record.ocr_text.substring(0, 500)
      : '(no text extracted)';

    return `Record ${index}: [${record.application_name}] ${record.window_title}
  Time: ${record.total_time_seconds}s | ${record.start_time} → ${record.end_time}
  OCR Text: ${ocrSnippet}`;
  }).join('\n\n');

  return `Analyze these activity records and match each to the most relevant Jira issue.
Match based on MEANING, not just keywords. If a window title contains a Jira key, use it. If OCR text references specific features or code related to an issue, match it.

User's Assigned Issues (from Jira):
${assignedIssuesText}

Activity Records:
${recordDescriptions}

For EACH record, determine:
1. Which Jira issue is the user most likely working on?
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
    ? ocrText.substring(0, 800)
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
 * Attempt to salvage a truncated JSON array by extracting complete objects.
 * When max_tokens cuts off the LLM response mid-JSON, this recovers
 * any fully-formed objects from the partial output.
 */
function salvageTruncatedJsonArray(truncatedJson) {
  // Find balanced {...} blocks without using vulnerable regex
  // Instead of regex, iterate through string to find balanced braces
  const salvaged = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < truncatedJson.length; i++) {
    const char = truncatedJson[i];
    if (char === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (char === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        const objectStr = truncatedJson.slice(start, i + 1);
        // Validate it contains recordIndex before parsing
        if (objectStr.includes('"recordIndex"')) {
          try {
            const parsed = JSON.parse(objectStr);
            if (typeof parsed.recordIndex === 'number') {
              salvaged.push(parsed);
            }
          } catch {
            // Skip malformed individual objects
          }
        }
        start = -1;
      }
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
    logger.debug('[ActivityService] Direct JSON parse failed, trying markdown extraction:', error.message);
    const jsonMatch = content.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      logger.error('[ActivityService] Failed to parse batch analysis response:', content.substring(0, 200));
      throw new Error('Failed to parse AI response as JSON array');
    }
    try {
      return JSON.parse(jsonMatch[0]);
    } catch (error_) {
      // JSON may be truncated by max_tokens — try to salvage complete entries
      logger.debug('[ActivityService] Markdown JSON parse failed, salvaging truncated response:', error_.message);
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
    logger.error('[ActivityService] Batch analysis failed:', error.message);
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
      logger.debug('[ActivityService] Direct JSON parse failed, trying regex extraction:', error.message);
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        result = JSON.parse(jsonMatch[0]);
      } else {
        logger.error('[ActivityService] Failed to parse classification response:', content.substring(0, 200));
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
    logger.error('[ActivityService] App classification failed:', error.message);
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
  logger.info('[ActivityService] Built user prompt:', userPrompt);

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
      logger.info('[ActivityService] Parsed JSON result:', JSON.stringify(result));
    } catch (error) {
      logger.warn('[ActivityService] Direct JSON parse failed, trying regex extraction:', error.message);
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        result = JSON.parse(jsonMatch[0]);
        logger.info('[ActivityService] Regex extracted JSON:', JSON.stringify(result));
      } else {
        logger.error('[ActivityService] Failed to parse app identification response:', content.substring(0, 200));
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
    logger.error('[ActivityService] Error message:', error.message);
    logger.error('[ActivityService] Stack trace:', error.stack);
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
  identifyAppByName
};