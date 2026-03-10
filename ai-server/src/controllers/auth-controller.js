/**
 * Auth Controller
 * Handles secure token exchange for desktop app
 *
 * Endpoints:
 * - POST /api/auth/atlassian/callback - Exchange OAuth code for tokens
 * - POST /api/auth/exchange-token - Mint Supabase JWT from Atlassian token
 * - POST /api/auth/refresh-token - Refresh Atlassian access token
 */

const axios = require('axios');
const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');
const { getClient } = require('../services/db/supabase-client');

// Atlassian OAuth configuration
const ATLASSIAN_TOKEN_URL = 'https://auth.atlassian.com/oauth/token';
const ATLASSIAN_ME_URL = 'https://api.atlassian.com/me';

// ============================================================================
// Helper Functions (extracted to reduce duplication)
// ============================================================================

/**
 * Get Atlassian OAuth credentials from environment
 * @returns {{ clientId: string|undefined, clientSecret: string|undefined }}
 */
function getAtlassianCredentials() {
  return {
    clientId: process.env.ATLASSIAN_CLIENT_ID,
    clientSecret: process.env.ATLASSIAN_CLIENT_SECRET
  };
}

/**
 * Check if Atlassian credentials are configured
 * @param {Object} res - Express response object
 * @returns {boolean} True if credentials are valid, false if error response sent
 */
function validateAtlassianCredentials(res) {
  const { clientId, clientSecret } = getAtlassianCredentials();
  if (!clientId || !clientSecret) {
    logger.error('[Auth] Atlassian credentials not configured on server');
    res.status(500).json({
      success: false,
      error: 'Server configuration error - Atlassian credentials not configured'
    });
    return false;
  }
  return true;
}

/**
 * Verify Atlassian token and fetch user info
 * @param {string} atlassianToken - Atlassian bearer token
 * @returns {Promise<Object>} User info from Atlassian
 * @throws {Error} If token is invalid or request fails
 */
async function verifyAtlassianToken(atlassianToken) {
  const userResponse = await axios.get(ATLASSIAN_ME_URL, {
    headers: {
      'Authorization': `Bearer ${atlassianToken}`,
      'Accept': 'application/json'
    },
    timeout: 10000
  });
  return userResponse.data;
}

/**
 * Verify Atlassian token and return user, or send error response
 * @param {string} atlassianToken - Atlassian bearer token
 * @param {Object} res - Express response object
 * @param {string} context - Context for logging (e.g., 'Supabase config', 'OCR config')
 * @returns {Promise<Object|null>} User info or null if error response sent
 */
async function verifyAtlassianTokenOrRespond(atlassianToken, res, context = '') {
  try {
    return await verifyAtlassianToken(atlassianToken);
  } catch (error) {
    const logContext = context ? ` for ${context}` : '';
    logger.warn(`[Auth] Invalid Atlassian token${logContext}:`, error.response?.status);
    res.status(401).json({
      success: false,
      error: 'Invalid or expired Atlassian token'
    });
    return null;
  }
}

/**
 * Lookup user in database by Atlassian account ID
 * @param {string} atlassianAccountId - Atlassian account ID
 * @returns {Promise<{user: Object|null, error: Object|null}>}
 */
async function lookupUserByAtlassianId(atlassianAccountId) {
  const supabase = getClient();
  if (!supabase) {
    return { user: null, error: { type: 'no_client' } };
  }

  const { data: dbUser, error: dbError } = await supabase
    .from('users')
    .select('id, organization_id')
    .eq('atlassian_account_id', atlassianAccountId)
    .single();

  if (dbError || !dbUser) {
    return { user: null, error: { type: 'not_found' } };
  }

  if (!dbUser.organization_id) {
    return { user: dbUser, error: { type: 'no_org' } };
  }

  return { user: dbUser, error: null };
}

