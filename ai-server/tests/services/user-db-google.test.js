'use strict';

// Unit tests for the non-Jira Google DB helpers in user-db-service.

jest.mock('../../src/services/db/supabase-client', () => ({
  getClient: jest.fn(),
  isNetworkError: jest.fn(() => false),
}));
jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const { getClient } = require('../../src/services/db/supabase-client');
const { getOrgIdByEmailDomain, findOrCreateGoogleUser } = require('../../src/services/db/user-db-service');

// Chainable Supabase mock: every builder method returns the builder; terminal
// reads (single/maybeSingle) and direct awaits resolve from a shared FIFO queue,
// so tests script the results in call order.
function makeClient(queue) {
  const makeBuilder = () => {
    const b = {};
    ['select', 'eq', 'ilike', 'in', 'is', 'not', 'order', 'limit', 'insert', 'update', 'delete', 'upsert', 'gte', 'lt']
      .forEach(m => { b[m] = jest.fn(() => b); });
    b.single = jest.fn(() => Promise.resolve(queue.shift()));
    b.maybeSingle = jest.fn(() => Promise.resolve(queue.shift()));
    b.then = (resolve, reject) => Promise.resolve(queue.shift()).then(resolve, reject);
    return b;
  };
  return { from: jest.fn(makeBuilder) };
}

describe('user-db-service Google helpers', () => {
  beforeEach(() => jest.clearAllMocks());

  test('getOrgIdByEmailDomain returns org id for a registered domain (case-insensitive)', async () => {
    getClient.mockReturnValue(makeClient([{ data: { organization_id: 'org-1' }, error: null }]));
    const id = await getOrgIdByEmailDomain('Amzur.com');
    expect(id).toBe('org-1');
  });

  test('getOrgIdByEmailDomain returns null for an unregistered domain', async () => {
    getClient.mockReturnValue(makeClient([{ data: null, error: null }]));
    expect(await getOrgIdByEmailDomain('random.com')).toBeNull();
  });

  test('findOrCreateGoogleUser returns the existing row (idempotent on google_sub)', async () => {
    const existing = {
      id: 'u1', organization_id: 'org-1', google_sub: 'sub-1',
      email: 'a@amzur.com', display_name: 'A', supabase_user_id: 'u1',
    };
    getClient.mockReturnValue(makeClient([
      { data: existing, error: null },        // lookup by google_sub
      { data: [{ id: 'm1' }], error: null },  // membership exists -> no insert
    ]));
    const u = await findOrCreateGoogleUser({
      googleSub: 'sub-1', email: 'a@amzur.com', displayName: 'A', organizationId: 'org-1',
    });
    expect(u.id).toBe('u1');
  });

  test('findOrCreateGoogleUser creates a new user and sets supabase_user_id = id', async () => {
    const created = {
      id: 'u2', organization_id: 'org-1', google_sub: 'sub-2',
      email: 'b@amzur.com', display_name: 'B', supabase_user_id: null,
    };
    getClient.mockReturnValue(makeClient([
      { data: null, error: null },     // lookup -> none
      { data: created, error: null },  // insert ... select single -> created
      { error: null },                 // update supabase_user_id = id
      { data: [], error: null },       // membership lookup -> none
      { error: null },                 // membership insert
    ]));
    const u = await findOrCreateGoogleUser({
      googleSub: 'sub-2', email: 'b@amzur.com', displayName: 'B', organizationId: 'org-1',
    });
    expect(u.id).toBe('u2');
    expect(u.supabase_user_id).toBe('u2'); // RLS requires supabase_user_id == id
  });

  test('findOrCreateGoogleUser rejects when existing user belongs to a different org (tenant isolation)', async () => {
    const existing = {
      id: 'u1', organization_id: 'org-OTHER', google_sub: 'sub-1',
      email: 'a@amzur.com', display_name: 'A', supabase_user_id: 'u1',
    };
    getClient.mockReturnValue(makeClient([{ data: existing, error: null }]));
    await expect(findOrCreateGoogleUser({
      googleSub: 'sub-1', email: 'a@amzur.com', displayName: 'A', organizationId: 'org-1',
    })).rejects.toMatchObject({ statusCode: 403 });
  });

  test('findOrCreateGoogleUser requires googleSub and organizationId', async () => {
    await expect(findOrCreateGoogleUser({ organizationId: 'org-1' })).rejects.toThrow('googleSub');
    await expect(findOrCreateGoogleUser({ googleSub: 'x' })).rejects.toThrow('organizationId');
  });
});
