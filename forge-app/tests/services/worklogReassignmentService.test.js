'use strict';

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

const mockCreateJiraWorklog = jest.fn();
const mockDeleteJiraWorklog = jest.fn();

jest.mock('../../src/utils/jira.js', () => ({
  createJiraWorklog: mockCreateJiraWorklog,
  deleteJiraWorklog: mockDeleteJiraWorklog,
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
const { reassignWorklog } = require('../../src/services/worklogReassignmentService.js');

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
    last_synced_seconds: 3600,
    started_at: '2026-03-26T09:00:00.000Z',
    issue_key: 'PROJ-2',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe('worklogReassignmentService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    setupDefaultMocks();
  });

  describe('reassignWorklog - happy path', () => {
    it('successfully reassigns a worklog end-to-end', async () => {
      const syncRecord = buildSyncRecord();

      // Mock supabaseRequest responses
      mockSupabaseRequest.mockImplementation((config, endpoint, options) => {
        // Fetch sync record for source issue
        if (endpoint.includes('issue_key=eq.PROJ-2') && options?.method === 'GET') {
          return Promise.resolve([syncRecord]);
        }
        // Check target issue has no existing worklog
        if (endpoint.includes('issue_key=eq.PROJ-1') && options?.method === 'GET') {
          return Promise.resolve([]);
        }
        // PATCH operations
        if (options?.method === 'PATCH') {
          return Promise.resolve({});
        }
        return Promise.resolve([]);
      });

      // Mock Jira delete (204 No Content)
      mockDeleteJiraWorklog.mockResolvedValue({ ok: true, status: 204 });

      // Mock Jira create
      mockCreateJiraWorklog.mockResolvedValue({ id: 'jira-wl-200' });

      const result = await reassignWorklog(ACCOUNT_ID, CLOUD_ID, 'PROJ-2', 'PROJ-1');

      expect(result.success).toBe(true);
      expect(result.fromIssueKey).toBe('PROJ-2');
      expect(result.toIssueKey).toBe('PROJ-1');
      expect(result.timeSpentSeconds).toBe(3600);
      expect(result.oldWorklogId).toBe('jira-wl-100');
      expect(result.newWorklogId).toBe('jira-wl-200');

      // Verify Jira calls
      expect(mockDeleteJiraWorklog).toHaveBeenCalledWith('PROJ-2', 'jira-wl-100');
      expect(mockCreateJiraWorklog).toHaveBeenCalledWith('PROJ-1', 3600, '2026-03-26T09:00:00.000Z');

      // Verify worklog_sync PATCH
      const patchCalls = mockSupabaseRequest.mock.calls.filter(
        c => c[2]?.method === 'PATCH'
      );
      expect(patchCalls.length).toBeGreaterThanOrEqual(2); // worklog_sync + activity_records
    });
  });

  describe('reassignWorklog - validation errors', () => {
    it('rejects same source and target issue', async () => {
      await expect(
        reassignWorklog(ACCOUNT_ID, CLOUD_ID, 'PROJ-1', 'PROJ-1')
      ).rejects.toThrow('Source and target issue must be different');
    });

    it('rejects invalid source issue key format', async () => {
      await expect(
        reassignWorklog(ACCOUNT_ID, CLOUD_ID, 'invalid', 'PROJ-1')
      ).rejects.toThrow('Invalid source issue key format');
    });

    it('rejects invalid target issue key format', async () => {
      await expect(
        reassignWorklog(ACCOUNT_ID, CLOUD_ID, 'PROJ-1', 'bad-format')
      ).rejects.toThrow('Invalid target issue key format');
    });
  });

  describe('reassignWorklog - no sync record', () => {
    it('throws when no synced worklog exists for source issue', async () => {
      mockSupabaseRequest.mockImplementation((config, endpoint, options) => {
        if (endpoint.includes('issue_key=eq.PROJ-2') && options?.method === 'GET') {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      await expect(
        reassignWorklog(ACCOUNT_ID, CLOUD_ID, 'PROJ-2', 'PROJ-1')
      ).rejects.toThrow('No synced worklog found for issue PROJ-2');
    });
  });

  describe('reassignWorklog - pending worklog', () => {
    it('throws when worklog has no jira_worklog_id', async () => {
      mockSupabaseRequest.mockImplementation((config, endpoint, options) => {
        if (endpoint.includes('issue_key=eq.PROJ-2') && options?.method === 'GET') {
          return Promise.resolve([buildSyncRecord({ jira_worklog_id: null })]);
        }
        if (endpoint.includes('issue_key=eq.PROJ-1') && options?.method === 'GET') {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      await expect(
        reassignWorklog(ACCOUNT_ID, CLOUD_ID, 'PROJ-2', 'PROJ-1')
      ).rejects.toThrow('Worklog has not been synced to Jira yet');
    });
  });

  describe('reassignWorklog - duplicate target detection', () => {
    it('throws when target issue already has a worklog', async () => {
      mockSupabaseRequest.mockImplementation((config, endpoint, options) => {
        if (endpoint.includes('issue_key=eq.PROJ-2') && options?.method === 'GET') {
          return Promise.resolve([buildSyncRecord()]);
        }
        if (endpoint.includes('issue_key=eq.PROJ-1') && options?.method === 'GET') {
          return Promise.resolve([{ id: 'existing-sync' }]);
        }
        return Promise.resolve([]);
      });

      await expect(
        reassignWorklog(ACCOUNT_ID, CLOUD_ID, 'PROJ-2', 'PROJ-1')
      ).rejects.toThrow('A worklog already exists for issue PROJ-1');
    });
  });

  describe('reassignWorklog - rollback on Jira create failure', () => {
    it('attempts rollback when creating worklog on new issue fails', async () => {
      mockSupabaseRequest.mockImplementation((config, endpoint, options) => {
        if (endpoint.includes('issue_key=eq.PROJ-2') && options?.method === 'GET') {
          return Promise.resolve([buildSyncRecord()]);
        }
        if (endpoint.includes('issue_key=eq.PROJ-1') && options?.method === 'GET') {
          return Promise.resolve([]);
        }
        return Promise.resolve([]);
      });

      // Delete succeeds
      mockDeleteJiraWorklog.mockResolvedValue({ ok: true, status: 204 });

      // Create fails
      mockCreateJiraWorklog
        .mockRejectedValueOnce(new Error('Jira create error'))
        .mockResolvedValueOnce({ id: 'rollback-wl' }); // rollback create

      await expect(
        reassignWorklog(ACCOUNT_ID, CLOUD_ID, 'PROJ-2', 'PROJ-1')
      ).rejects.toThrow('Jira create error');

      // Verify rollback was attempted (create called twice: once for target, once for rollback)
      expect(mockCreateJiraWorklog).toHaveBeenCalledTimes(2);
      expect(mockCreateJiraWorklog).toHaveBeenLastCalledWith('PROJ-2', 3600, '2026-03-26T09:00:00.000Z');
    });
  });

  describe('reassignWorklog - idempotent delete (404)', () => {
    it('succeeds when Jira delete returns 404', async () => {
      mockSupabaseRequest.mockImplementation((config, endpoint, options) => {
        if (endpoint.includes('issue_key=eq.PROJ-2') && options?.method === 'GET') {
          return Promise.resolve([buildSyncRecord()]);
        }
        if (endpoint.includes('issue_key=eq.PROJ-1') && options?.method === 'GET') {
          return Promise.resolve([]);
        }
        if (options?.method === 'PATCH') {
          return Promise.resolve({});
        }
        return Promise.resolve([]);
      });

      // Delete returns 404 (worklog already gone - acceptable)
      mockDeleteJiraWorklog.mockResolvedValue({ ok: false, status: 404 });
      mockCreateJiraWorklog.mockResolvedValue({ id: 'jira-wl-new' });

      const result = await reassignWorklog(ACCOUNT_ID, CLOUD_ID, 'PROJ-2', 'PROJ-1');

      expect(result.success).toBe(true);
      expect(result.newWorklogId).toBe('jira-wl-new');
    });
  });

  describe('reassignWorklog - analysis_results update failure is non-critical', () => {
    it('succeeds even if legacy analysis_results update fails', async () => {
      let patchCount = 0;
      mockSupabaseRequest.mockImplementation((config, endpoint, options) => {
        if (endpoint.includes('issue_key=eq.PROJ-2') && options?.method === 'GET') {
          return Promise.resolve([buildSyncRecord()]);
        }
        if (endpoint.includes('issue_key=eq.PROJ-1') && options?.method === 'GET') {
          return Promise.resolve([]);
        }
        if (options?.method === 'PATCH') {
          patchCount++;
          // Third PATCH is analysis_results — make it fail
          if (patchCount === 3) {
            return Promise.reject(new Error('analysis_results table error'));
          }
          return Promise.resolve({});
        }
        return Promise.resolve([]);
      });

      mockDeleteJiraWorklog.mockResolvedValue({ ok: true, status: 204 });
      mockCreateJiraWorklog.mockResolvedValue({ id: 'jira-wl-300' });

      const result = await reassignWorklog(ACCOUNT_ID, CLOUD_ID, 'PROJ-2', 'PROJ-1');

      // Should still succeed despite analysis_results failure
      expect(result.success).toBe(true);
    });
  });
});
