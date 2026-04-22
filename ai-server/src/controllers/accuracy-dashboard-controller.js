/**
 * AI Accuracy Dashboard Controller — REMOVABLE LAYER
 *
 * Read-only handlers powering the accuracy dashboard surfaced inside the
 * Jira Forge app frontend (Admin tab). Every endpoint runs behind
 * forgeAuthMiddleware (FIT validation); per-user authorization (email
 * allowlist via accuracy_dashboard_users table) is enforced inside the
 * Forge resolver before it calls these endpoints.
 *
 * Response shape is {success: true, data: {...}} so that Forge's
 * `remoteRequest` helper unwraps it cleanly.
 *
 * All aggregations are pushed down to Postgres via RPCs declared in migration
 * 20260422_ai_accuracy_aggregations.sql; this controller only shapes the
 * response.
 *
 * Removal: delete this file, the route mounts in src/index.js, the matching
 * Forge resolver, and the frontend tab. Drop the RPCs via a follow-up migration.
 *
 * Endpoints (all GET, mounted under /api/forge/accuracy/* in src/index.js):
 *   /orgs               List orgs (for filter dropdown)
 *   /summary            Headline accuracy + counts
 *   /wrong-pairs        Top reassigned (AI guess -> user pick)
 *   /by-app             Right/wrong per application
 *   /calibration        Confidence buckets vs actual accuracy
 *   /recent-mistakes    Last N reassigned events
 *
 * Common query params:
 *   days  - integer, defaults to 7, clamped to [1, 365]
 *   org   - organization_id (optional; omit for all orgs)
 *   limit - integer, defaults vary per endpoint
 */

const logger = require('../utils/logger');
const { getClient } = require('../services/db/supabase-client');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const UUID_RE = /^[0-9a-f-]{36}$/i;

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

// Convert the org query param to either a valid UUID string or null (so the
// RPC's `p_org IS NULL OR organization_id = p_org` matches all orgs).
function orgParam(orgId) {
  return orgId && UUID_RE.test(orgId) ? orgId : null;
}

function jsonError(res, status, message) {
  return res.status(status).json({ success: false, error: message });
}

function jsonOk(res, data) {
  return res.json({ success: true, data });
}

// ---------------------------------------------------------------------------
// Orgs list — for the dropdown
// ---------------------------------------------------------------------------

