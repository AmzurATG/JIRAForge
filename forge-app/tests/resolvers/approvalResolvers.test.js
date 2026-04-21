'use strict';

// ---------------------------------------------------------------------------
// Module mocks — set up BEFORE requiring the resolvers under test.
// ---------------------------------------------------------------------------

const mockSupabaseRequest = jest.fn();
const mockGetSupabaseConfig = jest.fn();
const mockGetOrCreateOrganization = jest.fn();
const mockGetOrCreateUser = jest.fn();

jest.mock('../../src/utils/supabase.js', () => ({
  supabaseRequest: mockSupabaseRequest,
  getSupabaseConfig: mockGetSupabaseConfig,
  getOrCreateOrganization: mockGetOrCreateOrganization,
  getOrCreateUser: mockGetOrCreateUser,
}));

const mockGetIssueTransitions = jest.fn();
const mockTransitionIssue = jest.fn();
jest.mock('../../src/utils/jira.js', () => ({
  getIssueTransitions: mockGetIssueTransitions,
  transitionIssue: mockTransitionIssue,
}));

const mockRequestJira = jest.fn();
jest.mock('@forge/api', () => {
  const api = { asUser: () => ({ requestJira: mockRequestJira }) };
  api.route = (strings, ...values) =>
    strings.reduce((acc, s, i) => acc + s + (values[i] || ''), '');
  return { __esModule: true, default: api, route: api.route };
});

jest.mock('../../src/utils/formatters.js', () => ({
  formatDuration: (seconds) => `${Math.floor(seconds / 60)}m`,
  formatJiraDate: (d) => (d || new Date()).toISOString(),
}));

jest.mock('../../src/utils/validators.js', () => ({
  isValidIssueKey: (v) => typeof v === 'string' && /^[A-Z]+-\d+$/.test(v),
  isValidProjectKey: (v) => typeof v === 'string' && /^[A-Z][A-Z0-9]+$/.test(v),
  isValidDate: (v) => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v),
  isValidUUID: (v) => typeof v === 'string' && v.length > 0,
  sanitizeUUIDArray: (arr) =>
    Array.isArray(arr) ? arr.filter((x) => typeof x === 'string' && x.length > 0) : [],
  toSafeInteger: (value, dflt, min, max) => {
    const n = Number.isFinite(value) ? value : dflt;
    return Math.max(min, Math.min(max, n));
  },
}));

// ---------------------------------------------------------------------------
// Import resolvers after mocks
// ---------------------------------------------------------------------------
const {
  approveRecords,
  reassignAndApproveRecords,
  createIssueAndApproveRecords,
} = require('../../src/resolvers/approval/approvalResolvers.js');

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const USER_ID = 'user-uuid-1';
const ORG_ID = 'org-uuid-1';
const ACCOUNT_ID = 'account-1';
const CLOUD_ID = 'cloud-1';
const SUPABASE_CFG = { url: 'https://t.supabase.co', key: 'k' };

function makeReq(payload = {}) {
  return {
    payload,
    context: { accountId: ACCOUNT_ID, cloudId: CLOUD_ID },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSupabaseConfig.mockResolvedValue(SUPABASE_CFG);
  mockGetOrCreateOrganization.mockResolvedValue({ id: ORG_ID });
  mockGetOrCreateUser.mockResolvedValue(USER_ID);
});

