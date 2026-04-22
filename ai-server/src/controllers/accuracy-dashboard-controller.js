/**
 * AI Accuracy Dashboard Controller — REMOVABLE LAYER
 *
 * Read-only handlers powering the accuracy dashboard.  Every endpoint runs
 * behind accuracy-dashboard-auth (email allowlist).  All queries hit
 * public.ai_accuracy_events directly via the service-role Supabase client; no
 * production tables are touched.
 *
 * Removal: delete this file, the middleware, the HTML, and the route mounts
 * in src/index.js.
 *
 * Endpoints:
 *   GET  /accuracy-dashboard                            HTML page
 *   GET  /accuracy-dashboard/api/orgs                   List orgs (for filter dropdown)
 *   GET  /accuracy-dashboard/api/summary                Headline accuracy + counts
 *   GET  /accuracy-dashboard/api/wrong-pairs            Top reassigned (AI guess -> user pick)
 *   GET  /accuracy-dashboard/api/by-app                 Right/wrong per application
 *   GET  /accuracy-dashboard/api/calibration            Confidence buckets vs actual accuracy
 *   GET  /accuracy-dashboard/api/recent-mistakes        Last N reassigned events
 *
 * Common query params:
 *   days  - integer, defaults to 7, clamped to [1, 365]
 *   org   - organization_id (optional; omit for all orgs)
 *   limit - integer, defaults vary per endpoint
 */

const path = require('node:path');
const logger = require('../utils/logger');
const { getClient } = require('../services/db/supabase-client');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function sinceTimestamp(daysParam) {
  const days = clampInt(daysParam, 1, 365, 7);
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  return { days, sinceISO: since.toISOString() };
}

function applyOrgFilter(builder, orgId) {
  if (orgId && /^[0-9a-f-]{36}$/i.test(orgId)) {
    return builder.eq('organization_id', orgId);
  }
  return builder;
}

function jsonError(res, status, message) {
  return res.status(status).json({ success: false, error: message });
}

// ---------------------------------------------------------------------------
// HTML page
// ---------------------------------------------------------------------------

exports.servePage = (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'dashboard', 'accuracy-dashboard.html'));
};

// ---------------------------------------------------------------------------
// Orgs list — for the dropdown
// ---------------------------------------------------------------------------

exports.listOrgs = async (req, res) => {
  try {
    const supabase = getClient();
    if (!supabase) return jsonError(res, 500, 'Database not configured');

    // Pull distinct organizations that have at least one accuracy event.
    // No date window — the dropdown should reflect all orgs that have ever
    // produced events, so the user can drill into historical data.
    const { data, error } = await supabase
      .from('ai_accuracy_events')
      .select('organization_id')
      .limit(10000);

    if (error) throw error;

    const orgIds = [...new Set((data || []).map(r => r.organization_id).filter(Boolean))];

    // Resolve display names from organizations table (best-effort).
    let orgs = orgIds.map(id => ({ id, name: id }));
    if (orgIds.length > 0) {
      const { data: orgRows } = await supabase
        .from('organizations')
        .select('id, name, jira_cloud_id')
        .in('id', orgIds);
      if (orgRows) {
        const byId = new Map(orgRows.map(o => [o.id, o]));
        orgs = orgIds.map(id => ({
          id,
          name: byId.get(id)?.name || byId.get(id)?.jira_cloud_id || id
        }));
      }
    }

    return res.json({ success: true, orgs });
  } catch (err) {
    logger.error('[AccuracyDashboard] listOrgs failed:', err.message);
    return jsonError(res, 500, err.message);
  }
};

// ---------------------------------------------------------------------------
// Summary — headline accuracy %, totals per event type
// ---------------------------------------------------------------------------

