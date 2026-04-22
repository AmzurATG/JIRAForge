/**
 * AI Accuracy Dashboard Authentication Middleware — REMOVABLE LAYER
 *
 * Verifies an Atlassian Bearer token and gates access on email membership in
 * the public.accuracy_dashboard_users table.  Intentionally does NOT check
 * Jira admin permissions — the email allowlist is the SOLE permission gate
 * (an admin who isn't on the allowlist gets 403; a non-admin who IS on the
 * allowlist gets 200).
 *
 * After this middleware runs, req has:
 *   req.atlassianUser  - { account_id, email, name, ... }
 *   req.atlassianToken - the raw bearer token
 *
 * Removal: delete this file, the dashboard controller, the HTML page, and the
 * route mounts in src/index.js. No production middleware is affected.
 */

const axios = require('axios');
const logger = require('../utils/logger');
const { getClient } = require('../services/db/supabase-client');

const ATLASSIAN_ME_URL = 'https://api.atlassian.com/me';

// Env-based allowlist (comma-separated emails). Parsed once at module load —
// changing the env requires a server restart, same as every other env var
// in this project. Useful for bootstrap or when the DB allowlist is empty.
function parseEnvAllowlist() {
  const raw = process.env.ACCURACY_DASHBOARD_ALLOWED_EMAILS || '';
  return new Set(
    raw.split(',')
       .map(e => e.trim().toLowerCase())
       .filter(Boolean)
  );
}
const ENV_ALLOWLIST = parseEnvAllowlist();

const accuracyDashboardAuth = async (req, res, next) => {
  try {
    // 1. Extract Bearer token
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ success: false, error: 'Authorization header missing' });
    }

    const [type, token] = authHeader.split(' ');
    if (type !== 'Bearer' || !token) {
      return res.status(401).json({
        success: false,
        error: 'Invalid authorization format. Use: Bearer <atlassian_token>'
      });
    }

    // 2. Verify token by calling Atlassian /me
    let userInfo;
    try {
      const meResponse = await axios.get(ATLASSIAN_ME_URL, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
        timeout: 10000,
        maxContentLength: 1 * 1024 * 1024,
        maxBodyLength: 1 * 1024 * 1024,
        maxRedirects: 5
      });
      userInfo = meResponse.data;
    } catch (err) {
      logger.warn('[AccuracyDashboardAuth] Invalid Atlassian token:',
        err.response?.status || err.message);
      return res.status(401).json({ success: false, error: 'Invalid or expired Atlassian token' });
    }

    const userEmail = (userInfo?.email || '').toLowerCase().trim();
    if (!userEmail) {
      logger.warn('[AccuracyDashboardAuth] Atlassian /me returned no email');
      return res.status(403).json({
        success: false,
        error: 'Cannot determine your email from Atlassian — access denied.'
      });
    }

    // 3. Allowlist lookup — env list is checked first (cheap, in-memory),
    // DB table second.  Either match grants access.
    let allowed = ENV_ALLOWLIST.has(userEmail);

    if (!allowed) {
      const supabase = getClient();
      if (!supabase) {
        return res.status(500).json({ success: false, error: 'Database not configured' });
      }

      const { data: dbAllowed, error: lookupError } = await supabase
        .from('accuracy_dashboard_users')
        .select('email')
        .ilike('email', userEmail)
        .maybeSingle();

      if (lookupError) {
        logger.error('[AccuracyDashboardAuth] Allowlist lookup failed:', lookupError.message);
        return res.status(500).json({ success: false, error: 'Authorization check failed' });
      }
      allowed = !!dbAllowed;
    }

    if (!allowed) {
      logger.warn('[AccuracyDashboardAuth] Access denied (not on allowlist):', userEmail);
      return res.status(403).json({
        success: false,
        error: 'Access denied. Your email is not on the accuracy dashboard allowlist.'
      });
    }

    // Attach context for downstream handlers
    req.atlassianUser = userInfo;
    req.atlassianToken = token;
    req.userEmail = userEmail;

    next();
  } catch (err) {
    logger.error('[AccuracyDashboardAuth] Unexpected error:', err.message);
    return res.status(500).json({ success: false, error: 'Authentication failed' });
  }
};

module.exports = accuracyDashboardAuth;
