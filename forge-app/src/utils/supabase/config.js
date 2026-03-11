/**
 * Supabase Configuration and Request Utilities
 * Core functions for Supabase connectivity
 *
 * NOTE: This module now provides backward-compatible stubs.
 * All Supabase operations are routed through the AI server via Forge Remote.
 * Credentials are stored securely on the AI server, not in Forge storage.
 */

import { supabaseQuery } from '../remote.js';

/**
 * Get Supabase client configuration
 * @deprecated Credentials are now managed by the AI server
 * @param {string} accountId - Atlassian account ID (ignored)
 * @returns {Promise<Object>} Placeholder config indicating remote mode
 */
export async function getSupabaseConfig(accountId) {
  // Return a placeholder to indicate the app is configured
  // Actual credentials are stored securely on the AI server
  return {
    url: 'remote:ai-server',
    serviceRoleKey: 'managed-by-ai-server',
    anonKey: 'managed-by-ai-server',
    isRemoteMode: true
  };
}

/**
 * Parse order parameter from query string
 * @param {string} value - Order value (e.g., 'column.desc')
 * @returns {Object} Parsed order object with column and ascending
 */
function parseOrderParam(value) {
  const dotIndex = value.lastIndexOf('.');
  if (dotIndex > 0) {
    const column = value.substring(0, dotIndex);
    const direction = value.substring(dotIndex + 1);
    return { column, ascending: direction !== 'desc' };
  }
  // No direction specified, default to ascending
  return { column: value, ascending: true };
}

/**
 * Parse a filter value in Supabase format (e.g., "eq.123", "in.(a,b,c)")
 * @param {string} key - Filter key/column name
 * @param {string} value - Filter value with operator prefix
 * @param {Object} query - Query object to populate
 */
function parseFilterValue(key, value, query) {
  const match = value.match(/^(eq|neq|gt|gte|lt|lte|in|is|not\.is|ilike)\.(.+)$/);
  
  if (!match) {
    // Simple equality
    if (!query.eq) query.eq = {};
    query.eq[key] = value;
    return;
  }

  const [, operator, val] = match;

  // Handle "not.is" operator specially (e.g., active_task_key=not.is.null)
  if (operator === 'not.is') {
    if (!query.not) query.not = {};
    query.not[key] = { operator: 'is', value: val === 'null' ? null : val };
    return;
  }

  if (!query[operator]) query[operator] = {};

  // Handle 'in' operator which expects an array
  if (operator === 'in') {
    query[operator][key] = val.replaceAll(/[()]/g, '').split(',');
    return;
  }

  // Handle 'is' with null value
  if (operator === 'is' && val === 'null') {
    query[operator][key] = null;
    return;
  }

  // All other operators
  query[operator][key] = val;
}

/**
 * Handle special query parameters (order, limit, offset, select, or)
 * @param {string} key - Parameter key
 * @param {string} value - Parameter value
 * @param {Object} query - Query object to populate
 * @returns {boolean} true if handled as special parameter
 */
function handleSpecialParam(key, value, query) {
  switch (key) {
    case 'order':
      query.order = parseOrderParam(value);
      return true;
    case 'limit':
      query.limit = Number.parseInt(value, 10);
      return true;
    case 'offset':
      query.offset = Number.parseInt(value, 10);
      return true;
    case 'select':
      query._select = value;
      return true;
    case 'or':
      query.or = value.replaceAll(/^\(|\)$/g, '');
      return true;
    default:
      return false;
  }
}

/**
 * Parse query string into filter object
 * @param {string} queryString - URL query string
 * @returns {Object} Parsed query object
 */
function parseQueryString(queryString) {
  const query = {};
  
  if (!queryString) {
    return query;
  }

  const params = new URLSearchParams(queryString);
  for (const [key, value] of params.entries()) {
    // Try special parameters first
    if (handleSpecialParam(key, value, query)) {
      continue;
    }
    // Otherwise parse as filter value
    parseFilterValue(key, value, query);
  }

  return query;
}

/**
 * Make a request to Supabase via the AI server
 * @deprecated Use supabaseQuery from remote.js instead
 * @param {Object} supabaseConfig - Supabase configuration (ignored in remote mode)
 * @param {string} endpoint - API endpoint (e.g., 'screenshots', 'users?id=eq.123')
 * @param {Object} options - Request options (method, body, headers)
 * @returns {Promise<Object>} Response data
 */
export async function supabaseRequest(supabaseConfig, endpoint, options = {}) {
  // Parse the endpoint to extract table and query parameters
  const [table, queryString] = endpoint.split('?');
  
  // Parse query string into filter object
  const query = parseQueryString(queryString);

  // Parse select from headers if present
  const select = options.headers?.Prefer?.includes('return=representation') ? '*' : undefined;

  // Map HTTP methods to query methods
  const method = options.method || 'GET';

  try {
    const result = await supabaseQuery(table, {
      method,
      query,
      body: options.body,
      select
    });

    return result;
  } catch (error) {
    console.error('[Supabase] Remote request failed:', error);
    throw error;
  }
}
