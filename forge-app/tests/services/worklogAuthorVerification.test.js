'use strict';

/**
 * Worklog Author Verification Tests
 * Validates that:
 * 1. Comment format is "Uploaded by {displayName}" (not "Uploaded from Time Tracker")
 * 2. created_as_user flag is set based on actual Jira response, not assumed true
 * 3. When Jira attributes worklog to app despite asUser(), created_as_user = false
 */

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
    const d = date || new Date('2026-04-02T10:00:00.000Z');
    return d.toISOString().replace('Z', '+0000');
  }),
}));

jest.mock('../../src/utils/validators.js', () => ({
  isValidIssueKey: jest.fn((val) => typeof val === 'string' && /^[A-Z]+-\d+$/.test(val)),
}));

const { syncCurrentUserWorklogs } = require('../../src/services/worklogService.js');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SUPABASE_CONFIG = { url: 'https://test.supabase.co', key: 'test-key' };
const ORG_ID = 'org-uuid-1';
const USER_ID = 'user-uuid-1';
const ACCOUNT_ID = 'atlassian-account-123';
const APP_ACCOUNT_ID = 'forge-app-account-456';
const CLOUD_ID = 'cloud-id-1';
const ISSUE_KEY = 'FEEDBACK-33';
const DISPLAY_NAME = 'Iswarya K';

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function buildSupabaseRequestMock({
  trackingSettings = [{ project_key: null, jira_worklog_sync_enabled: true }],
  activityRecords = [],
  existingMappings = [],
} = {}) {
  return jest.fn().mockImplementation((config, query, options) => {
    if (query.startsWith('tracking_settings?')) return Promise.resolve(trackingSettings);
    if (query.startsWith('activity_records?') && query.includes('user_assigned_issue_key=is.null'))
      return Promise.resolve([]);
    if (query.startsWith('activity_records?')) return Promise.resolve(activityRecords);
    if (query.startsWith('worklog_sync?') && query.includes('issue_key=in.'))
      return Promise.resolve(existingMappings);
    if (query.startsWith('worklog_sync?') && query.includes('select=id,issue_key,jira_worklog_id') && !query.includes('issue_key=in.'))
      return Promise.resolve([]);
    if (query === 'worklog_sync' && options?.method === 'POST') return Promise.resolve({ id: 'mapping-new' });
    if (query.startsWith('worklog_sync?id=eq.') && options?.method === 'PATCH') return Promise.resolve({});
    if (query.startsWith('worklog_sync?id=eq.') && options?.method === 'DELETE') return Promise.resolve({});
    return Promise.resolve([]);
  });
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------
beforeEach(() => {
  jest.clearAllMocks();
  mockGetSupabaseConfig.mockResolvedValue(SUPABASE_CONFIG);
  mockGetOrCreateOrganization.mockResolvedValue({ id: ORG_ID });
  mockGetOrCreateUser.mockResolvedValue(USER_ID);
  mockGetAllUserAssignedIssues.mockResolvedValue({ issues: [], total: 0 });

  // /myself returns the real user
  mockRequestJira.mockResolvedValue({
    json: () => Promise.resolve({ accountId: ACCOUNT_ID, displayName: DISPLAY_NAME }),
  });
});

// ===========================================================================
// Tests
// ===========================================================================

describe('Worklog comment format', () => {
  it('passes displayName to createJiraWorklog so comment says "Uploaded by {name}"', async () => {
    mockSupabaseRequest.mockImplementation(
      buildSupabaseRequestMock({
        activityRecords: [{
          user_assigned_issue_key: ISSUE_KEY,
          duration_seconds: 300,
          total_time_seconds: 300,
          end_time: '2026-04-02T10:00:00Z',
        }],
        existingMappings: [],
      })
    );

    mockCreateJiraWorklog.mockResolvedValue({
      id: 'worklog-test-1',
      author: { accountId: ACCOUNT_ID, displayName: DISPLAY_NAME },
    });

    await syncCurrentUserWorklogs(ACCOUNT_ID, CLOUD_ID);

    // The 4th argument should be the displayName
    expect(mockCreateJiraWorklog).toHaveBeenCalledWith(
      ISSUE_KEY, 300, expect.any(String), DISPLAY_NAME
    );
  });
});

describe('Author verification — created_as_user flag', () => {
  it('sets created_as_user=true when Jira author matches the user', async () => {
    mockSupabaseRequest.mockImplementation(
      buildSupabaseRequestMock({
        activityRecords: [{
          user_assigned_issue_key: ISSUE_KEY,
          duration_seconds: 300,
          total_time_seconds: 300,
          end_time: '2026-04-02T10:00:00Z',
        }],
        existingMappings: [],
      })
    );

    // Jira correctly attributes the worklog to the user
    mockCreateJiraWorklog.mockResolvedValue({
      id: 'worklog-user-ok',
      author: { accountId: ACCOUNT_ID, displayName: DISPLAY_NAME },
    });

    const result = await syncCurrentUserWorklogs(ACCOUNT_ID, CLOUD_ID);
    expect(result.success).toBe(true);
    expect(result.synced).toBe(1);

    const postCall = mockSupabaseRequest.mock.calls.find(
      ([, q, opts]) => q === 'worklog_sync' && opts?.method === 'POST'
    );
    expect(postCall).toBeDefined();
    expect(postCall[2].body.created_as_user).toBe(true);
  });

  it('sets created_as_user=false when Jira author is the app (not the user)', async () => {
    mockSupabaseRequest.mockImplementation(
      buildSupabaseRequestMock({
        activityRecords: [{
          user_assigned_issue_key: ISSUE_KEY,
          duration_seconds: 300,
          total_time_seconds: 300,
          end_time: '2026-04-02T10:00:00Z',
        }],
        existingMappings: [],
      })
    );

    // Jira attributes the worklog to the APP despite asUser()
    mockCreateJiraWorklog.mockResolvedValue({
      id: 'worklog-app-oops',
      author: { accountId: APP_ACCOUNT_ID, displayName: 'Time Tracker App' },
    });

    const result = await syncCurrentUserWorklogs(ACCOUNT_ID, CLOUD_ID);
    expect(result.success).toBe(true);
    expect(result.synced).toBe(1);

    const postCall = mockSupabaseRequest.mock.calls.find(
      ([, q, opts]) => q === 'worklog_sync' && opts?.method === 'POST'
    );
    expect(postCall).toBeDefined();
    // THIS IS THE KEY FIX: previously this was always true
    expect(postCall[2].body.created_as_user).toBe(false);
  });

  it('sets created_as_user=false when Jira response has no author field', async () => {
    mockSupabaseRequest.mockImplementation(
      buildSupabaseRequestMock({
        activityRecords: [{
          user_assigned_issue_key: ISSUE_KEY,
          duration_seconds: 300,
          total_time_seconds: 300,
          end_time: '2026-04-02T10:00:00Z',
        }],
        existingMappings: [],
      })
    );

    // Jira returns worklog with no author field
    mockCreateJiraWorklog.mockResolvedValue({
      id: 'worklog-no-author',
    });

    const result = await syncCurrentUserWorklogs(ACCOUNT_ID, CLOUD_ID);
    expect(result.success).toBe(true);

    const postCall = mockSupabaseRequest.mock.calls.find(
      ([, q, opts]) => q === 'worklog_sync' && opts?.method === 'POST'
    );
    expect(postCall).toBeDefined();
    expect(postCall[2].body.created_as_user).toBe(false);
  });
});

describe('Migration retry — app-authored worklog gets retried on next sync', () => {
  it('re-attempts migration when existing mapping has created_as_user=false', async () => {
    mockSupabaseRequest.mockImplementation(
      buildSupabaseRequestMock({
        activityRecords: [{
          user_assigned_issue_key: ISSUE_KEY,
          duration_seconds: 300,
          total_time_seconds: 300,
          end_time: '2026-04-02T10:00:00Z',
        }],
        existingMappings: [{
          id: 'mapping-app-authored',
          issue_key: ISSUE_KEY,
          jira_worklog_id: 'worklog-app-old',
          last_synced_seconds: 300,
          created_as_user: false, // Previously app-authored
        }],
      })
    );

    // Delete the old app worklog succeeds
    mockDeleteJiraWorklog.mockResolvedValue({ status: 204 });

    // Re-create as user succeeds this time
    mockCreateJiraWorklog.mockResolvedValue({
      id: 'worklog-user-new',
      author: { accountId: ACCOUNT_ID, displayName: DISPLAY_NAME },
    });

    const result = await syncCurrentUserWorklogs(ACCOUNT_ID, CLOUD_ID);
    expect(result.success).toBe(true);
    expect(result.synced).toBe(1);

    // Should have deleted the old app worklog
    expect(mockDeleteJiraWorklog).toHaveBeenCalledWith(ISSUE_KEY, 'worklog-app-old');

    // Should have created a new one
    expect(mockCreateJiraWorklog).toHaveBeenCalledWith(
      ISSUE_KEY, 300, expect.any(String), DISPLAY_NAME
    );

    // New mapping should reflect actual author verification
    const postCall = mockSupabaseRequest.mock.calls.find(
      ([, q, opts]) => q === 'worklog_sync' && opts?.method === 'POST'
    );
    expect(postCall).toBeDefined();
    expect(postCall[2].body.created_as_user).toBe(true);
    expect(postCall[2].body.jira_worklog_id).toBe('worklog-user-new');
  });
});
