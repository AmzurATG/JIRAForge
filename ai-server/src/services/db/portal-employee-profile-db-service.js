/**
 * Portal Employee Profile Database Service
 *
 * Supabase queries for the WS-B employee-location feature:
 *   - portal_locations          (managed list, superadmin CRUD)
 *   - portal_employee_profiles  (per-employee attributes; user_id is a soft
 *                                reference to users(id) — no FK)
 *
 * Queries only — no business rules. Both tables are portal-owned and
 * company-wide (no org_id) by design; see the 20260610 migration header.
 *
 * Plan: plan/2026-06-10_web-productivity-portal_ux-improvements.md (WS-B)
 */

'use strict';

const { getClient } = require('./supabase-client');
const logger = require('../../utils/logger');

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

async function listLocations({ includeInactive = false } = {}) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  let query = supabase.from('portal_locations').select('*').order('name', { ascending: true });
  if (!includeInactive) query = query.eq('is_active', true);

  const { data, error } = await query;
  if (error) {
    logger.error('[PortalProfileDB] listLocations failed', { error });
    throw error;
  }
  return data || [];
}

async function getLocationById(id) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase.from('portal_locations').select('*').eq('id', id).single();
  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error('[PortalProfileDB] getLocationById failed', { id, error });
    throw error;
  }
  return data;
}

async function createLocation({ name, createdBy }) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase
    .from('portal_locations')
    .insert({ name, created_by: createdBy || null })
    .select()
    .single();
  if (error) {
    logger.error('[PortalProfileDB] createLocation failed', { name, error });
    throw error;
  }
  return data;
}

async function updateLocation(id, updates) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase
    .from('portal_locations')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error('[PortalProfileDB] updateLocation failed', { id, error });
    throw error;
  }
  return data;
}

async function deleteLocation(id) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase.from('portal_locations').delete().eq('id', id).select();
  if (error) {
    logger.error('[PortalProfileDB] deleteLocation failed', { id, error });
    throw error;
  }
  return data && data.length > 0;
}

/** Number of employee profiles referencing a location (for delete guard). */
async function countProfilesForLocation(locationId) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { count, error } = await supabase
    .from('portal_employee_profiles')
    .select('id', { count: 'exact', head: true })
    .eq('location_id', locationId);
  if (error) {
    logger.error('[PortalProfileDB] countProfilesForLocation failed', { locationId, error });
    throw error;
  }
  return count || 0;
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/** Distinct user_ids assigned to a location (for location-scoped analytics). */
async function getUserIdsForLocation(locationId) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase
    .from('portal_employee_profiles')
    .select('user_id')
    .eq('location_id', locationId);
  if (error) {
    logger.error('[PortalProfileDB] getUserIdsForLocation failed', { locationId, error });
    throw error;
  }
  return [...new Set((data || []).map((r) => r.user_id))];
}

/**
 * Profile rows (with embedded location) for a set of users.
 * Chunked: callers may pass up to ~1000 ids (employee-summary report); a
 * single PostgREST `in.(…)` with that many UUIDs exceeds URL length limits.
 */
const PROFILE_IN_CHUNK = 200;
async function getProfilesByUserIds(userIds) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');
  if (!Array.isArray(userIds) || userIds.length === 0) return [];

  const rows = [];
  for (let i = 0; i < userIds.length; i += PROFILE_IN_CHUNK) {
    const chunk = userIds.slice(i, i + PROFILE_IN_CHUNK);
    const { data, error } = await supabase
      .from('portal_employee_profiles')
      .select('user_id, location_id, portal_locations(id, name, is_active)')
      .in('user_id', chunk);
    if (error) {
      logger.error('[PortalProfileDB] getProfilesByUserIds failed', { error });
      throw error;
    }
    rows.push(...(data || []));
  }
  return rows;
}

/** Upsert (one profile row per user). */
async function upsertProfile(userId, locationId, updatedBy) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase
    .from('portal_employee_profiles')
    .upsert(
      { user_id: userId, location_id: locationId, updated_by: updatedBy || null },
      { onConflict: 'user_id' }
    )
    .select('user_id, location_id, portal_locations(id, name, is_active)')
    .single();
  if (error) {
    logger.error('[PortalProfileDB] upsertProfile failed', { userId, error });
    throw error;
  }
  return data;
}

module.exports = {
  listLocations,
  getLocationById,
  createLocation,
  updateLocation,
  deleteLocation,
  countProfilesForLocation,
  getUserIdsForLocation,
  getProfilesByUserIds,
  upsertProfile,
};
