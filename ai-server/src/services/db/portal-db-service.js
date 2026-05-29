/**
 * Portal Database Service
 * 
 * CRUD operations for portal_admin_users table.
 */

'use strict';

const { getClient } = require('./supabase-client');
const logger = require('../../utils/logger');

/**
 * Get portal admin by email.
 * 
 * @param {string} email - Admin email
 * @returns {Promise<Object|null>} Admin user or null
 */
async function getAdminByEmail(email) {
  const supabase = getClient();
  if (!supabase) {
    throw new Error('Supabase client not initialized');
  }
  
  const { data, error } = await supabase
    .from('portal_admin_users')
    .select('*')
    .eq('email', email)
    .single();
    
  if (error) {
    if (error.code === 'PGRST116') {
      // No rows returned
      return null;
    }
    logger.error('[PortalDB] Get admin by email failed', { email, error });
    throw error;
  }
  
  return data;
}

/**
 * Get portal admin by ID.
 * 
 * @param {string} orgId - Organization ID
 * @param {string} userId - User ID
 * @returns {Promise<Object|null>} Admin user or null
 */
async function getAdminById(orgId, userId) {
  const supabase = getClient();
  if (!supabase) {
    throw new Error('Supabase client not initialized');
  }
  
  const { data, error } = await supabase
    .from('portal_admin_users')
    .select('*')
    .eq('id', userId)
    .single();
    
  if (error) {
    if (error.code === 'PGRST116') {
      return null;
    }
    logger.error('[PortalDB] Get admin by ID failed', { userId, error });
    throw error;
  }
  
  return data;
}

/**
 * List all portal admins for an organization.
 * 
 * @param {string} orgId - Organization ID
 * @param {number} page - Page number (1-indexed)
 * @param {number} limit - Page size
 * @returns {Promise<Object>} { data, totalCount }
 */
async function listAdmins(orgId, page = 1, limit = 20) {
  const supabase = getClient();
  if (!supabase) {
    throw new Error('Supabase client not initialized');
  }
  
  const offset = (page - 1) * limit;
  
  // Get total count (no org filter)
  const { count, error: countError } = await supabase
    .from('portal_admin_users')
    .select('*', { count: 'exact', head: true });
    
  if (countError) {
    logger.error('[PortalDB] Count admins failed', { error: countError });
    throw countError;
  }
  
  // Get paginated data (no org filter)
  const { data, error } = await supabase
    .from('portal_admin_users')
    .select('id, email, display_name, role, created_at, last_login_at')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
    
  if (error) {
    logger.error('[PortalDB] List admins failed', { error });
    throw error;
  }
  
  return {
    data: data || [],
    totalCount: count || 0
  };
}

/**
 * Create a new portal admin.
 * 
 * @param {string} orgId - Organization ID
 * @param {Object} adminData - { email, passwordHash, displayName, role }
 * @returns {Promise<Object>} Created admin user
 */
async function createAdmin(orgId, adminData) {
  const supabase = getClient();
  if (!supabase) {
    throw new Error('Supabase client not initialized');
  }
  
  const { data, error } = await supabase
    .from('portal_admin_users')
    .insert({
      org_id: orgId,
      email: adminData.email,
      password_hash: adminData.passwordHash,
      display_name: adminData.displayName,
      role: adminData.role
    })
    .select()
    .single();
    
  if (error) {
    logger.error('[PortalDB] Create admin failed', { orgId, email: adminData.email, error });
    throw error;
  }
  
  return data;
}

/**
 * Update portal admin.
 * 
 * @param {string} orgId - Organization ID
 * @param {string} userId - User ID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object>} Updated admin user
 */
async function updateAdmin(orgId, userId, updates) {
  const supabase = getClient();
  if (!supabase) {
    throw new Error('Supabase client not initialized');
  }
  
  const { data, error } = await supabase
    .from('portal_admin_users')
    .update({
      ...updates,
      updated_at: new Date().toISOString()
    })
    .eq('id', userId)
    .select()
    .single();
    
  if (error) {
    logger.error('[PortalDB] Update admin failed', { userId, error });
    throw error;
  }
  
  return data;
}