exports.listOrgs = async (req, res) => {
  try {
    const supabase = getClient();
    if (!supabase) return jsonError(res, 500, 'Database not configured');

    // RPC returns DISTINCT organization_id values — bounded by the number of
    // distinct orgs that have produced events, not by total event count.
    const { data: orgRows, error } = await supabase.rpc('get_accuracy_event_orgs');
    if (error) throw error;

    const orgIds = (orgRows || []).map(r => r.organization_id).filter(Boolean);

    // Resolve display names from organizations table (best-effort).  Falls
    // back to the org UUID if the name lookup fails or is missing.
    let orgs = orgIds.map(id => ({ id, name: id }));
    if (orgIds.length > 0) {
      const { data: orgNames } = await supabase
        .from('organizations')
        .select('id, name, jira_cloud_id')
        .in('id', orgIds);
      if (orgNames) {
        const byId = new Map(orgNames.map(o => [o.id, o]));
        orgs = orgIds.map(id => ({
          id,
          name: byId.get(id)?.name || byId.get(id)?.jira_cloud_id || id
        }));
      }
    }

    return jsonOk(res, { orgs });
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

    const { data, error } = await supabase.rpc('get_accuracy_summary', {
      p_org: orgParam(req.query.org),
      p_since: sinceISO
    });
    if (error) throw error;

    // RPC returns one row per (event_type, has_suggestion) bucket.  Collapse
    // into the shape the dashboard expects.
    const counts = {
      approved_as_is: 0,
      reassigned: 0,
      manually_assigned_with_suggestion: 0,
      manually_assigned_no_suggestion: 0
    };
    const durations = { approved: 0, reassigned: 0, manually_assigned: 0 };
    let totalEvents = 0;

    for (const row of (data || [])) {
      const c = Number(row.event_count) || 0;
      const s = Number(row.total_seconds) || 0;
      totalEvents += c;

      if (row.event_type === 'approved_as_is') {
        counts.approved_as_is += c;
        durations.approved += s;
      } else if (row.event_type === 'reassigned') {
        counts.reassigned += c;
        durations.reassigned += s;
      } else if (row.event_type === 'manually_assigned') {
        if (row.has_suggestion) counts.manually_assigned_with_suggestion += c;
        else                    counts.manually_assigned_no_suggestion += c;
        durations.manually_assigned += s;
      }
    }

    // Accuracy rate — among events where the AI made a suggestion, the share
    // the user accepted unchanged.  Excludes "manually_assigned with no
    // suggestion" because the AI didn't try (different signal).
    const decided =
      counts.approved_as_is +
      counts.reassigned +
      counts.manually_assigned_with_suggestion;
    const accuracyRate = decided > 0 ? counts.approved_as_is / decided : null;

    return jsonOk(res, {
      days,
      counts,
      accuracy_rate: accuracyRate,
      duration_seconds: durations,
      total_events: totalEvents
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

    const { data, error } = await supabase.rpc('get_accuracy_wrong_pairs', {
      p_org: orgParam(req.query.org),
      p_since: sinceISO,
      p_limit: clampInt(req.query.limit, 1, 200, 25)
    });
    if (error) throw error;

    const pairs = (data || []).map(r => ({
      from: r.ai_suggested_issue_key,
      to: r.final_issue_key,
      count: Number(r.pair_count) || 0
    }));

    return jsonOk(res, { days, pairs });
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

    const { data, error } = await supabase.rpc('get_accuracy_by_app', {
      p_org: orgParam(req.query.org),
      p_since: sinceISO,
      p_limit: clampInt(req.query.limit, 1, 200, 25)
    });
    if (error) throw error;

    const apps = (data || []).map(r => {
      const right = Number(r.right_count) || 0;
      const wrong = Number(r.wrong_count) || 0;
      const manuallyAssigned = Number(r.manually_assigned_count) || 0;
      const decided = right + wrong;
      return {
        app: r.application_name,
        right,
        wrong,
        manually_assigned: manuallyAssigned,
        accuracy_rate: decided > 0 ? right / decided : null,
        total: decided + manuallyAssigned
      };
    });

    return jsonOk(res, { days, apps });
  } catch (err) {
    logger.error('[AccuracyDashboard] getByApp failed:', err.message);
    return jsonError(res, 500, err.message);
  }
};

// ---------------------------------------------------------------------------
// Calibration — does AI confidence predict actual accuracy?
//
// Includes manually_assigned events that had a non-null AI suggestion (the
// AI tried but the user picked something different in the unassigned-work
// flow — that's also a confidence-vs-outcome signal).  RPC returns one row
// per non-empty bucket; we re-pad to the full 10 buckets so the dashboard
// renders an even axis.
// ---------------------------------------------------------------------------

exports.getCalibration = async (req, res) => {
  try {
    const supabase = getClient();
    if (!supabase) return jsonError(res, 500, 'Database not configured');

    const { days, sinceISO } = sinceTimestamp(req.query.days);

    const { data, error } = await supabase.rpc('get_accuracy_calibration', {
      p_org: orgParam(req.query.org),
      p_since: sinceISO
    });
    if (error) throw error;

    const byBucket = new Map();
    for (const r of (data || [])) {
      byBucket.set(Number(r.bucket), {
        sample_count: Number(r.sample_count) || 0,
        right_count: Number(r.right_count) || 0
      });
    }

    const series = Array.from({ length: 10 }, (_, i) => {
      const b = byBucket.get(i) || { sample_count: 0, right_count: 0 };
      return {
        bucket_label: `${i * 10}-${(i + 1) * 10}%`,
        sample_count: b.sample_count,
        actual_accuracy: b.sample_count > 0 ? b.right_count / b.sample_count : null
      };
    });

    return jsonOk(res, { days, series });
  } catch (err) {
    logger.error('[AccuracyDashboard] getCalibration failed:', err.message);
    return jsonError(res, 500, err.message);
  }
};

// ---------------------------------------------------------------------------
// Recent mistakes — last N AI-was-wrong events for prompt-tuning context
//
// Includes both 'reassigned' and 'manually_assigned' events that had an AI
// suggestion (the manually_assigned-with-suggestion case is also "AI got it
// wrong" — the user disagreed with the AI's pick when assigning unassigned
// work).
// ---------------------------------------------------------------------------

exports.getRecentMistakes = async (req, res) => {
  try {
    const supabase = getClient();
    if (!supabase) return jsonError(res, 500, 'Database not configured');

    const limit = clampInt(req.query.limit, 1, 200, 50);
    const orgId = orgParam(req.query.org);

    let q = supabase
      .from('ai_accuracy_events')
      .select('id, created_at, event_type, ai_suggested_issue_key, final_issue_key, ai_confidence_score, application_name, window_title, classification, duration_seconds, metadata')
      .in('event_type', ['reassigned', 'manually_assigned'])
      .not('ai_suggested_issue_key', 'is', null)
      .order('created_at', { ascending: false })
      .limit(limit);
    if (orgId) q = q.eq('organization_id', orgId);

    const { data, error } = await q;
    if (error) throw error;

    return jsonOk(res, { mistakes: data || [] });
  } catch (err) {
    logger.error('[AccuracyDashboard] getRecentMistakes failed:', err.message);
    return jsonError(res, 500, err.message);
  }
};
