'use strict';

/**
 * Portal reports controller — CSV column additions (AC-B3, AC-C5) and the
 * viewer role check. New columns are appended, never reordered.
 * Plan: plan/2026-06-10_web-productivity-portal_ux-improvements.md
 */

jest.mock('../../src/services/portal-service');
jest.mock('../../src/services/portal-lob-service');
jest.mock('../../src/services/portal-employee-profile-service');
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const ExcelJS = require('exceljs');
const portalService = require('../../src/services/portal-service');
const profileService = require('../../src/services/portal-employee-profile-service');
const ctrl = require('../../src/controllers/portal-reports-controller');

function makeRes() {
  const res = { _status: 200, _body: null, _headers: {}, _sent: null };
  res.status = jest.fn(function (c) { this._status = c; return this; });
  res.json = jest.fn(function (b) { this._body = b; return this; });
  res.setHeader = jest.fn(function (k, v) { this._headers[k] = v; return this; });
  res.send = jest.fn(function (b) { this._sent = b; return this; });
  return res;
}
function makeReq({ role = 'superadmin', query = {} } = {}) {
  return { portalUser: { userId: 'admin1', role, orgId: 'o', email: 'e' }, query };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.PORTAL_LOB_ENFORCEMENT; // scoping off → no LOB resolution
  // Default: no location filter → scope passes through unchanged.
  profileService.applyLocationScope.mockImplementation(async (ids) => ids);
});

describe('exportCSV — appended columns', () => {
  test('daily-summary CSV appends Neutral/Idle after the original columns (AC-C5)', async () => {
    portalService.getDashboardData.mockResolvedValue({
      summary: {},
      dailyTrend: [{ date: '2026-06-01', productiveHours: 1, nonProductiveHours: 0.5, neutralHours: 0.25, idleHours: 0.1 }],
    });

    const res = makeRes();
    await ctrl.exportCSV(makeReq({ query: { type: 'daily-summary', from: '2026-06-01', to: '2026-06-02' } }), res);

    const [header, row] = res._sent.split('\n');
    expect(header).toBe('Date,Productive Hours,Non-Productive Hours,Total Hours,Productivity %,Neutral Hours,Idle Hours');
    expect(row).toBe('"2026-06-01",1.00,0.50,1.50,66.7,0.25,0.10');
  });

  test('employee-summary CSV appends Location, Neutral, Idle (AC-B3, AC-C5)', async () => {
    portalService.getEmployees.mockResolvedValue({
      data: [{
        userId: 'u1', name: 'Jane', email: 'j@x.com',
        productiveHours: 2, nonProductiveHours: 1, productivityPercentage: 66.7,
        neutralHours: 0.5, idleHours: 0.2,
        location: { id: 'loc1', name: 'Hyderabad' },
      }],
      pagination: { page: 1, limit: 1000, totalCount: 1 },
    });

    const res = makeRes();
    await ctrl.exportCSV(makeReq({ query: { type: 'employee-summary', from: '2026-06-01', to: '2026-06-02' } }), res);

    const [header, row] = res._sent.split('\n');
    expect(header).toBe('Employee Name,Email,Productive Hours,Non-Productive Hours,Total Hours,Productivity %,Location,Neutral Hours,Idle Hours');
    expect(row).toContain('"Hyderabad"');
    expect(row).toContain('0.50,0.20');
  });
});

describe('location filter narrows report scope', () => {
  test('?locationId is resolved to a user set and passed into the report data fetch', async () => {
    profileService.applyLocationScope.mockResolvedValue(['u1', 'u2']);
    portalService.getDashboardData.mockResolvedValue({ summary: {}, dailyTrend: [] });

    const res = makeRes();
    await ctrl.getReportData(makeReq({ query: { type: 'daily-summary', from: '2026-06-01', to: '2026-06-02', locationId: 'loc1' } }), res);

    expect(res._status).toBe(200);
    expect(profileService.applyLocationScope).toHaveBeenCalledWith(null, 'loc1');
    expect(portalService.getDashboardData).toHaveBeenCalledWith('o', '2026-06-01', '2026-06-02', ['u1', 'u2']);
  });
});

describe('exportExcel — real .xlsx workbook', () => {
  test('daily-summary: xlsx headers + numeric cells, correct content type', async () => {
    portalService.getDashboardData.mockResolvedValue({
      summary: {},
      dailyTrend: [{ date: '2026-06-01', productiveHours: 1, nonProductiveHours: 0.5, neutralHours: 0.25, idleHours: 0.1 }],
    });

    const res = makeRes();
    await ctrl.exportExcel(makeReq({ query: { type: 'daily-summary', from: '2026-06-01', to: '2026-06-02' } }), res);

    expect(res._headers['Content-Type']).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(res._headers['Content-Disposition']).toMatch(/daily-summary-.*\.xlsx/);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res._sent);
    const sheet = workbook.getWorksheet('Daily Summary');
    expect(sheet).toBeTruthy();
    // Header row mirrors the CSV columns (appended, never reordered).
    expect(sheet.getRow(1).values.slice(1)).toEqual([
      'Date', 'Productive Hours', 'Non-Productive Hours', 'Total Hours', 'Productivity %', 'Neutral Hours', 'Idle Hours',
    ]);
    // Data cells are real numbers (summable in Excel), not strings.
    expect(sheet.getCell('A2').value).toBe('2026-06-01');
    expect(sheet.getCell('B2').value).toBe(1);
    expect(sheet.getCell('D2').value).toBe(1.5);
    expect(sheet.getCell('F2').value).toBe(0.25);
    expect(sheet.getCell('G2').value).toBeCloseTo(0.1);
  });

  test('employee-summary: includes Location, Neutral, Idle columns', async () => {
    portalService.getEmployees.mockResolvedValue({
      data: [{
        userId: 'u1', name: 'Jane', email: 'j@x.com',
        productiveHours: 2, nonProductiveHours: 1, productivityPercentage: 66.7,
        neutralHours: 0.5, idleHours: 0.2,
        location: { id: 'loc1', name: 'Hyderabad' },
      }],
      pagination: { page: 1, limit: 1000, totalCount: 1 },
    });

    const res = makeRes();
    await ctrl.exportExcel(makeReq({ query: { type: 'employee-summary', from: '2026-06-01', to: '2026-06-02' } }), res);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(res._sent);
    const sheet = workbook.getWorksheet('Employee Summary');
    expect(sheet.getRow(1).values.slice(1)).toEqual([
      'Employee Name', 'Email', 'Productive Hours', 'Non-Productive Hours', 'Total Hours', 'Productivity %', 'Location', 'Neutral Hours', 'Idle Hours',
    ]);
    expect(sheet.getCell('A2').value).toBe('Jane');
    expect(sheet.getCell('G2').value).toBe('Hyderabad');
    expect(sheet.getCell('H2').value).toBe(0.5);
  });

  test('unsupported type → 400', async () => {
    const res = makeRes();
    await ctrl.exportExcel(makeReq({ query: { type: 'nope' } }), res);
    expect(res._status).toBe(400);
  });
});

describe('role enforcement', () => {
  test('viewer cannot preview or export reports (403)', async () => {
    for (const fn of ['getReportData', 'exportCSV', 'exportExcel']) {
      const res = makeRes();
      await ctrl[fn](makeReq({ role: 'viewer', query: { type: 'daily-summary' } }), res);
      expect(res._status).toBe(403);
    }
    expect(portalService.getDashboardData).not.toHaveBeenCalled();
  });
});
