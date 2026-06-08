'use strict';

/**
 * Desktop endpoint: Description Quality Nudges
 *
 * Used by the python-desktop-app to poll for pending notification rows on the
 * `desktop` channel and to acknowledge them after the popup is shown / acted on.
 *
 * Authentication: desktopAuthMiddleware (Supabase JWT OR Atlassian token).
 *
 * Endpoints:
 *   GET  /api/desktop/description-quality-nudges
 *     → { success: true, nudges: [{ id, issueKey, score, summary, issueUrl, appUrl, notifiedAt }] }
 *   POST /api/desktop/description-quality-nudges/ack
 *     body: { nudgeIds: number[], action: 'viewed'|'opened-in-jira'|'dismissed'|'snoozed', snoozeUntil?: ISO8601 }
 *     → { success: true, acknowledged: <count> }
 */

const express = require('express');
const logger = require('../utils/logger');
const dqNotificationsRepo = require('../services/db/description-quality-notifications-repo');
const descriptionService = require('../services/description-service');
const { getUserById, getOrganizationById, getUserCachedIssues } = require('../services/db/user-db-service');
const { getClient } = require('../services/db/supabase-client');

const MAX_PENDING_NUDGES = 5;
const MAX_MANUAL_TRIGGER_LIMIT = 20;
const MAX_TRIGGER_REFRESH_ISSUES = 20;
const VALID_ACTIONS = new Set(['viewed', 'opened-in-jira', 'dismissed', 'snoozed']);

async function refreshScoresForManualTrigger({ orgId, accountId, cachedIssues }) {
  const rows = Array.isArray(cachedIssues) ? cachedIssues : [];
  if (!orgId || rows.length === 0) return;

  const byIssue = new Map();
  for (const row of rows) {
    if (!row?.issue_key || byIssue.has(row.issue_key)) continue;
    byIssue.set(row.issue_key, row);
    if (byIssue.size >= MAX_TRIGGER_REFRESH_ISSUES) break;
  }
  if (byIssue.size === 0) return;

  const freshScoreByIssue = new Map();
  for (const [issueKey, row] of byIssue.entries()) {
    const title = row.issue_summary || row.summary || issueKey;
    const description = typeof row.description === 'string' ? row.description : '';
    const issueType = row.issue_type || row.issueType || 'Task';
    const projectKey = row.project_key || (String(issueKey).split('-')[0] || 'TASK');

    try {
      const result = await descriptionService.analyzeDescription({
        issueKey,
        title,
        description,
        issueType,
        projectKey,
        requestImprovement: false,
        orgId,
        accountId
      });
      const score = Number(result?.score);
      if (Number.isFinite(score)) {
        freshScoreByIssue.set(issueKey, Math.max(0, Math.min(100, Math.round(score))));
      }
    } catch (err) {
      logger.warn('[DesktopDqNudges] Trigger refresh failed for %s: %s', issueKey, err.message);
    }
  }

  if (freshScoreByIssue.size === 0) return;

  const supabase = getClient();
  if (!supabase || typeof supabase.from !== 'function') return;

  const updatedAt = new Date().toISOString();
  for (const [issueKey, score] of freshScoreByIssue.entries()) {
    const { error } = await supabase
      .from('description_quality_cache')
      .update({ score, updated_at: updatedAt })
      .eq('org_id', orgId)
      .eq('issue_key', issueKey);
    if (error) {
      logger.warn('[DesktopDqNudges] Trigger cache update failed for %s: %s', issueKey, error.message);
    }
  }
}

/**
 * Resolve the calling user's (organizationId, atlassianAccountId, orgCloudId).
 * Works for both auth types set by desktopAuthMiddleware.
 */
