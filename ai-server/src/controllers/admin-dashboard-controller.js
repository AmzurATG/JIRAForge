/**
 * Admin Dashboard Controller
 * Status Report dashboard for HR/admin users
 * Shows users by team, feedback tickets with live Jira status
 */

const crypto = require('crypto');
const axios = require('axios');
const { getClient } = require('../services/db/supabase-client');
const logger = require('../utils/logger');

// ============================================================================
// Session Management
// ============================================================================
const sessions = new Map();
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

setInterval(() => {
  const now = Date.now();
  for (const [token, expiry] of sessions) {
    if (now > expiry) sessions.delete(token);
  }
}, 30 * 60 * 1000);

// ============================================================================
// Internal Team Mapping (hardcoded — no DB changes needed)
// ============================================================================
const ATG_EMAILS = new Set([
  'iswarya.kolimalla@amzur.com',
  'lavanya.joga@amzur.com',
  'murali.puramaneni@amzur.com',
  'pushpa.nacharla@amzur.com',
  'siva.jamula@amzur.com',
  'vishnu.kanthamraju@amzur.com',
]);

function getTeam(email) {
  if (!email) return '-';
  const e = email.toLowerCase();
  if (ATG_EMAILS.has(e)) return 'ATG';
  if (e.endsWith('@amzur.com')) return 'Custom Software';
  return '-';
}

function getOrg(email) {
  if (!email) return '';
  const e = email.toLowerCase();
  if (e.endsWith('@amzur.com')) return 'Amzur';
  if (e.endsWith('@evokesystems.com')) return 'Evoke';
  return '';
}

/** Ticket team label — e.g. "Amzur - ATG", "Custom Software", "Evoke" */
function getTicketTeamLabel(email) {
  if (!email) return '-';
  const e = email.toLowerCase();
  if (ATG_EMAILS.has(e)) return 'Amzur - ATG';
  if (e.endsWith('@amzur.com')) return 'Custom Software';
  if (e.endsWith('@evokesystems.com')) return 'Evoke';
  return '-';
}

// ============================================================================
// Jira Status Fetch (uses same JIRA_FEEDBACK_* env vars as ticket creation)
// ============================================================================
let jiraCache = { data: {}, fetchedAt: 0 };
const JIRA_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

async function fetchJiraStatuses() {
  const now = Date.now();
  if (now - jiraCache.fetchedAt < JIRA_CACHE_TTL && Object.keys(jiraCache.data).length > 0) {
    return jiraCache.data;
  }

  const email = process.env.JIRA_FEEDBACK_EMAIL;
  const apiToken = process.env.JIRA_FEEDBACK_API_TOKEN;
  const projectKey = process.env.JIRA_FEEDBACK_PROJECT;

  // Try JIRA_FEEDBACK_SITE_URL first, fall back to JIRA_BASE_URL
  const siteUrls = [
    process.env.JIRA_FEEDBACK_SITE_URL,
    process.env.JIRA_BASE_URL
  ].filter(Boolean);

  if (siteUrls.length === 0 || !email || !apiToken || !projectKey) return {};

  const basicAuth = Buffer.from(`${email}:${apiToken}`).toString('base64');
  const headers = { 'Authorization': `Basic ${basicAuth}`, 'Accept': 'application/json' };
  const params = {
    jql: `project = ${projectKey} ORDER BY created DESC`,
    fields: 'status,priority',
    maxResults: 200
  };

  // Try each site URL with both API v3 and v2
  for (const url of siteUrls) {
    const baseUrl = url.replace(/\/$/, '');
    for (const apiVersion of ['3', '2']) {
      try {
        const response = await axios.get(`${baseUrl}/rest/api/${apiVersion}/search`, {
          params, headers, timeout: 10000
        });

        const map = {};
        (response.data.issues || []).forEach(issue => {
          map[issue.key] = {
            status: issue.fields?.status?.name || '-',
            priority: issue.fields?.priority?.name || '-'
          };
        });

        logger.info('[AdminDashboard] Jira fetch OK via %s (api v%s) — %d issues', baseUrl, apiVersion, Object.keys(map).length);
        jiraCache = { data: map, fetchedAt: Date.now() };
        return map;
      } catch (e) {
        logger.warn('[AdminDashboard] Jira fetch failed: %s/rest/api/%s — %s', baseUrl, apiVersion, e.message);
      }
    }
  }

  // All attempts failed
  return {};
}

// ============================================================================
// Auth Endpoints
// ============================================================================

/** POST /admin-dashboard/api/login */
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

  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);

  logger.info('[AdminDashboard] Admin logged in from', req.ip);
  res.json({ success: true, token });
};

/** Middleware: validate session token */
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

// ============================================================================
// Dashboard Data
// ============================================================================

