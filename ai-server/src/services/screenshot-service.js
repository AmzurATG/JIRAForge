/**
 * Screenshot Service
 * Main service for screenshot analysis - orchestrates AI-based analysis
 *
 * Uses modular AI services:
 * - ai/ai-client.js - AI client management (Fireworks + LiteLLM)
 * - ai/prompts.js - AI prompts
 * - ai/vision-analyzer.js - Vision-based analysis
 * - ai/ocr-analyzer.js - OCR + AI text analysis
 */

const logger = require('../utils/logger');
const { isAIEnabled, analyzeWithVision, analyzeWithOCRPipeline } = require('./ai');

/**
 * Check if OCR fallback is enabled via environment variable
 * @returns {boolean} True if USE_OCR_FALLBACK is not set to 'false'
 */
function isOCRFallbackEnabled() {
  return process.env.USE_OCR_FALLBACK !== 'false';
}

/**
 * Analyze activity using AI (Vision primary, OCR fallback)
 *
 * @param {Object} params - Analysis parameters
 * @param {Buffer} params.imageBuffer - Screenshot image buffer
 * @param {string} params.windowTitle - Window title
 * @param {string} params.applicationName - Application name
 * @param {string} params.timestamp - Timestamp of the screenshot
 * @param {string} params.userId - User ID
 * @param {Array} params.userAssignedIssues - User's assigned Jira issues
 * @param {string} params.organizationId - Organization ID (optional)
 * @param {string} params.screenshotId - Screenshot ID (optional)
 * @returns {Promise<Object>} Analysis result
 */
exports.analyzeActivity = async ({ imageBuffer, windowTitle, applicationName, timestamp, userId, userAssignedIssues = [], organizationId = null, screenshotId = null }) => {
  try {
    // Calculate time spent (based on screenshot interval)
    const timeSpentSeconds = parseInt(process.env.SCREENSHOT_INTERVAL || '300');

    // Use AI Vision as primary analysis method
    let visionAnalysis = null;
    const useVision = isAIEnabled();

    if (useVision && imageBuffer) {
      try {
        visionAnalysis = await analyzeWithVision({
          imageBuffer,
          windowTitle,
          applicationName,
          userAssignedIssues,
          userId: userId,
          organizationId: organizationId,
          screenshotId: screenshotId
        });
        const providerName = visionAnalysis.aiProvider || 'AI';
        const modelName = visionAnalysis.aiModel || 'unknown';
        logger.info(`${providerName} Vision analysis completed`, {
          provider: providerName,
          model: modelName,
          taskKey: visionAnalysis.taskKey,
          workType: visionAnalysis.workType,
          confidence: visionAnalysis.confidenceScore,
          usedAssignedIssues: userAssignedIssues.length > 0,
          assignedIssuesCount: userAssignedIssues.length,
          assignedIssueKeys: userAssignedIssues.map(i => i.key).join(', '),
          reasoning: visionAnalysis.reasoning || 'No reasoning provided'
        });
      } catch (visionError) {
        logger.warn('AI Vision analysis failed, falling back to OCR + AI', { error: visionError.message });
        // Fall back to OCR-based analysis
      }
    }

    // If Vision analysis failed or not available, fall back to OCR + AI text
    if (!visionAnalysis && imageBuffer && isOCRFallbackEnabled()) {
      logger.info('Falling back to OCR-based analysis');
      try {
        visionAnalysis = await analyzeWithOCRPipeline({
          imageBuffer,
          windowTitle,
          applicationName,
          userAssignedIssues,
          userId: userId,
          organizationId: organizationId,
          screenshotId: screenshotId
        });
        const ocrProviderName = visionAnalysis.aiProvider || 'AI';
        const ocrModelName = visionAnalysis.aiModel || 'unknown';
        logger.info(`OCR + ${ocrProviderName} analysis completed`, {
          provider: ocrProviderName,
          model: ocrModelName,
          taskKey: visionAnalysis.taskKey,
          workType: visionAnalysis.workType,
          confidence: visionAnalysis.confidenceScore
        });
      } catch (aiError) {
        logger.error('Both Vision and OCR+AI analysis failed', { error: aiError.message });
        // Last fallback: basic heuristics - default to office work with no specific task
        visionAnalysis = {
          taskKey: null,
          projectKey: null,
          workType: 'office',
          confidenceScore: 0.3,
          reasoning: 'Fallback to basic heuristics - AI analysis failed',
          extractedText: ''
        };
      }
    } else if (!visionAnalysis && imageBuffer && !isOCRFallbackEnabled()) {
      logger.info('OCR fallback disabled (USE_OCR_FALLBACK=false), using basic heuristics');
      visionAnalysis = {
        taskKey: null,
        projectKey: null,
        workType: 'office',
        confidenceScore: 0.3,
        reasoning: 'OCR fallback disabled - using basic heuristics',
        extractedText: ''
      };
    }

    // Extract final results
    const taskKey = visionAnalysis?.taskKey || null;
    const projectKey = visionAnalysis?.projectKey || (taskKey ? taskKey.split('-')[0] : null);
    const workType = visionAnalysis?.workType || 'office';
    const confidenceScore = visionAnalysis?.confidenceScore || 0;

    return {
      taskKey,
      projectKey,
      timeSpentSeconds,
      confidenceScore,
      workType,
      modelVersion: visionAnalysis?.modelVersion || 'v3.1-vision-thorough',
      metadata: {
        application: applicationName,
        windowTitle,
        aiEnhanced: true,
        usedVision: !!visionAnalysis,
        assignedIssuesCount: userAssignedIssues.length,
        usedAssignedIssues: userAssignedIssues.length > 0,
        reasoning: visionAnalysis?.reasoning || '',
        extractedText: visionAnalysis?.extractedText || ''
      }
    };
  } catch (error) {
    logger.error('Activity analysis error:', error);
    throw new Error(`Failed to analyze activity: ${error.message}`);
  }
};

/**
 * Create worklog in Jira via Forge app
 *
 * @param {Object} params - Worklog parameters
 * @param {string} params.userId - User ID
 * @param {string} params.issueKey - Jira issue key
 * @param {number} params.timeSpentSeconds - Time spent in seconds
 * @param {string} params.startedAt - Start timestamp
 * @returns {Promise<Object>} Worklog creation result
 */
exports.createWorklog = async ({ userId, issueKey, timeSpentSeconds, startedAt }) => {
  try {
    logger.info('Worklog creation requested', {
      userId,
      issueKey,
      timeSpentSeconds,
      startedAt
    });

    // In production, this would make an API call to the Forge app
    // which would then use the Jira API to create the worklog
    /*
    const response = await axios.post(
      `${process.env.FORGE_APP_URL}/api/create-worklog`,
      {
        userId,
        issueKey,
        timeSpentSeconds,
        startedAt
      },
      {
        headers: {
          'Authorization': `Bearer ${process.env.FORGE_API_KEY}`
        }
      }
    );

    return response.data;
    */

    // Placeholder response
    return { worklogId: 'placeholder', created: true };
  } catch (error) {
    logger.error('Worklog creation error:', error);
    throw new Error(`Failed to create worklog: ${error.message}`);
  }
};
