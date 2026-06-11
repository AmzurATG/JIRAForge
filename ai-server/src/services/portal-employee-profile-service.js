/**
 * Portal Employee Profile Service (WS-B — Employee Location)
 *
 * Domain logic for the managed locations list and per-employee location
 * assignment. No Express req/res here; validation/known errors are thrown
 * with a numeric `.status` so controllers can map them (400/404/409).
 * Supabase access lives in services/db/portal-employee-profile-db-service.js.
 *
 * The Jira-owned `users` table is read for validation only — never written.
 *
 * Plan: plan/2026-06-10_web-productivity-portal_ux-improvements.md (WS-B)
 */

'use strict';

const db = require('./db/portal-employee-profile-db-service');
const lobDb = require('./db/portal-lob-db-service'); // reuse read-only users lookup

const MAX_NAME_LENGTH = 120;

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function isDuplicateError(err) {
  return err.code === '23505' || /duplicate|unique/i.test(err.message || '');
}

// ---------------------------------------------------------------------------
// Locations
// ---------------------------------------------------------------------------

async function listLocations({ includeInactive = false } = {}) {
  return db.listLocations({ includeInactive });
}

async function createLocation(name, createdBy) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw httpError('Location name is required', 400);
  if (trimmed.length > MAX_NAME_LENGTH) throw httpError(`Location name must be at most ${MAX_NAME_LENGTH} characters`, 400);
  try {
    return await db.createLocation({ name: trimmed, createdBy });
  } catch (err) {
    if (isDuplicateError(err)) throw httpError('A location with this name already exists', 409);
    throw err;
  }
}

async function updateLocation(id, { name, isActive }) {
  const updates = {};
  if (name !== undefined) {
    const trimmed = (name || '').trim();
    if (!trimmed) throw httpError('Location name cannot be empty', 400);
    if (trimmed.length > MAX_NAME_LENGTH) throw httpError(`Location name must be at most ${MAX_NAME_LENGTH} characters`, 400);
    updates.name = trimmed;
  }
  if (isActive !== undefined) updates.is_active = !!isActive;
  if (Object.keys(updates).length === 0) throw httpError('No fields to update', 400);

  let updated;
  try {
    updated = await db.updateLocation(id, updates);
  } catch (err) {
    if (isDuplicateError(err)) throw httpError('A location with this name already exists', 409);
    throw err;
  }
  if (!updated) throw httpError('Location not found', 404);
  return updated;
}

async function deleteLocation(id) {
  const location = await db.getLocationById(id);
  if (!location) throw httpError('Location not found', 404);

  const inUse = await db.countProfilesForLocation(id);
  if (inUse > 0) {
    throw httpError(`Location is assigned to ${inUse} employee(s) — unassign or deactivate it instead`, 409);
  }
  await db.deleteLocation(id);
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

/** Map of user_id -> { id, name } for the users that have a location. */
async function getLocationMapForUsers(userIds) {
  if (!Array.isArray(userIds) || userIds.length === 0) return {};
  const rows = await db.getProfilesByUserIds(userIds);
  const map = {};
  for (const row of rows) {
    if (row.location_id && row.portal_locations) {
      map[row.user_id] = { id: row.portal_locations.id, name: row.portal_locations.name };
    }
  }
  return map;
}

/**
 * Narrow a caller's visible-user set by a location (for the Location filter
 * on Dashboard / Time Logs / Reports).
 *
 * @param {Array<string>|null} visibleUserIds - LOB scope (null = unrestricted)
 * @param {string|undefined} locationId - optional location filter
 * @returns {Promise<Array<string>|null>} null (no restriction), or the
 *   narrowed user set (empty array ⇒ sees nothing) — same contract the
 *   analytics services already handle.
 */
async function applyLocationScope(visibleUserIds, locationId) {
  if (!locationId) return visibleUserIds;
  const locationUserIds = await db.getUserIdsForLocation(locationId);
  if (!Array.isArray(visibleUserIds)) return locationUserIds;
  const inLocation = new Set(locationUserIds);
  return visibleUserIds.filter((id) => inLocation.has(id));
}

/**
 * Set (or clear, with locationId = null) an employee's location.
 * Validates the employee exists in the Jira-owned users table (read-only)
 * and the location exists and is active.
 */
async function setEmployeeLocation(userId, locationId, updatedBy) {
  if (!userId) throw httpError('userId is required', 400);

  const users = await lobDb.getUsersByIds([userId]);
  if (!users.length) throw httpError('Employee not found', 404);

  if (locationId !== null && locationId !== undefined) {
    const location = await db.getLocationById(locationId);
    if (!location) throw httpError('Location not found', 404);
    if (!location.is_active) throw httpError('Location is inactive — reactivate it before assigning', 400);
  }

  const row = await db.upsertProfile(userId, locationId ?? null, updatedBy);
  return {
    userId: row.user_id,
    locationId: row.location_id,
    locationName: row.portal_locations ? row.portal_locations.name : null,
  };
}

/**
 * Bulk-assign (or clear, with locationId = null) a location for many
 * employees in one operation (Pattern A action bar + Pattern B members
 * picker). Validates the location once, validates employees against the
 * Jira-owned users table in chunks (read-only), upserts the valid ones.
 *
 * @returns {Promise<{updatedCount:number, invalidUserIds:string[]}>}
 */
async function setEmployeeLocations(userIds, locationId, updatedBy) {
  if (!Array.isArray(userIds) || userIds.length === 0) {
    throw httpError('userIds array is required', 400);
  }

  if (locationId !== null && locationId !== undefined) {
    const location = await db.getLocationById(locationId);
    if (!location) throw httpError('Location not found', 404);
    if (!location.is_active) throw httpError('Location is inactive — reactivate it before assigning', 400);
  }

  // Validate existence in chunks — getUsersByIds is a URL-encoded IN query.
  const CHUNK = 200;
  const existingIds = new Set();
  for (let i = 0; i < userIds.length; i += CHUNK) {
    const users = await lobDb.getUsersByIds(userIds.slice(i, i + CHUNK));
    for (const u of users) existingIds.add(u.id);
  }
  const validIds = [...new Set(userIds)].filter((id) => existingIds.has(id));
  const invalidUserIds = [...new Set(userIds)].filter((id) => !existingIds.has(id));

  if (validIds.length) {
    await db.bulkUpsertProfiles(validIds, locationId ?? null, updatedBy);
  }
  return { updatedCount: validIds.length, invalidUserIds };
}

module.exports = {
  listLocations,
  createLocation,
  updateLocation,
  deleteLocation,
  getLocationMapForUsers,
  applyLocationScope,
  setEmployeeLocation,
  setEmployeeLocations,
};
