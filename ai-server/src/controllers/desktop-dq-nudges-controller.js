'use strict';

/**
 * Desktop endpoint: Description Quality Nudges
 *
 * Used by the python-desktop-app to poll for pending notification rows on the
 * `desktop` channel and to acknowledge them after the popup is shown / acted on.
 *
 * Authentication: desktopAuthMiddleware (Supabase JWT OR Atlassian token).
 *
 * Jira users now prefer the live Atlassian OAuth token path for popup refresh:
 * every GET/trigger can fetch the caller's current in-progress Jira issues and
 * re-run description analysis in real time, rather than relying on cached issue
 * lists or cached description scores.
 */

const axios = require('axios');
const express = require('express');
const logger = require('../utils/logger');
const dqNotificationsRepo = require('../services/db/description-quality-notifications-repo');
const descriptionService = require('../services/description-service');
const { extractDescriptionText } = require('../utils/adfToText');
const { getUserById, getOrganizationById, getUserCachedIssues } = require('../services/db/user-db-service');
const { getClient } = require('../services/db/supabase-client');

const MAX_PENDING_NUDGES = 5;
const MAX_PENDING_SCAN = 50;
const MAX_MANUAL_TRIGGER_LIMIT = 20;
const MAX_TRIGGER_REFRESH_ISSUES = 20;
const MIN_NUDGE_SCORE = 80;
const MAX_ATTACHMENT_CONTEXT_ITEMS = 5;
const VALID_ACTIONS = new Set(['viewed', 'opened-in-jira', 'dismissed', 'snoozed']);
const LIVE_JQL = 'assignee = currentUser() AND resolution = EMPTY AND statusCategory = "In Progress" ORDER BY updated DESC';
const LIVE_FIELDS = ['summary', 'description', 'attachment', 'issuetype', 'project', 'status', 'updated'];

function formatBytes(bytes) {
  const size = Number(bytes);
  if (!Number.isFinite(size) || size <= 0) return 'size unknown';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function buildAttachmentContext(rawAttachments) {
  if (!Array.isArray(rawAttachments) || rawAttachments.length === 0) {
    return '';
  }

  const lines = rawAttachments
    .filter((att) => att && typeof att === 'object' && att.filename)
    .slice(0, MAX_ATTACHMENT_CONTEXT_ITEMS)
    .map((att) => {
      const mimeType = att.mimeType || 'unknown';
      return `- ${att.filename} (${mimeType}, ${formatBytes(att.size)})`;
    });

  if (lines.length === 0) return '';
  return `Attached files:\n${lines.join('\n')}`;
}

function normalizeIssueDescription(rawDescription) {
  if (rawDescription == null) return '';

  if (typeof rawDescription === 'object') {
    return extractDescriptionText(rawDescription) || '';
  }

  if (typeof rawDescription !== 'string') return '';

  const trimmed = rawDescription.trim();
  if (!trimmed) return '';

  // Cached rows may persist ADF as JSON text; parse opportunistically.
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed);
      const parsedText = extractDescriptionText(parsed);
      if (parsedText) return parsedText;
    } catch (_) {
      // Fallback to raw string below.
    }
  }

  return trimmed;
}

function normalizeScore(score) {
  const num = Number(score);
  if (!Number.isFinite(num)) return null;
  return Math.max(0, Math.min(100, Math.round(num)));
}

function buildIssueUrl(jiraBaseUrl, issueKey) {
  const base = jiraBaseUrl ? String(jiraBaseUrl).replace(/\/$/, '') : null;
  return base ? `${base}/browse/${issueKey}` : null;
}

function mapNudgeRow({ row, liveCandidate = null, jiraBaseUrl = null }) {
  const payload = row?.payload || {};
  const issueKey = liveCandidate?.issueKey || row.issue_key;
  return {
    id: row.id,
    issueKey,
    score: liveCandidate?.score ?? row.score_at_notify,
    summary: liveCandidate?.summary || payload.summary || null,
    issueUrl: liveCandidate?.issueUrl || payload.issueUrl || buildIssueUrl(jiraBaseUrl, issueKey),
    appUrl: payload.appUrl || null,
    notifiedAt: row.notified_at
  };
}