/**
 * Delete portal admin.
 * 
 * @param {string} orgId - Organization ID
 * @param {string} userId - User ID
 * @returns {Promise<void>}
 */
async function deleteAdmin(orgId, userId) {
  const supabase = getClient();
  if (!supabase) {
    throw new Error('Supabase client not initialized');
  }
  
  const { error } = await supabase
    .from('portal_admin_users')
    .delete()
    .eq('id', userId);
    
  if (error) {
    logger.error('[PortalDB] Delete admin failed', { userId, error });
    throw error;
  }
}

/**
 * Update last login timestamp.
 * 
 * @param {string} orgId - Organization ID
 * @param {string} userId - User ID
 * @returns {Promise<void>}
 */
async function updateLastLogin(orgId, userId) {
  const supabase = getClient();
  if (!supabase) {
    throw new Error('Supabase client not initialized');
  }
  
  const { error } = await supabase
    .from('portal_admin_users')
    .update({ last_login_at: new Date().toISOString() })
    .eq('id', userId);
    
  if (error) {
    logger.error('[PortalDB] Update last login failed', { userId, error });
    throw error;
  }
}

/**
 * Set password reset token on user.
 * SECURITY: Token should be hashed with bcrypt before passing to this function.
 * 
 * @param {string} orgId - Organization ID
 * @param {string} userId - User ID
 * @param {string} tokenHash - Hashed reset token (bcrypt)
 * @param {Date} expiresAt - Expiration timestamp
 * @returns {Promise<void>}
 */
async function setPasswordResetToken(orgId, userId, tokenHash, expiresAt) {
  const supabase = getClient();
  if (!supabase) {
    throw new Error('Supabase client not initialized');
  }
  
  if (!orgId || !userId || !tokenHash) {
    throw new Error('org_id, user_id, and tokenHash are required');
  }
  
  const { error } = await supabase
    .from('portal_admin_users')
    .update({
      reset_token: tokenHash,  // Store bcrypt hash, not plaintext
      reset_token_expires_at: expiresAt.toISOString()
    })
    .eq('id', userId);
    
  if (error) {
    logger.error('[PortalDB] Set password reset token failed', { userId, error });
    throw error;
  }
}

/**
 * Get all admins with active (non-expired) reset tokens.
 * SECURITY: Tokens are hashed, so we can't query by token directly.
 * Caller must iterate through results and use bcrypt.compare() to find match.
 * 
 * @returns {Promise<Array>} Array of admin users with active reset tokens
 */
async function getAdminsWithActiveResetToken() {
  const supabase = getClient();
  if (!supabase) {
    throw new Error('Supabase client not initialized');
  }
  
  const now = new Date().toISOString();
  const { data, error } = await supabase
    .from('portal_admin_users')
    .select('*')
    .not('reset_token', 'is', null)
    .gt('reset_token_expires_at', now);  // Only non-expired tokens
    
  if (error) {
    logger.error('[PortalDB] Get admins with active reset tokens failed', { error });
    throw error;
  }
  
  return data || [];
}

/**
 * @deprecated Use getAdminsWithActiveResetToken() instead.
 * Get admin by password reset token.
 * 
 * @param {string} token - Reset token
 * @returns {Promise<Object|null>} Admin user or null
 */
async function getAdminByResetToken(token) {
  const supabase = getClient();
  if (!supabase) {
    throw new Error('Supabase client not initialized');
  }
  
  const { data, error } = await supabase
    .from('portal_admin_users')
    .select('*')
    .eq('reset_token', token)
    .single();
    
  if (error) {
    if (error.code === 'PGRST116') {
      return null;
    }
    logger.error('[PortalDB] Get admin by reset token failed', { error });
    throw error;
  }
  
  return data;
}

/**
 * Clear password reset token after use.
 * 
 * @param {string} orgId - Organization ID
 * @param {string} userId - User ID
 * @returns {Promise<void>}
 */
async function clearPasswordResetToken(orgId, userId) {
  const supabase = getClient();
  if (!supabase) {
    throw new Error('Supabase client not initialized');
  }
  
  const { error } = await supabase
    .from('portal_admin_users')
    .update({
      reset_token: null,
      reset_token_expires_at: null
    })
    .eq('org_id', orgId)
    .eq('id', userId);
    
  if (error) {
    logger.error('[PortalDB] Clear password reset token failed', { orgId, userId, error });
    throw error;
  }
}

