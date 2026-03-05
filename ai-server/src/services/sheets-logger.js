/**
 * Google Sheets Logger for LLM API Usage Tracking
 * Logs AI API calls to a Google Sheet for cost tracking and monitoring
 *
 * Columns logged:
 * - TimeStamp
 * - Employee Name
 * - IP Address
 * - Project Name
 * - API call name
 * - API account email
 * - Provider (Fireworks/Portkey)
 * - Model Used
 * - Input token size
 * - Output token size
 * - Cost incurred
 */

const { google } = require('googleapis');
const logger = require('../utils/logger');
const os = require('node:os');

// Singleton instance
let sheetsLogger = null;

/**
 * Get the machine's IP address
 * @returns {string} IP address or 'Unknown'
 */
function getIpAddress() {
  try {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
      for (const iface of interfaces[name]) {
        // Skip internal and IPv6 addresses
        if (!iface.internal && iface.family === 'IPv4') {
          return iface.address;
        }
      }
    }
    return os.hostname();
  } catch (error) {
    logger.error('[SheetsLogger] Failed to get IP address:', error);
    return 'Unknown';
  }
}

/**
 * Calculate cost based on provider and token usage
 * Pricing as of Dec 2024 (per 1M tokens):
 * - Fireworks Qwen2.5-VL-32B: $0.40 input, $0.40 output (estimated)
 * - Gemini 2.0 Flash: $0.10 input, $0.40 output (Google pricing via Portkey)
 */
function calculateCost(provider, model, inputTokens, outputTokens) {
  // Pricing per 1M tokens
  const pricing = {
    fireworks: {
      'qwen2p5-vl-32b': { input: 0.4, output: 0.4 },
      'qwen2p5-vl-72b': { input: 0.9, output: 0.9 },
      'llama-v3p2-11b-vision': { input: 0.2, output: 0.2 },
      'default': { input: 0.5, output: 0.5 }
    },
    portkey: {
      // Gemini models (primary via google-key1 / google-key2)
      'gemini-2.0-flash-lite': { input: 0.075, output: 0.3 },
      'gemini-2.0-flash': { input: 0.1, output: 0.4 },
      'gemini-1.5-flash': { input: 0.075, output: 0.3 },
      'gemini-1.5-pro': { input: 1.25, output: 5 },
      // OpenAI models (fallback via openai-key1 / openai-key2)
      'gpt-4o': { input: 5, output: 15 },
      'gpt-4o-mini': { input: 0.15, output: 0.6 },
      'default': { input: 0.1, output: 0.4 }
    }
  };

  // Get pricing for provider
  const providerPricing = pricing[provider.toLowerCase()] || pricing.fireworks;

  // Find matching model pricing
  let modelPricing = providerPricing.default;
  for (const [modelKey, price] of Object.entries(providerPricing)) {
    if (modelKey !== 'default' && model.toLowerCase().includes(modelKey)) {
      modelPricing = price;
      break;
    }
  }

  // Calculate cost (pricing is per 1M tokens)
  const inputCost = (inputTokens / 1000000) * modelPricing.input;
  const outputCost = (outputTokens / 1000000) * modelPricing.output;

  return Number.parseFloat((inputCost + outputCost).toFixed(6));
}

/**
 * SheetsLogger class for logging LLM API calls to Google Sheets
 */
