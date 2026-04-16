'use strict';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockCreateJiraWorklog = jest.fn();
const mockUpdateJiraWorklog = jest.fn();
const mockDeleteJiraWorklog = jest.fn();
const mockDeleteJiraWorklogAsApp = jest.fn();
const mockGetAllUserAssignedIssues = jest.fn();

jest.mock('../../src/utils/jira.js', () => ({
  createJiraWorklog: mockCreateJiraWorklog,
  updateJiraWorklog: mockUpdateJiraWorklog,
  deleteJiraWorklog: mockDeleteJiraWorklog,
  deleteJiraWorklogAsApp: mockDeleteJiraWorklogAsApp,
  getAllUserAssignedIssues: mockGetAllUserAssignedIssues,
}));

// Mock @forge/api — used by the /myself verification check in syncCurrentUserWorklogs
const mockRequestJira = jest.fn();
const mockAsUser = jest.fn(() => ({ requestJira: mockRequestJira }));
jest.mock('@forge/api', () => {
  const api = { asUser: mockAsUser };
  api.route = (strings, ...values) => strings.reduce((acc, s, i) => acc + s + (values[i] || ''), '');
  return { __esModule: true, default: api, route: api.route };
});

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

jest.mock('../../src/utils/formatters.js', () => ({
  formatJiraDate: jest.fn((date) => {
    const d = date || new Date('2026-03-12T10:00:00.000Z');
    return d.toISOString().replace('Z', '+0000');
  }),
}));

jest.mock('../../src/utils/validators.js', () => ({
  isValidIssueKey: jest.fn((val) => typeof val === 'string' && /^[A-Z]+-\d+$/.test(val)),
}));

// ---------------------------------------------------------------------------
// Import the module under test
// ---------------------------------------------------------------------------
const { syncCurrentUserWorklogs } = require('../../src/services/worklogService.js');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const FAKE_SUPABASE_CONFIG = { url: 'https://test.supabase.co', key: 'test-key' };
const ORG_ID = 'org-uuid-1';
const USER_ID = 'user-uuid-1';
const ACCOUNT_ID = 'atlassian-account-123';
const CLOUD_ID = 'cloud-id-1';
const ISSUE_KEY = 'ESW-6570';

