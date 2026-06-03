/**
 * Portal LOB Service
 *
 * Domain logic for LOB segmentation & RBAC (Phase 1):
 *   - scope resolution (who the caller may see)
 *   - LOB / member / head management
 *   - shared app catalog management
 *   - per-LOB app classification
 *
 * No Express req/res here. Validation/known errors are thrown with a numeric
 * `.status` so controllers can map them (400/404/409). Supabase access lives in
 * services/db/portal-lob-db-service.js.
 */

'use strict';

const db = require('./db/portal-lob-db-service');
const logger = require('../utils/logger');

const CLASSIFICATIONS = ['productive', 'non_productive', 'private', 'neutral'];
const MATCH_BY = ['process', 'url'];

function httpError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// ---------------------------------------------------------------------------
// Scope / authorization
// ---------------------------------------------------------------------------

/**
 * Resolve what the caller may see.
 * @returns {Promise<{isSuperadmin:boolean, visibleLobIds:(string[]|null), visibleUserIds:(string[]|null)}>}
 *   For superadmin both `visible*` are null (no restriction). For everyone else
 *   visibleLobIds = LOBs they head, visibleUserIds = de-duplicated employees in
 *   those LOBs (empty array ⇒ sees nothing). Resolved per request from the DB,
 *   so head removal takes effect immediately.
 */
async function resolveScope(portalUser) {
  if (portalUser && portalUser.role === 'superadmin') {
    return { isSuperadmin: true, visibleLobIds: null, visibleUserIds: null };
  }
  const visibleLobIds = await db.getHeadedLobIds(portalUser.userId);
  const visibleUserIds = visibleLobIds.length ? await db.getUserIdsForLobs(visibleLobIds) : [];
  return { isSuperadmin: false, visibleLobIds, visibleUserIds };
}

/** True if the caller may view/manage the given LOB. */
function canAccessLob(scope, lobId) {
  return scope.isSuperadmin || (scope.visibleLobIds || []).includes(lobId);
}

/** De-duplicated employee user_ids across the given LOB ids. */
async function userIdsForLobs(lobIds) {
  return db.getUserIdsForLobs(lobIds);
}

// ---------------------------------------------------------------------------
// LOBs
// ---------------------------------------------------------------------------

async function listLobsForScope(scope, { includeInactive = false } = {}) {
  if (scope.isSuperadmin) return db.listLobs({ includeInactive });
  return db.listLobsByIds(scope.visibleLobIds || [], { includeInactive });
}

async function createLob({ name, description }, createdBy) {
  const trimmed = (name || '').trim();
  if (!trimmed) throw httpError('LOB name is required', 400);
  try {
    return await db.createLob({ name: trimmed, description, createdBy });
  } catch (err) {
    if (err.code === '23505' || /duplicate|unique/i.test(err.message || '')) {
      throw httpError('An LOB with this name already exists', 409);
    }
    throw err;
  }
}

async function updateLob(lobId, { name, description, isActive }) {
  const updates = {};
  if (name !== undefined) {
    const trimmed = (name || '').trim();
    if (!trimmed) throw httpError('LOB name cannot be empty', 400);
    updates.name = trimmed;
  }
  if (description !== undefined) updates.description = description;
  if (isActive !== undefined) updates.is_active = !!isActive;
  if (Object.keys(updates).length === 0) throw httpError('No fields to update', 400);

  let updated;
  try {
    updated = await db.updateLob(lobId, updates);
  } catch (err) {
    if (err.code === '23505' || /duplicate|unique/i.test(err.message || '')) {
      throw httpError('An LOB with this name already exists', 409);
    }
    throw err;
  }
  if (!updated) throw httpError('LOB not found', 404);
  return updated;
}

async function deleteLob(lobId) {
  const lob = await db.getLobById(lobId);
  if (!lob) throw httpError('LOB not found', 404);
  await db.deleteLob(lobId); // cascades members/heads/classifications; never touches users/activity
}

// ---------------------------------------------------------------------------
// Members (employees)
// ---------------------------------------------------------------------------

