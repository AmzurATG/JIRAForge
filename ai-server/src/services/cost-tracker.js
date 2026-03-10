/**
 * Cost Tracker Module for LLM Cost Tracking
 * Logs LLM API costs to Google Sheets (Sheet 2) with user context
 * 
 * This module is designed to be easily removable:
 * - Set ENABLE_COST_TRACKING=false to disable
 * - Remove the import and function calls to completely remove
 * 
 * See COST_TRACKING_HEADERS constant for logged columns (A-P).
 */

const { google } = require('googleapis');
const logger = require('../utils/logger');
const { calculateCost } = require('./sheets-logger');

// Singleton instance
let costTracker = null;

// User details cache to avoid repeated DB calls
const userCache = new Map();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Column headers (single source of truth)
const COST_TRACKING_HEADERS = [
  'TimeStamp',
  'User ID',
  'User Email',
  'User Display Name',
  'Organization ID',
  'API Call Name',
  'Provider',
  'Model Used',
  'Input Tokens',
  'Output Tokens',
  'Total Tokens',
  'Cost (USD)',
  'Request Duration (ms)',
  'Analysis Type',
  'Screenshot ID',
  'Notes'
];

/**
 * Helper to disable cost tracker and return null
 * @param {string} reason - Reason for disabling
 * @param {string} level - Log level ('info' or 'warn')
 * @returns {null}
 */
function disableTracker(reason, level = 'warn') {
  logger[level](`[CostTracker] Disabled (${reason})`);
  costTracker = null;
  return null;
}

/**
 * Get user details from cache or database
 * @param {string} userId - User ID
 * @returns {Promise<Object>} User details { email, display_name }
 */
async function getUserDetails(userId) {
  if (!userId) return { email: null, display_name: null };

  // Check cache first
  const cached = userCache.get(userId);
  if (cached && (Date.now() - cached.timestamp) < CACHE_TTL) {
    return cached.data;
  }

  // Fetch from database
  try {
    const { getUserById } = require('./db/user-db-service');
    const user = await getUserById(userId);
    
    const userDetails = {
      email: user?.email || null,
      display_name: user?.display_name || null
    };

    // Cache the result
    userCache.set(userId, {
      data: userDetails,
      timestamp: Date.now()
    });

    return userDetails;
  } catch (error) {
    logger.warn('[CostTracker] Failed to fetch user details:', error.message);
    return { email: null, display_name: null };
  }
}

/**
 * CostTracker class for logging LLM costs to Google Sheets (Sheet 2)
 */
class CostTracker {
  constructor(config) {
    this.sheetId = config.sheetId;
    this.sheetName = config.sheetName || 'LLM_Cost_Tracking';
    this.credentials = config.credentials;
    this.enabled = config.enabled !== false;
    this._sheets = null;
    this._auth = null;
  }

  /**
   * Check if tracker is properly configured for operations
   * @returns {boolean} True if enabled and sheet ID configured
   */
  _isConfigured() {
    return this.enabled && this.sheetId;
  }

  /**
   * Initialize Google Sheets API client
   */
  async _getSheets() {
    if (this._sheets) return this._sheets;

    try {
      // Parse credentials if string
      let creds = this.credentials;
      if (typeof creds === 'string') {
        creds = JSON.parse(creds);
      }

      // Use GoogleAuth with credentials object
      this._auth = new google.auth.GoogleAuth({
        credentials: {
          client_email: creds.client_email,
          private_key: creds.private_key,
        },
        scopes: ['https://www.googleapis.com/auth/spreadsheets']
      });

      // Create sheets client
      this._sheets = google.sheets({ version: 'v4', auth: this._auth });

      return this._sheets;
    } catch (error) {
      logger.error('[CostTracker] Failed to initialize Google Sheets API:', error.message);
      throw error;
    }
  }

