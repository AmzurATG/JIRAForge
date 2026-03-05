/**
 * Cleanup Service
 * Deletes old screenshot files from Supabase Storage (PNG screenshots and JPG thumbnails)
 * Runs monthly to delete files older than 2 months
 * Database records are preserved for time tracking history
 */

const { getClient } = require('./db/supabase-client');
const { deleteFile } = require('./db/storage-service');
const logger = require('../utils/logger');
const { toUTCISOString } = require('../utils/datetime');

// Configuration (can be overridden via environment variables)
const CLEANUP_SCHEDULE_DAY = Number.parseInt(process.env.CLEANUP_SCHEDULE_DAY || '1', 10); // 1st of month
const CLEANUP_SCHEDULE_HOUR = Number.parseInt(process.env.CLEANUP_SCHEDULE_HOUR || '3', 10); // 3 AM
const CLEANUP_SCHEDULE_MINUTE = Number.parseInt(process.env.CLEANUP_SCHEDULE_MINUTE || '0', 10); // 0 minutes
const MONTHS_TO_KEEP = Number.parseInt(process.env.CLEANUP_MONTHS_TO_KEEP || '2', 10); // Keep last 2 months
const BATCH_SIZE = Number.parseInt(process.env.CLEANUP_BATCH_SIZE || '50', 10); // Process 50 screenshots per batch

let scheduledTimeoutId = null;
let isRunning = false;

/**
 * Get the cutoff date for cleanup (files older than this will be deleted)
 * @returns {Date} Cutoff date
 */
function getCutoffDate() {
  const cutoff = new Date();
  cutoff.setMonth(cutoff.getMonth() - MONTHS_TO_KEEP);
  cutoff.setDate(1); // First day of that month
  cutoff.setHours(0, 0, 0, 0);
  return cutoff;
}

/**
 * Get screenshots that need cleanup (files older than cutoff date)
 * @param {number} limit - Maximum number of screenshots to fetch
 * @param {number} offset - Offset for pagination
 * @returns {Promise<Array>} Array of screenshots with storage_path
 */
async function getScreenshotsForCleanup(limit = BATCH_SIZE, offset = 0) {
  try {
    const supabase = getClient();
    const cutoffDate = getCutoffDate();
    const cutoffDateString = toUTCISOString(cutoffDate);

    logger.info(`[Cleanup] Fetching screenshots older than ${cutoffDate.toLocaleDateString()}`);

    // Get screenshots that:
    // 1. Have a storage_path (file exists)
    // 2. Are older than the cutoff date
    // 3. Haven't been marked as deleted yet (deleted_at is null, status is not 'deleted')
    const { data, error } = await supabase
      .from('screenshots')
      .select('id, storage_path, thumbnail_url, created_at')
      .lt('created_at', cutoffDateString)
      .not('storage_path', 'is', null)
      .is('deleted_at', null)
      .neq('status', 'deleted')
      .order('created_at', { ascending: true })
      .range(offset, offset + limit - 1);

    if (error) {
      throw error;
    }

    return data || [];
  } catch (error) {
    logger.error('[Cleanup] Error fetching screenshots for cleanup:', error);
    throw error;
  }
}

/**
 * Transform filename from screenshot to thumbnail format
 * @param {string} filename - Original filename
 * @returns {string} Thumbnail filename
 */
function transformToThumbnailFilename(filename) {
  return filename.replace('screenshot_', 'thumb_').replace('.png', '.jpg');
}

/**
 * Get the thumbnail path from storage_path
 * Converts screenshot_xxx.png to thumb_xxx.jpg
 * @param {string} storagePath - Original screenshot storage path
 * @returns {string} Thumbnail storage path
 */
function getThumbnailPath(storagePath) {
  if (!storagePath) return null;

  if (!storagePath.includes('/')) {
    return transformToThumbnailFilename(storagePath);
  }

  const dirPath = storagePath.substring(0, storagePath.lastIndexOf('/'));
  const filename = storagePath.substring(storagePath.lastIndexOf('/') + 1);
  const thumbFilename = transformToThumbnailFilename(filename);
  return `${dirPath}/${thumbFilename}`;
}

/**
 * Delete a single file from storage
 * @param {string} type - File type ('screenshot' or 'thumbnail')
 * @param {string} path - Storage path
 * @returns {Promise<boolean>} True if deleted successfully
 */
async function deleteSingleFile(type, path) {
  try {
    await deleteFile('screenshots', path);
    logger.debug(`[Cleanup] Deleted ${type}: ${path}`);
    return true;
  } catch (error) {
    logger.warn(`[Cleanup] Could not delete ${type} ${path}: ${error.message}`);
    return false;
  }
}

