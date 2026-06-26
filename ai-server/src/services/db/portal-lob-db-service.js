/**
 * Portal LOB Database Service
 *
 * Supabase queries for the LOB-segmentation feature (Phase 1):
 *   - portal_lobs                       (LOB definitions)
 *   - portal_lob_employees             (M:N LOB <-> tracked employee, soft ref to users)
 *   - portal_lob_heads                 (M:N LOB <-> portal admin head)
 *   - portal_app_catalog               (shared application catalog)
 *   - portal_lob_app_classifications   (per-LOB classification of catalog apps)
 *
 * Queries only — no request/response handling, no business rules. `users` and
 * `portal_admin_users` are read for display/validation; no Jira-owned table is
 * written. user_id in portal_lob_employees is a soft reference (no FK).
 */

'use strict';

const { getClient } = require('./supabase-client');
const logger = require('../../utils/logger');

// ---------------------------------------------------------------------------
// LOBs
// ---------------------------------------------------------------------------

async function listLobs({ includeInactive = false } = {}) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  let query = supabase.from('portal_lobs').select('*').order('name', { ascending: true });
  if (!includeInactive) query = query.eq('is_active', true);

  const { data, error } = await query;
  if (error) {
    logger.error('[PortalLobDB] listLobs failed', { error });
    throw error;
  }
  return data || [];
}

async function listLobsByIds(lobIds, { includeInactive = false } = {}) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');
  if (!Array.isArray(lobIds) || lobIds.length === 0) return [];

  let query = supabase.from('portal_lobs').select('*').in('id', lobIds).order('name', { ascending: true });
  if (!includeInactive) query = query.eq('is_active', true);

  const { data, error } = await query;
  if (error) {
    logger.error('[PortalLobDB] listLobsByIds failed', { error });
    throw error;
  }
  return data || [];
}

async function getLobById(id) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase.from('portal_lobs').select('*').eq('id', id).single();
  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error('[PortalLobDB] getLobById failed', { id, error });
    throw error;
  }
  return data;
}

async function createLob({ name, description, createdBy }) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase
    .from('portal_lobs')
    .insert({ name, description: description || null, created_by: createdBy || null })
    .select()
    .single();
  if (error) {
    logger.error('[PortalLobDB] createLob failed', { name, error });
    throw error;
  }
  return data;
}

async function updateLob(id, updates) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase
    .from('portal_lobs')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error('[PortalLobDB] updateLob failed', { id, error });
    throw error;
  }
  return data;
}

async function deleteLob(id) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { error } = await supabase.from('portal_lobs').delete().eq('id', id);
  if (error) {
    logger.error('[PortalLobDB] deleteLob failed', { id, error });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Scope resolution
// ---------------------------------------------------------------------------

/** LOB ids an admin heads. */
async function getHeadedLobIds(adminId) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase
    .from('portal_lob_heads')
    .select('lob_id')
    .eq('admin_id', adminId);
  if (error) {
    logger.error('[PortalLobDB] getHeadedLobIds failed', { adminId, error });
    throw error;
  }
  return (data || []).map((r) => r.lob_id);
}

/** Distinct employee user_ids across the given LOBs. */
async function getUserIdsForLobs(lobIds) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');
  if (!Array.isArray(lobIds) || lobIds.length === 0) return [];

  const { data, error } = await supabase
    .from('portal_lob_employees')
    .select('user_id')
    .in('lob_id', lobIds);
  if (error) {
    logger.error('[PortalLobDB] getUserIdsForLobs failed', { error });
    throw error;
  }
  return [...new Set((data || []).map((r) => r.user_id))];
}

// ---------------------------------------------------------------------------
// Members (employees)
// ---------------------------------------------------------------------------

/** Raw membership user_ids for one LOB. */
async function getMemberUserIds(lobId) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase
    .from('portal_lob_employees')
    .select('user_id')
    .eq('lob_id', lobId);
  if (error) {
    logger.error('[PortalLobDB] getMemberUserIds failed', { lobId, error });
    throw error;
  }
  return (data || []).map((r) => r.user_id);
}

/** Fetch user rows (Jira-owned users table, read-only) by id. */
async function getUsersByIds(userIds) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');
  if (!Array.isArray(userIds) || userIds.length === 0) return [];

  const { data, error } = await supabase
    .from('users')
    .select('id, display_name, email')
    .in('id', userIds);
  if (error) {
    logger.error('[PortalLobDB] getUsersByIds failed', { error });
    throw error;
  }
  return data || [];
}

async function addLobMembers(lobId, userIds, addedBy) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const rows = userIds.map((userId) => ({ lob_id: lobId, user_id: userId, added_by: addedBy || null }));
  const { data, error } = await supabase
    .from('portal_lob_employees')
    .upsert(rows, { onConflict: 'lob_id,user_id', ignoreDuplicates: true })
    .select();
  if (error) {
    logger.error('[PortalLobDB] addLobMembers failed', { lobId, error });
    throw error;
  }
  return data || [];
}