  /**
   * Log cost tracking data to Google Sheets (Sheet 2)
   * 
   * @param {Object} params - Cost tracking parameters
   * @param {string} params.userId - User ID (UUID)
   * @param {string} params.apiCallName - API call name (vision, text, clustering, brd)
   * @param {string} params.provider - Provider ID (portkey-gemini, fireworks)
   * @param {string} params.model - Model name used
   * @param {number} params.inputTokens - Input tokens
   * @param {number} params.outputTokens - Output tokens
   * @param {number} params.cost - Cost (auto-calculated if not provided)
   * @param {number} params.duration - Request duration in ms
   * @param {string} params.organizationId - Organization ID (optional)
   * @param {string} params.screenshotId - Screenshot ID (optional)
   * @param {string} params.notes - Additional notes (optional)
   * @returns {Promise<boolean>} True if logging successful
   */
  async logCost({
    userId,
    apiCallName,
    provider,
    model,
    inputTokens = 0,
    outputTokens = 0,
    cost = null,
    duration = 0,
    organizationId = null,
    screenshotId = null,
    notes = null
  }) {
    if (!this._isConfigured()) {
      logger.debug('[CostTracker] Not configured, skipping cost log');
      return false;
    }

    try {
      const sheets = await this._getSheets();

      // Get user details (with caching)
      const userDetails = await getUserDetails(userId);

      // Calculate cost if not provided
      // Map provider IDs to provider names for cost calculation
      const providerName = provider === 'fireworks'
        ? 'fireworks'
        : 'portkey';
      
      const calculatedCost = cost !== null 
        ? cost 
        : calculateCost(providerName, model, inputTokens, outputTokens);

      const totalTokens = inputTokens + outputTokens;

      // Prepare row data (16 columns: A-P)
      const row = [
        new Date().toISOString().replace('T', ' ').substring(0, 19),  // A: TimeStamp
        userId || '',                                                  // B: User ID
        userDetails.email || '',                                       // C: User Email
        userDetails.display_name || '',                                // D: User Display Name
        organizationId || '',                                           // E: Organization ID
        apiCallName || '',                                             // F: API Call Name
        provider || '',                                                 // G: Provider
        model || '',                                                   // H: Model Used
        inputTokens,                                                   // I: Input Tokens
        outputTokens,                                                  // J: Output Tokens
        totalTokens,                                                   // K: Total Tokens
        calculatedCost,                                                // L: Cost (USD)
        duration,                                                      // M: Request Duration (ms)
        apiCallName || '',                                             // N: Analysis Type
        screenshotId || '',                                           // O: Screenshot ID
        notes || ''                                                    // P: Notes
      ];

      // Append row to sheet
      await sheets.spreadsheets.values.append({
        spreadsheetId: this.sheetId,
        range: `${this.sheetName}!A:P`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        resource: {
          values: [row]
        }
      });

      logger.debug('[CostTracker] Logged cost: %s | %s | %s | in:%d out:%d | $%s',
        apiCallName, provider, model, inputTokens, outputTokens, calculatedCost);

      return true;
    } catch (error) {
      // Don't fail the request if logging fails
      logger.warn('[CostTracker] Failed to log cost:', error.message);
      return false;
    }
  }

  /**
   * Test the connection to Google Sheets
   * @returns {Promise<boolean>} True if connection successful
   */
  async testConnection() {
    if (!this._isConfigured()) return false;

    try {
      const sheets = await this._getSheets();
      await sheets.spreadsheets.get({ spreadsheetId: this.sheetId });
      logger.info('[CostTracker] Connection test successful');
      return true;
    } catch (error) {
      logger.error('[CostTracker] Connection test failed:', error.message);
      return false;
    }
  }

  /**
   * Ensure the sheet has proper headers
   * @returns {Promise<boolean>} True if headers are set
   */
  async ensureHeaders() {
    if (!this._isConfigured()) return false;

    try {
      const sheets = await this._getSheets();
      const headerRange = `${this.sheetName}!A1:P1`;

      // Check if first row has headers
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: this.sheetId,
        range: headerRange
      });

      const existingHeaders = response.data.values?.[0] || [];

      if (existingHeaders.length === 0 || existingHeaders[0] !== COST_TRACKING_HEADERS[0]) {
        await sheets.spreadsheets.values.update({
          spreadsheetId: this.sheetId,
          range: headerRange,
          valueInputOption: 'RAW',
          resource: { values: [COST_TRACKING_HEADERS] }
        });
        logger.info('[CostTracker] Headers created');
      }

      return true;
    } catch (error) {
      logger.warn('[CostTracker] Failed to ensure headers:', error.message);
      return false;
    }
  }
}

/**
 * Initialize the cost tracker singleton
 * Call this once at application startup
 */
function initializeCostTracker() {
  const enabled = process.env.ENABLE_COST_TRACKING === 'true';
  const sheetId = process.env.GOOGLE_SHEET_COST_SHEET_ID;
  const sheetName = process.env.GOOGLE_SHEET_COST_TRACKING_TAB || 'LLM_Cost_Tracking';
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;

  // Validate required configuration
  if (!enabled) return disableTracker('ENABLE_COST_TRACKING != true', 'info');
  if (!sheetId) return disableTracker('GOOGLE_SHEET_COST_SHEET_ID not configured');
  if (!credentials) return disableTracker('GOOGLE_SERVICE_ACCOUNT_JSON not configured');

  try {
    costTracker = new CostTracker({
      sheetId,
      sheetName,
      credentials,
      enabled: true
    });

    logger.info('[CostTracker] Initialized | Sheet: %s | Tab: %s', sheetId, sheetName);

    // Test connection and ensure headers (async, don't block startup)
    costTracker.testConnection().then(success => {
      if (success) {
        costTracker.ensureHeaders();
      }
    });

    return costTracker;
  } catch (error) {
    logger.error('[CostTracker] Failed to initialize:', error.message);
    costTracker = null;
    return null;
  }
}

/**
 * Get the cost tracker instance
 * @returns {CostTracker|null} The tracker instance or null if not initialized
 */
function getCostTracker() {
  return costTracker;
}

/**
 * Log cost tracking (convenience function)
 * @param {Object} params - See CostTracker.logCost
 * @returns {Promise<boolean>} True if logging successful
 */
async function logCostTracking(params) {
  if (!costTracker) {
    return false;
  }
  return costTracker.logCost(params);
}

module.exports = {
  CostTracker,
  initializeCostTracker,
  getCostTracker,
  logCostTracking
};
