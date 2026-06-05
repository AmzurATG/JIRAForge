/**
 * Description Quality Nudge Scheduler
 * Enhancement #13 — see plan: docs/jira_ticket_description_enhancement/13_SCHEDULED_QUALITY_NOTIFICATIONS.md
 *
 * Runs hourly (via two scheduledTriggers in manifest.yml: A/B).
 *
 * Algorithm (per tenant invocation):
 *   1. Acquire a 60s KVS lock to prevent overlapping runs of A and B.
 *   2. JQL: `assignee is not EMPTY AND statusCategory != Done AND updated >= -30d`
 *      via api.asApp() — returns recent open issues with an assignee.
 *   3. Group results by assignee accountId.
 *   4. For each (assignee, issue):
 *        - Look up cached quality score in description_quality_cache.
 *        - If absent, warm-up by calling the AI server `/api/forge/description/analyze`
 *          (capped at 10 warm-ups per tenant per run for cost control).
 *        - Skip if score >= MIN_NUDGE_SCORE (80).
 *        - Skip if the user is within their cross-channel cooldown (24 h).
 *        - Skip if the user has opted out of BOTH channels (bell + popup).
 *   5. Per user: cap at MAX_NUDGES_PER_USER (5) nudges per run.
 *   6. Fan out:
 *        Channel A (Jira bell) — POST /rest/api/3/issue/{key}/notify, then insert
 *          a `description_quality_notifications` row with channel='jira'.
 *        Channel B (Desktop popup) — insert a row with channel='desktop' for the
 *          desktop poller to pick up.
 *
 * Privacy:
 *   The payload written to description_quality_notifications is restricted to
 *   {score, summary, issueUrl, appUrl} — never the description body.
 */

import api, { route } from '@forge/api';
import { kvs } from '@forge/kvs';
import { supabaseQuery } from '../utils/remote.js';

const LOCK_KEY = 'scheduler-lock/dq-nudge';
const LOCK_TTL_MS = 60 * 1000; // 60 seconds

const MAX_NUDGES_PER_USER = 5;
const MAX_WARMUPS_PER_RUN = 10;
const MIN_NUDGE_SCORE = 80;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const RECENT_DAYS_JQL = 30;
const MAX_JQL_RESULTS = 100;

const JQL_OPEN_RECENT = `assignee is not EMPTY AND statusCategory != Done AND updated >= -${RECENT_DAYS_JQL}d ORDER BY updated DESC`;

// ---------------------------------------------------------------------------
// Locking — prevents overlapping A/B runs.
// ---------------------------------------------------------------------------
async function tryAcquireLock(now = Date.now()) {
  try {
    const entry = await kvs.get(LOCK_KEY);
    if (entry && entry.expiresAt > now) {
      return false; // someone else holds the lock
    }
    await kvs.set(LOCK_KEY, { holder: 'scheduler', expiresAt: now + LOCK_TTL_MS });
    return true;
  } catch (err) {
    console.warn('[DQNudge] Lock acquire failed:', err.message);
    return false;
  }
}

async function releaseLock() {
  try { await kvs.delete(LOCK_KEY); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------------------
// Jira data fetch
// ---------------------------------------------------------------------------
async function fetchOpenIssuesAsApp() {
  const response = await api.asApp().requestJira(
    route`/rest/api/3/search/jql`,
    {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jql: JQL_OPEN_RECENT,
        maxResults: MAX_JQL_RESULTS,
        fields: ['summary', 'assignee', 'status']
      })
    }
  );
  if (!response.ok) {
    throw new Error(`Jira search failed: ${response.status}`);
  }
  const data = await response.json();
  return data.issues || [];
}

/**
 * Group `[{key, fields:{assignee:{accountId}, summary}}]` issues by assignee.
 * Returns: Map<accountId, Array<{key, summary}>>
 */
export function groupByAssignee(issues) {
  const byUser = new Map();
  for (const issue of issues) {
    const accountId = issue?.fields?.assignee?.accountId;
    if (!accountId) continue;
    const summary = issue?.fields?.summary || '';
    if (!byUser.has(accountId)) byUser.set(accountId, []);
    byUser.get(accountId).push({ key: issue.key, summary });
  }
  return byUser;
}

// ---------------------------------------------------------------------------
// Cache score lookup + warm-up
// ---------------------------------------------------------------------------
async function loadCachedScores(orgId, issueKeys) {
  if (issueKeys.length === 0) return new Map();
  const data = await supabaseQuery('description_quality_cache', {
    method: 'GET',
    query: {
      org_id: `eq.${orgId}`,
      issue_key: `in.(${issueKeys.join(',')})`,
      _select: 'issue_key,score'
    }
  });
  const map = new Map();
  for (const row of (data?.data || data || [])) {
    if (row && row.issue_key) map.set(row.issue_key, row.score);
  }
  return map;
}

/**
 * Decide whether this run should warm-up missing cache entries.
 * Caller-injected `analyzer` keeps this testable.
 */
