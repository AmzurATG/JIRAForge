/**
 * Description Quality Nudge Preference Resolvers
 *
 * Two-checkbox UI bound to the desktop app's nudge preferences. The desktop
 * app is the source of truth (server-side table), but the Forge UI reads/writes
 * through the AI server via Forge Remote so a Jira user can toggle the bell
 * channel without launching the desktop app.
 *
 * Resolvers:
 *   - getDqNudgePreferences()  → { bellEnabled, popupEnabled }
 *   - setDqNudgePreferences({ bellEnabled?, popupEnabled? })
 *
 * Cache: 5-minute KVS cache so the settings page renders fast.
 */

import { kvs } from '@forge/kvs';
import { supabaseQuery } from '../utils/remote.js';

const CACHE_TTL_MS = 5 * 60 * 1000;
const DEFAULTS = { bellEnabled: true, popupEnabled: true };
const TABLE = 'description_quality_nudge_preferences';

function cacheKey(accountId, cloudId) {
  return `dq-nudge-prefs/${cloudId}/${accountId}`;
}

async function readCached(accountId, cloudId) {
  try {
    const entry = await kvs.get(cacheKey(accountId, cloudId));
    if (entry && entry.expiresAt > Date.now()) return entry.value;
  } catch { /* ignore */ }
  return null;
}

function writeCached(accountId, cloudId, value) {
  kvs.set(cacheKey(accountId, cloudId), {
    value,
    expiresAt: Date.now() + CACHE_TTL_MS
  }).catch(() => {});
}

function clearCached(accountId, cloudId) {
  kvs.delete(cacheKey(accountId, cloudId)).catch(() => {});
}

async function loadFromServer(accountId, orgId) {
  const data = await supabaseQuery(TABLE, {
    method: 'GET',
    query: {
      account_id: `eq.${accountId}`,
      org_id: `eq.${orgId}`,
      _select: 'bell_enabled,popup_enabled'
    }
  });
  const rows = data?.data || data || [];
  const row = rows[0];
  if (!row) return { ...DEFAULTS };
  return {
    bellEnabled: row.bell_enabled !== false,
    popupEnabled: row.popup_enabled !== false
  };
}

async function saveToServer(accountId, orgId, value) {
  // Upsert via POST + on_conflict in the proxy.
  await supabaseQuery(TABLE, {
    method: 'POST',
    body: {
      account_id: accountId,
      org_id: orgId,
      bell_enabled: value.bellEnabled,
      popup_enabled: value.popupEnabled,
      updated_at: new Date().toISOString()
    },
    query: { on_conflict: 'account_id,org_id' }
  });
}

export function registerDqNudgePreferenceResolvers(resolver) {
  resolver.define('getDqNudgePreferences', async (req) => {
    const { context } = req;
    const accountId = context?.accountId;
    const cloudId = context?.cloudId;
    if (!accountId || !cloudId) {
      return { success: false, error: 'Missing context', preferences: { ...DEFAULTS } };
    }

    try {
      const cached = await readCached(accountId, cloudId);
      if (cached) return { success: true, preferences: cached, cached: true };

      const preferences = await loadFromServer(accountId, cloudId);
      writeCached(accountId, cloudId, preferences);
      return { success: true, preferences };
    } catch (err) {
      console.warn('[DQNudgePrefs] getDqNudgePreferences failed:', err.message);
      // Soft-fail to defaults so the UI is never broken.
      return { success: true, preferences: { ...DEFAULTS }, fallback: true };
    }
  });

  resolver.define('setDqNudgePreferences', async (req) => {
    const { payload, context } = req;
    const accountId = context?.accountId;
    const cloudId = context?.cloudId;
    if (!accountId || !cloudId) {
      return { success: false, error: 'Missing context' };
    }

    const bellEnabled = payload?.bellEnabled;
    const popupEnabled = payload?.popupEnabled;
    if (bellEnabled === undefined && popupEnabled === undefined) {
      return { success: false, error: 'At least one preference required' };
    }
    if (bellEnabled !== undefined && typeof bellEnabled !== 'boolean') {
      return { success: false, error: 'bellEnabled must be boolean' };
    }
    if (popupEnabled !== undefined && typeof popupEnabled !== 'boolean') {
      return { success: false, error: 'popupEnabled must be boolean' };
    }

    try {
      // Load existing to merge partial update.
      const existing = (await readCached(accountId, cloudId))
        || await loadFromServer(accountId, cloudId);

      const next = {
        bellEnabled: bellEnabled !== undefined ? bellEnabled : existing.bellEnabled,
        popupEnabled: popupEnabled !== undefined ? popupEnabled : existing.popupEnabled
      };

      await saveToServer(accountId, cloudId, next);
      clearCached(accountId, cloudId);
      writeCached(accountId, cloudId, next);
      return { success: true, preferences: next };
    } catch (err) {
      console.error('[DQNudgePrefs] setDqNudgePreferences failed:', err.message);
      return { success: false, error: err.message };
    }
  });
}

export const _internals = { DEFAULTS };
