-- =============================================================================
-- Server-side OAuth token custody (Phase 2)
-- Plan: plan/2026-06-12_auth_server-side-token-custody.md
--
-- Moves Atlassian rotating refresh tokens off user devices into a server-held,
-- encrypted store, and introduces per-device session tokens issued by ai-server.
-- Root cause being fixed: a laptop sleeping mid-rotation loses the rotated
-- replacement token in transit, permanently killing the session (2026-06-12
-- incident). The server becomes the single serialized owner of each user's
-- refresh token; devices hold only revocable session tokens.
--
-- SECURITY MODEL (deliberate deviation from the org_id-policy convention):
-- Both tables hold or reference credential material. They are accessible ONLY
-- via the ai-server service role. RLS is ENABLED with NO policies, which in
-- Postgres denies every non-service-role access path (anon/authenticated JWTs
-- from desktop, portal, or Forge can never read or write these rows). Adding
-- an org_id-gated client policy here would EXPOSE token material to clients —
-- the opposite of the intent.
--
-- Token columns store AES-256-GCM ciphertext produced by ai-server
-- (TOKEN_ENCRYPTION_KEY env, never in this database). Device session tokens
-- are stored only as SHA-256 hashes — the plaintext exists once, in the
-- response that delivers it to the device's OS keyring.
-- =============================================================================

-- One credential row per user per provider: the server-held rotating refresh
-- token (encrypted) plus the most recent access token (encrypted) so devices
-- can be served without forcing a rotation on every request.
CREATE TABLE IF NOT EXISTS user_oauth_credentials (
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    provider text NOT NULL DEFAULT 'atlassian',
    refresh_token_encrypted text NOT NULL,
    access_token_encrypted text,
    access_token_expires_at timestamptz,
    rotated_at timestamptz NOT NULL DEFAULT now(),
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, provider)
);

COMMENT ON TABLE user_oauth_credentials IS
    'Server-held OAuth credentials (encrypted at ai-server). Service-role only: RLS enabled with no policies by design — see migration header.';

-- Per-device session tokens issued by ai-server. The desktop presents its
-- token to obtain fresh access tokens; revoking a row kills that device only.
CREATE TABLE IF NOT EXISTS device_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    organization_id uuid REFERENCES organizations(id),
    token_hash text NOT NULL UNIQUE,          -- SHA-256 hex of the device token
    device_name text,                          -- hostname, for support/audit only
    app_version text,
    created_at timestamptz NOT NULL DEFAULT now(),
    last_seen_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,           -- proposed 180 days from issue
    revoked_at timestamptz                     -- set on logout / lost device
);

COMMENT ON TABLE device_sessions IS
    'Device session tokens (hash only) issued by ai-server. Service-role only: RLS enabled with no policies by design — see migration header.';

CREATE INDEX IF NOT EXISTS idx_device_sessions_user_id
    ON device_sessions(user_id);

-- Service-role-only lockdown: RLS on, zero policies (deny-all for client JWTs).
ALTER TABLE user_oauth_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE device_sessions ENABLE ROW LEVEL SECURITY;
