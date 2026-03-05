/**
 * Vision Analyzer Module
 * Handles Vision-based screenshot analysis
 * Supports Fireworks AI primary with automatic LiteLLM fallback
 */

const { chatCompletionWithFallback, isAIEnabled } = require('./ai-client');
const { VISION_SYSTEM_PROMPT, buildVisionUserPrompt, formatAssignedIssues } = require('./prompts');
const logger = require('../../utils/logger');

/**
 * Analyze screenshot using Vision API
 * This is the PRIMARY analysis method - analyzes image directly
 * Uses Fireworks AI as primary, falls back to LiteLLM on consecutive failures
 *
 * @param {Object} params - Analysis parameters
 * @param {Buffer} params.imageBuffer - Screenshot image buffer
 * @param {string} params.windowTitle - Window title
 * @param {string} params.applicationName - Application name
 * @param {Array} params.userAssignedIssues - User's assigned Jira issues
 * @param {string} params.userId - User ID for cost tracking (optional)
 * @param {string} params.organizationId - Organization ID for cost tracking (optional)
 * @param {string} params.screenshotId - Screenshot ID for cost tracking (optional)
 * @returns {Promise<Object>} Analysis result
 */
async function analyzeWithVision({ imageBuffer, windowTitle, applicationName, userAssignedIssues = [], userId = null, organizationId = null, screenshotId = null }) {
  if (!isAIEnabled()) {
    throw new Error('AI client not initialized - check API keys');
  }

  // Convert image buffer to base64
  const base64Image = imageBuffer.toString('base64');
  const imageDataUrl = `data:image/png;base64,${base64Image}`;

  // Format assigned issues for the prompt
  const assignedIssuesText = formatAssignedIssues(userAssignedIssues);

  // Build the prompt
  const userPrompt = buildVisionUserPrompt(applicationName, windowTitle, assignedIssuesText);

  // Build messages array
  const messages = [
    {
      role: 'system',
      content: VISION_SYSTEM_PROMPT
    },
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: userPrompt
        },
        {
          type: 'image_url',
          image_url: {
            url: imageDataUrl,
            detail: 'high' // Use high detail for better analysis
          }
        }
      ]
    }
  ];

  try {
    // Use unified request with automatic fallback
    const { response, provider, model } = await chatCompletionWithFallback({
      messages,
      temperature: 0.3,
      max_tokens: 1200,
      isVision: true,
      reasoningEffort: 'none',
      userId: userId,
      organizationId: organizationId,
      screenshotId: screenshotId,
      apiCallName: 'vision-analysis'
    });

    const content = response.choices[0].message.content.trim();
    logger.info('[AI] Vision analysis done | %s (%s)', provider, model);

    // Parse JSON from the response
    const aiResult = parseAIResponse(content);

    // Validate and return the result with provider info
    const result = validateAndFormatResult(aiResult, userAssignedIssues);
    result.aiProvider = provider;
    result.aiModel = model;

    // Log analysis result
    logger.info('[AI] Result: %s | task: %s | confidence: %d%% | %s',
      result.workType,
      result.taskKey || 'none',
      Math.round(result.confidenceScore * 100),
      result.reasoning?.substring(0, 80) || 'no reasoning'
    );

    return result;

  } catch (error) {
    logger.error('[AI] Vision analysis failed: %s', error.message);
    throw error;
  }
}

/**
 * Extract a candidate JSON string from raw content using multiple strategies.
 * Handles full/truncated markdown code blocks and bare JSON.
 * @param {string} content - Raw AI response content
 * @returns {string[]} List of candidate strings to try parsing
 */