/**
 * Lookup user and send appropriate error response if not found
 * @param {string} atlassianAccountId - Atlassian account ID
 * @param {Object} res - Express response object
 * @param {string} context - Context for logging
 * @returns {Promise<Object|null>} User object or null if error response sent
 */
async function lookupUserOrRespond(atlassianAccountId, res, context = '') {
  const { user, error } = await lookupUserByAtlassianId(atlassianAccountId);
  const logSuffix = context ? ` for ${context}` : '';

  if (error?.type === 'no_client') {
    logger.error(`[Auth] Supabase client not available for user lookup${logSuffix}`);
    res.status(500).json({
      success: false,
      error: 'Server configuration error - database not available'
    });
    return null;
  }

  if (error?.type === 'not_found') {
    logger.warn(`[Auth] User not found in system${logSuffix}: %s`, atlassianAccountId);
    res.status(403).json({
      success: false,
      error: 'Access denied. Your Jira account is not associated with an organization that has the Forge app installed. Please contact your administrator to install the app.'
    });
    return null;
  }

  if (error?.type === 'no_org') {
    logger.warn(`[Auth] User has no organization${logSuffix}: %s`, atlassianAccountId);
    res.status(403).json({
      success: false,
      error: 'Access denied. Your account is not associated with an organization. Please contact your administrator.'
    });
    return null;
  }

  logger.info(`[Auth] User validated in system${logSuffix}: %s (org: %s)`, atlassianAccountId, user.organization_id);
  return user;
}

/**
 * Validate required request body field
 * @param {Object} req - Express request object
 * @param {Object} res - Express response object
 * @param {string} fieldName - Field name to validate
 * @param {string} errorMessage - Error message if missing
 * @returns {boolean} True if valid, false if error response sent
 */
function validateRequiredField(req, res, fieldName, errorMessage) {
  if (!req.body?.[fieldName]) {
    res.status(400).json({
      success: false,
      error: errorMessage
    });
    return false;
  }
  return true;
}

/**
 * Format Atlassian API error message
 * @param {Error} error - Axios error object
 * @returns {string} Formatted error message
 */
function formatAtlassianError(error) {
  return error.response?.data?.error_description ||
         error.response?.data?.error ||
         error.message;
}

// ============================================================================
// Route Handlers
// ============================================================================

/**
 * Exchange Atlassian OAuth code for tokens (with PKCE support)
 * This endpoint replaces the desktop app's direct call to Atlassian
 *
 * POST /api/auth/atlassian/callback
 * Body: { code: string, redirect_uri: string, code_verifier?: string }
 *
 * PKCE (RFC 7636): If code_verifier is provided, it will be included in the
 * token exchange request to Atlassian for enhanced security.
 */
exports.atlassianCallback = async (req, res) => {
  try {
    const { code, redirect_uri, code_verifier } = req.body;

    if (!validateRequiredField(req, res, 'code', 'Authorization code is required')) return;
    if (!validateRequiredField(req, res, 'redirect_uri', 'Redirect URI is required')) return;
    if (!validateAtlassianCredentials(res)) return;

    const { clientId, clientSecret } = getAtlassianCredentials();

    // Build token request payload
    const tokenRequestPayload = {
      grant_type: 'authorization_code',
      client_id: clientId,
      client_secret: clientSecret,
      code: code,
      redirect_uri: redirect_uri
    };

    // PKCE: Include code_verifier if provided (required for PKCE flow)
    if (code_verifier) {
      tokenRequestPayload.code_verifier = code_verifier;
      logger.info('[Auth] Exchanging OAuth code for tokens (with PKCE)');
    } else {
      logger.info('[Auth] Exchanging OAuth code for tokens (without PKCE - legacy flow)');
    }

    const tokenResponse = await axios.post(
      ATLASSIAN_TOKEN_URL,
      tokenRequestPayload,
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );

    const tokens = tokenResponse.data;

    logger.info('[Auth] Successfully exchanged code for tokens');

    // Return tokens to desktop app
    res.json({
      success: true,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expires_in: tokens.expires_in,
      token_type: tokens.token_type
    });

  } catch (error) {
    logger.error('[Auth] Atlassian callback error:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({
      success: false,
      error: `Token exchange failed: ${formatAtlassianError(error)}`
    });
  }
};

