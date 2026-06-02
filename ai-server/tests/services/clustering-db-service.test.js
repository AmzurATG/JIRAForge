'use strict';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockGetClient = jest.fn();
const mockLogger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
};

jest.mock('../../src/services/db/supabase-client', () => ({
  getClient: mockGetClient,
}));

jest.mock('../../src/utils/logger', () => mockLogger);

jest.mock('../../src/utils/datetime', () => ({
  toUTCISOString: (d) => d.toISOString(),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const { computeIsIdleOnly, getUsersWithUnassignedWork } = require('../../src/services/db/clustering-db-service');

// ---------------------------------------------------------------------------
// computeIsIdleOnly Helper Function Tests
// ---------------------------------------------------------------------------

describe('computeIsIdleOnly', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('returns true when ALL activity_records have is_idle = true', () => {
    const sessions = [
      { id: 'ar-1', source: 'activity_records', is_idle: true },
      { id: 'ar-2', source: 'activity_records', is_idle: true },
      { id: 'ar-3', source: 'activity_records', is_idle: true },
    ];

    const result = computeIsIdleOnly(sessions);
    expect(result).toBe(true);
  });

  it('returns false when ANY activity_record has is_idle = false', () => {
    const sessions = [
      { id: 'ar-1', source: 'activity_records', is_idle: true },
      { id: 'ar-2', source: 'activity_records', is_idle: false },
      { id: 'ar-3', source: 'activity_records', is_idle: true },
    ];

    const result = computeIsIdleOnly(sessions);
    expect(result).toBe(false);
  });

  it('returns false when activity_records have mixed idle states', () => {
    const sessions = [
      { id: 'ar-1', source: 'activity_records', is_idle: true },
      { id: 'ar-2', source: 'activity_records', is_idle: null },
      { id: 'ar-3', source: 'activity_records', is_idle: undefined },
    ];

    const result = computeIsIdleOnly(sessions);
    expect(result).toBe(false);
  });

  it('returns false for empty array', () => {
    const result = computeIsIdleOnly([]);
    expect(result).toBe(false);
  });

  it('returns false for null input', () => {
    const result = computeIsIdleOnly(null);
    expect(result).toBe(false);
  });

  it('returns false for undefined input', () => {
    const result = computeIsIdleOnly(undefined);
    expect(result).toBe(false);
  });

  it('returns false when group contains legacy unassigned_activity members (no is_idle field)', () => {
    const sessions = [
      { id: 'legacy-1', source: 'unassigned_activity' },
      { id: 'legacy-2', source: 'unassigned_activity' },
    ];

    const result = computeIsIdleOnly(sessions);
    expect(result).toBe(false);
  });

  it('returns false when group contains mix of legacy and idle activity_records', () => {
    const sessions = [
      { id: 'ar-1', source: 'activity_records', is_idle: true },
      { id: 'legacy-1', source: 'unassigned_activity' },
      { id: 'ar-2', source: 'activity_records', is_idle: true },
    ];

    const result = computeIsIdleOnly(sessions);
    expect(result).toBe(false);
  });

  it('returns true when only activity_records present and all are idle (ignores other fields)', () => {
    const sessions = [
      { id: 'ar-1', source: 'activity_records', is_idle: true, window_title: 'Lock Screen', duration_seconds: 300 },
      { id: 'ar-2', source: 'activity_records', is_idle: true, window_title: 'Screensaver', duration_seconds: 600 },
    ];

    const result = computeIsIdleOnly(sessions);
    expect(result).toBe(true);
  });

  it('returns false when sessions have no source field (defaults to unassigned_activity)', () => {
    const sessions = [
      { id: 'unknown-1', is_idle: true },
      { id: 'unknown-2', is_idle: true },
    ];

    const result = computeIsIdleOnly(sessions);
    expect(result).toBe(false);
  });

  it('returns false when activity_records have is_idle explicitly set to false', () => {
    const sessions = [
      { id: 'ar-1', source: 'activity_records', is_idle: false },
    ];

    const result = computeIsIdleOnly(sessions);
    expect(result).toBe(false);
  });

  it('returns false when activity_records have is_idle = 0 (falsy but not boolean)', () => {
    const sessions = [
      { id: 'ar-1', source: 'activity_records', is_idle: 0 },
    ];

    const result = computeIsIdleOnly(sessions);
    expect(result).toBe(false);
  });

  it('returns true when single activity_record is idle', () => {
    const sessions = [
      { id: 'ar-1', source: 'activity_records', is_idle: true },
    ];

    const result = computeIsIdleOnly(sessions);
    expect(result).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// getUsersWithUnassignedWork — Google (non-Jira) user exclusion
// ---------------------------------------------------------------------------
// Builds a minimal chainable Supabase stub. The function makes these calls, in
// order: unassigned_group_members.select(); unassigned_activity.select().eq().eq().order();
// activity_records.select().is().in().in().eq(); then (new) users.select().in().eq().
// We drive results per-table so we can assert the final provider filter.

describe('getUsersWithUnassignedWork — excludes google users', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Returns a thenable query builder whose chain methods all return `this`,
  // resolving to `{ data, error }` when awaited.
  function makeQuery(result) {
    const q = {
      select: () => q,
      eq: () => q,
      is: () => q,
      in: () => q,
      order: () => q,
      then: (resolve) => resolve(result),
    };
    return q;
  }

  function buildClient({ activityRecords, googleUsers, usersError = null }) {
    return {
      from: (table) => {
        switch (table) {
          case 'unassigned_group_members':
            return makeQuery({ data: [], error: null }); // nothing grouped yet
          case 'unassigned_activity':
            return makeQuery({ data: [], error: null }); // no legacy rows
          case 'activity_records':
            return makeQuery({ data: activityRecords, error: null });
          case 'users':
            return makeQuery({ data: googleUsers, error: usersError });
          default:
            return makeQuery({ data: [], error: null });
        }
      },
    };
  }

  it('removes users whose auth_provider is google, keeps the rest', async () => {
    mockGetClient.mockReturnValue(buildClient({
      activityRecords: [
        { id: 'r1', user_id: 'google-user', organization_id: 'org-1' },
        { id: 'r2', user_id: 'jira-user', organization_id: 'org-1' },
      ],
      googleUsers: [{ id: 'google-user' }], // users table says this one is google
    }));

    const result = await getUsersWithUnassignedWork();

    const ids = result.map(u => u.id);
    expect(ids).toContain('jira-user');
    expect(ids).not.toContain('google-user');
    expect(result).toHaveLength(1);
  });

  it('keeps everyone when there are no google users', async () => {
    mockGetClient.mockReturnValue(buildClient({
      activityRecords: [
        { id: 'r1', user_id: 'jira-1', organization_id: 'org-1' },
        { id: 'r2', user_id: 'jira-2', organization_id: 'org-1' },
      ],
      googleUsers: [],
    }));

    const result = await getUsersWithUnassignedWork();
    expect(result.map(u => u.id).sort()).toEqual(['jira-1', 'jira-2']);
  });

  it('fails OPEN: if the provider lookup errors, returns the unfiltered combos', async () => {
    mockGetClient.mockReturnValue(buildClient({
      activityRecords: [
        { id: 'r1', user_id: 'maybe-google', organization_id: 'org-1' },
      ],
      googleUsers: null,
      usersError: { message: 'users query failed' },
    }));

    const result = await getUsersWithUnassignedWork();
    // Must not silently drop a user on a transient DB error.
    expect(result.map(u => u.id)).toEqual(['maybe-google']);
  });

  it('returns empty (and skips the provider query) when there is no unassigned work', async () => {
    mockGetClient.mockReturnValue(buildClient({
      activityRecords: [],
      googleUsers: [],
    }));

    const result = await getUsersWithUnassignedWork();
    expect(result).toEqual([]);
  });
});
