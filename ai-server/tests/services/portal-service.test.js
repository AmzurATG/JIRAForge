'use strict';

jest.mock('../../src/services/db/supabase-client');
jest.mock('../../src/services/portal-employee-profile-service');

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { getClient } = require('../../src/services/db/supabase-client');
const profileService = require('../../src/services/portal-employee-profile-service');
const portalService = require('../../src/services/portal-service');

beforeEach(() => {
  jest.clearAllMocks();
  // Default: no employee has a portal location assigned.
  profileService.getLocationMapForUsers.mockResolvedValue({});
});

describe('getDashboardData — RPC aggregation + LOB scoping', () => {
  test('passes visibleUserIds as p_user_ids and aggregates the per-day rows', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: {
        employeeCount: 1,
        daily: [
          { work_date: '2026-06-01', productive_seconds: 3600, nonproductive_seconds: 1800 },
        ],
      },
      error: null,
    });
    getClient.mockReturnValue({ rpc });

    const result = await portalService.getDashboardData('org', '2026-06-01', '2026-06-02', ['u1', 'u2']);

    expect(rpc).toHaveBeenCalledWith('portal_dashboard_summary', {
      p_from: '2026-06-01', p_to: '2026-06-02', p_user_ids: ['u1', 'u2'],
    });
    expect(result.summary.totalProductiveHours).toBeCloseTo(1);
    expect(result.summary.totalNonProductiveHours).toBeCloseTo(0.5);
    expect(result.summary.productivityPercentage).toBeCloseTo(66.7);
    expect(result.summary.employeeCount).toBe(1);
    expect(result.dailyTrend).toEqual([
      { date: '2026-06-01', productiveHours: 1, nonProductiveHours: 0.5 },
    ]);
  });

  test('passes p_user_ids: null when visibleUserIds is null (superadmin / flag off)', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: { employeeCount: 0, daily: [] }, error: null });
    getClient.mockReturnValue({ rpc });

    await portalService.getDashboardData('org', '2026-06-01', '2026-06-02', null);

    expect(rpc).toHaveBeenCalledWith('portal_dashboard_summary', {
      p_from: '2026-06-01', p_to: '2026-06-02', p_user_ids: null,
    });
  });

  test('throws when the RPC returns an error', async () => {
    const rpc = jest.fn().mockResolvedValue({ data: null, error: { message: 'boom' } });
    getClient.mockReturnValue({ rpc });

    await expect(portalService.getDashboardData('org', '2026-06-01', '2026-06-02', null))
      .rejects.toMatchObject({ message: 'boom' });
  });
});

