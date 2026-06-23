'use strict';

/**
 * Portal reports controller — per-category hours+% columns, legal/tracked/
 * attainment on the employee summary, "Neutral" surfaced as "Unknown", and the
 * viewer role check.
 * Plans:
 *   plan/2026-06-10_web-productivity-portal_ux-improvements.md (location filter)
 *   plan/2026-06-23_web-productivity-portal_holidays-legal-hours-and-category-percentages.md
 */

jest.mock('../../src/services/portal-service');
jest.mock('../../src/services/portal-lob-service');
jest.mock('../../src/services/portal-employee-profile-service');
jest.mock('../../src/services/portal-holiday-service');
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const ExcelJS = require('exceljs');
const portalService = require('../../src/services/portal-service');
const profileService = require('../../src/services/portal-employee-profile-service');
const holidayService = require('../../src/services/portal-holiday-service');
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
  // Legal hours fixed for the employee-summary report (2 working days × 9 = 18).
  holidayService.legalHours.mockResolvedValue(18);
});

describe('exportCSV — per-category hours + percentages', () => {
  test('daily-summary: each category shows Hours and %, no Productivity % column, Unknown label', async () => {
    portalService.getDashboardData.mockResolvedValue({
      summary: {},
      dailyTrend: [{ date: '2026-06-01', productiveHours: 1, nonProductiveHours: 0.5, neutralHours: 0.25, idleHours: 0.1 }],
    });

    const res = makeRes();
    await ctrl.exportCSV(makeReq({ query: { type: 'daily-summary', from: '2026-06-01', to: '2026-06-02' } }), res);

    const [header, row] = res._sent.split('\n');
    expect(header).toBe('Date,Productive Hours,Productive %,Non-Productive Hours,Non-Productive %,Unknown Hours,Unknown %,Idle Hours,Idle %,Total Hours');
    // total = 1 + 0.5 + 0.25 + 0.1 = 1.85; %s = each ÷ 1.85, summing to 100.
    expect(row).toBe('"2026-06-01",1.00,54.1,0.50,27.0,0.25,13.5,0.10,5.4,1.85');
  });

  test('employee-summary: per-category Hrs/% + Tracked/Attainment; legal hours shown once on top; no Branch', async () => {
    portalService.getEmployees.mockResolvedValue({
      data: [{
        userId: 'u1', name: 'Jane', email: 'j@x.com',
        productiveHours: 2, nonProductiveHours: 1,
        neutralHours: 0.5, idleHours: 0.2,
        location: { id: 'loc1', name: 'Hyderabad' },
      }],
      pagination: { page: 1, limit: 1000, totalCount: 1 },
    });

    const res = makeRes();
    await ctrl.exportCSV(makeReq({ query: { type: 'employee-summary', from: '2026-06-01', to: '2026-06-02' } }), res);

    const lines = res._sent.split('\n');
    expect(lines[0]).toBe('Legal Hours (period),18.00'); // once, not per row
    expect(lines[1]).toBe('');
    expect(lines[2]).toBe('Employee Name,Email,Productive Hours,Productive %,Non-Productive Hours,Non-Productive %,Unknown Hours,Unknown %,Idle Hours,Idle %,Tracked Hours,Attainment %');
    // total = 3.7; tracked = 2 + 1 + 0.5 = 3.5; attainment = 3.5 / 18 = 19.4%.
    expect(lines[3]).toBe('"Jane","j@x.com",2.00,54.1,1.00,27.0,0.50,13.5,0.20,5.4,3.50,19.4');
    expect(holidayService.legalHours).toHaveBeenCalledWith('2026-06-01', '2026-06-02');
  });

  test('employee-summary degrades to Legal=0 when the holiday lookup fails (migration not applied)', async () => {
    portalService.getEmployees.mockResolvedValue({
      data: [{
        userId: 'u1', name: 'Jane', email: 'j@x.com',
        productiveHours: 2, nonProductiveHours: 1, neutralHours: 0.5, idleHours: 0.2, location: null,
      }],
      pagination: { page: 1, limit: 1000, totalCount: 1 },
    });
    holidayService.legalHours.mockRejectedValue(new Error('relation "portal_holidays" does not exist'));

    const res = makeRes();
    await ctrl.exportCSV(makeReq({ query: { type: 'employee-summary', from: '2026-06-01', to: '2026-06-02' } }), res);

    expect(res._status).toBe(200); // report still renders
    const lines = res._sent.split('\n');
    expect(lines[0]).toBe('Legal Hours (period),0.00'); // degraded to 0, still shown once
    expect(lines[3]).toBe('"Jane","j@x.com",2.00,54.1,1.00,27.0,0.50,13.5,0.20,5.4,3.50,0.0'); // Tracked 3.50, Attainment 0.0
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
  test('daily-summary: xlsx headers + numeric Hrs/% cells, correct content type', async () => {
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
    expect(sheet.getRow(1).values.slice(1)).toEqual([
      'Date', 'Productive Hours', 'Productive %', 'Non-Productive Hours', 'Non-Productive %',
      'Unknown Hours', 'Unknown %', 'Idle Hours', 'Idle %', 'Total Hours',
    ]);
    // Real numbers (summable in Excel), not strings.
    expect(sheet.getCell('A2').value).toBe('2026-06-01');
    expect(sheet.getCell('B2').value).toBe(1);       // Productive Hours
    expect(sheet.getCell('C2').value).toBeCloseTo(54.1); // Productive %
    expect(sheet.getCell('F2').value).toBe(0.25);    // Unknown Hours
    expect(sheet.getCell('J2').value).toBe(1.85);    // Total Hours
  });

  test('employee-summary: legal hours as a title row, then Hrs/% + Tracked/Attainment (no Branch)', async () => {
    portalService.getEmployees.mockResolvedValue({
      data: [{
        userId: 'u1', name: 'Jane', email: 'j@x.com',
        productiveHours: 2, nonProductiveHours: 1,
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
    expect(sheet.getCell('A1').value).toBe('Legal Hours (period): 18.00'); // shown once on top
    expect(sheet.getRow(2).values.slice(1)).toEqual([
      'Employee Name', 'Email', 'Productive Hours', 'Productive %', 'Non-Productive Hours', 'Non-Productive %',
      'Unknown Hours', 'Unknown %', 'Idle Hours', 'Idle %', 'Tracked Hours', 'Attainment %',
    ]);
    expect(sheet.getCell('A3').value).toBe('Jane');
    expect(sheet.getCell('G3').value).toBe(0.5);  // Unknown Hours
    expect(sheet.getCell('K3').value).toBe(3.5);  // Tracked Hours
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
