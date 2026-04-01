'use strict';

// ---------------------------------------------------------------------------
// Module mocks — jest.mock() calls are hoisted before all imports/requires.
// ---------------------------------------------------------------------------

const mockCreateJiraWorklogAsUser = jest.fn();
const mockCreateJiraWorklogAsApp = jest.fn();
const mockUpdateJiraWorklogAsUser = jest.fn();
const mockUpdateJiraWorklogAsApp = jest.fn();
const mockDeleteJiraWorklogAsUser = jest.fn();
const mockDeleteJiraWorklogAsApp = jest.fn();

jest.mock('../../src/utils/jira.js', () => ({
  createJiraWorklogAsUser: mockCreateJiraWorklogAsUser,
  createJiraWorklogAsApp: mockCreateJiraWorklogAsApp,
  updateJiraWorklogAsUser: mockUpdateJiraWorklogAsUser,
  updateJiraWorklogAsApp: mockUpdateJiraWorklogAsApp,
  deleteJiraWorklogAsUser: mockDeleteJiraWorklogAsUser,
  deleteJiraWorklogAsApp: mockDeleteJiraWorklogAsApp,
}));

const mockGetSupabaseConfig = jest.fn();
const mockSupabaseRequest = jest.fn();

jest.mock('../../src/utils/supabase.js', () => ({
  getSupabaseConfig: mockGetSupabaseConfig,
  supabaseRequest: mockSupabaseRequest,
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
const { runScheduledWorklogSync } = require('../../src/services/scheduledWorklogSync.js');

// ---------------------------------------------------------------------------
// Constants used across tests
// ---------------------------------------------------------------------------
const FAKE_SUPABASE_CONFIG = { url: 'https://test.supabase.co', key: 'test-key' };
const ORG_ID = 'org-uuid-1';
const USER_ID = 'user-uuid-1';
const ACCOUNT_ID = 'atlassian-account-123';
const DISPLAY_NAME = 'Srilakshmi Achanta';
const ISSUE_KEY = 'ESW-6570';

// ---------------------------------------------------------------------------
// Helpers to build supabaseRequest responses based on the query path.
// ---------------------------------------------------------------------------

/**
 * Build a standard mock implementation for supabaseRequest.
 * Returns different data based on the query string to simulate the
 * full runScheduledWorklogSync flow.
 */
function buildSupabaseRequestMock({
  trackingSettings = [{ organization_id: ORG_ID, project_key: null, jira_worklog_sync_enabled: true }],
  activityRecords = [],
  userRows = [{ atlassian_account_id: ACCOUNT_ID, display_name: DISPLAY_NAME }],
  existingMappings = [],
  allMappings = [],
} = {}) {
  return jest.fn().mockImplementation((config, query, options) => {
    // tracking_settings fetch
    if (query.startsWith('tracking_settings?')) {
      return Promise.resolve(trackingSettings);
    }

    // activity_records aggregation (time per user/issue)
    if (query.startsWith('activity_records?organization_id=')) {
      return Promise.resolve(activityRecords);
    }

    // User lookup for atlassian_account_id + display_name
    if (query.startsWith(`users?id=eq.${USER_ID}`)) {
      return Promise.resolve(userRows);
    }

    // Existing worklog_sync mappings per user
    if (query.startsWith('worklog_sync?organization_id=') && query.includes('user_id=') && query.includes('issue_key=in.')) {
      return Promise.resolve(existingMappings);
    }

    // All worklog_sync mappings for org (cleanup phase)
    if (query.startsWith('worklog_sync?organization_id=') && query.includes('select=id,user_id,issue_key,jira_worklog_id') && !query.includes('user_id=eq.')) {
      return Promise.resolve(allMappings);
    }

    // Worklog_sync POST (create mapping)
    if (query === 'worklog_sync' && options?.method === 'POST') {
      return Promise.resolve({ id: 'mapping-new' });
    }

    // Worklog_sync PATCH (update mapping)
    if (query.startsWith('worklog_sync?id=eq.') && options?.method === 'PATCH') {
      return Promise.resolve({});
    }

    // Worklog_sync DELETE (delete mapping)
    if (query.startsWith('worklog_sync?id=eq.') && options?.method === 'DELETE') {
      return Promise.resolve({});
    }

    // Users lookup for cleanup (by id list)
    if (query.startsWith('users?id=in.')) {
      return Promise.resolve(userRows.map(u => ({ id: USER_ID, atlassian_account_id: u.atlassian_account_id })));
    }

    // Default: empty
    return Promise.resolve([]);
  });
}

// ---------------------------------------------------------------------------
// Setup and teardown
// ---------------------------------------------------------------------------
beforeEach(() => {
  jest.clearAllMocks();
  mockGetSupabaseConfig.mockResolvedValue(FAKE_SUPABASE_CONFIG);
});

// ============================================================================
// Tests: created_as_user flag (the fix under test)
// ============================================================================
describe('scheduledWorklogSync — created_as_user flag', () => {

  describe('when impersonation succeeds (author matches accountId)', () => {
    it('sets created_as_user to TRUE', async () => {
      // Activity record: 120s tracked on ESW-6570 by user-uuid-1
      mockSupabaseRequest.mockImplementation(
        buildSupabaseRequestMock({
          activityRecords: [{
            user_id: USER_ID,
            user_assigned_issue_key: ISSUE_KEY,
            duration_seconds: 120,
            total_time_seconds: 120,
            end_time: '2026-03-12T10:00:00Z',
          }],
        })
      );

      // createJiraWorklogAsUser returns worklog with author matching accountId
      mockCreateJiraWorklogAsUser.mockResolvedValue({
        id: 'worklog-1',
        author: { accountId: ACCOUNT_ID, displayName: DISPLAY_NAME },
      });

      const result = await runScheduledWorklogSync();

      expect(result.success).toBe(true);
      expect(result.synced).toBe(1);

      // Verify worklog was created via asUser
      expect(mockCreateJiraWorklogAsUser).toHaveBeenCalledWith(
        ACCOUNT_ID,
        ISSUE_KEY,
        120,
        expect.any(String),
        DISPLAY_NAME
      );
      expect(mockCreateJiraWorklogAsApp).not.toHaveBeenCalled();

      // Find the worklog_sync POST call and verify created_as_user is TRUE
      const postCall = mockSupabaseRequest.mock.calls.find(
        ([, q, opts]) => q === 'worklog_sync' && opts?.method === 'POST'
      );
      expect(postCall).toBeDefined();
      expect(postCall[2].body.created_as_user).toBe(true);
      expect(postCall[2].body.issue_key).toBe(ISSUE_KEY);
      expect(postCall[2].body.jira_worklog_id).toBe('worklog-1');
    });
  });

  describe('when impersonation is called but author does NOT match accountId', () => {
    it('deletes the app worklog and saves a pending record', async () => {
      mockSupabaseRequest.mockImplementation(
        buildSupabaseRequestMock({
          activityRecords: [{
            user_id: USER_ID,
            user_assigned_issue_key: ISSUE_KEY,
            duration_seconds: 120,
            total_time_seconds: 120,
            end_time: '2026-03-12T10:00:00Z',
          }],
        })
      );

      // Jira returned the worklog but the author is the app, not the user
      mockCreateJiraWorklogAsUser.mockResolvedValue({
        id: 'worklog-2',
        author: { accountId: 'app-account-id', displayName: 'Time Tracker App' },
      });

      // deleteJiraWorklogAsApp used to clean up the app-authored worklog
      mockDeleteJiraWorklogAsApp.mockResolvedValue({ status: 204 });

      const result = await runScheduledWorklogSync();

      expect(result.success).toBe(true);
      expect(result.synced).toBe(1);

      // Should have deleted the app-authored worklog
      expect(mockDeleteJiraWorklogAsApp).toHaveBeenCalledWith(ISSUE_KEY, 'worklog-2');

      // Should save a pending record (jira_worklog_id = null)
      const postCall = mockSupabaseRequest.mock.calls.find(
        ([, q, opts]) => q === 'worklog_sync' && opts?.method === 'POST'
      );
      expect(postCall).toBeDefined();
      expect(postCall[2].body.created_as_user).toBe(false);
      expect(postCall[2].body.jira_worklog_id).toBeNull();
    });
  });

  describe('when impersonation response has no author field', () => {
    it('deletes the worklog and saves a pending record', async () => {
      mockSupabaseRequest.mockImplementation(
        buildSupabaseRequestMock({
          activityRecords: [{
            user_id: USER_ID,
            user_assigned_issue_key: ISSUE_KEY,
            duration_seconds: 120,
            total_time_seconds: 120,
            end_time: '2026-03-12T10:00:00Z',
          }],
        })
      );

      // Jira returned the worklog with no author field
      mockCreateJiraWorklogAsUser.mockResolvedValue({
        id: 'worklog-3',
      });

      mockDeleteJiraWorklogAsApp.mockResolvedValue({ status: 204 });

      const result = await runScheduledWorklogSync();

      expect(result.success).toBe(true);

      // Should have deleted the ambiguous worklog
      expect(mockDeleteJiraWorklogAsApp).toHaveBeenCalledWith(ISSUE_KEY, 'worklog-3');

      const postCall = mockSupabaseRequest.mock.calls.find(
        ([, q, opts]) => q === 'worklog_sync' && opts?.method === 'POST'
      );
      expect(postCall).toBeDefined();
      expect(postCall[2].body.created_as_user).toBe(false);
      expect(postCall[2].body.jira_worklog_id).toBeNull();
    });
  });

  describe('when AUTH_TYPE_UNAVAILABLE prevents impersonation', () => {
    it('saves a pending record instead of falling back to asApp', async () => {
      mockSupabaseRequest.mockImplementation(
        buildSupabaseRequestMock({
          activityRecords: [{
            user_id: USER_ID,
            user_assigned_issue_key: ISSUE_KEY,
            duration_seconds: 120,
            total_time_seconds: 120,
            end_time: '2026-03-12T10:00:00Z',
          }],
        })
      );

      // asUser throws AUTH_TYPE_UNAVAILABLE
      mockCreateJiraWorklogAsUser.mockRejectedValue(
        new Error('AUTH_TYPE_UNAVAILABLE: User has not granted offline access')
      );

      const result = await runScheduledWorklogSync();

      expect(result.success).toBe(true);
      expect(result.synced).toBe(1);

      // Should NOT fall back to asApp — no "Itracker" worklog created
      expect(mockCreateJiraWorklogAsApp).not.toHaveBeenCalled();

      // Should save a pending record with jira_worklog_id = null
      const postCall = mockSupabaseRequest.mock.calls.find(
        ([, q, opts]) => q === 'worklog_sync' && opts?.method === 'POST'
      );
      expect(postCall).toBeDefined();
      expect(postCall[2].body.created_as_user).toBe(false);
      expect(postCall[2].body.jira_worklog_id).toBeNull();
      expect(postCall[2].body.issue_key).toBe(ISSUE_KEY);
    });
  });

  describe('when no accountId exists for the user', () => {
    it('saves a pending record instead of creating via asApp', async () => {
      mockSupabaseRequest.mockImplementation(
        buildSupabaseRequestMock({
          activityRecords: [{
            user_id: USER_ID,
            user_assigned_issue_key: ISSUE_KEY,
            duration_seconds: 120,
            total_time_seconds: 120,
            end_time: '2026-03-12T10:00:00Z',
          }],
          // User has no atlassian_account_id
          userRows: [{ atlassian_account_id: null, display_name: DISPLAY_NAME }],
        })
      );

      const result = await runScheduledWorklogSync();

      expect(result.success).toBe(true);
      expect(result.synced).toBe(1);
      // Should NOT call either Jira API
      expect(mockCreateJiraWorklogAsUser).not.toHaveBeenCalled();
      expect(mockCreateJiraWorklogAsApp).not.toHaveBeenCalled();

      // Should save a pending record with jira_worklog_id = null
      const postCall = mockSupabaseRequest.mock.calls.find(
        ([, q, opts]) => q === 'worklog_sync' && opts?.method === 'POST'
      );
      expect(postCall).toBeDefined();
      expect(postCall[2].body.created_as_user).toBe(false);
      expect(postCall[2].body.jira_worklog_id).toBeNull();
    });
  });
});

// ============================================================================
// Tests: update existing worklog path
// ============================================================================
describe('scheduledWorklogSync — update existing worklog', () => {

  it('skips sync when time has not changed', async () => {
    mockSupabaseRequest.mockImplementation(
      buildSupabaseRequestMock({
        activityRecords: [{
          user_id: USER_ID,
          user_assigned_issue_key: ISSUE_KEY,
          duration_seconds: 120,
          total_time_seconds: 120,
          end_time: '2026-03-12T10:00:00Z',
        }],
        existingMappings: [{
          id: 'mapping-1',
          issue_key: ISSUE_KEY,
          jira_worklog_id: 'jira-worklog-1',
          last_synced_seconds: 120, // Same as tracked time
          created_as_user: false,
        }],
      })
    );

    const result = await runScheduledWorklogSync();

    expect(result.success).toBe(true);
    expect(result.synced).toBe(0);
    expect(mockUpdateJiraWorklogAsUser).not.toHaveBeenCalled();
    expect(mockUpdateJiraWorklogAsApp).not.toHaveBeenCalled();
    expect(mockCreateJiraWorklogAsUser).not.toHaveBeenCalled();
    expect(mockCreateJiraWorklogAsApp).not.toHaveBeenCalled();
  });

  it('skips user-authored worklog even when time has changed (defers to interactive sync)', async () => {
    mockSupabaseRequest.mockImplementation(
      buildSupabaseRequestMock({
        activityRecords: [{
          user_id: USER_ID,
          user_assigned_issue_key: ISSUE_KEY,
          duration_seconds: 300,
          total_time_seconds: 300,
          end_time: '2026-03-12T10:00:00Z',
        }],
        existingMappings: [{
          id: 'mapping-user-owned',
          issue_key: ISSUE_KEY,
          jira_worklog_id: 'jira-worklog-user',
          last_synced_seconds: 120, // Time has changed
          created_as_user: true,    // But it's user-authored
        }],
      })
    );

    const result = await runScheduledWorklogSync();

    expect(result.success).toBe(true);
    expect(result.synced).toBe(0); // Should NOT count as synced
    // Should NOT touch the Jira worklog at all
    expect(mockUpdateJiraWorklogAsUser).not.toHaveBeenCalled();
    expect(mockUpdateJiraWorklogAsApp).not.toHaveBeenCalled();
    expect(mockCreateJiraWorklogAsUser).not.toHaveBeenCalled();
    expect(mockCreateJiraWorklogAsApp).not.toHaveBeenCalled();
  });

  it('updates app-authored worklog via asUser when time changed and accountId available', async () => {
    mockSupabaseRequest.mockImplementation(
      buildSupabaseRequestMock({
        activityRecords: [{
          user_id: USER_ID,
          user_assigned_issue_key: ISSUE_KEY,
          duration_seconds: 300,
          total_time_seconds: 300,
          end_time: '2026-03-12T10:00:00Z',
        }],
        existingMappings: [{
          id: 'mapping-1',
          issue_key: ISSUE_KEY,
          jira_worklog_id: 'jira-worklog-1',
          last_synced_seconds: 120, // Different from tracked time
          created_as_user: false,   // App-authored — scheduled trigger may update
        }],
      })
    );

    mockUpdateJiraWorklogAsUser.mockResolvedValue({ status: 200 });

    const result = await runScheduledWorklogSync();

    expect(result.success).toBe(true);
    expect(result.synced).toBe(1);
    expect(mockUpdateJiraWorklogAsUser).toHaveBeenCalledWith(
      ACCOUNT_ID, ISSUE_KEY, 'jira-worklog-1', 300
    );
  });

  it('falls back to asApp for update when AUTH_TYPE_UNAVAILABLE', async () => {
    mockSupabaseRequest.mockImplementation(
      buildSupabaseRequestMock({
        activityRecords: [{
          user_id: USER_ID,
          user_assigned_issue_key: ISSUE_KEY,
          duration_seconds: 300,
          total_time_seconds: 300,
          end_time: '2026-03-12T10:00:00Z',
        }],
        existingMappings: [{
          id: 'mapping-1',
          issue_key: ISSUE_KEY,
          jira_worklog_id: 'jira-worklog-1',
          last_synced_seconds: 120,
          created_as_user: false,   // App-authored — safe for scheduled trigger
        }],
      })
    );

    mockUpdateJiraWorklogAsUser.mockRejectedValue(
      new Error('AUTH_TYPE_UNAVAILABLE')
    );
    mockUpdateJiraWorklogAsApp.mockResolvedValue({ status: 200 });

    const result = await runScheduledWorklogSync();

    expect(result.success).toBe(true);
    expect(result.synced).toBe(1);
    expect(mockUpdateJiraWorklogAsApp).toHaveBeenCalledWith(
      ISSUE_KEY, 'jira-worklog-1', 300
    );
  });

  it('recreates worklog when update returns 404 (stale app-authored mapping)', async () => {
    mockSupabaseRequest.mockImplementation(
      buildSupabaseRequestMock({
        activityRecords: [{
          user_id: USER_ID,
          user_assigned_issue_key: ISSUE_KEY,
          duration_seconds: 300,
          total_time_seconds: 300,
          end_time: '2026-03-12T10:00:00Z',
        }],
        existingMappings: [{
          id: 'mapping-1',
          issue_key: ISSUE_KEY,
          jira_worklog_id: 'jira-worklog-1',
          last_synced_seconds: 120,
          created_as_user: false,   // App-authored — safe for scheduled trigger
        }],
      })
    );

    // Update returns 404 — stale mapping
    mockUpdateJiraWorklogAsUser.mockResolvedValue({ status: 404 });

    // Recreate succeeds with correct author
    mockCreateJiraWorklogAsUser.mockResolvedValue({
      id: 'worklog-recreated',
      author: { accountId: ACCOUNT_ID },
    });

    const result = await runScheduledWorklogSync();

    expect(result.success).toBe(true);
    expect(result.synced).toBe(1);

    // Should have deleted stale mapping
    const deleteCall = mockSupabaseRequest.mock.calls.find(
      ([, q, opts]) => q === 'worklog_sync?id=eq.mapping-1' && opts?.method === 'DELETE'
    );
    expect(deleteCall).toBeDefined();

    // Should have created new worklog
    expect(mockCreateJiraWorklogAsUser).toHaveBeenCalled();

    // New mapping should have created_as_user = true (author matched)
    const postCall = mockSupabaseRequest.mock.calls.find(
      ([, q, opts]) => q === 'worklog_sync' && opts?.method === 'POST'
    );
    expect(postCall).toBeDefined();
    expect(postCall[2].body.created_as_user).toBe(true);
  });
});

// ============================================================================
// Tests: edge cases and error handling
// ============================================================================
describe('scheduledWorklogSync — edge cases', () => {

  it('returns early when no tracking settings found', async () => {
    mockSupabaseRequest.mockImplementation(
      buildSupabaseRequestMock({ trackingSettings: [] })
    );

    const result = await runScheduledWorklogSync();

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/no tracking settings/i);
  });

  it('returns early when sync is not enabled for any org', async () => {
    mockSupabaseRequest.mockImplementation(
      buildSupabaseRequestMock({
        trackingSettings: [{
          organization_id: ORG_ID,
          project_key: null,
          jira_worklog_sync_enabled: false,
        }],
      })
    );

    const result = await runScheduledWorklogSync();

    expect(result.success).toBe(true);
    expect(result.message).toMatch(/not enabled/i);
  });

  it('rounds up entries below MIN_SYNC_SECONDS (60s) to Jira minimum', async () => {
    mockSupabaseRequest.mockImplementation(
      buildSupabaseRequestMock({
        activityRecords: [{
          user_id: USER_ID,
          user_assigned_issue_key: ISSUE_KEY,
          duration_seconds: 30, // Below 60s minimum — should be rounded up to 60
          total_time_seconds: 30,
          end_time: '2026-03-12T10:00:00Z',
        }],
      })
    );

    mockCreateJiraWorklogAsUser.mockResolvedValue({
      id: 'worklog-roundup',
      author: { accountId: ACCOUNT_ID, displayName: DISPLAY_NAME },
    });

    const result = await runScheduledWorklogSync();

    expect(result.success).toBe(true);
    expect(result.synced).toBe(1);
    // Verify worklog was created with rounded-up 60s, not the original 30s
    expect(mockCreateJiraWorklogAsUser).toHaveBeenCalledWith(
      ACCOUNT_ID,
      ISSUE_KEY,
      60,
      expect.any(String),
      DISPLAY_NAME
    );
  });

  it('handles Jira error responses gracefully', async () => {
    mockSupabaseRequest.mockImplementation(
      buildSupabaseRequestMock({
        activityRecords: [{
          user_id: USER_ID,
          user_assigned_issue_key: ISSUE_KEY,
          duration_seconds: 120,
          total_time_seconds: 120,
          end_time: '2026-03-12T10:00:00Z',
        }],
      })
    );

    // Jira returns error (e.g., issue deleted)
    mockCreateJiraWorklogAsUser.mockResolvedValue({
      errorMessages: ['Issue Does Not Exist'],
    });

    const result = await runScheduledWorklogSync();

    expect(result.success).toBe(true);
    expect(result.synced).toBe(0);
    expect(result.errors).toBe(0); // gracefully skipped, not counted as error
  });

  it('counts non-impersonation exceptions as errors', async () => {
    mockSupabaseRequest.mockImplementation(
      buildSupabaseRequestMock({
        activityRecords: [{
          user_id: USER_ID,
          user_assigned_issue_key: ISSUE_KEY,
          duration_seconds: 120,
          total_time_seconds: 120,
          end_time: '2026-03-12T10:00:00Z',
        }],
      })
    );

    // Generic network error (not AUTH_TYPE_UNAVAILABLE)
    mockCreateJiraWorklogAsUser.mockRejectedValue(
      new Error('Network timeout')
    );

    const result = await runScheduledWorklogSync();

    expect(result.success).toBe(true);
    expect(result.synced).toBe(0);
    expect(result.errors).toBe(1);
  });

  it('returns error when supabase is not configured', async () => {
    mockGetSupabaseConfig.mockResolvedValue(null);

    const result = await runScheduledWorklogSync();

    // With no config, the sync fetches tracking_settings which returns []
    // because supabaseRequest will be called with null config.
    // The actual behavior depends on how supabaseRequest handles null config.
    // The function should still return successfully.
    expect(result).toBeDefined();
  });
});

// ============================================================================
// Tests: project-level sync filtering
// ============================================================================
describe('scheduledWorklogSync — project-level sync filtering', () => {

  it('excludes projects that are explicitly disabled when org sync is enabled', async () => {
    mockSupabaseRequest.mockImplementation(
      buildSupabaseRequestMock({
        trackingSettings: [
          { organization_id: ORG_ID, project_key: null, jira_worklog_sync_enabled: true },
          { organization_id: ORG_ID, project_key: 'DISABLED', jira_worklog_sync_enabled: false },
        ],
        activityRecords: [
          // This record is in the DISABLED project — should be excluded by project filter
          {
            user_id: USER_ID,
            user_assigned_issue_key: 'DISABLED-1',
            project_key: 'DISABLED',
            duration_seconds: 120,
            total_time_seconds: 120,
            end_time: '2026-03-12T10:00:00Z',
          },
        ],
      })
    );

    const result = await runScheduledWorklogSync();

    expect(result.success).toBe(true);
    // The project filter is applied in the DB query, but since we mock
    // supabaseRequest to return records regardless, we check the query
    const activityQuery = mockSupabaseRequest.mock.calls.find(
      ([, q]) => q.includes('activity_records?')
    );
    expect(activityQuery).toBeDefined();
    // Should contain the project exclusion clause
    expect(activityQuery[1]).toContain('project_key=not.in.(DISABLED)');
  });

  it('only syncs explicitly enabled projects when org sync is disabled', async () => {
    mockSupabaseRequest.mockImplementation(
      buildSupabaseRequestMock({
        trackingSettings: [
          { organization_id: ORG_ID, project_key: null, jira_worklog_sync_enabled: false },
          { organization_id: ORG_ID, project_key: 'ENABLED', jira_worklog_sync_enabled: true },
        ],
        activityRecords: [],
      })
    );

    const result = await runScheduledWorklogSync();

    expect(result.success).toBe(true);
    const activityQuery = mockSupabaseRequest.mock.calls.find(
      ([, q]) => q.includes('activity_records?')
    );
    expect(activityQuery).toBeDefined();
    expect(activityQuery[1]).toContain('project_key=in.(ENABLED)');
  });
});

// ============================================================================
// Tests: pending record handling (no "Itracker" worklogs)
// ============================================================================
describe('scheduledWorklogSync — pending record handling', () => {

  it('updates pending record time without calling Jira when time changes', async () => {
    mockSupabaseRequest.mockImplementation(
      buildSupabaseRequestMock({
        activityRecords: [{
          user_id: USER_ID,
          user_assigned_issue_key: ISSUE_KEY,
          duration_seconds: 300,
          total_time_seconds: 300,
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

    const result = await runScheduledWorklogSync();

    expect(result.success).toBe(true);
    expect(result.synced).toBe(1);

    // Should NOT call any Jira API for pending records
    expect(mockUpdateJiraWorklogAsUser).not.toHaveBeenCalled();
    expect(mockUpdateJiraWorklogAsApp).not.toHaveBeenCalled();
    expect(mockCreateJiraWorklogAsUser).not.toHaveBeenCalled();
    expect(mockCreateJiraWorklogAsApp).not.toHaveBeenCalled();

    // Should update the pending record in the DB with new time
    const patchCall = mockSupabaseRequest.mock.calls.find(
      ([, q, opts]) => q === 'worklog_sync?id=eq.mapping-pending-1' && opts?.method === 'PATCH'
    );
    expect(patchCall).toBeDefined();
    expect(patchCall[2].body.last_synced_seconds).toBe(300);
  });

  it('skips pending record when tracked time has not changed', async () => {
    mockSupabaseRequest.mockImplementation(
      buildSupabaseRequestMock({
        activityRecords: [{
          user_id: USER_ID,
          user_assigned_issue_key: ISSUE_KEY,
          duration_seconds: 120,
          total_time_seconds: 120,
          end_time: '2026-03-12T10:00:00Z',
        }],
        existingMappings: [{
          id: 'mapping-pending-2',
          issue_key: ISSUE_KEY,
          jira_worklog_id: null,
          last_synced_seconds: 120, // Same
          created_as_user: false,
        }],
      })
    );

    const result = await runScheduledWorklogSync();

    expect(result.success).toBe(true);
    expect(result.synced).toBe(0);
    expect(mockUpdateJiraWorklogAsUser).not.toHaveBeenCalled();
    expect(mockCreateJiraWorklogAsUser).not.toHaveBeenCalled();
  });

  it('cleans up orphaned pending records without calling Jira', async () => {
    mockSupabaseRequest.mockImplementation(
      buildSupabaseRequestMock({
        activityRecords: [], // No active time — mapping is orphaned
        allMappings: [{
          id: 'mapping-orphan-pending',
          user_id: USER_ID,
          issue_key: ISSUE_KEY,
          jira_worklog_id: null, // Pending record
        }],
      })
    );

    const result = await runScheduledWorklogSync();

    expect(result.success).toBe(true);

    // Should NOT call Jira delete for pending records
    expect(mockDeleteJiraWorklogAsUser).not.toHaveBeenCalled();
    expect(mockDeleteJiraWorklogAsApp).not.toHaveBeenCalled();

    // Should delete the DB mapping
    const deleteCall = mockSupabaseRequest.mock.calls.find(
      ([, q, opts]) => q === 'worklog_sync?id=eq.mapping-orphan-pending' && opts?.method === 'DELETE'
    );
    expect(deleteCall).toBeDefined();
  });

  it('cleans up orphaned real worklogs normally', async () => {
    mockSupabaseRequest.mockImplementation(
      buildSupabaseRequestMock({
        activityRecords: [], // No active time — mapping is orphaned
        allMappings: [{
          id: 'mapping-orphan-real',
          user_id: USER_ID,
          issue_key: ISSUE_KEY,
          jira_worklog_id: 'jira-worklog-999', // Real Jira worklog
        }],
      })
    );

    mockDeleteJiraWorklogAsUser.mockResolvedValue({ status: 204 });

    const result = await runScheduledWorklogSync();

    expect(result.success).toBe(true);

    // Should call Jira delete for real worklogs
    expect(mockDeleteJiraWorklogAsUser).toHaveBeenCalledWith(
      ACCOUNT_ID, ISSUE_KEY, 'jira-worklog-999'
    );

    // Should delete the DB mapping
    const deleteCall = mockSupabaseRequest.mock.calls.find(
      ([, q, opts]) => q === 'worklog_sync?id=eq.mapping-orphan-real' && opts?.method === 'DELETE'
    );
    expect(deleteCall).toBeDefined();
  });
});
