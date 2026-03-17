/**
 * Feedback Database Service Module
 * Handles feedback-related database operations
 */

const { getClient } = require('./supabase-client');
const logger = require('../../utils/logger');

/**
 * Create a new feedback record
 * @param {Object} data - Feedback data
 * @param {string} data.atlassian_account_id - Atlassian account ID
 * @param {string} data.user_email - User email
 * @param {string} data.user_display_name - User display name
 * @param {string} data.jira_cloud_id - Jira cloud ID
 * @param {string} data.category - Feedback category
 * @param {string} data.title - Feedback title (optional)
 * @param {string} data.priority - User-selected priority (optional)
 * @param {string} data.description - Feedback description
 * @param {string[]} data.image_paths - Array of storage paths for uploaded images
 * @param {number} data.image_count - Number of images
 * @param {string} data.app_version - Desktop app version (optional)
 * @returns {Promise<Object>} Created feedback record
 */
async function createFeedback(data) {
  try {
    const supabase = getClient();
    const { data: feedback, error } = await supabase
      .from('feedback')
      .insert({
        atlassian_account_id: data.atlassian_account_id,
        user_email: data.user_email,
        user_display_name: data.user_display_name,
        jira_cloud_id: data.jira_cloud_id,
        category: data.category,
        title: data.title || null,
        user_priority: data.priority || null,
        description: data.description,
        image_paths: data.image_paths || [],
        image_count: data.image_count || 0,
        app_version: data.app_version || null,
        jira_creation_status: 'pending'
      })
      .select()
      .single();

    if (error) {
      throw error;
    }

    logger.info('[FeedbackDB] Created feedback %s (category: %s)', feedback.id, data.category);
    return feedback;
  } catch (error) {
    logger.error('[FeedbackDB] Error creating feedback:', error);
    throw new Error(`Failed to create feedback: ${error.message}`);
  }
}

/**
 * Get feedback by ID
 * @param {string} feedbackId - Feedback ID
 * @returns {Promise<Object|null>} Feedback record or null
 */
async function getFeedbackById(feedbackId) {
  try {
    const supabase = getClient();
    const { data, error } = await supabase
      .from('feedback')
      .select('*')
      .eq('id', feedbackId)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return null;
      }
      throw error;
    }

    return data;
  } catch (error) {
    logger.error('[FeedbackDB] Error fetching feedback by ID:', error);
    throw new Error(`Failed to fetch feedback: ${error.message}`);
  }
}

/**
 * Update feedback Jira creation status
 * @param {string} feedbackId - Feedback ID
 * @param {string} status - New status ('pending', 'processing', 'created', 'failed')
 * @param {Object} jiraData - Jira ticket data (optional)
 * @param {string} jiraData.jira_issue_key - Jira issue key (e.g., 'FEEDBACK-123')
 * @param {string} jiraData.jira_issue_url - Jira issue URL
 * @param {string} jiraData.error - Error message if failed
 * @returns {Promise<void>}
 */
async function updateFeedbackStatus(feedbackId, status, jiraData = {}) {
  try {
    const supabase = getClient();
    const updateData = {
      jira_creation_status: status
    };

    if (jiraData.jira_issue_key) {
      updateData.jira_issue_key = jiraData.jira_issue_key;
    }
    if (jiraData.jira_issue_url) {
      updateData.jira_issue_url = jiraData.jira_issue_url;
    }
    if (jiraData.error) {
      updateData.jira_creation_error = jiraData.error;
    }

    const { error } = await supabase
      .from('feedback')
      .update(updateData)
      .eq('id', feedbackId);

    if (error) {
      throw error;
    }

    logger.info('[FeedbackDB] Updated feedback %s status to %s', feedbackId, status);
  } catch (error) {
    logger.error('[FeedbackDB] Error updating feedback status:', error);
    throw new Error(`Failed to update feedback status: ${error.message}`);
  }
}

/**
 * Update feedback with AI analysis results
 * @param {string} feedbackId - Feedback ID
 * @param {Object} aiResults - AI analysis results
 * @param {string} aiResults.ai_summary - AI-generated summary
 * @param {string} aiResults.ai_priority - AI-suggested priority
 * @param {string[]} aiResults.ai_labels - AI-suggested labels
 * @param {string} aiResults.ai_issue_type - AI-suggested issue type
 * @returns {Promise<void>}
 */
async function updateFeedbackAIResults(feedbackId, aiResults) {
  try {
    const supabase = getClient();
    const { error } = await supabase
      .from('feedback')
      .update({
        ai_summary: aiResults.ai_summary || null,
        ai_priority: aiResults.ai_priority || null,
        ai_labels: aiResults.ai_labels || [],
        ai_issue_type: aiResults.ai_issue_type || 'Task',
        title: aiResults.title || undefined // AI-generated title if user didn't provide one
      })
      .eq('id', feedbackId);

    if (error) {
      throw error;
    }

    logger.info('[FeedbackDB] Updated AI results for feedback %s', feedbackId);
  } catch (error) {
    logger.error('[FeedbackDB] Error updating AI results:', error);
    throw new Error(`Failed to update AI results: ${error.message}`);
  }
}

module.exports = {
  createFeedback,
  getFeedbackById,
  updateFeedbackStatus,
  updateFeedbackAIResults
};