async function listMembers(lobId, { page = 1, limit = 20, search } = {}) {
  const userIds = await db.getMemberUserIds(lobId);
  if (userIds.length === 0) return { data: [], pagination: { page, limit, totalCount: 0 } };

  let users = await db.getUsersByIds(userIds); // orphaned ids silently dropped
  if (search) {
    const s = search.toLowerCase();
    users = users.filter(
      (u) => (u.display_name || '').toLowerCase().includes(s) || (u.email || '').toLowerCase().includes(s)
    );
  }
  users.sort((a, b) => (a.display_name || a.email || '').localeCompare(b.display_name || b.email || ''));

  const totalCount = users.length;
  const offset = (page - 1) * limit;
  const pageRows = users.slice(offset, offset + limit).map((u) => ({
    userId: u.id,
    name: u.display_name || u.email || 'Unknown User',
    email: u.email,
  }));
  return { data: pageRows, pagination: { page, limit, totalCount } };
}

async function addMembers(lobId, userIds, addedBy) {
  const lob = await db.getLobById(lobId);
  if (!lob) throw httpError('LOB not found', 404);
  if (!Array.isArray(userIds) || userIds.length === 0) throw httpError('userIds array is required', 400);

  // Validate the user ids exist in the (Jira-owned) users table — soft-ref integrity.
  const existing = await db.getUsersByIds(userIds);
  const existingIds = new Set(existing.map((u) => u.id));
  const validIds = userIds.filter((id) => existingIds.has(id));
  const invalidUserIds = userIds.filter((id) => !existingIds.has(id));

  let addedCount = 0;
  if (validIds.length) {
    const inserted = await db.addLobMembers(lobId, validIds, addedBy);
    addedCount = inserted.length;
  }
  return { addedCount, invalidUserIds };
}

async function removeMember(lobId, userId) {
  const removed = await db.removeLobMember(lobId, userId);
  if (!removed) throw httpError('Member not found in this LOB', 404);
}

// ---------------------------------------------------------------------------
// Heads
// ---------------------------------------------------------------------------

/**
 * Map of adminId -> [{ id, name }] LOBs each admin heads.
 * Used to show/edit an admin's LOB assignments in the Settings page.
 */
async function getLobsForAdmins(adminIds) {
  if (!Array.isArray(adminIds) || adminIds.length === 0) return {};
  const rows = await db.getHeadRowsForAdmins(adminIds);
  if (rows.length === 0) return {};
  const lobIds = [...new Set(rows.map((r) => r.lob_id))];
  const lobs = await db.listLobsByIds(lobIds, { includeInactive: true });
  const lobById = new Map(lobs.map((l) => [l.id, l]));
  const map = {};
  for (const r of rows) {
    const lob = lobById.get(r.lob_id);
    if (!lob) continue; // tolerate orphan
    (map[r.admin_id] = map[r.admin_id] || []).push({ id: lob.id, name: lob.name });
  }
  return map;
}

async function listHeads(lobId) {
  const rows = await db.getLobHeadRows(lobId);
  if (rows.length === 0) return [];
  const admins = await db.getAdminsByIds(rows.map((r) => r.admin_id));
  const byId = new Map(admins.map((a) => [a.id, a]));
  return rows
    .map((r) => {
      const a = byId.get(r.admin_id);
      if (!a) return null; // orphan tolerance
      return {
        adminId: a.id,
        email: a.email,
        displayName: a.display_name,
        accountRole: a.role, // global portal role
        lobRole: r.role, // 'head' (reserved: 'viewer')
        assignedAt: r.created_at,
      };
    })
    .filter(Boolean);
}

async function addHeads(lobId, adminIds, assignedBy) {
  const lob = await db.getLobById(lobId);
  if (!lob) throw httpError('LOB not found', 404);
  if (!Array.isArray(adminIds) || adminIds.length === 0) throw httpError('adminIds array is required', 400);

  const existing = await db.getAdminsByIds(adminIds);
  const existingIds = new Set(existing.map((a) => a.id));
  const validIds = adminIds.filter((id) => existingIds.has(id));
  const invalidAdminIds = adminIds.filter((id) => !existingIds.has(id));

  let addedCount = 0;
  if (validIds.length) {
    const inserted = await db.addLobHeads(lobId, validIds, assignedBy);
    addedCount = inserted.length;
  }
  return { addedCount, invalidAdminIds };
}

