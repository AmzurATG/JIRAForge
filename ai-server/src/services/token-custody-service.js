'use strict';

/**
 * Token Custody Service (Phase 2)
 * Plan: plan/2026-06-12_auth_server-side-token-custody.md
 *
 * Single serialized owner of each user's Atlassian rotating refresh token.
 * Rotating tokens are single-use: whoever sends one must reliably receive and
 * persist the replacement, or the session dies. Laptops cannot guarantee that
 * (sleep mid-rotation lost the replacement in the 2026-06-12 incident); this
 * server can — rotations happen over a datacenter connection, are serialized
 * per user, persist the new token BEFORE responding, and retry the same token
 * promptly on network failure (inside Atlassian's documented 10-minute reuse
 * window).
 *
 * Storage model (migration 20260612_token_custody.sql):
 *   user_oauth_credentials — AES-256-GCM-encrypted refresh/access tokens,
 *                            one row per user per provider. Service-role only.
 *   device_sessions        — revocable per-device session tokens, stored as
 *                            SHA-256 hashes only. Service-role only.
 */

const crypto = require('crypto');
const axios = require('axios');
const { getClient } = require('./db/supabase-client');
const logger = require('../utils/logger');

const ATLASSIAN_TOKEN_URL = 'https://auth.atlassian.com/oauth/token';

// Refresh the access token when fewer than this many ms remain. Wide enough
// that a device never receives an about-to-expire token, narrow enough that
// rotations stay ~hourly per user.
const ACCESS_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

// Device session lifetime (plan: 180 days, non-rotating, revocable).
const DEVICE_SESSION_TTL_MS = 180 * 24 * 60 * 60 * 1000;

// Same-token retry on network failure. Atlassian's reuse interval is 10
// minutes; a couple of prompt retries comfortably fits inside it.
const ROTATION_MAX_ATTEMPTS = 3;
const ROTATION_RETRY_DELAY_MS = 2000;

// Keep in sync with the dead-token text list in auth-controller.js (and the
// desktop's authoritative list in desktop_app.py): wording is the reliable
// signal, not HTTP status or field position.
const DEAD_TOKEN_TEXT = [
  'invalid_grant',
  'unauthorized_client',
  'refresh_token is invalid',
  'refresh token is invalid',
  'unknown or invalid refresh token',
  'token has been revoked',
  'token was globally revoked',
  'token has been expired'
];

// Per-user in-flight rotation promises. Two concurrent callers for the same
// user share one rotation — the single-use refresh token is never double-spent
// (the v1.4.5 desktop race, eliminated structurally).
const inflightByUser = new Map();

function custodyError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

// ---------------------------------------------------------------------------
// Encryption at rest (AES-256-GCM, key from env — never in the database)
// ---------------------------------------------------------------------------

