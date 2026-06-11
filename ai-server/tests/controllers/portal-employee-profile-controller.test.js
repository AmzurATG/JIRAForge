'use strict';

/**
 * WS-B — locations + profile endpoints role enforcement (AC-B1, AC-B2).
 * Plan: plan/2026-06-10_web-productivity-portal_ux-improvements.md
 */

jest.mock('../../src/services/portal-employee-profile-service');
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const profileService = require('../../src/services/portal-employee-profile-service');
const ctrl = require('../../src/controllers/portal-employee-profile-controller');

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

describe('locations read is open to any portal user', () => {
  test.each(['superadmin', 'admin', 'viewer'])('%s can list locations (200)', async (role) => {
    profileService.listLocations.mockResolvedValue([{ id: 'l1', name: 'Tampa', is_active: true }]);
    const res = makeRes();
    await ctrl.getLocations(makeReq({ role }), res);
    expect(res._status).toBe(200);
    expect(res._body.data).toEqual([{ id: 'l1', name: 'Tampa', isActive: true }]);
  });
});

describe('location writes are superadmin-only (AC-B1)', () => {
  test.each(['admin', 'viewer'])('%s is denied (403) for create/update/delete', async (role) => {
    for (const [fn, over] of [
      ['createLocation', { body: { name: 'Tampa' } }],
      ['updateLocation', { params: { id: 'l1' }, body: { name: 'X' } }],
      ['deleteLocation', { params: { id: 'l1' } }],
    ]) {
      const res = makeRes();
      await ctrl[fn](makeReq({ role, ...over }), res);
      expect(res._status).toBe(403);
    }
    expect(profileService.createLocation).not.toHaveBeenCalled();
    expect(profileService.updateLocation).not.toHaveBeenCalled();
    expect(profileService.deleteLocation).not.toHaveBeenCalled();
  });

  test('superadmin create returns 201; service 409 is mapped through', async () => {
    profileService.createLocation.mockResolvedValue({ id: 'l1', name: 'Tampa', is_active: true });
    const ok = makeRes();
    await ctrl.createLocation(makeReq({ body: { name: 'Tampa' } }), ok);
    expect(ok._status).toBe(201);

    const dup = new Error('A location with this name already exists');
    dup.status = 409;
    profileService.createLocation.mockRejectedValue(dup);
    const conflict = makeRes();
    await ctrl.createLocation(makeReq({ body: { name: 'Tampa' } }), conflict);
    expect(conflict._status).toBe(409);
  });
});

describe('employee profile assignment is superadmin-only (AC-B2)', () => {
  test('non-superadmin denied (403), service not called', async () => {
    const res = makeRes();
    await ctrl.setEmployeeProfile(makeReq({ role: 'admin', params: { userId: 'u1' }, body: { locationId: 'l1' } }), res);
    expect(res._status).toBe(403);
    expect(profileService.setEmployeeLocation).not.toHaveBeenCalled();
  });

  test('superadmin sets a location (200) and can clear it with undefined → null', async () => {
    profileService.setEmployeeLocation.mockResolvedValue({ userId: 'u1', locationId: 'l1', locationName: 'Tampa' });
    const res = makeRes();
    await ctrl.setEmployeeProfile(makeReq({ params: { userId: 'u1' }, body: { locationId: 'l1' } }), res);
    expect(res._status).toBe(200);
    expect(profileService.setEmployeeLocation).toHaveBeenCalledWith('u1', 'l1', 'admin1');

    profileService.setEmployeeLocation.mockResolvedValue({ userId: 'u1', locationId: null, locationName: null });
    const res2 = makeRes();
    await ctrl.setEmployeeProfile(makeReq({ params: { userId: 'u1' }, body: {} }), res2);
    expect(profileService.setEmployeeLocation).toHaveBeenLastCalledWith('u1', null, 'admin1');
  });

  test('service 404 (unknown employee) is mapped through', async () => {
    const notFound = new Error('Employee not found');
    notFound.status = 404;
    profileService.setEmployeeLocation.mockRejectedValue(notFound);
    const res = makeRes();
    await ctrl.setEmployeeProfile(makeReq({ params: { userId: 'ghost' }, body: { locationId: 'l1' } }), res);
    expect(res._status).toBe(404);
  });
});
