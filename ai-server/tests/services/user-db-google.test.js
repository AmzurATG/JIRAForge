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
  const builders = [];
  const makeBuilder = () => {
    const b = {};
    ['select', 'eq', 'ilike', 'in', 'is', 'not', 'order', 'limit', 'insert', 'update', 'delete', 'upsert', 'gte', 'lt']
      .forEach(m => { b[m] = jest.fn(() => b); });
    b.single = jest.fn(() => Promise.resolve(queue.shift()));
    b.maybeSingle = jest.fn(() => Promise.resolve(queue.shift()));
    b.then = (resolve, reject) => Promise.resolve(queue.shift()).then(resolve, reject);
    builders.push(b);
    return b;
  };
  return { from: jest.fn(makeBuilder), builders };
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
      { data: null, error: null },     // lookup by google_sub -> none
      { data: [], error: null },       // email-link lookup -> no same-email user
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

  // Cross-provider duplicate fix — spec:
  // plan/2026-07-03_ai-server_google-login-duplicate-users.md (AC1–AC3).
  describe('cross-provider linking (google login onto an Atlassian-provisioned user)', () => {
    const atlassianRow = {
      id: 'u-atl', organization_id: 'org-1', google_sub: null,
      atlassian_account_id: '712020:abc', auth_provider: 'atlassian',
      email: 'a@amzur.com', display_name: 'A', supabase_user_id: 'u-atl',
    };

    test('AC1: google_sub miss + one same-email user in org → linked (google_sub set), no insert', async () => {
      const client = makeClient([
        { data: null, error: null },            // 1. lookup by google_sub → none
        { data: [atlassianRow], error: null },  // 2. email-link lookup → exactly one
        { error: null },                        // 3. update users set google_sub
        { data: [{ id: 'm1' }], error: null },  // 4. membership exists
      ]);
      getClient.mockReturnValue(client);

      const u = await findOrCreateGoogleUser({
        googleSub: 'sub-9', email: 'a@amzur.com', displayName: 'A', organizationId: 'org-1',
      });

      expect(u.id).toBe('u-atl');
      expect(u.google_sub).toBe('sub-9');
      // Linked, not duplicated: no insert anywhere.
      for (const b of client.builders) expect(b.insert).not.toHaveBeenCalled();
      // The link update sets google_sub but never touches auth_provider
      // (google provider = "non-Jira user" semantics elsewhere).
      const updateBuilder = client.builders.find((b) => b.update.mock.calls.length > 0);
      expect(updateBuilder).toBeDefined();
      const updatePayload = updateBuilder.update.mock.calls[0][0];
      expect(updatePayload.google_sub).toBe('sub-9');
      expect('auth_provider' in updatePayload).toBe(false);
    });

    test('AC2: 2+ same-email rows → falls through to create (no link, no throw)', async () => {
      const created = {
        id: 'u-new', organization_id: 'org-1', google_sub: 'sub-9',
        email: 'a@amzur.com', display_name: 'A', supabase_user_id: null,
      };
      const client = makeClient([
        { data: null, error: null },                              // 1. sub lookup → none
        { data: [atlassianRow, { ...atlassianRow, id: 'u-atl2' }], error: null }, // 2. email → ambiguous
        { data: created, error: null },                           // 3. insert → created
        { error: null },                                          // 4. backfill supabase_user_id
        { data: [], error: null },                                // 5. membership lookup → none
        { error: null },                                          // 6. membership insert
      ]);
      getClient.mockReturnValue(client);

      const u = await findOrCreateGoogleUser({
        googleSub: 'sub-9', email: 'a@amzur.com', displayName: 'A', organizationId: 'org-1',
      });

      expect(u.id).toBe('u-new');
    });

    test('AC3: the google_sub lookup no longer filters on auth_provider', async () => {
      const linkedAtlassian = { ...atlassianRow, google_sub: 'sub-9' };
      const client = makeClient([
        { data: linkedAtlassian, error: null }, // 1. sub lookup finds the linked atlassian row
        { data: [{ id: 'm1' }], error: null },  // 2. membership exists
      ]);
      getClient.mockReturnValue(client);

      const u = await findOrCreateGoogleUser({
        googleSub: 'sub-9', email: 'a@amzur.com', displayName: 'A', organizationId: 'org-1',
      });

      expect(u.id).toBe('u-atl');
      const lookupBuilder = client.builders[0];
      const eqArgs = lookupBuilder.eq.mock.calls;
      expect(eqArgs).toContainEqual(['google_sub', 'sub-9']);
      expect(eqArgs.find((c) => c[0] === 'auth_provider')).toBeUndefined();
    });
  });
});
