/**
 * Description Quality Nudge Scheduler
 * Enhancement #13 — see plan: docs/jira_ticket_description_enhancement/13_SCHEDULED_QUALITY_NOTIFICATIONS.md
 *
 * Runs on frequent scheduled triggers with a 30-minute cadence gate.
 *
 * Algorithm (per tenant invocation):
 *   1. Acquire a 60s KVS lock to prevent overlapping runs.
 *   2. JQL: `assignee is not EMPTY AND statusCategory = "In Progress" AND updated >= -30d`
 *      via api.asApp() — returns recent open issues with an assignee.
 *   3. Group results by assignee accountId.
 *   4. For each (assignee, issue):
 *        - Refresh score by calling the AI server `/api/forge/description/analyze`
 *          and fall back to cache if refresh fails.
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
import { supabaseQuery, remoteRequest } from '../utils/remote.js';

const LOCK_KEY = 'scheduler-lock/dq-nudge';
const LOCK_TTL_MS = 60 * 1000; // 60 seconds
const LAST_RUN_KEY = 'scheduler-last-run/dq-nudge';
const RUN_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes

const MAX_NUDGES_PER_USER = 5;
const MIN_NUDGE_SCORE = 80;
const COOLDOWN_MS = 24 * 60 * 60 * 1000;
const RECENT_DAYS_JQL = 30;
const MAX_JQL_RESULTS = 100;

const JQL_OPEN_RECENT = `assignee is not EMPTY AND statusCategory = "In Progress" AND updated >= -${RECENT_DAYS_JQL}d ORDER BY updated DESC`;

function extractUuidFromString(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i);
  return m ? m[0] : null;
}

function resolveCloudId(context = {}, event = {}) {
  const direct = context.cloudId || event.cloudId || event?.context?.cloudId;
  if (direct) return direct;

  const nestedCandidates = [
    context?.extension?.cloudId,
    context?.installation?.cloudId,
    event?.installation?.cloudId
  ];
  for (const candidate of nestedCandidates) {
    if (candidate) return candidate;
  }

  const installationContexts = context?.installation?.contexts || event?.installation?.contexts || [];
  for (const ctx of installationContexts) {
    if (!ctx) continue;
    if (ctx.cloudId) return ctx.cloudId;
    const fromResource = extractUuidFromString(ctx.resourceId || ctx.ari || '');
    if (fromResource) return fromResource;
  }

  // Last-resort parsing from known string fields seen in Forge contexts.
  const stringCandidates = [
    context.localId,
    context.moduleKey,
    context?.installationId,
    event?.contextToken,
    event?.contextAri
  ];
  for (const s of stringCandidates) {
    const parsed = extractUuidFromString(s);
    if (parsed) return parsed;
  }

  return null;
}

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

async function shouldRunForCadence(nowMs = Date.now()) {
  try {
    const row = await kvs.get(LAST_RUN_KEY);
    const lastRunAt = Number(row?.lastRunAt || 0);
    if (lastRunAt > 0 && (nowMs - lastRunAt) < RUN_INTERVAL_MS) {
      return false;
    }
    return true;
  } catch (err) {
    console.warn('[DQNudge] Cadence read failed; proceeding:', err.message);
    return true;
  }
}

async function markRunForCadence(nowMs = Date.now()) {
  try {
    await kvs.set(LAST_RUN_KEY, { lastRunAt: nowMs });
  } catch (err) {
    console.warn('[DQNudge] Cadence write failed:', err.message);
  }
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
// Jira base URL (for notification payload URLs)
// ---------------------------------------------------------------------------
async function fetchJiraBaseUrl() {
  try {
    const resp = await api.asApp().requestJira(
      route`/rest/api/3/serverInfo`,
      { method: 'GET', headers: { Accept: 'application/json' } }
    );
    if (!resp.ok) return null;
    const info = await resp.json();
    return info.baseUrl || null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Warm-up analyzer — fetches issue and calls the AI server analyze endpoint.
// ---------------------------------------------------------------------------
export async function analyzeIssue(issueKey) {
  try {
    const issueResp = await api.asApp().requestJira(
      route`/rest/api/3/issue/${issueKey}`,
      { method: 'GET', headers: { Accept: 'application/json' } }
    );
    if (!issueResp.ok) return null;
    const issue = await issueResp.json();
    const data = await remoteRequest('/api/forge/description/analyze', {
      method: 'POST',
      body: {
        issueKey,
        title: issue.fields?.summary || '',
        description: issue.fields?.description || null,
        issueType: issue.fields?.issuetype?.name || 'Task',
        projectKey: issue.fields?.project?.key || issueKey.split('-')[0]
      }
    });
    const result = data || {};
    return typeof result.score === 'number' ? result : null;
  } catch (err) {
    console.warn(`[DQNudge] analyzeIssue failed for ${issueKey}:`, err.message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Cache score lookup + warm-up
// ---------------------------------------------------------------------------
async function loadCachedScores(orgId, issueKeys) {
  if (issueKeys.length === 0) return new Map();
  const data = await supabaseQuery('description_quality_cache', {
    method: 'GET',
    query: {
      eq: { org_id: orgId },
      in: { issue_key: issueKeys },
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
 * Re-analyze all in-progress issues for near-real-time scoring.
 */
