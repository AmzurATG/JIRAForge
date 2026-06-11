'use strict';

/**
 * WS-B — profile DB service URL-length safety.
 * getProfilesByUserIds must chunk large id sets: a single PostgREST
 * `in.(…)` with ~1000 UUIDs exceeds URL limits (employee-summary report
 * passes up to 1000 ids).
 */

jest.mock('../../src/services/db/supabase-client');
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { getClient } = require('../../src/services/db/supabase-client');
const db = require('../../src/services/db/portal-employee-profile-db-service');

beforeEach(() => jest.clearAllMocks());

describe('getProfilesByUserIds chunks large id sets', () => {
  function buildClient(inCalls) {
    const chain = {
      select: jest.fn(function () { return this; }),
      in: jest.fn(async (col, ids) => {
        inCalls.push(ids);
        return { data: ids.map((id) => ({ user_id: id, location_id: null, portal_locations: null })), error: null };
      }),
    };
    return { from: jest.fn(() => chain) };
  }

  test('450 ids → 3 chunked queries (200/200/50), all rows returned in order', async () => {
    const inCalls = [];
    getClient.mockReturnValue(buildClient(inCalls));

    const ids = Array.from({ length: 450 }, (_, i) => `u${i}`);
    const rows = await db.getProfilesByUserIds(ids);

    expect(inCalls.map((c) => c.length)).toEqual([200, 200, 50]);
    expect(rows).toHaveLength(450);
    expect(rows[0].user_id).toBe('u0');
    expect(rows[449].user_id).toBe('u449');
  });

  test('empty input → no query', async () => {
    const from = jest.fn();
    getClient.mockReturnValue({ from });
    expect(await db.getProfilesByUserIds([])).toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });
});
