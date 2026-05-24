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
import { kvs } from '@forge/kvs';
import { remoteRequest } from '../utils/remote.js';
import { supabaseQuery } from '../utils/remote.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Allowlist cache TTL. A dashboard refresh fires 6 parallel resolver calls;
// without caching, each one re-hits Jira /myself + Supabase. 60s is short
// enough that revoking access takes effect within a minute, long enough that
// the typical refresh cadence (≤5s) only triggers a single round trip.
const ALLOWLIST_TTL_MS = 60 * 1000;

// In-memory cache keyed by accountId. Survives across resolver calls within
// the same Forge invocation container (warm starts). Stores both the
// resolved email and the allowlist verdict so a single dashboard refresh
// (6 parallel resolver calls) does at most one /myself + one Supabase hit.
const _memoryCache = new Map(); // accountId -> { email, allowed, expiresAt }

function kvsCacheKey(accountId) {
  return `accuracy-dashboard:allow:${accountId}`;
}

async function getCachedAccess(accountId) {
  if (!accountId) return null;
  const mem = _memoryCache.get(accountId);
  if (mem && mem.expiresAt > Date.now()) return mem;
  try {
    const entry = await kvs.get(kvsCacheKey(accountId));
    if (entry && entry.expiresAt > Date.now()) {
      _memoryCache.set(accountId, entry);
      return entry;
    }
  } catch {
    // KVS unavailable — fall through to live lookup.
  }
  return null;
}

function setCachedAccess(accountId, email, allowed) {
  if (!accountId) return;
  const entry = { email, allowed, expiresAt: Date.now() + ALLOWLIST_TTL_MS };
  _memoryCache.set(accountId, entry);
  // Fire-and-forget — cache misses are cheap, don't block the request.
  kvs.set(kvsCacheKey(accountId), entry).catch(() => {});
}

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
async function checkAllowlist(accountId) {
  // Fast path: cached verdict for this accountId (avoids both /myself AND Supabase).
  const cached = await getCachedAccess(accountId);
  if (cached) {
    return {
      allowed: cached.allowed,
      email: cached.email,
      reason: cached.allowed ? undefined : 'Not on the accuracy dashboard allowlist'
    };
  }

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
    setCachedAccess(accountId, email, allowed);
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
async function callAiServer(req, endpoint, params) {
  const accountId = req?.context?.accountId;
  const access = await checkAllowlist(accountId);
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
  resolver.define('checkAccuracyDashboardAccess', async (req) => {
    const access = await checkAllowlist(req?.context?.accountId);
    return {
      success: true,
      allowed: access.allowed,
      email: access.email,
      reason: access.reason
    };
  });

  resolver.define('getAccuracyOrgs', async (req) =>
    callAiServer(req, '/api/forge/accuracy/orgs', {})
  );

  resolver.define('getAccuracySummary', async (req) =>
    callAiServer(req, '/api/forge/accuracy/summary', {
      days: req.payload?.days,
      org: req.payload?.org
    })
  );

  resolver.define('getAccuracyWrongPairs', async (req) =>
    callAiServer(req, '/api/forge/accuracy/wrong-pairs', {
      days: req.payload?.days,
      org: req.payload?.org,
      limit: req.payload?.limit
    })
  );

  resolver.define('getAccuracyByApp', async (req) =>
    callAiServer(req, '/api/forge/accuracy/by-app', {
      days: req.payload?.days,
      org: req.payload?.org,
      limit: req.payload?.limit
    })
  );

  resolver.define('getAccuracyRecentMistakes', async (req) =>
    callAiServer(req, '/api/forge/accuracy/recent-mistakes', {
      org: req.payload?.org,
      limit: req.payload?.limit
    })
  );
}
