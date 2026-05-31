'use strict';

/**
 * Desktop dual-auth middleware tests.
 * Accepts a Supabase JWT (Google users) OR an Atlassian token (Jira users).
 */

jest.mock('axios');
jest.mock('jsonwebtoken', () => ({ verify: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(),
}));

const axios = require('axios');
const jwt = require('jsonwebtoken');
const desktopAuth = require('../../src/middleware/desktop-auth');

function makeRes() {
  const res = {};
  res.status = jest.fn().mockReturnValue(res);
  res.json = jest.fn().mockReturnValue(res);
  return res;
}

describe('desktopAuth middleware', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_JWT_SECRET = 'test-secret';
  });
  afterEach(() => {
    delete process.env.SUPABASE_JWT_SECRET;
  });

  test('401 when Authorization header missing', async () => {
    const req = { headers: {} };
    const res = makeRes();
    const next = jest.fn();
    await desktopAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('401 on malformed authorization format', async () => {
    const req = { headers: { authorization: 'NotBearer xyz' } };
    const res = makeRes();
    const next = jest.fn();
    await desktopAuth(req, res, next);
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  test('Google user: valid Supabase JWT passes (no Atlassian call) and attaches supabaseUser', async () => {
    jwt.verify.mockReturnValue({ sub: 'user-999', app_metadata: { org_id: 'org-1', provider: 'google' } });
    const req = { headers: { authorization: 'Bearer supabase.jwt.token' } };
    const res = makeRes();
    const next = jest.fn();

    await desktopAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.authType).toBe('supabase');
    expect(req.supabaseUser.sub).toBe('user-999');
    expect(axios.get).not.toHaveBeenCalled(); // local verify only — no network round-trip
  });

  test('Jira user: Atlassian token passes when JWT verify fails, attaches atlassianUser', async () => {
    jwt.verify.mockImplementation(() => { throw new Error('invalid signature'); }); // not our JWT
    axios.get.mockResolvedValue({ data: { account_id: 'acc-1', email: 'a@b.com' } });
    const req = { headers: { authorization: 'Bearer atlassian-opaque-token' } };
    const res = makeRes();
    const next = jest.fn();

    await desktopAuth(req, res, next);

    expect(next).toHaveBeenCalled();
    expect(req.authType).toBe('atlassian');
    expect(req.atlassianUser).toEqual({ account_id: 'acc-1', email: 'a@b.com' });
  });

  test('401 when neither a valid Supabase JWT nor a valid Atlassian token', async () => {
    jwt.verify.mockImplementation(() => { throw new Error('invalid signature'); });
    axios.get.mockRejectedValue({ response: { status: 401 } });
    const req = { headers: { authorization: 'Bearer garbage' } };
    const res = makeRes();
    const next = jest.fn();

    await desktopAuth(req, res, next);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});
