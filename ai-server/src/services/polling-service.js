const screenshotService = require('./screenshot-service');
const supabaseService = require('./supabase-service');
const logger = require('../utils/logger');
const { getUTCISOString, toUTCISOString } = require('../utils/datetime');

// Feature flag: Delete screenshots after analysis (default: true for privacy)
const DELETE_AFTER_ANALYSIS = process.env.DELETE_SCREENSHOTS_AFTER_ANALYSIS !== 'false';

class PollingService {
  isRunning = false;
  intervalId = null;
  pollInterval = Number.parseInt(process.env.POLLING_INTERVAL_MS || '180000', 10);
  batchSize = Number.parseInt(process.env.POLLING_BATCH_SIZE || '10', 10);
  processing = false;

  constructor() {
    // Initialization handled by class fields
  }

  /**
   * Start the polling service
   */
  start() {
    if (this.isRunning) {
      logger.warn('Polling service is already running');
      return;
    }

    this.isRunning = true;
    logger.info(`Starting polling service (interval: ${this.pollInterval}ms, batch size: ${this.batchSize})`);

    // Process immediately on start - handle promise rejection to prevent crash
    this.processPendingScreenshots().catch(error => {
      logger.error('Error in initial polling cycle:', error);
      // Don't stop the service - the interval will retry
    });

    // Then set up interval
    this.intervalId = setInterval(() => {
      this.processPendingScreenshots().catch(error => {
        logger.error('Error in polling cycle:', error);
      });
    }, this.pollInterval);
  }

  /**
   * Stop the polling service
   */
  stop() {
    if (!this.isRunning) {
      return;
    }

    this.isRunning = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }

