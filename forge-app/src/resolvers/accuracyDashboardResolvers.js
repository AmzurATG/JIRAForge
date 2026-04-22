/**
 * AI Accuracy Dashboard Resolvers — REMOVABLE LAYER
 *
 * Surfaces the AI accuracy dashboard inside the Forge app frontend (Admin tab).
 * Authorization is gated by the `public.accuracy_dashboard_users` email
 * allowlist — Jira admin role is intentionally NOT checked (an admin who isn't
 * on the allowlist gets denied; a non-admin who is on the allowlist gets
 * access).
 *
 * Each resolver:
 *   1. Resolves the requester's email from the Jira user API
 *   2. Confirms membership in accuracy_dashboard_users (case-insensitive)
 *   3. Forwards to the AI server's /api/forge/accuracy/* endpoint via FIT
 *
 * Removal: delete this file, unregister it in src/index.js, drop the
 * corresponding tab in static/main, and drop the matching ai-server routes +
 * controller. See plan/AI_ACCURACY_TRACKING_IMPLEMENTATION_PLAN.md.
 */

import api, { route } from '@forge/api';
import { remoteRequest } from '../utils/remote.js';
import { supabaseQuery } from '../utils/remote.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Get the current Jira user's email. Uses /rest/api/3/myself which returns
 * the requesting user's profile (no accountId needed and emailAddress is
 * always returned for the caller themselves regardless of privacy settings).
 */
async function getCurrentUserEmail() {
  try {
    const response = await api.asUser().requestJira(
      route`/rest/api/3/myself`,
      { method: 'GET', headers: { Accept: 'application/json' } }
    );
    if (!response.ok) {
      console.warn('[AccuracyDashboard] /myself returned', response.status);
      return null;
    }
    const me = await response.json();
    const email = (me?.emailAddress || '').trim().toLowerCase();
    return email || null;
  } catch (err) {
    console.error('[AccuracyDashboard] getCurrentUserEmail failed:', err.message);
    return null;
  }
}

/**
 * Check whether the caller's email is on the allowlist. Returns
 * { allowed: boolean, email: string|null, reason?: string }.
 *
 * Performs a case-insensitive lookup in `accuracy_dashboard_users` via the
 * AI server's Supabase proxy (service-role on the server). Storing the
 * allowlist server-side keeps the membership list out of any client bundle.
 */
async function checkAllowlist() {
  const email = await getCurrentUserEmail();
  if (!email) {
    return { allowed: false, email: null, reason: 'Cannot determine your email' };
  }
  try {
    // Migration 20260422_ai_accuracy_tracking_harden.sql enforces lowercase
    // emails in this table, so a case-sensitive eq on the lowercased caller
    // email is sufficient (and the supabase proxy doesn't expose `ilike`).
    const rows = await supabaseQuery('accuracy_dashboard_users', {
      method: 'GET',
      query: { eq: { email }, limit: 1 },
      select: 'email'
    });
    const allowed = Array.isArray(rows) && rows.length > 0;
    return { allowed, email, reason: allowed ? undefined : 'Not on the accuracy dashboard allowlist' };
  } catch (err) {
    console.error('[AccuracyDashboard] Allowlist lookup failed:', err.message);
    return { allowed: false, email, reason: 'Authorization check failed' };
  }
}

/**
 * Build a query string from a payload object, dropping null/undefined.
 */
function buildQueryString(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === null || v === undefined || v === '') continue;
    usp.append(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

/**
 * Common wrapper: re-check allowlist on every call (cheap, ~1 DB hit) then
 * GET the corresponding AI server endpoint via FIT.
 */
async function callAiServer(endpoint, params) {
  const access = await checkAllowlist();
  if (!access.allowed) {
    return { success: false, error: access.reason || 'Access denied' };
  }
  try {
    const data = await remoteRequest(`${endpoint}${buildQueryString(params)}`, {
      method: 'GET'
    });
    return { success: true, data };
  } catch (err) {
    console.error(`[AccuracyDashboard] ${endpoint} failed:`, err.message);
    return { success: false, error: err.message };
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerAccuracyDashboardResolvers(resolver) {
  // Lightweight visibility check used by the frontend on mount to decide
  // whether to render the sidebar entry. No data, just a yes/no.
  resolver.define('checkAccuracyDashboardAccess', async () => {
    const access = await checkAllowlist();
    return {
      success: true,
      allowed: access.allowed,
      email: access.email,
      reason: access.reason
    };
  });

  resolver.define('getAccuracyOrgs', async () =>
    callAiServer('/api/forge/accuracy/orgs', {})
  );

  resolver.define('getAccuracySummary', async ({ payload = {} }) =>
    callAiServer('/api/forge/accuracy/summary', {
      days: payload.days,
      org: payload.org
    })
  );

  resolver.define('getAccuracyWrongPairs', async ({ payload = {} }) =>
    callAiServer('/api/forge/accuracy/wrong-pairs', {
      days: payload.days,
      org: payload.org,
      limit: payload.limit
    })
  );

  resolver.define('getAccuracyByApp', async ({ payload = {} }) =>
    callAiServer('/api/forge/accuracy/by-app', {
      days: payload.days,
      org: payload.org,
      limit: payload.limit
    })
  );

  resolver.define('getAccuracyCalibration', async ({ payload = {} }) =>
    callAiServer('/api/forge/accuracy/calibration', {
      days: payload.days,
      org: payload.org
    })
  );

  resolver.define('getAccuracyRecentMistakes', async ({ payload = {} }) =>
    callAiServer('/api/forge/accuracy/recent-mistakes', {
      org: payload.org,
      limit: payload.limit
    })
  );
}
