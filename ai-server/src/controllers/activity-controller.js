/**
 * Activity Controller
 * Handles endpoints for the new event-based activity tracking pipeline.
 * - POST /api/analyze-batch — text-only LLM task matching for productive records
 * - POST /api/classify-app — LLM classification for unknown apps
 */

const activityService = require('../services/activity-service');
const activityDbService = require('../services/db/activity-db-service');
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

    // Atomically claim records (pending → processing) to prevent race with polling service.
    // Only process records we successfully claimed. If another process already claimed them,
    // we skip gracefully — the other process will handle them.
    const recordIds = records.filter(r => r.id).map(r => r.id);
    let claimedIds = new Set();
    if (recordIds.length > 0) {
      try {
        const claimed = await activityDbService.claimBatchForProcessing(recordIds);
        claimedIds = new Set(claimed.map(c => c.id));
      } catch (claimErr) {
        logger.warn(`[ActivityController] Claim failed (non-fatal): ${claimErr.message}`);
        // If claim fails (e.g. DB issue), proceed with all records — worst case is a double-process
        // which results in the same outcome (idempotent update).
        claimedIds = new Set(recordIds);
      }
    }

    // Filter to only claimed records (skip records another process already owns).
    // Distinguish between "no records have IDs" (can't claim, just process all)
    // and "records have IDs but none were claimable" (all already owned → skip).
    let recordsToAnalyze;
    if (recordIds.length === 0) {
      // No records have IDs (unusual edge case) — can't claim, process all
      recordsToAnalyze = records;
    } else if (claimedIds.size === 0) {
      // All records had IDs but none were claimable (already processing elsewhere)
      recordsToAnalyze = [];
    } else {
      // Process only the records we successfully claimed
      recordsToAnalyze = records.filter(r => !r.id || claimedIds.has(r.id));
    }

    if (recordsToAnalyze.length === 0) {
      logger.info('[ActivityController] All records already claimed by polling service, skipping');
      return res.json({ success: true, recordsProcessed: 0, alreadyClaimed: true });
    }

    // Fetch session continuity context and correction patterns (same as polling service)
    let previousMatchContext = null;
    let correctionPatterns = null;
    try {
      previousMatchContext = await activityDbService.getRecentMatchForUser(user_id);
    } catch (ctxErr) {
      logger.debug(`[ActivityController] Failed to fetch recent match context: ${ctxErr.message}`);
    }
    try {
      correctionPatterns = await activityDbService.getRecentCorrectionPatterns(user_id);
    } catch (cpErr) {
      logger.debug(`[ActivityController] Failed to fetch correction patterns: ${cpErr.message}`);
    }

    const result = await activityService.analyzeBatch(
      recordsToAnalyze,
      user_assigned_issues || [],
      user_id,
      organization_id,
      previousMatchContext,
      correctionPatterns
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

/**
 * POST /api/activity
 * Create activity record with idempotency check.
 * 
 * AC3: Duplicate request_id returns 200 with {duplicate: true} and creates zero new records.
 * 
 * Security: No PII (window_title) logged at info level per copilot-instructions.md.
 */
async function createActivity(req, res) {
  const { request_id, org_id, user_id, timestamp, window_title, duration_seconds } = req.body;
  
  // Validate request_id is present
  if (!request_id) {
    logger.warn('Activity submission missing request_id', { org_id, user_id });
    return res.status(400).json({ error: 'request_id is required' });
  }
  
  try {
    // Check if already processed (idempotency)
    const existing = await activityDbService.findByRequestId(org_id, request_id);
    if (existing) {
      logger.debug('Duplicate activity submission detected', { 
        request_id, 
        existing_id: existing.id,
        org_id
      });
      return res.status(200).json({ 
        id: existing.id, 
        duplicate: true,
        message: 'Activity already recorded'
      });
    }
    
    // Insert with request_id
    const result = await activityDbService.createWithRequestId({
      request_id,
      org_id,
      user_id,
      timestamp,
      window_title,
      duration_seconds,
      created_at: new Date().toISOString()
    });
    
    logger.info('Activity recorded', { 
      activity_id: result.id, 
      org_id, 
      user_id, 
      duration: duration_seconds 
    });
    
    return res.status(201).json({ 
      id: result.id, 
      duplicate: false 
    });
    
  } catch (error) {
    logger.error('Activity creation failed', { 
      error: error.message, 
      org_id, 
      user_id,
      request_id 
    });
    return res.status(500).json({ error: 'Internal server error' });
  }
}

module.exports = { analyzeBatch, classifyApp, identifyApp, createActivity };
