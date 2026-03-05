/**
 * Atlassian Token Authentication Middleware
 * Verifies requests from desktop app using Atlassian OAuth tokens
 * 
 * Used for desktop-app-to-server endpoints that should be authenticated
 * via the user's Atlassian token (not API key).
 */

const axios = require('axios');
const logger = require('../utils/logger');

const ATLASSIAN_ME_URL = 'https://api.atlassian.com/me';

/**
 * Express middleware for Atlassian token authentication
 * Verifies the Bearer token is a valid Atlassian access token
 */
const atlassianAuth = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        error: 'Authorization header missing'
      });
    }

    const [type, token] = authHeader.split(' ');

    if (type !== 'Bearer' || !token) {
      return res.status(401).json({
        success: false,
        error: 'Invalid authorization format. Use: Bearer <atlassian_token>'
      });
    }

    // Verify the Atlassian token by calling the /me endpoint
    try {
      const meResponse = await axios.get(ATLASSIAN_ME_URL, {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json'
        },
        timeout: 10000
      });

      // Attach user info to request for downstream use
      req.atlassianUser = meResponse.data;
      logger.debug('[AtlassianAuth] Token verified for user:', meResponse.data.account_id);

      next();
    } catch (error) {
      logger.warn('[AtlassianAuth] Invalid Atlassian token:', error.response?.status || error.message);
      return res.status(401).json({
        success: false,
        error: 'Invalid or expired Atlassian token'
      });
    }

  } catch (error) {
    logger.error('[AtlassianAuth] Middleware error:', error);
    res.status(500).json({
      success: false,
      error: 'Authentication failed'
    });
  }
};

module.exports = atlassianAuth;
