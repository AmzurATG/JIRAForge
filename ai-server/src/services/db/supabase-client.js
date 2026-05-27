/**
 * Supabase Client Module
 * Centralized Supabase client initialization and management
 */

const { createClient } = require('@supabase/supabase-js');
const logger = require('../../utils/logger');

let supabaseClient = null;

/**
 * Initialize the Supabase client
 * Called once at application startup
 */
function initializeClient() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
    logger.error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set');
    return null;
  }

  try {
    // Increase timeout for slow queries (default 60s -> 180s)
    const timeout = parseInt(process.env.SUPABASE_QUERY_TIMEOUT) || 180000;
    
    supabaseClient = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_ROLE_KEY,
      {
        db: {
          schema: 'public'
        },
        global: {
          headers: {
            'x-client-info': 'ai-server'
          }
        },
        auth: {
          persistSession: false
        },
        // Increase fetch timeout for large queries
        realtime: {
          timeout: timeout
        }
      }
    );
    logger.info(`Supabase client initialized successfully (timeout: ${timeout}ms)`);
    return supabaseClient;
  } catch (error) {
    logger.error('Failed to initialize Supabase client:', error);
    return null;
  }
}

/**
 * Get the Supabase client instance
 * @returns {Object|null} Supabase client or null if not initialized
 */
function getClient() {
  if (!supabaseClient) {
    // Lazy initialization
    return initializeClient();
  }
  return supabaseClient;
}

/**
 * Check if a database error is a network error
 * Network errors are expected in corporate environments and should be handled gracefully
 * @param {Error} error - Error object
 * @returns {boolean} True if it's a network error
 */
function isNetworkError(error) {
  const errorMessage = error?.message || '';
  return (
    errorMessage.includes('ENOTFOUND') ||
    errorMessage.includes('ECONNREFUSED') ||
    errorMessage.includes('ETIMEDOUT') ||
    errorMessage.includes('timeout') ||
    errorMessage.includes('certificate') ||
    errorMessage.includes('fetch failed')
  );
}

module.exports = {
  initializeClient,
  getClient,
  isNetworkError
};
