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
    .eq('org_id', orgId)
    .eq('id', userId)
    .single();
    
  if (error) {
    if (error.code === 'PGRST116') {
      return null;
    }
    logger.error('[PortalDB] Get admin by ID failed', { orgId, userId, error });
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
  
  // Get total count
  const { count, error: countError } = await supabase
    .from('portal_admin_users')
    .select('*', { count: 'exact', head: true })
    .eq('org_id', orgId);
    
  if (countError) {
    logger.error('[PortalDB] Count admins failed', { orgId, error: countError });
    throw countError;
  }
  
  // Get paginated data
  const { data, error } = await supabase
    .from('portal_admin_users')
    .select('id, email, display_name, role, created_at, last_login_at')
    .eq('org_id', orgId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
    
  if (error) {
    logger.error('[PortalDB] List admins failed', { orgId, error });
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
    .eq('org_id', orgId)
    .eq('id', userId)
    .select()
    .single();
    
  if (error) {
    logger.error('[PortalDB] Update admin failed', { orgId, userId, error });
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
    .eq('org_id', orgId)
    .eq('id', userId);
    
  if (error) {
    logger.error('[PortalDB] Delete admin failed', { orgId, userId, error });
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
    .eq('org_id', orgId)
    .eq('id', userId);
    
  if (error) {
    logger.error('[PortalDB] Update last login failed', { orgId, userId, error });
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
    .eq('org_id', orgId)
    .eq('id', userId);
    
  if (error) {
    logger.error('[PortalDB] Set password reset token failed', { orgId, userId, error });
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
  clearPasswordResetToken
};