async function refreshScoresForIssues({ issues, analyzer }) {
  const newScores = new Map();
  for (const issue of issues) {
    try {
      const result = await analyzer(issue.key);
      if (result && typeof result.score === 'number') {
        newScores.set(issue.key, result.score);
      }
    } catch (err) {
      console.warn(`[DQNudge] Re-analysis failed for ${issue.key}:`, err.message);
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
      eq: { org_id: orgId, account_id: accountId },
      in: { issue_key: issueKeys },
      gte: { notified_at: sinceIso },
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
      eq: { org_id: orgId },
      in: { account_id: accountIds },
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
 * @param {Object} [deps.event] — Forge scheduled trigger event payload
 * @param {Object} [deps.context] — Forge invocation context
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
    event = {},
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

  const cloudId = resolveCloudId(context, event);
  if (!cloudId) {
    console.warn('[DQNudge] No cloudId resolved from context/event — aborting scheduler run.');
    return { success: false, error: 'missing cloudId' };
  }

  const jiraBaseUrl = await fetchJiraBaseUrl();
  const acquired = await lockAcquire(now());
  if (!acquired) {
    console.log('[DQNudge] Lock held — skipping this run.');
    return { success: true, skipped: 'lock-held' };
  }

  const nowMs = now();
  const cadenceAllowed = await shouldRunForCadence(nowMs);
  if (!cadenceAllowed) {
    await lockRelease();
    return { success: true, skipped: 'cadence-throttled' };
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
      await markRunForCadence(nowMs);
      return { success: true, stats };
    }

    const byUser = groupByAssignee(issues);
    if (byUser.size === 0) {
      await markRunForCadence(nowMs);
      return { success: true, stats };
    }

    // Load preferences for all assignees in one shot.
    const accountIds = Array.from(byUser.keys());
    const prefsMap = await prefsLoader(orgId, accountIds);

    // Load cached scores for ALL issue keys in one query.
    const allKeys = issues.map((i) => i.key);
    const scores = await cacheLoader(orgId, allKeys);

    // Refresh score pass — analyze all issues for real-time consistency.
    if (analyzer) {
      const refreshed = await refreshScoresForIssues({
        issues,
        analyzer,
      });
      for (const [k, v] of refreshed.entries()) scores.set(k, v);
      stats.warmedUp = refreshed.size;
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
        const issueUrl = jiraBaseUrl
          ? `${jiraBaseUrl}/browse/${cand.key}`
          : `https://atlassian.net/browse/${cand.key}`;
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

    await markRunForCadence(nowMs);
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
  MIN_NUDGE_SCORE,
  RUN_INTERVAL_MS,
  COOLDOWN_MS,
  isWithinCooldown,
  getPreference,
  groupByAssignee
};