// ===========================================================================
// approveRecords
// ===========================================================================
describe('approveRecords', () => {
  it('rejects an empty / invalid session list', async () => {
    const result = await approveRecords(makeReq({ sessionIds: [] }));
    expect(result).toEqual({ success: false, error: 'No valid session IDs provided' });
    expect(mockSupabaseRequest).not.toHaveBeenCalled();
  });

  it('PATCHes with approval_status=pending_approval WHERE guard (idempotent)', async () => {
    mockSupabaseRequest.mockResolvedValue([{ id: 'rec-1' }, { id: 'rec-2' }]);

    const result = await approveRecords(makeReq({ sessionIds: ['rec-1', 'rec-2'] }));

    expect(result.success).toBe(true);
    expect(result.updated).toBe(2);

    const [, endpoint, options] = mockSupabaseRequest.mock.calls[0];
    expect(endpoint).toContain('id=in.(rec-1,rec-2)');
    expect(endpoint).toContain(`user_id=eq.${USER_ID}`);
    // race-safe: only touches rows still in pending_approval
    expect(endpoint).toContain('approval_status=eq.pending_approval');
    expect(options.method).toBe('PATCH');
    expect(options.body.approval_status).toBe('approved');
    expect(options.body.approved_by).toBe(USER_ID);
    expect(options.body.approved_at).toBeDefined();
  });

  it('returns updated=0 when another tab beat us to the approval (empty result)', async () => {
    mockSupabaseRequest.mockResolvedValue([]);
    const result = await approveRecords(makeReq({ sessionIds: ['rec-1'] }));
    expect(result).toEqual(expect.objectContaining({ success: true, updated: 0 }));
  });
});

// ===========================================================================
// reassignAndApproveRecords
// ===========================================================================
describe('reassignAndApproveRecords', () => {
  it('rejects when newIssueKey is missing or malformed', async () => {
    const r1 = await reassignAndApproveRecords(makeReq({ sessionIds: ['rec-1'] }));
    expect(r1.success).toBe(false);

    const r2 = await reassignAndApproveRecords(makeReq({ sessionIds: ['rec-1'], newIssueKey: 'not a key' }));
    expect(r2.success).toBe(false);
  });

  it('patches with new issue key, project key, reassigned_from, and approval fields', async () => {
    mockSupabaseRequest.mockImplementation((cfg, endpoint, options) => {
      if (!options) {
        // First call: SELECT existing rows for reassigned_from snapshot
        return Promise.resolve([
          { id: 'rec-1', user_assigned_issue_key: 'OLD-1' },
          { id: 'rec-2', user_assigned_issue_key: 'OLD-1' },
        ]);
      }
      // Second call: PATCH
      return Promise.resolve([{ id: 'rec-1' }, { id: 'rec-2' }]);
    });

    const result = await reassignAndApproveRecords(
      makeReq({ sessionIds: ['rec-1', 'rec-2'], newIssueKey: 'NEW-42', reason: 'Wrong issue' })
    );

    expect(result.success).toBe(true);
    expect(result.updated).toBe(2);
    expect(result.new_issue_key).toBe('NEW-42');

    const patchCall = mockSupabaseRequest.mock.calls.find(([, , opts]) => opts?.method === 'PATCH');
    expect(patchCall).toBeDefined();
    const body = patchCall[2].body;
    expect(body.user_assigned_issue_key).toBe('NEW-42');
    expect(body.project_key).toBe('NEW');
    expect(body.reassigned_from).toBe('OLD-1');
    expect(body.approval_status).toBe('approved');
    expect(body.approval_notes).toBe('Wrong issue');
  });

  it('fans out PATCHes when the selection spans multiple original issue keys', async () => {
    let call = 0;
    mockSupabaseRequest.mockImplementation((cfg, endpoint, options) => {
      call += 1;
      if (!options) {
        return Promise.resolve([
          { id: 'rec-1', user_assigned_issue_key: 'A-1' },
          { id: 'rec-2', user_assigned_issue_key: 'B-1' },
        ]);
      }
      return Promise.resolve([{ id: `patched-${call}` }]);
    });

    const result = await reassignAndApproveRecords(
      makeReq({ sessionIds: ['rec-1', 'rec-2'], newIssueKey: 'NEW-1' })
    );

    expect(result.success).toBe(true);
    const patchCalls = mockSupabaseRequest.mock.calls.filter(([, , opts]) => opts?.method === 'PATCH');
    expect(patchCalls).toHaveLength(2);

    const froms = patchCalls.map((c) => c[2].body.reassigned_from).sort();
    expect(froms).toEqual(['A-1', 'B-1']);
  });

  it('returns updated=0 when no pending rows match (race with another tab)', async () => {
    mockSupabaseRequest.mockResolvedValue([]);

    const result = await reassignAndApproveRecords(
      makeReq({ sessionIds: ['rec-1'], newIssueKey: 'NEW-1' })
    );

    expect(result).toEqual(expect.objectContaining({ success: true, updated: 0 }));
  });
});

