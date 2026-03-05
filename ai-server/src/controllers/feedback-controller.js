/**
 * Feedback Controller
 * Handles feedback form sessions, serving the form, submissions, and status checks
 *
 * Endpoints:
 * - POST /api/feedback/session - Create feedback session (desktop app sends Atlassian token)
 * - GET /api/feedback/form - Serve feedback form (session-authenticated)
 * - POST /api/feedback/submit - Submit feedback with images
 * - GET /api/feedback/status/:id - Check feedback/Jira creation status
 */

const axios = require('axios');
const path = require('node:path');
const logger = require('../utils/logger');
const sessionStore = require('../services/feedback-session-store');
const { createFeedback, getFeedbackById } = require('../services/db/feedback-db-service');
const { uploadFile } = require('../services/db/storage-service');
const { processAndCreateJiraTicket } = require('../services/feedback-service');

const ATLASSIAN_ME_URL = 'https://api.atlassian.com/me';
const VALID_CATEGORIES = new Set(['bug', 'feature_request', 'improvement', 'question', 'other']);
const ALLOWED_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);
const MAX_IMAGES = 3;
const MAX_IMAGE_SIZE_BYTES = 5 * 1024 * 1024; // 5MB

/**
 * Verify Atlassian token and fetch user info
 * @param {string} token - Atlassian bearer token
 * @returns {Promise<Object>} User info from Atlassian
 */
async function verifyAtlassianToken(token) {
  const userResponse = await axios.get(ATLASSIAN_ME_URL, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/json'
    },
    timeout: 10000
  });
  return userResponse.data;
}

/**
 * Validate feedback submission input
 * @param {Object} data - Submission data
 * @returns {Object|null} Error object if validation fails, null if valid
 */
function validateFeedbackSubmission(data) {
  const { session_id, category, description } = data;

  if (!session_id) {
    return { error: 'Session ID is required' };
  }

  if (!category) {
    return { error: 'Category is required' };
  }

  if (!description?.trim()) {
    return { error: 'Description is required' };
  }

  if (!VALID_CATEGORIES.has(category)) {
    return { error: 'Invalid category' };
  }

  return null;
}

/**
 * Check if image is valid
 * @param {Object} img - Image object with data and type
 * @param {Buffer} buffer - Decoded image buffer
 * @returns {boolean} True if valid
 */
function isValidImage(img, buffer) {
  if (!img.data || !img.type) {
    return false;
  }

  if (buffer.length > MAX_IMAGE_SIZE_BYTES) {
    logger.warn('[Feedback] Image exceeds 5MB limit (%d bytes), skipping', buffer.length);
    return false;
  }

  if (!ALLOWED_IMAGE_TYPES.has(img.type)) {
    logger.warn('[Feedback] Invalid image type %s, skipping', img.type);
    return false;
  }

  return true;
}

/**
 * Get file extension from MIME type
 * @param {string} mimeType - Image MIME type
 * @returns {string} File extension
 */
function getFileExtension(mimeType) {
  const ext = mimeType.split('/')[1];
  return ext === 'jpeg' ? 'jpg' : ext;
}

/**
 * Upload single image to storage
 * @param {Object} img - Image object
 * @param {string} accountId - User account ID
 * @param {number} index - Image index
 * @returns {Promise<string|null>} Storage path or null if failed
 */
async function uploadSingleImage(img, accountId, index) {
  try {
    const buffer = Buffer.from(img.data, 'base64');

    if (!isValidImage(img, buffer)) {
      return null;
    }

    const ext = getFileExtension(img.type);
    const storagePath = `${accountId}/${Date.now()}_${index}.${ext}`;

    await uploadFile('feedback-images', storagePath, buffer, {
      contentType: img.type,
      upsert: false
    });

    return storagePath;
  } catch (uploadError) {
    logger.warn('[Feedback] Failed to upload image %d: %s', index, uploadError.message);
    return null;
  }
}

/**
 * Upload multiple images to storage
 * @param {Array} images - Array of image objects
 * @param {string} accountId - User account ID
 * @returns {Promise<Array<string>>} Array of storage paths
 */
async function uploadImages(images, accountId) {
  if (!images || !Array.isArray(images)) {
    return [];
  }

  const uploadPromises = images
    .slice(0, MAX_IMAGES)
    .map((img, index) => uploadSingleImage(img, accountId, index));

  const results = await Promise.all(uploadPromises);
  return results.filter(path => path !== null);
}

/**
 * Create a feedback session
 * Desktop app calls this with the user's Atlassian token to get a session ID,
 * then opens the browser to the feedback form with that session.
 *
 * POST /api/feedback/session
 * Body: { atlassian_token: string, cloud_id: string }
 */
