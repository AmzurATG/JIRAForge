'use strict';

jest.mock('../../src/services/db/supabase-client');

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const { getClient } = require('../../src/services/db/supabase-client');
const portalService = require('../../src/services/portal-service');

beforeEach(() => {
  jest.clearAllMocks();
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

describe('empty scope short-circuits (head with no employees sees nothing)', () => {
  test('getDashboardData returns a zeroed dashboard without touching the DB', async () => {
    const from = jest.fn();
    getClient.mockReturnValue({ from });

    const res = await portalService.getDashboardData('org', '2026-06-01', '2026-06-02', []);

    expect(res.summary).toEqual({ totalProductiveHours: 0, totalNonProductiveHours: 0, productivityPercentage: 0, employeeCount: 0 });
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
