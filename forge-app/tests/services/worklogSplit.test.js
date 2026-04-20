'use strict';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockCreateJiraWorklog = jest.fn();
const mockDeleteJiraWorklog = jest.fn();
const mockUpdateJiraWorklog = jest.fn();

jest.mock('../../src/utils/jira.js', () => ({
  createJiraWorklog: mockCreateJiraWorklog,
  deleteJiraWorklog: mockDeleteJiraWorklog,
  updateJiraWorklog: mockUpdateJiraWorklog,
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

jest.mock('../../src/utils/validators.js', () => ({
  isValidIssueKey: jest.fn((val) => typeof val === 'string' && /^[A-Z]+-\d+$/.test(val)),
}));

// ---------------------------------------------------------------------------
// Import the module under test
// ---------------------------------------------------------------------------
const { splitWorklog } = require('../../src/services/worklogReassignmentService.js');

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const SUPABASE_CONFIG = { url: 'remote:ai-server', isRemoteMode: true };
const ORG = { id: 'org-uuid-1' };
const USER_ID = 'user-uuid-1';
const ACCOUNT_ID = 'atlassian-account-123';
const CLOUD_ID = 'cloud-id-1';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function setupDefaultMocks() {
  mockGetSupabaseConfig.mockResolvedValue(SUPABASE_CONFIG);
  mockGetOrCreateOrganization.mockResolvedValue(ORG);
  mockGetOrCreateUser.mockResolvedValue(USER_ID);
}

function buildSyncRecord(overrides = {}) {
  return {
    id: 'sync-uuid-1',
    jira_worklog_id: 'jira-wl-100',
    last_synced_seconds: 1080, // 18 minutes
    started_at: '2026-03-26T09:00:00.000Z',
    issue_key: 'PROJ-2',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('splitWorklog', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaultMocks();
  });

  describe('partial split - happy path', () => {
    it('splits 600s (10m) from 1080s (18m) worklog', async () => {
      const syncRecord = buildSyncRecord();

      mockSupabaseRequest.mockImplementation((config, endpoint, options) => {
        // Fetch sync record for source
        if (endpoint.includes('issue_key=eq.PROJ-2') && (!options?.method || options?.method === 'GET')) {
          return Promise.resolve([syncRecord]);
        }
        // Check target has no worklog
        if (endpoint.includes('issue_key=eq.PROJ-1') && (!options?.method || options?.method === 'GET')) {
          return Promise.resolve([]);
        }
        // Activity records query
        if (endpoint.includes('activity_records') && endpoint.includes('select=id') && !options?.method) {
          return Promise.resolve([
            { id: 'ar-1', duration_seconds: 300, total_time_seconds: 300 },
            { id: 'ar-2', duration_seconds: 300, total_time_seconds: 300 },
            { id: 'ar-3', duration_seconds: 480, total_time_seconds: 480 },
          ]);
        }
        // PATCH / POST operations
        if (options?.method === 'PATCH' || options?.method === 'POST') {
          return Promise.resolve({});
        }
        return Promise.resolve([]);
      });

      // Jira PUT (reduce source): 200 OK
      mockUpdateJiraWorklog.mockResolvedValue({ status: 200 });

      // Jira POST (create target)
      mockCreateJiraWorklog.mockResolvedValue({ id: 'jira-wl-200' });

      const result = await splitWorklog(ACCOUNT_ID, CLOUD_ID, 'PROJ-2', 'PROJ-1', 600);

      expect(result.success).toBe(true);
      expect(result.fromIssueKey).toBe('PROJ-2');
      expect(result.toIssueKey).toBe('PROJ-1');
      expect(result.splitSeconds).toBe(600);
      expect(result.remainingSeconds).toBe(480);
      expect(result.newWorklogId).toBe('jira-wl-200');

      // Verify Jira PUT called with remaining seconds
      expect(mockUpdateJiraWorklog).toHaveBeenCalledWith('PROJ-2', 'jira-wl-100', 480);

      // Verify Jira POST called with split seconds
      expect(mockCreateJiraWorklog).toHaveBeenCalledWith('PROJ-1', 600, '2026-03-26T09:00:00.000+0000');

      // DELETE should NOT be called (partial split uses PUT)
      expect(mockDeleteJiraWorklog).not.toHaveBeenCalled();

      // Verify worklog_sync PATCH (reduce source)
      const patchCalls = mockSupabaseRequest.mock.calls.filter(
        c => c[2]?.method === 'PATCH' && c[1].includes('worklog_sync')
      );
      expect(patchCalls.length).toBe(1);
      expect(patchCalls[0][2].body.last_synced_seconds).toBe(480);

      // Verify worklog_sync POST (create target)
      const postCalls = mockSupabaseRequest.mock.calls.filter(
        c => c[2]?.method === 'POST' && c[1] === 'worklog_sync'
      );
      expect(postCalls.length).toBe(1);
      expect(postCalls[0][2].body.issue_key).toBe('PROJ-1');
      expect(postCalls[0][2].body.last_synced_seconds).toBe(600);
      expect(postCalls[0][2].body.reassigned_from).toBe('PROJ-2');
    });
  });

  describe('full move - delegates to reassignWorklog', () => {
    it('delegates to reassignWorklog when splitSeconds equals total', async () => {
      const syncRecord = buildSyncRecord({ last_synced_seconds: 1080 });

      mockSupabaseRequest.mockImplementation((config, endpoint, options) => {
        if (endpoint.includes('issue_key=eq.PROJ-2') && (!options?.method || options?.method === 'GET')) {
          return Promise.resolve([syncRecord]);
        }
        if (endpoint.includes('issue_key=eq.PROJ-1') && (!options?.method || options?.method === 'GET')) {
          return Promise.resolve([]);
        }
        if (options?.method === 'PATCH' || options?.method === 'POST') {
          return Promise.resolve({});
        }
        return Promise.resolve([]);
      });

      // Full move uses DELETE + CREATE (via reassignWorklog)
      mockDeleteJiraWorklog.mockResolvedValue({ ok: true, status: 204 });
      mockCreateJiraWorklog.mockResolvedValue({ id: 'jira-wl-200' });

      const result = await splitWorklog(ACCOUNT_ID, CLOUD_ID, 'PROJ-2', 'PROJ-1', 1080);

      expect(result.success).toBe(true);
      expect(result.splitSeconds).toBe(1080);
      expect(result.remainingSeconds).toBe(0);

      // Full move should use DELETE (from reassignWorklog), not PUT
      expect(mockDeleteJiraWorklog).toHaveBeenCalledWith('PROJ-2', 'jira-wl-100');
      expect(mockUpdateJiraWorklog).not.toHaveBeenCalled();
    });
  });

  describe('validation errors', () => {
    it('rejects same source and target', async () => {
      await expect(
        splitWorklog(ACCOUNT_ID, CLOUD_ID, 'PROJ-1', 'PROJ-1', 300)
      ).rejects.toThrow('Source and target issue must be different');
    });

    it('rejects invalid source issue key', async () => {
      await expect(
        splitWorklog(ACCOUNT_ID, CLOUD_ID, 'bad', 'PROJ-1', 300)
      ).rejects.toThrow('Invalid source issue key format');
    });

    it('rejects splitSeconds of 0', async () => {
      await expect(
        splitWorklog(ACCOUNT_ID, CLOUD_ID, 'PROJ-2', 'PROJ-1', 0)
      ).rejects.toThrow('splitSeconds must be a positive integer');
    });

    it('rejects negative splitSeconds', async () => {
      await expect(
        splitWorklog(ACCOUNT_ID, CLOUD_ID, 'PROJ-2', 'PROJ-1', -100)
      ).rejects.toThrow('splitSeconds must be a positive integer');
    });

    it('rejects non-integer splitSeconds', async () => {
      await expect(
        splitWorklog(ACCOUNT_ID, CLOUD_ID, 'PROJ-2', 'PROJ-1', 300.5)
      ).rejects.toThrow('splitSeconds must be a positive integer');
    });

    it('rejects splitSeconds exceeding total', async () => {
      mockSupabaseRequest.mockImplementation((config, endpoint, options) => {
        if (endpoint.includes('issue_key=eq.PROJ-2') && (!options?.method || options?.method === 'GET')) {
          return Promise.resolve([buildSyncRecord({ last_synced_seconds: 600 })]);
        }
        return Promise.resolve([]);
      });

      await expect(
        splitWorklog(ACCOUNT_ID, CLOUD_ID, 'PROJ-2', 'PROJ-1', 900)
      ).rejects.toThrow('splitSeconds (900) exceeds worklog total (600s)');
    });
  });

  describe('error handling', () => {
    it('throws when no sync record exists', async () => {
      mockSupabaseRequest.mockImplementation((config, endpoint, options) => {
        if (endpoint.includes('issue_key=eq.PROJ-2')) return Promise.resolve([]);
        return Promise.resolve([]);
      });

      await expect(
        splitWorklog(ACCOUNT_ID, CLOUD_ID, 'PROJ-2', 'PROJ-1', 300)
      ).rejects.toThrow('No activity records found to reassign from PROJ-2');
    });

    it('succeeds when worklog is pending (no jira_worklog_id)', async () => {
      mockSupabaseRequest.mockImplementation((config, endpoint, options) => {
        if (endpoint.includes('issue_key=eq.PROJ-2')) {
          return Promise.resolve([buildSyncRecord({ jira_worklog_id: null })]);
        }
        if (endpoint.includes('activity_records') && endpoint.includes('select=id') && (!options?.method || options?.method === 'GET')) {
          return Promise.resolve([
            { id: 'ar-1', duration_seconds: 300, total_time_seconds: 300 }
          ]);
        }
        if (options?.method === 'PATCH') {
          return Promise.resolve({});
        }
        return Promise.resolve([]);
      });

      const result = await splitWorklog(ACCOUNT_ID, CLOUD_ID, 'PROJ-2', 'PROJ-1', 300);
      expect(result.success).toBe(true);
      expect(result.newWorklogId).toBeNull();
    });

    it('allows split when target worklog is from a different date', async () => {
      mockSupabaseRequest.mockImplementation((config, endpoint, options) => {
        if (endpoint.includes('issue_key=eq.PROJ-2') && (!options?.method || options?.method === 'GET')) {
          return Promise.resolve([buildSyncRecord()]);
        }
        if (endpoint.includes('issue_key=eq.PROJ-1') && (!options?.method || options?.method === 'GET')) {
          return Promise.resolve([{ id: 'existing-sync' }]);
        }
        if (endpoint.includes('activity_records') && endpoint.includes('select=id') && (!options?.method || options?.method === 'GET')) {
          return Promise.resolve([
            { id: 'ar-1', duration_seconds: 300, total_time_seconds: 300 },
            { id: 'ar-2', duration_seconds: 300, total_time_seconds: 300 }
          ]);
        }
        if (options?.method === 'PATCH' || options?.method === 'DELETE' || options?.method === 'POST') {
          return Promise.resolve({});
        }
        return Promise.resolve([]);
      });

      mockUpdateJiraWorklog.mockResolvedValue({ status: 200 });
      mockCreateJiraWorklog.mockResolvedValue({ id: 'jira-wl-200' });

      const result = await splitWorklog(ACCOUNT_ID, CLOUD_ID, 'PROJ-2', 'PROJ-1', 300);
      expect(result.success).toBe(true);
    });
  });

  describe('rollback on Jira POST failure', () => {
    it('restores source worklog when target creation fails', async () => {
      mockSupabaseRequest.mockImplementation((config, endpoint, options) => {
        if (endpoint.includes('issue_key=eq.PROJ-2') && (!options?.method || options?.method === 'GET')) {
          return Promise.resolve([buildSyncRecord()]);
        }
        if (endpoint.includes('issue_key=eq.PROJ-1') && (!options?.method || options?.method === 'GET')) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      // PUT succeeds (source reduced)
      mockUpdateJiraWorklog.mockResolvedValue({ status: 200 });

      // POST fails (target creation)
      mockCreateJiraWorklog.mockRejectedValue(new Error('Jira API error'));

      await expect(
        splitWorklog(ACCOUNT_ID, CLOUD_ID, 'PROJ-2', 'PROJ-1', 600)
      ).rejects.toThrow('Jira API error');

      // Verify rollback: PUT called twice — first to reduce, then to restore
      expect(mockUpdateJiraWorklog).toHaveBeenCalledTimes(2);
      // First call: reduce to remaining (480)
      expect(mockUpdateJiraWorklog).toHaveBeenNthCalledWith(1, 'PROJ-2', 'jira-wl-100', 480);
      // Second call: rollback to original (1080)
      expect(mockUpdateJiraWorklog).toHaveBeenNthCalledWith(2, 'PROJ-2', 'jira-wl-100', 1080);
    });
  });

  describe('Jira PUT failure', () => {
    it('throws when source worklog update fails', async () => {
      mockSupabaseRequest.mockImplementation((config, endpoint, options) => {
        if (endpoint.includes('issue_key=eq.PROJ-2') && (!options?.method || options?.method === 'GET')) {
          return Promise.resolve([buildSyncRecord()]);
        }
        if (endpoint.includes('issue_key=eq.PROJ-1') && (!options?.method || options?.method === 'GET')) {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      // PUT fails
      mockUpdateJiraWorklog.mockResolvedValue({ status: 500 });

      await expect(
        splitWorklog(ACCOUNT_ID, CLOUD_ID, 'PROJ-2', 'PROJ-1', 600)
      ).rejects.toThrow('Failed to update worklog on PROJ-2: HTTP 500');

      // No Jira create should be attempted
      expect(mockCreateJiraWorklog).not.toHaveBeenCalled();
    });
  });

  describe('activity records reassignment', () => {
    it('moves proportional activity records to target issue', async () => {
      const syncRecord = buildSyncRecord();

      const patchedCalls = [];
      mockSupabaseRequest.mockImplementation((config, endpoint, options) => {
        if (endpoint.includes('worklog_sync') && endpoint.includes('issue_key=eq.PROJ-2') && (!options?.method || options?.method === 'GET')) {
          return Promise.resolve([syncRecord]);
        }
        if (endpoint.includes('worklog_sync') && endpoint.includes('issue_key=eq.PROJ-1') && (!options?.method || options?.method === 'GET')) {
          return Promise.resolve([]);
        }
        // Activity records SELECT query — return 3 records
        if (endpoint.includes('activity_records') && endpoint.includes('select=id') && (!options?.method || options?.method === 'GET')) {
          return Promise.resolve([
            { id: 'ar-1', duration_seconds: 300, total_time_seconds: 300 },
            { id: 'ar-2', duration_seconds: 300, total_time_seconds: 300 },
            { id: 'ar-3', duration_seconds: 480, total_time_seconds: 480 },
          ]);
        }
        if (options?.method === 'PATCH') {
          patchedCalls.push({ endpoint, body: options.body });
          return Promise.resolve({});
        }
        if (options?.method === 'POST') {
          return Promise.resolve({});
        }
        return Promise.resolve([]);
      });

      mockUpdateJiraWorklog.mockResolvedValue({ status: 200 });
      mockCreateJiraWorklog.mockResolvedValue({ id: 'jira-wl-200' });

      await splitWorklog(ACCOUNT_ID, CLOUD_ID, 'PROJ-2', 'PROJ-1', 600);

      // Find the PATCH call that updates activity_records with IN filter
      const activityPatch = patchedCalls.find(c => c.endpoint.includes('activity_records') && c.endpoint.includes('id=in.'));
      expect(activityPatch).toBeTruthy();
      // Should include ar-1 and ar-2 (300 + 300 = 600 >= 600 splitSeconds)
      expect(activityPatch.endpoint).toContain('ar-1');
      expect(activityPatch.endpoint).toContain('ar-2');
      // Verify the body sets the target issue
      expect(activityPatch.body.user_assigned_issue_key).toBe('PROJ-1');
      expect(activityPatch.body.reassigned_from).toBeUndefined();
    });
  });
});
