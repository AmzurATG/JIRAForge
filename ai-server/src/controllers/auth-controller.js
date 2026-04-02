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
const ATLASSIAN_RESOURCES_URL = 'https://api.atlassian.com/oauth/token/accessible-resources';

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
 * GET /api/auth/config
 * Returns public OAuth configuration (client ID only — no secrets).
 * Used by the dashboard React app at runtime so the client ID doesn't
 * need to be baked in at build time.
 */
exports.getOAuthConfig = (req, res) => {
  const clientId = process.env.ATLASSIAN_CLIENT_ID;
  if (!clientId) {
    logger.error('[Auth] ATLASSIAN_CLIENT_ID not configured');
    return res.status(500).json({ success: false, error: 'OAuth not configured on server' });
  }
  res.json({ success: true, clientId });
};

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
    timeout: 10000,
    maxContentLength: 1 * 1024 * 1024,
    maxBodyLength: 1 * 1024 * 1024,
    maxRedirects: 5
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
    .select('id, organization_id, supabase_user_id')
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
 * Lookup user and send appropriate error response if not found.
 * If atlassianToken is provided, auto-provisions the user when not found
 * by fetching their Jira cloud resources and creating org + user records.
 *
 * @param {string} atlassianAccountId - Atlassian account ID
 * @param {Object} res - Express response object
 * @param {string} context - Context for logging
 * @param {Object} [provisionInfo] - Info needed for auto-provisioning
 * @param {string} [provisionInfo.atlassianToken] - Atlassian bearer token
 * @param {string} [provisionInfo.email] - User email
 * @param {string} [provisionInfo.displayName] - User display name
 * @returns {Promise<Object|null>} User object or null if error response sent
 */
