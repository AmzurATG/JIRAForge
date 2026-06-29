'use strict';

/**
 * Tests for the server-side token custody service (Phase 2).
 * Plan: plan/2026-06-12_auth_server-side-token-custody.md
 *
 * The service is the single serialized owner of each user's Atlassian rotating
 * refresh token: encrypted at rest, rotated only server-side, with prompt
 * same-token retry on network failure (inside Atlassian's 10-minute reuse
 * window). Devices authenticate with revocable session tokens stored as hashes.
 */

jest.mock('axios');
jest.mock('../../src/services/db/supabase-client', () => ({
  getClient: jest.fn()
}));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn()
}));

const axios = require('axios');
const { getClient } = require('../../src/services/db/supabase-client');

// 32-byte key, hex-encoded — mirrors the TOKEN_ENCRYPTION_KEY env contract.
const TEST_KEY = 'a'.repeat(64);

/**
 * Minimal chainable Supabase query mock. Each call to from() returns a builder
 * whose terminal methods resolve to the next queued result (default empty).
 */
function makeSupabaseMock() {
  const calls = [];
  const queue = [];
  const builder = () => {
    const chain = {
      _table: null,
      _op: null,
      _payload: null,
      _filters: []   // [op, column, value] tuples (eq/is/gt/neq) for scope assertions
    };
    const record = (op, payload) => {
      chain._op = chain._op || op;
      // Only write-ops carry a payload worth asserting on; a trailing
      // .select('id') after .insert(payload) must not clobber it.
      if (op !== 'select' && payload !== undefined) {
        chain._payload = payload;
      }
      return proxy;
    };
    const filter = (op, col, val) => { chain._filters.push([op, col, val]); return proxy; };
    const result = () => Promise.resolve(queue.length ? queue.shift() : { data: null, error: null });
    const proxy = {
      select: (...a) => record('select', a[0]),
      upsert: (p) => record('upsert', p),
      insert: (p) => record('insert', p),
      update: (p) => record('update', p),
      eq: (c, v) => filter('eq', c, v),
      is: (c, v) => filter('is', c, v),
      gt: (c, v) => filter('gt', c, v),
      neq: (c, v) => filter('neq', c, v),
      single: () => { calls.push(chain); return result(); },
      maybeSingle: () => { calls.push(chain); return result(); },
      then: (resolve, reject) => { calls.push(chain); return result().then(resolve, reject); }
    };
    return { chain, proxy };
  };
  const client = {
    from: jest.fn((table) => {
      const { chain, proxy } = builder();
      chain._table = table;
      return proxy;
    })
  };
  return { client, calls, queue };
}

