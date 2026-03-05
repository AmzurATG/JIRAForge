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

  const updateData = {
    status: 'analyzed',
    user_assigned_issue_key: analysisResult.taskKey || null,
    metadata: analysisResult.metadata || {},
    analyzed_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  // Preserve existing row project_key unless AI explicitly resolves one.
  if (analysisResult.projectKey) {
    updateData.project_key = analysisResult.projectKey;
  }

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

/**
 * Mark records as failed, incrementing retry_count.
 * Records with retry_count >= 3 are permanently marked 'failed'.
 * @param {Array<string>} recordIds - UUIDs of records
 * @param {string} errorMessage - Error description
 */
async function markBatchFailed(recordIds, errorMessage) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  for (const id of recordIds) {
    try {
      const { data: record } = await supabase
        .from('activity_records')
        .select('retry_count, metadata')
        .eq('id', id)
        .single();

      const retryCount = (record?.retry_count || 0) + 1;
      const newStatus = retryCount >= 3 ? 'failed' : 'pending';

      await supabase
        .from('activity_records')
        .update({
          status: newStatus,
          retry_count: retryCount,
          metadata: record?.metadata ? { ...record.metadata, error: errorMessage } : { error: errorMessage },
          updated_at: new Date().toISOString()
        })
        .eq('id', id);
    } catch (err) {
      logger.error(`[ActivityDB] Failed to mark record ${id} as failed:`, err);
    }
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

module.exports = {
  getPendingActivityBatches,
  claimBatchForProcessing,
  updateActivityRecordAnalysis,
  markBatchAnalyzed,
  markBatchFailed,
  resetStuckProcessingRecords
};
