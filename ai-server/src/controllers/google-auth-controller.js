/**
 * Google Auth Controller (desktop, non-Jira users)
 *
 * Lets employees WITHOUT a Jira account sign in to the desktop tracker with their
 * company Google account. Mirrors the Atlassian exchange-token flow:
 *   1. Exchange the OAuth code (with PKCE code_verifier) for Google tokens.
 *   2. Read the verified Google identity (email, sub, hosted domain).
 *   3. Resolve the organization from the email domain (org_email_domains allowlist).
 *      This also enforces "company email only" self-signup.
 *   4. Find-or-create the users row (auth_provider='google') + org membership.
 *   5. Mint a Supabase JWT structurally identical to exchangeToken (sub=users.id,
 *      app_metadata.org_id) so RLS and the whole downstream pipeline just work.
 *
 * A refresh endpoint re-mints the (1h) Supabase JWT from the stored Google
 * refresh token, so desktop sessions keep uploading without re-prompting.
 *
 * The desktop never needs Jira; productive records are later analyzed in the AI
 * "describe" mode (empty issue list) rather than matched to a Jira issue.
 */

'use strict';

const jwt = require('jsonwebtoken');
const logger = require('../utils/logger');
const { getClient } = require('../services/db/supabase-client');
const userDbService = require('../services/db/user-db-service');
const { buildOcrConfig, buildPrivacyConfig } = require('../config/ocr-config-builder');

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo';

function getGoogleCredentials() {
  // Prefer a dedicated desktop client; fall back to the portal's client.
  return {
    clientId: process.env.GOOGLE_DESKTOP_CLIENT_ID || process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_DESKTOP_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET
  };
}

/** Exchange an authorization code (PKCE) for Google tokens. Returns tokens or throws an HttpError. */
async function exchangeGoogleCode({ code, redirectUri, codeVerifier, clientId, clientSecret }) {
  const body = new URLSearchParams({ code, client_id: clientId, redirect_uri: redirectUri, grant_type: 'authorization_code' });
  if (clientSecret) body.set('client_secret', clientSecret);
  if (codeVerifier) body.set('code_verifier', codeVerifier);
  return postGoogleToken(body);
}

/** Exchange a refresh token for a fresh Google access token. */
async function refreshGoogleTokens({ refreshToken, clientId, clientSecret }) {
  const body = new URLSearchParams({ refresh_token: refreshToken, client_id: clientId, grant_type: 'refresh_token' });
  if (clientSecret) body.set('client_secret', clientSecret);
  return postGoogleToken(body);
}

async function postGoogleToken(body) {
  const resp = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(15000)
  });
  if (!resp.ok) {
    const errData = await resp.json().catch(() => ({}));
    const err = new Error(errData.error_description || 'Google token request failed');
    err.statusCode = 401;
    throw err;
  }
  return resp.json();
}

/**
 * Fetch the verified Google identity using the access token.
 *
 * We validate identity by calling Google's userinfo endpoint with the access
 * token (authoritative — the token was just issued to OUR client via the code/
 * refresh exchange using our client_id+secret), rather than locally verifying
 * the id_token signature. The caller then enforces `verified_email === true`
 * and the org email-domain allowlist. This mirrors the existing portal Google flow.
 */
async function fetchGoogleUser(accessToken) {
  const resp = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(10000)
  });
  if (!resp.ok) {
    const err = new Error('Failed to fetch Google user info');
    err.statusCode = 401;
    throw err;
  }
  return resp.json();
}

/**
 * Mint a Supabase JWT for a non-Jira Google user.
 * Payload shape matches auth-controller.exchangeToken exactly, except provider=google
 * and atlassian_account_id is null. sub = users.id enables RLS via auth.uid().
 */
function mintSupabaseToken(dbUser, email, displayName) {
  const supabaseJwtSecret = process.env.SUPABASE_JWT_SECRET;
  if (!supabaseJwtSecret) throw new Error('SUPABASE_JWT_SECRET not configured');

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseRefMatch = supabaseUrl ? /https:\/\/([^.]+)\.supabase\.co/.exec(supabaseUrl) : null;
  const supabaseRef = supabaseRefMatch?.[1] || null;

  const now = Math.floor(Date.now() / 1000);
  const expiresIn = 3600;

  const payload = {
    iss: 'supabase',
    ref: supabaseRef || undefined,
    role: 'authenticated',
    iat: now,
    exp: now + expiresIn,
    aud: 'authenticated',
    sub: dbUser.id,
    atlassian_account_id: null,
    email: email || null,
    app_metadata: { provider: 'google', providers: ['google'], org_id: dbUser.organization_id },
    user_metadata: { email: email || null, name: displayName || null }
  };

  return { token: jwt.sign(payload, supabaseJwtSecret, { algorithm: 'HS256' }), expiresIn };
}

/**
 * Shared finalize: validate the Google identity, resolve org from the email
 * domain, find-or-create the user, mint the Supabase JWT, and send the response.
 */
