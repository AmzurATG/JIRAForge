/**
 * Forge Auth Middleware — boundary tests for nbf/exp clock tolerance.
 *
 * Targets the asymmetric clock-tolerance behavior introduced as a follow-up
 * to PR #205:
 *   NBF_TOLERANCE = 600s (generous, for host clock drift)
 *   EXP_TOLERANCE = 30s  (tight, to limit replay window)
 *
 * Tests call `tryVerifyWithAudiences` directly (exported as
 * `_tryVerifyWithAudiences`) with a stub `jose` object — this avoids the
 * dynamic `await import('jose')` in production code, which Jest's CJS
 * transformer cannot intercept without --experimental-vm-modules.
 */

'use strict';

// Set FORGE_APP_ID before requiring the module — it throws at load time otherwise.
process.env.FORGE_APP_ID = 'ari:cloud:ecosystem::app/test-app-id';

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { _tryVerifyWithAudiences } = require('../../src/middleware/forge-auth');

const APP_ID = 'ari:cloud:ecosystem::app/test-app-id';
const APP_UUID = 'test-app-id';

/**
 * Build a stub `jose` object whose compactVerify returns a payload encoded
 * the way the real jose library returns it: { payload: <Uint8Array>, ... }.
 */
function makeStubJose(payload) {
  return {
    compactVerify: jest.fn().mockResolvedValue({
      payload: new TextEncoder().encode(JSON.stringify(payload)),
      protectedHeader: { alg: 'RS256' },
    }),
  };
}

function basePayload(overrides = {}) {
  const now = Math.floor(Date.now() / 1000);
  return {
    iss: 'forge/invocation-token',
    aud: APP_ID,
    nbf: now - 5,
    exp: now + 60,
    app: { id: APP_ID, installationId: 'inst-1', environment: { type: 'PRODUCTION' } },
    context: { cloudId: 'cloud-1', accountId: 'acct-1' },
    ...overrides,
  };
}

const verify = (payload) =>
  _tryVerifyWithAudiences(makeStubJose(payload), {}, 'unused.token', [APP_ID, APP_UUID]);

describe('forge-auth — claim validation (iss/aud)', () => {
  it('accepts a well-formed token with all claims present', async () => {
    const result = await verify(basePayload());
    expect(result.iss).toBe('forge/invocation-token');
    expect(result.aud).toBe(APP_ID);
  });

  it('rejects when iss is wrong', async () => {
    await expect(verify(basePayload({ iss: 'forge/wrong' })))
      .rejects.toThrow('unexpected "iss"');
  });

  it('rejects when aud does not match any configured FORGE_APP_ID', async () => {
    await expect(verify(basePayload({ aud: 'ari:cloud:ecosystem::app/different' })))
      .rejects.toThrow('unexpected "aud"');
  });

  it('accepts when aud matches the UUID-only form (slug stripped)', async () => {
    const result = await verify(basePayload({ aud: APP_UUID }));
    expect(result.aud).toBe(APP_UUID);
  });
});

describe('forge-auth — exp boundary (EXP_TOLERANCE = 30s)', () => {
  it('accepts a token whose exp is exactly at "now" (not yet expired)', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(verify(basePayload({ exp: now }))).resolves.toBeDefined();
  });

  it('accepts a token whose exp expired 29s ago (within EXP_TOLERANCE)', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(verify(basePayload({ exp: now - 29 }))).resolves.toBeDefined();
  });

  it('rejects a token whose exp expired 31s ago (past EXP_TOLERANCE)', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(verify(basePayload({ exp: now - 31 })))
      .rejects.toThrow('Token expired');
  });

  it('rejects a token expired ~10 min ago (replay defence)', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(verify(basePayload({ exp: now - 600 })))
      .rejects.toThrow('Token expired');
  });
});

describe('forge-auth — nbf boundary (NBF_TOLERANCE = 600s)', () => {
  it('accepts a token whose nbf is exactly "now"', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(verify(basePayload({ nbf: now }))).resolves.toBeDefined();
  });

  it('accepts a token whose nbf is 599s in the future (within NBF_TOLERANCE)', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(verify(basePayload({ nbf: now + 599, exp: now + 1200 })))
      .resolves.toBeDefined();
  });

  it('rejects a token whose nbf is 601s in the future (past NBF_TOLERANCE)', async () => {
    const now = Math.floor(Date.now() / 1000);
    await expect(verify(basePayload({ nbf: now + 601, exp: now + 1200 })))
      .rejects.toThrow('"nbf" claim timestamp check failed');
  });

  it('accepts the production drift scenario (nbf ~120s ahead of now)', async () => {
    // Mirrors the original prod incident: server clock 120s behind Atlassian.
    // Old 120s tolerance failed at observed 122s drift; new 600s leaves headroom.
    const now = Math.floor(Date.now() / 1000);
    await expect(verify(basePayload({ nbf: now + 122, exp: now + 122 + 60 })))
      .resolves.toBeDefined();
  });
});