async function resolveCaller(req) {
  // Fast path: our exchange-token JWT carries `atlassian_account_id` as a
  // top-level claim — look up by Atlassian ID to avoid sub-UUID ambiguity.
  const jwtAtlassianId = req.supabaseUser?.atlassian_account_id
    || req.supabaseUser?.user_metadata?.atlassian_account_id;
  if (jwtAtlassianId) {
    const supabase = getClient();
    if (!supabase) return null;
    const { data: user, error } = await supabase
      .from('users')
      .select('id, organization_id, atlassian_account_id')
      .eq('atlassian_account_id', jwtAtlassianId)
      .maybeSingle();
    if (!error && user) {
      const org = await getOrganizationById(user.organization_id);
      return {
        userId: user.id,
        organizationId: user.organization_id,
        atlassianAccountId: user.atlassian_account_id,
        orgId: org?.jira_cloud_id || user.organization_id,
        jiraBaseUrl: org?.jira_instance_url || null
      };
    }
  }

  // Slow path: sub-based lookup (fallback for tokens without atlassian_account_id claim)
  if (req.supabaseUser?.sub) {
    const user = await getUserById(req.supabaseUser.sub);
    if (!user) return null;
    const org = await getOrganizationById(user.organization_id);
    return {
      userId: user.id,
      organizationId: user.organization_id,
      atlassianAccountId: user.atlassian_account_id,
      orgId: org?.jira_cloud_id || user.organization_id,
      jiraBaseUrl: org?.jira_instance_url || null
    };
  }

  // Path 3: Atlassian token — req.atlassianUser.account_id is the atlassian acct id
  if (req.atlassianUser?.account_id) {
    const accountId = req.atlassianUser.account_id;
    const supabase = getClient();
    if (!supabase) return null;
    const { data: user, error } = await supabase
      .from('users')
      .select('id, organization_id, atlassian_account_id')
      .eq('atlassian_account_id', accountId)
      .maybeSingle();
    if (error || !user) return null;
    const org = await getOrganizationById(user.organization_id);
    return {
      userId: user.id,
      organizationId: user.organization_id,
      atlassianAccountId: user.atlassian_account_id,
      orgId: org?.jira_cloud_id || user.organization_id,
      jiraBaseUrl: org?.jira_instance_url || null
    };
  }

  return null;
}

const router = express.Router();

// ---------------------------------------------------------------------------
// GET / — list pending desktop nudges for the caller.
// ---------------------------------------------------------------------------
router.get('/', async (req, res) => {
  try {
    const caller = await resolveCaller(req);
    if (!caller || !caller.atlassianAccountId || !caller.orgId) {
      return res.status(404).json({ success: false, error: 'User profile not found' });
    }

    const rows = await dqNotificationsRepo.listPendingDesktopNudges({
      orgId: caller.orgId,
      accountId: caller.atlassianAccountId,
      limit: MAX_PENDING_NUDGES
    });

    const issueKeys = [...new Set(rows.map((row) => row.issue_key).filter(Boolean))];
    const liveScores = await dqNotificationsRepo.getIssueScoresFromCache({
      orgId: caller.orgId,
      issueKeys
    });

    const staleResolvedIds = [];
    const nudges = [];

    for (const row of rows) {
      const payload = row.payload || {};
      const liveScore = liveScores.has(row.issue_key)
        ? Number(liveScores.get(row.issue_key))
        : Number(row.score_at_notify);

      // Do not surface stale rows that are no longer below threshold.
      if (Number.isFinite(liveScore) && liveScore >= 80) {
        staleResolvedIds.push(row.id);
        continue;
      }

      nudges.push({
        id: row.id,
        issueKey: row.issue_key,
        score: Number.isFinite(liveScore) ? liveScore : row.score_at_notify,
        summary: payload.summary || null,
        issueUrl: payload.issueUrl || null,
        appUrl: payload.appUrl || null,
        notifiedAt: row.notified_at
      });
    }

    if (staleResolvedIds.length > 0) {
      await dqNotificationsRepo.acknowledgeNudges({
        orgId: caller.orgId,
        accountId: caller.atlassianAccountId,
        nudgeIds: staleResolvedIds,
        action: 'dismissed',
        snoozeUntil: null
      });
    }

    return res.json({ success: true, nudges });
  } catch (err) {
    logger.error('[DesktopDqNudges] GET / failed: %s', err.message);
    return res.status(500).json({ success: false, error: 'Failed to fetch nudges' });
  }
});

// ---------------------------------------------------------------------------
// POST /ack — acknowledge one or more nudges.
// ---------------------------------------------------------------------------
router.post('/ack', async (req, res) => {
  try {
    const { nudgeIds, action, snoozeUntil } = req.body || {};

    if (!Array.isArray(nudgeIds) || nudgeIds.length === 0 || nudgeIds.length > 50) {
      return res.status(400).json({ success: false, error: 'nudgeIds must be a 1..50 element array' });
    }
    if (!nudgeIds.every((id) => Number.isInteger(id) && id > 0)) {
      return res.status(400).json({ success: false, error: 'nudgeIds must contain positive integers' });
    }
    if (!VALID_ACTIONS.has(action)) {
      return res.status(400).json({ success: false, error: 'Invalid action' });
    }
    if (action === 'snoozed') {
      if (!snoozeUntil || typeof snoozeUntil !== 'string') {
        return res.status(400).json({ success: false, error: 'snoozeUntil (ISO 8601) required when action is "snoozed"' });
      }
      const parsed = Date.parse(snoozeUntil);
      if (Number.isNaN(parsed) || parsed <= Date.now()) {
        return res.status(400).json({ success: false, error: 'snoozeUntil must be a future ISO 8601 timestamp' });
      }
    }

    const caller = await resolveCaller(req);
    if (!caller || !caller.atlassianAccountId || !caller.orgId) {
      return res.status(404).json({ success: false, error: 'User profile not found' });
    }

    const count = await dqNotificationsRepo.acknowledgeNudges({
      orgId: caller.orgId,
      accountId: caller.atlassianAccountId,
      nudgeIds,
      action,
      snoozeUntil: action === 'snoozed' ? snoozeUntil : null
    });

    return res.json({ success: true, acknowledged: count });
  } catch (err) {
    logger.error('[DesktopDqNudges] POST /ack failed: %s', err.message);
    return res.status(500).json({ success: false, error: 'Failed to acknowledge nudges' });
  }
});