async function fetchLiveAssignedIssues({ atlassianToken, cloudId, limit = MAX_TRIGGER_REFRESH_ISSUES }) {
  if (!atlassianToken || !cloudId) return [];

  const url = `https://api.atlassian.com/ex/jira/${encodeURIComponent(cloudId)}/rest/api/3/search/jql`;
  const response = await axios.post(
    url,
    {
      jql: LIVE_JQL,
      maxResults: Math.max(1, Math.min(limit, MAX_TRIGGER_REFRESH_ISSUES)),
      fields: LIVE_FIELDS
    },
    {
      headers: {
        Authorization: `Bearer ${atlassianToken}`,
        Accept: 'application/json',
        'Content-Type': 'application/json'
      },
      timeout: 15000,
      maxContentLength: 5 * 1024 * 1024,
      maxBodyLength: 5 * 1024 * 1024
    }
  );

  return response?.data?.issues || [];
}

async function analyzeLiveIssues({ orgId, accountId, jiraBaseUrl, issues }) {
  const candidates = [];
  const rows = Array.isArray(issues) ? issues : [];

  for (const issue of rows) {
    const issueKey = issue?.key;
    if (!issueKey) continue;

    const fields = issue.fields || {};
    const description = normalizeIssueDescription(fields.description);
    const attachmentContext = buildAttachmentContext(fields.attachment);
    const analysisDescription = [description, attachmentContext].filter(Boolean).join('\n\n');

    const result = await descriptionService.analyzeDescription({
      issueKey,
      title: String(fields.summary || issueKey).trim(),
      description: analysisDescription,
      issueType: String(fields.issuetype?.name || 'Task').trim(),
      projectKey: String(fields.project?.key || issueKey.split('-')[0] || 'TASK').trim(),
      requestImprovement: false,
      orgId,
      accountId
    });

    const score = normalizeScore(result?.score);
    if (score === null) continue;

    candidates.push({
      issueKey,
      score,
      summary: String(fields.summary || '').trim() || null,
      issueUrl: buildIssueUrl(jiraBaseUrl, issueKey),
      appUrl: null
    });
  }

  candidates.sort((a, b) => a.score - b.score);
  return candidates;
}