exports.getSummary = async (req, res) => {
  try {
    const supabase = getClient();
    if (!supabase) return jsonError(res, 500, 'Database not configured');

    const { days, sinceISO } = sinceTimestamp(req.query.days);
    const orgId = req.query.org;

    let q = supabase
      .from('ai_accuracy_events')
      .select('event_type, ai_suggested_issue_key, duration_seconds')
      .gte('created_at', sinceISO);
    q = applyOrgFilter(q, orgId);

    const { data, error } = await q.limit(100000);
    if (error) throw error;

    const rows = data || [];
    const counts = {
      approved_as_is: 0,
      reassigned: 0,
      manually_assigned_with_suggestion: 0,
      manually_assigned_no_suggestion: 0
    };
    let approvedSeconds = 0;
    let reassignedSeconds = 0;
    let manuallyAssignedSeconds = 0;

    for (const r of rows) {
      switch (r.event_type) {
        case 'approved_as_is':
          counts.approved_as_is += 1;
          approvedSeconds += r.duration_seconds || 0;
          break;
        case 'reassigned':
          counts.reassigned += 1;
          reassignedSeconds += r.duration_seconds || 0;
          break;
        case 'manually_assigned':
          if (r.ai_suggested_issue_key) {
            counts.manually_assigned_with_suggestion += 1;
          } else {
            counts.manually_assigned_no_suggestion += 1;
          }
          manuallyAssignedSeconds += r.duration_seconds || 0;
          break;
        default:
          break;
      }
    }

    // Accuracy rate — among events where the AI made a suggestion, the share
    // the user accepted unchanged.  Excludes "manually_assigned with no
    // suggestion" because the AI didn't try (different signal).
    const decided =
      counts.approved_as_is +
      counts.reassigned +
      counts.manually_assigned_with_suggestion;
    const accuracyRate = decided > 0
      ? counts.approved_as_is / decided
      : null;

    return res.json({
      success: true,
      days,
      counts,
      accuracy_rate: accuracyRate,
      duration_seconds: {
        approved: approvedSeconds,
        reassigned: reassignedSeconds,
        manually_assigned: manuallyAssignedSeconds
      },
      total_events: rows.length
    });
  } catch (err) {
    logger.error('[AccuracyDashboard] getSummary failed:', err.message);
    return jsonError(res, 500, err.message);
  }
};

// ---------------------------------------------------------------------------
// Wrong pairs — what AI suggested vs. what the user actually picked
// ---------------------------------------------------------------------------