async function removeLobMember(lobId, userId) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase
    .from('portal_lob_employees')
    .delete()
    .eq('lob_id', lobId)
    .eq('user_id', userId)
    .select();
  if (error) {
    logger.error('[PortalLobDB] removeLobMember failed', { lobId, userId, error });
    throw error;
  }
  return data && data.length > 0;
}

// ---------------------------------------------------------------------------
// Expected-member roster (adoption tracking) — portal_lob_expected_members
// ---------------------------------------------------------------------------

/** Imported roster rows for one LOB (email-keyed expected members). */
async function listExpectedMembers(lobId) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase
    .from('portal_lob_expected_members')
    .select('id, email, full_name')
    .eq('lob_id', lobId)
    .order('email', { ascending: true });
  if (error) {
    logger.error('[PortalLobDB] listExpectedMembers failed', { lobId, error });
    throw error;
  }
  return data || [];
}

/**
 * Upsert roster rows for a LOB. `rows` are pre-normalized { email, full_name }.
 * Re-import refreshes full_name (merge, not ignore) so a corrected name sticks.
 */
async function upsertExpectedMembers(lobId, rows, importedBy) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');
  if (!Array.isArray(rows) || rows.length === 0) return [];

  const payload = rows.map((r) => ({
    lob_id: lobId,
    email: r.email,
    full_name: r.full_name || null,
    imported_by: importedBy || null,
  }));
  const { data, error } = await supabase
    .from('portal_lob_expected_members')
    .upsert(payload, { onConflict: 'lob_id,email' })
    .select();
  if (error) {
    logger.error('[PortalLobDB] upsertExpectedMembers failed', { lobId, error });
    throw error;
  }
  return data || [];
}

async function deleteExpectedMember(lobId, id) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase
    .from('portal_lob_expected_members')
    .delete()
    .eq('lob_id', lobId)
    .eq('id', id)
    .select();
  if (error) {
    logger.error('[PortalLobDB] deleteExpectedMember failed', { lobId, id, error });
    throw error;
  }
  return data && data.length > 0;
}

/**
 * Read-only lookup of the (Jira-owned) users table by email — the install
 * signal. `emails` must be normalized lower-case; matching is exact (see the
 * email-privacy follow-up in the spec). Never writes to users.
 */
async function getUsersByEmails(emails) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');
  if (!Array.isArray(emails) || emails.length === 0) return [];

  const { data, error } = await supabase
    .from('users')
    .select('id, display_name, email')
    .in('email', emails);
  if (error) {
    logger.error('[PortalLobDB] getUsersByEmails failed', { error });
    throw error;
  }
  return data || [];
}

// ---------------------------------------------------------------------------
// Heads
// ---------------------------------------------------------------------------

async function getLobHeadRows(lobId) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase
    .from('portal_lob_heads')
    .select('admin_id, role, created_at')
    .eq('lob_id', lobId);
  if (error) {
    logger.error('[PortalLobDB] getLobHeadRows failed', { lobId, error });
    throw error;
  }
  return data || [];
}

/** Head rows for a set of admins (for showing each admin's LOBs). */
async function getHeadRowsForAdmins(adminIds) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');
  if (!Array.isArray(adminIds) || adminIds.length === 0) return [];

  const { data, error } = await supabase
    .from('portal_lob_heads')
    .select('admin_id, lob_id')
    .in('admin_id', adminIds);
  if (error) {
    logger.error('[PortalLobDB] getHeadRowsForAdmins failed', { adminCount: adminIds.length, error });
    throw error;
  }
  return data || [];
}

async function getAdminsByIds(adminIds) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');
  if (!Array.isArray(adminIds) || adminIds.length === 0) return [];

  const { data, error } = await supabase
    .from('portal_admin_users')
    .select('id, email, display_name, role')
    .in('id', adminIds);
  if (error) {
    logger.error('[PortalLobDB] getAdminsByIds failed', { error });
    throw error;
  }
  return data || [];
}

async function addLobHeads(lobId, adminIds, assignedBy) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const rows = adminIds.map((adminId) => ({ lob_id: lobId, admin_id: adminId, assigned_by: assignedBy || null }));
  const { data, error } = await supabase
    .from('portal_lob_heads')
    .upsert(rows, { onConflict: 'lob_id,admin_id', ignoreDuplicates: true })
    .select();
  if (error) {
    logger.error('[PortalLobDB] addLobHeads failed', { lobId, error });
    throw error;
  }
  return data || [];
}