async function syncLiveDesktopNudges({ caller, atlassianToken, limit = MAX_PENDING_NUDGES, force = false }) {
  await dqNotificationsRepo.ensurePreferenceRow({
    orgId: caller.orgId,
    accountId: caller.atlassianAccountId
  });

  const liveIssues = await fetchLiveAssignedIssues({
    atlassianToken,
    cloudId: caller.orgId,
    limit: MAX_TRIGGER_REFRESH_ISSUES
  });

  const pendingRows = await dqNotificationsRepo.listPendingDesktopNudges({
    orgId: caller.orgId,
    accountId: caller.atlassianAccountId,
    limit: MAX_PENDING_SCAN
  });

  const liveCandidates = await analyzeLiveIssues({
    orgId: caller.orgId,
    accountId: caller.atlassianAccountId,
    jiraBaseUrl: caller.jiraBaseUrl,
    issues: liveIssues
  });

  const lowScoreCandidates = liveCandidates.filter((candidate) => candidate.score < MIN_NUDGE_SCORE);
  const lowScoreKeySet = new Set(lowScoreCandidates.map((candidate) => candidate.issueKey));
  const pendingByIssue = new Map(
    pendingRows
      .filter((row) => row?.issue_key)
      .map((row) => [row.issue_key, row])
  );

  const staleResolvedIds = pendingRows
    .filter((row) => row?.issue_key && !lowScoreKeySet.has(row.issue_key))
    .map((row) => row.id);

  if (staleResolvedIds.length > 0) {
    await dqNotificationsRepo.acknowledgeNudges({
      orgId: caller.orgId,
      accountId: caller.atlassianAccountId,
      nudgeIds: staleResolvedIds,
      action: 'dismissed',
      snoozeUntil: null
    });
  }

  const nudges = [];
  let generated = 0;
  let skippedCooldown = 0;

  for (const candidate of lowScoreCandidates) {
    if (nudges.length >= limit) break;

    const existing = pendingByIssue.get(candidate.issueKey);
    if (existing) {
      nudges.push(mapNudgeRow({ row: existing, liveCandidate: candidate, jiraBaseUrl: caller.jiraBaseUrl }));
      continue;
    }

    if (!force) {
      const inCooldown = await dqNotificationsRepo.isWithinCooldown(
        caller.orgId,
        caller.atlassianAccountId,
        candidate.issueKey
      );
      if (inCooldown) {
        skippedCooldown += 1;
        continue;
      }
    }

    const inserted = await dqNotificationsRepo.insertNotification({
      orgId: caller.orgId,
      accountId: caller.atlassianAccountId,
      cloudId: caller.orgId,
      issueKey: candidate.issueKey,
      scoreAtNotify: candidate.score,
      channel: 'desktop',
      payload: {
        score: candidate.score,
        summary: candidate.summary,
        issueUrl: candidate.issueUrl,
        appUrl: candidate.appUrl,
        createdAt: new Date().toISOString()
      }
    });

    generated += 1;
    nudges.push(mapNudgeRow({ row: inserted, liveCandidate: candidate, jiraBaseUrl: caller.jiraBaseUrl }));
  }

  let reason = null;
  if (nudges.length === 0) {
    if (liveIssues.length === 0) {
      reason = 'no-live-issues';
    } else if (lowScoreCandidates.length === 0) {
      reason = 'no-low-scores';
    } else if (!force && skippedCooldown > 0) {
      reason = 'cooldown-filtered';
    } else {
      reason = 'limit-reached-or-invalid-candidates';
    }
  }

  return {
    nudges,
    generated,
    candidates: lowScoreCandidates.length,
    issueCount: liveIssues.length,
    force,
    skippedCooldown,
    reason
  };
}

async function refreshScoresForManualTrigger({ orgId, accountId, cachedIssues }) {
  const rows = Array.isArray(cachedIssues) ? cachedIssues : [];
  if (!orgId || rows.length === 0) return new Map();

  const freshScoreByIssue = new Map();
  let refreshCount = 0;

  for (const row of rows) {
    if (!row?.issue_key) continue;
    if (refreshCount >= MAX_TRIGGER_REFRESH_ISSUES) break;

    try {
      const title = String(row.issue_summary || row.summary || row.issue_key).trim();
      const description = normalizeIssueDescription(row.description);
      const attachmentContext = buildAttachmentContext(row.attachments || row.attachment || []);
      const analysisDescription = [description, attachmentContext].filter(Boolean).join('\n\n');
      const issueType = String(row.issue_type || 'Task').trim();
      const projectKey = String(row.project_key || row.issue_key.split('-')[0] || 'TASK').trim();

      const result = await descriptionService.analyzeDescription({
        issueKey: row.issue_key,
        title,
        description: analysisDescription,
        issueType,
        projectKey,
        requestImprovement: false,
        orgId,
        accountId
      });

      const score = normalizeScore(result?.score);
      if (score !== null) {
        freshScoreByIssue.set(row.issue_key, score);
        logger.debug('[DesktopDqNudges] Trigger refresh %s: %d', row.issue_key, score);
      }
      refreshCount += 1;
    } catch (err) {
      logger.warn('[DesktopDqNudges] Trigger refresh failed for %s: %s', row.issue_key, err.message);
    }
  }

  logger.info('[DesktopDqNudges] Trigger refresh completed: %d issues analyzed', refreshCount);
  return freshScoreByIssue;
}

/**
 * Resolve the calling user's (organizationId, atlassianAccountId, orgCloudId).
 * Works for both auth types set by desktopAuthMiddleware.
 */