/**
 * Delete a screenshot and its thumbnail from storage
 * @param {string} storagePath - Path to the screenshot file
 * @returns {Promise<{screenshotDeleted: boolean, thumbnailDeleted: boolean}>}
 */
async function deleteScreenshotFiles(storagePath) {
  const result = { screenshotDeleted: false, thumbnailDeleted: false };

  if (!storagePath) {
    return result;
  }

  // Delete the main screenshot
  result.screenshotDeleted = await deleteSingleFile('screenshot', storagePath);

  // Delete the thumbnail
  const thumbPath = getThumbnailPath(storagePath);
  if (thumbPath) {
    result.thumbnailDeleted = await deleteSingleFile('thumbnail', thumbPath);
  }

  return result;
}

/**
 * Mark screenshot as having files deleted in the database
 * Uses existing deleted_at column and sets status to 'deleted'
 * @param {string} screenshotId - Screenshot ID
 * @returns {Promise<void>}
 */
async function markFilesAsDeleted(screenshotId) {
  try {
    const supabase = getClient();
    const { error } = await supabase
      .from('screenshots')
      .update({
        storage_url: '',
        thumbnail_url: '',
        status: 'deleted',
        deleted_at: toUTCISOString(new Date())
      })
      .eq('id', screenshotId);

    if (error) {
      throw error;
    }
  } catch (error) {
    logger.error(`[Cleanup] Error marking screenshot ${screenshotId} as deleted:`, error);
    throw error;
  }
}

/**
 * Process a single screenshot for cleanup
 * @param {Object} screenshot - Screenshot record
 * @returns {Promise<boolean>} True if files were deleted
 */
async function processScreenshotForCleanup(screenshot) {
  // Delete files from storage
  const deleteResult = await deleteScreenshotFiles(screenshot.storage_path);

  // Mark as deleted in database (even if file deletion failed - file may already be gone)
  await markFilesAsDeleted(screenshot.id);

  return deleteResult.screenshotDeleted || deleteResult.thumbnailDeleted;
}

/**
 * Process a batch of screenshots
 * @param {Array} screenshots - Screenshots to process
 * @returns {Promise<{deleted: number, errors: number}>} Processing results
 */
async function processScreenshotBatch(screenshots) {
  let deleted = 0;
  let errors = 0;

  for (const screenshot of screenshots) {
    try {
      const wasDeleted = await processScreenshotForCleanup(screenshot);
      if (wasDeleted) {
        deleted++;
      }
    } catch (error) {
      errors++;
      logger.error(`[Cleanup] Error processing screenshot ${screenshot.id}:`, error);
    }
  }

  return { deleted, errors };
}

/**
 * Check if we should continue processing more batches
 * @param {Array} screenshots - Current batch of screenshots
 * @returns {boolean} True if should continue
 */
function shouldContinueBatch(screenshots) {
  return screenshots.length >= BATCH_SIZE;
}

/**
 * Process all batches of screenshots
 * @returns {Promise<{deleted: number, errors: number}>} Total results
 */
async function processAllBatches() {
  let totalDeleted = 0;
  let totalErrors = 0;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const screenshots = await getScreenshotsForCleanup(BATCH_SIZE, offset);

    if (screenshots.length === 0) {
      break;
    }

    logger.info(`[Cleanup] Processing batch of ${screenshots.length} screenshots (offset: ${offset})`);

    const { deleted, errors } = await processScreenshotBatch(screenshots);
    totalDeleted += deleted;
    totalErrors += errors;

    hasMore = shouldContinueBatch(screenshots);

    // Small delay between batches to avoid rate limiting
    if (hasMore) {
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }

  return { deleted: totalDeleted, errors: totalErrors };
}

/**
 * Main cleanup function - deletes old screenshot files from storage
 * @returns {Promise<{success: boolean, deleted: number, errors: number}>}
 */
async function runCleanup() {
  if (isRunning) {
    logger.warn('[Cleanup] Cleanup is already running, skipping');
    return { success: false, deleted: 0, errors: 0 };
  }

  isRunning = true;
  const startTime = Date.now();

  try {
    const cutoffDate = getCutoffDate();
    logger.info(`[Cleanup] Starting monthly cleanup job - deleting files older than ${cutoffDate.toLocaleDateString()}`);

    const { deleted, errors } = await processAllBatches();

    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    logger.info(`[Cleanup] Monthly cleanup completed in ${duration}s - ${deleted} files deleted, ${errors} errors`);

    return { success: true, deleted, errors };
  } catch (error) {
    logger.error('[Cleanup] Error in cleanup job:', error);
    return { success: false, deleted: 0, errors: 0 };
  } finally {
    isRunning = false;
  }
}

