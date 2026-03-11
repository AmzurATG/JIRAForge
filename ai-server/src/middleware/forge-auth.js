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
 * Validate Forge Invocation Token (FIT)
 * @param {string} token - The JWT token from Authorization header
 * @returns {Promise<Object>} - Validated payload with context
 */
async function validateFIT(token) {
  try {
    const jose = await getJose();
    const JWKS = await getJWKS();

    // First decode the token to inspect the actual aud claim (for flexible matching)
    const parts = token.split('.');
    let decodedPayload = null;
    if (parts.length === 3) {
      try {
        decodedPayload = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
      } catch (_) {
        // Fall through to standard validation
      }
    }

    // Log the actual aud for debugging (before validation attempt)
    if (decodedPayload) {
      logger.debug('[FIT] Token aud claim:', decodedPayload.aud, '| Expected one of:', FORGE_APP_IDS);
    }

    // Build audience options to try:
    // For each configured app ID, add both full ARI and UUID-only formats
    const audienceOptions = [];
    for (const appId of FORGE_APP_IDS) {
      audienceOptions.push(appId);
      // Extract UUID from full ARI format
      const appUUID = appId.includes('/') ? appId.split('/').pop() : appId;
      if (!audienceOptions.includes(appUUID)) {
        audienceOptions.push(appUUID);
      }
    }
    
    // Also add the actual token's aud if it contains any of our app UUIDs (handles edge cases)
    if (decodedPayload?.aud) {
      const tokenAud = Array.isArray(decodedPayload.aud) ? decodedPayload.aud : [decodedPayload.aud];
      for (const aud of tokenAud) {
        if (typeof aud === 'string') {
          // Check if token aud contains any of our known app UUIDs
          const matchesKnownApp = FORGE_APP_IDS.some(appId => {
            const uuid = appId.includes('/') ? appId.split('/').pop() : appId;
            return aud.includes(uuid);
          });
          if (matchesKnownApp && !audienceOptions.includes(aud)) {
            audienceOptions.push(aud);
          }
        }
      }
    }

    let payload;
    let lastError;
    for (const aud of audienceOptions) {
      try {
        ({ payload } = await jose.jwtVerify(token, JWKS, {
          issuer: 'forge/invocation-token',
          audience: aud
        }));
        logger.debug('[FIT] Token validated with audience:', aud);
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (!payload) throw lastError;

    return payload;
  } catch (error) {
    // Log detailed debugging info on validation failure
    try {
      const parts = token.split('.');
      if (parts.length === 3) {
        const decoded = JSON.parse(Buffer.from(parts[1], 'base64url').toString());
        logger.error('[FIT] Token validation failed. Expected one of:', FORGE_APP_IDS, '| Actual aud:', JSON.stringify(decoded.aud), '| iss:', decoded.iss);
      }
    } catch (_) {}
    logger.error('[FIT] Token validation failed:', error.message);
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
