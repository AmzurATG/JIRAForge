/**
 * Activity Polling Service
 * Polls activity_records table for pending records and processes them.
 * Runs alongside the existing polling-service.js (old pipeline continues for old clients).
 *
 * Pattern: Same as polling-service.js — singleton class with start/stop/processing lock.
 */

const activityService = require('./activity-service');
const activityDbService = require('./db/activity-db-service');
const logger = require('../utils/logger');

/**
 * Parse user assigned issues from activity record
 * @param {*} userAssignedIssues - Raw assigned issues data
 * @returns {Array} Parsed array of issues
 */
function parseUserAssignedIssues(userAssignedIssues) {
  if (!userAssignedIssues) {
    return [];
  }

  try {
    const parsed = typeof userAssignedIssues === 'string'
      ? JSON.parse(userAssignedIssues)
      : userAssignedIssues;
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    logger.debug('Failed to parse user_assigned_issues: %s', error.message);
    return [];
  }
}

/**
 * Extract first non-empty user assigned issues from records
 * @param {Array} records - Activity records
 * @returns {Array} User assigned issues
 */
function extractUserAssignedIssues(records) {
  for (const record of records) {
    if (!record.user_assigned_issues) {
      continue;
    }

    const parsed = parseUserAssignedIssues(record.user_assigned_issues);
    if (parsed.length > 0) {
      return parsed;
    }
  }
  return [];
}

/**
 * Check if error is a network error
 * @param {Error} error - Error object
 * @returns {boolean} True if network error
 */
function isNetworkError(error) {
  const errorMessage = error?.message || '';
  return errorMessage.includes('ENOTFOUND') ||
         errorMessage.includes('ECONNREFUSED') ||
         errorMessage.includes('ETIMEDOUT') ||
         errorMessage.includes('timeout') ||
         errorMessage.includes('certificate') ||
         errorMessage.includes('fetch failed');
}

/**
 * Group pending records by user ID
 * @param {Array} records - Pending records
 * @returns {Object} Records grouped by user_id
 */
function groupRecordsByUser(records) {
  const userBatches = {};
  for (const record of records) {
    const key = record.user_id;
    if (!userBatches[key]) {
      userBatches[key] = [];
    }
    userBatches[key].push(record);
  }
  return userBatches;
}

/**
 * Transform record to analysis format
 * @param {Object} record - Activity record
 * @returns {Object} Formatted record for analysis
 */
function transformRecordForAnalysis(record) {
  return {
    id: record.id,
    window_title: record.window_title,
    application_name: record.application_name,
    ocr_text: record.ocr_text,
    total_time_seconds: record.total_time_seconds,
    start_time: record.start_time,
    end_time: record.end_time,
    classification: record.classification,
    metadata: record.metadata
  };
}

/**
 * Log processing completion summary
 * @param {number} successCount - Number of successful records
 * @param {number} failureCount - Number of failed records
 */
function logCompletionSummary(successCount, failureCount) {
  const totalProcessed = successCount + failureCount;
  
  if (totalProcessed === 0) {
    return;
  }

  if (failureCount > 0) {
    logger.info(`Activity polling completed: ${totalProcessed} record(s) — ${successCount} succeeded, ${failureCount} failed`);
  } else {
    logger.info(`Activity polling completed: ${totalProcessed} record(s) — all succeeded`);
  }
}

class ActivityPollingService {
  isRunning = false;
  intervalId = null;
  processing = false;
  // Poll every 3 minutes by default (configurable via env)
  pollInterval = Number.parseInt(process.env.ACTIVITY_POLLING_INTERVAL_MS || '180000', 10);
  batchSize = Number.parseInt(process.env.ACTIVITY_POLLING_BATCH_SIZE || '20', 10);

  /**
   * Start the activity polling service
   */
  start() {
    if (this.isRunning) {
      logger.warn('Activity polling service is already running');
      return;
    }

    this.isRunning = true;
    logger.info(`Starting activity polling service (interval: ${this.pollInterval}ms, batch size: ${this.batchSize})`);

    // Process immediately on start
    this.processPendingRecords().catch(error => {
      logger.error('Error in initial activity polling cycle:', error);
    });

    // Then set up interval
    this.intervalId = setInterval(() => {
      this.processPendingRecords().catch(error => {
        logger.error('Error in activity polling cycle:', error);
      });
    }, this.pollInterval);
  }