/**
 * Calculate milliseconds until the next scheduled cleanup time
 * Runs on the 1st of each month at 3 AM
 * @returns {number} Milliseconds until next scheduled run
 */
function getMillisecondsUntilScheduledTime() {
  const now = new Date();
  const scheduledTime = new Date();

  // Set to the scheduled day, hour, and minute
  scheduledTime.setDate(CLEANUP_SCHEDULE_DAY);
  scheduledTime.setHours(CLEANUP_SCHEDULE_HOUR, CLEANUP_SCHEDULE_MINUTE, 0, 0);

  // If scheduled time has passed this month, schedule for next month
  if (scheduledTime <= now) {
    scheduledTime.setMonth(scheduledTime.getMonth() + 1);
  }

  return scheduledTime.getTime() - now.getTime();
}

/**
 * Check if timeout exceeds maximum safe value
 * @param {number} ms - Milliseconds
 * @returns {boolean} True if exceeds max timeout
 */
function exceedsMaxTimeout(ms) {
  const MAX_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours in ms
  return ms > MAX_TIMEOUT;
}

/**
 * Schedule intermediate check (for timeouts > 24 hours)
 */
function scheduleIntermediateCheck() {
  const MAX_TIMEOUT = 24 * 60 * 60 * 1000;
  logger.info(`[Cleanup] Scheduling intermediate check in 24 hours (timeout too large for single setTimeout)`);
  scheduledTimeoutId = setTimeout(() => {
    scheduleNextRun(); // Re-check and schedule again
  }, MAX_TIMEOUT);
}

/**
 * Schedule direct cleanup run
 * @param {number} msUntilNextRun - Milliseconds until next run
 */
function scheduleDirectRun(msUntilNextRun) {
  scheduledTimeoutId = setTimeout(async () => {
    await runCleanup();
    scheduleNextRun(); // Schedule the next month's run
  }, msUntilNextRun);
}

/**
 * Log next scheduled run time
 * @param {number} msUntilNextRun - Milliseconds until next run
 */
function logNextRunTime(msUntilNextRun) {
  const daysUntilNextRun = (msUntilNextRun / (1000 * 60 * 60 * 24)).toFixed(2);
  const nextRunTime = new Date(Date.now() + msUntilNextRun);
  logger.info(`[Cleanup] Next scheduled run at ${nextRunTime.toLocaleString()} (in ${daysUntilNextRun} days)`);
}

/**
 * Schedule the next cleanup run
 * Uses chunked timeouts to avoid JavaScript's 32-bit signed integer overflow
 * (setTimeout max is ~24.8 days / 2,147,483,647 ms)
 */
function scheduleNextRun() {
  const msUntilNextRun = getMillisecondsUntilScheduledTime();
  logNextRunTime(msUntilNextRun);

  if (exceedsMaxTimeout(msUntilNextRun)) {
    scheduleIntermediateCheck();
  } else {
    scheduleDirectRun(msUntilNextRun);
  }
}

/**
 * Start the cleanup service
 * Schedules monthly cleanup runs
 * @returns {Promise<void>}
 */
async function start() {
  logger.info('[Cleanup] Starting cleanup service...');
  logger.info(`[Cleanup] Scheduled: ${CLEANUP_SCHEDULE_DAY}${getOrdinalSuffix(CLEANUP_SCHEDULE_DAY)} of each month at ${CLEANUP_SCHEDULE_HOUR}:${CLEANUP_SCHEDULE_MINUTE.toString().padStart(2, '0')}`);
  logger.info(`[Cleanup] Files older than ${MONTHS_TO_KEEP} months will be deleted`);

  // Schedule the monthly run
  scheduleNextRun();

  logger.info('[Cleanup] Cleanup service started successfully');
}

/**
 * Get ordinal suffix for a number (1st, 2nd, 3rd, etc.)
 * @param {number} n - Number
 * @returns {string} Ordinal suffix
 */
function getOrdinalSuffix(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

/**
 * Stop the cleanup service
 */
function stop() {
  if (scheduledTimeoutId) {
    clearTimeout(scheduledTimeoutId);
    scheduledTimeoutId = null;
    logger.info('[Cleanup] Cleanup service stopped');
  }
}

/**
 * Check if cleanup is currently running
 * @returns {boolean}
 */
function isCleanupRunning() {
  return isRunning;
}

module.exports = {
  start,
  stop,
  runCleanup, // Exported for manual triggering
  isCleanupRunning,
  getCutoffDate, // Exported for testing
  getScreenshotsForCleanup // Exported for testing
};