/**
 * Refresh Atlassian access token using refresh token
 *
 * POST /api/auth/refresh-token
 * Body: { refresh_token: string }
 */
exports.refreshToken = async (req, res) => {
  try {
    const { refresh_token } = req.body;

    if (!validateRequiredField(req, res, 'refresh_token', 'Refresh token is required')) return;
    if (!validateAtlassianCredentials(res)) return;

    const { clientId, clientSecret } = getAtlassianCredentials();

    // Refresh the token with Atlassian
    logger.info('[Auth] Refreshing Atlassian access token');

    const tokenResponse = await axios.post(
      ATLASSIAN_TOKEN_URL,
      {
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refresh_token
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 30000
      }
    );

    const tokens = tokenResponse.data;

    logger.info('[Auth] Successfully refreshed access token');

    res.json({
      success: true,
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token || refresh_token, // Atlassian may or may not return new refresh token
      expires_in: tokens.expires_in,
      token_type: tokens.token_type
    });

  } catch (error) {
    logger.error('[Auth] Token refresh error:', error.response?.data || error.message);

    // Check if refresh token is expired/invalid
    if (error.response?.status === 400 || error.response?.status === 401) {
      return res.status(401).json({
        success: false,
        error: 'Refresh token expired or invalid. User must re-authenticate.',
        requiresReauth: true
      });
    }

    res.status(error.response?.status || 500).json({
      success: false,
      error: `Token refresh failed: ${formatAtlassianError(error)}`
    });
  }
};

/**
 * Exchange Atlassian token for Supabase JWT
 * This allows desktop app to access Supabase with user-scoped permissions
 *
 * POST /api/auth/exchange-token
 * Body: { atlassian_token: string }
 */
exports.exchangeToken = async (req, res) => {
  try {
    const { atlassian_token } = req.body;

    if (!validateRequiredField(req, res, 'atlassian_token', 'Atlassian token is required')) return;

    // Get Supabase JWT secret from environment
    const supabaseJwtSecret = process.env.SUPABASE_JWT_SECRET;
    const supabaseUrl = process.env.SUPABASE_URL;

    if (!supabaseJwtSecret) {
      logger.error('[Auth] SUPABASE_JWT_SECRET not configured');
      return res.status(500).json({
        success: false,
        error: 'Server configuration error - JWT secret not configured'
      });
    }

    // Verify the Atlassian token by fetching user info
    logger.info('[Auth] Verifying Atlassian token');
    const atlassianUser = await verifyAtlassianTokenOrRespond(atlassian_token, res);
    if (!atlassianUser) return;

    // Extract user identifier from Atlassian
    const atlassianAccountId = atlassianUser.account_id;
    const email = atlassianUser.email;

    if (!atlassianAccountId) {
      return res.status(400).json({
        success: false,
        error: 'Could not retrieve Atlassian account ID'
      });
    }

    logger.info('[Auth] Atlassian user verified: %s', atlassianAccountId);

    // Verify user exists in our system (registered via Forge app)
    const dbUser = await lookupUserOrRespond(atlassianAccountId, res);
    if (!dbUser) return;

    // Extract Supabase reference from URL (e.g., jvijitdewbypqbatfboi from https://jvijitdewbypqbatfboi.supabase.co)
    const supabaseRefMatch = supabaseUrl ? /https:\/\/([^.]+)\.supabase\.co/.exec(supabaseUrl) : null;
    const supabaseRef = supabaseRefMatch?.[1] || null;

    // Mint a custom Supabase JWT for this user
    // This JWT will be used for RLS (Row Level Security) in Supabase
    const now = Math.floor(Date.now() / 1000);
    const expiresIn = 3600; // 1 hour

    const payload = {
      // Standard JWT claims
      iss: 'supabase',
      ref: supabaseRef || 'jvijitdewbypqbatfboi',
      role: 'authenticated',
      iat: now,
      exp: now + expiresIn,

      // Supabase auth claims
      aud: 'authenticated',
      sub: atlassianAccountId, // Use Atlassian account ID as subject

      // Custom claims for RLS policies
      atlassian_account_id: atlassianAccountId,
      email: email,

      // App metadata
      app_metadata: {
        provider: 'atlassian',
        providers: ['atlassian']
      },

      // User metadata
      user_metadata: {
        atlassian_account_id: atlassianAccountId,
        email: email,
        name: atlassianUser.name || atlassianUser.display_name
      }
    };

    // Sign the JWT
    const supabaseToken = jwt.sign(payload, supabaseJwtSecret, {
      algorithm: 'HS256'
    });

    logger.info('[Auth] Minted Supabase JWT for user: %s (expires in %ds)', atlassianAccountId, expiresIn);

    res.json({
      success: true,
      supabase_token: supabaseToken,
      expires_in: expiresIn,
      user: {
        id: dbUser.id,
        atlassian_account_id: atlassianAccountId,
        email: email,
        organization_id: dbUser.organization_id
      }
    });

  } catch (error) {
    logger.error('[Auth] Token exchange error:', error);
    res.status(500).json({
      success: false,
      error: `Token exchange failed: ${error.message}`
    });
  }
};

