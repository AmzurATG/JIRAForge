/**
 * Portal Working-Location Database Service
 *
 * Supabase queries for portal_employee_work_locations — one row per employee
 * holding the approximate location they are currently working from
 * (user_id is a soft reference to users(id); no FK).
 *
 * Queries only — no business rules. The table is portal-owned and company-wide
 * (no org_id) by design; see the 20260613 migration header. Portal-only
 * feature: never expose these through forge-auth'd routes.
 *
 * Plan: plan/2026-06-12_cross-component_automatic-employee-location-detection.md
 */

'use strict';

const { getClient } = require('./supabase-client');
const logger = require('../../utils/logger');

const WORK_LOC_IN_CHUNK = 200;

/** Latest working location for one user, or null. */
async function getWorkLocationByUserId(userId) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase
    .from('portal_employee_work_locations')
    .select('*')
    .eq('user_id', userId)
    .single();
  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error('[WorkLocationDB] getWorkLocationByUserId failed', { userId, error });
    throw error;
  }
  return data;
}

/**
 * Working locations for a set of users (for the Employees list).
 * Chunked: callers may pass up to ~1000 ids; a single PostgREST `in.(…)` with
 * that many UUIDs exceeds URL length limits.
 */
async function getWorkLocationsByUserIds(userIds) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');
  if (!Array.isArray(userIds) || userIds.length === 0) return [];

  const rows = [];
  for (let i = 0; i < userIds.length; i += WORK_LOC_IN_CHUNK) {
    const chunk = userIds.slice(i, i + WORK_LOC_IN_CHUNK);
    const { data, error } = await supabase
      .from('portal_employee_work_locations')
      .select('user_id, city, region, country, detected_at')
      .in('user_id', chunk);
    if (error) {
      logger.error('[WorkLocationDB] getWorkLocationsByUserIds failed', { error });
      throw error;
    }
    rows.push(...(data || []));
  }
  return rows;
}

/** Upsert (one row per user) the latest detected working location. */
async function upsertWorkLocation({ userId, city, region, country, ipPrefix, source }) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase
    .from('portal_employee_work_locations')
    .upsert(
      {
        user_id: userId,
        city: city || null,
        region: region || null,
        country: country || null,
        ip_prefix: ipPrefix || null,
        source: source || 'geoip',
        detected_at: new Date().toISOString(),
      },
      { onConflict: 'user_id' }
    )
    .select('*')
    .single();
  if (error) {
    logger.error('[WorkLocationDB] upsertWorkLocation failed', { userId, error });
    throw error;
  }
  return data;
}

module.exports = {
  getWorkLocationByUserId,
  getWorkLocationsByUserIds,
  upsertWorkLocation,
};
