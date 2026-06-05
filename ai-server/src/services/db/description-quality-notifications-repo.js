'use strict';

/**
 * Description Quality Notifications Repository
 *
 * CRUD + dedupe helpers for the `description_quality_notifications` table,
 * which powers the Enhancement #13 scheduled nudge feature.
 *
 * Used by:
 *   - forge-app scheduler (`descriptionQualityNudge`) — via forge-proxy /
 *     direct insert from server when called through the AI server.
 *   - ai-server desktop endpoints — desktop app polls pending desktop-channel
 *     rows and posts acknowledgements.
 *
 * Privacy guardrail: callers MUST pass `payload` objects that contain only
 * `summary`, `score`, `issueUrl`, `appUrl`. The repo enforces a strict
 * allow-list before persisting and strips anything else (no description text
 * ever lands in the DB).
 */

const { getClient } = require('./supabase-client');
const logger = require('../../utils/logger');

const TABLE = 'description_quality_notifications';
const VALID_CHANNELS = new Set(['jira', 'desktop', 'email']);
const VALID_ACK_ACTIONS = new Set(['viewed', 'opened-in-jira', 'dismissed', 'snoozed']);

// Strict allow-list of payload keys — guarantees no ticket description content
// ever lands in the row payload (privacy requirement §11 of the plan).
const ALLOWED_PAYLOAD_KEYS = new Set(['summary', 'score', 'issueUrl', 'appUrl', 'createdAt']);

const DEFAULT_COOLDOWN_HOURS = 24;

function sanitisePayload(rawPayload) {
  if (!rawPayload || typeof rawPayload !== 'object') return null;
  const out = {};
  for (const key of Object.keys(rawPayload)) {
    if (ALLOWED_PAYLOAD_KEYS.has(key)) out[key] = rawPayload[key];
  }
  return out;
}

function assertChannel(channel) {
  if (!VALID_CHANNELS.has(channel)) {
    throw new Error(`Invalid channel: ${channel}`);
  }
}

/**
 * Insert a notification row.
 * @returns {Promise<Object>} The inserted row.
 */
async function insertNotification({
  orgId,
  accountId,
  cloudId,
  issueKey,
  scoreAtNotify,
  channel,
  payload = null
}) {
  if (!orgId || !accountId || !cloudId || !issueKey || channel === undefined) {
    throw new Error('insertNotification requires orgId, accountId, cloudId, issueKey, channel');
  }
  assertChannel(channel);
  if (typeof scoreAtNotify !== 'number' || scoreAtNotify < 0 || scoreAtNotify > 100) {
    throw new Error('scoreAtNotify must be a number 0-100');
  }

  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialised');

  const safePayload = sanitisePayload(payload);

  const { data, error } = await supabase
    .from(TABLE)
    .insert({
      org_id: orgId,
      account_id: accountId,
      cloud_id: cloudId,
      issue_key: issueKey,
      score_at_notify: scoreAtNotify,
      channel,
      payload: safePayload
    })
    .select()
    .single();

  if (error) {
    logger.error('[DQNotificationsRepo] insert failed: %s', error.message);
    throw error;
  }
  return data;
}

/**
 * Look up the most-recent notification for a (user, issue) across ALL channels.
 * Used by the scheduler to enforce cross-channel cooldown.
 * @returns {Promise<Object|null>}
 */
async function lookupLatestAnyChannel(orgId, accountId, issueKey) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialised');

  const { data, error } = await supabase
    .from(TABLE)
    .select('id, channel, notified_at, snooze_until, acknowledged_at, ack_action')
    .eq('org_id', orgId)
    .eq('account_id', accountId)
    .eq('issue_key', issueKey)
    .order('notified_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.error('[DQNotificationsRepo] lookupLatest failed: %s', error.message);
    throw error;
  }
  return data || null;
}