class SheetsLogger {
  constructor(config) {
    this.sheetId = config.sheetId;
    this.sheetName = config.sheetName || 'LLM_Calls_Log';
    this.credentials = config.credentials;
    this.enabled = config.enabled !== false;
    this.projectName = config.projectName || 'Jira AI Server';
    this.employeeName = config.employeeName || 'AI Server';
    this.apiAccountEmail = config.apiAccountEmail || process.env.SHEETS_API_ACCOUNT_EMAIL || 'ai-server@amzur.com';
    this._sheets = null;
    this._auth = null;
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

      // Use GoogleAuth with credentials object (works better with Node.js 17+ / OpenSSL 3.0)
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
      logger.error('[SheetsLogger] Failed to initialize Google Sheets API:', error.message);
      throw error;
    }
  }

  /**
   * Log an LLM API request to Google Sheets
   *
   * @param {Object} params - Log parameters
   * @param {string} params.apiCallName - Name/type of the API call (vision, text, clustering, brd)
   * @param {string} params.provider - AI provider (fireworks, litellm)
   * @param {string} params.model - Model name used
   * @param {number} params.inputTokens - Number of input tokens
   * @param {number} params.outputTokens - Number of output tokens
   * @param {number} params.cost - Cost incurred (auto-calculated if not provided)
   * @param {string} params.employeeName - Employee name (optional override)
   * @param {string} params.projectName - Project name (optional override)
   * @returns {Promise<boolean>} True if logging successful
   */
  async logRequest({
    apiCallName,
    provider,
    model,
    inputTokens = 0,
    outputTokens = 0,
    cost = null,
    employeeName = null,
    projectName = null
  }) {
    if (this.enabled && this.sheetId) {
      try {
        const sheets = await this._getSheets();

        // Calculate cost if not provided
        const calculatedCost = cost !== null ? cost : calculateCost(provider, model, inputTokens, outputTokens);

        // Prepare row data
        const row = [
          new Date().toISOString().replace('T', ' ').substring(0, 19),  // TimeStamp
          employeeName || this.employeeName,                            // Employee Name
          getIpAddress(),                                               // IP Address
          projectName || this.projectName,                              // Project Name
          apiCallName,                                                  // API call name
          this.apiAccountEmail,                                         // API account email
          provider,                                                     // Provider
          model,                                                        // Model Used
          inputTokens,                                                  // Input token size
          outputTokens,                                                 // Output token size
          calculatedCost                                                // Cost incurred
        ];

        // Append row to sheet
        await sheets.spreadsheets.values.append({
          spreadsheetId: this.sheetId,
          range: `${this.sheetName}!A:K`,
          valueInputOption: 'RAW',
          insertDataOption: 'INSERT_ROWS',
          resource: {
            values: [row]
          }
        });

        logger.debug('[SheetsLogger] Logged: %s | %s | %s | in:%d out:%d | $%s',
          apiCallName, provider, model, inputTokens, outputTokens, calculatedCost);

        return true;
      } catch (error) {
        // Don't fail the request if logging fails
        logger.warn('[SheetsLogger] Failed to log request:', error.message);
        return false;
      }
    } else {
      if (!this.enabled) {
        logger.debug('[SheetsLogger] Logging disabled, skipping');
      } else if (!this.sheetId) {
        logger.debug('[SheetsLogger] No sheet ID configured, skipping');
      }
      return false;
    }
  }

  /**
   * Test the connection to Google Sheets
   * @returns {Promise<boolean>} True if connection successful
   */
  async testConnection() {
    if (!this.enabled || !this.sheetId) {
      return false;
    }

    try {
      const sheets = await this._getSheets();
      await sheets.spreadsheets.get({
        spreadsheetId: this.sheetId
      });
      logger.info('[SheetsLogger] Connection test successful');
      return true;
    } catch (error) {
      logger.error('[SheetsLogger] Connection test failed:', error.message);
      return false;
    }
  }

  /**
   * Ensure the sheet has proper headers
   * @returns {Promise<boolean>} True if headers are set
   */
  async ensureHeaders() {
    if (!this.enabled || !this.sheetId) {
      return false;
    }

    try {
      const sheets = await this._getSheets();

      // Check if first row has headers
      const response = await sheets.spreadsheets.values.get({
        spreadsheetId: this.sheetId,
        range: `${this.sheetName}!A1:K1`
      });

      const existingHeaders = response.data.values?.[0] || [];

      if (existingHeaders.length === 0 || existingHeaders[0] !== 'TimeStamp') {
        // Set headers
        const headers = [
          'TimeStamp',
          'Employee Name',
          'IP Address',
          'Project Name',
          'API call name',
          'API account email',
          'Provider',
          'Model Used',
          'Input token size',
          'Output token size',
          'Cost incurred'
        ];

        await sheets.spreadsheets.values.update({
          spreadsheetId: this.sheetId,
          range: `${this.sheetName}!A1:K1`,
          valueInputOption: 'RAW',
          resource: {
            values: [headers]
          }
        });

        logger.info('[SheetsLogger] Headers created');
      }

      return true;
    } catch (error) {
      logger.warn('[SheetsLogger] Failed to ensure headers:', error.message);
      return false;
    }
  }
}

/**
 * Initialize the sheets logger singleton
 * Call this once at application startup
 */
function initializeSheetsLogger() {
  const enabled = process.env.SHEETS_LOGGING_ENABLED === 'true';
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const sheetName = process.env.GOOGLE_SHEET_NAME || 'LLM_Calls_Log';
  const credentials = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const projectName = process.env.SHEETS_PROJECT_NAME || 'Jira AI Server';
  const employeeName = process.env.SHEETS_EMPLOYEE_NAME || 'AI Server';
  const apiAccountEmail = process.env.SHEETS_API_ACCOUNT_EMAIL || 'ai-server@amzur.com';

  if (!enabled) {
    logger.info('[SheetsLogger] Disabled (SHEETS_LOGGING_ENABLED != true)');
    sheetsLogger = null;
    return null;
  }

  if (!sheetId) {
    logger.warn('[SheetsLogger] Disabled (GOOGLE_SHEET_ID not configured)');
    sheetsLogger = null;
    return null;
  }

  if (!credentials) {
    logger.warn('[SheetsLogger] Disabled (GOOGLE_SERVICE_ACCOUNT_JSON not configured)');
    sheetsLogger = null;
    return null;
  }

  try {
    sheetsLogger = new SheetsLogger({
      sheetId,
      sheetName,
      credentials,
      projectName,
      employeeName,
      apiAccountEmail,
      enabled: true
    });

    logger.info('[SheetsLogger] Initialized | Sheet: %s | Tab: %s', sheetId, sheetName);

    // Test connection and ensure headers (async, don't block startup)
    sheetsLogger.testConnection().then(success => {
      if (success) {
        sheetsLogger.ensureHeaders();
      }
    });

    return sheetsLogger;
  } catch (error) {
    logger.error('[SheetsLogger] Failed to initialize:', error.message);
    sheetsLogger = null;
    return null;
  }
}

/**
 * Get the sheets logger instance
 * @returns {SheetsLogger|null} The logger instance or null if not initialized
 */
function getSheetsLogger() {
  return sheetsLogger;
}

/**
 * Log an LLM API request (convenience function)
 * @param {Object} params - See SheetsLogger.logRequest
 * @returns {Promise<boolean>} True if logging successful
 */
async function logLLMRequest(params) {
  if (!sheetsLogger) {
    return false;
  }
  return sheetsLogger.logRequest(params);
}

module.exports = {
  SheetsLogger,
  initializeSheetsLogger,
  getSheetsLogger,
  logLLMRequest,
  calculateCost,
  getIpAddress
};
