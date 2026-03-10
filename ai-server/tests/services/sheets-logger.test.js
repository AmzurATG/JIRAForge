'use strict';

jest.mock('googleapis', () => ({
  google: {
    auth: {
      GoogleAuth: jest.fn()
    },
    sheets: jest.fn()
  }
}));

jest.mock('node:os', () => ({
  networkInterfaces: jest.fn(),
  hostname: jest.fn().mockReturnValue('test-host')
}));

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { google } = require('googleapis');
const os = require('node:os');
const logger = require('../../src/utils/logger');
const {
  SheetsLogger,
  initializeSheetsLogger,
  getSheetsLogger,
  logLLMRequest,
  calculateCost,
  getIpAddress,
} = require('../../src/services/sheets-logger');

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function makeSheetsClient(overrides = {}) {
  return {
    spreadsheets: {
      values: {
        append: jest.fn().mockResolvedValue({}),
        get: jest.fn().mockResolvedValue({ data: { values: [] } }),
        update: jest.fn().mockResolvedValue({}),
      },
      get: jest.fn().mockResolvedValue({}),
      ...overrides.spreadsheets,
    },
  };
}

function validCreds() {
  return JSON.stringify({ client_email: 'svc@test.iam.gsa', private_key: '-----BEGIN' });
}

beforeEach(() => {
  jest.clearAllMocks();
  // Reset env vars
  delete process.env.SHEETS_LOGGING_ENABLED;
  delete process.env.GOOGLE_SHEET_ID;
  delete process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  delete process.env.GOOGLE_SHEET_NAME;

  // Default googleapis mock
  const client = makeSheetsClient();
  google.auth.GoogleAuth.mockImplementation(() => ({}));
  google.sheets.mockReturnValue(client);
});

// ---------------------------------------------------------------------------
// getIpAddress
// ---------------------------------------------------------------------------