// ---------------------------------------------------------------------------
// Helper to build supabaseRequest mock for syncCurrentUserWorklogs flow
// ---------------------------------------------------------------------------
function buildSupabaseRequestMock({
  trackingSettings = [{ project_key: null, jira_worklog_sync_enabled: true }],
  activityRecords = [],
  unassignedRecords = [],
  existingMappings = [],
  allMappings = [],
} = {}) {
  return jest.fn().mockImplementation((config, query, options) => {
    // tracking_settings fetch
    if (query.startsWith('tracking_settings?')) {
      return Promise.resolve(trackingSettings);
    }

    // activity_records — unassigned (user_assigned_issue_key=is.null)
    if (query.startsWith('activity_records?') && query.includes('user_assigned_issue_key=is.null')) {
      return Promise.resolve(unassignedRecords);
    }

    // activity_records — assigned (all records including those with issue keys)
    if (query.startsWith('activity_records?')) {
      return Promise.resolve(activityRecords);
    }

    // Existing worklog_sync mappings
    if (query.startsWith('worklog_sync?') && query.includes('issue_key=in.')) {
      return Promise.resolve(existingMappings);
    }

    // All worklog_sync mappings for cleanup
    if (query.startsWith('worklog_sync?') && query.includes('select=id,issue_key,jira_worklog_id') && !query.includes('issue_key=in.')) {
      return Promise.resolve(allMappings);
    }

    // worklog_sync POST
    if (query === 'worklog_sync' && options?.method === 'POST') {
      return Promise.resolve({ id: 'mapping-new' });
    }

    // worklog_sync PATCH
    if (query.startsWith('worklog_sync?id=eq.') && options?.method === 'PATCH') {
      return Promise.resolve({});
    }

    // worklog_sync DELETE
    if (query.startsWith('worklog_sync?id=eq.') && options?.method === 'DELETE') {
      return Promise.resolve({});
    }

    return Promise.resolve([]);
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
beforeEach(() => {
  jest.clearAllMocks();
  mockGetSupabaseConfig.mockResolvedValue(FAKE_SUPABASE_CONFIG);
  mockGetOrCreateOrganization.mockResolvedValue({ id: ORG_ID });
  mockGetOrCreateUser.mockResolvedValue(USER_ID);

  // Default: /myself check succeeds and returns the expected user
  mockRequestJira.mockResolvedValue({
    json: () => Promise.resolve({ accountId: ACCOUNT_ID, displayName: 'Test User' }),
  });

  // Default: no Jira issues for fallback matching (no unassigned time matches)
  mockGetAllUserAssignedIssues.mockResolvedValue({ issues: [], total: 0 });
});

// ============================================================================
// Tests: pending record migration in user context
// ============================================================================
describe('worklogService — syncCurrentUserWorklogs', () => {

  describe('when a pending record exists (jira_worklog_id = PENDING)', () => {
    it('creates the worklog as the user without trying to delete from Jira', async () => {
      mockSupabaseRequest.mockImplementation(
        buildSupabaseRequestMock({
          activityRecords: [{
            user_assigned_issue_key: ISSUE_KEY,
            duration_seconds: 120,
            total_time_seconds: 120,
            end_time: '2026-03-12T10:00:00Z',
          }],
          existingMappings: [{
            id: 'mapping-pending-1',
            issue_key: ISSUE_KEY,
            jira_worklog_id: 'PENDING', // Pending — no Jira worklog
            last_synced_seconds: 120,
            created_as_user: false,
          }],
        })
      );

      // createJiraWorklog (used in user context) succeeds
      mockCreateJiraWorklog.mockResolvedValue({
        id: 'worklog-user-1',
        author: { accountId: ACCOUNT_ID },
      });

      const result = await syncCurrentUserWorklogs(ACCOUNT_ID, CLOUD_ID);

      expect(result.success).toBe(true);
      expect(result.synced).toBe(1);

      // Should NOT try to delete from Jira (no worklog to delete)
      expect(mockDeleteJiraWorklog).not.toHaveBeenCalled();
      expect(mockDeleteJiraWorklogAsApp).not.toHaveBeenCalled();

      // Should delete the pending DB mapping
      const deleteCall = mockSupabaseRequest.mock.calls.find(
        ([, q, opts]) => q === 'worklog_sync?id=eq.mapping-pending-1' && opts?.method === 'DELETE'
      );
      expect(deleteCall).toBeDefined();

      // Should create fresh worklog via user session
      expect(mockCreateJiraWorklog).toHaveBeenCalledWith(
        ISSUE_KEY, 120, expect.any(String), 'Test User'
      );

      // New mapping should have created_as_user = true
      const postCall = mockSupabaseRequest.mock.calls.find(
        ([, q, opts]) => q === 'worklog_sync' && opts?.method === 'POST'
      );
      expect(postCall).toBeDefined();
      expect(postCall[2].body.created_as_user).toBe(true);
      expect(postCall[2].body.jira_worklog_id).toBe('worklog-user-1');
    });
  });

  describe('when an app-created worklog exists (jira_worklog_id is set)', () => {
    it('deletes the app worklog and recreates as user', async () => {
      mockSupabaseRequest.mockImplementation(
        buildSupabaseRequestMock({
          activityRecords: [{
            user_assigned_issue_key: ISSUE_KEY,
            duration_seconds: 120,
            total_time_seconds: 120,
            end_time: '2026-03-12T10:00:00Z',
          }],
          existingMappings: [{
            id: 'mapping-app-1',
            issue_key: ISSUE_KEY,
            jira_worklog_id: 'jira-worklog-app',
            last_synced_seconds: 120,
            created_as_user: false,
          }],
        })
      );

      // Delete the app worklog succeeds
      mockDeleteJiraWorklog.mockResolvedValue({ status: 204 });

      // Create as user succeeds
      mockCreateJiraWorklog.mockResolvedValue({
        id: 'worklog-user-2',
        author: { accountId: ACCOUNT_ID },
      });

      const result = await syncCurrentUserWorklogs(ACCOUNT_ID, CLOUD_ID);

      expect(result.success).toBe(true);
      expect(result.synced).toBe(1);

      // Should delete the app worklog from Jira
      expect(mockDeleteJiraWorklog).toHaveBeenCalledWith(ISSUE_KEY, 'jira-worklog-app');

      // Should create new worklog as user
      expect(mockCreateJiraWorklog).toHaveBeenCalledWith(
        ISSUE_KEY, 120, expect.any(String), 'Test User'
      );

      // New mapping should be user-created
      const postCall = mockSupabaseRequest.mock.calls.find(
        ([, q, opts]) => q === 'worklog_sync' && opts?.method === 'POST'
      );
      expect(postCall).toBeDefined();
      expect(postCall[2].body.created_as_user).toBe(true);
    });

    it('falls back to app-delete when user lacks DELETE_ALL_WORKLOGS (403)', async () => {
      mockSupabaseRequest.mockImplementation(
        buildSupabaseRequestMock({
          activityRecords: [{
            user_assigned_issue_key: ISSUE_KEY,
            duration_seconds: 120,
            total_time_seconds: 120,
            end_time: '2026-03-12T10:00:00Z',
          }],
          existingMappings: [{
            id: 'mapping-app-2',
            issue_key: ISSUE_KEY,
            jira_worklog_id: 'jira-worklog-app-2',
            last_synced_seconds: 120,
            created_as_user: false,
          }],
        })
      );

      // User delete fails with 403
      mockDeleteJiraWorklog.mockResolvedValue({ status: 403 });
      // App delete succeeds
      mockDeleteJiraWorklogAsApp.mockResolvedValue({ status: 204 });

      mockCreateJiraWorklog.mockResolvedValue({
        id: 'worklog-user-3',
        author: { accountId: ACCOUNT_ID },
      });

      const result = await syncCurrentUserWorklogs(ACCOUNT_ID, CLOUD_ID);

      expect(result.success).toBe(true);
      expect(result.synced).toBe(1);

      // Should have tried user delete, then fallen back to app delete
      expect(mockDeleteJiraWorklog).toHaveBeenCalled();
      expect(mockDeleteJiraWorklogAsApp).toHaveBeenCalledWith(ISSUE_KEY, 'jira-worklog-app-2');
    });
  });

  describe('when a user-created worklog exists with changed time', () => {
    it('updates the existing worklog in place', async () => {
      mockSupabaseRequest.mockImplementation(
        buildSupabaseRequestMock({
          activityRecords: [{
            user_assigned_issue_key: ISSUE_KEY,
            duration_seconds: 300,
            total_time_seconds: 300,
            end_time: '2026-03-12T10:00:00Z',
          }],
          existingMappings: [{
            id: 'mapping-user-1',
            issue_key: ISSUE_KEY,
            jira_worklog_id: 'jira-worklog-user-1',
            last_synced_seconds: 120,
            created_as_user: true,
          }],
        })
      );

      mockUpdateJiraWorklog.mockResolvedValue({ status: 200 });

      const result = await syncCurrentUserWorklogs(ACCOUNT_ID, CLOUD_ID);

      expect(result.success).toBe(true);
      expect(result.synced).toBe(1);

      // Should update in place, not delete+recreate
      expect(mockUpdateJiraWorklog).toHaveBeenCalledWith(
        ISSUE_KEY, 'jira-worklog-user-1', 300
      );
      expect(mockDeleteJiraWorklog).not.toHaveBeenCalled();
    });
  });

  describe('when updating a user-created worklog fails with a non-404 status', () => {
    it('counts the entry as an error and does NOT create a duplicate worklog', async () => {
      mockSupabaseRequest.mockImplementation(
        buildSupabaseRequestMock({
          activityRecords: [{
            user_assigned_issue_key: ISSUE_KEY,
            duration_seconds: 300,
            total_time_seconds: 300,
            end_time: '2026-03-12T10:00:00Z',
          }],
          existingMappings: [{
            id: 'mapping-user-nonfatal',
            issue_key: ISSUE_KEY,
            jira_worklog_id: 'jira-worklog-user-nonfatal',
            last_synced_seconds: 120,
            created_as_user: true,
          }],
        })
      );

      // Jira returns 500 — transient/server failure. The worklog still exists
      // in Jira, so the caller MUST NOT fall through to create (which would
      // duplicate the worklog and fail the worklog_sync unique constraint).
      mockUpdateJiraWorklog.mockResolvedValue({
        status: 500,
        text: async () => 'Internal Server Error',
      });

      const result = await syncCurrentUserWorklogs(ACCOUNT_ID, CLOUD_ID);

      expect(result.success).toBe(true);
      expect(result.synced).toBe(0);
      expect(result.errors).toBe(1);

      expect(mockUpdateJiraWorklog).toHaveBeenCalledWith(
        ISSUE_KEY, 'jira-worklog-user-nonfatal', 300
      );
      // Critical: create must NOT be called on a non-404 update failure.
      expect(mockCreateJiraWorklog).not.toHaveBeenCalled();
      // Mapping row must not be deleted on non-404 failure (it's only deleted on 404).
      const mappingDelete = mockSupabaseRequest.mock.calls.find(
        ([, q, opts]) => q === `worklog_sync?id=eq.mapping-user-nonfatal` && opts?.method === 'DELETE'
      );
      expect(mappingDelete).toBeUndefined();
    });
  });

  describe('when a user-created worklog has unchanged time', () => {
    it('skips syncing', async () => {
      mockSupabaseRequest.mockImplementation(
        buildSupabaseRequestMock({
          activityRecords: [{
            user_assigned_issue_key: ISSUE_KEY,
            duration_seconds: 120,
            total_time_seconds: 120,
            end_time: '2026-03-12T10:00:00Z',
          }],
          existingMappings: [{
            id: 'mapping-user-2',
            issue_key: ISSUE_KEY,
            jira_worklog_id: 'jira-worklog-user-2',
            last_synced_seconds: 120,
            created_as_user: true,
          }],
        })
      );

      const result = await syncCurrentUserWorklogs(ACCOUNT_ID, CLOUD_ID);

      expect(result.success).toBe(true);
      expect(result.synced).toBe(0);
      expect(mockUpdateJiraWorklog).not.toHaveBeenCalled();
      expect(mockCreateJiraWorklog).not.toHaveBeenCalled();
    });
  });

  describe('when no existing mapping exists', () => {
    it('creates a new worklog as user', async () => {
      mockSupabaseRequest.mockImplementation(
        buildSupabaseRequestMock({
          activityRecords: [{
            user_assigned_issue_key: ISSUE_KEY,
            duration_seconds: 180,
            total_time_seconds: 180,
            end_time: '2026-03-12T10:00:00Z',
          }],
          existingMappings: [], // No prior mapping
        })
      );

      mockCreateJiraWorklog.mockResolvedValue({
        id: 'worklog-brand-new',
        author: { accountId: ACCOUNT_ID },
      });

      const result = await syncCurrentUserWorklogs(ACCOUNT_ID, CLOUD_ID);

      expect(result.success).toBe(true);
      expect(result.synced).toBe(1);

      expect(mockCreateJiraWorklog).toHaveBeenCalledWith(
        ISSUE_KEY, 180, expect.any(String), 'Test User'
      );

      const postCall = mockSupabaseRequest.mock.calls.find(
        ([, q, opts]) => q === 'worklog_sync' && opts?.method === 'POST'
      );
      expect(postCall).toBeDefined();
      expect(postCall[2].body.created_as_user).toBe(true);
      expect(postCall[2].body.jira_worklog_id).toBe('worklog-brand-new');
    });
  });

  describe('when sync is not enabled', () => {
    it('returns early with success', async () => {
      mockSupabaseRequest.mockImplementation(
        buildSupabaseRequestMock({
          trackingSettings: [{ project_key: null, jira_worklog_sync_enabled: false }],
        })
      );

      const result = await syncCurrentUserWorklogs(ACCOUNT_ID, CLOUD_ID);

      expect(result.success).toBe(true);
      expect(result.synced).toBe(0);
      expect(result.message).toMatch(/not enabled/i);
    });
  });

  describe('when /myself verification fails', () => {
    it('returns early with error when user session is broken', async () => {
      mockRequestJira.mockRejectedValue(new Error('Unauthorized'));

      const result = await syncCurrentUserWorklogs(ACCOUNT_ID, CLOUD_ID);

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/User session not available/i);
      // Should NOT proceed to create any worklogs
      expect(mockCreateJiraWorklog).not.toHaveBeenCalled();
    });
  });

  describe('when records have no user_assigned_issue_key but have project_key', () => {
    it('creates worklog via window-title fallback matching', async () => {
      mockSupabaseRequest.mockImplementation(
        buildSupabaseRequestMock({
          activityRecords: [], // No directly-assigned records
          unassignedRecords: [{
            project_key: 'FEEDBACK',
            window_title: 'FEEDBACK-33 - Fix login bug - Jira',
            duration_seconds: 484, // 8m 4s
            total_time_seconds: 484,
            end_time: '2026-04-01T10:00:00Z',
          }],
          existingMappings: [],
        })
      );

      // User has FEEDBACK-33 in-progress in Jira
      mockGetAllUserAssignedIssues.mockResolvedValue({
        issues: [{
          key: 'FEEDBACK-33',
          fields: {
            project: { key: 'FEEDBACK' },
            status: { statusCategory: { key: 'indeterminate' } },
          }
        }],
        total: 1,
      });

      mockCreateJiraWorklog.mockResolvedValue({
        id: 'worklog-fallback-1',
        author: { accountId: ACCOUNT_ID },
      });

      const result = await syncCurrentUserWorklogs(ACCOUNT_ID, CLOUD_ID);

      expect(result.success).toBe(true);
      expect(result.synced).toBe(1);

      // Should create worklog on the in-progress issue
      expect(mockCreateJiraWorklog).toHaveBeenCalledWith(
        'FEEDBACK-33', 484, expect.any(String), 'Test User'
      );

      // New mapping should be user-created
      const postCall = mockSupabaseRequest.mock.calls.find(
        ([, q, opts]) => q === 'worklog_sync' && opts?.method === 'POST'
      );
      expect(postCall).toBeDefined();
      expect(postCall[2].body.created_as_user).toBe(true);
      expect(postCall[2].body.issue_key).toBe('FEEDBACK-33');
    });

    it('merges direct and fallback time for same issue', async () => {
      mockSupabaseRequest.mockImplementation(
        buildSupabaseRequestMock({
          activityRecords: [{
            user_assigned_issue_key: 'FEEDBACK-33',
            duration_seconds: 120,
            total_time_seconds: 120,
            end_time: '2026-04-01T09:00:00Z',
          }],
          unassignedRecords: [{
            project_key: 'FEEDBACK',
            window_title: 'FEEDBACK-33 - Fix login bug - Jira',
            duration_seconds: 300,
            total_time_seconds: 300,
            end_time: '2026-04-01T10:00:00Z',
          }],
          existingMappings: [],
        })
      );

      mockGetAllUserAssignedIssues.mockResolvedValue({
        issues: [{
          key: 'FEEDBACK-33',
          fields: {
            project: { key: 'FEEDBACK' },
            status: { statusCategory: { key: 'indeterminate' } },
          }
        }],
        total: 1,
      });

      mockCreateJiraWorklog.mockResolvedValue({
        id: 'worklog-merged-1',
        author: { accountId: ACCOUNT_ID },
      });

      const result = await syncCurrentUserWorklogs(ACCOUNT_ID, CLOUD_ID);

      expect(result.success).toBe(true);
      expect(result.synced).toBe(1);

      // Should create worklog with merged time (120 + 300 = 420s)
      expect(mockCreateJiraWorklog).toHaveBeenCalledWith(
        'FEEDBACK-33', 420, expect.any(String), 'Test User'
      );
    });
  });
});
