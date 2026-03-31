/**
 * Dashboard Authentication Middleware
 * Verifies Atlassian OAuth token, resolves the user's cloud site,
 * checks Jira admin permissions, and attaches organization context.
 *
 * After this middleware runs, req will have:
 *   req.atlassianUser  - { account_id, email, name, ... }
 *   req.atlassianToken - the raw bearer token
 *   req.cloudId        - Jira cloud site ID
 *   req.organizationId - internal organization UUID
 */

const axios = require('axios');
const logger = require('../utils/logger');
const { getClient } = require('../services/db/supabase-client');

const ATLASSIAN_ME_URL = 'https://api.atlassian.com/me';
const ATLASSIAN_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';

/**
 * Express middleware: Atlassian OAuth + admin check + org resolution
 */
const dashboardAuth = async (req, res, next) => {
  try {
    // 1. Extract Bearer token
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res.status(401).json({ success: false, error: 'Authorization header missing' });
    }

    const [type, token] = authHeader.split(' ');
    if (type !== 'Bearer' || !token) {
      return res.status(401).json({ success: false, error: 'Invalid authorization format. Use: Bearer <atlassian_token>' });
    }

    // 2. Verify token by calling Atlassian /me
    let userInfo;
    try {
      const meResponse = await axios.get(ATLASSIAN_ME_URL, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
        timeout: 10000
      });
      userInfo = meResponse.data;
    } catch (err) {
      logger.warn('[DashboardAuth] Invalid Atlassian token:', err.response?.status || err.message);
      return res.status(401).json({ success: false, error: 'Invalid or expired Atlassian token' });
    }

    // 3. Fetch accessible Jira cloud sites
    let cloudId;
    try {
      const resourcesResponse = await axios.get(ATLASSIAN_RESOURCES_URL, {
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
        timeout: 10000
      });

      const resources = resourcesResponse.data;
      if (!resources || resources.length === 0) {
        return res.status(403).json({ success: false, error: 'No accessible Jira sites found for this account' });
      }

      // Use cloudId from query param if provided, otherwise first resource
      const requestedCloudId = req.query.cloudId || req.body.cloudId;
      if (requestedCloudId) {
        const match = resources.find(r => r.id === requestedCloudId);
        if (!match) {
          return res.status(403).json({ success: false, error: 'You do not have access to the requested Jira site' });
        }
        cloudId = requestedCloudId;
      } else {
        cloudId = resources[0].id;
      }
    } catch (err) {
      logger.error('[DashboardAuth] Failed to fetch accessible resources:', err.message);
      return res.status(500).json({ success: false, error: 'Failed to verify Jira site access' });
    }

    // 4. Check Jira admin permissions via REST API
    try {
      const permResponse = await axios.get(
        `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/mypermissions?permissions=ADMINISTER`,
        {
          headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json' },
          timeout: 10000
        }
      );

      const adminPerm = permResponse.data?.permissions?.ADMINISTER;
      if (!adminPerm?.havePermission) {
        return res.status(403).json({ success: false, error: 'Access denied: Jira Administrator required' });
      }
    } catch (err) {
      logger.error('[DashboardAuth] Failed to check Jira permissions:', err.message);
      return res.status(500).json({ success: false, error: 'Failed to verify admin permissions' });
    }

    // 5. Resolve organization from cloudId
    const supabase = getClient();
    if (!supabase) {
      return res.status(500).json({ success: false, error: 'Database not configured' });
    }

    const { data: orgs, error: orgError } = await supabase
      .from('organizations')
      .select('id')
      .eq('jira_cloud_id', cloudId);

    if (orgError) throw orgError;

    if (!orgs || orgs.length === 0) {
      return res.status(404).json({ success: false, error: 'Organization not found. The Forge app must be installed first.' });
    }

    // Attach context to request
    req.atlassianUser = userInfo;
    req.atlassianToken = token;
    req.cloudId = cloudId;
    req.organizationId = orgs[0].id;

    next();
  } catch (err) {
    logger.error('[DashboardAuth] Unexpected error:', err.message);
    return res.status(500).json({ success: false, error: 'Authentication failed' });
  }
};

module.exports = dashboardAuth;
