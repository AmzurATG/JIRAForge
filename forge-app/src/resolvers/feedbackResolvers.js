/**
 * Feedback Resolvers
 * Handles feedback-related operations for the Forge app
 */

import { createFeedbackSession, submitFeedback, getFeedbackStatus } from '../utils/remote.js';

/**
 * Register feedback resolvers
 * @param {Resolver} resolver - Forge resolver instance
 */
export function registerFeedbackResolvers(resolver) {
  /**
   * Get a feedback form URL
   * Creates a feedback session and returns a URL that can be opened in a browser
   */
  resolver.define('getFeedbackUrl', async (req) => {
    try {
      const feedbackUrl = await createFeedbackSession();

      return {
        success: true,
        feedbackUrl
      };
    } catch (error) {
      console.error('Error creating feedback session:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });

  /**
   * Submit feedback from the in-app modal
   * Validates inputs and submits via remote
   */
  resolver.define('submitFeedback', async (req) => {
    try {
      const { category, title, priority, description, images } = req.payload;

      // Validate required fields
      if (!category) {
        return { success: false, error: 'Category is required' };
      }
      if (!description || !description.trim()) {
        return { success: false, error: 'Description is required' };
      }

      // Validate images
      if (images && images.length > 3) {
        return { success: false, error: 'Maximum 3 screenshots allowed' };
      }

      const result = await submitFeedback({
        category,
        title: title || '',
        priority: priority || '',
        description: description.trim(),
        images: images || []
      });

      return {
        success: true,
        message: 'Feedback submitted successfully',
        feedbackId: result.feedback_id || result.feedbackId
      };
    } catch (error) {
      console.error('Error submitting feedback:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });

  /**
   * Get feedback status (poll for Jira ticket creation)
   * Checks the current status of a feedback submission
   */
  resolver.define('getFeedbackStatus', async (req) => {
    try {
      const { feedbackId } = req.payload;

      if (!feedbackId) {
        return { success: false, error: 'Feedback ID is required' };
      }

      const result = await getFeedbackStatus(feedbackId);

      return {
        success: true,
        status: result.status,
        jira_issue_key: result.jira_issue_key || null,
        jira_issue_url: result.jira_issue_url || null,
        error: result.error || null
      };
    } catch (error) {
      console.error('Error getting feedback status:', error);
      return {
        success: false,
        error: error.message
      };
    }
  });
}
