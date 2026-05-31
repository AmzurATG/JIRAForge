/**
 * Desktop Dual Authentication Middleware
 *
 * Authenticates desktop-app requests that only need to prove *who is calling*,
 * not read Jira-specific identity. Accepts EITHER:
 *   1. A Supabase JWT minted by this server (non-Jira Google users) — verified
 *      locally via HS256 with SUPABASE_JWT_SECRET (no network call). This is our
 *      own token, so it is the strongest, cheapest proof of identity.
 *   2. An Atlassian OAuth access token (Jira users) — verified against
 *      https://api.atlassian.com/me, identical to atlassian-auth.js.
 *
 * Why: endpoints like /api/classify-app must work for BOTH login types. Google
 * users have no Atlassian token, so an Atlassian-only guard rejects them (401).
 * The downstream controller does not depend on req.atlassianUser, so accepting
 * either credential changes no behavior for existing Jira users.
 */

'use strict';

const axios = require('axios');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');

const ATLASSIAN_ME_URL = 'https://api.atlassian.com/me';

module.exports = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ success: false, error: 'Authorization header missing' });
    }

    const [type, token] = authHeader.split(' ');
    if (type !== 'Bearer' || !token) {
      return res.status(401).json({
        success: false,
        error: 'Invalid authorization format. Use: Bearer <token>'
      });
    }

    // 1) Try our own Supabase JWT first — local HS256 verify, no network round-trip.
    const supabaseJwtSecret = process.env.SUPABASE_JWT_SECRET;
    if (supabaseJwtSecret) {
      try {
        const decoded = jwt.verify(token, supabaseJwtSecret, { algorithms: ['HS256'] });
        req.supabaseUser = decoded;
        req.authType = 'supabase';
        logger.debug('[DesktopAuth] Authenticated via Supabase JWT', { sub: decoded.sub });
        return next();
      } catch {
        // Not a (valid) Supabase JWT — fall through to Atlassian validation.
      }
    }

    // 2) Fall back to Atlassian token validation (network call to /me).
    try {
      const meResponse = await axios.get(ATLASSIAN_ME_URL, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
        timeout: 10000,
        maxContentLength: 1 * 1024 * 1024, // 1MB max response
        maxBodyLength: 1 * 1024 * 1024,
        maxRedirects: 5
      });
      req.atlassianUser = meResponse.data;
      req.authType = 'atlassian';
      logger.debug('[DesktopAuth] Authenticated via Atlassian token:', meResponse.data.account_id);
      return next();
    } catch (error) {
      logger.warn('[DesktopAuth] No valid Supabase or Atlassian token:', error.response?.status || error.message);
      return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }
  } catch (error) {
    logger.error('[DesktopAuth] Middleware error:', error);
    return res.status(500).json({ success: false, error: 'Authentication failed' });
  }
};