describe('Token Custody Service', () => {
  let custody;
  let supa;

  beforeEach(() => {
    jest.clearAllMocks();
    // No resetModules: the service reads TOKEN_ENCRYPTION_KEY at call time, and
    // resetting would detach it from the axios/getClient mock instances bound above.
    process.env.TOKEN_ENCRYPTION_KEY = TEST_KEY;
    process.env.ATLASSIAN_CLIENT_ID = 'client-id';
    process.env.ATLASSIAN_CLIENT_SECRET = 'client-secret';
    supa = makeSupabaseMock();
    getClient.mockReturnValue(supa.client);
    custody = require('../../src/services/token-custody-service');
  });

  // ---------------------------------------------------------------------------
  // Encryption at rest
  // ---------------------------------------------------------------------------
  describe('encryption', () => {
    it('round-trips a token and never stores plaintext', () => {
      const ciphertext = custody.encryptToken('secret-refresh-token');
      expect(ciphertext).not.toContain('secret-refresh-token');
      expect(custody.decryptToken(ciphertext)).toBe('secret-refresh-token');
    });

    it('uses a fresh IV per encryption (identical plaintext, different ciphertext)', () => {
      const a = custody.encryptToken('same-token');
      const b = custody.encryptToken('same-token');
      expect(a).not.toBe(b);
      expect(custody.decryptToken(a)).toBe('same-token');
      expect(custody.decryptToken(b)).toBe('same-token');
    });

    it('rejects tampered ciphertext (GCM auth)', () => {
      const ciphertext = custody.encryptToken('secret');
      const tampered = ciphertext.slice(0, -4) + (ciphertext.endsWith('AAAA') ? 'BBBB' : 'AAAA');
      expect(() => custody.decryptToken(tampered)).toThrow();
    });

    it('refuses to operate without a valid 32-byte key', () => {
      process.env.TOKEN_ENCRYPTION_KEY = 'too-short';
      expect(() => custody.encryptToken('x')).toThrow(/TOKEN_ENCRYPTION_KEY/);
    });
  });

  // ---------------------------------------------------------------------------
  // Device session tokens
  // ---------------------------------------------------------------------------
  describe('device sessions', () => {
    it('issues a token but persists only its SHA-256 hash', async () => {
      supa.queue.push({ data: { id: 'session-1' }, error: null });
      const { deviceToken } = await custody.issueDeviceSession('user-1', {
        organizationId: 'org-1',
        deviceName: 'LAP-001',
        appVersion: '18.0.1'
      });

      expect(deviceToken).toBeTruthy();
      const inserted = supa.calls.find((c) => c._table === 'device_sessions' && c._op === 'insert');
      expect(inserted).toBeTruthy();
      expect(inserted._payload.token_hash).toBe(custody.hashDeviceToken(deviceToken));
      expect(JSON.stringify(inserted._payload)).not.toContain(deviceToken);
    });

    it('revokes the user\'s PRIOR active sessions on the SAME device (no token accumulation)', async () => {
      supa.queue.push({ data: { id: 'new-session-id' }, error: null }); // the insert
      supa.queue.push({ data: [{ id: 'old-1' }], error: null });        // the revoke update

      await custody.issueDeviceSession('user-1', { deviceName: 'LAP-001', appVersion: '18.0.1' });

      const revoke = supa.calls.find((c) => c._table === 'device_sessions' && c._op === 'update');
      expect(revoke).toBeTruthy();
      expect(revoke._payload.revoked_at).toBeTruthy();
      // Correctly scoped: this user, this device, only still-active rows, EXCLUDING
      // the session just created.
      expect(revoke._filters).toContainEqual(['eq', 'user_id', 'user-1']);
      expect(revoke._filters).toContainEqual(['eq', 'device_name', 'LAP-001']);
      expect(revoke._filters).toContainEqual(['is', 'revoked_at', null]);
      expect(revoke._filters).toContainEqual(['neq', 'id', 'new-session-id']);
    });

    it('does NOT revoke anything when device_name is unknown (cannot scope safely)', async () => {
      supa.queue.push({ data: { id: 'new-id' }, error: null });
      await custody.issueDeviceSession('user-1', { deviceName: null });
      const revoke = supa.calls.find((c) => c._table === 'device_sessions' && c._op === 'update');
      expect(revoke).toBeFalsy();
    });

    it('still returns the new token if prior-session cleanup fails (best-effort)', async () => {
      supa.queue.push({ data: { id: 'new-id' }, error: null });        // insert ok
      supa.queue.push({ data: null, error: { message: 'cleanup blew up' } }); // revoke errors
      const { deviceToken } = await custody.issueDeviceSession('user-1', { deviceName: 'LAP-001' });
      expect(deviceToken).toBeTruthy(); // issuance must not fail over cleanup
    });

    it('verifies a valid session and returns the user identity', async () => {
      supa.queue.push({
        data: { id: 's1', user_id: 'user-1', organization_id: 'org-1', revoked_at: null, expires_at: new Date(Date.now() + 86400000).toISOString() },
        error: null
      });
      const session = await custody.verifyDeviceSession('device-token-abc');
      expect(session).toEqual(expect.objectContaining({ userId: 'user-1', organizationId: 'org-1' }));
    });

    it('rejects revoked and expired sessions', async () => {
      supa.queue.push({
        data: { id: 's1', user_id: 'user-1', revoked_at: '2026-06-01T00:00:00Z', expires_at: new Date(Date.now() + 86400000).toISOString() },
        error: null
      });
      expect(await custody.verifyDeviceSession('revoked-token')).toBeNull();

      supa.queue.push({
        data: { id: 's2', user_id: 'user-1', revoked_at: null, expires_at: new Date(Date.now() - 1000).toISOString() },
        error: null
      });
      expect(await custody.verifyDeviceSession('expired-token')).toBeNull();
    });

    it('rejects unknown tokens', async () => {
      supa.queue.push({ data: null, error: null });
      expect(await custody.verifyDeviceSession('unknown-token')).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // Credential storage + central rotation
  // ---------------------------------------------------------------------------
  describe('getAccessTokenForUser', () => {
    function queueCredential({ accessValidMs }) {
      supa.queue.push({
        data: {
          user_id: 'user-1',
          provider: 'atlassian',
          refresh_token_encrypted: custody.encryptToken('stored-refresh'),
          access_token_encrypted: custody.encryptToken('stored-access'),
          access_token_expires_at: new Date(Date.now() + accessValidMs).toISOString()
        },
        error: null
      });
    }

    it('serves the cached access token without rotating when still valid', async () => {
      queueCredential({ accessValidMs: 30 * 60 * 1000 }); // 30 min left
      const result = await custody.getAccessTokenForUser('user-1');
      expect(result.accessToken).toBe('stored-access');
      expect(axios.post).not.toHaveBeenCalled();
    });

    it('rotates when the access token is near expiry and persists BEFORE returning', async () => {
      queueCredential({ accessValidMs: 60 * 1000 }); // 1 min left -> rotate
      supa.queue.push({ data: null, error: null });   // upsert result
      axios.post.mockResolvedValue({
        data: { access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600 }
      });

      const result = await custody.getAccessTokenForUser('user-1');

      expect(result.accessToken).toBe('new-access');
      expect(axios.post).toHaveBeenCalledTimes(1);
      const sent = axios.post.mock.calls[0][1];
      expect(sent.refresh_token).toBe('stored-refresh');

      const upsert = supa.calls.find((c) => c._table === 'user_oauth_credentials' && c._op === 'upsert');
      expect(upsert).toBeTruthy();
      expect(custody.decryptToken(upsert._payload.refresh_token_encrypted)).toBe('new-refresh');
      expect(JSON.stringify(upsert._payload)).not.toContain('new-refresh');
    });

    it('retries the SAME refresh token promptly after a network failure (reuse window)', async () => {
      queueCredential({ accessValidMs: 0 });
      supa.queue.push({ data: null, error: null });
      const networkError = new Error('socket hang up'); // no .response => network-level
      axios.post
        .mockRejectedValueOnce(networkError)
        .mockResolvedValueOnce({ data: { access_token: 'recovered-access', refresh_token: 'recovered-refresh', expires_in: 3600 } });

      const result = await custody.getAccessTokenForUser('user-1', { retryDelayMs: 1 });

      expect(result.accessToken).toBe('recovered-access');
      expect(axios.post).toHaveBeenCalledTimes(2);
      expect(axios.post.mock.calls[0][1].refresh_token).toBe('stored-refresh');
      expect(axios.post.mock.calls[1][1].refresh_token).toBe('stored-refresh');
    });

    it('surfaces a dead token as OAUTH_REAUTH_REQUIRED without overwriting the credential', async () => {
      queueCredential({ accessValidMs: 0 });
      axios.post.mockRejectedValue({
        response: { status: 403, data: { error: 'invalid_grant', error_description: 'Unknown or invalid refresh token.' } }
      });

      await expect(custody.getAccessTokenForUser('user-1')).rejects.toMatchObject({
        code: 'OAUTH_REAUTH_REQUIRED'
      });
      const upsert = supa.calls.find((c) => c._table === 'user_oauth_credentials' && c._op === 'upsert');
      expect(upsert).toBeFalsy();
    });

    it('throws OAUTH_REAUTH_REQUIRED when no credential is stored for the user', async () => {
      supa.queue.push({ data: null, error: null });
      await expect(custody.getAccessTokenForUser('user-no-credential')).rejects.toMatchObject({
        code: 'OAUTH_REAUTH_REQUIRED'
      });
    });

    it('serializes concurrent requests per user: one rotation, both callers served', async () => {
      // Only ONE credential read + ONE upsert should happen; the second caller
      // must piggyback on the first rotation instead of double-spending the
      // single-use refresh token (the v1.4.5 race, now impossible by design).
      queueCredential({ accessValidMs: 0 });
      supa.queue.push({ data: null, error: null }); // upsert for the single rotation
      let resolveAtlassian;
      axios.post.mockImplementation(
        () => new Promise((resolve) => { resolveAtlassian = resolve; })
      );

      const p1 = custody.getAccessTokenForUser('user-1');
      const p2 = custody.getAccessTokenForUser('user-1');
      await new Promise((r) => setImmediate(r));
      resolveAtlassian({ data: { access_token: 'single-rotation-access', refresh_token: 'r2', expires_in: 3600 } });

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(r1.accessToken).toBe('single-rotation-access');
      expect(r2.accessToken).toBe('single-rotation-access');
    });
  });

  // ---------------------------------------------------------------------------
  // storeCredential (login / migration path)
  // ---------------------------------------------------------------------------
  describe('storeCredential', () => {
    it('upserts the encrypted refresh + access tokens for the user', async () => {
      supa.queue.push({ data: null, error: null });
      await custody.storeCredential('user-1', {
        refreshToken: 'fresh-refresh',
        accessToken: 'fresh-access',
        expiresIn: 3600
      });
      const upsert = supa.calls.find((c) => c._table === 'user_oauth_credentials' && c._op === 'upsert');
      expect(upsert).toBeTruthy();
      expect(custody.decryptToken(upsert._payload.refresh_token_encrypted)).toBe('fresh-refresh');
      expect(custody.decryptToken(upsert._payload.access_token_encrypted)).toBe('fresh-access');
      expect(JSON.stringify(upsert._payload)).not.toContain('fresh-refresh');
    });
  });

  // ---------------------------------------------------------------------------
  // Revocation
  // ---------------------------------------------------------------------------
  describe('revokeDeviceSession', () => {
    it('marks the session revoked by token hash', async () => {
      supa.queue.push({ data: [{ id: 's1' }], error: null });
      const ok = await custody.revokeDeviceSession('device-token-abc');
      expect(ok).toBe(true);
      const update = supa.calls.find((c) => c._table === 'device_sessions' && c._op === 'update');
      expect(update).toBeTruthy();
      expect(update._payload.revoked_at).toBeTruthy();
    });
  });
});