function getEncryptionKey() {
  const hex = process.env.TOKEN_ENCRYPTION_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw custodyError(
      'CONFIG_ERROR',
      'TOKEN_ENCRYPTION_KEY must be 64 hex characters (32 bytes). Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(hex, 'hex');
}

function encryptToken(plaintext) {
  const key = getEncryptionKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join('.');
}

function decryptToken(encrypted) {
  const key = getEncryptionKey();
  const [ivB64, tagB64, dataB64] = String(encrypted).split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

// ---------------------------------------------------------------------------
// Device session tokens (plaintext exists only in the issuing response)
// ---------------------------------------------------------------------------

function generateDeviceToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashDeviceToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

async function issueDeviceSession(userId, { organizationId = null, deviceName = null, appVersion = null } = {}) {
  const client = getClient();
  if (!client) throw custodyError('DB_UNAVAILABLE', 'Supabase client not available');

  const deviceToken = generateDeviceToken();
  const expiresAt = new Date(Date.now() + DEVICE_SESSION_TTL_MS).toISOString();

  const { data: inserted, error } = await client
    .from('device_sessions')
    .insert({
      user_id: userId,
      organization_id: organizationId,
      token_hash: hashDeviceToken(deviceToken),
      device_name: deviceName,
      app_version: appVersion,
      expires_at: expiresAt
    })
    .select('id')
    .single();

  if (error) {
    logger.error('[Custody] Failed to issue device session: %s', error.message);
    throw custodyError('DB_ERROR', 'Failed to issue device session');
  }

  // Retire this user's PRIOR active sessions on the SAME device so re-logins /
  // reinstalls don't accumulate live device tokens (one device token per device).
  // Scoped to device_name on purpose: other machines keep their own sessions, so
  // genuine multi-device use is preserved. Done AFTER the insert (the new session
  // already exists, so the user is never momentarily left with zero sessions) and
  // best-effort (cleanup must never fail issuance). Note: distinct machines that
  // happen to share a hostname would retire each other — an accepted trade-off.
  const newId = inserted && inserted.id;
  if (deviceName && newId) {
    try {
      const { error: revokeError } = await client
        .from('device_sessions')
        .update({ revoked_at: new Date().toISOString() })
        .eq('user_id', userId)
        .eq('device_name', deviceName)
        .is('revoked_at', null)
        .neq('id', newId);
      if (revokeError) {
        logger.warn('[Custody] Prior-session cleanup failed for user %s: %s', userId, revokeError.message);
      }
    } catch (e) {
      logger.warn('[Custody] Prior-session cleanup threw for user %s: %s', userId, e.message);
    }
  }

  logger.info('[Custody] Device session issued for user %s', userId);
  return { deviceToken, expiresAt };
}

async function verifyDeviceSession(deviceToken) {
  const client = getClient();
  if (!client || !deviceToken) return null;

  const { data: row, error } = await client
    .from('device_sessions')
    .select('id, user_id, organization_id, revoked_at, expires_at')
    .eq('token_hash', hashDeviceToken(deviceToken))
    .maybeSingle();

  if (error || !row) return null;
  if (row.revoked_at) return null;
  if (row.expires_at && new Date(row.expires_at).getTime() <= Date.now()) return null;

  try {
    await client
      .from('device_sessions')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', row.id);
  } catch (e) {
    // last_seen is best-effort telemetry; never fail verification over it
  }

  return { sessionId: row.id, userId: row.user_id, organizationId: row.organization_id };
}

async function revokeDeviceSession(deviceToken) {
  const client = getClient();
  if (!client || !deviceToken) return false;

  const { data, error } = await client
    .from('device_sessions')
    .update({ revoked_at: new Date().toISOString() })
    .eq('token_hash', hashDeviceToken(deviceToken))
    .select('id');

  if (error) {
    logger.error('[Custody] Failed to revoke device session: %s', error.message);
    return false;
  }
  return Array.isArray(data) && data.length > 0;
}

// ---------------------------------------------------------------------------
// Credential storage + central rotation
// ---------------------------------------------------------------------------

async function storeCredential(userId, { refreshToken, accessToken = null, expiresIn = null, provider = 'atlassian' }) {
  const client = getClient();
  if (!client) throw custodyError('DB_UNAVAILABLE', 'Supabase client not available');

  const now = new Date().toISOString();
  const payload = {
    user_id: userId,
    provider,
    refresh_token_encrypted: encryptToken(refreshToken),
    rotated_at: now,
    updated_at: now
  };
  if (accessToken) {
    payload.access_token_encrypted = encryptToken(accessToken);
    payload.access_token_expires_at = new Date(Date.now() + (expiresIn || 3600) * 1000).toISOString();
  }

  const { error } = await client
    .from('user_oauth_credentials')
    .upsert(payload, { onConflict: 'user_id,provider' });

  if (error) {
    logger.error('[Custody] Failed to store credential for user %s: %s', userId, error.message);
    throw custodyError('DB_ERROR', 'Failed to store credential');
  }
  logger.info('[Custody] Credential stored for user %s', userId);
}

function getAccessTokenForUser(userId, opts = {}) {
  // Synchronous de-duplication: the promise must be registered before any
  // await, or two near-simultaneous callers would both start a rotation and
  // double-spend the single-use refresh token.
  if (inflightByUser.has(userId)) {
    return inflightByUser.get(userId);
  }
  const promise = fetchOrRotateAccessToken(userId, opts).finally(() => {
    inflightByUser.delete(userId);
  });
  inflightByUser.set(userId, promise);
  return promise;
}

async function fetchOrRotateAccessToken(userId, opts) {
  const client = getClient();
  if (!client) throw custodyError('DB_UNAVAILABLE', 'Supabase client not available');

  const { data: credential, error } = await client
    .from('user_oauth_credentials')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', 'atlassian')
    .maybeSingle();

  if (error) throw custodyError('DB_ERROR', `Failed to load credential: ${error.message}`);
  if (!credential) {
    throw custodyError('OAUTH_REAUTH_REQUIRED', 'No stored credential for user — login required');
  }

  // Serve the cached access token while it has comfortable life left.
  if (credential.access_token_encrypted && credential.access_token_expires_at) {
    const remainingMs = new Date(credential.access_token_expires_at).getTime() - Date.now();
    if (remainingMs > ACCESS_TOKEN_REFRESH_MARGIN_MS) {
      return {
        accessToken: decryptToken(credential.access_token_encrypted),
        expiresAt: credential.access_token_expires_at
      };
    }
  }

  return rotateCredential(client, userId, credential, opts);
}

async function rotateCredential(client, userId, credential, opts = {}) {
  const refreshToken = decryptToken(credential.refresh_token_encrypted);
  const maxAttempts = opts.maxAttempts || ROTATION_MAX_ATTEMPTS;
  const retryDelayMs = opts.retryDelayMs !== undefined ? opts.retryDelayMs : ROTATION_RETRY_DELAY_MS;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await axios.post(
        ATLASSIAN_TOKEN_URL,
        {
          grant_type: 'refresh_token',
          client_id: process.env.ATLASSIAN_CLIENT_ID,
          client_secret: process.env.ATLASSIAN_CLIENT_SECRET,
          refresh_token: refreshToken
        },
        { headers: { 'Content-Type': 'application/json' }, timeout: 30000 }
      );

      const tokens = response.data;
      // Persist the rotated credential BEFORE returning — if this write fails
      // we must not hand out an access token while the new refresh token is
      // unsaved (that is precisely the lost-rotation failure being eliminated).
      await storeCredential(userId, {
        refreshToken: tokens.refresh_token || refreshToken,
        accessToken: tokens.access_token,
        expiresIn: tokens.expires_in
      });
      logger.info('[Custody] Rotated credential for user %s (attempt %d)', userId, attempt);
      return {
        accessToken: tokens.access_token,
        expiresAt: new Date(Date.now() + (tokens.expires_in || 3600) * 1000).toISOString()
      };
    } catch (err) {
      if (err.response) {
        const body = err.response.data || {};
        const bodyText = `${body.error || ''} ${body.error_description || ''}`.toLowerCase();
        const isDead = DEAD_TOKEN_TEXT.some((pattern) => bodyText.includes(pattern));
        logger.error('[Custody] Rotation failed for user %s: status=%s dead=%s', userId, err.response.status, isDead);
        if (isDead) {
          // Do NOT overwrite the stored credential: the row is the audit trail
          // of what died, and a re-login will overwrite it anyway.
          throw custodyError('OAUTH_REAUTH_REQUIRED', 'Refresh token is no longer valid — login required');
        }
        throw custodyError('OAUTH_TEMPORARY_FAILURE', `Atlassian rotation failed with status ${err.response.status}`);
      }

      // Network-level failure: the request may or may not have reached
      // Atlassian. Retrying the SAME token promptly is safe inside the
      // documented 10-minute reuse window — and is the entire reason custody
      // lives on this server instead of a sleeping laptop.
      if (attempt < maxAttempts) {
        logger.warn('[Custody] Network failure rotating for user %s (attempt %d/%d) — retrying same token', userId, attempt, maxAttempts);
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }
      throw custodyError('OAUTH_TEMPORARY_FAILURE', `Network failure during rotation: ${err.message}`);
    }
  }
  throw custodyError('OAUTH_TEMPORARY_FAILURE', 'Rotation attempts exhausted');
}

module.exports = {
  encryptToken,
  decryptToken,
  generateDeviceToken,
  hashDeviceToken,
  issueDeviceSession,
  verifyDeviceSession,
  revokeDeviceSession,
  storeCredential,
  getAccessTokenForUser
};
