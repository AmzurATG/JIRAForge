const screenshotService = require('../services/screenshot-service');
const supabaseService = require('../services/supabase-service');
const logger = require('../utils/logger');
const { getUTCISOString, toUTCISOString } = require('../utils/datetime');

// Feature flag: Delete screenshots after analysis (default: true for privacy)
const DELETE_AFTER_ANALYSIS = process.env.DELETE_SCREENSHOTS_AFTER_ANALYSIS !== 'false';

/**
 * Validate UUID format
 * @param {string} id - String to validate
 * @returns {boolean} True if valid UUID format
 */
const isValidUUID = (id) => {
  if (!id || typeof id !== 'string') return false;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(id);
};

/**
 * Parse user assigned issues from webhook payload
 * @param {*} userAssignedIssues - Can be string or array
 * @returns {Array} Parsed array of issues
 */
function parseUserAssignedIssues(userAssignedIssues) {
  if (!userAssignedIssues) return [];
  
  if (typeof userAssignedIssues === 'string') {
    try {
      return JSON.parse(userAssignedIssues);
    } catch (error) {
      logger.warn('Failed to parse user_assigned_issues string', { userAssignedIssues, error: error.message });
      return [];
    }
  }
  
  return userAssignedIssues;
}

/**
 * Extract and normalize webhook data
 * @param {Object} reqBody - Request body from webhook
 * @returns {Object} Normalized webhook data
 */
function extractWebhookData(reqBody) {
  const webhookData = reqBody.record || reqBody;
  const screenshot_id = webhookData.id || webhookData.screenshot_id;
  
  return {
    ...webhookData,
    screenshot_id,
    user_assigned_issues: parseUserAssignedIssues(webhookData.user_assigned_issues)
  };
}

/**
 * Validate required webhook fields
 * @param {Object} data - Webhook data
 * @returns {Object|null} Error object if validation fails, null if valid
 */
function validateWebhookData(data) {
  const { screenshot_id, user_id, storage_url } = data;

  if (!screenshot_id || !user_id || !storage_url) {
    return {
      status: 400,
      error: 'Missing required fields: screenshot_id (id), user_id, storage_url'
    };
  }

  if (!isValidUUID(screenshot_id)) {
    return {
      status: 400,
      error: 'Invalid screenshot_id format: must be a valid UUID'
    };
  }

  if (!isValidUUID(user_id)) {
    return {
      status: 400,
      error: 'Invalid user_id format: must be a valid UUID'
    };
  }

  if (data.organization_id && !isValidUUID(data.organization_id)) {
    return {
      status: 400,
      error: 'Invalid organization_id format: must be a valid UUID'
    };
  }

  return null;
}

/**
 * Resolve organization ID (from payload or screenshot record)
 * @param {string} organizationId - Organization ID from webhook
 * @param {string} screenshotId - Screenshot ID
 * @returns {Promise<string|null>} Resolved organization ID
 */
async function resolveOrganizationId(organizationId, screenshotId) {
  if (organizationId) {
    return organizationId;
  }

  const screenshotRecord = await supabaseService.getScreenshotById(screenshotId);
  if (!screenshotRecord) {
    return null;
  }

  logger.info('Fetched organization_id from screenshot record', {
    screenshot_id: screenshotId,
    organization_id: screenshotRecord.organization_id
  });

  return screenshotRecord.organization_id;
}

/**
 * Check if duration fields need updating
 * @param {Object} data - Webhook data with duration fields
 * @returns {boolean} True if update is needed
 */
function needsDurationUpdate(data) {
  const { duration_seconds, start_time, end_time } = data;
  return duration_seconds == null || !start_time || !end_time;
}

/**
 * Calculate duration timestamps for legacy screenshots
 * @param {number} durationSeconds - Duration in seconds
 * @param {string} timestamp - Screenshot timestamp
 * @returns {Object} Object with start_time and end_time
 */
function calculateDurationTimestamps(durationSeconds, timestamp) {
  const calculatedEndTime = timestamp || getUTCISOString();
  const calculatedStartTime = toUTCISOString(
    new Date(new Date(calculatedEndTime).getTime() - (durationSeconds * 1000))
  );

  return {
    start_time: calculatedStartTime,
    end_time: calculatedEndTime
  };
}