// ---------------------------------------------------------------------------
// POST /trigger — manual test helper: generate desktop nudge rows now.
// ---------------------------------------------------------------------------
router.post('/trigger', async (req, res) => {
  try {
    const caller = await resolveCaller(req);
    if (!caller || !caller.atlassianAccountId || !caller.orgId) {
      return res.status(404).json({ success: false, error: 'User profile not found' });
    }

    const rawLimit = Number(req.body?.limit || MAX_PENDING_NUDGES);
    const limit = Number.isInteger(rawLimit)
      ? Math.max(1, Math.min(rawLimit, MAX_MANUAL_TRIGGER_LIMIT))
      : MAX_PENDING_NUDGES;
    const force = req.body?.force !== undefined ? Boolean(req.body.force) : true;

    await dqNotificationsRepo.ensurePreferenceRow({
      orgId: caller.orgId,
      accountId: caller.atlassianAccountId
    });

    const cachedIssues = await getUserCachedIssues(caller.userId, caller.organizationId);
    const issueKeys = [...new Set((cachedIssues || []).map((r) => r.issue_key).filter(Boolean))];

    if (issueKeys.length === 0) {
      return res.json({ success: true, generated: 0, candidates: 0, reason: 'no-cached-issues' });
    }

    await refreshScoresForManualTrigger({
      orgId: caller.orgId,
      accountId: caller.atlassianAccountId,
      cachedIssues
    });

    const scoreRows = await dqNotificationsRepo.listLowScoreCandidates({
      orgId: caller.orgId,
      issueKeys,
      maxScore: 79,
      limit: limit * 3
    });

    const summaryByIssue = new Map(
      (cachedIssues || []).map((row) => [row.issue_key, row.issue_summary || row.summary || null])
    );

    let generated = 0;
    let skippedCooldown = 0;
    for (const row of scoreRows) {
      if (generated >= limit) break;

      const issueKey = row.issue_key;
      const score = Number(row.score);
      if (!issueKey || Number.isNaN(score)) continue;

      if (!force) {
        const inCooldown = await dqNotificationsRepo.isWithinCooldown(
          caller.orgId,
          caller.atlassianAccountId,
          issueKey
        );
        if (inCooldown) {
          skippedCooldown += 1;
          continue;
        }
      }

      const baseUrl = caller.jiraBaseUrl ? String(caller.jiraBaseUrl).replace(/\/$/, '') : null;
      await dqNotificationsRepo.insertNotification({
        orgId: caller.orgId,
        accountId: caller.atlassianAccountId,
        cloudId: caller.orgId,
        issueKey,
        scoreAtNotify: score,
        channel: 'desktop',
        payload: {
          score,
          summary: summaryByIssue.get(issueKey) || null,
          issueUrl: baseUrl ? `${baseUrl}/browse/${issueKey}` : null,
          appUrl: null,
          createdAt: new Date().toISOString()
        }
      });

      generated += 1;
    }

    let reason = null;
    if (generated === 0) {
      if (scoreRows.length === 0) {
        reason = 'no-low-scores';
      } else if (!force && skippedCooldown > 0) {
        reason = 'cooldown-filtered';
      } else {
        reason = 'limit-reached-or-invalid-candidates';
      }
    }

    return res.json({
      success: true,
      generated,
      candidates: scoreRows.length,
      issueCount: issueKeys.length,
      force,
      skippedCooldown,
      reason
    });
  } catch (err) {
    logger.error('[DesktopDqNudges] POST /trigger failed: %s', err.message);
    return res.status(500).json({ success: false, error: 'Failed to trigger nudges' });
  }
});

module.exports = router;
// Exposed for unit-test injection only.
module.exports._resolveCaller = resolveCaller;
