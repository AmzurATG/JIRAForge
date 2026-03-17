'use strict';

// ---------------------------------------------------------------------------
// Module mocks — jest.mock() calls are hoisted before all imports/requires.
// ---------------------------------------------------------------------------

const mockIsJiraAdmin = jest.fn();
const mockCheckUserPermissions = jest.fn();
const mockGetProjectsUserAdmins = jest.fn();

jest.mock('../../src/utils/jira.js', () => ({
  isJiraAdmin: mockIsJiraAdmin,
  checkUserPermissions: mockCheckUserPermissions,
  getProjectsUserAdmins: mockGetProjectsUserAdmins,
}));

const mockGetSupabaseConfig = jest.fn();
const mockGetOrCreateUser = jest.fn();
const mockGetOrCreateOrganization = jest.fn();
const mockGetUserOrganizationMembership = jest.fn();
const mockSupabaseRequest = jest.fn();

jest.mock('../../src/utils/supabase.js', () => ({
  getSupabaseConfig: mockGetSupabaseConfig,
  getOrCreateUser: mockGetOrCreateUser,
  getOrCreateOrganization: mockGetOrCreateOrganization,
  getUserOrganizationMembership: mockGetUserOrganizationMembership,
  supabaseRequest: mockSupabaseRequest,
}));

const mockFetchDashboardData = jest.fn();

jest.mock('../../src/utils/remote.js', () => ({
  fetchDashboardData: mockFetchDashboardData,
}));

jest.mock('../../src/config/constants.js', () => ({
  MAX_DAILY_SUMMARY_DAYS: 60,
  MAX_WEEKLY_SUMMARY_WEEKS: 12,
  MAX_ISSUES_IN_ANALYTICS: 50,
}));

// ---------------------------------------------------------------------------
// Import the module under test
// ---------------------------------------------------------------------------
const { fetchTimeAnalyticsBatch, fetchTimeAnalytics } = require('../../src/services/analytics/userAnalyticsService.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function resetMocks() {
  jest.clearAllMocks();
  mockCheckUserPermissions.mockResolvedValue({
    permissions: { ADMINISTER_PROJECTS: { havePermission: false } }
  });
  mockIsJiraAdmin.mockResolvedValue(false);
  mockGetProjectsUserAdmins.mockResolvedValue([]);
}

