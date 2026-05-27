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

// ---------------------------------------------------------------------------
// Export resolver tests — covers authorizeExport (multi-project authorization)
// and unionMembersForUnassignedSection (multi-project Unassigned dedup).
// ---------------------------------------------------------------------------

const analyticsService = require('../../src/services/analyticsService.js');
const jiraUtils = require('../../src/utils/jira.js');

/** Build a Jira `mypermissions` response. perms is e.g. { ADMINISTER: true }. */
function permResponse(perms) {
  return {
    permissions: Object.fromEntries(
      Object.entries(perms).map(([k, v]) => [k, { havePermission: v }])
    )
  };
}

/** Build a fake fetchProjectTeamAnalytics return value. */
function teamAnalyticsFixture(members) {
  return {
    teamMemberActivity: members,
    teamSummary: { issuesWorked: 0 },
    teamTimeByIssue: []
  };
}

/** Find the mock call whose final options arg matches the given mode. */
function callWithMode(mockFn, mode) {
  return mockFn.mock.calls.find(args => {
    const opts = args[args.length - 1];
    return opts && typeof opts === 'object' && opts.mode === mode;
  });
}

describe('exportTeamAnalytics (CSV) resolver', () => {
  describe('authorizeExport', () => {
    test('empty projectKeys rejected before any work', async () => {
      const result = await mockResolver.invoke('exportTeamAnalytics', makeReq({
        projectKeys: [],
        startDate: '2026-05-01',
        endDate: '2026-05-27',
      }));
      expect(result.success).toBe(false);
      expect(result.error).toMatch(/at least one project/i);
      expect(jiraUtils.checkUserPermissions).not.toHaveBeenCalled();
      expect(analyticsService.generateTeamExportData).not.toHaveBeenCalled();
    });

    test('global Jira admin short-circuits per-project permission checks', async () => {
      jiraUtils.checkUserPermissions.mockResolvedValueOnce(permResponse({ ADMINISTER: true }));
      analyticsService.fetchProjectTeamAnalytics.mockResolvedValue(teamAnalyticsFixture([]));
      analyticsService.generateTeamExportData.mockResolvedValue('csv-block');

      const result = await mockResolver.invoke('exportTeamAnalytics', makeReq({
        projectKeys: ['A', 'B'],
        startDate: '2026-05-01',
        endDate: '2026-05-27',
      }));

      expect(result.success).toBe(true);
      // Only one permission check fired — global admin short-circuited the per-project loop.
      expect(jiraUtils.checkUserPermissions).toHaveBeenCalledTimes(1);
      expect(jiraUtils.checkUserPermissions).toHaveBeenCalledWith(['ADMINISTER'], 'A');
    });

    test('non-admin denied when project admin missing on ANY selected project', async () => {
      jiraUtils.checkUserPermissions
        .mockResolvedValueOnce(permResponse({ ADMINISTER: false }))           // global check
        .mockResolvedValueOnce(permResponse({ ADMINISTER_PROJECTS: true }))   // A
        .mockResolvedValueOnce(permResponse({ ADMINISTER_PROJECTS: false })); // B - denied

      const result = await mockResolver.invoke('exportTeamAnalytics', makeReq({
        projectKeys: ['A', 'B'],
        startDate: '2026-05-01',
        endDate: '2026-05-27',
      }));

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/every selected project/i);
      // No export work was done.
      expect(analyticsService.generateTeamExportData).not.toHaveBeenCalled();
    });

    test('project admin allowed when granted on every selected project', async () => {
      jiraUtils.checkUserPermissions
        .mockResolvedValueOnce(permResponse({ ADMINISTER: false }))
        .mockResolvedValueOnce(permResponse({ ADMINISTER_PROJECTS: true }))
        .mockResolvedValueOnce(permResponse({ ADMINISTER_PROJECTS: true }));
      analyticsService.fetchProjectTeamAnalytics.mockResolvedValue(teamAnalyticsFixture([]));
      analyticsService.generateTeamExportData.mockResolvedValue('csv-block');

      const result = await mockResolver.invoke('exportTeamAnalytics', makeReq({
        projectKeys: ['A', 'B'],
        startDate: '2026-05-01',
        endDate: '2026-05-27',
      }));

      expect(result.success).toBe(true);
      // 1 global + 2 per-project = 3 permission checks
      expect(jiraUtils.checkUserPermissions).toHaveBeenCalledTimes(3);
    });
  });

  describe('multi-project orchestration', () => {
    beforeEach(() => {
      // Default: global admin (auth passes) so each test can focus on orchestration.
      jiraUtils.checkUserPermissions.mockResolvedValue(permResponse({ ADMINISTER: true }));
    });

    test('single project uses legacy path (no mode/options)', async () => {
      analyticsService.generateTeamExportData.mockResolvedValue('csv-A');

      const result = await mockResolver.invoke('exportTeamAnalytics', makeReq({
        projectKeys: ['A'],
        startDate: '2026-05-01',
        endDate: '2026-05-27',
      }));

      expect(result.success).toBe(true);
      expect(result.data).toBe('csv-A');
      expect(result.filename).toBe('team-analytics-A-2026-05-27.csv');
      // Single-project path passes 6 args (no options) so default mode applies.
      expect(analyticsService.generateTeamExportData).toHaveBeenCalledTimes(1);
      expect(analyticsService.generateTeamExportData).toHaveBeenCalledWith(
        ACCOUNT_ID, CLOUD_ID, 'A', '2026-05-01', '2026-05-27', null
      );
    });

    test('multi-project runs each project with mode=projectOnly', async () => {
      analyticsService.fetchProjectTeamAnalytics.mockResolvedValue(teamAnalyticsFixture([]));
      analyticsService.generateTeamExportData.mockResolvedValue('csv-block');

      const result = await mockResolver.invoke('exportTeamAnalytics', makeReq({
        projectKeys: ['A', 'B'],
        startDate: '2026-05-01',
        endDate: '2026-05-27',
      }));

      expect(result.success).toBe(true);
      expect(result.filename).toBe('team-analytics-2-projects-2026-05-27.csv');
      // Two per-project calls, both with projectOnly. No unassigned call since no member has unassigned hours.
      expect(analyticsService.generateTeamExportData).toHaveBeenCalledTimes(2);
      expect(callWithMode(analyticsService.generateTeamExportData, 'projectOnly')).toBeDefined();
      expect(callWithMode(analyticsService.generateTeamExportData, 'unassignedOnly')).toBeUndefined();
    });

    test('appends synthetic Unassigned section when any active member has unassigned hours', async () => {
      // Same user appears in both projects' rosters — must be deduped in the union.
      const alice = { userId: 'u1', displayName: 'Alice', monthUnassignedSeconds: 3600 };
      analyticsService.fetchProjectTeamAnalytics
        .mockResolvedValueOnce(teamAnalyticsFixture([alice]))
        .mockResolvedValueOnce(teamAnalyticsFixture([alice]));
      analyticsService.generateTeamExportData.mockResolvedValue('csv-block');

      const result = await mockResolver.invoke('exportTeamAnalytics', makeReq({
        projectKeys: ['A', 'B'],
        startDate: '2026-05-01',
        endDate: '2026-05-27',
      }));

      expect(result.success).toBe(true);
      // 2 per-project + 1 synthetic = 3 generator calls.
      expect(analyticsService.generateTeamExportData).toHaveBeenCalledTimes(3);

      const unassignedCall = callWithMode(analyticsService.generateTeamExportData, 'unassignedOnly');
      expect(unassignedCall).toBeDefined();
      const opts = unassignedCall[unassignedCall.length - 1];
      expect(opts.displayProjectKey).toBe('Unassigned (All Projects)');
      // Deduped to a single entry even though Alice appeared in both project rosters.
      expect(opts.presetMembers).toHaveLength(1);
      expect(opts.presetMembers[0].userId).toBe('u1');
      // Member's monthSeconds is reframed to her unassigned total so activeMembers
      // filter inside the generator sees her as having work to report.
      expect(opts.presetMembers[0].monthSeconds).toBe(3600);
    });

    test('skips Unassigned section when no member has unassigned hours', async () => {
      analyticsService.fetchProjectTeamAnalytics.mockResolvedValue(teamAnalyticsFixture([
        { userId: 'u1', displayName: 'Alice', monthUnassignedSeconds: 0 }
      ]));
      analyticsService.generateTeamExportData.mockResolvedValue('csv-block');

      const result = await mockResolver.invoke('exportTeamAnalytics', makeReq({
        projectKeys: ['A', 'B'],
        startDate: '2026-05-01',
        endDate: '2026-05-27',
      }));

      expect(result.success).toBe(true);
      expect(analyticsService.generateTeamExportData).toHaveBeenCalledTimes(2);
      expect(callWithMode(analyticsService.generateTeamExportData, 'unassignedOnly')).toBeUndefined();
    });

    test('filterUserIds restricts the Unassigned union', async () => {
      const alice = { userId: 'u1', displayName: 'Alice', monthUnassignedSeconds: 3600 };
      const bob = { userId: 'u2', displayName: 'Bob', monthUnassignedSeconds: 3600 };
      analyticsService.fetchProjectTeamAnalytics.mockResolvedValue(teamAnalyticsFixture([alice, bob]));
      analyticsService.generateTeamExportData.mockResolvedValue('csv-block');

      const result = await mockResolver.invoke('exportTeamAnalytics', makeReq({
        projectKeys: ['A', 'B'],
        startDate: '2026-05-01',
        endDate: '2026-05-27',
        filterUserIds: ['u1'],
      }));

      expect(result.success).toBe(true);
      const unassignedCall = callWithMode(analyticsService.generateTeamExportData, 'unassignedOnly');
      expect(unassignedCall).toBeDefined();
      const opts = unassignedCall[unassignedCall.length - 1];
      // Bob was excluded by filterUserIds; only Alice in the synthetic block.
      expect(opts.presetMembers).toHaveLength(1);
      expect(opts.presetMembers[0].userId).toBe('u1');
    });
  });
});