describe('getEmployees — RPC aggregation', () => {
  test('maps per-employee rows, computes productivity, and paginates', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: [
        { user_id: 'u1', name: 'Alice', email: 'a@x.com', productive_seconds: 7200, nonproductive_seconds: 0, last_activity: '2026-06-01T10:00:00Z' },
        { user_id: 'u2', name: 'Bob', email: 'b@x.com', productive_seconds: 3600, nonproductive_seconds: 3600, last_activity: '2026-06-01T09:00:00Z' },
      ],
      error: null,
    });
    getClient.mockReturnValue({ rpc });

    const res = await portalService.getEmployees('org', { from: '2026-06-01', to: '2026-06-02' }, { page: 1, limit: 10 }, ['u1', 'u2']);

    expect(rpc).toHaveBeenCalledWith('portal_employee_summary', {
      p_from: '2026-06-01', p_to: '2026-06-02', p_user_ids: ['u1', 'u2'],
    });
    expect(res.pagination.totalCount).toBe(2);
    const alice = res.data.find((e) => e.userId === 'u1');
    expect(alice.productiveHours).toBeCloseTo(2);
    expect(alice.productivityPercentage).toBe(100);
    const bob = res.data.find((e) => e.userId === 'u2');
    expect(bob.productivityPercentage).toBe(50);
  });

  test('productivityRange filter narrows results', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: [
        { user_id: 'u1', name: 'Alice', email: 'a@x.com', productive_seconds: 7200, nonproductive_seconds: 0, last_activity: null },
        { user_id: 'u2', name: 'Bob', email: 'b@x.com', productive_seconds: 0, nonproductive_seconds: 7200, last_activity: null },
      ],
      error: null,
    });
    getClient.mockReturnValue({ rpc });

    const res = await portalService.getEmployees('org', { productivityRange: 'high' }, { page: 1, limit: 10 }, null);

    expect(res.data).toHaveLength(1);
    expect(res.data[0].userId).toBe('u1');
  });

  test('search filter matches name or email (case-insensitive)', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: [
        { user_id: 'u1', name: 'Alice', email: 'a@x.com', productive_seconds: 1, nonproductive_seconds: 0, last_activity: null },
        { user_id: 'u2', name: 'Bob', email: 'bob@x.com', productive_seconds: 1, nonproductive_seconds: 0, last_activity: null },
      ],
      error: null,
    });
    getClient.mockReturnValue({ rpc });

    const res = await portalService.getEmployees('org', { search: 'BOB' }, { page: 1, limit: 10 }, null);

    expect(res.data).toHaveLength(1);
    expect(res.data[0].userId).toBe('u2');
  });

  test('merges each employee\'s portal location into the page (AC-B3)', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: [
        { user_id: 'u1', name: 'Alice', email: 'a@x.com', productive_seconds: 1, nonproductive_seconds: 0, last_activity: null },
        { user_id: 'u2', name: 'Bob', email: 'b@x.com', productive_seconds: 1, nonproductive_seconds: 0, last_activity: null },
      ],
      error: null,
    });
    getClient.mockReturnValue({ rpc });
    profileService.getLocationMapForUsers.mockResolvedValue({
      u1: { id: 'loc1', name: 'Hyderabad' },
    });

    const res = await portalService.getEmployees('org', { from: 'a', to: 'b' }, { page: 1, limit: 10 }, null);

    const alice = res.data.find((e) => e.userId === 'u1');
    const bob = res.data.find((e) => e.userId === 'u2');
    expect(alice.location).toEqual({ id: 'loc1', name: 'Hyderabad' });
    expect(bob.location).toBeNull();
  });

  test('locationId filter narrows to employees in that location, before pagination (AC-B3)', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: [
        { user_id: 'u1', name: 'Alice', email: 'a@x.com', productive_seconds: 1, nonproductive_seconds: 0, last_activity: null },
        { user_id: 'u2', name: 'Bob', email: 'b@x.com', productive_seconds: 1, nonproductive_seconds: 0, last_activity: null },
      ],
      error: null,
    });
    getClient.mockReturnValue({ rpc });
    profileService.getLocationMapForUsers.mockResolvedValue({
      u1: { id: 'loc1', name: 'Hyderabad' },
      u2: { id: 'loc2', name: 'Tampa' },
    });

    const res = await portalService.getEmployees('org', { from: 'a', to: 'b', locationId: 'loc1' }, { page: 1, limit: 10 }, null);

    expect(res.data).toHaveLength(1);
    expect(res.data[0].userId).toBe('u1');
    expect(res.pagination.totalCount).toBe(1);
  });
});

describe('getApplicationUsage — RPC aggregation', () => {
  test('normalizes classification and folds an in-scope employee into p_user_ids', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: [
        { application_name: 'VSCode', total_seconds: 3600, session_count: 5, employee_count: 1 },
      ],
      error: null,
    });
    getClient.mockReturnValue({ rpc });

    const res = await portalService.getApplicationUsage(
      'org',
      { from: '2026-06-01', to: '2026-06-02', classification: 'non-productive', employee: 'u1' },
      ['u1', 'u2']
    );

    expect(rpc).toHaveBeenCalledWith('portal_app_usage_summary', {
      p_from: '2026-06-01', p_to: '2026-06-02', p_user_ids: ['u1'], p_classification: 'non_productive',
    });
    expect(res.data[0].application).toBe('VSCode');
    expect(res.data[0].totalHours).toBeCloseTo(1);
    expect(res.data[0].employeeCount).toBe(1);
  });

  test('employee outside the caller scope → empty result, no RPC call', async () => {
    const rpc = jest.fn();
    getClient.mockReturnValue({ rpc });

    const res = await portalService.getApplicationUsage('org', { employee: 'outsider' }, ['u1']);

    expect(res).toEqual({ data: [], pagination: { totalCount: 0 } });
    expect(rpc).not.toHaveBeenCalled();
  });
});

