/**
 * Feedback Session Store
 * In-memory store for feedback form sessions with 30-minute TTL.
 * Sessions are created when the desktop app requests a feedback form
 * and invalidated after the feedback is submitted.
 */

const crypto = require('node:crypto');
const logger = require('../utils/logger');

// In-memory session store
const sessions = new Map();

// Session TTL: 30 minutes
const SESSION_TTL_MS = 30 * 60 * 1000;

// Cleanup interval: every 5 minutes
const CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

/**
 * Create a new feedback session
 * @param {Object} data - Session data
 * @param {string} data.atlassianToken - User's Atlassian access token
 * @param {string} data.cloudId - Jira cloud ID
 * @param {Object} data.userInfo - Atlassian user info (account_id, email, name)
 * @returns {string} Session ID
 */
function createSession({ atlassianToken, cloudId, userInfo }) {
  const sessionId = crypto.randomBytes(16).toString('hex');

  sessions.set(sessionId, {
    atlassianToken,
    cloudId,
    userInfo,
    expiresAt: Date.now() + SESSION_TTL_MS,
    used: false
  });

  logger.info('[FeedbackSession] Created session %s for user %s (expires in 30 min)',
    sessionId.substring(0, 8), userInfo?.account_id || 'unknown');

  return sessionId;
}

/**
 * Get a session by ID (does not invalidate)
 * @param {string} sessionId - Session ID
 * @returns {Object|null} Session data or null if expired/not found
 */
function getSession(sessionId) {
  const session = sessions.get(sessionId);

  if (!session) {
    return null;
  }

  if (Date.now() > session.expiresAt) {
    sessions.delete(sessionId);
    logger.info('[FeedbackSession] Session %s expired', sessionId.substring(0, 8));
    return null;
  }

  return session;
}

/**
 * Get and invalidate a session (for one-time use on submit)
 * @param {string} sessionId - Session ID
 * @returns {Object|null} Session data or null if expired/not found/already used
 */
function consumeSession(sessionId) {
  const session = getSession(sessionId);

  if (!session) {
    return null;
  }

  if (session.used) {
    logger.warn('[FeedbackSession] Session %s already used', sessionId.substring(0, 8));
    return null;
  }

  // Mark as used but don't delete yet (needed for status polling)
  session.used = true;
  return session;
}

/**
 * Delete a session
 * @param {string} sessionId - Session ID
 */
function deleteSession(sessionId) {
  sessions.delete(sessionId);
}

/**
 * Clean up expired sessions
 */
function cleanupExpiredSessions() {
  const now = Date.now();
  let cleaned = 0;

  for (const [id, session] of sessions) {
    if (now > session.expiresAt) {
      sessions.delete(id);
      cleaned++;
    }
  }

  if (cleaned > 0) {
    logger.info('[FeedbackSession] Cleaned up %d expired sessions (%d active)',
      cleaned, sessions.size);
  }
}

// Start periodic cleanup
const cleanupTimer = setInterval(cleanupExpiredSessions, CLEANUP_INTERVAL_MS);

// Prevent cleanup timer from keeping the process alive
if (cleanupTimer.unref) {
  cleanupTimer.unref();
}

module.exports = {
  createSession,
  getSession,
  consumeSession,
  deleteSession
};