async function lookupUserOrRespond(atlassianAccountId, res, context = '', provisionInfo = null) {
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
    // Auto-provision user if we have an Atlassian token
    if (provisionInfo?.atlassianToken) {
      logger.info(`[Auth] User not found${logSuffix}, attempting auto-provisioning: %s`, atlassianAccountId);
      const provisioned = await autoProvisionUser(
        atlassianAccountId,
        provisionInfo.atlassianToken,
        provisionInfo.email,
        provisionInfo.displayName
      );
      if (provisioned) {
        logger.info(`[Auth] Auto-provisioned user${logSuffix}: %s (org: %s)`, atlassianAccountId, provisioned.organization_id);
        return provisioned;
      }
    }

    logger.warn(`[Auth] User not found in system${logSuffix}: %s`, atlassianAccountId);
    res.status(403).json({
      success: false,
      error: 'Access denied. Your Jira account is not associated with an organization that has the Forge app installed. Please contact your administrator to install the app.'
    });
    return null;
  }

  if (error?.type === 'no_org') {
    // Try to fix missing org via auto-provisioning
    if (provisionInfo?.atlassianToken) {
      logger.info(`[Auth] User has no org${logSuffix}, attempting auto-provisioning: %s`, atlassianAccountId);
      const provisioned = await autoProvisionUser(
        atlassianAccountId,
        provisionInfo.atlassianToken,
        provisionInfo.email,
        provisionInfo.displayName
      );
      if (provisioned) {
        return provisioned;
      }
    }

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
 * Auto-provision a user by fetching their Jira cloud resources,
 * finding or creating the organization, and creating the user record.
 *
 * @param {string} atlassianAccountId - Atlassian account ID
 * @param {string} atlassianToken - Valid Atlassian bearer token
 * @param {string} [email] - User email
 * @param {string} [displayName] - User display name
 * @returns {Promise<Object|null>} User object with id and organization_id, or null on failure
 */
async function autoProvisionUser(atlassianAccountId, atlassianToken, email, displayName) {
  try {
    const supabase = getClient();
    if (!supabase) return null;

    // Fetch accessible Jira cloud resources to get cloud ID and site name
    const resourcesResponse = await axios.get(ATLASSIAN_RESOURCES_URL, {
      headers: {
        'Authorization': `Bearer ${atlassianToken}`,
        'Accept': 'application/json'
      },
      timeout: 10000,
      maxContentLength: 1 * 1024 * 1024,
      maxBodyLength: 1 * 1024 * 1024,
      maxRedirects: 5
    });

    const resources = resourcesResponse.data;
    if (!resources || resources.length === 0) {
      logger.warn('[Auth] No accessible Jira resources for auto-provisioning');
      return null;
    }

    // Use the first Jira cloud resource
    const resource = resources[0];
    const cloudId = resource.id;
    const orgName = resource.name || 'Unknown Organization';
    const jiraUrl = resource.url || `https://${cloudId}.atlassian.net`;

    logger.info('[Auth] Auto-provisioning with cloud resource: %s (%s)', orgName, cloudId);

    // Find or create organization
    const { data: existingOrgs, error: findOrgError } = await supabase
      .from('organizations')
      .select('*')
      .eq('jira_cloud_id', cloudId);

    if (findOrgError) throw findOrgError;

    let organization;
    if (existingOrgs && existingOrgs.length > 0) {
      organization = existingOrgs[0];
      logger.info('[Auth] Found existing organization for auto-provisioning', { id: organization.id });
    } else {
      // Create new organization
      const { data: newOrg, error: createOrgError } = await supabase
        .from('organizations')
        .insert({
          jira_cloud_id: cloudId,
          org_name: orgName,
          jira_instance_url: jiraUrl,
          subscription_status: 'active',
          subscription_tier: 'free'
        })
        .select()
        .single();

      if (createOrgError) throw createOrgError;

      // Create default organization settings
      await supabase
        .from('organization_settings')
        .insert({
          organization_id: newOrg.id,
          screenshot_interval: 300,
          auto_worklog_enabled: true
        });

      organization = newOrg;
      logger.info('[Auth] Created new organization via auto-provisioning', { id: organization.id });
    }

    // Find or create user
    const { data: existingUsers, error: findUserError } = await supabase
      .from('users')
      .select('id, organization_id, supabase_user_id')
      .eq('atlassian_account_id', atlassianAccountId);

    if (findUserError) throw findUserError;

    let dbUser;
    if (existingUsers && existingUsers.length > 0) {
      dbUser = existingUsers[0];
      // Update org if missing
      if (!dbUser.organization_id) {
        await supabase.from('users')
          .update({ organization_id: organization.id })
          .eq('id', dbUser.id);
        dbUser.organization_id = organization.id;
      }
    } else {
      // Create new user
      const { data: newUser, error: createUserError } = await supabase
        .from('users')
        .insert({
          atlassian_account_id: atlassianAccountId,
          organization_id: organization.id,
          email: email || null,
          display_name: displayName || null
        })
        .select()
        .single();

      if (createUserError) throw createUserError;

      // Set supabase_user_id = the newly created user's own id
      // This is required for RLS: get_current_user_id() does WHERE supabase_user_id = auth.uid()
      await supabase
        .from('users')
        .update({ supabase_user_id: newUser.id })
        .eq('id', newUser.id);

      dbUser = newUser;
    }

    // Ensure organization membership
    const { data: existingMembership } = await supabase
      .from('organization_members')
      .select('id')
      .eq('user_id', dbUser.id)
      .eq('organization_id', organization.id);

    if (!existingMembership || existingMembership.length === 0) {
      const { data: allMembers } = await supabase
        .from('organization_members')
        .select('id')
        .eq('organization_id', organization.id);

      const isFirstUser = !allMembers || allMembers.length === 0;
      const role = isFirstUser ? 'owner' : 'member';
      const ADMIN_ROLES = new Set(['owner', 'admin']);
      const ANALYTICS_ROLES = new Set(['owner', 'admin', 'manager']);

      await supabase
        .from('organization_members')
        .insert({
          user_id: dbUser.id,
          organization_id: organization.id,
          role,
          can_manage_settings: ADMIN_ROLES.has(role),
          can_view_team_analytics: ANALYTICS_ROLES.has(role),
          can_manage_members: ADMIN_ROLES.has(role),
          can_delete_screenshots: ADMIN_ROLES.has(role),
          can_manage_billing: role === 'owner'
        });

      logger.info('[Auth] Created organization membership via auto-provisioning', { userId: dbUser.id, role });
    }

    return { id: dbUser.id, organization_id: organization.id, supabase_user_id: dbUser.supabase_user_id || dbUser.id };
  } catch (error) {
    logger.error('[Auth] Auto-provisioning failed:', error.message);
    return null;
  }
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
        timeout: 30000,
        maxContentLength: 1 * 1024 * 1024,
        maxBodyLength: 1 * 1024 * 1024,
        maxRedirects: 5
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
        timeout: 30000,
        maxContentLength: 1 * 1024 * 1024,
        maxBodyLength: 1 * 1024 * 1024,
        maxRedirects: 5
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

    // Verify user exists in our system (auto-provision if needed)
    const dbUser = await lookupUserOrRespond(atlassianAccountId, res, '', {
      atlassianToken: atlassian_token,
      email,
      displayName: atlassianUser.name || atlassianUser.display_name
    });
    if (!dbUser) return;

    // Ensure supabase_user_id is set so RLS policies (via get_current_user_id()) work.
    // get_current_user_id() does: WHERE supabase_user_id = auth.uid()
    // We set sub = dbUser.id in the JWT, so supabase_user_id must also = dbUser.id.
    if (!dbUser.supabase_user_id || dbUser.supabase_user_id !== dbUser.id) {
      const supabase = getClient();
      if (supabase) {
        await supabase
          .from('users')
          .update({ supabase_user_id: dbUser.id })
          .eq('id', dbUser.id);
        logger.info('[Auth] Set supabase_user_id = %s for user %s', dbUser.id, atlassianAccountId);
      }
    }

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
      sub: dbUser.id, // Database UUID — enables RLS via auth.uid() = users.id

      // Custom claims for RLS policies
      atlassian_account_id: atlassianAccountId,
      email: email,

      // App metadata — org_id enables tenant isolation in RLS
      app_metadata: {
        provider: 'atlassian',
        providers: ['atlassian'],
        org_id: dbUser.organization_id
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

    // Verify user exists in our system (auto-provision if needed)
    const atlassianAccountId = atlassianUser.account_id;
    const dbUser = await lookupUserOrRespond(atlassianAccountId, res, 'Supabase config', {
      atlassianToken: atlassian_token,
      email: atlassianUser.email,
      displayName: atlassianUser.name || atlassianUser.display_name
    });
    if (!dbUser) return;

    // Get Supabase credentials from environment
    // NOTE: Only the URL and anon key are sent to clients.
    // The service role key is NEVER sent — it stays server-side only.
    const supabaseUrl = process.env.SUPABASE_URL;
    const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

    if (!supabaseUrl || !supabaseAnonKey) {
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
      supabase_anon_key: supabaseAnonKey
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
      primary_engine: process.env.OCR_PRIMARY_ENGINE || 'rapidocr',
      fallback_engines: (process.env.OCR_FALLBACK_ENGINES || 'winrtocr').split(',').map(e => e.trim()),
      
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

    // Privacy filter configuration (delivered to desktop app alongside OCR config)
    const privacyConfig = {
      enabled: (process.env.PRIVACY_FILTER_ENABLED || 'true').toLowerCase() === 'true',
      min_confidence: Number.parseFloat(process.env.PRIVACY_MIN_CONFIDENCE || '0.7'),
      detect_pii: (process.env.PRIVACY_DETECT_PII || 'true').toLowerCase() === 'true',
      detect_secrets: (process.env.PRIVACY_DETECT_SECRETS || 'false').toLowerCase() === 'true',
      detect_custom_patterns: (process.env.PRIVACY_DETECT_CUSTOM_PATTERNS || 'true').toLowerCase() === 'true',
      redaction_strategy: process.env.PRIVACY_REDACTION_STRATEGY || 'mask',
      mask_char: (process.env.PRIVACY_MASK_CHAR || '*').charAt(0) || '*',
      mask_length: Number.parseInt(process.env.PRIVACY_MASK_LENGTH || '8', 10),
      fail_open: (process.env.PRIVACY_FAIL_OPEN || 'false').toLowerCase() === 'true',
    };

    logger.info(`[Auth] Providing OCR config to authenticated user (engines: ${Array.from(discoveredEngines).join(', ')}, privacy: ${privacyConfig.enabled ? 'enabled' : 'disabled'})`);

    res.json({
      success: true,
      config: ocrConfig,
      privacy: privacyConfig
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

/**
 * Receive and log client diagnostics (OCR status, login events, errors)
 * Desktop app sends this periodically or on errors to help debugging
 *
 * POST /api/auth/diagnostics
 * Body: { 
 *   atlassian_token: string,
 *   type: 'ocr' | 'login' | 'error',
 *   diagnostics: object 
 * }
 */
/**
 * Log OCR-specific diagnostics (engine status, bundled deps, recommendations)
 */
function logOcrDiagnostics(logPrefix, diagnostics) {
  const ocrStatus = diagnostics?.status || 'unknown';
  const primaryEngine = diagnostics?.config?.primary_engine || 'unknown';
  const engineDetails = diagnostics?.engine_init_details || {};

  logger.info(`${logPrefix} OCR Status: ${ocrStatus}`);
  logger.info(`${logPrefix} Primary Engine: ${primaryEngine}`);

  // PaddleOCR details
  const paddle = engineDetails.paddle || {};
  logger.info(`${logPrefix} PaddleOCR: module=${paddle.module_available}, engine=${paddle.engine_available}, user_models=${paddle.user_models_exist}, version=${paddle.version || 'N/A'}`);
  if (paddle.initialization_error) {
    logger.error(`${logPrefix} PaddleOCR Init Error: ${paddle.initialization_error}`);
  }

  // Tesseract details
  const tesseract = engineDetails.tesseract || {};
  logger.info(`${logPrefix} Tesseract: module=${tesseract.module_available}, engine=${tesseract.engine_available}, version=${tesseract.tesseract_version || 'N/A'}`);
  if (tesseract.initialization_error) {
    logger.error(`${logPrefix} Tesseract Init Error: ${tesseract.initialization_error}`);
  }

  // Bundled dependency status for exe deployments
  const bundled = diagnostics?.bundled_dependencies;
  if (bundled) {
    logger.info(`${logPrefix} Bundled: tesseract=${bundled.tesseract_exe ? 'YES' : 'NO'}, paddle_bundled=${bundled.paddleocr_models_bundled ? 'YES' : 'NO'}, paddle_user=${bundled.paddleocr_user_models ? 'YES' : 'NO'}`);
  }

  // Recommendations
  const recommendations = diagnostics?.recommendations || [];
  if (recommendations.length > 0) {
    logger.warn(`${logPrefix} Recommendations: ${recommendations.join(' | ')}`);
  }
}

/**
 * Log login-specific diagnostics (status, step, errors)
 */
function logLoginDiagnostics(logPrefix, diagnostics) {
  const loginStatus = diagnostics?.status || 'unknown';
  const loginStep = diagnostics?.step || 'unknown';
  const errorMessage = diagnostics?.error || null;

  logger.info(`${logPrefix} Login Status: ${loginStatus} | Step: ${loginStep}`);
  if (errorMessage) {
    logger.error(`${logPrefix} Login Error: ${errorMessage}`);
    if (diagnostics?.error_details) {
      logger.error(`${logPrefix} Error Details: ${JSON.stringify(diagnostics.error_details)}`);
    }
  }
}

/**
 * Log general error diagnostics (category, message, stack trace)
 */
function logErrorDiagnostics(logPrefix, diagnostics) {
  const errorCategory = diagnostics?.category || 'general';
  const errorMessage = diagnostics?.message || 'Unknown error';
  const stackTrace = diagnostics?.stack_trace || null;

  logger.error(`${logPrefix} Category: ${errorCategory} | Error: ${errorMessage}`);
  if (stackTrace) {
    logger.error(`${logPrefix} Stack: ${stackTrace.substring(0, 500)}`);
  }
}

/** Dispatch table for type-specific diagnostic logging */
const diagnosticLoggers = {
  ocr: logOcrDiagnostics,
  login: logLoginDiagnostics,
  error: logErrorDiagnostics
};

exports.submitDiagnostics = async (req, res) => {
  try {
    const { atlassian_token, type, diagnostics, app_version } = req.body;

    if (!validateRequiredField(req, res, 'atlassian_token', 'Atlassian token is required')) return;
    if (!validateRequiredField(req, res, 'type', 'Diagnostics type is required')) return;
    if (!validateRequiredField(req, res, 'diagnostics', 'Diagnostics data is required')) return;

    // Verify the Atlassian token first
    const atlassianUser = await verifyAtlassianTokenOrRespond(atlassian_token, res, 'diagnostics');
    if (!atlassianUser) return;

    const userEmail = atlassianUser.email;

    // Log the diagnostics to server logs with structured format for easy searching
    const logPrefix = `[DIAG:${type.toUpperCase()}]`;
    const hostname = diagnostics?.system_info?.hostname || 'unknown';
    const platform = diagnostics?.system_info?.platform || 'unknown';

    logger.info(`${logPrefix} User: ${userEmail} | Host: ${hostname} | Platform: ${platform} | App: ${app_version || 'unknown'}`);

    // Dispatch to type-specific logger (no-op for unknown types)
    const typeLogger = diagnosticLoggers[type];
    if (typeLogger) {
      typeLogger(logPrefix, diagnostics);
    }

    // Log the full diagnostics as JSON for detailed analysis (at debug level)
    logger.debug(`${logPrefix} Full diagnostics: ${JSON.stringify(diagnostics)}`);

    res.json({
      success: true,
      message: 'Diagnostics received and logged'
    });

  } catch (error) {
    logger.error('[Auth] Diagnostics submission error:', error);
    res.status(500).json({
      success: false,
      error: `Failed to submit diagnostics: ${error.message}`
    });
  }
};
