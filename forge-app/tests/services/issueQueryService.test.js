'use strict';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockGetAllUserAssignedIssues = jest.fn();
const mockGetUserAssignedIssues = jest.fn();
const mockFormatIssuesData = jest.fn();
const mockGetNonSprintProjectKeys = jest.fn();

jest.mock('../../src/utils/jira.js', () => ({
  getAllUserAssignedIssues: mockGetAllUserAssignedIssues,
  getUserAssignedIssues: mockGetUserAssignedIssues,
  formatIssuesData: mockFormatIssuesData,
  getNonSprintProjectKeys: mockGetNonSprintProjectKeys,
}));

const mockGetSupabaseConfig = jest.fn();
const mockSupabaseRequest = jest.fn();
const mockGetOrCreateOrganization = jest.fn();
const mockGetOrCreateUser = jest.fn();

jest.mock('../../src/utils/supabase.js', () => ({
  getSupabaseConfig: mockGetSupabaseConfig,
  supabaseRequest: mockSupabaseRequest,
  getOrCreateOrganization: mockGetOrCreateOrganization,
  getOrCreateUser: mockGetOrCreateUser,
}));

jest.mock('../../src/config/constants.js', () => ({
  JQL_ACTIVE_STATUSES: 'statusCategory != Done',
}));

