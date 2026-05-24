'use strict';

/**
 * Unit Tests: Unassigned Work Date Filter
 *
 * Verifies acceptance criteria for the date range filter feature on
 * getUnassignedGroups (sessionResolvers.js).
 *
 * AC-1: dateFrom  queries activity_records with start_time=gte.YYYY-MM-DDT00:00:00
 * AC-2: dateTo    queries activity_records with start_time=lte.YYYY-MM-DDT23:59:59
 * AC-3: Both dateFrom and dateTo - both start_time filters applied in activity lookup
 * AC-4: No dates - no date-range lookup; count+data queries have no date filter
 * AC-5: Invalid date string - filter ignored; no date-range lookup
 * AC-6: No matching activity records - early return { success: true, groups: [], ... }
 * AC-7: No matching group members - early return { success: true, groups: [], ... }
 */

// Mocks declared before any require() calls

const mockSupabaseRequest = jest.fn();
const mockInitializeRequestContext = jest.fn();
const mockHandleResolverError = jest.fn((err) => ({ success: false, error: err.message }));
const mockEnsureArray = jest.fn((v) => (Array.isArray(v) ? v : []));

jest.mock('../../src/utils/supabase.js', () => ({
  getSupabaseConfig: jest.fn(),
  getOrCreateUser: jest.fn(),
  getOrCreateOrganization: jest.fn(),
  supabaseRequest: mockSupabaseRequest,
  generateSignedUrl: jest.fn(),
}));

jest.mock('../../src/utils/formatters.js', () => ({
  formatDuration: jest.fn((s) => `${s}s`),
}));

jest.mock('../../src/resolvers/unassigned/helpers.js', () => ({
  initializeRequestContext: mockInitializeRequestContext,
  handleResolverError: mockHandleResolverError,
  ensureArray: mockEnsureArray,
}));

jest.mock('../../src/utils/validators.js', () => {
  const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;
  return {
    isValidDate: (value) => {
      if (typeof value !== 'string' || !DATE_REGEX.test(value)) return false;
      const d = new Date(value + 'T00:00:00Z');
      return !Number.isNaN(d.getTime());
    },
    isValidUUID: jest.fn(() => true),
    sanitizeUUIDArray: jest.fn((arr) => (Array.isArray(arr) ? arr : [])),
    toSafeInteger: jest.fn((v, def) => (typeof v === 'number' ? v : def)),
  };
});

const { getUnassignedGroups } = require('../../src/resolvers/unassigned/sessionResolvers.js');

const ORG_ID = 'org-uuid-test';
const USER_ID = 'user-uuid-test';
const FAKE_CONFIG = { url: 'https://supabase.test', key: 'fake-key' };

function makeRequest(payload = {}) {
  return { context: { accountId: 'acc-1', cloudId: 'cloud-1' }, payload };
}

function capturedUrl(callIndex = 0) {
  return mockSupabaseRequest.mock.calls[callIndex][1];
}

const SAMPLE_GROUP = {
  id: 'g1',
  group_label: 'Test Group',
  group_description: 'desc',
  session_count: 3,
  total_seconds: 600,
  confidence_level: 'high',
  recommended_action: null,
  suggested_issue_key: null,
  recommendation_reason: null,
  created_at: '2026-05-17T15:05:49Z',
  is_idle_only: false,
};

function setupNoDateMocks() {
  mockSupabaseRequest
    .mockResolvedValueOnce([{ id: 'g1' }, { id: 'g2' }])
    .mockResolvedValueOnce([SAMPLE_GROUP]);
  mockEnsureArray.mockImplementation((v) => (Array.isArray(v) ? v : v ? [v] : []));
}

function setupDateFilterMocks(activityIds = ['act-1', 'act-2'], groupIds = ['g1']) {
  const activities = activityIds.map((id) => ({ id, duration_seconds: 0 }));
  const members = groupIds.map((gid, i) => ({ group_id: gid, activity_record_id: activityIds[i] || activityIds[0] }));
  mockSupabaseRequest
    .mockResolvedValueOnce(activities)
    .mockResolvedValueOnce(members)
    .mockResolvedValueOnce([{ id: 'g1' }])
    .mockResolvedValueOnce([SAMPLE_GROUP]);
  mockEnsureArray.mockImplementation((v) => (Array.isArray(v) ? v : v ? [v] : []));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockInitializeRequestContext.mockResolvedValue({
    success: true,
    config: FAKE_CONFIG,
    organization: { id: ORG_ID },
    userId: USER_ID,
  });
});

