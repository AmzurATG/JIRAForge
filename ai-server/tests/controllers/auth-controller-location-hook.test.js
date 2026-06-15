'use strict';

/**
 * Token exchange must never block or fail on the working-location hook
 * (plan AC6). The detection call is fire-and-forget: a throwing detection
 * service still yields a 200 with a minted Supabase token.
 * Plan: plan/2026-06-12_cross-component_automatic-employee-location-detection.md
 */

jest.mock('axios');
jest.mock('../../src/services/location-detection-service');
jest.mock('../../src/services/db/supabase-client');
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const axios = require('axios');
const { getClient } = require('../../src/services/db/supabase-client');
const locationDetectionService = require('../../src/services/location-detection-service');
const logger = require('../../src/utils/logger');
const authController = require('../../src/controllers/auth-controller');

function makeFakeSupabase() {
  return {
    from: jest.fn((table) => {
      if (table === 'users') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { id: 'u1', organization_id: 'org1', supabase_user_id: 'u1' },
                error: null,
              }),
            }),
          }),
          update: () => ({ eq: async () => ({ error: null }) }),
        };
      }
      if (table === 'organizations') {
        return {
          select: () => ({
            eq: () => ({
              single: async () => ({ data: { jira_cloud_id: 'cloud-1' }, error: null }),
            }),
          }),
        };
      }
      throw new Error(`Unexpected table in test: ${table}`);
    }),
  };
}

function makeRes() {
  const res = { _status: 200, _body: null };
  res.status = jest.fn(function (c) { this._status = c; return this; });
  res.json = jest.fn(function (b) { this._body = b; return this; });
  return res;
}

describe('exchangeToken × location-detection hook (AC6)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.SUPABASE_JWT_SECRET = 'test-secret';
    process.env.SUPABASE_URL = 'https://testref.supabase.co';
    axios.get.mockResolvedValue({ data: { account_id: 'acc-1', email: 'e@example.com', name: 'E' } });
    getClient.mockReturnValue(makeFakeSupabase());
  });

  test('returns 200 with a token even when the detection service rejects', async () => {
    locationDetectionService.recordWorkingLocation.mockRejectedValue(new Error('detection exploded'));

    const req = { body: { atlassian_token: 'tok' }, ip: '49.207.10.5' };
    const res = makeRes();
    await authController.exchangeToken(req, res);
    await new Promise(setImmediate); // let the fire-and-forget rejection settle

    expect(res._status).toBe(200);
    expect(res._body.success).toBe(true);
    expect(typeof res._body.supabase_token).toBe('string');
    expect(locationDetectionService.recordWorkingLocation).toHaveBeenCalledWith('u1', '49.207.10.5');
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Working-location detection skipped'),
      'detection exploded'
    );
  });

  test('the hook receives the resolved user and request IP on the happy path', async () => {
    locationDetectionService.recordWorkingLocation.mockResolvedValue(null);

    const req = { body: { atlassian_token: 'tok' }, ip: '::ffff:49.207.10.5' };
    const res = makeRes();
    await authController.exchangeToken(req, res);

    expect(res._status).toBe(200);
    expect(locationDetectionService.recordWorkingLocation).toHaveBeenCalledWith('u1', '::ffff:49.207.10.5');
  });
});