async function removeLobHead(lobId, adminId) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase
    .from('portal_lob_heads')
    .delete()
    .eq('lob_id', lobId)
    .eq('admin_id', adminId)
    .select();
  if (error) {
    logger.error('[PortalLobDB] removeLobHead failed', { lobId, adminId, error });
    throw error;
  }
  return data && data.length > 0;
}

// ---------------------------------------------------------------------------
// App catalog
// ---------------------------------------------------------------------------

async function listCatalog({ search, matchBy, page = 1, limit = 100, includeInactive = false } = {}) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const offset = (page - 1) * limit;
  let query = supabase.from('portal_app_catalog').select('*', { count: 'exact' });
  if (!includeInactive) query = query.eq('is_active', true);
  if (matchBy) query = query.eq('match_by', matchBy);
  if (search) query = query.or(`identifier.ilike.%${search}%,display_name.ilike.%${search}%`);

  const { data, error, count } = await query
    .order('display_name', { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) {
    logger.error('[PortalLobDB] listCatalog failed', { error });
    throw error;
  }
  return { data: data || [], totalCount: count || 0 };
}

async function getCatalogById(id) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase.from('portal_app_catalog').select('*').eq('id', id).single();
  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error('[PortalLobDB] getCatalogById failed', { id, error });
    throw error;
  }
  return data;
}

async function getCatalogByIdentifier(identifier, matchBy) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase
    .from('portal_app_catalog')
    .select('*')
    .eq('identifier', identifier)
    .eq('match_by', matchBy)
    .single();
  if (error) {
    if (error.code === 'PGRST116') return null; // no row
    logger.error('[PortalLobDB] getCatalogByIdentifier failed', { identifier, matchBy, error });
    throw error;
  }
  return data;
}

async function createCatalogApp(appData) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase.from('portal_app_catalog').insert(appData).select().single();
  if (error) {
    logger.error('[PortalLobDB] createCatalogApp failed', { error });
    throw error;
  }
  return data;
}

async function updateCatalogApp(id, updates) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase
    .from('portal_app_catalog')
    .update(updates)
    .eq('id', id)
    .select()
    .single();
  if (error) {
    if (error.code === 'PGRST116') return null;
    logger.error('[PortalLobDB] updateCatalogApp failed', { id, error });
    throw error;
  }
  return data;
}

async function deleteCatalogApp(id) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase.from('portal_app_catalog').delete().eq('id', id).select();
  if (error) {
    logger.error('[PortalLobDB] deleteCatalogApp failed', { id, error });
    throw error;
  }
  return data && data.length > 0;
}

// ---------------------------------------------------------------------------
// Per-LOB classifications
// ---------------------------------------------------------------------------

async function listLobClassifications(lobId) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase
    .from('portal_lob_app_classifications')
    .select('id, app_id, classification, updated_at')
    .eq('lob_id', lobId);
  if (error) {
    logger.error('[PortalLobDB] listLobClassifications failed', { lobId, error });
    throw error;
  }
  return data || [];
}

async function setLobClassification(lobId, appId, classification, createdBy) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase
    .from('portal_lob_app_classifications')
    .upsert(
      { lob_id: lobId, app_id: appId, classification, created_by: createdBy || null },
      { onConflict: 'lob_id,app_id' }
    )
    .select()
    .single();
  if (error) {
    logger.error('[PortalLobDB] setLobClassification failed', { lobId, appId, error });
    throw error;
  }
  return data;
}

async function deleteLobClassification(lobId, appId) {
  const supabase = getClient();
  if (!supabase) throw new Error('Supabase client not initialized');

  const { data, error } = await supabase
    .from('portal_lob_app_classifications')
    .delete()
    .eq('lob_id', lobId)
    .eq('app_id', appId)
    .select();
  if (error) {
    logger.error('[PortalLobDB] deleteLobClassification failed', { lobId, appId, error });
    throw error;
  }
  return data && data.length > 0;
}

module.exports = {
  // LOBs
  listLobs,
  listLobsByIds,
  getLobById,
  createLob,
  updateLob,
  deleteLob,
  // scope
  getHeadedLobIds,
  getUserIdsForLobs,
  // members
  getMemberUserIds,
  getUsersByIds,
  addLobMembers,
  removeLobMember,
  // expected-member roster
  listExpectedMembers,
  upsertExpectedMembers,
  deleteExpectedMember,
  getUsersByEmails,
  // heads
  getLobHeadRows,
  getHeadRowsForAdmins,
  getAdminsByIds,
  addLobHeads,
  removeLobHead,
  // catalog
  listCatalog,
  getCatalogById,
  getCatalogByIdentifier,
  createCatalogApp,
  updateCatalogApp,
  deleteCatalogApp,
  // per-LOB classifications
  listLobClassifications,
  setLobClassification,
  deleteLobClassification,
};