async function removeHead(lobId, adminId) {
  const removed = await db.removeLobHead(lobId, adminId);
  if (!removed) throw httpError('Head not assigned to this LOB', 404);
}

// ---------------------------------------------------------------------------
// App catalog
// ---------------------------------------------------------------------------

async function listCatalog(params) {
  return db.listCatalog(params);
}

async function createCatalogApp({ identifier, displayName, matchBy, defaultClassification }, createdBy) {
  const id = (identifier || '').trim().toLowerCase();
  const name = (displayName || '').trim();
  if (!id || !name) throw httpError('identifier and displayName are required', 400);
  if (!MATCH_BY.includes(matchBy)) throw httpError('matchBy must be "process" or "url"', 400);
  if (defaultClassification && !CLASSIFICATIONS.includes(defaultClassification)) {
    throw httpError('Invalid default classification', 400);
  }
  try {
    return await db.createCatalogApp({
      identifier: id,
      display_name: name,
      match_by: matchBy,
      default_classification: defaultClassification || null,
      created_by: createdBy || null,
    });
  } catch (err) {
    if (err.code === '23505' || /duplicate|unique/i.test(err.message || '')) {
      throw httpError('This application is already in the catalog', 409);
    }
    throw err;
  }
}

async function updateCatalogApp(id, { displayName, defaultClassification, isActive }) {
  const updates = {};
  if (displayName !== undefined) {
    const name = (displayName || '').trim();
    if (!name) throw httpError('displayName cannot be empty', 400);
    updates.display_name = name;
  }
  if (defaultClassification !== undefined) {
    if (defaultClassification !== null && !CLASSIFICATIONS.includes(defaultClassification)) {
      throw httpError('Invalid default classification', 400);
    }
    updates.default_classification = defaultClassification;
  }
  if (isActive !== undefined) updates.is_active = !!isActive;
  if (Object.keys(updates).length === 0) throw httpError('No fields to update', 400);

  const updated = await db.updateCatalogApp(id, updates);
  if (!updated) throw httpError('Catalog app not found', 404);
  return updated;
}

async function deleteCatalogApp(id) {
  const deleted = await db.deleteCatalogApp(id);
  if (!deleted) throw httpError('Catalog app not found', 404);
}

async function bulkImportCatalog(items, createdBy) {
  if (!Array.isArray(items) || items.length === 0) throw httpError('data array is required', 400);
  const results = { success: [], failed: [] };
  for (const item of items) {
    try {
      const created = await createCatalogApp(item, createdBy);
      results.success.push({ identifier: created.identifier, id: created.id });
    } catch (err) {
      results.failed.push({ identifier: item.identifier, error: err.message });
    }
  }
  return {
    data: results,
    summary: { total: items.length, successful: results.success.length, failed: results.failed.length },
  };
}

// ---------------------------------------------------------------------------
// Per-LOB classifications
// ---------------------------------------------------------------------------

/**
 * Catalog apps merged with this LOB's classification + the effective label
 * (per-LOB rule → catalog default → neutral). Drives the per-LOB app UI.
 */
async function listLobClassifications(lobId, { search, classification } = {}) {
  const lob = await db.getLobById(lobId);
  if (!lob) throw httpError('LOB not found', 404);

  const [{ data: catalog }, lobRows] = await Promise.all([
    db.listCatalog({ search, limit: 1000 }),
    db.listLobClassifications(lobId),
  ]);
  const byApp = new Map(lobRows.map((r) => [r.app_id, r.classification]));

  let merged = catalog.map((app) => {
    const lobClassification = byApp.get(app.id) || null;
    // The per-LOB rule is the single source of truth: NO fallback to the catalog
    // default. An app stays Unclassified (neutral, excluded from productivity)
    // until a head/superadmin sets a rule. default_classification is returned for
    // display only ("Org Default" hint), never applied as the effective value.
    const effective = lobClassification || 'neutral';
    return {
      appId: app.id,
      identifier: app.identifier,
      displayName: app.display_name,
      matchBy: app.match_by,
      defaultClassification: app.default_classification || null,
      lobClassification,
      effectiveClassification: effective,
      isClassified: !!lobClassification,
    };
  });
  if (classification) merged = merged.filter((m) => m.effectiveClassification === classification);
  return merged;
}