// ---------------------------------------------------------------------------
// Tests: fetchTimeAnalyticsBatch — canViewAllUsers enforcement
// ---------------------------------------------------------------------------
describe('fetchTimeAnalyticsBatch — user visibility permissions', () => {
  beforeEach(resetMocks);

  it('sets canViewAllUsers=false for a normal user (not admin, not project admin)', async () => {
    const serverResponse = {
      canViewAllUsers: true, // server might return true (e.g. membership override)
      dailySummary: [{ total_seconds: 100 }],
      allUsers: [{ id: 'u1' }, { id: 'u2' }],
    };
    mockFetchDashboardData.mockResolvedValue(serverResponse);

    const result = await fetchTimeAnalyticsBatch('account-1', 'cloud-1');

    // Must override server's canViewAllUsers with Forge-computed value
    expect(result.canViewAllUsers).toBe(false);

    // Verify fetchDashboardData was called with canViewAllUsers=false
    expect(mockFetchDashboardData).toHaveBeenCalledWith(
      expect.objectContaining({ canViewAllUsers: false })
    );
  });

  it('sets canViewAllUsers=true for a Jira admin', async () => {
    mockIsJiraAdmin.mockResolvedValue(true);

    const serverResponse = {
      canViewAllUsers: true,
      dailySummary: [],
      allUsers: [],
    };
    mockFetchDashboardData.mockResolvedValue(serverResponse);

    const result = await fetchTimeAnalyticsBatch('account-1', 'cloud-1');

    expect(result.canViewAllUsers).toBe(true);
    expect(mockFetchDashboardData).toHaveBeenCalledWith(
      expect.objectContaining({ canViewAllUsers: true, isJiraAdmin: true })
    );
  });

  it('sets canViewAllUsers=true for a project admin with valid project keys', async () => {
    mockCheckUserPermissions.mockResolvedValue({
      permissions: { ADMINISTER_PROJECTS: { havePermission: true } }
    });
    mockGetProjectsUserAdmins.mockResolvedValue(['PROJ-A', 'PROJ-B']);

    const serverResponse = {
      canViewAllUsers: true,
      dailySummary: [],
      allUsers: [],
    };
    mockFetchDashboardData.mockResolvedValue(serverResponse);

    const result = await fetchTimeAnalyticsBatch('account-1', 'cloud-1');

    expect(result.canViewAllUsers).toBe(true);
    expect(mockFetchDashboardData).toHaveBeenCalledWith(
      expect.objectContaining({
        canViewAllUsers: true,
        projectKeys: ['PROJ-A', 'PROJ-B'],
      })
    );
  });

  it('returns empty data for project admin with no discoverable projects', async () => {
    mockCheckUserPermissions.mockResolvedValue({
      permissions: { ADMINISTER_PROJECTS: { havePermission: true } }
    });
    mockGetProjectsUserAdmins.mockResolvedValue([]);

    const result = await fetchTimeAnalyticsBatch('account-1', 'cloud-1');

    expect(result.canViewAllUsers).toBe(false);
    expect(result.dailySummary).toEqual([]);
    expect(result.allUsers).toEqual([]);
    // Should NOT call the dashboard API at all
    expect(mockFetchDashboardData).not.toHaveBeenCalled();
  });

  it('overrides server canViewAllUsers even when membership has can_view_team_analytics=true', async () => {
    // Normal user, not admin — but the AI server might honor membership flag
    const serverResponse = {
      canViewAllUsers: true, // AI server widened access via membership flag
      membership: { can_view_team_analytics: true },
      dailySummary: [{ user_id: 'other-user', total_seconds: 500 }],
      allUsers: [{ id: 'current' }, { id: 'other-user' }],
    };
    mockFetchDashboardData.mockResolvedValue(serverResponse);

    const result = await fetchTimeAnalyticsBatch('account-1', 'cloud-1');

    // Forge MUST override to false — only Jira perms matter
    expect(result.canViewAllUsers).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Tests: fetchTimeAnalytics (legacy) — canViewAllUsers enforcement
// ---------------------------------------------------------------------------
describe('fetchTimeAnalytics (legacy) — user visibility permissions', () => {
  beforeEach(() => {
    resetMocks();
    mockGetSupabaseConfig.mockResolvedValue({ url: 'https://test.supabase.co', key: 'test-key' });
    mockGetOrCreateOrganization.mockResolvedValue({ id: 'org-1', org_name: 'Test Org' });
    mockGetOrCreateUser.mockResolvedValue('user-1');
    mockSupabaseRequest.mockResolvedValue([]);
  });

  it('normal user with can_view_team_analytics=true still gets canViewAllUsers=false', async () => {
    mockGetUserOrganizationMembership.mockResolvedValue({
      can_view_team_analytics: true, // DB flag is true
      role: 'member',
    });

    const result = await fetchTimeAnalytics('account-1', 'cloud-1');

    // canViewAllUsers must NOT be widened by the membership flag
    expect(result.canViewAllUsers).toBe(false);
    // Should only query for the user's own data (user_id filter present)
    const dailyQueryCall = mockSupabaseRequest.mock.calls.find(
      call => call[1] && call[1].includes('daily_time_summary')
    );
    expect(dailyQueryCall[1]).toContain('user_id=eq.user-1');
  });

  it('Jira admin sees all users regardless of membership flag', async () => {
    mockIsJiraAdmin.mockResolvedValue(true);
    mockGetUserOrganizationMembership.mockResolvedValue({
      can_view_team_analytics: false,
      role: 'member',
    });

    const result = await fetchTimeAnalytics('account-1', 'cloud-1');

    expect(result.canViewAllUsers).toBe(true);
    // Daily summary query should NOT have user_id filter
    const dailyQueryCall = mockSupabaseRequest.mock.calls.find(
      call => call[1] && call[1].includes('daily_time_summary')
    );
    expect(dailyQueryCall[1]).not.toContain('user_id=eq.');
  });

  it('project admin sees all users', async () => {
    mockCheckUserPermissions.mockResolvedValue({
      permissions: { ADMINISTER_PROJECTS: { havePermission: true } }
    });
    mockGetUserOrganizationMembership.mockResolvedValue({
      can_view_team_analytics: false,
      role: 'member',
    });

    const result = await fetchTimeAnalytics('account-1', 'cloud-1');

    expect(result.canViewAllUsers).toBe(true);
  });
});