function extractJsonCandidates(content) {
  const trimmed = content.trim();
  const candidates = [];

  // 1) Markdown code blocks (prefer ```json then plain ```) - full block
  const codeBlockJson = trimmed.match(/```json\s*([\s\S]*?)\s*```/);
  if (codeBlockJson) candidates.push(codeBlockJson[1].trim());

  const codeBlockAny = trimmed.match(/```\s*([\s\S]*?)\s*```/);
  if (codeBlockAny) candidates.push(codeBlockAny[1].trim());

  // 2) Truncated ```json (no closing ```) - Gemini often truncates; take from first { to end
  if (/```json\s*[\s\S]*\{/.test(trimmed)) {
    const afterFence = trimmed.replace(/^[^]*?```json\s*/i, '').trim();
    const firstBrace = afterFence.indexOf('{');
    if (firstBrace !== -1) {
      const fromBrace = afterFence.slice(firstBrace);
      candidates.push(fromBrace);
    }
  }

  // 3) First { to last } (handles "Here is the analysis: { ... }" or full JSON)
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    candidates.push(trimmed.slice(firstBrace, lastBrace + 1));
  }

  // 4) Raw content as-is
  candidates.push(trimmed);

  return [...new Set(candidates)];
}

/**
 * Try to fix common LLM JSON mistakes (trailing commas, truncated closing).
 * @param {string} raw - Raw JSON string
 * @returns {string} Potentially fixed JSON string
 */
function tryFixJsonString(raw) {
  let s = raw
    .replaceAll(/,(\s*[}\]])/g, '$1')  // trailing commas before } or ]
    .replaceAll('\r\n', '\n')
    .trim();
  // If truncated (unclosed object), append closing brace(s) by balance
  const open = (s.match(/\{/g) || []).length;
  const close = (s.match(/\}/g) || []).length;
  if (open > close) {
    s += '}'.repeat(open - close);
  }
  return s;
}

/**
 * Parse AI response and extract JSON
 * @param {string} content - Raw AI response content
 * @returns {Object} Parsed JSON object
 */
function parseAIResponse(content) {
  if (!content || typeof content !== 'string') {
    logger.warn('[AI] Empty or non-string response');
    throw new Error('Invalid JSON response from AI');
  }

  const candidates = extractJsonCandidates(content);

  for (const candidate of candidates) {
    for (const fn of [s => s, tryFixJsonString]) {
      try {
        const str = fn(candidate);
        if (!str) continue;
        const parsed = JSON.parse(str);
        if (parsed && typeof parsed === 'object') return parsed;
      } catch (_) {
        // try next candidate or fix
      }
    }
  }

  // Log a short sample for debugging (avoid logging huge or sensitive content)
  const sample = content.length > 400 ? content.substring(0, 400) + '...' : content;
  logger.warn('[AI] Failed to parse response as JSON. Sample: %s', sample.replaceAll('\n', ' '));
  throw new Error('Invalid JSON response from AI');
}

/**
 * Validate AI result and format the response
 * @param {Object} aiResult - Parsed AI result
 * @param {Array} userAssignedIssues - User's assigned issues for validation
 * @returns {Object} Validated and formatted result
 */
function validateAndFormatResult(aiResult, userAssignedIssues) {
  // Validate work_type
  if (aiResult.workType !== 'office' && aiResult.workType !== 'non-office') {
    logger.warn('[AI] Invalid work_type "%s", defaulting to office', aiResult.workType);
    aiResult.workType = 'office';
  }

  // Validate task key is in user's assigned issues (if provided)
  let validatedTaskKey = aiResult.taskKey || null;

  if (validatedTaskKey && userAssignedIssues && userAssignedIssues.length > 0) {
    const assignedIssueKeys = userAssignedIssues.map(issue => issue.key);
    if (!assignedIssueKeys.includes(validatedTaskKey)) {
      logger.warn('[AI] Task key %s not in assigned issues, setting to null', validatedTaskKey);
      validatedTaskKey = null;
    }
  }

  // Return validated analysis
  return {
    workType: aiResult.workType,
    taskKey: validatedTaskKey,
    projectKey: aiResult.projectKey || (validatedTaskKey ? validatedTaskKey.split('-')[0] : null),
    confidenceScore: Math.min(Math.max(aiResult.confidenceScore || 0.5, 0), 1), // Clamp between 0 and 1
    contentAnalysis: aiResult.contentAnalysis || '',
    reasoning: aiResult.reasoning || '',
    modelVersion: 'v3.1-vision-thorough'
  };
}

module.exports = {
  analyzeWithVision,
  parseAIResponse,
  validateAndFormatResult
};
