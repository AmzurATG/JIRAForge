/**
 * Activity Controller
 * Handles endpoints for the new event-based activity tracking pipeline.
 * - POST /api/analyze-batch — text-only LLM task matching for productive records
 * - POST /api/classify-app — LLM classification for unknown apps
 */

const activityService = require('../services/activity-service');
const logger = require('../utils/logger');

/**
 * POST /api/analyze-batch
 * Accepts array of productive activity records with OCR text,
 * runs text-only LLM to match each to a Jira issue,
 * updates activity_records in Supabase.
 */
async function analyzeBatch(req, res, next) {
  try {
    const { records, user_assigned_issues, user_id, organization_id } = req.body;

    if (!records || !Array.isArray(records) || records.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'records array is required and must not be empty'
      });
    }

    if (!user_id) {
      return res.status(400).json({
        success: false,
        error: 'user_id is required'
      });
    }

    logger.info(`[ActivityController] Analyzing batch of ${records.length} records for user ${user_id}`);

    const result = await activityService.analyzeBatch(
      records,
      user_assigned_issues || [],
      user_id,
      organization_id
    );

    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('[ActivityController] Error in analyzeBatch:', error);
    next(error);
  }
}

/**
 * POST /api/classify-app
 * Accepts unknown app info (name + window title + OCR text),
 * LLM returns classification + confidence + reasoning.
 */
async function classifyApp(req, res, next) {
  try {
    const { application_name, window_title, ocr_text, user_id, organization_id } = req.body;

    if (!application_name) {
      return res.status(400).json({
        success: false,
        error: 'application_name is required'
      });
    }

    logger.info(`[ActivityController] Classifying unknown app: ${application_name}`);

    const result = await activityService.classifyUnknownApp(
      application_name,
      window_title || '',
      ocr_text || '',
      user_id || null,
      organization_id || null
    );

    res.json({ success: true, ...result });
  } catch (error) {
    logger.error('[ActivityController] Error in classifyApp:', error);
    next(error);
  }
}

/**
 * POST /api/identify-app
 * Accepts a search term (app name) and uses LLM to identify
 * what application it likely refers to. Used when:
 * 1. Admin searches for an app not in the database
 * 2. psutil can't find it (app is not currently running)
 * 
 * LLM fallback provides best-guess identification.
 */
async function identifyApp(req, res, next) {
  logger.info('[ActivityController] ========== /api/identify-app REQUEST RECEIVED ==========');
  logger.info('[ActivityController] Request body: %s', JSON.stringify(req.body));
  
  try {
    const { search_term } = req.body;

    if (!search_term || search_term.trim().length < 2) {
      logger.warn('[ActivityController] Invalid search_term: %s', search_term);
      return res.status(400).json({
        success: false,
        error: 'search_term is required and must be at least 2 characters'
      });
    }

    logger.info(`[ActivityController] Calling activityService.identifyAppByName for: "${search_term}"`);

    const result = await activityService.identifyAppByName(search_term.trim());

    logger.info('[ActivityController] Service result: %s', JSON.stringify(result));
    logger.info('[ActivityController] ========== /api/identify-app RESPONSE SENT ==========');
    
    // Wrap result in 'data' field - Forge remoteRequest expects { success, data }
    res.json({ success: true, data: result });
  } catch (error) {
    logger.error('[ActivityController] Error in identifyApp:', error);
    logger.error('[ActivityController] Stack: %s', error.stack);
    next(error);
  }
}

module.exports = { analyzeBatch, classifyApp, identifyApp };
