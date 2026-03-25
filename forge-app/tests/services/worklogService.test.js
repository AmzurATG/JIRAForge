'use strict';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockCreateJiraWorklog = jest.fn();
const mockUpdateJiraWorklog = jest.fn();
const mockDeleteJiraWorklog = jest.fn();
const mockDeleteJiraWorklogAsApp = jest.fn();

jest.mock('../../src/utils/jira.js', () => ({
  createJiraWorklog: mockCreateJiraWorklog,
  updateJiraWorklog: mockUpdateJiraWorklog,
  deleteJiraWorklog: mockDeleteJiraWorklog,
  deleteJiraWorklogAsApp: mockDeleteJiraWorklogAsApp,
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
  existingMappings = [],
  allMappings = [],
} = {}) {
  return jest.fn().mockImplementation((config, query, options) => {
    // tracking_settings fetch
    if (query.startsWith('tracking_settings?')) {
      return Promise.resolve(trackingSettings);
    }

    // activity_records aggregation
    if (query.startsWith('activity_records?')) {
      return Promise.resolve(activityRecords);
    }

    // Existing worklog_sync mappings
    if (query.startsWith('worklog_sync?organization_id=') && query.includes('issue_key=in.')) {
      return Promise.resolve(existingMappings);
    }

    // All worklog_sync mappings for cleanup
    if (query.startsWith('worklog_sync?organization_id=') && query.includes('select=id,issue_key,jira_worklog_id') && !query.includes('issue_key=in.')) {
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
});

// ============================================================================
// Tests: pending record migration in user context
// ============================================================================
describe('worklogService — syncCurrentUserWorklogs', () => {

  describe('when a pending record exists (jira_worklog_id = null)', () => {
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
            jira_worklog_id: null, // Pending — no Jira worklog
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
        ISSUE_KEY, 120, expect.any(String)
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
        ISSUE_KEY, 120, expect.any(String)
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
        ISSUE_KEY, 180, expect.any(String)
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
});
