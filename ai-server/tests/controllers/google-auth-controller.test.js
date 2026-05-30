'use strict';

/**
 * Google Auth Controller (non-Jira desktop SSO) unit tests.
 */

jest.mock('jsonwebtoken', () => ({ sign: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), debug: jest.fn(),
}));
jest.mock('../../src/services/db/supabase-client', () => ({
  getClient: jest.fn(() => ({})),
}));
jest.mock('../../src/services/db/user-db-service', () => ({
  getOrgIdByEmailDomain: jest.fn(),
  findOrCreateGoogleUser: jest.fn(),
}));

const jwt = require('jsonwebtoken');
const userDbService = require('../../src/services/db/user-db-service');
const { desktopGoogleLogin, desktopGoogleRefresh } = require('../../src/controllers/google-auth-controller');

// Helper to mock the two sequential fetch calls (token exchange, then userinfo).
function mockGoogleFetch({ userinfo }) {
  global.fetch = jest.fn()
    .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'g-access', refresh_token: 'g-refresh' }) })
    .mockResolvedValueOnce({ ok: true, json: async () => userinfo });
}

function makeRes() {
  return { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
}

describe('desktopGoogleLogin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.GOOGLE_CLIENT_ID = 'gcid';
    process.env.GOOGLE_CLIENT_SECRET = 'gsecret';
    process.env.SUPABASE_JWT_SECRET = 'jwt-secret';
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    jwt.sign.mockReturnValue('signed.jwt.token');
  });
  afterEach(() => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.SUPABASE_JWT_SECRET;
    delete process.env.SUPABASE_URL;
  });

  test('valid company-domain login mints a Supabase JWT with sub=users.id and org_id', async () => {
    mockGoogleFetch({ userinfo: { id: 'google-sub-1', email: 'vishnu@amzur.com', verified_email: true, name: 'Vishnu', hd: 'amzur.com' } });
    userDbService.getOrgIdByEmailDomain.mockResolvedValue('org-123');
    userDbService.findOrCreateGoogleUser.mockResolvedValue({ id: 'user-999', organization_id: 'org-123' });

    const req = { body: { code: 'abc', redirect_uri: 'http://127.0.0.1:51777/auth/google/callback', code_verifier: 'v' } };
    const res = makeRes();
    await desktopGoogleLogin(req, res);

    expect(userDbService.getOrgIdByEmailDomain).toHaveBeenCalledWith('amzur.com');
    expect(userDbService.findOrCreateGoogleUser).toHaveBeenCalledWith(expect.objectContaining({
      googleSub: 'google-sub-1', email: 'vishnu@amzur.com', organizationId: 'org-123',
    }));
    const payload = jwt.sign.mock.calls[0][0];
    expect(payload.sub).toBe('user-999');
    expect(payload.role).toBe('authenticated');
    expect(payload.app_metadata.org_id).toBe('org-123');
    expect(payload.app_metadata.provider).toBe('google');
    expect(payload.atlassian_account_id).toBeNull();
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true, supabase_token: 'signed.jwt.token',
      user: expect.objectContaining({ id: 'user-999', organization_id: 'org-123', jira_cloud_id: null }),
    }));
  });

  test('unregistered domain → 403, no user created', async () => {
    mockGoogleFetch({ userinfo: { id: 'gsub', email: 'someone@random.com', verified_email: true, name: 'X' } });
    userDbService.getOrgIdByEmailDomain.mockResolvedValue(null);

    const req = { body: { code: 'abc', redirect_uri: 'http://127.0.0.1:51777/auth/google/callback', code_verifier: 'v' } };
    const res = makeRes();
    await desktopGoogleLogin(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(userDbService.findOrCreateGoogleUser).not.toHaveBeenCalled();
  });

  test('unverified Google email → 401', async () => {
    mockGoogleFetch({ userinfo: { id: 'gsub', email: 'vishnu@amzur.com', verified_email: false, name: 'V' } });

    const req = { body: { code: 'abc', redirect_uri: 'http://127.0.0.1:51777/auth/google/callback', code_verifier: 'v' } };
    const res = makeRes();
    await desktopGoogleLogin(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
    expect(userDbService.getOrgIdByEmailDomain).not.toHaveBeenCalled();
  });

  test('missing code → 400', async () => {
    const req = { body: {} };
    const res = makeRes();
    await desktopGoogleLogin(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('missing code_verifier → 400 (PKCE required)', async () => {
    const req = { body: { code: 'abc', redirect_uri: 'http://127.0.0.1:51777/auth/google/callback' } };
    const res = makeRes();
    await desktopGoogleLogin(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  test('non-loopback redirect_uri → 400 (not a generic token proxy)', async () => {
    const req = { body: { code: 'abc', redirect_uri: 'https://evil.example.com/callback', code_verifier: 'v' } };
    const res = makeRes();
    await desktopGoogleLogin(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(userDbService.getOrgIdByEmailDomain).not.toHaveBeenCalled();
  });

  test('refresh re-mints a Supabase JWT from a stored google_refresh_token', async () => {
    mockGoogleFetch({ userinfo: { id: 'google-sub-1', email: 'vishnu@amzur.com', verified_email: true, name: 'Vishnu', hd: 'amzur.com' } });
    userDbService.getOrgIdByEmailDomain.mockResolvedValue('org-123');
    userDbService.findOrCreateGoogleUser.mockResolvedValue({ id: 'user-999', organization_id: 'org-123' });

    const req = { body: { google_refresh_token: 'g-refresh' } };
    const res = makeRes();
    await desktopGoogleRefresh(req, res);

    const payload = jwt.sign.mock.calls[0][0];
    expect(payload.sub).toBe('user-999');
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, supabase_token: 'signed.jwt.token' }));
  });

  test('refresh keeps the caller\'s refresh token when Google omits a new one', async () => {
    // Google refresh responses usually omit refresh_token; the response must echo
    // back the caller's existing token so the desktop keeps a usable credential.
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: 'g-access' }) }) // no refresh_token
      .mockResolvedValueOnce({ ok: true, json: async () => ({ id: 'google-sub-1', email: 'vishnu@amzur.com', verified_email: true, name: 'Vishnu', hd: 'amzur.com' }) });
    userDbService.getOrgIdByEmailDomain.mockResolvedValue('org-123');
    userDbService.findOrCreateGoogleUser.mockResolvedValue({ id: 'user-999', organization_id: 'org-123' });

    const req = { body: { google_refresh_token: 'caller-refresh' } };
    const res = makeRes();
    await desktopGoogleRefresh(req, res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true, google_refresh_token: 'caller-refresh',
    }));
  });

  test('refresh without a token → 400', async () => {
    const req = { body: {} };
    const res = makeRes();
    await desktopGoogleRefresh(req, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });
});