async function warmUpMissingScores({ issuesNeedingScore, analyzer, budget }) {
  const newScores = new Map();
  let used = 0;
  for (const issue of issuesNeedingScore) {
    if (used >= budget) break;
    try {
      const result = await analyzer(issue.key);
      if (result && typeof result.score === 'number') {
        newScores.set(issue.key, result.score);
        used += 1;
      }
    } catch (err) {
      console.warn(`[DQNudge] Warm-up failed for ${issue.key}:`, err.message);
    }
  }
  return newScores;
}

// ---------------------------------------------------------------------------
// Dedupe / cooldown lookup against description_quality_notifications
// ---------------------------------------------------------------------------
async function loadRecentNotifications({ orgId, accountId, issueKeys, now = Date.now() }) {
  if (issueKeys.length === 0) return new Map();
  const sinceIso = new Date(now - COOLDOWN_MS).toISOString();
  const data = await supabaseQuery('description_quality_notifications', {
    method: 'GET',
    query: {
      org_id: `eq.${orgId}`,
      account_id: `eq.${accountId}`,
      issue_key: `in.(${issueKeys.join(',')})`,
      notified_at: `gte.${sinceIso}`,
      _select: 'issue_key,channel,notified_at,snooze_until'
    }
  });
  const map = new Map();
  for (const row of (data?.data || data || [])) {
    if (!row || !row.issue_key) continue;
    // Take the latest per issue
    const existing = map.get(row.issue_key);
    if (!existing || new Date(row.notified_at) > new Date(existing.notified_at)) {
      map.set(row.issue_key, row);
    }
  }
  return map;
}

function isWithinCooldown(row, now = Date.now()) {
  if (!row) return false;
  if (row.snooze_until && new Date(row.snooze_until).getTime() > now) return true;
  if (row.notified_at && (now - new Date(row.notified_at).getTime()) < COOLDOWN_MS) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------
async function loadPreferencesMap(orgId, accountIds) {
  if (accountIds.length === 0) return new Map();
  const data = await supabaseQuery('description_quality_nudge_preferences', {
    method: 'GET',
    query: {
      org_id: `eq.${orgId}`,
      account_id: `in.(${accountIds.join(',')})`,
      _select: 'account_id,bell_enabled,popup_enabled'
    }
  });
  const map = new Map();
  for (const row of (data?.data || data || [])) {
    if (row?.account_id) map.set(row.account_id, row);
  }
  return map;
}

function getPreference(prefs, accountId) {
  const row = prefs.get(accountId);
  return {
    bellEnabled: row ? row.bell_enabled !== false : true,
    popupEnabled: row ? row.popup_enabled !== false : true
  };
}

// ---------------------------------------------------------------------------
// Channel fan-out
// ---------------------------------------------------------------------------
async function sendJiraBellNotification(issueKey, summary) {
  // Forge api.asApp Jira notify — assignee is auto-included via "recipients.assignee".
  try {
    const response = await api.asApp().requestJira(
      route`/rest/api/3/issue/${issueKey}/notify`,
      {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          subject: 'Improve this ticket description',
          textBody: `The description quality for ${issueKey} (${summary}) is below the recommended threshold. Open it in the Time Tracker to view AI-suggested improvements.`,
          htmlBody: `<p>The description quality for <b>${issueKey}</b> (${summary}) is below the recommended threshold.</p><p>Open it in the Time Tracker to view AI-suggested improvements.</p>`,
          to: {
            assignee: true
          }
        })
      }
    );
    return response.ok;
  } catch (err) {
    console.warn(`[DQNudge] Jira notify failed for ${issueKey}:`, err.message);
    return false;
  }
}

async function insertNotificationRow({ orgId, accountId, cloudId, issueKey, score, channel, payload }) {
  // Payload allow-list — never include description text.
  const safePayload = {
    summary: payload.summary,
    score,
    issueUrl: payload.issueUrl,
    appUrl: payload.appUrl
  };
  await supabaseQuery('description_quality_notifications', {
    method: 'POST',
    body: {
      org_id: orgId,
      account_id: accountId,
      cloud_id: cloudId,
      issue_key: issueKey,
      score_at_notify: score,
      channel,
      payload: safePayload
    }
  });
}

// ---------------------------------------------------------------------------
// Public orchestrator (exported as the scheduled trigger handler)
// ---------------------------------------------------------------------------

/**
 * @param {Object} [deps] — injected for tests
 * @param {Object} [deps.context] — Forge context (must contain `cloudId`)
 * @param {Function} [deps.fetchIssues] — overrides fetchOpenIssuesAsApp
 * @param {Function} [deps.analyzer] — overrides ai-server warm-up
 * @param {Function} [deps.notifier] — overrides Jira bell notify
 * @param {Function} [deps.lockAcquire] — overrides tryAcquireLock
 * @param {Function} [deps.lockRelease] — overrides releaseLock
 * @param {Function} [deps.cacheLoader] — overrides loadCachedScores
 * @param {Function} [deps.recentLoader] — overrides loadRecentNotifications
 * @param {Function} [deps.prefsLoader] — overrides loadPreferencesMap
 * @param {Function} [deps.rowInserter] — overrides insertNotificationRow
 * @param {Function} [deps.now] — clock injection (returns ms)
 */