describe('getIpAddress', () => {
  it('returns the first non-internal IPv4 address', () => {
    os.networkInterfaces.mockReturnValue({
      eth0: [
        { address: '127.0.0.1', family: 'IPv4', internal: true },
        { address: '192.168.1.100', family: 'IPv4', internal: false },
      ]
    });
    expect(getIpAddress()).toBe('192.168.1.100');
  });

  it('skips IPv6 addresses', () => {
    os.networkInterfaces.mockReturnValue({
      eth0: [
        { address: '::1', family: 'IPv6', internal: false },
        { address: '10.0.0.1', family: 'IPv4', internal: false },
      ]
    });
    expect(getIpAddress()).toBe('10.0.0.1');
  });

  it('returns hostname when no non-internal IPv4 found', () => {
    os.networkInterfaces.mockReturnValue({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true }]
    });
    expect(getIpAddress()).toBe('test-host');
  });

  it('returns Unknown when os.networkInterfaces throws', () => {
    os.networkInterfaces.mockImplementation(() => { throw new Error('no iface'); });
    expect(getIpAddress()).toBe('Unknown');
    expect(logger.error).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// calculateCost
// ---------------------------------------------------------------------------

describe('calculateCost', () => {
  it('calculates cost for a known fireworks model', () => {
    // qwen2p5-vl-32b: $0.40/$0.40 per 1M tokens
    const cost = calculateCost('fireworks', 'qwen2p5-vl-32b', 1000000, 500000);
    expect(cost).toBeCloseTo(0.6, 5);
  });

  it('calculates cost for a known portkey model', () => {
    // gemini-2.0-flash: $0.10 input / $0.40 output per 1M tokens
    const cost = calculateCost('portkey', 'gemini-2.0-flash', 2000000, 1000000);
    expect(cost).toBeCloseTo(0.6, 5);
  });

  it('uses default pricing for unknown provider', () => {
    const cost = calculateCost('unknown-provider', 'some-model', 1000000, 0);
    // falls through to fireworks default: $0.50 input
    expect(cost).toBeCloseTo(0.5, 5);
  });

  it('uses default pricing for unknown model within known provider', () => {
    // portkey default: $0.10 input / $0.40 output
    const cost = calculateCost('portkey', 'unknown-model-xyz', 1000000, 0);
    expect(cost).toBeCloseTo(0.1, 5);
  });

  it('returns 0 when tokens are 0', () => {
    expect(calculateCost('fireworks', 'qwen2p5-vl-32b', 0, 0)).toBe(0);
  });

  it('matches portkey gpt-4o model key', () => {
    // gpt-4o: $5.00 input / $15.00 output per 1M tokens
    const cost = calculateCost('portkey', 'gpt-4o', 1000000, 1000000);
    expect(cost).toBeCloseTo(20, 4);
  });
});

// ---------------------------------------------------------------------------
// SheetsLogger class
// ---------------------------------------------------------------------------

describe('SheetsLogger', () => {
  describe('constructor', () => {
    it('sets defaults from config', () => {
      const sl = new SheetsLogger({ sheetId: 'sheet-1', credentials: validCreds() });
      expect(sl.sheetId).toBe('sheet-1');
      expect(sl.sheetName).toBe('LLM_Calls_Log');
      expect(sl.enabled).toBe(true);
      expect(sl.projectName).toBe('Jira AI Server');
    });

    it('respects enabled: false', () => {
      const sl = new SheetsLogger({ sheetId: 'x', credentials: 'c', enabled: false });
      expect(sl.enabled).toBe(false);
    });
  });

  describe('_getSheets', () => {
    it('returns cached client on second call', async () => {
      const sl = new SheetsLogger({ sheetId: 'sheet-1', credentials: validCreds() });
      const first = await sl._getSheets();
      const second = await sl._getSheets();
      expect(first).toBe(second);
      expect(google.auth.GoogleAuth).toHaveBeenCalledTimes(1);
    });

    it('parses JSON string credentials', async () => {
      const sl = new SheetsLogger({ sheetId: 'sheet-1', credentials: validCreds() });
      await sl._getSheets();
      expect(google.auth.GoogleAuth).toHaveBeenCalledWith(
        expect.objectContaining({ credentials: expect.objectContaining({ client_email: 'svc@test.iam.gsa' }) })
      );
    });

    it('accepts credential object directly', async () => {
      const creds = { client_email: 'svc@test.iam.gsa', private_key: '---' };
      const sl = new SheetsLogger({ sheetId: 'sheet-1', credentials: creds });
      await sl._getSheets();
      expect(google.auth.GoogleAuth).toHaveBeenCalledWith(
        expect.objectContaining({ credentials: expect.objectContaining({ client_email: 'svc@test.iam.gsa' }) })
      );
    });

    it('throws and logs when GoogleAuth throws', async () => {
      google.auth.GoogleAuth.mockImplementation(() => { throw new Error('auth fail'); });
      const sl = new SheetsLogger({ sheetId: 'sheet-1', credentials: validCreds() });
      await expect(sl._getSheets()).rejects.toThrow('auth fail');
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('[SheetsLogger]'), 'auth fail'
      );
    });
  });

  describe('logRequest', () => {
    it('returns false when disabled', async () => {
      const sl = new SheetsLogger({ sheetId: 'sheet-1', credentials: validCreds(), enabled: false });
      const result = await sl.logRequest({ apiCallName: 'test', provider: 'portkey', model: 'gemini' });
      expect(result).toBe(false);
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('disabled'));
    });

    it('returns false when sheetId is missing', async () => {
      const sl = new SheetsLogger({ sheetId: null, credentials: validCreds() });
      const result = await sl.logRequest({ apiCallName: 'test', provider: 'portkey', model: 'gemini' });
      expect(result).toBe(false);
      expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining('No sheet ID'));
    });

    it('appends a row and returns true on success', async () => {
      const sheets = makeSheetsClient();
      google.sheets.mockReturnValue(sheets);
      const sl = new SheetsLogger({ sheetId: 'sheet-1', credentials: validCreds() });
      const result = await sl.logRequest({
        apiCallName: 'vision',
        provider: 'fireworks',
        model: 'qwen2p5-vl-32b',
        inputTokens: 1000,
        outputTokens: 500,
      });
      expect(result).toBe(true);
      expect(sheets.spreadsheets.values.append).toHaveBeenCalledWith(
        expect.objectContaining({
          spreadsheetId: 'sheet-1',
          range: 'LLM_Calls_Log!A:K',
        })
      );
    });

    it('uses pre-calculated cost when provided', async () => {
      const sheets = makeSheetsClient();
      google.sheets.mockReturnValue(sheets);
      const sl = new SheetsLogger({ sheetId: 'sheet-1', credentials: validCreds() });
      await sl.logRequest({ apiCallName: 'test', provider: 'portkey', model: 'gemini', cost: 0.01234 });
      const appendCall = sheets.spreadsheets.values.append.mock.calls[0][0];
      expect(appendCall.resource.values[0][10]).toBe(0.01234);
    });

    it('uses override employeeName and projectName when provided', async () => {
      const sheets = makeSheetsClient();
      google.sheets.mockReturnValue(sheets);
      const sl = new SheetsLogger({ sheetId: 'sheet-1', credentials: validCreds() });
      await sl.logRequest({
        apiCallName: 'test', provider: 'portkey', model: 'gemini',
        employeeName: 'Alice', projectName: 'ProjectX'
      });
      const row = sheets.spreadsheets.values.append.mock.calls[0][0].resource.values[0];
      expect(row[1]).toBe('Alice');
      expect(row[3]).toBe('ProjectX');
    });

    it('returns false and logs warning on append failure', async () => {
      const sheets = makeSheetsClient();
      sheets.spreadsheets.values.append.mockRejectedValue(new Error('quota exceeded'));
      google.sheets.mockReturnValue(sheets);
      const sl = new SheetsLogger({ sheetId: 'sheet-1', credentials: validCreds() });
      const result = await sl.logRequest({ apiCallName: 'test', provider: 'portkey', model: 'gemini' });
      expect(result).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('[SheetsLogger] Failed to log request:'), 'quota exceeded'
      );
    });
  });

  describe('testConnection', () => {
    it('returns false when disabled', async () => {
      const sl = new SheetsLogger({ sheetId: 'sheet-1', credentials: validCreds(), enabled: false });
      expect(await sl.testConnection()).toBe(false);
    });

    it('returns false when sheetId is missing', async () => {
      const sl = new SheetsLogger({ sheetId: null, credentials: validCreds() });
      expect(await sl.testConnection()).toBe(false);
    });

    it('returns true when spreadsheet is reachable', async () => {
      const sheets = makeSheetsClient();
      google.sheets.mockReturnValue(sheets);
      const sl = new SheetsLogger({ sheetId: 'sheet-1', credentials: validCreds() });
      const result = await sl.testConnection();
      expect(result).toBe(true);
      expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Connection test successful'));
    });

    it('returns false and logs error on network failure', async () => {
      const sheets = makeSheetsClient();
      sheets.spreadsheets.get.mockRejectedValue(new Error('network error'));
      google.sheets.mockReturnValue(sheets);
      const sl = new SheetsLogger({ sheetId: 'sheet-1', credentials: validCreds() });
      const result = await sl.testConnection();
      expect(result).toBe(false);
      expect(logger.error).toHaveBeenCalledWith(
        expect.stringContaining('Connection test failed:'), 'network error'
      );
    });
  });

  describe('ensureHeaders', () => {
    it('returns false when disabled', async () => {
      const sl = new SheetsLogger({ sheetId: 'sheet-1', credentials: validCreds(), enabled: false });
      expect(await sl.ensureHeaders()).toBe(false);
    });

    it('returns false when sheetId is missing', async () => {
      const sl = new SheetsLogger({ sheetId: null, credentials: validCreds() });
      expect(await sl.ensureHeaders()).toBe(false);
    });

    it('creates headers when first row is empty', async () => {
      const sheets = makeSheetsClient();
      sheets.spreadsheets.values.get.mockResolvedValue({ data: { values: [] } });
      google.sheets.mockReturnValue(sheets);
      const sl = new SheetsLogger({ sheetId: 'sheet-1', credentials: validCreds() });
      const result = await sl.ensureHeaders();
      expect(result).toBe(true);
      expect(sheets.spreadsheets.values.update).toHaveBeenCalledWith(
        expect.objectContaining({ range: 'LLM_Calls_Log!A1:K1' })
      );
      expect(logger.info).toHaveBeenCalledWith('[SheetsLogger] Headers created');
    });

    it('skips header creation when TimeStamp header already exists', async () => {
      const sheets = makeSheetsClient();
      sheets.spreadsheets.values.get.mockResolvedValue({
        data: { values: [['TimeStamp', 'Employee Name']] }
      });
      google.sheets.mockReturnValue(sheets);
      const sl = new SheetsLogger({ sheetId: 'sheet-1', credentials: validCreds() });
      const result = await sl.ensureHeaders();
      expect(result).toBe(true);
      expect(sheets.spreadsheets.values.update).not.toHaveBeenCalled();
    });

    it('returns false and logs warning on API error', async () => {
      const sheets = makeSheetsClient();
      sheets.spreadsheets.values.get.mockRejectedValue(new Error('api error'));
      google.sheets.mockReturnValue(sheets);
      const sl = new SheetsLogger({ sheetId: 'sheet-1', credentials: validCreds() });
      const result = await sl.ensureHeaders();
      expect(result).toBe(false);
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('[SheetsLogger] Failed to ensure headers:'), 'api error'
      );
    });
  });
});