/**
 * Get Supabase configuration for authenticated users
 * Desktop app calls this after Atlassian login to get Supabase credentials
 *
 * POST /api/auth/supabase-config
 * Body: { atlassian_token: string }
 */
exports.getSupabaseConfig = async (req, res) => {
  try {
    const { atlassian_token } = req.body;

    if (!validateRequiredField(req, res, 'atlassian_token', 'Atlassian token is required')) return;

    // Verify the Atlassian token first
    const atlassianUser = await verifyAtlassianTokenOrRespond(atlassian_token, res, 'Supabase config');
    if (!atlassianUser) return;

    // Verify user exists in our system (registered via Forge app)
    const atlassianAccountId = atlassianUser.account_id;
    const dbUser = await lookupUserOrRespond(atlassianAccountId, res, 'Supabase config');
    if (!dbUser) return;

    // Get Supabase credentials from environment
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
    const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseAnonKey || !supabaseServiceRoleKey) {
      logger.error('[Auth] Supabase credentials not configured on server');
      return res.status(500).json({
        success: false,
        error: 'Server configuration error - Supabase credentials not configured'
      });
    }

    logger.info('[Auth] Providing Supabase config to authenticated user');

    res.json({
      success: true,
      supabase_url: supabaseUrl,
      supabase_anon_key: supabaseAnonKey,
      supabase_service_role_key: supabaseServiceRoleKey
    });

  } catch (error) {
    logger.error('[Auth] Supabase config error:', error);
    res.status(500).json({
      success: false,
      error: `Failed to get Supabase config: ${error.message}`
    });
  }
};

/**
 * Get OCR configuration for authenticated users
 * Desktop app calls this after Atlassian login to get OCR settings
 *
 * POST /api/auth/ocr-config
 * Body: { atlassian_token: string }
 */
