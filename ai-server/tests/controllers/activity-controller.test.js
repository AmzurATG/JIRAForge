'use strict';

jest.mock('../../src/services/activity-service', () => ({
  analyzeBatch: jest.fn(),
  classifyUnknownApp: jest.fn(),
  identifyAppByName: jest.fn(),
}));

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const activityService = require('../../src/services/activity-service');
const { analyzeBatch, classifyApp, identifyApp } = require('../../src/controllers/activity-controller');

function makeRes() {
  const res = {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
  return res;
}

// ---------------------------------------------------------------------------
// analyzeBatch
// ---------------------------------------------------------------------------

describe('analyzeBatch', () => {
  let res;

  beforeEach(() => {
    res = makeRes();
    jest.clearAllMocks();
  });

  it('returns 400 when records is missing', async () => {
    const req = { body: { user_id: 'user-1' } };
    await analyzeBatch(req, res);
    expect(res._status).toBe(400);
    expect(res._body.success).toBe(false);
    expect(res._body.error).toContain('records array is required');
  });

  it('returns 400 when records is not an array', async () => {
    const req = { body: { records: 'not-an-array', user_id: 'user-1' } };
    await analyzeBatch(req, res);
    expect(res._status).toBe(400);
    expect(res._body.success).toBe(false);
  });

  it('returns 400 when records is an empty array', async () => {
    const req = { body: { records: [], user_id: 'user-1' } };
    await analyzeBatch(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toContain('records array is required');
  });

  it('returns 400 when user_id is missing', async () => {
    const req = { body: { records: [{ id: 'r1' }] } };
    await analyzeBatch(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toContain('user_id is required');
  });

  it('returns success with service result on valid input', async () => {
    activityService.analyzeBatch.mockResolvedValue({ processed: 2, matched: 1 });
    const req = {
      body: {
        records: [{ id: 'r1' }, { id: 'r2' }],
        user_id: 'user-1',
        organization_id: 'org-1',
        user_assigned_issues: [{ key: 'PROJ-1' }],
      },
    };
    await analyzeBatch(req, res);
    expect(res._status).toBe(200);
    expect(res._body.success).toBe(true);
    expect(res._body.processed).toBe(2);
    expect(activityService.analyzeBatch).toHaveBeenCalledWith(
      [{ id: 'r1' }, { id: 'r2' }],
      [{ key: 'PROJ-1' }],
      'user-1',
      'org-1'
    );
  });

  it('defaults user_assigned_issues to [] when not provided', async () => {
    activityService.analyzeBatch.mockResolvedValue({ processed: 1 });
    const req = { body: { records: [{ id: 'r1' }], user_id: 'user-1' } };
    await analyzeBatch(req, res);
    expect(activityService.analyzeBatch).toHaveBeenCalledWith(
      [{ id: 'r1' }],
      [],
      'user-1',
      undefined
    );
  });

  it('calls next(error) when service throws', async () => {
    const serviceError = new Error('AI service down');
    activityService.analyzeBatch.mockRejectedValue(serviceError);
    const req = { body: { records: [{ id: 'r1' }], user_id: 'user-1' } };
    const next = jest.fn();
    await analyzeBatch(req, res, next);
    expect(next).toHaveBeenCalledWith(serviceError);
  });
});

// ---------------------------------------------------------------------------
// classifyApp
// ---------------------------------------------------------------------------

describe('classifyApp', () => {
  let res;

  beforeEach(() => {
    res = makeRes();
    jest.clearAllMocks();
  });

  it('returns 400 when application_name is missing', async () => {
    const req = { body: {} };
    await classifyApp(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toContain('application_name is required');
  });

  it('returns success with classification result', async () => {
    activityService.classifyUnknownApp.mockResolvedValue({
      category: 'development',
      confidence: 0.9,
      reasoning: 'It is an IDE'
    });
    const req = {
      body: {
        application_name: 'VS Code',
        window_title: 'index.js',
        ocr_text: 'function hello()',
        user_id: 'user-1',
        organization_id: 'org-1',
      },
    };
    await classifyApp(req, res);
    expect(res._status).toBe(200);
    expect(res._body.success).toBe(true);
    expect(res._body.category).toBe('development');
    expect(activityService.classifyUnknownApp).toHaveBeenCalledWith(
      'VS Code', 'index.js', 'function hello()', 'user-1', 'org-1'
    );
  });

  it('defaults window_title, ocr_text to empty string and user/org to null when absent', async () => {
    activityService.classifyUnknownApp.mockResolvedValue({ category: 'unknown' });
    const req = { body: { application_name: 'SomeApp' } };
    await classifyApp(req, res);
    expect(activityService.classifyUnknownApp).toHaveBeenCalledWith(
      'SomeApp', '', '', null, null
    );
  });

  it('calls next(error) when service throws', async () => {
    activityService.classifyUnknownApp.mockRejectedValue(new Error('LLM error'));
    const req = { body: { application_name: 'SomeApp' } };
    const next = jest.fn();
    await classifyApp(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});

// ---------------------------------------------------------------------------
// identifyApp
// ---------------------------------------------------------------------------

describe('identifyApp', () => {
  let res;

  beforeEach(() => {
    res = makeRes();
    jest.clearAllMocks();
  });

  it('returns 400 when search_term is missing', async () => {
    const req = { body: {} };
    await identifyApp(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toContain('search_term is required');
  });

  it('returns 400 when search_term is a single character', async () => {
    const req = { body: { search_term: 'X' } };
    await identifyApp(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toContain('at least 2 characters');
  });

  it('returns 400 when search_term is whitespace only', async () => {
    const req = { body: { search_term: ' ' } };
    await identifyApp(req, res);
    expect(res._status).toBe(400);
  });

  it('returns success with identified app data', async () => {
    activityService.identifyAppByName.mockResolvedValue({
      name: 'Visual Studio Code',
      publisher: 'Microsoft',
      category: 'development'
    });
    const req = { body: { search_term: '  VS Code  ' } };
    await identifyApp(req, res);
    expect(res._status).toBe(200);
    expect(res._body.success).toBe(true);
    expect(res._body.data.name).toBe('Visual Studio Code');
    // Trims search term before passing to service
    expect(activityService.identifyAppByName).toHaveBeenCalledWith('VS Code');
  });

  it('calls next(error) when service throws', async () => {
    activityService.identifyAppByName.mockRejectedValue(new Error('Model timeout'));
    const req = { body: { search_term: 'Chrome' } };
    const next = jest.fn();
    await identifyApp(req, res, next);
    expect(next).toHaveBeenCalledWith(expect.any(Error));
  });
});