describe('getUnassignedGroups - date range filter', () => {

  it('AC-4: no dates - no date-range lookup; count and data queries have no date filter', async () => {
    setupNoDateMocks();
    await getUnassignedGroups(makeRequest({}));
    expect(mockSupabaseRequest).toHaveBeenCalledTimes(2);
    expect(capturedUrl(0)).not.toMatch(/start_time=(gte|lte)/);
    expect(capturedUrl(1)).not.toMatch(/start_time=(gte|lte)/);
    expect(capturedUrl(0)).toMatch(/unassigned_work_groups/);
    expect(capturedUrl(1)).toMatch(/unassigned_work_groups/);
  });

  it('AC-5: invalid dateFrom - filter ignored, only count+data queries fired', async () => {
    setupNoDateMocks();
    await getUnassignedGroups(makeRequest({ dateFrom: 'not-a-date' }));
    expect(mockSupabaseRequest).toHaveBeenCalledTimes(2);
    expect(capturedUrl(0)).not.toMatch(/start_time=(gte|lte)/);
  });

  it('AC-5b: invalid dateTo format (MM/DD/YYYY) - filter ignored', async () => {
    setupNoDateMocks();
    await getUnassignedGroups(makeRequest({ dateTo: '05/18/2026' }));
    expect(mockSupabaseRequest).toHaveBeenCalledTimes(2);
    expect(capturedUrl(0)).not.toMatch(/start_time=(gte|lte)/);
  });

  it('AC-1: dateFrom - activity_records queried with start_time=gte.YYYY-MM-DDT00:00:00', async () => {
    setupDateFilterMocks();
    await getUnassignedGroups(makeRequest({ dateFrom: '2026-05-14' }));
    expect(capturedUrl(0)).toMatch(/activity_records/);
    expect(capturedUrl(0)).toContain('start_time=gte.2026-05-14T00:00:00');
    expect(capturedUrl(1)).toMatch(/unassigned_group_members/);
    expect(mockSupabaseRequest).toHaveBeenCalledTimes(4);
  });

  it('AC-2: dateTo - activity_records queried with start_time=lte.YYYY-MM-DDT23:59:59', async () => {
    setupDateFilterMocks();
    await getUnassignedGroups(makeRequest({ dateTo: '2026-05-18' }));
    expect(capturedUrl(0)).toMatch(/activity_records/);
    expect(capturedUrl(0)).toContain('start_time=lte.2026-05-18T23:59:59');
    expect(mockSupabaseRequest).toHaveBeenCalledTimes(4);
  });

  it('AC-3: both dateFrom and dateTo - both start_time filters in activity lookup', async () => {
    setupDateFilterMocks();
    await getUnassignedGroups(makeRequest({ dateFrom: '2026-05-01', dateTo: '2026-05-18' }));
    expect(capturedUrl(0)).toContain('start_time=gte.2026-05-01T00:00:00');
    expect(capturedUrl(0)).toContain('start_time=lte.2026-05-18T23:59:59');
    expect(capturedUrl(2)).toContain('id=in.');
    expect(capturedUrl(3)).toContain('id=in.');
    expect(mockSupabaseRequest).toHaveBeenCalledTimes(4);
  });

  it('AC-6: no matching activity records - early return with empty groups', async () => {
    mockSupabaseRequest.mockResolvedValueOnce([]);
    mockEnsureArray.mockImplementation((v) => (Array.isArray(v) ? v : v ? [v] : []));
    const result = await getUnassignedGroups(makeRequest({ dateFrom: '2026-01-01' }));
    expect(mockSupabaseRequest).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ success: true, groups: [], total_groups: 0, has_more: false, next_offset: 0 });
  });

  it('AC-7: no matching group members - early return with empty groups', async () => {
    mockSupabaseRequest
      .mockResolvedValueOnce([{ id: 'act-1' }])
      .mockResolvedValueOnce([]);
    mockEnsureArray.mockImplementation((v) => (Array.isArray(v) ? v : v ? [v] : []));
    const result = await getUnassignedGroups(makeRequest({ dateFrom: '2026-01-01' }));
    expect(mockSupabaseRequest).toHaveBeenCalledTimes(2);
    // early return when no group members found
    expect(result).toEqual({ success: true, groups: [], total_groups: 0, has_more: false, next_offset: 0 });
  });

  it('returns success with groups on a valid date-filtered response', async () => {
    setupDateFilterMocks();
    const result = await getUnassignedGroups(makeRequest({ dateFrom: '2026-05-14' }));
    expect(result.success).toBe(true);
    expect(result.groups).toHaveLength(1);
    expect(result.groups[0].id).toBe('g1');
  });
});