// ===========================================================================
// createIssueAndApproveRecords
// ===========================================================================
describe('createIssueAndApproveRecords', () => {
  it('creates the Jira issue, patches records, writes cache and audit log', async () => {
    let step = 0;
    // Sequence:
    //   1. SELECT pending rows for time total
    //   2. PATCH records (approve + reassign to new key)
    //   3. POST user_jira_issues_cache
    //   4. POST created_issues_log
    mockSupabaseRequest.mockImplementation((cfg, endpoint, options) => {
      step += 1;
      if (step === 1) {
        return Promise.resolve([
          { id: 'rec-1', duration_seconds: 300 },
          { id: 'rec-2', duration_seconds: 600 },
        ]);
      }
      if (step === 2) {
        return Promise.resolve([{ id: 'rec-1' }, { id: 'rec-2' }]);
      }
      return Promise.resolve({});
    });

    mockRequestJira.mockResolvedValue({
      ok: true,
      json: async () => ({ key: 'NEW-500', id: '10500' }),
    });

    const result = await createIssueAndApproveRecords(makeReq({
      sessionIds: ['rec-1', 'rec-2'],
      issueSummary: 'Imported from review',
      projectKey: 'NEW',
      issueType: 'Task',
      assignToSelf: true,
    }));

    expect(result.success).toBe(true);
    expect(result.issue_key).toBe('NEW-500');
    expect(result.updated).toBe(2);
    expect(result.total_seconds).toBe(900);

    // Verified the Jira create was attempted
    expect(mockRequestJira).toHaveBeenCalledTimes(1);

    // PATCH body should reassign + approve
    const patchCall = mockSupabaseRequest.mock.calls.find(([, , opts]) => opts?.method === 'PATCH');
    expect(patchCall).toBeDefined();
    expect(patchCall[2].body.user_assigned_issue_key).toBe('NEW-500');
    expect(patchCall[2].body.approval_status).toBe('approved');

    // Cache upsert
    const cacheCall = mockSupabaseRequest.mock.calls.find(
      ([, endpoint, opts]) => endpoint === 'user_jira_issues_cache' && opts?.method === 'POST'
    );
    expect(cacheCall).toBeDefined();
    expect(cacheCall[2].body.issue_key).toBe('NEW-500');

    // Audit log
    const auditCall = mockSupabaseRequest.mock.calls.find(
      ([, endpoint, opts]) => endpoint === 'created_issues_log' && opts?.method === 'POST'
    );
    expect(auditCall).toBeDefined();
    expect(auditCall[2].body.total_time_seconds).toBe(900);
  });

  it('returns early with updated=0 when there are no pending rows', async () => {
    mockSupabaseRequest.mockResolvedValueOnce([]);

    const result = await createIssueAndApproveRecords(makeReq({
      sessionIds: ['rec-1'],
      issueSummary: 'X',
      projectKey: 'PROJ',
    }));

    expect(result.success).toBe(true);
    expect(result.updated).toBe(0);
    expect(mockRequestJira).not.toHaveBeenCalled();
  });

  it('surfaces Jira create failures as an error', async () => {
    mockSupabaseRequest.mockResolvedValueOnce([
      { id: 'rec-1', duration_seconds: 120 },
    ]);
    mockRequestJira.mockResolvedValue({
      ok: false,
      text: async () => 'project not permitted',
    });

    const result = await createIssueAndApproveRecords(makeReq({
      sessionIds: ['rec-1'],
      issueSummary: 'X',
      projectKey: 'PROJ',
    }));

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Failed to create issue/);
  });
});