/**
 * Add an application to a LOB in one step: find-or-create the shared catalog
 * entry, then set this LOB's classification. Lets superadmins AND LOB heads
 * cover apps the seed catalog missed.
 *
 * When the catalog entry is newly created here it gets NO org default
 * (default_classification = null), so a head adding an app for their LOB never
 * changes how other LOBs see it — the head's choice lives only in the per-LOB
 * rule. If the app already exists (matched by identifier + match_by) it is
 * reused, not duplicated. `classification` is optional ('' / omitted ⇒ "use
 * default", i.e. catalog entry only, no per-LOB rule).
 *
 * @returns the merged row (same shape as listLobClassifications) + `created`.
 */
async function addLobApp(lobId, { identifier, displayName, matchBy, classification }, createdBy) {
  const lob = await db.getLobById(lobId);
  if (!lob) throw httpError('LOB not found', 404);

  const id = (identifier || '').trim().toLowerCase();
  const name = (displayName || '').trim();
  if (!id || !name) throw httpError('identifier and displayName are required', 400);
  if (!MATCH_BY.includes(matchBy)) throw httpError('matchBy must be "process" or "url"', 400);
  const cls = classification || '';
  if (cls && !CLASSIFICATIONS.includes(cls)) throw httpError('Invalid classification', 400);

  // Find-or-create the shared catalog entry (no org default when created here).
  let app = await db.getCatalogByIdentifier(id, matchBy);
  const created = !app;
  if (!app) {
    app = await db.createCatalogApp({
      identifier: id,
      display_name: name,
      match_by: matchBy,
      default_classification: null,
      created_by: createdBy || null,
    });
  }

  // Apply this LOB's classification, if one was chosen.
  let lobClassification = null;
  if (cls) {
    const row = await db.setLobClassification(lobId, app.id, cls, createdBy);
    lobClassification = row.classification;
  }

  return {
    appId: app.id,
    identifier: app.identifier,
    displayName: app.display_name,
    matchBy: app.match_by,
    defaultClassification: app.default_classification || null,
    lobClassification,
    effectiveClassification: lobClassification || app.default_classification || 'neutral',
    created,
  };
}

async function setLobClassification(lobId, appId, classification, createdBy) {
  if (!appId) throw httpError('appId is required', 400);
  if (!CLASSIFICATIONS.includes(classification)) throw httpError('Invalid classification', 400);
  const lob = await db.getLobById(lobId);
  if (!lob) throw httpError('LOB not found', 404);
  const app = await db.getCatalogById(appId);
  if (!app) throw httpError('Catalog app not found', 404);
  return db.setLobClassification(lobId, appId, classification, createdBy);
}

async function deleteLobClassification(lobId, appId) {
  const lob = await db.getLobById(lobId);
  if (!lob) throw httpError('LOB not found', 404);
  const removed = await db.deleteLobClassification(lobId, appId);
  if (!removed) throw httpError('No classification set for this app in this LOB', 404);
}

async function bulkSetLobClassifications(lobId, items, createdBy) {
  if (!Array.isArray(items) || items.length === 0) throw httpError('items array is required', 400);
  const lob = await db.getLobById(lobId);
  if (!lob) throw httpError('LOB not found', 404);
  const results = { success: [], failed: [] };
  for (const item of items) {
    try {
      await setLobClassification(lobId, item.appId, item.classification, createdBy);
      results.success.push({ appId: item.appId });
    } catch (err) {
      results.failed.push({ appId: item.appId, error: err.message });
    }
  }
  return {
    data: results,
    summary: { total: items.length, successful: results.success.length, failed: results.failed.length },
  };
}

module.exports = {
  CLASSIFICATIONS,
  MATCH_BY,
  resolveScope,
  canAccessLob,
  userIdsForLobs,
  listLobsForScope,
  createLob,
  updateLob,
  deleteLob,
  listMembers,
  addMembers,
  removeMember,
  listHeads,
  getLobsForAdmins,
  addHeads,
  removeHead,
  listCatalog,
  createCatalogApp,
  updateCatalogApp,
  deleteCatalogApp,
  bulkImportCatalog,
  listLobClassifications,
  addLobApp,
  setLobClassification,
  deleteLobClassification,
  bulkSetLobClassifications,
};
