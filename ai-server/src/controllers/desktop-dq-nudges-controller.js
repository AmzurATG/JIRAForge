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
const { getUserById, getOrganizationById, getUserAtlassianAccountId } = require('../services/db/user-db-service');
const { getClient } = require('../services/db/supabase-client');

const MAX_PENDING_NUDGES = 5;
const VALID_ACTIONS = new Set(['viewed', 'opened-in-jira', 'dismissed', 'snoozed']);

/**
 * Resolve the calling user's (organizationId, atlassianAccountId, orgCloudId).
 * Works for both auth types set by desktopAuthMiddleware.
 */
async function resolveCaller(req) {
  // Path 1: Supabase JWT — `sub` is the public.users.id
  if (req.supabaseUser?.sub) {
    const user = await getUserById(req.supabaseUser.sub);
    if (!user) return null;
    const org = await getOrganizationById(user.organization_id);
    return {
      userId: user.id,
      organizationId: user.organization_id,
      atlassianAccountId: user.atlassian_account_id,
      orgId: org?.jira_cloud_id || user.organization_id
    };
  }

  // Path 2: Atlassian token — req.atlassianUser.account_id is the atlassian acct id
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
      orgId: org?.jira_cloud_id || user.organization_id
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

    const nudges = rows.map((row) => {
      const payload = row.payload || {};
      return {
        id: row.id,
        issueKey: row.issue_key,
        score: row.score_at_notify,
        summary: payload.summary || null,
        issueUrl: payload.issueUrl || null,
        appUrl: payload.appUrl || null,
        notifiedAt: row.notified_at
      };
    });

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

module.exports = router;
// Exposed for unit-test injection only.
module.exports._resolveCaller = resolveCaller;