// ---------------------------------------------------------------------------
// initializeSheetsLogger
// ---------------------------------------------------------------------------

describe('initializeSheetsLogger', () => {
  it('returns null when SHEETS_LOGGING_ENABLED is not true', () => {
    const result = initializeSheetsLogger();
    expect(result).toBeNull();
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('Disabled (SHEETS_LOGGING_ENABLED'));
  });

  it('returns null when GOOGLE_SHEET_ID is missing', () => {
    process.env.SHEETS_LOGGING_ENABLED = 'true';
    const result = initializeSheetsLogger();
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('GOOGLE_SHEET_ID'));
  });

  it('returns null when GOOGLE_SERVICE_ACCOUNT_JSON is missing', () => {
    process.env.SHEETS_LOGGING_ENABLED = 'true';
    process.env.GOOGLE_SHEET_ID = 'sheet-123';
    const result = initializeSheetsLogger();
    expect(result).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('GOOGLE_SERVICE_ACCOUNT_JSON'));
  });

  it('returns a SheetsLogger instance when fully configured', () => {
    process.env.SHEETS_LOGGING_ENABLED = 'true';
    process.env.GOOGLE_SHEET_ID = 'sheet-123';
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = validCreds();
    const sheets = makeSheetsClient();
    sheets.spreadsheets.get.mockResolvedValue({});
    sheets.spreadsheets.values.get.mockResolvedValue({ data: { values: [] } });
    sheets.spreadsheets.values.update.mockResolvedValue({});
    google.sheets.mockReturnValue(sheets);

    const result = initializeSheetsLogger();
    expect(result).toBeInstanceOf(SheetsLogger);
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('[SheetsLogger] Initialized'), expect.any(String), expect.any(String)
    );
  });
});

