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
// Jira Issue Fetch (uses same JIRA_FEEDBACK_* env vars as ticket creation)
// ============================================================================
let jiraCache = { data: { statusMap: {}, issues: [] }, fetchedAt: 0 };
const JIRA_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

async function fetchJiraIssues() {
  const now = Date.now();
  if (now - jiraCache.fetchedAt < JIRA_CACHE_TTL) {
    return jiraCache.data;
  }

  const email = process.env.JIRA_FEEDBACK_EMAIL;
  const apiToken = process.env.JIRA_FEEDBACK_API_TOKEN;
  const projectKey = process.env.JIRA_FEEDBACK_PROJECT;
  const siteUrl = (process.env.JIRA_FEEDBACK_SITE_URL || '').replace(/\/$/, '');

  const siteUrls = [
    process.env.JIRA_FEEDBACK_SITE_URL,
    process.env.JIRA_BASE_URL
  ].filter(Boolean);

  const empty = { statusMap: {}, issues: [] };
  if (siteUrls.length === 0 || !email || !apiToken || !projectKey) return empty;

  const basicAuth = Buffer.from(`${email}:${apiToken}`).toString('base64');
  const headers = { 'Authorization': `Basic ${basicAuth}`, 'Accept': 'application/json' };
  const params = {
    jql: `project = ${projectKey} ORDER BY created DESC`,
    fields: 'status,priority,summary,reporter,created',
    maxResults: 200
  };

  for (const url of siteUrls) {
    const baseUrl = url.replace(/\/$/, '');
    const endpoints = [
      `${baseUrl}/rest/api/3/search/jql`,
      `${baseUrl}/rest/api/3/search`,
      `${baseUrl}/rest/api/2/search`,
    ];
    for (const endpoint of endpoints) {
      try {
        const response = await axios.get(endpoint, {
          params, headers, timeout: 10000
        });

        const statusMap = {};
        const issues = [];
        (response.data.issues || []).forEach(issue => {
          statusMap[issue.key] = {
            status: issue.fields?.status?.name || '-',
            priority: issue.fields?.priority?.name || '-'
          };
          issues.push({
            key: issue.key,
            summary: issue.fields?.summary || '-',
            status: issue.fields?.status?.name || '-',
            priority: issue.fields?.priority?.name || '-',
            reporter: issue.fields?.reporter?.displayName || '-',
            reporterEmail: issue.fields?.reporter?.emailAddress || '',
            created: issue.fields?.created || null,
            url: siteUrl ? `${siteUrl}/browse/${issue.key}` : ''
          });
        });

        logger.info('[AdminDashboard] Jira fetch OK via %s — %d issues', endpoint, issues.length);
        jiraCache = { data: { statusMap, issues }, fetchedAt: Date.now() };
        return { statusMap, issues };
      } catch (e) {
        logger.warn('[AdminDashboard] Jira fetch failed: %s — %s', endpoint, e.message);
      }
    }
  }

  jiraCache = { data: empty, fetchedAt: Date.now() };
  return empty;
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
    logger.warn('[AdminDashboard] Failed login attempt from %s', req.ip);
    return res.status(401).json({ success: false, error: 'Invalid password' });
  }

  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);

  logger.info('[AdminDashboard] Admin logged in from %s', req.ip);
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

    // Jira issues (non-blocking)
    let jiraData = { statusMap: {}, issues: [] };
    try {
      jiraData = await fetchJiraIssues();
    } catch (e) {
      logger.warn('[AdminDashboard] Jira fetch failed: %s', e.message);
    }

    // Org ID → name
    const orgMap = {};
    orgs.forEach(o => { orgMap[o.id] = o.org_name; });

    // ── Build user list with team info ──
    const allUsers = users.map(u => {
      const org = orgMap[u.organization_id] || getOrg(u.email) || '-';
      const desktopInstalled = u.desktop_logged_in === true || !!u.desktop_last_heartbeat;
      return {
        displayName: u.display_name || '',
        email: u.email || '',
        organization: org,
        team: getTeam(u.email),
        isActive: u.is_active !== false,
        desktopInstalled,
        desktopLoggedIn: u.desktop_logged_in || false,
        lastHeartbeat: u.desktop_last_heartbeat,
        appVersion: u.desktop_app_version,
        createdAt: u.created_at,
        status: desktopInstalled ? 'Active' : 'Not Started'
      };
    });

    // ── Summary metrics ──
    const totalUsers = allUsers.length;
    const activeUsers = allUsers.filter(u => u.status === 'Active').length;
    const desktopAppUsers = allUsers.filter(u => u.desktopInstalled).length;
    const notStarted = allUsers.filter(u => u.status === 'Not Started').length;

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

    // ── Tickets: use Jira issues directly, enrich with feedback data ──
    const feedbackByKey = {};
    feedback.forEach(f => {
      if (f.jira_issue_key) feedbackByKey[f.jira_issue_key] = f;
    });

    const tickets = jiraData.issues.map(issue => {
      const fb = feedbackByKey[issue.key];
      return {
        issueKey: issue.key,
        issueUrl: issue.url,
        summary: issue.summary,
        submittedBy: fb?.user_display_name || issue.reporter,
        team: getTicketTeamLabel(fb?.user_email || issue.reporterEmail),
        status: issue.status,
        priority: issue.priority,
        category: fb?.category || '-',
        createdAt: issue.created
      };
    });

    // ── Tickets per team ──
    const teamTickets = {};
    tickets.forEach(t => {
      if (t.team !== '-') {
        if (!teamTickets[t.team]) teamTickets[t.team] = { count: 0, earliest: null };
        teamTickets[t.team].count++;
        if (t.createdAt && (!teamTickets[t.team].earliest || new Date(t.createdAt) < new Date(teamTickets[t.team].earliest))) {
          teamTickets[t.team].earliest = t.createdAt;
        }
      }
    });

    const totalTickets = tickets.length;
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

    // ── Dynamic org tabs ──
    const orgGroupsMap = {};
    allUsers.forEach(u => {
      const org = u.organization;
      if (!org || org === '-') return;
      if (!orgGroupsMap[org]) orgGroupsMap[org] = [];
      orgGroupsMap[org].push(u);
    });

    const orgTabs = Object.entries(orgGroupsMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([orgName, orgUsers]) => {
        const subGroupMap = {};
        orgUsers.forEach(u => {
          const team = u.team && u.team !== '-' ? u.team : orgName;
          if (!subGroupMap[team]) subGroupMap[team] = [];
          subGroupMap[team].push(u);
        });
        return {
          orgName,
          totalUsers: orgUsers.length,
          subGroups: Object.entries(subGroupMap).map(([name, users]) => ({ name, users }))
        };
      });

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
      orgTabs
    });
  } catch (error) {
    logger.error('[AdminDashboard] Stats error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
};
