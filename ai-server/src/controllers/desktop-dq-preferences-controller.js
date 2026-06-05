'use strict';

/**
 * Desktop endpoint: Description Quality Nudge Preferences
 *
 * Lets the desktop app read / write the user's per-channel opt-in flags.
 * Storage table: description_quality_nudge_preferences (added in
 * supabase/migrations/20260605_description_quality_notifications.sql).
 *
 * Endpoints:
 *   GET  /api/desktop/preferences/dq-nudges
 *     → { success: true, preferences: { bellEnabled: bool, popupEnabled: bool } }
 *   PUT  /api/desktop/preferences/dq-nudges
 *     body: { bellEnabled?: bool, popupEnabled?: bool }
 *     → { success: true, preferences: { bellEnabled, popupEnabled } }
 *
 * Defaults (when no row exists) — both true (opt-in).
 */

const express = require('express');
const logger = require('../utils/logger');
const { getClient } = require('../services/db/supabase-client');
const { getUserById, getOrganizationById } = require('../services/db/user-db-service');

const TABLE = 'description_quality_nudge_preferences';

async function resolveCaller(req) {
  if (req.supabaseUser?.sub) {
    const user = await getUserById(req.supabaseUser.sub);
    if (!user) return null;
    const org = await getOrganizationById(user.organization_id);
    return {
      atlassianAccountId: user.atlassian_account_id,
      orgId: org?.jira_cloud_id || user.organization_id
    };
  }
  if (req.atlassianUser?.account_id) {
    const supabase = getClient();
    if (!supabase) return null;
    const { data: user, error } = await supabase
      .from('users')
      .select('id, organization_id, atlassian_account_id')
      .eq('atlassian_account_id', req.atlassianUser.account_id)
      .maybeSingle();
    if (error || !user) return null;
    const org = await getOrganizationById(user.organization_id);
    return {
      atlassianAccountId: user.atlassian_account_id,
      orgId: org?.jira_cloud_id || user.organization_id
    };
  }
  return null;
}

const router = express.Router();

const DEFAULTS = { bellEnabled: true, popupEnabled: true };

router.get('/', async (req, res) => {
  try {
    const caller = await resolveCaller(req);
    if (!caller || !caller.atlassianAccountId || !caller.orgId) {
      return res.status(404).json({ success: false, error: 'User profile not found' });
    }

    const supabase = getClient();
    const { data, error } = await supabase
      .from(TABLE)
      .select('bell_enabled, popup_enabled')
      .eq('account_id', caller.atlassianAccountId)
      .eq('org_id', caller.orgId)
      .maybeSingle();

    if (error) {
      logger.error('[DesktopDqPreferences] GET failed: %s', error.message);
      return res.status(500).json({ success: false, error: 'Failed to load preferences' });
    }

    const preferences = data
      ? { bellEnabled: data.bell_enabled, popupEnabled: data.popup_enabled }
      : { ...DEFAULTS };

    return res.json({ success: true, preferences });
  } catch (err) {
    logger.error('[DesktopDqPreferences] GET threw: %s', err.message);
    return res.status(500).json({ success: false, error: 'Failed to load preferences' });
  }
});

router.put('/', async (req, res) => {
  try {
    const { bellEnabled, popupEnabled } = req.body || {};

    // Validation — both fields optional, but at least one required.
    if (bellEnabled === undefined && popupEnabled === undefined) {
      return res.status(400).json({ success: false, error: 'At least one of bellEnabled or popupEnabled is required' });
    }
    if (bellEnabled !== undefined && typeof bellEnabled !== 'boolean') {
      return res.status(400).json({ success: false, error: 'bellEnabled must be boolean' });
    }
    if (popupEnabled !== undefined && typeof popupEnabled !== 'boolean') {
      return res.status(400).json({ success: false, error: 'popupEnabled must be boolean' });
    }

    const caller = await resolveCaller(req);
    if (!caller || !caller.atlassianAccountId || !caller.orgId) {
      return res.status(404).json({ success: false, error: 'User profile not found' });
    }

    const supabase = getClient();

    // Load current to apply partial update on top of existing defaults.
    const { data: existing } = await supabase
      .from(TABLE)
      .select('bell_enabled, popup_enabled')
      .eq('account_id', caller.atlassianAccountId)
      .eq('org_id', caller.orgId)
      .maybeSingle();

    const row = {
      account_id: caller.atlassianAccountId,
      org_id: caller.orgId,
      bell_enabled: bellEnabled !== undefined
        ? bellEnabled
        : (existing ? existing.bell_enabled : DEFAULTS.bellEnabled),
      popup_enabled: popupEnabled !== undefined
        ? popupEnabled
        : (existing ? existing.popup_enabled : DEFAULTS.popupEnabled),
      updated_at: new Date().toISOString()
    };

    const { error } = await supabase
      .from(TABLE)
      .upsert(row, { onConflict: 'account_id,org_id' });

    if (error) {
      logger.error('[DesktopDqPreferences] PUT failed: %s', error.message);
      return res.status(500).json({ success: false, error: 'Failed to save preferences' });
    }

    return res.json({
      success: true,
      preferences: { bellEnabled: row.bell_enabled, popupEnabled: row.popup_enabled }
    });
  } catch (err) {
    logger.error('[DesktopDqPreferences] PUT threw: %s', err.message);
    return res.status(500).json({ success: false, error: 'Failed to save preferences' });
  }
});

module.exports = router;
module.exports._resolveCaller = resolveCaller;