async function buildGoogleSessionResponse(googleUser, refreshToken, res) {
  const email = (googleUser.email || '').trim().toLowerCase();
  const emailVerified = googleUser.verified_email === true || googleUser.email_verified === true;
  const googleSub = googleUser.id || googleUser.sub;
  const displayName = googleUser.name || email;

  if (!email || !googleSub) {
    return res.status(401).json({ success: false, error: 'Google account missing email or id' });
  }
  if (!emailVerified) {
    return res.status(401).json({ success: false, error: 'Google email is not verified' });
  }

  // Resolve org from domain (prefer Workspace hd claim, else the email's domain).
  const emailDomain = email.includes('@') ? email.split('@')[1] : null;
  const domain = (googleUser.hd || emailDomain || '').trim().toLowerCase();
  if (!domain) {
    return res.status(400).json({ success: false, error: 'Could not determine email domain' });
  }

  const organizationId = await userDbService.getOrgIdByEmailDomain(domain);
  if (!organizationId) {
    logger.warn('[GoogleAuth] Unregistered domain attempted login', { domain });
    return res.status(403).json({
      success: false,
      error: "Your company hasn't enabled non-Jira access. Ask your admin to register your email domain."
    });
  }

  const dbUser = await userDbService.findOrCreateGoogleUser({ googleSub, email, displayName, organizationId });

  if (!getClient()) {
    return res.status(500).json({ success: false, error: 'Database not configured' });
  }
  const { token, expiresIn } = mintSupabaseToken(dbUser, email, displayName);

  logger.info('[GoogleAuth] Minted Supabase JWT for google user', { userId: dbUser.id, organizationId });

  return res.json({
    success: true,
    supabase_token: token,
    expires_in: expiresIn,
    google_refresh_token: refreshToken || null,
    // Non-sensitive Supabase client config (anon key is public). The desktop has
    // no Atlassian token to call /api/auth/supabase-config, so we hand it the URL
    // + anon key here and it caches them for client init.
    supabase_url: process.env.SUPABASE_URL || null,
    supabase_anon_key: process.env.SUPABASE_ANON_KEY || null,
    // OCR + privacy config — Google users can't call /api/auth/ocr-config (no
    // Atlassian token), so we deliver it here. Without this they'd run OCR with
    // DEFAULT privacy settings instead of the org's configured ones (privacy gap).
    config: buildOcrConfig(),
    privacy: buildPrivacyConfig(),
    user: {
      id: dbUser.id,
      organization_id: dbUser.organization_id,
      email,
      display_name: displayName,
      jira_cloud_id: null
    }
  });
}

/**
 * POST /api/auth/desktop-google
 * Body: { code, redirect_uri, code_verifier }
 */
exports.desktopGoogleLogin = async (req, res) => {
  try {
    const { code, redirect_uri, code_verifier } = req.body || {};
    if (!code || !redirect_uri) {
      return res.status(400).json({ success: false, error: 'code and redirect_uri are required' });
    }

    const { clientId, clientSecret } = getGoogleCredentials();
    if (!clientId) {
      logger.error('[GoogleAuth] Google client id not configured');
      return res.status(500).json({ success: false, error: 'Google OAuth not configured on server' });
    }

    const tokens = await exchangeGoogleCode({ code, redirectUri: redirect_uri, codeVerifier: code_verifier, clientId, clientSecret });
    const googleUser = await fetchGoogleUser(tokens.access_token);
    return await buildGoogleSessionResponse(googleUser, tokens.refresh_token, res);
  } catch (error) {
    if (error.statusCode) {
      logger.warn('[GoogleAuth] login failed', { status: error.statusCode, error: error.message });
      return res.status(error.statusCode).json({ success: false, error: error.message });
    }
    logger.error('[GoogleAuth] desktopGoogleLogin error:', error);
    return res.status(500).json({ success: false, error: `Google login failed: ${error.message}` });
  }
};

/**
 * POST /api/auth/desktop-google/refresh
 * Body: { google_refresh_token }
 * Re-mints the Supabase JWT after re-validating the Google account is still active.
 */
exports.desktopGoogleRefresh = async (req, res) => {
  try {
    const { google_refresh_token } = req.body || {};
    if (!google_refresh_token) {
      return res.status(400).json({ success: false, error: 'google_refresh_token is required' });
    }

    const { clientId, clientSecret } = getGoogleCredentials();
    if (!clientId) {
      return res.status(500).json({ success: false, error: 'Google OAuth not configured on server' });
    }

    const tokens = await refreshGoogleTokens({ refreshToken: google_refresh_token, clientId, clientSecret });
    const googleUser = await fetchGoogleUser(tokens.access_token);
    // Google refresh responses usually omit a new refresh_token; keep the caller's existing one.
    return await buildGoogleSessionResponse(googleUser, tokens.refresh_token || google_refresh_token, res);
  } catch (error) {
    if (error.statusCode) {
      logger.warn('[GoogleAuth] refresh failed', { status: error.statusCode, error: error.message });
      return res.status(error.statusCode).json({ success: false, error: error.message });
    }
    logger.error('[GoogleAuth] desktopGoogleRefresh error:', error);
    return res.status(500).json({ success: false, error: `Google token refresh failed: ${error.message}` });
  }
};
