'use strict';

/**
 * Employee Activity Status (live presence) — spec:
 * plan/2026-07-02_portal_employee-activity-status.md (AC1–AC6).
 *
 * getEmployees merges portal_employee_presence into the summary list so
 * inactive employees become visible and filterable.
 */

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

const NOW = new Date('2026-07-02T12:00:00Z');

/** ISO timestamp `minutes` before NOW. */
function minutesAgo(minutes) {
  return new Date(NOW.getTime() - minutes * 60 * 1000).toISOString();
}

/**
 * rpc mock serving both portal RPCs from canned rows, plus a `.from` chain for
 * the detected-location page merge (user_location_log → empty).
 * Presence rows use the SQL shape: user_id/name/email/last_active_at/
 * active_today/ever_tracked.
 */
function mockRpc({ summaryRows = [], presenceRows = [], presenceError = null }) {
  const rpc = jest.fn((fnName) => {
    if (fnName === 'portal_employee_summary') {
      return Promise.resolve({ data: summaryRows, error: null });
    }
    if (fnName === 'portal_employee_presence') {
      return presenceError
        ? Promise.resolve({ data: null, error: presenceError })
        : Promise.resolve({ data: presenceRows, error: null });
    }
    return Promise.resolve({ data: null, error: { message: `unexpected rpc ${fnName}` } });
  });
  const locationLogChain = {
    select: jest.fn(function () { return this; }),
    in: jest.fn(function () { return this; }),
    order: jest.fn(function () { return this; }),
    limit: jest.fn(async () => ({ data: [], error: null })),
  };
  getClient.mockReturnValue({ rpc, from: jest.fn(() => locationLogChain) });
  return rpc;
}

const SUMMARY_ALICE = {
  user_id: 'u1', name: 'Alice', email: 'a@x.com',
  productive_seconds: 7200, nonproductive_seconds: 0,
  last_activity: minutesAgo(60),
};

const PRESENCE_ALICE = {
  user_id: 'u1', name: 'Alice', email: 'a@x.com',
  last_active_at: minutesAgo(5), active_today: true, ever_tracked: true,
};
// Bob: no activity in the selected range (absent from summary), none today,
// last seen 26h ago.
const PRESENCE_BOB = {
  user_id: 'u2', name: 'Bob', email: 'b@x.com',
  last_active_at: minutesAgo(26 * 60), active_today: false, ever_tracked: true,
};
// Cara: never produced a single activity record.
const PRESENCE_CARA = {
  user_id: 'u3', name: 'Cara', email: 'c@x.com',
  last_active_at: null, active_today: false, ever_tracked: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
  profileService.getLocationMapForUsers.mockResolvedValue({});
});

afterEach(() => {
  jest.useRealTimers();
});

describe('getEmployees — presence merge (AC1, AC2)', () => {
  test('AC1: calls portal_employee_presence with p_today + p_user_ids and maps fields onto summary rows', async () => {
    const rpc = mockRpc({ summaryRows: [SUMMARY_ALICE], presenceRows: [PRESENCE_ALICE] });

    const res = await portalService.getEmployees(
      'org',
      { from: '2026-07-02', to: '2026-07-02', today: '2026-07-02', includePresence: true },
      { page: 1, limit: 10 },
      ['u1']
    );

    expect(rpc).toHaveBeenCalledWith('portal_employee_presence', {
      p_today: '2026-07-02', p_user_ids: ['u1'],
    });
    const alice = res.data.find((e) => e.userId === 'u1');
    expect(alice.lastActivityAt).toBe(PRESENCE_ALICE.last_active_at);
    expect(alice.activeToday).toBe(true);
    expect(alice.everTracked).toBe(true);
  });

  test('AC1: p_user_ids is null when unscoped', async () => {
    const rpc = mockRpc({ summaryRows: [SUMMARY_ALICE], presenceRows: [PRESENCE_ALICE] });

    await portalService.getEmployees(
      'org', { from: '2026-07-02', to: '2026-07-02', today: '2026-07-02', includePresence: true },
      { page: 1, limit: 10 }, null
    );

    expect(rpc).toHaveBeenCalledWith('portal_employee_presence',
      expect.objectContaining({ p_user_ids: null }));
  });

  test('AC2: presence-only users appear with zero hours and their presence fields', async () => {
    mockRpc({
      summaryRows: [SUMMARY_ALICE],
      presenceRows: [PRESENCE_ALICE, PRESENCE_BOB, PRESENCE_CARA],
    });

    const res = await portalService.getEmployees(
      'org', { from: '2026-07-02', to: '2026-07-02', today: '2026-07-02', includePresence: true },
      { page: 1, limit: 10 }, null
    );

    expect(res.pagination.totalCount).toBe(3);
    const bob = res.data.find((e) => e.userId === 'u2');
    expect(bob).toBeDefined();
    expect(bob.name).toBe('Bob');
    expect(bob.productiveHours).toBe(0);
    expect(bob.nonProductiveHours).toBe(0);
    expect(bob.productivityPercentage).toBe(0);
    expect(bob.activeToday).toBe(false);
    expect(bob.everTracked).toBe(true);
    const cara = res.data.find((e) => e.userId === 'u3');
    expect(cara.everTracked).toBe(false);
    expect(cara.lastActivityAt).toBeNull();
  });
});

