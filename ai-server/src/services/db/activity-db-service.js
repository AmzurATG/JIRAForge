/**
 * Activity DB Service
 * Database operations for the activity_records table (new event-based pipeline).
 * Uses the shared Supabase client from supabase-client.js.
 */

const { getClient, isNetworkError } = require('./supabase-client');
const logger = require('../../utils/logger');

/**
 * Get pending activity batches for processing
 * @param {number} batchSize - Maximum records to fetch
 * @returns {Promise<Array>} Array of pending activity records
 */
async function getPendingActivityBatches(batchSize = 10) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data } = await supabase
    .from('activity_records')
    .select('*')
    .eq('status', 'pending')
    .lt('retry_count', 3)
    .order('created_at', { ascending: true })
    .limit(batchSize);
  return data || [];
}

/**
 * Atomically claim a batch of records for processing.
 * Only claims records still in 'pending' status (prevents race conditions).
 * @param {Array<string>} recordIds - UUIDs of records to claim
 * @returns {Promise<Array>} Records that were successfully claimed
 */
async function claimBatchForProcessing(recordIds) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase
    .from('activity_records')
    .update({
      status: 'processing',
      updated_at: new Date().toISOString()
    })
    .in('id', recordIds)
    .eq('status', 'pending')
    .select();

  if (error) throw error;
  return data || [];
}

/**
 * Update a single activity record with analysis results
 * @param {string} recordId - UUID of the record
 * @param {Object} analysisResult - Analysis result from AI
 */
async function updateActivityRecordAnalysis(recordId, analysisResult) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  // Only assign issue key when the AI's confidence meets the minimum threshold.
  // The prompt defines 0.4–0.5 as "Reasonable match" and records go through
  // approval_status: 'pending_approval' before syncing to Jira, so false
  // positives are caught by the human-in-the-loop gate.
  const MIN_CONFIDENCE_THRESHOLD = parseFloat(process.env.AI_MATCH_MIN_CONFIDENCE || '0.4');
  const confidenceScore = analysisResult.metadata?.confidenceScore ?? 0;
  const taskKeyMeetsThreshold = analysisResult.taskKey && confidenceScore >= MIN_CONFIDENCE_THRESHOLD;

  // Derive project_key from the validated taskKey (set by validateAnalysisKeys).
  // If taskKey didn't meet confidence threshold, project_key is also cleared to null
  // so the record shows as "unassigned" rather than under a potentially wrong project.
  const effectiveTaskKey = taskKeyMeetsThreshold ? analysisResult.taskKey : null;
  let projectKey = null;
  if (effectiveTaskKey) {
    const match = effectiveTaskKey.match(/^([A-Z][A-Z0-9]+)-\d+$/);
    projectKey = match ? match[1] : null;
  }

  const updateData = {
    status: 'analyzed',
    user_assigned_issue_key: effectiveTaskKey,
    project_key: projectKey,
    metadata: analysisResult.metadata || {},
    analyzed_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    // Human-in-the-loop approval gate: if the AI assigned an issue, the
    // record must be approved by the owning user before it syncs to Jira.
    // If no issue was assigned (low confidence), leave NULL — the record
    // falls into the existing Unassigned Work panel (already a review surface).
    approval_status: effectiveTaskKey ? 'pending_approval' : null
  };

  const { data, error } = await supabase
    .from('activity_records')
    .update(updateData)
    .eq('id', recordId)
    .select();

  if (error) throw error;
  return data?.[0] || null;
}

/**
 * Mark an entire batch as analyzed
 * @param {Array<string>} recordIds - UUIDs of records
 */
async function markBatchAnalyzed(recordIds) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase
    .from('activity_records')
    .update({
      status: 'analyzed',
      analyzed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    })
    .in('id', recordIds)
    .select();

  if (error) throw error;
  return data || [];
}

// Patterns that identify transient/upstream failures.
// Retrying after the provider recovers will succeed, so we don't burn retry
// budget on these. Anything not matching falls through to the permanent path.
const TRANSIENT_ERROR_PATTERNS = [
  'enotfound',
  'econnrefused',
  'etimedout',
  'econnreset',
  'timeout',
  'timed out',
  'fetch failed',
  'socket hang up',
  'all ai providers failed',
  'service unavailable',
  '429',
  '500',
  '502',
  '503',
  '504',
  '408'
];

