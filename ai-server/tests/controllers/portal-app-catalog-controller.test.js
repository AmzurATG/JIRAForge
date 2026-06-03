'use strict';

jest.mock('../../src/services/portal-lob-service');
jest.mock('../../src/services/portal-app-suggest-service', () => ({ isEnabled: jest.fn(), suggestApp: jest.fn() }));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const lobService = require('../../src/services/portal-lob-service');
const appSuggest = require('../../src/services/portal-app-suggest-service');
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

describe('aiSuggest (AI-assisted Add Application)', () => {
  test('flag off → available:false, suggestions:null, service not called', async () => {
    appSuggest.isEnabled.mockReturnValue(false);
    const res = makeRes();
    await ctrl.aiSuggest(makeReq({ role: 'admin', body: { name: 'Notion' } }), res);
    expect(res._body).toEqual({ success: true, available: false, suggestions: null });
    expect(appSuggest.suggestApp).not.toHaveBeenCalled();
  });

  test('flag on → calls service and returns suggestions (any portal user)', async () => {
    appSuggest.isEnabled.mockReturnValue(true);
    appSuggest.suggestApp.mockResolvedValue({
      displayName: 'Notion', kinds: ['url'], processNames: [], domains: ['notion.so'],
      suggestedClassification: 'productive', confidence: 0.7, rationale: 'x',
    });
    const res = makeRes();
    await ctrl.aiSuggest(makeReq({ role: 'admin', body: { name: 'Notion' } }), res);
    expect(appSuggest.suggestApp).toHaveBeenCalledWith('Notion');
    expect(res._body.available).toBe(true);
    expect(res._body.suggestions.displayName).toBe('Notion');
  });

  test('flag on + missing name → 400, service not called', async () => {
    appSuggest.isEnabled.mockReturnValue(true);
    const res = makeRes();
    await ctrl.aiSuggest(makeReq({ role: 'admin', body: {} }), res);
    expect(res._status).toBe(400);
    expect(appSuggest.suggestApp).not.toHaveBeenCalled();
  });

  test('service failure degrades to suggestions:null (never errors the modal)', async () => {
    appSuggest.isEnabled.mockReturnValue(true);
    appSuggest.suggestApp.mockRejectedValue(new Error('boom'));
    const res = makeRes();
    await ctrl.aiSuggest(makeReq({ role: 'admin', body: { name: 'Notion' } }), res);
    expect(res._body).toEqual({ success: true, available: true, suggestions: null });
  });
});