describe('getDashboardData — neutral/idle category breakdown (WS-C)', () => {
  test('new RPC fields surface as totalNeutralHours + per-day neutral/idle, old fields unchanged (AC-C1, AC-C2)', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: {
        employeeCount: 2,
        daily: [
          { work_date: '2026-06-01', productive_seconds: 3600, nonproductive_seconds: 1800, neutral_seconds: 900, idle_seconds: 600 },
        ],
      },
      error: null,
    });
    getClient.mockReturnValue({ rpc });

    const result = await portalService.getDashboardData('org', '2026-06-01', '2026-06-02', null);

    // Golden (AC-C1): productive / non-productive / % identical to the pre-WS-C math.
    expect(result.summary.totalProductiveHours).toBeCloseTo(1);
    expect(result.summary.totalNonProductiveHours).toBeCloseTo(0.5);
    expect(result.summary.productivityPercentage).toBeCloseTo(66.7);
    // Additive (AC-C2): neutral total + per-day breakdown.
    expect(result.summary.totalNeutralHours).toBeCloseTo(0.25);
    expect(result.dailyTrend[0].neutralHours).toBeCloseTo(0.25);
    expect(result.dailyTrend[0].idleHours).toBeCloseTo(600 / 3600);
  });

  test('degraded mode (AC-C6): pre-migration RPC shape renders the old view, no neutral fields', async () => {
    const rpc = jest.fn().mockResolvedValue({
      data: {
        employeeCount: 1,
        daily: [{ work_date: '2026-06-01', productive_seconds: 3600, nonproductive_seconds: 0 }],
      },
      error: null,
    });
    getClient.mockReturnValue({ rpc });

    const result = await portalService.getDashboardData('org', '2026-06-01', '2026-06-02', null);

    expect(result.summary.totalProductiveHours).toBeCloseTo(1);
    expect('totalNeutralHours' in result.summary).toBe(false);
    expect('neutralHours' in result.dailyTrend[0]).toBe(false);
  });
});

describe('getEmployeeDetail — canonical categories incl. idle (WS-C)', () => {
  function buildDetailClient({ user, activityRows }) {
    const userChain = {
      select: jest.fn(function () { return this; }),
      eq: jest.fn(function () { return this; }),
      single: jest.fn(async () => ({ data: user, error: null })),
    };
    const activityChain = {
      select: jest.fn(function () { return this; }),
      eq: jest.fn(function () { return this; }),
      gte: jest.fn(function () { return this; }),
      lte: jest.fn(function () { return this; }),
      order: jest.fn(function () { return this; }),
      range: jest.fn(async () => ({ data: activityRows, error: null })),
    };
    return {
      from: jest.fn((table) => (table === 'users' ? userChain : activityChain)),
    };
  }

  test('buckets P/NP(both spellings)/Neutral/Idle; daily % uses the summary denominator (AC-C2, AC-C4, AC-C5)', async () => {
    const activityRows = [
      { classification: 'productive', duration_seconds: 3600, work_date: '2026-06-01', is_idle: false },
      { classification: 'non_productive', duration_seconds: 1800, work_date: '2026-06-01', is_idle: false },
      { classification: 'non-productive', duration_seconds: 600, work_date: '2026-06-01', is_idle: false },
      { classification: 'private', duration_seconds: 900, work_date: '2026-06-01', is_idle: false },
      { classification: null, duration_seconds: 300, work_date: '2026-06-01', is_idle: false },
      { classification: 'idle', duration_seconds: 1200, work_date: '2026-06-01', is_idle: true },
      // is_idle NULL: excluded by the old `.neq('is_idle', true)` filter and by
      // the SQL aggregates — must fall in NO bucket here either (parity).
      { classification: 'productive', duration_seconds: 99999, work_date: '2026-06-01', is_idle: null },
    ];
    getClient.mockReturnValue(buildDetailClient({
      user: { id: 'u1', display_name: 'Jane', email: 'j@x.com' },
      activityRows,
    }));

    const result = await portalService.getEmployeeDetail('org', 'u1', '2026-06-01', '2026-06-02');

    const s = result.summary;
    expect(s.productiveHours).toBeCloseTo(1);
    expect(s.nonProductiveHours).toBeCloseTo(2400 / 3600); // both spellings counted
    expect(s.neutralHours).toBeCloseTo(1200 / 3600); // private + null
    expect(s.idleHours).toBeCloseTo(1200 / 3600);
    // Sum checks: Active = P + NP + Neutral; Office = Active + Idle.
    expect(s.activeHours).toBeCloseTo(s.productiveHours + s.nonProductiveHours + s.neutralHours);
    expect(s.officeHours).toBeCloseTo(s.activeHours + s.idleHours);
    // Ratio excludes neutral + idle: 3600 / (3600 + 2400) = 60%.
    expect(s.productivityPercentage).toBeCloseTo(60);
    // AC-C4: single-day trend % equals the summary % (same denominator).
    expect(result.dailyTrend).toHaveLength(1);
    expect(result.dailyTrend[0].productivityPercentage).toBeCloseTo(60);
    // totalHours keeps its "active time" meaning (idle excluded).
    expect(result.dailyTrend[0].totalHours).toBeCloseTo(s.activeHours);
  });
});

