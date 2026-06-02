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

/** Chainable Supabase query-builder mock that resolves to `result` when awaited. */
function chain(result) {
  const q = {};
  ['select', 'gte', 'lte', 'neq', 'in', 'eq', 'or', 'ilike', 'order', 'range', 'limit'].forEach((m) => {
    q[m] = jest.fn(() => q);
  });
  q.then = (resolve, reject) => Promise.resolve(result).then(resolve, reject);
  return q;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('getDashboardData — LOB scoping', () => {
  test('applies .in("user_id", visibleUserIds) when an array is passed', async () => {
    const activities = [
      { classification: 'productive', duration_seconds: 3600, user_id: 'u1', work_date: '2026-06-01' },
      { classification: 'non_productive', duration_seconds: 1800, user_id: 'u1', work_date: '2026-06-01' },
    ];
    const q = chain({ data: activities, error: null });
    getClient.mockReturnValue({ from: jest.fn(() => q) });

    const result = await portalService.getDashboardData('org', '2026-06-01', '2026-06-02', ['u1', 'u2']);

    expect(q.in).toHaveBeenCalledWith('user_id', ['u1', 'u2']);
    expect(result.summary.totalProductiveHours).toBeCloseTo(1);
    expect(result.summary.totalNonProductiveHours).toBeCloseTo(0.5);
    expect(result.summary.employeeCount).toBe(1);
  });

  test('does NOT filter when visibleUserIds is null (superadmin / flag off)', async () => {
    const q = chain({ data: [], error: null });
    getClient.mockReturnValue({ from: jest.fn(() => q) });

    await portalService.getDashboardData('org', '2026-06-01', '2026-06-02', null);

    expect(q.in).not.toHaveBeenCalled();
  });
});

describe('empty scope short-circuits (head with no employees sees nothing)', () => {
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