/**
 * List application classifications for an organization.
 * 
 * @param {string} orgId - Organization ID
 * @param {number} page - Page number (1-indexed)
 * @param {number} limit - Page size
 * @param {Object} filters - { classification, match_by, search }
 * @returns {Promise<Object>} { data, totalCount }
 */
async function listAppClassifications(orgId, page = 1, limit = 50, filters = {}) {
  const supabase = getClient();
  if (!supabase) {
    throw new Error('Supabase client not initialized');
  }
  
  const offset = (page - 1) * limit;
  
  // Build query
  let query = supabase
    .from('application_classifications')
    .select('*', { count: 'exact' });
  
  // Filter by organization (org-level + global defaults)
  query = query.or(`organization_id.eq.${orgId},organization_id.is.null`);
  
  // Apply filters
  if (filters.classification) {
    query = query.eq('classification', filters.classification);
  }
  if (filters.match_by) {
    query = query.eq('match_by', filters.match_by);
  }
  if (filters.search) {
    query = query.or(`identifier.ilike.%${filters.search}%,display_name.ilike.%${filters.search}%`);
  }
  
  // Get total count
  const { count, error: countError } = await query;
  if (countError) {
    logger.error('[PortalDB] Count app classifications failed', { error: countError });
    throw countError;
  }
  
  // Get paginated data
  const { data, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  
  if (error) {
    logger.error('[PortalDB] List app classifications failed', { error });
    throw error;
  }
  
  return {
    data: data || [],
    totalCount: count || 0
  };
}

/**
 * Create application classification.
 * 
 * @param {Object} data - Classification data
 * @returns {Promise<Object>} Created classification
 */
async function createAppClassification(data) {
  const supabase = getClient();
  if (!supabase) {
    throw new Error('Supabase client not initialized');
  }
  
  const { data: created, error } = await supabase
    .from('application_classifications')
    .insert(data)
    .select()
    .single();
  
  if (error) {
    logger.error('[PortalDB] Create app classification failed', { error });
    throw error;
  }
  
  return created;
}

/**
 * Update application classification.
 * 
 * @param {string} orgId - Organization ID
 * @param {string} id - Classification ID
 * @param {Object} updates - Fields to update
 * @returns {Promise<Object|null>} Updated classification or null
 */
async function updateAppClassification(orgId, id, updates) {
  const supabase = getClient();
  if (!supabase) {
    throw new Error('Supabase client not initialized');
  }
  
  const { data, error } = await supabase
    .from('application_classifications')
    .update({
      ...updates,
      updated_at: new Date().toISOString()
    })
    .eq('id', id)
    .or(`organization_id.eq.${orgId},organization_id.is.null`)
    .select()
    .single();
  
  if (error) {
    if (error.code === 'PGRST116') {
      return null;
    }
    logger.error('[PortalDB] Update app classification failed', { id, error });
    throw error;
  }
  
  return data;
}

/**
 * Delete application classification.
 * 
 * @param {string} orgId - Organization ID
 * @param {string} id - Classification ID
 * @returns {Promise<boolean>} True if deleted, false if not found
 */
async function deleteAppClassification(orgId, id) {
  const supabase = getClient();
  if (!supabase) {
    throw new Error('Supabase client not initialized');
  }
  
  const { data, error } = await supabase
    .from('application_classifications')
    .delete()
    .eq('id', id)
    .or(`organization_id.eq.${orgId},organization_id.is.null`)
    .select();
  
  if (error) {
    logger.error('[PortalDB] Delete app classification failed', { id, error });
    throw error;
  }
  
  return data && data.length > 0;
}

module.exports = {
  getAdminByEmail,
  getAdminById,
  listAdmins,
  createAdmin,
  updateAdmin,
  deleteAdmin,
  updateLastLogin,
  setPasswordResetToken,
  getAdminsWithActiveResetToken,  // New: for hashed token lookup
  getAdminByResetToken,  // Deprecated: kept for backward compatibility
  clearPasswordResetToken,
  // Application Classifications
  listAppClassifications,
  createAppClassification,
  updateAppClassification,
  deleteAppClassification
};