exports.getOcrConfig = async (req, res) => {
  try {
    const { atlassian_token } = req.body;

    if (!validateRequiredField(req, res, 'atlassian_token', 'Atlassian token is required')) return;

    // Verify the Atlassian token first
    const atlassianUser = await verifyAtlassianTokenOrRespond(atlassian_token, res, 'OCR config');
    if (!atlassianUser) return;

    // Build OCR configuration from environment variables
    // This centralizes all OCR configuration in the AI server
    const ocrConfig = {
      // Primary and fallback engines
      primary_engine: process.env.OCR_PRIMARY_ENGINE || 'paddle',
      fallback_engines: (process.env.OCR_FALLBACK_ENGINES || 'tesseract').split(',').map(e => e.trim()),
      
      // Global preprocessing settings
      use_preprocessing: (process.env.OCR_USE_PREPROCESSING || 'true').toLowerCase() === 'true',
      max_image_dimension: Number.parseInt(process.env.OCR_MAX_IMAGE_DIMENSION || '4096', 10),
      preprocessing_target_dpi: Number.parseInt(process.env.OCR_PREPROCESSING_TARGET_DPI || '300', 10),
      
      // Engine-specific configurations (dynamically discovered from env)
      engines: {}
    };

    // Discover all OCR engine configurations from environment
    const discoveredEngines = new Set();
    discoveredEngines.add(ocrConfig.primary_engine);
    ocrConfig.fallback_engines.forEach(e => discoveredEngines.add(e));

    // Scan environment for OCR_<ENGINE>_* patterns
    const OCR_RESERVED_PARTS = new Set(['PRIMARY', 'FALLBACK', 'USE', 'MAX', 'PREPROCESSING']);
    Object.keys(process.env).forEach(key => {
      if (key.startsWith('OCR_') && key.includes('_', 4)) {
        const parts = key.split('_');
        if (parts.length >= 3 && !OCR_RESERVED_PARTS.has(parts[1])) {
          discoveredEngines.add(parts[1].toLowerCase());
        }
      }
    });

    // Build configuration for each discovered engine
    discoveredEngines.forEach(engineName => {
      const prefix = `OCR_${engineName.toUpperCase()}_`;
      const engineConfig = {
        name: engineName,
        enabled: (process.env[`${prefix}ENABLED`] || 'true').toLowerCase() === 'true',
        min_confidence: Number.parseFloat(process.env[`${prefix}MIN_CONFIDENCE`] || '0.5'),
        use_gpu: (process.env[`${prefix}USE_GPU`] || 'false').toLowerCase() === 'true',
        language: process.env[`${prefix}LANGUAGE`] || 'en',
        extra_params: {}
      };

      // Capture any extra custom parameters
      const standardKeys = new Set(['ENABLED', 'MIN_CONFIDENCE', 'USE_GPU', 'LANGUAGE']);
      Object.keys(process.env).forEach(key => {
        if (key.startsWith(prefix)) {
          const paramName = key.substring(prefix.length).toLowerCase();
          if (!standardKeys.has(paramName.toUpperCase())) {
            engineConfig.extra_params[paramName] = process.env[key];
          }
        }
      });

      ocrConfig.engines[engineName] = engineConfig;
    });

    logger.info(`[Auth] Providing OCR config to authenticated user (engines: ${Array.from(discoveredEngines).join(', ')})`);

    res.json({
      success: true,
      config: ocrConfig
    });

  } catch (error) {
    logger.error('[Auth] OCR config error:', error);
    res.status(500).json({
      success: false,
      error: `Failed to get OCR config: ${error.message}`
    });
  }
};

/**
 * Verify Atlassian token and return user info
 * Utility endpoint for desktop app to validate tokens
 *
 * POST /api/auth/verify
 * Body: { atlassian_token: string }
 */
exports.verifyToken = async (req, res) => {
  try {
    const { atlassian_token } = req.body;

    if (!validateRequiredField(req, res, 'atlassian_token', 'Atlassian token is required')) return;

    // Verify by fetching user info
    const atlassianUser = await verifyAtlassianToken(atlassian_token);

    res.json({
      success: true,
      valid: true,
      user: {
        account_id: atlassianUser.account_id,
        email: atlassianUser.email,
        name: atlassianUser.name || atlassianUser.display_name
      }
    });

  } catch (error) {
    if (error.response?.status === 401) {
      return res.json({
        success: true,
        valid: false,
        error: 'Token expired or invalid'
      });
    }

    res.status(500).json({
      success: false,
      error: `Verification failed: ${error.message}`
    });
  }
};