export async function runDescriptionQualityNudge(deps = {}) {
  const {
    context = {},
    fetchIssues = fetchOpenIssuesAsApp,
    analyzer = null,
    notifier = sendJiraBellNotification,
    lockAcquire = tryAcquireLock,
    lockRelease = releaseLock,
    cacheLoader = loadCachedScores,
    recentLoader = loadRecentNotifications,
    prefsLoader = loadPreferencesMap,
    rowInserter = insertNotificationRow,
    now = () => Date.now()
  } = deps;

  const cloudId = context.cloudId;
  if (!cloudId) {
    console.warn('[DQNudge] No cloudId in context — cannot determine tenant baseUrl, aborting.');
    return { success: false, error: 'missing cloudId' };
  }

  const acquired = await lockAcquire(now());
  if (!acquired) {
    console.log('[DQNudge] Lock held — skipping this run.');
    return { success: true, skipped: 'lock-held' };
  }

  const orgId = cloudId;
  const stats = {
    issuesScanned: 0,
    warmedUp: 0,
    bellSent: 0,
    desktopQueued: 0,
    skippedCooldown: 0,
    skippedOptOut: 0,
    skippedHighScore: 0,
    errors: 0
  };

  try {
    const issues = await fetchIssues();
    stats.issuesScanned = issues.length;
    if (issues.length === 0) {
      return { success: true, stats };
    }

    const byUser = groupByAssignee(issues);
    if (byUser.size === 0) {
      return { success: true, stats };
    }

    // Load preferences for all assignees in one shot.
    const accountIds = Array.from(byUser.keys());
    const prefsMap = await prefsLoader(orgId, accountIds);

    // Load cached scores for ALL issue keys in one query.
    const allKeys = issues.map((i) => i.key);
    const scores = await cacheLoader(orgId, allKeys);

    // Optional warm-up pass — capped per run.
    let warmupBudget = MAX_WARMUPS_PER_RUN;
    if (analyzer) {
      const missing = issues
        .filter((i) => !scores.has(i.key))
        .map((i) => ({ key: i.key, summary: i.fields?.summary || '' }))
        .slice(0, warmupBudget);
      const warmed = await warmUpMissingScores({
        issuesNeedingScore: missing,
        analyzer,
        budget: warmupBudget
      });
      for (const [k, v] of warmed.entries()) scores.set(k, v);
      stats.warmedUp = warmed.size;
    }

    // Per-user processing
    for (const [accountId, userIssues] of byUser.entries()) {
      const pref = getPreference(prefsMap, accountId);
      if (!pref.bellEnabled && !pref.popupEnabled) {
        stats.skippedOptOut += userIssues.length;
        continue;
      }

      // Candidate issues = below threshold with a known score
      const candidates = userIssues
        .filter((iss) => {
          const s = scores.get(iss.key);
          if (typeof s !== 'number') return false;
          if (s >= MIN_NUDGE_SCORE) {
            stats.skippedHighScore += 1;
            return false;
          }
          return true;
        })
        .slice(0, MAX_NUDGES_PER_USER);

      if (candidates.length === 0) continue;

      // Cross-channel cooldown lookup
      const recentMap = await recentLoader({
        orgId,
        accountId,
        issueKeys: candidates.map((c) => c.key),
        now: now()
      });

      for (const cand of candidates) {
        const recent = recentMap.get(cand.key);
        if (isWithinCooldown(recent, now())) {
          stats.skippedCooldown += 1;
          continue;
        }

        const score = scores.get(cand.key);
        const issueUrl = `https://jira/browse/${cand.key}`; // baseUrl injected client-side
        const appUrl = `#mf-improve?issueKey=${cand.key}`;
        const payload = { summary: cand.summary, issueUrl, appUrl };

        try {
          if (pref.bellEnabled) {
            const ok = await notifier(cand.key, cand.summary);
            await rowInserter({
              orgId, accountId, cloudId, issueKey: cand.key,
              score, channel: 'jira', payload
            });
            if (ok) stats.bellSent += 1;
          }
          if (pref.popupEnabled) {
            await rowInserter({
              orgId, accountId, cloudId, issueKey: cand.key,
              score, channel: 'desktop', payload
            });
            stats.desktopQueued += 1;
          }
        } catch (err) {
          stats.errors += 1;
          console.warn(`[DQNudge] Fan-out failed for ${accountId}/${cand.key}:`, err.message);
        }
      }
    }

    return { success: true, stats };
  } catch (err) {
    console.error('[DQNudge] Fatal error:', err.message);
    return { success: false, error: err.message, stats };
  } finally {
    await lockRelease();
  }
}

// Exposed for tests
export const _internals = {
  MAX_NUDGES_PER_USER,
  MAX_WARMUPS_PER_RUN,
  MIN_NUDGE_SCORE,
  COOLDOWN_MS,
  isWithinCooldown,
  getPreference,
  groupByAssignee
};
