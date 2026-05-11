'use strict';

/**
 * Analytics Resolver Tests
 * Tests for getWorklogSummary resolver (unified aggregation service)
 */

// ---------------------------------------------------------------------------
// Module mocks — set up BEFORE requiring the resolvers under test.
// ---------------------------------------------------------------------------

const mockGetDailyWorkTotal = jest.fn();
const mockGetWeeklyWorkTotal = jest.fn();
const mockGetOrCreateOrganization = jest.fn();
const mockGetOrCreateUser = jest.fn();

jest.mock('../../src/utils/remote.js', () => ({
  getDailyWorkTotal: mockGetDailyWorkTotal,
  getWeeklyWorkTotal: mockGetWeeklyWorkTotal,
  getOrCreateOrganization: mockGetOrCreateOrganization,
  getOrCreateUser: mockGetOrCreateUser,
}));

// Mock other dependencies (not used by getWorklogSummary but required by module)
jest.mock('../../src/services/analyticsService.js', () => ({
  fetchTimeAnalytics: jest.fn(),
  fetchTimeAnalyticsBatch: jest.fn(),
  fetchAllAnalytics: jest.fn(),
  fetchProjectAnalytics: jest.fn(),
  fetchProjectTeamAnalytics: jest.fn(),
  fetchTeamDayTimeline: jest.fn(),
  fetchMyDayTimeline: jest.fn(),
  fetchMyDayIssueBreakdown: jest.fn(),
  convertIdleToWorklog: jest.fn(),
  fetchMemberDayDetails: jest.fn(),
  fetchMemberWeekDetails: jest.fn(),
  fetchMemberMonthDetails: jest.fn(),
  generateTeamExportData: jest.fn(),
  generateTeamExportDataStructured: jest.fn(),
}));

jest.mock('../../src/utils/jira.js', () => ({
  isJiraAdmin: jest.fn(),
  checkUserPermissions: jest.fn(),
  createJiraIssue: jest.fn(),
  getIssueTransitions: jest.fn(),
  transitionIssue: jest.fn(),
  createJiraWorklog: jest.fn(),
  textToADF: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Import resolvers after mocks
// ---------------------------------------------------------------------------
const { registerAnalyticsResolvers } = require('../../src/resolvers/analyticsResolvers.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const USER_ID = 'user-uuid-1';
const ORG_ID = 'org-uuid-1';
const ACCOUNT_ID = 'account-1';
const CLOUD_ID = 'cloud-1';

function makeReq(payload = {}) {
  return {
    payload,
    context: { accountId: ACCOUNT_ID, cloudId: CLOUD_ID },
  };
}

// Mock resolver object
const mockResolver = {
  _resolvers: new Map(),
  define(name, handler) {
    this._resolvers.set(name, handler);
  },
  invoke(name, req) {
    const handler = this._resolvers.get(name);
    if (!handler) throw new Error(`Resolver '${name}' not found`);
    return handler(req);
  }
};

beforeEach(() => {
  jest.clearAllMocks();
  mockResolver._resolvers.clear();
  
  // Register resolvers
  registerAnalyticsResolvers(mockResolver);
  
  // Default mocks
  mockGetOrCreateOrganization.mockResolvedValue({ id: ORG_ID });
  mockGetOrCreateUser.mockResolvedValue(USER_ID);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getWorklogSummary resolver', () => {
  test('returns daily total when period is not specified', async () => {
    mockGetDailyWorkTotal.mockResolvedValue({
      date: '2026-05-07',
      total_seconds: 7200,
      hours: '2.00',
      timezone: 'UTC'
    });

    const req = makeReq({
      date: '2026-05-07',
      timezone: 'UTC'
    });

    const result = await mockResolver.invoke('getWorklogSummary', req);

    expect(result.success).toBe(true);
    expect(result.data.total_seconds).toBe(7200);
    expect(result.data.hours).toBe('2.00');
    expect(mockGetDailyWorkTotal).toHaveBeenCalledWith(
      ORG_ID,
      USER_ID,
      '2026-05-07',
      'UTC'
    );
  });

  test('returns daily total when period is "daily"', async () => {
    mockGetDailyWorkTotal.mockResolvedValue({
      date: '2026-05-07',
      total_seconds: 3600,
      hours: '1.00',
      timezone: 'America/New_York'
    });

    const req = makeReq({
      date: '2026-05-07',
      timezone: 'America/New_York',
      period: 'daily'
    });

    const result = await mockResolver.invoke('getWorklogSummary', req);

    expect(result.success).toBe(true);
    expect(result.data.total_seconds).toBe(3600);
    expect(mockGetDailyWorkTotal).toHaveBeenCalledWith(
      ORG_ID,
      USER_ID,
      '2026-05-07',
      'America/New_York'
    );
  });

  test('returns weekly total when period is "weekly"', async () => {
    mockGetWeeklyWorkTotal.mockResolvedValue({
      week_start: '2026-05-05',
      total_seconds: 144000,
      hours: '40.00',
      timezone: 'UTC'
    });

    const req = makeReq({
      date: '2026-05-05',
      timezone: 'UTC',
      period: 'weekly'
    });

    const result = await mockResolver.invoke('getWorklogSummary', req);

    expect(result.success).toBe(true);
    expect(result.data.total_seconds).toBe(144000);
    expect(result.data.hours).toBe('40.00');
    expect(mockGetWeeklyWorkTotal).toHaveBeenCalledWith(
      ORG_ID,
      USER_ID,
      '2026-05-05',
      'UTC'
    );
  });

  test('defaults timezone to UTC when not provided', async () => {
    mockGetDailyWorkTotal.mockResolvedValue({
      date: '2026-05-07',
      total_seconds: 5400,
      hours: '1.50',
      timezone: 'UTC'
    });

    const req = makeReq({
      date: '2026-05-07'
      // timezone not provided
    });

    const result = await mockResolver.invoke('getWorklogSummary', req);

    expect(result.success).toBe(true);
    expect(mockGetDailyWorkTotal).toHaveBeenCalledWith(
      ORG_ID,
      USER_ID,
      '2026-05-07',
      'UTC'
    );
  });

  test('returns error when organization cannot be retrieved', async () => {
    mockGetOrCreateOrganization.mockResolvedValue(null);

    const req = makeReq({
      date: '2026-05-07'
    });

    const result = await mockResolver.invoke('getWorklogSummary', req);

    expect(result.success).toBe(false);
    expect(result.error).toContain('organization');
  });

  test('returns error when user cannot be retrieved', async () => {
    mockGetOrCreateUser.mockResolvedValue(null);

    const req = makeReq({
      date: '2026-05-07'
    });

    const result = await mockResolver.invoke('getWorklogSummary', req);

    expect(result.success).toBe(false);
    expect(result.error).toContain('user');
  });

  test('returns error when aggregation service throws', async () => {
    mockGetDailyWorkTotal.mockRejectedValue(new Error('Database connection failed'));

    const req = makeReq({
      date: '2026-05-07'
    });

    const result = await mockResolver.invoke('getWorklogSummary', req);

    expect(result.success).toBe(false);
    expect(result.error).toContain('Database connection failed');
  });
});
