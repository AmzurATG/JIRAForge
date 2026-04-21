/**
 * Forge Invocation Token (FIT) Authentication Middleware
 * Validates requests from Atlassian Forge apps using JWT verification
 */

const logger = require('../utils/logger');

// Atlassian's JWKS endpoint for FIT token verification
const JWKS_URL = 'https://forge.cdn.prod.atlassian-dev.net/.well-known/jwks.json';

// Your Forge App ID(s) (from manifest.yml) - MUST be set in environment
// Supports multiple app IDs separated by commas for dev/prod using same server
if (!process.env.FORGE_APP_ID) {
  throw new Error('FORGE_APP_ID environment variable is required. Set it in .env to your Forge app ARI(s). Separate multiple IDs with commas.');
}
// Parse comma-separated app IDs and trim whitespace
const FORGE_APP_IDS = process.env.FORGE_APP_ID.split(',').map(id => id.trim()).filter(Boolean);
// Log the configured app IDs at startup for debugging
logger.info('[FIT] Configured FORGE_APP_IDs:', FORGE_APP_IDS);

// Cache the JWKS and jose module
let cachedJWKS = null;
let joseModule = null;

/**
 * Load jose module (ES Module) dynamically
 */
async function getJose() {
  if (!joseModule) {
    joseModule = await import('jose');
  }
  return joseModule;
}

/**
 * Get the JWKS (JSON Web Key Set) from Atlassian
 * @returns {Promise<jose.JWKS>}
 */
async function getJWKS() {
  const jose = await getJose();
  if (!cachedJWKS) {
    cachedJWKS = jose.createRemoteJWKSet(new URL(JWKS_URL));
  }
  return cachedJWKS;
}

/**
 * Safely decode JWT payload without verification.
 * Returns null if token is malformed or decoding fails.
 * @param {string} token - Raw JWT string
 * @returns {Object|null}
 */
function decodeTokenPayload(token) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString());
  } catch (_) {
    return null;
  }
}

/**
 * Build the list of audience values to try for token verification.
 * Includes full ARI, UUID-only, and any matching aud values from the token itself.
 * @param {Object|null} decodedPayload - Decoded (unverified) token payload
 * @returns {Array<string>}
 */
function buildAudienceOptions(decodedPayload) {
  const audienceOptions = [];

  for (const appId of FORGE_APP_IDS) {
    audienceOptions.push(appId);
    const appUUID = appId.includes('/') ? appId.split('/').pop() : appId;
    if (!audienceOptions.includes(appUUID)) {
      audienceOptions.push(appUUID);
    }
  }

  if (!decodedPayload?.aud) return audienceOptions;

  // Also add token's own aud values if they contain any of our known app UUIDs
  const tokenAud = Array.isArray(decodedPayload.aud) ? decodedPayload.aud : [decodedPayload.aud];
  for (const aud of tokenAud) {
    if (typeof aud !== 'string') continue;
    const matchesKnownApp = FORGE_APP_IDS.some(appId => {
      const uuid = appId.includes('/') ? appId.split('/').pop() : appId;
      return aud.includes(uuid);
    });
    if (matchesKnownApp && !audienceOptions.includes(aud)) {
      audienceOptions.push(aud);
    }
  }

  return audienceOptions;
}

/**
 * Attempt JWT verification against each audience option in order.
 * Returns the verified payload, or throws the last error if all attempts fail.
 * @param {Object} jose - jose module
 * @param {Object} JWKS - JWKS key set
 * @param {string} token - Raw JWT string
 * @param {Array<string>} audienceOptions - Audience values to try
 * @returns {Promise<Object>} Verified payload
 */
