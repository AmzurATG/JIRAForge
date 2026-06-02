'use strict';

jest.mock('../../src/services/portal-lob-service');
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const lobService = require('../../src/services/portal-lob-service');
const ctrl = require('../../src/controllers/portal-lob-controller');

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

describe('LOB CRUD is superadmin-only', () => {
  test('createLob: superadmin allowed (201)', async () => {
    lobService.createLob.mockResolvedValue({ id: 'L1', name: 'Cloud' });
    const res = makeRes();
    await ctrl.createLob(makeReq({ role: 'superadmin', body: { name: 'Cloud' } }), res);
    expect(res._status).toBe(201);
    expect(lobService.createLob).toHaveBeenCalledWith({ name: 'Cloud', description: undefined }, 'admin1');
  });

  test('createLob: non-superadmin denied (403), service not called', async () => {
    const res = makeRes();
    await ctrl.createLob(makeReq({ role: 'admin', body: { name: 'Cloud' } }), res);
    expect(res._status).toBe(403);
    expect(lobService.createLob).not.toHaveBeenCalled();
  });

  test('updateLob / deleteLob: non-superadmin denied (403)', async () => {
    const r1 = makeRes(); await ctrl.updateLob(makeReq({ role: 'viewer', params: { lobId: 'L1' }, body: { name: 'x' } }), r1);
    const r2 = makeRes(); await ctrl.deleteLob(makeReq({ role: 'admin', params: { lobId: 'L1' } }), r2);
    expect(r1._status).toBe(403);
    expect(r2._status).toBe(403);
    expect(lobService.updateLob).not.toHaveBeenCalled();
    expect(lobService.deleteLob).not.toHaveBeenCalled();
  });

  test('createLob: maps service error.status (409) to response', async () => {
    const err = new Error('dup'); err.status = 409;
    lobService.createLob.mockRejectedValue(err);
    const res = makeRes();
    await ctrl.createLob(makeReq({ role: 'superadmin', body: { name: 'Cloud' } }), res);
    expect(res._status).toBe(409);
  });
});

describe('Member listing is scoped (superadmin or head of the LOB)', () => {
  test('head of the LOB can list members (200)', async () => {
    lobService.resolveScope.mockResolvedValue({ isSuperadmin: false, visibleLobIds: ['L1'] });
    lobService.canAccessLob.mockReturnValue(true);
    lobService.listMembers.mockResolvedValue({ data: [], pagination: { page: 1, limit: 20, totalCount: 0 } });
    const res = makeRes();
    await ctrl.getMembers(makeReq({ role: 'admin', params: { lobId: 'L1' } }), res);
    expect(res._status).toBe(200);
    expect(lobService.listMembers).toHaveBeenCalled();
  });

  test('head of a DIFFERENT LOB is denied (403), no DB read', async () => {
    lobService.resolveScope.mockResolvedValue({ isSuperadmin: false, visibleLobIds: ['L1'] });
    lobService.canAccessLob.mockReturnValue(false);
    const res = makeRes();
    await ctrl.getMembers(makeReq({ role: 'admin', params: { lobId: 'L2' } }), res);
    expect(res._status).toBe(403);
    expect(lobService.listMembers).not.toHaveBeenCalled();
  });
});

describe('Member & head assignment is superadmin-only', () => {
  test('addMembers: superadmin allowed (201)', async () => {
    lobService.addMembers.mockResolvedValue({ addedCount: 2, invalidUserIds: [] });
    const res = makeRes();
    await ctrl.addMembers(makeReq({ role: 'superadmin', params: { lobId: 'L1' }, body: { userIds: ['u1', 'u2'] } }), res);
    expect(res._status).toBe(201);
  });

  test('addMembers / removeMember / addHeads / removeHead / getHeads: non-superadmin denied (403)', async () => {
    const calls = [
      ['addMembers', { params: { lobId: 'L1' }, body: { userIds: ['u1'] } }],
      ['removeMember', { params: { lobId: 'L1', userId: 'u1' } }],
      ['getHeads', { params: { lobId: 'L1' } }],
      ['addHeads', { params: { lobId: 'L1' }, body: { adminIds: ['a1'] } }],
      ['removeHead', { params: { lobId: 'L1', adminId: 'a1' } }],
    ];
    for (const [fn, over] of calls) {
      const res = makeRes();
      await ctrl[fn](makeReq({ role: 'admin', ...over }), res);
      expect(res._status).toBe(403);
    }
    expect(lobService.addMembers).not.toHaveBeenCalled();
    expect(lobService.addHeads).not.toHaveBeenCalled();
    expect(lobService.removeHead).not.toHaveBeenCalled();
  });
});