/**
 * Delete screenshot files from storage
 * @param {string} screenshotId - Screenshot ID
 * @param {string} storagePath - Storage path of screenshot
 * @returns {Promise<void>}
 */
async function deleteScreenshotFiles(screenshotId, storagePath) {
  if (!DELETE_AFTER_ANALYSIS || !storagePath) {
    return;
  }

  try {
    // Delete the main screenshot
    await supabaseService.deleteFile('screenshots', storagePath);
    logger.info('Deleted screenshot from storage after analysis', {
      screenshot_id: screenshotId,
      storage_path: storagePath
    });

    // Delete the thumbnail (derive path from main screenshot path)
    const thumbPath = storagePath.replace('screenshot_', 'thumb_').replace('.png', '.jpg');
    try {
      await supabaseService.deleteFile('screenshots', thumbPath);
      logger.debug('Deleted thumbnail from storage', { thumbPath });
    } catch (thumbError) {
      // Thumbnail may not exist - this is not critical
      logger.debug('Thumbnail not found or already deleted', { thumbPath, error: thumbError.message });
    }

    // Clear storage URLs in database to prevent broken image links
    await supabaseService.clearStorageUrls(screenshotId);
    logger.debug('Cleared storage URLs in database', { screenshot_id: screenshotId });
  } catch (deleteError) {
    // Log but don't fail the analysis if deletion fails
    logger.warn('Failed to delete screenshot from storage (non-critical)', {
      screenshot_id: screenshotId,
      storage_path: storagePath,
      error: deleteError.message
    });
  }
}

/**
 * Create worklog in Jira if configured
 * @param {Object} params - Worklog parameters
 * @returns {Promise<void>}
 */
async function createWorklogIfEnabled(params) {
  const { analysis, userId, screenshotId, timestamp } = params;

  const shouldCreateWorklog = 
    analysis.taskKey && 
    analysis.workType === 'office' && 
    process.env.AUTO_CREATE_WORKLOGS === 'true';

  if (!shouldCreateWorklog) {
    return;
  }

  try {
    await screenshotService.createWorklog({
      userId,
      issueKey: analysis.taskKey,
      timeSpentSeconds: analysis.timeSpentSeconds,
      startedAt: timestamp
    });

    // Mark worklog as created
    await supabaseService.markWorklogCreated(screenshotId, analysis.taskKey);
  } catch (worklogError) {
    logger.error('Failed to create worklog', { 
      error: worklogError, 
      screenshot_id: screenshotId 
    });
    // Don't fail the entire analysis if worklog creation fails
  }
}

/**
 * Update screenshot with duration data
 * @param {string} screenshotId - Screenshot ID
 * @param {Object} webhookData - Webhook data
 * @param {number} actualDuration - Actual duration in seconds
 * @returns {Promise<void>}
 */
async function updateScreenshotDurationIfNeeded(screenshotId, webhookData, actualDuration) {
  if (!needsDurationUpdate(webhookData)) {
    // Desktop app already set all duration fields - they're already accurate
    return;
  }

  // Fallback: Calculate duration for legacy screenshots that don't have event-based data
  const { start_time: calcStartTime, end_time: calcEndTime } = 
    calculateDurationTimestamps(actualDuration, webhookData.timestamp);

  await supabaseService.updateScreenshotDuration(screenshotId, {
    duration_seconds: webhookData.duration_seconds ?? actualDuration,
    start_time: webhookData.start_time || calcStartTime,
    end_time: webhookData.end_time || calcEndTime
  });
}

/**
 * Handle analysis error and update screenshot status
 * @param {Error} error - Error object
 * @param {Object} webhookData - Webhook data
 * @returns {Object} Error response object
 */
async function handleAnalysisError(error, webhookData) {
  const failedScreenshotId = webhookData.screenshot_id;

  logger.error('Screenshot analysis error', {
    message: error.message,
    screenshot_id: failedScreenshotId,
    user_id: webhookData.user_id,
    organization_id: webhookData.organization_id,
    storage_path: webhookData.storage_path,
    stack: error.stack
  });

  // Update screenshot status to failed
  if (failedScreenshotId) {
    try {
      await supabaseService.updateScreenshotStatus(
        failedScreenshotId,
        'failed',
        error.message
      );
    } catch (updateError) {
      logger.error('Failed to update screenshot status:', updateError);
    }
  }

  return {
    success: false,
    error: 'Failed to analyze screenshot',
    details: process.env.NODE_ENV === 'development' ? error.message : undefined
  };
}

