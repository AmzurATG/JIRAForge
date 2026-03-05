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
 * Make a request to Supabase via the AI server
 * @deprecated Use supabaseQuery from remote.js instead
 * @param {Object} supabaseConfig - Supabase configuration (ignored in remote mode)
 * @param {string} endpoint - API endpoint (e.g., 'screenshots', 'users?id=eq.123')
 * @param {Object} options - Request options (method, body, headers)
 * @returns {Promise<Object>} Response data
 */
export async function supabaseRequest(supabaseConfig, endpoint, options = {}) {
  // Parse the endpoint to extract table and query parameters
  const [tablePart, queryString] = endpoint.split('?');
  const table = tablePart;

  // Parse query string into filter object
  const query = {};
  if (queryString) {
    const params = new URLSearchParams(queryString);
    for (const [key, value] of params.entries()) {
      // Handle special query parameters first
      if (key === 'order') {
        // Parse order format: column.direction (e.g., work_date.desc)
        const dotIndex = value.lastIndexOf('.');
        if (dotIndex > 0) {
          const column = value.substring(0, dotIndex);
          const direction = value.substring(dotIndex + 1);
          query.order = {
            column,
            ascending: direction !== 'desc'
          };
        } else {
          // No direction specified, default to ascending
          query.order = { column: value, ascending: true };
        }
        continue;
      }
      if (key === 'limit') {
        query.limit = parseInt(value, 10);
        continue;
      }
      if (key === 'offset') {
        query.offset = parseInt(value, 10);
        continue;
      }
      if (key === 'select') {
        // Store select for later use - will be used by supabaseQuery
        query._select = value;
        continue;
      }

      // Handle OR filter (e.g., "or=(col1.eq.val,col2.eq.val)")
      if (key === 'or') {
        query.or = value.replace(/^\(|\)$/g, '');
        continue;
      }

      // Parse Supabase filter format (e.g., "id=eq.123")
      const match = value.match(/^(eq|neq|gt|gte|lt|lte|in|is|not\.is)\.(.+)$/);
      if (match) {
        const [, operator, val] = match;

        // Handle "not.is" operator specially (e.g., active_task_key=not.is.null)
        if (operator === 'not.is') {
          if (!query.not) query.not = {};
          query.not[key] = { operator: 'is', value: val === 'null' ? null : val };
          continue;
        }

        if (!query[operator]) query[operator] = {};
        // Handle 'in' operator which expects an array
        if (operator === 'in') {
          query[operator][key] = val.replace(/[()]/g, '').split(',');
        } else if (operator === 'is' && val === 'null') {
          query[operator][key] = null;
        } else {
          query[operator][key] = val;
        }
      } else {
        // Simple equality
        if (!query.eq) query.eq = {};
        query.eq[key] = value;
      }
    }
  }

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
