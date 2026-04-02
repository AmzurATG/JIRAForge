/**
 * Admin Dashboard Controller
 * Simple read-only dashboard showing user/org stats from Supabase
 * Password-protected — admins set their own password via ADMIN_DASHBOARD_PASSWORD env var
 */

const crypto = require('crypto');
const { getClient } = require('../services/db/supabase-client');
const logger = require('../utils/logger');

// In-memory session store (token -> expiry timestamp)
const sessions = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

// Cleanup expired sessions every 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of sessions) {
    if (now > expiry) sessions.delete(token);
  }
}, 30 * 60 * 1000);

/**
 * POST /admin-dashboard/api/login
 * Validates password and returns a session token
 */
exports.login = (req, res) => {
  const { password } = req.body || {};
  const correctPassword = process.env.ADMIN_DASHBOARD_PASSWORD;

  if (!correctPassword) {
    return res.status(503).json({
      success: false,
      error: 'ADMIN_DASHBOARD_PASSWORD is not set in the server .env file. Ask the server admin to set it.'
    });
  }

  if (!password || password !== correctPassword) {
    logger.warn('[AdminDashboard] Failed login attempt from', req.ip);
    return res.status(401).json({ success: false, error: 'Invalid password' });
  }

  // Generate a secure session token
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);

  logger.info('[AdminDashboard] Admin logged in from', req.ip);
  res.json({ success: true, token });
};

/**
 * Middleware: validate dashboard session token
 */
exports.requireSession = (req, res, next) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, error: 'Not authenticated' });
  }

  const token = authHeader.slice(7);
  const expiry = sessions.get(token);
  if (!expiry || Date.now() > expiry) {
    sessions.delete(token);
    return res.status(401).json({ success: false, error: 'Session expired' });
  }

  next();
};

/**
 * GET /admin-dashboard/api/stats
 * Returns all dashboard data in a single call
 */
exports.getStats = async (req, res) => {
  try {
    const supabase = getClient();
    if (!supabase) {
      return res.status(503).json({ success: false, error: 'Database not connected' });
    }

    // 1. Get all organizations
    const { data: orgs, error: orgsErr } = await supabase
      .from('organizations')
      .select('id, org_name, jira_cloud_id, subscription_status, subscription_tier, is_active, created_at')
      .order('org_name');
    if (orgsErr) throw orgsErr;

    // 2. Get all users with their org info
    const { data: users, error: usersErr } = await supabase
      .from('users')
      .select('id, email, display_name, organization_id, is_active, desktop_logged_in, desktop_last_heartbeat, desktop_app_version, created_at')
      .order('display_name');
    if (usersErr) throw usersErr;

    // 3. Build per-org stats
    const orgStats = (orgs || []).map(org => {
      const orgUsers = (users || []).filter(u => u.organization_id === org.id);
      const installedUsers = orgUsers.filter(u => u.desktop_logged_in === true || u.desktop_last_heartbeat);
      const activeNow = orgUsers.filter(u => {
        if (!u.desktop_last_heartbeat) return false;
        const diff = Date.now() - new Date(u.desktop_last_heartbeat).getTime();
        return diff < 10 * 60 * 1000; // active in last 10 minutes
      });

      return {
        id: org.id,
        name: org.org_name,
        cloudId: org.jira_cloud_id,
        status: org.subscription_status,
        tier: org.subscription_tier,
        isActive: org.is_active,
        createdAt: org.created_at,
        totalUsers: orgUsers.length,
        installedDesktop: installedUsers.length,
        notInstalled: orgUsers.length - installedUsers.length,
        activeNow: activeNow.length,
        users: orgUsers.map(u => ({
          id: u.id,
          email: u.email,
          displayName: u.display_name,
          isActive: u.is_active,
          desktopInstalled: u.desktop_logged_in === true || !!u.desktop_last_heartbeat,
          desktopLoggedIn: u.desktop_logged_in || false,
          lastHeartbeat: u.desktop_last_heartbeat,
          appVersion: u.desktop_app_version,
          createdAt: u.created_at
        }))
      };
    });

    // 4. Summary metrics
    const totalUsers = (users || []).length;
    const totalOrgs = (orgs || []).length;
    const totalInstalled = (users || []).filter(u => u.desktop_logged_in === true || u.desktop_last_heartbeat).length;
    const totalActiveNow = (users || []).filter(u => {
      if (!u.desktop_last_heartbeat) return false;
      return (Date.now() - new Date(u.desktop_last_heartbeat).getTime()) < 10 * 60 * 1000;
    }).length;

    res.json({
      success: true,
      summary: {
        totalOrganizations: totalOrgs,
        totalUsers,
        desktopInstalled: totalInstalled,
        desktopNotInstalled: totalUsers - totalInstalled,
        activeNow: totalActiveNow
      },
      organizations: orgStats
    });
  } catch (error) {
    logger.error('[AdminDashboard] Stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};