  /**
   * Stop the activity polling service
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

    logger.info('Activity polling service stopped');
  }

  /**
   * Process a single user batch
   * @param {string} userId - User ID
   * @param {Array} records - Activity records for this user
   * @returns {Promise<number>} Number of successfully processed records
   */
  async processSingleBatch(userId, records) {
    const recordIds = records.map(r => r.id);

    // Atomically claim records for processing
    const claimed = await activityDbService.claimBatchForProcessing(recordIds);
    if (claimed.length === 0) {
      logger.info('Activity records already claimed by another process, skipping');
      return 0;
    }

    // Extract user's assigned issues from the records
    const userAssignedIssues = extractUserAssignedIssues(records);

    // Per-batch timeout (default: 60 seconds)
    const batchTimeoutMs = Number.parseInt(process.env.ACTIVITY_BATCH_TIMEOUT_MS || '60000', 10);

    // Analyze the batch with timeout
    await Promise.race([
      activityService.analyzeBatch(
        records.map(transformRecordForAnalysis),
        userAssignedIssues,
        userId,
        records[0]?.organization_id
      ),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Batch processing timed out after ${batchTimeoutMs / 1000}s`)), batchTimeoutMs)
      )
    ]);

    logger.info(`Batch for user ${userId}: ${claimed.length} records analyzed`);
    return claimed.length;
  }

  /**
   * Process all user batches concurrently (up to ACTIVITY_POLLING_CONCURRENCY at a time)
   * @param {Object} userBatches - Batches grouped by user ID
   * @returns {Promise<Object>} Success and failure counts
   */
  async processUserBatches(userBatches) {
    const concurrencyLimit = Number.parseInt(process.env.ACTIVITY_POLLING_CONCURRENCY || '10', 10);
    let successCount = 0;
    let failureCount = 0;

    const entries = Object.entries(userBatches);

    for (let i = 0; i < entries.length; i += concurrencyLimit) {
      const chunk = entries.slice(i, i + concurrencyLimit);
      const results = await Promise.allSettled(
        chunk.map(([userId, records]) => this.processSingleBatch(userId, records))
      );

      for (let j = 0; j < results.length; j++) {
        const result = results[j];
        const [userId, records] = chunk[j];
        if (result.status === 'fulfilled') {
          successCount += result.value;
        } else {
          failureCount += records.length;
          const recordIds = records.map(r => r.id);
          logger.error(`Error processing activity batch for user ${userId}:`, result.reason);
          await activityDbService.markBatchFailed(recordIds, result.reason.message);
        }
      }
    }

    return { successCount, failureCount };
  }

  /**
   * Process pending activity records
   */
  async processPendingRecords() {
    // Skip if already processing (prevent overlapping runs)
    if (this.processing) {
      logger.debug('Previous activity polling cycle still running, skipping');
      return;
    }

    this.processing = true;

    try {
      // Reset records stuck in 'processing' for too long
      await activityDbService.resetStuckProcessingRecords(10);

      // Get pending records (only productive records that need AI analysis)
      const pendingRecords = await activityDbService.getPendingActivityBatches(this.batchSize);

      if (pendingRecords.length === 0) {
        logger.debug('No pending activity records to process');
        return;
      }

      logger.info(`Processing ${pendingRecords.length} pending activity record(s)`);

      // Group records by user_id for efficient batch processing
      const userBatches = groupRecordsByUser(pendingRecords);

      // Process each user's batch
      const { successCount, failureCount } = await this.processUserBatches(userBatches);

      // Log completion summary
      logCompletionSummary(successCount, failureCount);

    } catch (error) {
      // Handle network errors gracefully
      if (isNetworkError(error)) {
        logger.debug('Network error in activity polling (will retry on next cycle)');
      } else {
        logger.error('Error in activity polling cycle:', error);
      }
    } finally {
      this.processing = false;
    }
  }
}

// Create singleton instance
const activityPollingService = new ActivityPollingService();

module.exports = activityPollingService;