/**
 * Analyze screenshot endpoint
 * Triggered by Supabase webhook when a new screenshot is uploaded
 */
exports.analyzeScreenshot = async (req, res) => {
  try {
    // Extract and normalize webhook data
    const webhookData = extractWebhookData(req.body);
    
    // Validate required fields and UUIDs
    const validationError = validateWebhookData(webhookData);
    if (validationError) {
      logger.error('Webhook validation failed', { body: req.body });
      return res.status(validationError.status).json({
        success: false,
        error: validationError.error
      });
    }

    const {
      screenshot_id,
      user_id,
      organization_id,
      storage_path,
      window_title,
      application_name,
      timestamp,
      duration_seconds,
      user_assigned_issues
    } = webhookData;

    // Atomically claim the screenshot for processing (prevents webhook + polling race condition)
    const claimed = await supabaseService.claimScreenshotForProcessing(screenshot_id);
    if (!claimed) {
      logger.info('Screenshot already processing or processed, skipping', { screenshot_id });
      return res.json({
        success: true,
        message: 'Already processing or processed'
      });
    }

    // Resolve organization ID (from payload or screenshot record)
    const resolvedOrganizationId = await resolveOrganizationId(organization_id, screenshot_id);

    logger.info('Starting screenshot analysis', {
      screenshot_id,
      user_id,
      organization_id: resolvedOrganizationId,
      application_name,
      hasAssignedIssues: user_assigned_issues?.length > 0
    });

    // Download screenshot from Supabase Storage
    const imageBuffer = await supabaseService.downloadFile('screenshots', storage_path);

    // Analyze the screenshot using GPT-4 Vision
    // This will automatically fall back to OCR + AI if Vision fails
    const analysis = await screenshotService.analyzeActivity({
      imageBuffer,
      windowTitle: window_title,
      applicationName: application_name,
      timestamp,
      userId: user_id,
      userAssignedIssues: user_assigned_issues || [],
      organizationId: resolvedOrganizationId,
      screenshotId: screenshot_id
    });

    // Use actual duration from desktop app if available, otherwise use AI's calculated value
    // IMPORTANT: Use ?? (nullish coalescing) instead of || to handle duration_seconds: 0 correctly
    const actualDuration = duration_seconds ?? analysis.timeSpentSeconds;

    // Save analysis results to Supabase
    await supabaseService.saveAnalysisResult({
      screenshot_id,
      user_id,
      organization_id: resolvedOrganizationId,
      time_spent_seconds: actualDuration,
      active_task_key: analysis.taskKey,
      active_project_key: analysis.projectKey,
      confidence_score: analysis.confidenceScore,
      extracted_text: analysis.metadata?.extractedText || '',
      work_type: analysis.workType,
      ai_model_version: analysis.modelVersion,
      analysis_metadata: analysis.metadata
    });

    // Update screenshot with duration data if needed (for legacy screenshots)
    await updateScreenshotDurationIfNeeded(screenshot_id, webhookData, actualDuration);

    // Update screenshot status
    await supabaseService.updateScreenshotStatus(screenshot_id, 'analyzed');

    // Delete screenshot files from storage after successful analysis (privacy feature)
    await deleteScreenshotFiles(screenshot_id, storage_path);

    // If configured, create worklog in Jira (only for office work)
    await createWorklogIfEnabled({
      analysis,
      userId: user_id,
      screenshotId: screenshot_id,
      timestamp
    });

    logger.info('Screenshot analysis completed', {
      screenshot_id,
      taskKey: analysis.taskKey,
      confidenceScore: analysis.confidenceScore
    });

    res.json({
      success: true,
      screenshot_id,
      analysis: {
        task_key: analysis.taskKey,
        project_key: analysis.projectKey,
        confidence_score: analysis.confidenceScore,
        work_type: analysis.workType
      }
    });

  } catch (error) {
    const webhookData = extractWebhookData(req.body);
    const errorResponse = await handleAnalysisError(error, webhookData);
    res.status(500).json(errorResponse);
  }
};