/**
 * Returns true if a notification for this (user, issue) was sent within the
 * cooldown window OR is still under an active snooze.
 *
 * @param {string} orgId
 * @param {string} accountId
 * @param {string} issueKey
 * @param {Object} [opts]
 * @param {number} [opts.cooldownHours] — default 24
 * @param {Date}   [opts.now] — injected for tests
 */
async function isWithinCooldown(orgId, accountId, issueKey, opts = {}) {
  const cooldownHours = opts.cooldownHours || DEFAULT_COOLDOWN_HOURS;
  const now = opts.now || new Date();

  const last = await lookupLatestAnyChannel(orgId, accountId, issueKey);
  if (!last) return false;

  // Active snooze on the latest row takes precedence.
  if (last.snooze_until) {
    const snoozeEnd = new Date(last.snooze_until);
    if (snoozeEnd > now) return true;
  }

  if (last.notified_at) {
    const last_at = new Date(last.notified_at);
    const elapsedMs = now - last_at;
    if (elapsedMs < cooldownHours * 3600 * 1000) return true;
  }
  return false;
}

/**
 * Pending desktop nudges for a given account in a given org.
 * Used by GET /api/desktop/description-quality-nudges.
 *
 * @param {Object} args
 * @param {string} args.orgId
 * @param {string} args.accountId
 * @param {number} [args.limit] — default 5
 * @returns {Promise<Array<Object>>}
 */
async function listPendingDesktopNudges({ orgId, accountId, limit = 5 }) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialised');

  const { data, error } = await supabase
    .from(TABLE)
    .select('id, issue_key, score_at_notify, payload, notified_at')
    .eq('org_id', orgId)
    .eq('account_id', accountId)
    .eq('channel', 'desktop')
    .is('acknowledged_at', null)
    .order('notified_at', { ascending: true })
    .limit(limit);

  if (error) {
    logger.error('[DQNotificationsRepo] listPendingDesktopNudges failed: %s', error.message);
    throw error;
  }
  return data || [];
}

/**
 * Acknowledge one or more nudge rows.
 *
 * @param {Object} args
 * @param {string} args.orgId — caller's org, must match row org for safety
 * @param {string} args.accountId — caller's account, must match row account
 * @param {Array<number>} args.nudgeIds
 * @param {string} args.action
 * @param {string} [args.snoozeUntil] — ISO timestamp, required when action === 'snoozed'
 * @returns {Promise<number>} number of rows acknowledged
 */
async function acknowledgeNudges({ orgId, accountId, nudgeIds, action, snoozeUntil = null }) {
  if (!Array.isArray(nudgeIds) || nudgeIds.length === 0) {
    throw new Error('nudgeIds is required and must be non-empty');
  }
  if (!VALID_ACK_ACTIONS.has(action)) {
    throw new Error(`Invalid action: ${action}`);
  }
  if (action === 'snoozed' && !snoozeUntil) {
    throw new Error('snoozeUntil is required when action is "snoozed"');
  }

  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialised');

  const update = {
    acknowledged_at: new Date().toISOString(),
    ack_action: action
  };
  if (snoozeUntil) update.snooze_until = snoozeUntil;

  const { data, error } = await supabase
    .from(TABLE)
    .update(update)
    .in('id', nudgeIds)
    .eq('org_id', orgId)
    .eq('account_id', accountId)
    .select('id');

  if (error) {
    logger.error('[DQNotificationsRepo] acknowledgeNudges failed: %s', error.message);
    throw error;
  }
  return (data || []).length;
}

module.exports = {
  insertNotification,
  lookupLatestAnyChannel,
  isWithinCooldown,
  listPendingDesktopNudges,
  acknowledgeNudges,
  // Exposed for tests:
  _sanitisePayload: sanitisePayload,
  _ALLOWED_PAYLOAD_KEYS: ALLOWED_PAYLOAD_KEYS,
  _DEFAULT_COOLDOWN_HOURS: DEFAULT_COOLDOWN_HOURS
};