// ---------------------------------------------------------------------------
// getSheetsLogger
// ---------------------------------------------------------------------------

describe('getSheetsLogger', () => {
  it('returns null when not initialized', () => {
    // Calling initializeSheetsLogger with no env vars resets to null
    initializeSheetsLogger();
    expect(getSheetsLogger()).toBeNull();
  });

  it('returns the logger instance after initialization', () => {
    process.env.SHEETS_LOGGING_ENABLED = 'true';
    process.env.GOOGLE_SHEET_ID = 'sheet-123';
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = validCreds();
    const sheets = makeSheetsClient();
    sheets.spreadsheets.get.mockResolvedValue({});
    google.sheets.mockReturnValue(sheets);

    const initialized = initializeSheetsLogger();
    expect(getSheetsLogger()).toBe(initialized);
  });
});

// ---------------------------------------------------------------------------
// logLLMRequest (module-level convenience function)
// ---------------------------------------------------------------------------

describe('logLLMRequest', () => {
  it('returns false when no logger is initialized', async () => {
    initializeSheetsLogger(); // no env vars → sets singleton to null
    const result = await logLLMRequest({ apiCallName: 'test', provider: 'p', model: 'm' });
    expect(result).toBe(false);
  });

  it('delegates to SheetsLogger.logRequest when initialized', async () => {
    process.env.SHEETS_LOGGING_ENABLED = 'true';
    process.env.GOOGLE_SHEET_ID = 'sheet-123';
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON = validCreds();
    const sheets = makeSheetsClient();
    sheets.spreadsheets.get.mockResolvedValue({});
    google.sheets.mockReturnValue(sheets);

    initializeSheetsLogger();
    const result = await logLLMRequest({ apiCallName: 'vision', provider: 'fireworks', model: 'qwen', inputTokens: 100, outputTokens: 50 });
    expect(result).toBe(true);
    expect(sheets.spreadsheets.values.append).toHaveBeenCalled();
  });
});