function isTransientError(errorMessage) {
  if (!errorMessage) return false;
  const lower = String(errorMessage).toLowerCase();
  return TRANSIENT_ERROR_PATTERNS.some(p => lower.includes(p));
}

/**
 * Mark records as failed after an analysis attempt.
 * - Transient/upstream errors (Portkey down, network, "All AI providers failed"):
 *   keep status='pending' and do NOT increment retry_count. The next polling
 *   cycle will retry once the provider recovers.
 * - Permanent errors: increment retry_count and flip to 'failed' once it caps.
 * @param {Array<string>} recordIds - UUIDs of records
 * @param {string} errorMessage - Error description
 */
async function markBatchFailed(recordIds, errorMessage) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const transient = isTransientError(errorMessage);

  try {
    // Fetch all records in one query instead of N individual queries
    const { data: records } = await supabase
      .from('activity_records')
      .select('id, retry_count, metadata')
      .in('id', recordIds);

    if (!records || records.length === 0) return;

    // Update all records in parallel
    await Promise.all(records.map(record => {
      const currentCount = record.retry_count || 0;
      const retryCount = transient ? currentCount : currentCount + 1;
      const newStatus = !transient && retryCount >= 3 ? 'failed' : 'pending';
      const newMetadata = record.metadata
        ? { ...record.metadata, error: errorMessage, transient }
        : { error: errorMessage, transient };

      return supabase
        .from('activity_records')
        .update({
          status: newStatus,
          retry_count: retryCount,
          metadata: newMetadata,
          updated_at: new Date().toISOString()
        })
        .eq('id', record.id);
    }));

    if (transient) {
      logger.warn(`[ActivityDB] Transient error on ${records.length} record(s), keeping pending without burning retry budget: ${errorMessage}`);
    }
  } catch (err) {
    logger.error('[ActivityDB] Failed to mark batch as failed:', err);
  }
}

/**
 * Reset records stuck in 'processing' status for too long.
 * Recovers records that were claimed but never completed (e.g., server crash).
 * @param {number} minutesThreshold - Minutes before considering a record stuck
 */
async function resetStuckProcessingRecords(minutesThreshold = 10) {
  const supabase = getClient();
  if (!supabase) return;

  try {
    const threshold = new Date(Date.now() - minutesThreshold * 60 * 1000).toISOString();

    const { data, error } = await supabase
      .from('activity_records')
      .update({
        status: 'pending',
        updated_at: new Date().toISOString()
      })
      .eq('status', 'processing')
      .lt('updated_at', threshold)
      .select();

    if (data && data.length > 0) {
      logger.info(`[ActivityDB] Reset ${data.length} stuck processing records`);
    }
  } catch (error) {
    if (!isNetworkError(error)) {
      logger.error('[ActivityDB] Error resetting stuck records:', error);
    }
  }
}

/**
 * Reset records permanently marked 'failed' if they've been stuck long enough.
 * Acts as a dead-letter re-drive: if a record was marked failed during an
 * outage and we missed classifying it as transient, this safety net brings it
 * back into the processing pool once the provider has had time to recover.
 * @param {number} minutesThreshold - Minutes a record must have been failed before reset
 */
async function resetStuckFailedRecords(minutesThreshold = 30) {
  const supabase = getClient();
  if (!supabase) return;

  try {
    const threshold = new Date(Date.now() - minutesThreshold * 60 * 1000).toISOString();

    const { data } = await supabase
      .from('activity_records')
      .update({
        status: 'pending',
        retry_count: 0,
        updated_at: new Date().toISOString()
      })
      .eq('status', 'failed')
      .lt('updated_at', threshold)
      .select();

    if (data && data.length > 0) {
      logger.info(`[ActivityDB] Re-queued ${data.length} stuck failed records for retry`);
    }
  } catch (error) {
    if (!isNetworkError(error)) {
      logger.error('[ActivityDB] Error resetting stuck failed records:', error);
    }
  }
}

module.exports = {
  getPendingActivityBatches,
  claimBatchForProcessing,
  updateActivityRecordAnalysis,
  markBatchAnalyzed,
  markBatchFailed,
  resetStuckProcessingRecords,
  resetStuckFailedRecords,
  isTransientError
};
