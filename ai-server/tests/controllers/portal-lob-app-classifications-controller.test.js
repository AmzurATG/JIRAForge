'use strict';

jest.mock('../../src/services/portal-lob-service');
jest.mock('../../src/services/portal-service');
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const lobService = require('../../src/services/portal-lob-service');
const portalService = require('../../src/services/portal-service');
const ctrl = require('../../src/controllers/portal-lob-app-classifications-controller');

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

describe('Per-LOB classifications: superadmin or head of the LOB only', () => {
  test('head of the LOB can read & set (200)', async () => {
    lobService.resolveScope.mockResolvedValue({ isSuperadmin: false, visibleLobIds: ['L1'] });
    lobService.canAccessLob.mockReturnValue(true);
    lobService.listLobClassifications.mockResolvedValue([]);
    lobService.setLobClassification.mockResolvedValue({ id: 'c1' });

    const r1 = makeRes();
    await ctrl.getClassifications(makeReq({ role: 'admin', params: { lobId: 'L1' } }), r1);
    expect(r1._status).toBe(200);

    const r2 = makeRes();
    await ctrl.setClassification(makeReq({ role: 'admin', params: { lobId: 'L1' }, body: { appId: 'a', classification: 'productive' } }), r2);
    expect(r2._status).toBe(200);
    expect(lobService.setLobClassification).toHaveBeenCalledWith('L1', 'a', 'productive', 'admin1');
  });

  test('caller without access to the LOB is denied (403) for read, set, delete, bulk', async () => {
    lobService.resolveScope.mockResolvedValue({ isSuperadmin: false, visibleLobIds: ['L1'] });
    lobService.canAccessLob.mockReturnValue(false);

    const calls = [
      ['getClassifications', { params: { lobId: 'L2' } }],
      ['setClassification', { params: { lobId: 'L2' }, body: { appId: 'a', classification: 'productive' } }],
      ['deleteClassification', { params: { lobId: 'L2', appId: 'a' } }],
      ['bulkSet', { params: { lobId: 'L2' }, body: { items: [] } }],
    ];
    for (const [fn, over] of calls) {
      const res = makeRes();
      await ctrl[fn](makeReq({ role: 'admin', ...over }), res);
      expect(res._status).toBe(403);
    }
    expect(lobService.setLobClassification).not.toHaveBeenCalled();
    expect(lobService.deleteLobClassification).not.toHaveBeenCalled();
  });

  test('maps service error.status (404 unknown LOB) to response', async () => {
    lobService.resolveScope.mockResolvedValue({ isSuperadmin: true, visibleLobIds: null });
    lobService.canAccessLob.mockReturnValue(true);
    const err = new Error('LOB not found'); err.status = 404;
    lobService.setLobClassification.mockRejectedValue(err);
    const res = makeRes();
    await ctrl.setClassification(makeReq({ role: 'superadmin', params: { lobId: 'missing' }, body: { appId: 'a', classification: 'productive' } }), res);
    expect(res._status).toBe(404);
  });
});

describe('getUnlistedApps cleans display names (AC-A1)', () => {
  test('rows carry a cleaned displayName alongside the raw identifier', async () => {
    lobService.resolveScope.mockResolvedValue({ isSuperadmin: true, visibleLobIds: null });
    lobService.canAccessLob.mockReturnValue(true);
    lobService.userIdsForLobs.mockResolvedValue(['u1']);
    lobService.listCatalog.mockResolvedValue({ data: [{ identifier: 'code.exe' }], totalCount: 1 });
    portalService.getApplicationUsage.mockResolvedValue({
      data: [
        { applicationName: 'ShellExperienceHost.exe', totalHours: 1.2, sessionCount: 3, employeeCount: 2 },
        { applicationName: 'org.gnome.Nautilus', totalHours: 0.5, sessionCount: 1, employeeCount: 1 },
        // already in the catalog — must be excluded
        { applicationName: 'code.exe', totalHours: 9, sessionCount: 9, employeeCount: 3 },
      ],
      pagination: { totalCount: 3 },
    });

    const res = makeRes();
    await ctrl.getUnlistedApps(makeReq({ params: { lobId: 'L1' } }), res);

    expect(res._status).toBe(200);
    const rows = res._body.data;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      identifier: 'ShellExperienceHost.exe',
      displayName: 'Shell Experience Host',
    });
    expect(rows[1]).toMatchObject({
      identifier: 'org.gnome.Nautilus',
      displayName: 'Nautilus',
    });
  });
});
