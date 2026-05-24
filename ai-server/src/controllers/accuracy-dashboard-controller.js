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
 * All aggregations are pushed down to Postgres via RPCs declared in
 * 20260514_ai_accuracy_dashboard_redesign.sql (v2 summary/by-app) and
 * 20260514_ai_accuracy_reassignments_add_user.sql (reassignments with user
 * attribution); this controller only shapes the response.
 *
 * Bucket model used uniformly by /summary, /wrong-pairs, and /by-app:
 *   matched     -> approved_as_is
 *   reassigned  -> reassigned ∪ (manually_assigned WITH suggestion)
 *   unmatched   -> manually_assigned WITHOUT suggestion
 *
 * match_rate is time-weighted everywhere it appears.
 *
 * Removal: delete this file, the route mounts in src/index.js, the matching
 * Forge resolver, and the frontend tab. Drop the RPCs via a follow-up migration.
 *
 * Endpoints (all GET, mounted under /api/forge/accuracy/* in src/index.js):
 *   /orgs               List orgs (for filter dropdown)
 *   /summary            Matched/Reassigned/Unmatched buckets + time-weighted match rate
 *   /wrong-pairs        Reassignment pairs with total time, is_new_issue, user attribution
 *   /by-app             Matched/Reassigned/Unmatched time + counts per application
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

    // Resolve display names from organizations table (best-effort).  Column is
    // `org_name` (not `name`) — see schema in 20260221_add_activity_records.sql
    // and earlier org migrations. Falls back to jira_cloud_id, then the UUID.
    let orgs = orgIds.map(id => ({ id, name: id }));
    if (orgIds.length > 0) {
      const { data: orgNames } = await supabase
        .from('organizations')
        .select('id, org_name, jira_cloud_id')
        .in('id', orgIds);
      if (orgNames) {
        const byId = new Map(orgNames.map(o => [o.id, o]));
        orgs = orgIds.map(id => ({
          id,
          name: byId.get(id)?.org_name || byId.get(id)?.jira_cloud_id || id
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
// Summary — three time buckets (matched / reassigned / unmatched) + time-
// weighted match rate.  Powered by get_accuracy_summary_v2, which returns the
// buckets as a single row already aggregated in the database.
//
// Bucket model (identical across all v2 endpoints — see migration
// 20260514_ai_accuracy_dashboard_redesign.sql):
//   matched     -> event_type = 'approved_as_is'
//   reassigned  -> event_type = 'reassigned'
//                  OR (event_type = 'manually_assigned' AND ai_suggested_issue_key IS NOT NULL)
//   unmatched   -> event_type = 'manually_assigned' AND ai_suggested_issue_key IS NULL
//
// match_rate is TIME-WEIGHTED: matched_seconds / (matched_seconds + reassigned_seconds).
// Unmatched time is excluded — the AI didn't make a suggestion, so it can't be
// scored as right/wrong.
// ---------------------------------------------------------------------------

exports.getSummary = async (req, res) => {
  try {
    const supabase = getClient();
    if (!supabase) return jsonError(res, 500, 'Database not configured');

    const { days, sinceISO } = sinceTimestamp(req.query.days);

    const { data, error } = await supabase.rpc('get_accuracy_summary_v2', {
      p_org: orgParam(req.query.org),
      p_since: sinceISO
    });
    if (error) throw error;

    const row = (data && data[0]) || {};

    const matched = {
      count: Number(row.matched_count) || 0,
      seconds: Number(row.matched_seconds) || 0
    };
    const reassigned = {
      count: Number(row.reassigned_count) || 0,
      seconds: Number(row.reassigned_seconds) || 0,
      new_issue_count: Number(row.reassigned_new_issue_count) || 0,
      new_issue_seconds: Number(row.reassigned_new_issue_seconds) || 0
    };
    const unmatched = {
      count: Number(row.unmatched_count) || 0,
      seconds: Number(row.unmatched_seconds) || 0
    };

    const decidedSeconds = matched.seconds + reassigned.seconds;
    const matchRate = decidedSeconds > 0 ? matched.seconds / decidedSeconds : null;

    return jsonOk(res, {
      days,
      matched,
      reassigned,
      unmatched,
      match_rate: matchRate,
      total_events: matched.count + reassigned.count + unmatched.count,
      total_seconds: matched.seconds + reassigned.seconds + unmatched.seconds
    });
  } catch (err) {
    logger.error('[AccuracyDashboard] getSummary failed:', err.message);
    return jsonError(res, 500, err.message);
  }
};

// ---------------------------------------------------------------------------
// Reassignments — pairs of (AI suggested, user chose) with the total time
// involved.  Sorted by total_seconds desc so high-impact mistakes lead.
//
// is_new_issue is true when at least one event in the pair has
// metadata.reassign_reason='created_new_issue' — i.e. the destination issue
// was created from the AI's suggestion rather than chosen from existing.
//
// Route name preserved (/wrong-pairs) for compatibility with the resolver;
// the response shape adds total_seconds and is_new_issue.
// ---------------------------------------------------------------------------

exports.getWrongPairs = async (req, res) => {
  try {
    const supabase = getClient();
    if (!supabase) return jsonError(res, 500, 'Database not configured');

    const { days, sinceISO } = sinceTimestamp(req.query.days);

    const { data, error } = await supabase.rpc('get_accuracy_reassignments', {
      p_org: orgParam(req.query.org),
      p_since: sinceISO,
      p_limit: clampInt(req.query.limit, 1, 200, 25)
    });
    if (error) throw error;

    const pairs = (data || []).map(r => ({
      from: r.ai_suggested_issue_key,
      to: r.final_issue_key,
      is_new_issue: !!r.is_new_issue,
      user_id: r.user_id || null,
      user_display_name: r.user_display_name || null,
      user_email: r.user_email || null,
      seconds: Number(r.total_seconds) || 0,
      count: Number(r.pair_count) || 0
    }));

    return jsonOk(res, { days, pairs });
  } catch (err) {
    logger.error('[AccuracyDashboard] getWrongPairs failed:', err.message);
    return jsonError(res, 500, err.message);
  }
};

// ---------------------------------------------------------------------------
// By-app — matched / reassigned / unmatched per application_name, returned
// as both counts AND duration_seconds.  Sorted by total_seconds desc so
// high-volume apps surface first regardless of their accuracy.
//
// match_rate is time-weighted, with the same denominator rule as the headline
// (decided seconds = matched + reassigned; unmatched is reported separately).
// ---------------------------------------------------------------------------

exports.getByApp = async (req, res) => {
  try {
    const supabase = getClient();
    if (!supabase) return jsonError(res, 500, 'Database not configured');

    const { days, sinceISO } = sinceTimestamp(req.query.days);

    const { data, error } = await supabase.rpc('get_accuracy_by_app_v2', {
      p_org: orgParam(req.query.org),
      p_since: sinceISO,
      p_limit: clampInt(req.query.limit, 1, 200, 25)
    });
    if (error) throw error;

    const apps = (data || []).map(r => {
      const matched_count      = Number(r.matched_count)      || 0;
      const matched_seconds    = Number(r.matched_seconds)    || 0;
      const reassigned_count   = Number(r.reassigned_count)   || 0;
      const reassigned_seconds = Number(r.reassigned_seconds) || 0;
      const unmatched_count    = Number(r.unmatched_count)    || 0;
      const unmatched_seconds  = Number(r.unmatched_seconds)  || 0;
      const total_seconds      = Number(r.total_seconds)      || 0;

      const decidedSeconds = matched_seconds + reassigned_seconds;

      return {
        app: r.application_name,
        matched_count,
        matched_seconds,
        reassigned_count,
        reassigned_seconds,
        unmatched_count,
        unmatched_seconds,
        total_seconds,
        match_rate: decidedSeconds > 0 ? matched_seconds / decidedSeconds : null
      };
    });

    return jsonOk(res, { days, apps });
  } catch (err) {
    logger.error('[AccuracyDashboard] getByApp failed:', err.message);
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