async function tryVerifyWithAudiences(jose, JWKS, token, audienceOptions) {
  let lastError;
  for (const aud of audienceOptions) {
    try {
      const { payload } = await jose.jwtVerify(token, JWKS, {
        issuer: 'forge/invocation-token',
        audience: aud,
        clockTolerance: '60s'
      });
      logger.debug('[FIT] Token validated with audience:', aud);
      return payload;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

/**
 * Log detailed token debugging info after a validation failure.
 * @param {string} token - Raw JWT string
 * @param {Error} error - Validation error
 */
function logValidationFailure(token, error) {
  const decoded = decodeTokenPayload(token);
  if (decoded) {
    logger.error('[FIT] Token validation failed. Expected one of:', FORGE_APP_IDS, '| Actual aud:', JSON.stringify(decoded.aud), '| iss:', decoded.iss);
  }
  logger.error('[FIT] Token validation failed: %s', error.message);
}

/**
 * Validate Forge Invocation Token (FIT)
 * @param {string} token - The JWT token from Authorization header
 * @returns {Promise<Object>} - Validated payload with context
 */
async function validateFIT(token) {
  try {
    const jose = await getJose();
    const JWKS = await getJWKS();

    const decodedPayload = decodeTokenPayload(token);
    if (decodedPayload) {
      logger.debug('[FIT] Token aud claim:', decodedPayload.aud, '| Expected one of:', FORGE_APP_IDS);
    }

    const audienceOptions = buildAudienceOptions(decodedPayload);
    return await tryVerifyWithAudiences(jose, JWKS, token, audienceOptions);
  } catch (error) {
    logValidationFailure(token, error);
    throw error;
  }
}

/**
 * Express middleware for Forge authentication
 * Validates FIT token and extracts context (cloudId, accountId)
 */
const forgeAuthMiddleware = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;

    if (!authHeader) {
      return res.status(401).json({
        success: false,
        error: 'Authorization header missing'
      });
    }

    const [type, token] = authHeader.split(' ');

    if (type !== 'Bearer' || !token) {
      return res.status(401).json({
        success: false,
        error: 'Invalid authorization format. Use: Bearer <token>'
      });
    }

    // Validate the FIT token
    const payload = await validateFIT(token);

    // Log minimal token info (full payload only in debug mode to avoid CPU overhead)
    if (process.env.LOG_LEVEL === 'debug') {
      logger.debug('[FIT] Full token payload:', { 
        app: payload.app?.id,
        principal: typeof payload.principal === 'string' ? payload.principal : payload.principal?.accountId,
        cloudId: payload.context?.cloudId
      });
    }

    // Extract context from validated token
    // accountId can be in different places depending on invocation type
    // Note: principal can be either a string (e.g., "712020:uuid") or an object with accountId
    const extractAccountId = () => {
      if (payload.context?.accountId) return payload.context.accountId;
      if (payload.sub) return payload.sub;
      if (typeof payload.principal === 'string') return payload.principal;
      if (payload.principal?.accountId) return payload.principal.accountId;
      return null;
    };

    const context = {
      cloudId: payload.context?.cloudId || payload.iss?.split('/')[2],
      accountId: extractAccountId(),
      appId: payload.app?.id,
      installationId: payload.app?.installationId,
      environment: payload.app?.environment?.type
    };

    logger.info('[FIT] Extracted context:', context);

    if (!context.cloudId) {
      logger.warn('[FIT] Token missing cloudId', { payload });
      return res.status(400).json({
        success: false,
        error: 'Token missing required context (cloudId)'
      });
    }

    // Attach context to request for downstream use
    req.forgeContext = context;

    logger.info('[FIT] Request authenticated', {
      cloudId: context.cloudId,
      accountId: context.accountId,
      path: req.path
    });

    next();
  } catch (error) {
    logger.error('[FIT] Authentication failed:', error);

    // Check for specific JWT errors
    if (error.code === 'ERR_JWT_EXPIRED') {
      return res.status(401).json({
        success: false,
        error: 'Token expired'
      });
    }

    if (error.code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED') {
      return res.status(401).json({
        success: false,
        error: 'Invalid token signature'
      });
    }

    if (error.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
      return res.status(401).json({
        success: false,
        error: 'Token validation failed: ' + error.message
      });
    }

    res.status(401).json({
      success: false,
      error: 'Authentication failed'
    });
  }
};

module.exports = forgeAuthMiddleware;
module.exports.validateFIT = validateFIT;
