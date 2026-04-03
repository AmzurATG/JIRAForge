/**
 * User Data Controller
 * 
 * REST API endpoints for personal data export and deletion (GDPR compliance)
 * Implements Atlassian's Personal Data Reporting API
 */

const express = require('express');
const router = express.Router();
const userDataService = require('../services/user-data-service');
const { forgeAuthMiddleware } = require('../middleware/forge-auth');
const { sanitizeLogData } = require('../utils/log-sanitizer');
const logger = require('../utils/logger');

/**
 * POST /api/v1/user-data/status
 * Check status of existing data request
 * 
 * Body: { accountId, cloudId, requestType }
 * Auth: Requires Forge Invocation Token (FIT)
 */
router.post('/status', forgeAuthMiddleware, async (req, res) => {
  try {
    const { accountId, cloudId, requestType } = req.body;

    if (!accountId || !cloudId || !requestType) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: accountId, cloudId, requestType'
      });
    }

    if (!['export', 'delete'].includes(requestType)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid requestType. Must be "export" or "delete"'
      });
    }

    logger.info('[UserData] Checking request status:', sanitizeLogData({
      accountId: accountId.substring(0, 10) + '...',
      cloudId,
      requestType
    }));

    const request = await userDataService.getRequestStatus(accountId, cloudId, requestType);

    res.json({ 
      success: true,
      request 
    });
  } catch (error) {
    logger.error('[UserData] Status check error:', sanitizeLogData(error.message));
    res.status(500).json({ 
      success: false,
      error: 'Internal server error' 
    });
  }
});

/**
 * POST /api/v1/user-data/create-request
 * Create new data request record
 * 
 * Body: { accountId, cloudId, requestType }
 * Auth: Requires Forge Invocation Token (FIT)
 */
router.post('/create-request', forgeAuthMiddleware, async (req, res) => {
  try {
    const { accountId, cloudId, requestType } = req.body;

    if (!accountId || !cloudId || !requestType) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: accountId, cloudId, requestType'
      });
    }

    if (!['export', 'delete'].includes(requestType)) {
      return res.status(400).json({
        success: false,
        error: 'Invalid requestType. Must be "export" or "delete"'
      });
    }

    logger.info('[UserData] Creating new request:', sanitizeLogData({
      accountId: accountId.substring(0, 10) + '...',
      cloudId,
      requestType
    }));

    const request = await userDataService.createRequest(accountId, cloudId, requestType);

    res.status(201).json({
      success: true,
      request
    });
  } catch (error) {
    logger.error('[UserData] Create request error:', sanitizeLogData(error.message));
    res.status(500).json({ 
      success: false,
      error: 'Internal server error' 
    });
  }
});

/**
 * POST /api/v1/user-data/export
 * Export all personal data for a user
 * 
 * Body: { requestId, accountId, cloudId }
 * Auth: Requires Forge Invocation Token (FIT)
 */
router.post('/export', forgeAuthMiddleware, async (req, res) => {
  const startTime = Date.now();

  try {
    const { requestId, accountId, cloudId } = req.body;

    if (!requestId || !accountId || !cloudId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: requestId, accountId, cloudId'
      });
    }

    logger.info('[UserData] Starting export:', sanitizeLogData({
      requestId,
      accountId: accountId.substring(0, 10) + '...',
      cloudId
    }));

    // Update status to processing
    await userDataService.updateRequestStatus(requestId, 'processing');

    // Execute export
    const exportData = await userDataService.exportUserData(accountId, cloudId);

    // Generate signed URL for download (24hr expiry)
    const signedUrl = await userDataService.generateSignedUrlForExport(exportData, requestId);

    const processingDuration = Date.now() - startTime;

    // Update status to completed
    await userDataService.updateRequestStatus(requestId, 'completed', {
      result_url: signedUrl,
      result_data: {
        size_bytes: JSON.stringify(exportData).length,
        exported_at: new Date().toISOString(),
        record_counts: {
          screenshots: exportData.screenshotCount || 0,
          analysis_results: exportData.analysisResultCount || 0,
          activity_records: exportData.activityRecordCount || 0,
          worklogs: exportData.worklogCount || 0,
          documents: exportData.documentCount || 0,
          feedback: exportData.feedbackCount || 0,
          storage_files: exportData.storageSummary?.totalFiles || 0
        }
      },
      processing_duration_ms: processingDuration
    });

    logger.info('[UserData] Export completed:', sanitizeLogData({
      requestId,
      duration_ms: processingDuration,
      size_bytes: JSON.stringify(exportData).length
    }));

    res.json({
      success: true,
      requestId,
      signedUrl,
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
      processingDurationMs: processingDuration
    });
  } catch (error) {
    logger.error('[UserData] Export error:', sanitizeLogData(error.message));

    // Update status to failed
    try {
      await userDataService.updateRequestStatus(req.body.requestId, 'failed', {
        error_message: error.message,
        processing_duration_ms: Date.now() - startTime
      });
    } catch (updateError) {
      logger.error('[UserData] Failed to update request status:', sanitizeLogData(updateError.message));
    }

    res.status(500).json({ 
      success: false,
      error: 'Export failed: ' + error.message 
    });
  }
});

/**
 * POST /api/v1/user-data/delete
 * Permanently delete all personal data for a user
 * 
 * Body: { requestId, accountId, cloudId }
 * Auth: Requires Forge Invocation Token (FIT)
 */
router.post('/delete', forgeAuthMiddleware, async (req, res) => {
  const startTime = Date.now();

  try {
    const { requestId, accountId, cloudId } = req.body;

    if (!requestId || !accountId || !cloudId) {
      return res.status(400).json({
        success: false,
        error: 'Missing required fields: requestId, accountId, cloudId'
      });
    }

    logger.info('[UserData] Starting deletion:', sanitizeLogData({
      requestId,
      accountId: accountId.substring(0, 10) + '...',
      cloudId
    }));

    // Update status to processing
    await userDataService.updateRequestStatus(requestId, 'processing');

    // Execute deletion
    const deletionSummary = await userDataService.deleteUserData(accountId, cloudId);

    const processingDuration = Date.now() - startTime;

    // Update status to completed
    await userDataService.updateRequestStatus(requestId, 'completed', {
      result_data: {
        records_deleted: deletionSummary.recordsDeleted,
        files_deleted: deletionSummary.filesDeleted,
        deleted_at: deletionSummary.deletedAt
      },
      processing_duration_ms: processingDuration
    });

    logger.info('[UserData] Deletion completed:', sanitizeLogData({
      requestId,
      duration_ms: processingDuration,
      total_records_deleted: Object.values(deletionSummary.recordsDeleted).reduce((a, b) => a + b, 0),
      files_deleted: deletionSummary.filesDeleted
    }));

    res.json({
      success: true,
      requestId,
      summary: deletionSummary,
      processingDurationMs: processingDuration
    });
  } catch (error) {
    logger.error('[UserData] Deletion error:', sanitizeLogData(error.message));

    // Update status to failed
    try {
      await userDataService.updateRequestStatus(req.body.requestId, 'failed', {
        error_message: error.message,
        processing_duration_ms: Date.now() - startTime
      });
    } catch (updateError) {
      logger.error('[UserData] Failed to update request status:', sanitizeLogData(updateError.message));
    }

    res.status(500).json({ 
      success: false,
      error: 'Deletion failed: ' + error.message 
    });
  }
});

module.exports = router;
