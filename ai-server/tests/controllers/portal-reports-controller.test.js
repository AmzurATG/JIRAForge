'use strict';

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../src/services/portal-service', () => ({
  getEmployees: jest.fn(),
  getEmployeesList: jest.fn(),
  getTimeLogs: jest.fn(),
}));

jest.mock('../../src/services/db/supabase-client', () => ({
  getClient: jest.fn(),
}));

jest.mock('xlsx', () => ({
  utils: {
    book_new: jest.fn(() => ({ sheets: [] })),
    aoa_to_sheet: jest.fn((rows) => ({ rows })),
    book_append_sheet: jest.fn(),
  },
  write: jest.fn(() => Buffer.from('xlsx-content')),
}));

const portalService = require('../../src/services/portal-service');
const XLSX = require('xlsx');
const { exportXLSX } = require('../../src/controllers/portal-reports-controller');

function makeRes() {
  return {
    _status: 200,
    _headers: {},
    _body: null,
    status: jest.fn(function status(code) {
      this._status = code;
      return this;
    }),
    json: jest.fn(function json(body) {
      this._body = body;
      return this;
    }),
    setHeader: jest.fn(function setHeader(key, value) {
      this._headers[key] = value;
    }),
    send: jest.fn(function send(body) {
      this._body = body;
      return this;
    }),
  };
}

describe('portal-reports-controller exportXLSX', () => {
  let req;
  let res;

  beforeEach(() => {
    jest.clearAllMocks();
    req = {
      portalUser: {
        orgId: 'org-123',
        role: 'admin',
      },
      query: {
        type: 'employee-summary',
      },
    };
    res = makeRes();

    portalService.getEmployees.mockResolvedValue({
      data: [
        {
          userId: 'user-1',
          name: 'Alice Doe',
          email: 'alice@example.com',
          productiveHours: 6.25,
          nonProductiveHours: 1.75,
          productivityPercentage: 78.1,
        },
      ],
    });
  });

  it('returns 403 for viewer role', async () => {
    req.portalUser.role = 'viewer';

    await exportXLSX(req, res);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'Insufficient permissions to export reports',
      })
    );
  });

  it('returns 400 when report type is missing', async () => {
    delete req.query.type;

    await exportXLSX(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
        error: 'Report type is required',
      })
    );
  });

  it('returns 400 when report type is unsupported', async () => {
    req.query.type = 'unknown-type';

    await exportXLSX(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        success: false,
      })
    );
    expect(XLSX.write).not.toHaveBeenCalled();
  });

  it('returns xlsx payload with correct content headers', async () => {
    await exportXLSX(req, res);

    expect(XLSX.utils.book_new).toHaveBeenCalledTimes(1);
    expect(XLSX.utils.aoa_to_sheet).toHaveBeenCalledTimes(1);
    expect(XLSX.utils.book_append_sheet).toHaveBeenCalledTimes(1);
    expect(XLSX.write).toHaveBeenCalledWith(expect.any(Object), {
      type: 'buffer',
      bookType: 'xlsx',
    });

    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    expect(res.setHeader).toHaveBeenCalledWith(
      'Content-Disposition',
      expect.stringMatching(/attachment; filename="employee-summary-\d{4}-\d{2}-\d{2}\.xlsx"/)
    );
    expect(res.send).toHaveBeenCalledWith(Buffer.from('xlsx-content'));
  });
});