exports.createSession = async (req, res) => {
  try {
    const { atlassian_token, cloud_id } = req.body;

    // Early return for missing token
    if (!atlassian_token) {
      return res.status(400).json({
        success: false,
        error: 'Atlassian token is required'
      });
    }

    // Early return for missing cloud ID
    if (!cloud_id) {
      return res.status(400).json({
        success: false,
        error: 'Cloud ID is required'
      });
    }

    // Verify the Atlassian token by fetching user info
    let atlassianUser;
    try {
      atlassianUser = await verifyAtlassianToken(atlassian_token);
    } catch (error) {
      logger.warn('[Feedback] Invalid Atlassian token:', error.response?.status);
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired Atlassian token'
      });
    }

    // Create session
    const sessionId = sessionStore.createSession({
      atlassianToken: atlassian_token,
      cloudId: cloud_id,
      userInfo: {
        account_id: atlassianUser.account_id,
        email: atlassianUser.email,
        name: atlassianUser.name || atlassianUser.display_name
      }
    });

    // Build feedback form URL (using /api prefix so nginx forwards to AI server)
    const protocol = req.protocol;
    const host = req.get('host');
    const feedbackUrl = `${protocol}://${host}/api/feedback/form?session=${sessionId}`;

    logger.info('[Feedback] Session created for user %s', atlassianUser.account_id);

    res.json({
      success: true,
      session_id: sessionId,
      feedback_url: feedbackUrl
    });

  } catch (error) {
    logger.error('[Feedback] Session creation error:', error);
    res.status(500).json({
      success: false,
      error: `Failed to create feedback session: ${error.message}`
    });
  }
};

/**
 * Serve the feedback form page
 * Validates the session query parameter before serving the HTML.
 *
 * GET /api/feedback/form?session=<session_id>
 */
exports.getFeedbackPage = (req, res) => {
  const sessionId = req.query.session;

  if (!sessionId) {
    return res.status(400).send(getErrorPage('Missing session parameter. Please use the "Send Feedback" option from the desktop app.'));
  }

  const session = sessionStore.getSession(sessionId);
  if (!session) {
    return res.status(401).send(getErrorPage('Invalid or expired session. Please use the "Send Feedback" option from the desktop app to get a new session.'));
  }

  res.sendFile(path.join(__dirname, '..', 'feedback', 'feedback-form.html'));
};

/**
 * Submit feedback
 * Validates session, uploads images to Supabase, saves feedback to DB,
 * and triggers async AI processing + Jira ticket creation.
 *
 * POST /api/feedback/submit
 * Body: { session_id, category, title?, description, images?: [{ data: base64, name, type }], app_version? }
 */
exports.submitFeedback = async (req, res) => {
  try {
    const { session_id, category, title, description, images, app_version } = req.body;

    // Validate input
    const validationError = validateFeedbackSubmission(req.body);
    if (validationError) {
      return res.status(400).json({ success: false, ...validationError });
    }

    // Consume session (one-time use)
    const session = sessionStore.consumeSession(session_id);
    if (!session) {
      return res.status(401).json({
        success: false,
        error: 'Invalid, expired, or already-used session'
      });
    }

    // Upload images to Supabase storage
    const imagePaths = await uploadImages(images, session.userInfo.account_id);

    // Save feedback to database
    const feedback = await createFeedback({
      atlassian_account_id: session.userInfo.account_id,
      user_email: session.userInfo.email,
      user_display_name: session.userInfo.name,
      jira_cloud_id: session.cloudId,
      category,
      title: title || null,
      description: description.trim(),
      image_paths: imagePaths,
      image_count: imagePaths.length,
      app_version: app_version || null
    });

    // Trigger async AI processing + Jira ticket creation
    // Tickets are created on the configured Jira instance (server-side credentials)
    processAndCreateJiraTicket(feedback.id)
      .catch(err => logger.error('[Feedback] Async processing error:', err));

    logger.info('[Feedback] Feedback %s submitted (category: %s, images: %d)',
      feedback.id, category, imagePaths.length);

    res.json({
      success: true,
      feedback_id: feedback.id,
      message: 'Feedback submitted successfully. A Jira ticket will be created shortly.'
    });

  } catch (error) {
    logger.error('[Feedback] Submit error:', error);
    res.status(500).json({
      success: false,
      error: `Failed to submit feedback: ${error.message}`
    });
  }
};

/**
 * Get feedback status (poll for Jira ticket creation status)
 *
 * GET /api/feedback/status/:id
 */
exports.getFeedbackStatus = async (req, res) => {
  try {
    const { id } = req.params;

    if (!id) {
      return res.status(400).json({ success: false, error: 'Feedback ID is required' });
    }

    const feedback = await getFeedbackById(id);
    if (!feedback) {
      return res.status(404).json({ success: false, error: 'Feedback not found' });
    }

    res.json({
      success: true,
      status: feedback.jira_creation_status,
      jira_issue_key: feedback.jira_issue_key ?? null,
      jira_issue_url: feedback.jira_issue_url ?? null,
      error: feedback.jira_creation_error ?? null
    });

  } catch (error) {
    logger.error('[Feedback] Status check error:', error);
    res.status(500).json({
      success: false,
      error: `Failed to check feedback status: ${error.message}`
    });
  }
};

/**
 * Generate a simple error HTML page
 * @param {string} message - Error message to display
 * @returns {string} HTML error page
 */
function escapeHtml(str) {
  return str
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function getErrorPage(message) {
  const safeMessage = escapeHtml(message);
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Feedback - Error</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
    .error-card { background: white; padding: 40px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); text-align: center; max-width: 500px; }
    .error-card h1 { color: #DE350B; margin-bottom: 16px; }
    .error-card p { color: #666; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="error-card">
    <h1>Session Error</h1>
    <p>${safeMessage}</p>
  </div>
</body>
</html>`;
}