// ---------------------------------------------------------------------------
// Import the module under test
// ---------------------------------------------------------------------------
const { getActiveIssuesWithTime, buildMyFocusJql } = require('../../src/services/issue/issueQueryService.js');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const ACCOUNT_ID = 'atlassian-account-123';
const CLOUD_ID = 'cloud-id-1';
const FAKE_SUPABASE_CONFIG = { url: 'https://test.supabase.co', key: 'test-key' };
const ORG_ID = 'org-uuid-1';
const USER_ID = 'user-uuid-1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeJiraIssue(key, { status = 'In Progress', statusCategory = 'indeterminate', projectKey = 'TEST', issueType = 'Task' } = {}) {
  return {
    key,
    fields: {
      summary: `${key} summary`,
      status: { name: status, statusCategory: { key: statusCategory } },
      project: { key: projectKey },
      issuetype: { name: issueType, iconUrl: '' },
      priority: { name: 'Medium', iconUrl: '' },
      updated: '2026-04-16T10:00:00.000Z',
    },
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
beforeEach(() => {
  jest.clearAllMocks();
  // Default: user has no non-sprint projects unless a test overrides this.
  mockGetNonSprintProjectKeys.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('getActiveIssuesWithTime', () => {
  describe('JQL filter', () => {
    it('scopes the non-sprint clause to project keys when the user has JSM/business projects', async () => {
      mockGetNonSprintProjectKeys.mockResolvedValue(['JSM', 'HELP']);
      mockGetAllUserAssignedIssues.mockResolvedValue({ issues: [], total: 0 });
      mockGetSupabaseConfig.mockResolvedValue(null);

      await getActiveIssuesWithTime(ACCOUNT_ID, CLOUD_ID);

      expect(mockGetAllUserAssignedIssues).toHaveBeenCalledTimes(1);
      expect(mockGetAllUserAssignedIssues).toHaveBeenCalledWith({
        jqlFilter: '((sprint in openSprints()) OR (project in ("JSM","HELP") AND resolution = EMPTY AND statusCategory != Done))',
      });
    });

    it('collapses to (sprint in openSprints()) when the user has no non-sprint projects', async () => {
      mockGetNonSprintProjectKeys.mockResolvedValue([]);
      mockGetAllUserAssignedIssues.mockResolvedValue({ issues: [], total: 0 });
      mockGetSupabaseConfig.mockResolvedValue(null);

      await getActiveIssuesWithTime(ACCOUNT_ID, CLOUD_ID);

      const calledFilter = mockGetAllUserAssignedIssues.mock.calls[0][0].jqlFilter;
      expect(calledFilter).toBe('(sprint in openSprints())');
    });

    it('never emits the sprint is EMPTY clause (the source of the backlog leak)', async () => {
      mockGetNonSprintProjectKeys.mockResolvedValue(['JSM']);
      mockGetAllUserAssignedIssues.mockResolvedValue({ issues: [], total: 0 });
      mockGetSupabaseConfig.mockResolvedValue(null);

      await getActiveIssuesWithTime(ACCOUNT_ID, CLOUD_ID);

      const calledFilter = mockGetAllUserAssignedIssues.mock.calls[0][0].jqlFilter;
      expect(calledFilter).not.toContain('sprint is EMPTY');
    });

    it('always includes the open-sprint clause for software issues', async () => {
      mockGetNonSprintProjectKeys.mockResolvedValue(['JSM']);
      mockGetAllUserAssignedIssues.mockResolvedValue({ issues: [], total: 0 });
      mockGetSupabaseConfig.mockResolvedValue(null);

      await getActiveIssuesWithTime(ACCOUNT_ID, CLOUD_ID);

      const calledFilter = mockGetAllUserAssignedIssues.mock.calls[0][0].jqlFilter;
      expect(calledFilter).toContain('sprint in openSprints()');
    });

    it('scopes the non-sprint clause by resolution = EMPTY AND statusCategory != Done', async () => {
      mockGetNonSprintProjectKeys.mockResolvedValue(['JSM']);
      mockGetAllUserAssignedIssues.mockResolvedValue({ issues: [], total: 0 });
      mockGetSupabaseConfig.mockResolvedValue(null);

      await getActiveIssuesWithTime(ACCOUNT_ID, CLOUD_ID);

      const calledFilter = mockGetAllUserAssignedIssues.mock.calls[0][0].jqlFilter;
      expect(calledFilter).toContain('resolution = EMPTY');
      expect(calledFilter).toContain('statusCategory != Done');
    });

    it('degrades to sprint-only when the project lookup returns [] (failure path)', async () => {
      mockGetNonSprintProjectKeys.mockResolvedValue([]);
      mockGetAllUserAssignedIssues.mockResolvedValue({ issues: [], total: 0 });
      mockGetSupabaseConfig.mockResolvedValue(null);

      await getActiveIssuesWithTime(ACCOUNT_ID, CLOUD_ID);

      const calledFilter = mockGetAllUserAssignedIssues.mock.calls[0][0].jqlFilter;
      expect(calledFilter).toBe('(sprint in openSprints())');
    });
  });

  describe('buildMyFocusJql', () => {
    it('returns the sprint-only filter for empty / null / undefined input', () => {
      expect(buildMyFocusJql([])).toBe('(sprint in openSprints())');
      expect(buildMyFocusJql(null)).toBe('(sprint in openSprints())');
      expect(buildMyFocusJql(undefined)).toBe('(sprint in openSprints())');
    });

    it('builds the scoped, parenthesized filter for given project keys', () => {
      expect(buildMyFocusJql(['JSM', 'HELP'])).toBe(
        '((sprint in openSprints()) OR (project in ("JSM","HELP") AND resolution = EMPTY AND statusCategory != Done))'
      );
    });

    it('never emits sprint is EMPTY', () => {
      expect(buildMyFocusJql(['JSM'])).not.toContain('sprint is EMPTY');
    });

    it('caps the project list at 500 keys', () => {
      const keys = Array.from({ length: 600 }, (_, i) => `P${i}`);
      const jql = buildMyFocusJql(keys);
      const count = (jql.match(/"P\d+"/g) || []).length;
      expect(count).toBe(500);
    });
  });

  describe('without Supabase config', () => {
    it('should return formatted issues without time tracking when Supabase is not configured', async () => {
      const scrumIssue = makeJiraIssue('SCRUM-1', { status: 'In Progress', statusCategory: 'indeterminate', projectKey: 'SCRUM' });
      const jsmIssue = makeJiraIssue('JSM-10', { status: 'Waiting for support', statusCategory: 'indeterminate', projectKey: 'JSM', issueType: 'Service Request' });

      mockGetAllUserAssignedIssues.mockResolvedValue({ issues: [scrumIssue, jsmIssue], total: 2 });
      mockGetSupabaseConfig.mockResolvedValue(null);

      const result = await getActiveIssuesWithTime(ACCOUNT_ID, CLOUD_ID);

      expect(result.total).toBe(2);
      expect(result.issues).toHaveLength(2);
      expect(result.issues.map(i => i.key)).toEqual(expect.arrayContaining(['SCRUM-1', 'JSM-10']));
    });

    it('should set timeTracked to 0 for all issues when Supabase is not configured', async () => {
      const issue = makeJiraIssue('JSM-5', { projectKey: 'JSM', issueType: 'Incident' });
      mockGetAllUserAssignedIssues.mockResolvedValue({ issues: [issue], total: 1 });
      mockGetSupabaseConfig.mockResolvedValue(null);

      const result = await getActiveIssuesWithTime(ACCOUNT_ID, CLOUD_ID);

      expect(result.issues[0].timeTracked).toBe(0);
      expect(result.issues[0].lastWorkedOn).toBeNull();
    });
  });

  describe('with Supabase config and activity records', () => {
    beforeEach(() => {
      mockGetSupabaseConfig.mockResolvedValue(FAKE_SUPABASE_CONFIG);
      mockGetOrCreateOrganization.mockResolvedValue({ id: ORG_ID });
      mockGetOrCreateUser.mockResolvedValue(USER_ID);
    });

    it('should enrich JSM issues with time tracking data from activity records', async () => {
      const jsmIssue = makeJiraIssue('JSM-10', { status: 'Open', statusCategory: 'new', projectKey: 'JSM', issueType: 'Service Request' });
      mockGetAllUserAssignedIssues.mockResolvedValue({ issues: [jsmIssue], total: 1 });

      // First supabase call: check if user has activity records
      // Second call: paginated activity records
      mockSupabaseRequest.mockImplementation((config, query) => {
        // User existence check
        if (query.startsWith('activity_records?') && query.includes('select=id&limit=1')) {
          return Promise.resolve([{ id: 'rec-1' }]);
        }
        // Activity records fetch
        if (query.startsWith('activity_records?') && query.includes('classification=in.')) {
          return Promise.resolve([{
            id: 'rec-1',
            user_assigned_issue_key: 'JSM-10',
            total_time_seconds: 3600,
            duration_seconds: 3600,
            start_time: '2026-04-16T09:00:00.000Z',
            end_time: '2026-04-16T10:00:00.000Z',
            work_date: '2026-04-16',
            window_title: 'JSM-10 - Fix login issue',
            application_name: 'Chrome',
            classification: 'productive',
            project_key: 'JSM',
            created_at: '2026-04-16T10:00:00.000Z',
          }]);
        }
        return Promise.resolve([]);
      });

      const result = await getActiveIssuesWithTime(ACCOUNT_ID, CLOUD_ID);

      expect(result.issues).toHaveLength(1);
      expect(result.issues[0].key).toBe('JSM-10');
      expect(result.issues[0].timeTracked).toBe(3600);
      expect(result.issues[0].sessions).toHaveLength(1);
    });

    it('should handle mixed Scrum and JSM issues together', async () => {
      const scrumIssue = makeJiraIssue('SCRUM-1', { status: 'In Progress', statusCategory: 'indeterminate', projectKey: 'SCRUM' });
      const jsmIssue = makeJiraIssue('JSM-10', { status: 'Open', statusCategory: 'new', projectKey: 'JSM', issueType: 'Service Request' });
      const kanbanIssue = makeJiraIssue('KAN-5', { status: 'To Do', statusCategory: 'new', projectKey: 'KAN' });

      mockGetAllUserAssignedIssues.mockResolvedValue({
        issues: [scrumIssue, jsmIssue, kanbanIssue],
        total: 3,
      });

      mockSupabaseRequest.mockImplementation((config, query) => {
        if (query.includes('select=id&limit=1')) {
          return Promise.resolve([{ id: 'rec-1' }]);
        }
        if (query.includes('classification=in.')) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      const result = await getActiveIssuesWithTime(ACCOUNT_ID, CLOUD_ID);

      expect(result.total).toBe(3);
      const keys = result.issues.map(i => i.key);
      expect(keys).toContain('SCRUM-1');
      expect(keys).toContain('JSM-10');
      expect(keys).toContain('KAN-5');
    });
  });

  describe('issue enrichment', () => {
    it('should correctly map JSM issue types and status categories', async () => {
      const jsmIssue = makeJiraIssue('JSM-10', {
        status: 'Waiting for support',
        statusCategory: 'indeterminate',
        projectKey: 'JSM',
        issueType: 'Service Request',
      });

      mockGetAllUserAssignedIssues.mockResolvedValue({ issues: [jsmIssue], total: 1 });
      mockGetSupabaseConfig.mockResolvedValue(null);

      const result = await getActiveIssuesWithTime(ACCOUNT_ID, CLOUD_ID);

      expect(result.issues[0]).toEqual(expect.objectContaining({
        key: 'JSM-10',
        status: 'Waiting for support',
        statusCategory: 'indeterminate',
        projectKey: 'JSM',
        issueType: 'Service Request',
      }));
    });

    it('should sort issues with In Progress first, then others, then Done', async () => {
      const inProgressIssue = makeJiraIssue('JSM-1', { status: 'In Progress', statusCategory: 'indeterminate' });
      const todoIssue = makeJiraIssue('JSM-2', { status: 'Open', statusCategory: 'new' });
      const doneIssue = makeJiraIssue('JSM-3', { status: 'Done', statusCategory: 'done' });

      mockGetAllUserAssignedIssues.mockResolvedValue({
        issues: [doneIssue, todoIssue, inProgressIssue],
        total: 3,
      });
      // Sorting only applies when Supabase is configured (enriched path)
      mockGetSupabaseConfig.mockResolvedValue(FAKE_SUPABASE_CONFIG);
      mockGetOrCreateOrganization.mockResolvedValue({ id: ORG_ID });
      mockGetOrCreateUser.mockResolvedValue(USER_ID);
      mockSupabaseRequest.mockImplementation((config, query) => {
        if (query.includes('select=id&limit=1')) return Promise.resolve([{ id: 'rec-1' }]);
        return Promise.resolve([]);
      });

      const result = await getActiveIssuesWithTime(ACCOUNT_ID, CLOUD_ID);

      expect(result.issues[0].key).toBe('JSM-1'); // In Progress first
      expect(result.issues[2].key).toBe('JSM-3'); // Done last
    });
  });

  describe('edge cases', () => {
    it('should return empty issues when Jira returns no results', async () => {
      mockGetAllUserAssignedIssues.mockResolvedValue({ issues: [], total: 0 });
      mockGetSupabaseConfig.mockResolvedValue(null);

      const result = await getActiveIssuesWithTime(ACCOUNT_ID, CLOUD_ID);

      expect(result.issues).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should handle null issues array from Jira gracefully', async () => {
      mockGetAllUserAssignedIssues.mockResolvedValue({ issues: null, total: 0 });
      mockGetSupabaseConfig.mockResolvedValue(null);

      const result = await getActiveIssuesWithTime(ACCOUNT_ID, CLOUD_ID);

      expect(result.issues).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('should return issues without time when organization lookup fails', async () => {
      const issue = makeJiraIssue('JSM-1');
      mockGetAllUserAssignedIssues.mockResolvedValue({ issues: [issue], total: 1 });
      mockGetSupabaseConfig.mockResolvedValue(FAKE_SUPABASE_CONFIG);
      mockGetOrCreateOrganization.mockResolvedValue(null);

      const result = await getActiveIssuesWithTime(ACCOUNT_ID, CLOUD_ID);

      expect(result.total).toBe(1);
      expect(result.issues[0].timeTracked).toBe(0);
    });

    it('should return issues without time when user lookup fails', async () => {
      const issue = makeJiraIssue('JSM-1');
      mockGetAllUserAssignedIssues.mockResolvedValue({ issues: [issue], total: 1 });
      mockGetSupabaseConfig.mockResolvedValue(FAKE_SUPABASE_CONFIG);
      mockGetOrCreateOrganization.mockResolvedValue({ id: ORG_ID });
      mockGetOrCreateUser.mockResolvedValue(null);

      const result = await getActiveIssuesWithTime(ACCOUNT_ID, CLOUD_ID);

      expect(result.total).toBe(1);
      expect(result.issues[0].timeTracked).toBe(0);
    });
  });
});