describe('getTimeLogs — category filters and field (WS-C)', () => {
  function buildLogsClient(rows) {
    const chain = {};
    for (const m of ['select', 'eq', 'gte', 'lte', 'neq', 'in', 'or', 'ilike', 'order', 'limit', 'range']) {
      chain[m] = jest.fn(function () { return this; });
    }
    // The supabase query builder is awaitable.
    chain.then = (resolve) => resolve({ data: rows, error: null, count: rows.length });
    return { from: jest.fn(() => chain), chain };
  }

  test('non-productive filter matches BOTH stored spellings; idle stays excluded by default (AC-C3, AC-C5)', async () => {
    const { from, chain } = buildLogsClient([]);
    getClient.mockReturnValue({ from });

    await portalService.getTimeLogs('org', { classification: 'non-productive', from: '2026-06-01', to: '2026-06-02' }, { page: 1, limit: 20 }, null);

    expect(chain.in).toHaveBeenCalledWith('classification', ['non_productive', 'non-productive']);
    expect(chain.neq).toHaveBeenCalledWith('is_idle', true);
  });

  test('neutral filter targets private/unknown/NULL (AC-C3)', async () => {
    const { from, chain } = buildLogsClient([]);
    getClient.mockReturnValue({ from });

    await portalService.getTimeLogs('org', { classification: 'neutral', from: '2026-06-01', to: '2026-06-02' }, { page: 1, limit: 20 }, null);

    expect(chain.or).toHaveBeenCalledWith('classification.is.null,classification.not.in.(productive,non_productive,non-productive)');
  });

  test('rows expose the canonical category field (AC-C3)', async () => {
    const rows = [
      { id: 1, classification: 'productive', is_idle: false, users: { display_name: 'A', email: 'a@x' } },
      { id: 2, classification: 'non-productive', is_idle: false, users: { display_name: 'A', email: 'a@x' } },
      { id: 3, classification: 'private', is_idle: false, users: { display_name: 'A', email: 'a@x' } },
      { id: 4, classification: 'idle', is_idle: true, users: { display_name: 'A', email: 'a@x' } },
    ];
    const { from } = buildLogsClient(rows);
    getClient.mockReturnValue({ from });

    const res = await portalService.getTimeLogs('org', { from: '2026-06-01', to: '2026-06-02', includeIdle: true }, { page: 1, limit: 20 }, null);

    expect(res.data.map((r) => r.category)).toEqual(['productive', 'non-productive', 'neutral', 'idle']);
  });
});

describe('empty scope short-circuits (head with no employees sees nothing)', () => {
  test('getDashboardData returns a zeroed dashboard without touching the DB', async () => {
    const from = jest.fn();
    getClient.mockReturnValue({ from });

    const res = await portalService.getDashboardData('org', '2026-06-01', '2026-06-02', []);

    expect(res.summary).toEqual({ totalProductiveHours: 0, totalNonProductiveHours: 0, totalNeutralHours: 0, productivityPercentage: 0, employeeCount: 0 });
    expect(res.dailyTrend).toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });

  test('getEmployees returns empty without touching the DB', async () => {
    const from = jest.fn();
    getClient.mockReturnValue({ from });

    const res = await portalService.getEmployees('org', { from: 'a', to: 'b' }, { page: 1, limit: 10 }, []);

    expect(res).toEqual({ data: [], pagination: { page: 1, limit: 10, totalCount: 0 } });
    expect(from).not.toHaveBeenCalled();
  });

  test('getEmployeesList returns [] without touching the DB', async () => {
    const from = jest.fn();
    getClient.mockReturnValue({ from });

    const res = await portalService.getEmployeesList('org', '', []);

    expect(res).toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });

  test('getTimeLogs returns empty page without touching the DB', async () => {
    const from = jest.fn();
    getClient.mockReturnValue({ from });

    const res = await portalService.getTimeLogs('org', {}, { page: 1, limit: 20 }, []);

    expect(res).toEqual({ data: [], pagination: { page: 1, limit: 20, totalCount: 0 } });
    expect(from).not.toHaveBeenCalled();
  });
});
