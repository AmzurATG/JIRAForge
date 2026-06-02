'use strict';

jest.mock('../../src/services/portal-lob-service');
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const lobService = require('../../src/services/portal-lob-service');
const ctrl = require('../../src/controllers/portal-app-catalog-controller');

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

describe('App catalog: read open to any portal user, writes superadmin-only', () => {
  test('getCatalog: a viewer can read (200)', async () => {
    lobService.listCatalog.mockResolvedValue({ data: [], totalCount: 0 });
    const res = makeRes();
    await ctrl.getCatalog(makeReq({ role: 'viewer' }), res);
    expect(res._status).toBe(200);
    expect(lobService.listCatalog).toHaveBeenCalled();
  });

  test('createApp: superadmin allowed (201)', async () => {
    lobService.createCatalogApp.mockResolvedValue({ id: 'app1' });
    const res = makeRes();
    await ctrl.createApp(makeReq({ role: 'superadmin', body: { identifier: 'slack.exe', displayName: 'Slack', matchBy: 'process' } }), res);
    expect(res._status).toBe(201);
  });

  test('createApp / updateApp / deleteApp / bulkImport: non-superadmin denied (403)', async () => {
    const calls = [
      ['createApp', { body: { identifier: 'x', displayName: 'X', matchBy: 'process' } }],
      ['updateApp', { params: { id: 'app1' }, body: { displayName: 'X' } }],
      ['deleteApp', { params: { id: 'app1' } }],
      ['bulkImport', { body: { data: [] } }],
    ];
    for (const [fn, over] of calls) {
      const res = makeRes();
      await ctrl[fn](makeReq({ role: 'admin', ...over }), res);
      expect(res._status).toBe(403);
    }
    expect(lobService.createCatalogApp).not.toHaveBeenCalled();
    expect(lobService.updateCatalogApp).not.toHaveBeenCalled();
    expect(lobService.deleteCatalogApp).not.toHaveBeenCalled();
    expect(lobService.bulkImportCatalog).not.toHaveBeenCalled();
  });
});
