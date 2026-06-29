'use strict';

/**
 * Portal controller — getEmployeeLogs `includeIdle` passthrough.
 * The day-timeline view opts in (idle shown as its own blocks); the table view
 * omits it (idle excluded, today's default). Scoping off by default here.
 * Spec: plan/2026-06-26_web-productivity-portal_employee-day-timeline.md
 */

jest.mock('../../src/services/portal-service');
jest.mock('../../src/services/portal-lob-service');
jest.mock('../../src/services/portal-employee-profile-service');
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const portalService = require('../../src/services/portal-service');
const profileService = require('../../src/services/portal-employee-profile-service');
const ctrl = require('../../src/controllers/portal-controller');

function makeRes() {
  const res = { _status: 200, _body: null };
  res.status = jest.fn(function (c) { this._status = c; return this; });
  res.json = jest.fn(function (b) { this._body = b; return this; });
  return res;
}
function makeReq({ params = {}, query = {} } = {}) {
  return { portalUser: { orgId: 'o', userId: 'admin1', role: 'superadmin' }, params, query };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.PORTAL_LOB_ENFORCEMENT; // scoping off → visibleUserIds = null
  profileService.applyLocationScope.mockResolvedValue(null);
  portalService.getTimeLogs.mockResolvedValue({ data: [], pagination: { page: 1, limit: 20, totalCount: 0 } });
});

describe('getEmployeeLogs — includeIdle passthrough', () => {
  test('includeIdle="true" → getTimeLogs receives includeIdle:true (timeline view)', async () => {
    const res = makeRes();
    await ctrl.getEmployeeLogs(
      makeReq({ params: { userId: 'u1' }, query: { from: '2026-06-26', to: '2026-06-26', includeIdle: 'true' } }),
      res
    );
    expect(res._status).toBe(200);
    expect(portalService.getTimeLogs).toHaveBeenCalledWith(
      'o',
      expect.objectContaining({ employee: 'u1', includeIdle: true }),
      expect.any(Object),
      null
    );
  });

  test('no includeIdle → includeIdle:false (table default, idle excluded)', async () => {
    const res = makeRes();
    await ctrl.getEmployeeLogs(
      makeReq({ params: { userId: 'u1' }, query: { from: '2026-06-26', to: '2026-06-26' } }),
      res
    );
    expect(portalService.getTimeLogs).toHaveBeenCalledWith(
      'o',
      expect.objectContaining({ includeIdle: false }),
      expect.any(Object),
      null
    );
  });

  test('non-true value is treated as false (no accidental opt-in)', async () => {
    const res = makeRes();
    await ctrl.getEmployeeLogs(
      makeReq({ params: { userId: 'u1' }, query: { includeIdle: 'false' } }),
      res
    );
    expect(portalService.getTimeLogs).toHaveBeenCalledWith(
      'o',
      expect.objectContaining({ includeIdle: false }),
      expect.any(Object),
      null
    );
  });
});