async function resolveCaller(req) {
  const jwtAtlassianId = req.supabaseUser?.atlassian_account_id
    || req.supabaseUser?.user_metadata?.atlassian_account_id;
  if (jwtAtlassianId) {
    try {
      const supabase = getClient();
      if (supabase) {
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
    } catch (err) {
      logger.warn('[DesktopDqNudges] resolveCaller fast path failed: %s', err.message);
    }
  }

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

  if (req.atlassianUser?.account_id) {
    const accountId = req.atlassianUser.account_id;
    try {
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
    } catch (err) {
      logger.warn('[DesktopDqNudges] resolveCaller Atlassian path failed: %s', err.message);
      return null;
    }
  }

  return null;
}

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const caller = await resolveCaller(req);
    if (!caller || !caller.atlassianAccountId || !caller.orgId) {
      return res.status(404).json({ success: false, error: 'User profile not found' });
    }

    if (req.atlassianToken) {
      const live = await syncLiveDesktopNudges({
        caller,
        atlassianToken: req.atlassianToken,
        limit: MAX_PENDING_NUDGES,
        force: false
      });
      return res.json({ success: true, nudges: live.nudges });
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

      if (Number.isFinite(liveScore) && liveScore >= MIN_NUDGE_SCORE) {
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

router.post('/sync-recent-unassigned', async (req, res) => {
  try {
    const caller = await resolveCaller(req);
    if (!caller || !caller.atlassianAccountId || !caller.orgId) {
      return res.status(404).json({ success: false, error: 'User profile not found' });
    }

    const rawWindow = Number(req.body?.windowMinutes ?? 30);
    const windowMinutes = Number.isInteger(rawWindow)
      ? Math.max(1, Math.min(rawWindow, 60))
      : 30;
    const rawLimit = Number(req.body?.limit || MAX_PENDING_NUDGES);
    const limit = Number.isInteger(rawLimit)
      ? Math.max(1, Math.min(rawLimit, MAX_MANUAL_TRIGGER_LIMIT))
      : MAX_PENDING_NUDGES;
    const force = req.body?.force !== undefined ? Boolean(req.body.force) : false;

    const hasRecent = await dqNotificationsRepo.hasRecentUnassignedWork({
      userId: caller.userId,
      organizationId: caller.organizationId,
      windowMinutes
    });

    if (!hasRecent) {
      return res.json({
        success: true,
        generated: 0,
        nudges: [],
        reason: 'no-recent-unassigned',
        windowMinutes
      });
    }

    if (req.atlassianToken) {
      const live = await syncLiveDesktopNudges({
        caller,
        atlassianToken: req.atlassianToken,
        limit,
        force
      });
      return res.json({
        success: true,
        generated: live.generated,
        candidates: live.candidates,
        issueCount: live.issueCount,
        force: live.force,
        skippedCooldown: live.skippedCooldown,
        reason: live.reason,
        nudges: live.nudges,
        windowMinutes
      });
    }

    await dqNotificationsRepo.ensurePreferenceRow({
      orgId: caller.orgId,
      accountId: caller.atlassianAccountId
    });

    const cachedIssues = await getUserCachedIssues(caller.userId, caller.organizationId);
    const issueKeys = [...new Set((cachedIssues || []).map((r) => r.issue_key).filter(Boolean))];

    if (issueKeys.length === 0) {
      return res.json({
        success: true,
        generated: 0,
        nudges: [],
        reason: 'no-cached-issues',
        windowMinutes
      });
    }

    const freshScores = await refreshScoresForManualTrigger({
      orgId: caller.orgId,
      accountId: caller.atlassianAccountId,
      cachedIssues
    });

    const cachedScores = await dqNotificationsRepo.getIssueScoresFromCache({
      orgId: caller.orgId,
      issueKeys
    });

    const mergedScores = new Map(cachedScores);
    for (const [issueKey, score] of freshScores.entries()) {
      mergedScores.set(issueKey, score);
    }

    const scoreRows = [];
    for (const [issueKey, score] of mergedScores.entries()) {
      const numScore = Number(score);
      if (Number.isFinite(numScore) && numScore < MIN_NUDGE_SCORE) {
        scoreRows.push({ issue_key: issueKey, score: numScore });
      }
    }
    scoreRows.sort((a, b) => a.score - b.score);
    scoreRows.splice(limit * 3);

    const summaryByIssue = new Map(
      (cachedIssues || []).map((row) => [row.issue_key, row.issue_summary || row.summary || null])
    );

    let generated = 0;
    let skippedCooldown = 0;
    const nudges = [];

    for (const row of scoreRows) {
      if (nudges.length >= limit) break;

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

      const inserted = await dqNotificationsRepo.insertNotification({
        orgId: caller.orgId,
        accountId: caller.atlassianAccountId,
        cloudId: caller.orgId,
        issueKey,
        scoreAtNotify: score,
        channel: 'desktop',
        payload: {
          score,
          summary: summaryByIssue.get(issueKey) || null,
          issueUrl: buildIssueUrl(caller.jiraBaseUrl, issueKey),
          appUrl: null,
          createdAt: new Date().toISOString()
        }
      });

      generated += 1;
      nudges.push(mapNudgeRow({ row: inserted, jiraBaseUrl: caller.jiraBaseUrl }));
    }

    let reason = null;
    if (nudges.length === 0) {
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
      reason,
      nudges,
      windowMinutes
    });
  } catch (err) {
    logger.error('[DesktopDqNudges] POST /sync-recent-unassigned failed: %s', err.message);
    return res.status(500).json({ success: false, error: 'Failed to sync recent unassigned nudges' });
  }
});

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

    if (req.atlassianToken) {
      const live = await syncLiveDesktopNudges({
        caller,
        atlassianToken: req.atlassianToken,
        limit,
        force
      });

      return res.json({
        success: true,
        generated: live.generated,
        candidates: live.candidates,
        issueCount: live.issueCount,
        force: live.force,
        skippedCooldown: live.skippedCooldown,
        reason: live.reason
      });
    }

    await dqNotificationsRepo.ensurePreferenceRow({
      orgId: caller.orgId,
      accountId: caller.atlassianAccountId
    });

    const cachedIssues = await getUserCachedIssues(caller.userId, caller.organizationId);
    const issueKeys = [...new Set((cachedIssues || []).map((r) => r.issue_key).filter(Boolean))];

    if (issueKeys.length === 0) {
      return res.json({ success: true, generated: 0, candidates: 0, reason: 'no-cached-issues' });
    }

    const freshScores = await refreshScoresForManualTrigger({
      orgId: caller.orgId,
      accountId: caller.atlassianAccountId,
      cachedIssues
    });

    const cachedScores = await dqNotificationsRepo.getIssueScoresFromCache({
      orgId: caller.orgId,
      issueKeys
    });

    const mergedScores = new Map(cachedScores);
    for (const [issueKey, score] of freshScores.entries()) {
      mergedScores.set(issueKey, score);
    }

    logger.debug('[DesktopDqNudges] Trigger scores: cached=%d, fresh=%d, merged=%d',
      cachedScores.size, freshScores.size, mergedScores.size);

    const scoreRows = [];
    for (const [issueKey, score] of mergedScores.entries()) {
      const numScore = Number(score);
      if (Number.isFinite(numScore) && numScore < MIN_NUDGE_SCORE) {
        scoreRows.push({ issue_key: issueKey, score: numScore });
      }
    }
    scoreRows.sort((a, b) => a.score - b.score);
    scoreRows.splice(limit * 3);

    logger.debug('[DesktopDqNudges] Trigger filtered candidates: %d < %d', scoreRows.length, MIN_NUDGE_SCORE);

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
          issueUrl: buildIssueUrl(caller.jiraBaseUrl, issueKey),
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
module.exports._resolveCaller = resolveCaller;