describe('getEmployees — activityStatus filter (AC3)', () => {
  const FIVE_MIN = { ...PRESENCE_ALICE }; // 5 min ago
  const EXACTLY_15 = {
    user_id: 'u4', name: 'Dan', email: 'd@x.com',
    last_active_at: minutesAgo(15), active_today: true, ever_tracked: true,
  };
  const NINETY_MIN = {
    user_id: 'u5', name: 'Eve', email: 'e@x.com',
    last_active_at: minutesAgo(90), active_today: true, ever_tracked: true,
  };
  const TWO_H_TEN = {
    user_id: 'u6', name: 'Fin', email: 'f@x.com',
    last_active_at: minutesAgo(130), active_today: true, ever_tracked: true,
  };
  const FOUR_H = {
    user_id: 'u7', name: 'Gus', email: 'g@x.com',
    last_active_at: minutesAgo(240), active_today: true, ever_tracked: true,
  };
  const ALL_PRESENCE = [FIVE_MIN, EXACTLY_15, NINETY_MIN, TWO_H_TEN, FOUR_H, PRESENCE_BOB, PRESENCE_CARA];

  async function idsFor(activityStatus) {
    mockRpc({ summaryRows: [], presenceRows: ALL_PRESENCE });
    const res = await portalService.getEmployees(
      'org', { from: '2026-07-02', to: '2026-07-02', today: '2026-07-02', includePresence: true, activityStatus },
      { page: 1, limit: 50 }, null
    );
    return res.data.map((e) => e.userId).sort();
  }

  test('active: within 15 min only', async () => {
    expect(await idsFor('active')).toEqual(['u1']);
  });

  test('away: older than 15 min, within 2 h (boundary 15 min is away)', async () => {
    expect(await idsFor('away')).toEqual(['u4', 'u5']);
  });

  test('inactive2h: older than 2 h or no recent activity at all', async () => {
    expect(await idsFor('inactive2h')).toEqual(['u2', 'u3', 'u6', 'u7']);
  });

  test('inactive3h: older than 3 h or no recent activity at all', async () => {
    expect(await idsFor('inactive3h')).toEqual(['u2', 'u3', 'u7']);
  });

  test('nottoday: active_today false', async () => {
    expect(await idsFor('nottoday')).toEqual(['u2', 'u3']);
  });

  test('never: ever_tracked false', async () => {
    expect(await idsFor('never')).toEqual(['u3']);
  });
});

describe('getEmployees — productivityRange semantics preserved (AC4)', () => {
  test('zero-hour presence-only rows never match high/medium/low', async () => {
    mockRpc({
      summaryRows: [SUMMARY_ALICE], // 100% productive → high
      presenceRows: [PRESENCE_ALICE, PRESENCE_BOB, PRESENCE_CARA],
    });

    const low = await portalService.getEmployees(
      'org', { from: '2026-07-02', to: '2026-07-02', today: '2026-07-02', includePresence: true, productivityRange: 'low' },
      { page: 1, limit: 10 }, null
    );
    expect(low.data).toHaveLength(0);

    const high = await portalService.getEmployees(
      'org', { from: '2026-07-02', to: '2026-07-02', today: '2026-07-02', includePresence: true, productivityRange: 'high' },
      { page: 1, limit: 10 }, null
    );
    expect(high.data.map((e) => e.userId)).toEqual(['u1']);
  });
});

describe('getEmployees — presence is opt-in (reports parity)', () => {
  test('without includePresence: presence RPC not called, row set and fields unchanged', async () => {
    const rpc = mockRpc({
      summaryRows: [SUMMARY_ALICE],
      presenceRows: [PRESENCE_ALICE, PRESENCE_BOB, PRESENCE_CARA],
    });

    // Same call shape as portal-reports-controller getEmployeeSummaryData.
    const res = await portalService.getEmployees(
      'org', { from: '2026-06-01', to: '2026-06-30' }, { page: 1, limit: 1000 }, null
    );

    expect(rpc).not.toHaveBeenCalledWith('portal_employee_presence', expect.anything());
    expect(res.pagination.totalCount).toBe(1); // Bob & Cara NOT appended
    const alice = res.data[0];
    // Range-scoped timestamp preserved; no presence fields added at all.
    expect(alice.lastActivityAt).toBe(SUMMARY_ALICE.last_activity);
    expect('activeToday' in alice).toBe(false);
    expect('everTracked' in alice).toBe(false);
  });
});

describe('getEmployees — empty scope and degrade (AC5, AC6)', () => {
  test('AC5: visibleUserIds = [] short-circuits with no RPC calls at all', async () => {
    const rpc = mockRpc({ summaryRows: [], presenceRows: [] });

    const res = await portalService.getEmployees(
      'org', { from: '2026-07-02', to: '2026-07-02', today: '2026-07-02', includePresence: true },
      { page: 1, limit: 10 }, []
    );

    expect(res).toEqual({ data: [], pagination: { page: 1, limit: 10, totalCount: 0 } });
    expect(rpc).not.toHaveBeenCalled();
  });

  test('AC6: presence RPC error degrades to summary-only list with null presence fields', async () => {
    mockRpc({
      summaryRows: [SUMMARY_ALICE],
      presenceError: { message: 'function public.portal_employee_presence does not exist' },
    });

    const res = await portalService.getEmployees(
      'org', { from: '2026-07-02', to: '2026-07-02', today: '2026-07-02', includePresence: true },
      { page: 1, limit: 10 }, null
    );

    expect(res.data).toHaveLength(1);
    const alice = res.data[0];
    // Falls back to the range-scoped summary timestamp (pre-existing behavior).
    expect(alice.lastActivityAt).toBe(SUMMARY_ALICE.last_activity);
    expect(alice.activeToday).toBeNull();
    expect(alice.everTracked).toBeNull();
  });
});