/** GET /admin-dashboard/api/stats */
exports.getStats = async (req, res) => {
  try {
    const supabase = getClient();
    if (!supabase) {
      return res.status(503).json({ success: false, error: 'Database not connected' });
    }

    // Parallel: users, orgs, feedback
    const [orgsResult, usersResult, feedbackResult] = await Promise.all([
      supabase.from('organizations').select('id, org_name').order('org_name'),
      supabase
        .from('users')
        .select('id, email, display_name, organization_id, is_active, desktop_logged_in, desktop_last_heartbeat, desktop_app_version, created_at')
        .order('display_name'),
      supabase
        .from('feedback')
        .select('id, user_email, user_display_name, category, title, ai_summary, jira_issue_key, jira_issue_url, jira_creation_status, ai_priority, user_priority, organization_id, created_at')
        .order('created_at', { ascending: false })
    ]);

    if (orgsResult.error) throw orgsResult.error;
    if (usersResult.error) throw usersResult.error;
    if (feedbackResult.error) throw feedbackResult.error;

    const orgs = orgsResult.data || [];
    const users = usersResult.data || [];
    const feedback = feedbackResult.data || [];

    // Jira statuses (non-blocking)
    let jiraStatuses = {};
    try {
      jiraStatuses = await fetchJiraStatuses();
    } catch (e) {
      logger.warn('[AdminDashboard] Jira status fetch failed:', e.message);
    }

    // Org ID → name
    const orgMap = {};
    orgs.forEach(o => { orgMap[o.id] = o.org_name; });

    // ── Build user list with team info ──
    const allUsers = users.map(u => {
      const emailOrg = getOrg(u.email);
      return {
        displayName: u.display_name || '',
        email: u.email || '',
        organization: emailOrg || orgMap[u.organization_id] || '-',
        team: getTeam(u.email),
        isActive: u.is_active !== false,
        desktopInstalled: u.desktop_logged_in === true || !!u.desktop_last_heartbeat,
        desktopLoggedIn: u.desktop_logged_in || false,
        lastHeartbeat: u.desktop_last_heartbeat,
        appVersion: u.desktop_app_version,
        createdAt: u.created_at
      };
    });

    // ── Summary metrics ──
    const totalUsers = allUsers.length;
    const activeUsers = allUsers.filter(u => u.isActive).length;
    const desktopAppUsers = allUsers.filter(u => u.desktopInstalled).length;
    const notStarted = totalUsers - desktopAppUsers;

    const uniqueTeams = new Set();
    allUsers.forEach(u => uniqueTeams.add(u.team !== '-' ? u.team : u.organization));

    // ── Users per team (for the summary table) ──
    const teamCounts = {};
    allUsers.forEach(u => {
      const label = u.team !== '-' ? u.team : u.organization;
      teamCounts[label] = (teamCounts[label] || 0) + 1;
    });
    const usersPerTeam = Object.entries(teamCounts)
      .map(([team, userCount]) => ({ team, userCount }))
      .sort((a, b) => b.userCount - a.userCount);

    // ── Map feedback tickets ──
    const tickets = feedback.map(f => {
      const jira = f.jira_issue_key ? jiraStatuses[f.jira_issue_key] : null;
      return {
        issueKey: f.jira_issue_key || '-',
        issueUrl: f.jira_issue_url || '',
        summary: f.title || f.ai_summary || f.category || '-',
        submittedBy: f.user_display_name || '-',
        team: getTicketTeamLabel(f.user_email),
        status: jira?.status || f.jira_creation_status || '-',
        priority: f.user_priority || jira?.priority || f.ai_priority || '-',
        category: f.category,
        createdAt: f.created_at
      };
    });

    // ── Tickets per team ──
    // Ensure all teams appear (even with 0 tickets)
    const allTicketTeamLabels = new Set();
    allUsers.forEach(u => {
      const label = getTicketTeamLabel(u.email);
      if (label !== '-') allTicketTeamLabels.add(label);
    });
    const teamTickets = {};
    allTicketTeamLabels.forEach(t => { teamTickets[t] = { count: 0, earliest: null }; });
    tickets.forEach(t => {
      if (t.team !== '-') {
        if (!teamTickets[t.team]) teamTickets[t.team] = { count: 0, earliest: null };
        teamTickets[t.team].count++;
        if (t.createdAt && (!teamTickets[t.team].earliest || new Date(t.createdAt) < new Date(teamTickets[t.team].earliest))) {
          teamTickets[t.team].earliest = t.createdAt;
        }
      }
    });

    const totalTickets = tickets.filter(t => t.issueKey !== '-').length;
    const ticketsPerTeam = Object.entries(teamTickets)
      .map(([team, info]) => ({
        team,
        ticketsRaised: info.count,
        percentOfTotal: totalTickets > 0 ? Math.round((info.count / totalTickets) * 1000) / 10 : 0,
        started: info.earliest || null
      }))
      .sort((a, b) => b.ticketsRaised - a.ticketsRaised);

    // ── Ticket status summary ──
    const statusAgg = {};
    tickets.forEach(t => {
      const s = t.status || '-';
      if (!statusAgg[s]) statusAgg[s] = { count: 0, teams: new Set() };
      statusAgg[s].count++;
      if (t.team !== '-') statusAgg[s].teams.add(t.team);
    });
    const statusOrder = ['To Do', 'In Progress', 'Review', 'Done', 'created', 'pending', 'processing', 'failed'];
    const ticketStatusSummary = Object.entries(statusAgg)
      .map(([status, d]) => ({
        status,
        count: d.count,
        teamBreakdown: Array.from(d.teams).join(', ')
      }))
      .sort((a, b) => {
        const ai = statusOrder.indexOf(a.status);
        const bi = statusOrder.indexOf(b.status);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      });

    // ── Org-specific user lists ──
    const amzurCS = allUsers.filter(u => u.organization === 'Amzur' && u.team === 'Custom Software');
    const amzurATG = allUsers.filter(u => u.organization === 'Amzur' && u.team === 'ATG');
    const evokeUsers = allUsers.filter(u => u.organization === 'Evoke');

    res.json({
      success: true,
      summary: {
        totalUsers,
        activeUsers,
        desktopAppUsers,
        notStarted,
        organizationsTeam: uniqueTeams.size,
        totalTickets
      },
      usersPerTeam,
      ticketsPerTeam,
      ticketStatusSummary,
      allUsers,
      tickets,
      amzurUsers: { customSoftware: amzurCS, atg: amzurATG },
      evokeUsers
    });
  } catch (error) {
    logger.error('[AdminDashboard] Stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};
