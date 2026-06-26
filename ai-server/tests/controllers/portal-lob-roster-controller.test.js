'use strict';

/**
 * Portal LOB roster controller — import/delete are superadmin-only; read is
 * scoped (superadmin or head of the LOB). Service errors map by .status.
 * Spec: plan/2026-06-26_web-productivity-portal_lob-roster-adoption.md
 */

jest.mock('../../src/services/portal-lob-service');
jest.mock('../../src/services/portal-lob-roster-service');
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const lobService = require('../../src/services/portal-lob-service');
const rosterService = require('../../src/services/portal-lob-roster-service');
const ctrl = require('../../src/controllers/portal-lob-roster-controller');

function makeRes() {
  const res = { _status: 200, _body: null };
  res.status = jest.fn(function (c) { this._status = c; return this; });
  res.json = jest.fn(function (b) { this._body = b; return this; });
  return res;
}
function makeReq({ role = 'superadmin', userId = 'admin1', params = {}, query = {}, body = {} } = {}) {
  return { portalUser: { userId, role, orgId: 'o', email: 'e' }, params, query, body };
}

beforeEach(() => jest.clearAllMocks());

describe('importRoster — superadmin only', () => {
  test('superadmin allowed; service called; summary returned (200)', async () => {
    rosterService.importRoster.mockResolvedValue({ received: 3, imported: 2, duplicatesSkipped: 1, invalidSkipped: 0 });
    const res = makeRes();
    await ctrl.importRoster(makeReq({
      role: 'superadmin', params: { lobId: 'L1' }, body: { filename: 'r.csv', contentBase64: 'eA==' },
    }), res);
    expect(res._status).toBe(200);
    expect(res._body).toMatchObject({ success: true, imported: 2 });
    expect(rosterService.importRoster).toHaveBeenCalledWith('L1', { filename: 'r.csv', contentBase64: 'eA==' }, 'admin1');
  });

  test('non-superadmin denied (403), service not called', async () => {
    const res = makeRes();
    await ctrl.importRoster(makeReq({ role: 'admin', params: { lobId: 'L1' }, body: {} }), res);
    expect(res._status).toBe(403);
    expect(rosterService.importRoster).not.toHaveBeenCalled();
  });
});

describe('getRoster — scoped read', () => {
  test('head of the LOB can read (200)', async () => {
    lobService.resolveScope.mockResolvedValue({ isSuperadmin: false, visibleLobIds: ['L1'] });
    lobService.canAccessLob.mockReturnValue(true);
    rosterService.getRoster.mockResolvedValue({ data: [], pagination: { page: 1, limit: 20, totalCount: 0 } });
    const res = makeRes();
    await ctrl.getRoster(makeReq({ role: 'admin', params: { lobId: 'L1' } }), res);
    expect(res._status).toBe(200);
    expect(rosterService.getRoster).toHaveBeenCalled();
  });

  test('head of a DIFFERENT LOB denied (403), no read', async () => {
    lobService.resolveScope.mockResolvedValue({ isSuperadmin: false, visibleLobIds: ['L1'] });
    lobService.canAccessLob.mockReturnValue(false);
    const res = makeRes();
    await ctrl.getRoster(makeReq({ role: 'admin', params: { lobId: 'L2' } }), res);
    expect(res._status).toBe(403);
    expect(rosterService.getRoster).not.toHaveBeenCalled();
  });
});

describe('removeRosterEntry — superadmin only', () => {
  test('superadmin allowed (200)', async () => {
    rosterService.removeRosterEntry.mockResolvedValue(undefined);
    const res = makeRes();
    await ctrl.removeRosterEntry(makeReq({ role: 'superadmin', params: { lobId: 'L1', id: 'r1' } }), res);
    expect(res._status).toBe(200);
    expect(rosterService.removeRosterEntry).toHaveBeenCalledWith('L1', 'r1');
  });

  test('non-superadmin denied (403)', async () => {
    const res = makeRes();
    await ctrl.removeRosterEntry(makeReq({ role: 'admin', params: { lobId: 'L1', id: 'r1' } }), res);
    expect(res._status).toBe(403);
    expect(rosterService.removeRosterEntry).not.toHaveBeenCalled();
  });

  test('service error.status (404) is mapped', async () => {
    const err = new Error('Roster entry not found'); err.status = 404;
    rosterService.removeRosterEntry.mockRejectedValue(err);
    const res = makeRes();
    await ctrl.removeRosterEntry(makeReq({ role: 'superadmin', params: { lobId: 'L1', id: 'x' } }), res);
    expect(res._status).toBe(404);
  });
});