    logger.info('Polling service stopped');
  }

  /**
   * Process pending screenshots
   */
  async processPendingScreenshots() {
    // Skip if already processing (prevent overlapping runs)
    if (this.processing) {
      logger.debug('Previous polling cycle still running, skipping this cycle');
      return;
    }

    this.processing = true;

    try {
      // Reset screenshots stuck in 'processing' for too long (e.g., crashed/hung analysis)
      // This recovers screenshots that were claimed but never completed
      await supabaseService.resetStuckProcessingScreenshots(10);

      // Fetch pending screenshots from Supabase
      const pendingScreenshots = await supabaseService.getPendingScreenshots(this.batchSize);

      if (pendingScreenshots.length === 0) {
        logger.debug('No pending screenshots to process');
        return;
      }

      logger.info(`Processing ${pendingScreenshots.length} pending screenshot(s)`);

      // Track processing results
      let successCount = 0;
      let failureCount = 0;

      // Per-screenshot timeout (default: 90 seconds)
      const screenshotTimeoutMs = Number.parseInt(process.env.SCREENSHOT_PROCESSING_TIMEOUT_MS || '90000', 10);

      // Process each screenshot
      for (const screenshot of pendingScreenshots) {
        try {
          // Wrap processScreenshot with a timeout to prevent any single screenshot from hanging
          await Promise.race([
            this.processScreenshot(screenshot),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`Screenshot processing timed out after ${screenshotTimeoutMs / 1000}s`)), screenshotTimeoutMs)
            )
          ]);
          successCount++;
        } catch (error) {
          failureCount++;
          logger.error('Error processing screenshot', {
            screenshot_id: screenshot.id,
            error: error.message
          });

          // Update status to failed
          try {
            await supabaseService.updateScreenshotStatus(
              screenshot.id,
              'failed',
              error.message
            );
          } catch (updateError) {
            logger.error('Failed to update screenshot status to failed', {
              screenshot_id: screenshot.id,
              error: updateError.message
            });
          }
        }
      }

      // Log accurate completion count
      const totalProcessed = successCount + failureCount;
      if (failureCount > 0) {
        logger.info(`Completed processing ${totalProcessed} screenshot(s): ${successCount} succeeded, ${failureCount} failed`);
      } else {
        logger.info(`Completed processing ${totalProcessed} screenshot(s): all succeeded`);
      }

    } catch (error) {
      // Handle network errors gracefully - these are expected in corporate environments
      const errorMessage = error.message || '';
      const isNetworkError = 
        errorMessage.includes('ENOTFOUND') ||
        errorMessage.includes('ECONNREFUSED') ||
        errorMessage.includes('ETIMEDOUT') ||
        errorMessage.includes('timeout') ||
        errorMessage.includes('certificate') ||
        errorMessage.includes('fetch failed');

      if (isNetworkError) {
        // Log network errors at debug level to reduce noise
        // These are expected in corporate networks with proxies/firewalls
        logger.debug('Network error in polling cycle (will retry on next cycle)', {
          error: errorMessage.substring(0, 100) // Truncate long error messages
        });
      } else {
        // Log other errors at error level
        logger.error('Error in polling cycle:', error);
      }
    } finally {
      this.processing = false;
    }
  }

  /**
   * Process a single screenshot
   * @param {Object} screenshot - Screenshot record from database
   */
  async processScreenshot(screenshot) {
    const {
      id: screenshot_id,
      user_id,
      organization_id,  // Multi-tenancy: Get organization_id from screenshot
      storage_path,
      window_title,
      application_name,
      timestamp,
      duration_seconds,  // Event-based tracking: Duration set by desktop app
      start_time,        // Event-based tracking: Start time set by desktop app
      end_time,          // Event-based tracking: End time set by desktop app
      user_assigned_issues
    } = screenshot;

    logger.info('Processing screenshot', {
      screenshot_id,
      user_id,
      application_name
    });

    // Atomically claim the screenshot for processing (prevents webhook + polling race condition)
    const claimed = await supabaseService.claimScreenshotForProcessing(screenshot_id);
    if (!claimed) {
      logger.info('Screenshot already claimed by another process, skipping', { screenshot_id });
      return;
    }

    let parsedAssignedIssues = this._parseAssignedIssues(user_assigned_issues, screenshot_id);
    if (!Array.isArray(parsedAssignedIssues) || parsedAssignedIssues.length === 0) {
      parsedAssignedIssues = await this._getCachedAssignedIssues(user_id, organization_id);
    }

    // Download screenshot from Supabase Storage
    const imageBuffer = await supabaseService.downloadFile('screenshots', storage_path);

    // Analyze the screenshot using GPT-4 Vision
    const analysis = await screenshotService.analyzeActivity({
      imageBuffer,
      windowTitle: window_title,
      applicationName: application_name,
      timestamp,
      userId: user_id,
      userAssignedIssues: parsedAssignedIssues || []
    });

    const actualDuration = duration_seconds ?? analysis.timeSpentSeconds;

    await supabaseService.saveAnalysisResult({
      screenshot_id,
      user_id,
      organization_id,
      time_spent_seconds: actualDuration,
      active_task_key: analysis.taskKey,
      active_project_key: analysis.projectKey,
      confidence_score: analysis.confidenceScore,
      extracted_text: analysis.metadata?.extractedText || '',
      work_type: analysis.workType,
      ai_model_version: analysis.modelVersion,
      analysis_metadata: analysis.metadata
    });

    await this._updateScreenshotDurationIfNeeded({
      screenshot_id,
      duration_seconds,
      actualDuration,
      start_time,
      end_time,
      timestamp
    });

    await supabaseService.updateScreenshotStatus(screenshot_id, 'analyzed');

    await this._deleteScreenshotFilesIfNeeded(screenshot_id, storage_path, user_id);

    await this._createWorklogIfNeeded({
      analysis,
      user_id,
      screenshot_id,
      timestamp
    });

    logger.info('Screenshot analysis completed', {
      screenshot_id,
      taskKey: analysis.taskKey,
      confidenceScore: analysis.confidenceScore,
      workType: analysis.workType
    });
  }

  _parseAssignedIssues(user_assigned_issues, screenshot_id) {
    let parsed = user_assigned_issues;
    if (typeof parsed === 'string') {
      try {
        parsed = JSON.parse(parsed);
      } catch (err) {
        logger.warn('Failed to parse user_assigned_issues', { screenshot_id, error: err });
        parsed = [];
      }
    }
    return parsed;
  }

  async _getCachedAssignedIssues(user_id, organization_id) {
    const cachedIssues = await supabaseService.getUserCachedIssues(user_id, organization_id);
    return cachedIssues.map(issue => ({
      key: issue.issue_key,
      summary: issue.summary,
      status: issue.status,
      projectKey: issue.project_key
    }));
  }

  async _updateScreenshotDurationIfNeeded({ screenshot_id, duration_seconds, actualDuration, start_time, end_time, timestamp }) {
    // Only update if desktop app hasn't already set the values
    if (duration_seconds == null || start_time == null || end_time == null) {
      const calculatedEndTime = timestamp || getUTCISOString();
      const calculatedStartTime = toUTCISOString(new Date(new Date(calculatedEndTime).getTime() - (actualDuration * 1000)));
      await supabaseService.updateScreenshotDuration(screenshot_id, {
        duration_seconds: duration_seconds ?? actualDuration,
        start_time: start_time ?? calculatedStartTime,
        end_time: end_time ?? calculatedEndTime
      });
    }
  }

  async _deleteScreenshotFilesIfNeeded(screenshot_id, storage_path, user_id) {
    if (DELETE_AFTER_ANALYSIS && storage_path) {
      try {
        await supabaseService.deleteFile('screenshots', storage_path);
        logger.info('Deleted screenshot from storage after analysis', {
          screenshot_id,
          storage_path
        });

        const thumbPath = storage_path.replace('screenshot_', 'thumb_').replace('.png', '.jpg');
        try {
          await supabaseService.deleteFile('screenshots', thumbPath);
          logger.debug('Deleted thumbnail from storage', { thumbPath });
        } catch (thumbError) {
          logger.debug('Thumbnail not found or already deleted', { thumbPath, error: thumbError });
        }

        await supabaseService.clearStorageUrls(screenshot_id);
        logger.debug('Cleared storage URLs in database', { screenshot_id });
      } catch (deleteError) {
        logger.warn('Failed to delete screenshot from storage (non-critical)', {
          screenshot_id,
          storage_path,
          error: deleteError.message
        });
      }
    }
  }

  async _createWorklogIfNeeded({ analysis, user_id, screenshot_id, timestamp }) {
    if (analysis.taskKey && analysis.workType === 'office' && process.env.AUTO_CREATE_WORKLOGS === 'true') {
      try {
        await screenshotService.createWorklog({
          userId: user_id,
          issueKey: analysis.taskKey,
          timeSpentSeconds: analysis.timeSpentSeconds,
          startedAt: timestamp
        });
        await supabaseService.markWorklogCreated(screenshot_id, analysis.taskKey);
      } catch (worklogError) {
        logger.error('Failed to create worklog', {
          error: worklogError.message,
          screenshot_id
        });
      }
    }
  }
}

// Create singleton instance
const pollingService = new PollingService();

module.exports = pollingService;