exports.getWrongPairs = async (req, res) => {
  try {
    const supabase = getClient();
    if (!supabase) return jsonError(res, 500, 'Database not configured');

    const { days, sinceISO } = sinceTimestamp(req.query.days);
    const orgId = req.query.org;
    const limit = clampInt(req.query.limit, 1, 200, 25);

    let q = supabase
      .from('ai_accuracy_events')
      .select('ai_suggested_issue_key, final_issue_key')
      .eq('event_type', 'reassigned')
      .gte('created_at', sinceISO);
    q = applyOrgFilter(q, orgId);

    const { data, error } = await q.limit(50000);
    if (error) throw error;

    const counts = new Map();
    for (const r of (data || [])) {
      if (!r.ai_suggested_issue_key) continue;  // no AI guess to learn from
      const key = `${r.ai_suggested_issue_key}|${r.final_issue_key}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }

    const pairs = [...counts.entries()]
      .map(([key, count]) => {
        const [from, to] = key.split('|');
        return { from, to, count };
      })
      .sort((a, b) => b.count - a.count)
      .slice(0, limit);

    return res.json({ success: true, days, pairs });
  } catch (err) {
    logger.error('[AccuracyDashboard] getWrongPairs failed:', err.message);
    return jsonError(res, 500, err.message);
  }
};

// ---------------------------------------------------------------------------
// By-app — right/wrong rate per application_name
// ---------------------------------------------------------------------------

exports.getByApp = async (req, res) => {
  try {
    const supabase = getClient();
    if (!supabase) return jsonError(res, 500, 'Database not configured');

    const { days, sinceISO } = sinceTimestamp(req.query.days);
    const orgId = req.query.org;
    const limit = clampInt(req.query.limit, 1, 200, 25);

    let q = supabase
      .from('ai_accuracy_events')
      .select('event_type, application_name')
      .gte('created_at', sinceISO);
    q = applyOrgFilter(q, orgId);

    const { data, error } = await q.limit(100000);
    if (error) throw error;

    const byApp = new Map();
    for (const r of (data || [])) {
      const app = (r.application_name || '(unknown)').toLowerCase();
      const cur = byApp.get(app) || { app, right: 0, wrong: 0, manually_assigned: 0 };
      if (r.event_type === 'approved_as_is') cur.right += 1;
      else if (r.event_type === 'reassigned') cur.wrong += 1;
      else if (r.event_type === 'manually_assigned') cur.manually_assigned += 1;
      byApp.set(app, cur);
    }

    const apps = [...byApp.values()]
      .map(a => {
        const decided = a.right + a.wrong;
        return {
          ...a,
          accuracy_rate: decided > 0 ? a.right / decided : null,
          total: decided + a.manually_assigned
        };
      })
      .sort((a, b) => b.wrong - a.wrong)
      .slice(0, limit);

    return res.json({ success: true, days, apps });
  } catch (err) {
    logger.error('[AccuracyDashboard] getByApp failed:', err.message);
    return jsonError(res, 500, err.message);
  }
};

// ---------------------------------------------------------------------------
// Calibration — does AI confidence predict actual accuracy?
// ---------------------------------------------------------------------------

exports.getCalibration = async (req, res) => {
  try {
    const supabase = getClient();
    if (!supabase) return jsonError(res, 500, 'Database not configured');

    const { days, sinceISO } = sinceTimestamp(req.query.days);
    const orgId = req.query.org;

    let q = supabase
      .from('ai_accuracy_events')
      .select('event_type, ai_confidence_score')
      .in('event_type', ['approved_as_is', 'reassigned'])
      .not('ai_confidence_score', 'is', null)
      .gte('created_at', sinceISO);
    q = applyOrgFilter(q, orgId);

    const { data, error } = await q.limit(100000);
    if (error) throw error;

    // Ten 0.1-wide buckets covering [0.0, 1.0].  Confidences > 1 land in the
    // top bucket; < 0 land in the bottom.
    const buckets = Array.from({ length: 10 }, (_, i) => ({
      bucket_min: i / 10,
      bucket_max: (i + 1) / 10,
      right: 0,
      wrong: 0
    }));

    for (const r of (data || [])) {
      const c = Math.max(0, Math.min(0.999999, Number(r.ai_confidence_score)));
      const idx = Math.floor(c * 10);
      const bucket = buckets[idx];
      if (r.event_type === 'approved_as_is') bucket.right += 1;
      else if (r.event_type === 'reassigned') bucket.wrong += 1;
    }

    const series = buckets.map(b => {
      const total = b.right + b.wrong;
      return {
        bucket_label: `${(b.bucket_min * 100).toFixed(0)}-${(b.bucket_max * 100).toFixed(0)}%`,
        sample_count: total,
        actual_accuracy: total > 0 ? b.right / total : null
      };
    });

    return res.json({ success: true, days, series });
  } catch (err) {
    logger.error('[AccuracyDashboard] getCalibration failed:', err.message);
    return jsonError(res, 500, err.message);
  }
};

// ---------------------------------------------------------------------------
// Recent mistakes — last N reassigned events for prompt-tuning context
// ---------------------------------------------------------------------------

exports.getRecentMistakes = async (req, res) => {
  try {
    const supabase = getClient();
    if (!supabase) return jsonError(res, 500, 'Database not configured');

    const orgId = req.query.org;
    const limit = clampInt(req.query.limit, 1, 200, 50);

    let q = supabase
      .from('ai_accuracy_events')
      .select('id, created_at, ai_suggested_issue_key, final_issue_key, ai_confidence_score, application_name, window_title, classification, duration_seconds, metadata')
      .eq('event_type', 'reassigned')
      .order('created_at', { ascending: false })
      .limit(limit);
    q = applyOrgFilter(q, orgId);

    const { data, error } = await q;
    if (error) throw error;

    return res.json({ success: true, mistakes: data || [] });
  } catch (err) {
    logger.error('[AccuracyDashboard] getRecentMistakes failed:', err.message);
    return jsonError(res, 500, err.message);
  }
};