describe('exportTeamAnalyticsExcel resolver', () => {
  beforeEach(() => {
    jiraUtils.checkUserPermissions.mockResolvedValue(permResponse({ ADMINISTER: true }));
  });

  test('multi-project assembles { projects: [..., Unassigned] } when applicable', async () => {
    analyticsService.fetchProjectTeamAnalytics.mockResolvedValue(teamAnalyticsFixture([
      { userId: 'u1', displayName: 'Alice', monthUnassignedSeconds: 3600 }
    ]));
    analyticsService.generateTeamExportDataStructured.mockImplementation((aid, cid, pk, sd, ed, fu, opts) =>
      Promise.resolve({
        projectKey: opts?.displayProjectKey || pk,
        memberDetails: [],
        summary: {},
        memberSummary: []
      })
    );

    const result = await mockResolver.invoke('exportTeamAnalyticsExcel', makeReq({
      projectKeys: ['A', 'B'],
      startDate: '2026-05-01',
      endDate: '2026-05-27',
    }));

    expect(result.success).toBe(true);
    expect(result.data.isMultiProject).toBe(true);
    expect(result.data.projects).toHaveLength(3);
    expect(result.data.projects.map(p => p.projectKey))
      .toEqual(['A', 'B', 'Unassigned (All Projects)']);
  });

  test('multi-project returns only project blocks when no unassigned hours', async () => {
    analyticsService.fetchProjectTeamAnalytics.mockResolvedValue(teamAnalyticsFixture([
      { userId: 'u1', displayName: 'Alice', monthUnassignedSeconds: 0 }
    ]));
    analyticsService.generateTeamExportDataStructured.mockImplementation((aid, cid, pk) =>
      Promise.resolve({ projectKey: pk, memberDetails: [], summary: {}, memberSummary: [] })
    );

    const result = await mockResolver.invoke('exportTeamAnalyticsExcel', makeReq({
      projectKeys: ['A', 'B'],
      startDate: '2026-05-01',
      endDate: '2026-05-27',
    }));

    expect(result.success).toBe(true);
    expect(result.data.projects).toHaveLength(2);
    expect(result.data.projects.map(p => p.projectKey)).toEqual(['A', 'B']);
  });

  test('empty projectKeys denied (same authorization path as CSV)', async () => {
    const result = await mockResolver.invoke('exportTeamAnalyticsExcel', makeReq({
      projectKeys: [],
      startDate: '2026-05-01',
      endDate: '2026-05-27',
    }));
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/at least one project/i);
  });
});
