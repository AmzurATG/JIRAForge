/**
 * Shared Helper Functions for Unassigned Work Resolvers
 * Extracted to reduce duplication across sessionResolvers.js and assignmentResolvers.js
 */

import { getSupabaseConfig, getOrCreateUser, getOrCreateOrganization } from '../../utils/supabase.js';

/**
 * Initialize request context with Supabase config, organization, and user
 * @param {Object} req - Request object with context
 * @returns {Promise<{success: boolean, error?: string, config?: Object, organization?: Object, userId?: string, accountId?: string, cloudId?: string}>}
 */
export async function initializeRequestContext(req) {
  const { accountId, cloudId } = req.context;

  const supabaseConfig = await getSupabaseConfig(accountId);
  if (!supabaseConfig) {
    return { success: false, error: 'Supabase not configured' };
  }

  const organization = await getOrCreateOrganization(cloudId, supabaseConfig);
  if (!organization) {
    return { success: false, error: 'Unable to get organization information' };
  }

  const userId = await getOrCreateUser(accountId, supabaseConfig, organization.id);

  return {
    success: true,
    config: supabaseConfig,
    organization,
    userId,
    accountId,
    cloudId
  };
}

/**
 * Handle resolver errors consistently
 * @param {Error} error - The caught error
 * @param {string} operation - Description of the operation that failed
 * @returns {{success: boolean, error: string}}
 */
export function handleResolverError(error, operation) {
  console.error(`Error ${operation}:`, error);
  return { success: false, error: error.message };
}

/**
 * Ensure a value is an array (normalize single values or null to array)
 * @param {*} value - Value to normalize
 * @returns {Array}
 */
export function ensureArray(value) {
  if (Array.isArray(value)) return value;
  return value ? [value] : [];
}
