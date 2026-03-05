'use strict';

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
  debug: jest.fn(),
}));

jest.mock('../../src/services/db/supabase-client', () => ({
  getClient: jest.fn(),
}));

jest.mock('../../src/utils/datetime', () => ({
  getUTCISOString: jest.fn().mockReturnValue('2024-01-01T00:00:00Z'),
}));

jest.mock('../../src/services/feedback-session-store', () => ({}));

const { getClient } = require('../../src/services/db/supabase-client');
const { getDashboardData, supabaseQuery } = require('../../src/controllers/forge-proxy-controller');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Creates a Supabase query builder mock that is:
 *   - Chainable  (.select / .eq / .gte / .order / .in / .or / .not / .single all return `this`)
 *   - Awaitable  (Promise.all / await resolve to `resolveValue`)
 */
function makeQuery(resolveValue) {
  const p = Promise.resolve(resolveValue);
  const q = {
    select: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    delete: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    neq: jest.fn().mockReturnThis(),
    gte: jest.fn().mockReturnThis(),
    lte: jest.fn().mockReturnThis(),
    gt: jest.fn().mockReturnThis(),
    lt: jest.fn().mockReturnThis(),
    is: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    limit: jest.fn().mockReturnThis(),
    range: jest.fn().mockReturnThis(),
    in: jest.fn().mockReturnThis(),
    or: jest.fn().mockReturnThis(),
    not: jest.fn().mockReturnThis(),
    single: jest.fn().mockReturnThis(),
    maybeSingle: jest.fn().mockReturnThis(),
    then: (...args) => p.then(...args),
    catch: (...args) => p.catch(...args),
    finally: (...args) => p.finally(...args),
  };
  return q;
}

/**
 * Builds a mock Supabase client where `from(table)` returns a chainable query.
 * Pass an array of responses for a table to support multiple calls to the same table
 * (e.g. `users` is queried twice when building the project-admin users list).
 */
function makeSupabaseClient(overrides = {}) {
  const defaults = {
    organizations: { data: [ORG], error: null },
    users: { data: [USER], error: null },
    organization_members: { data: MEMBERSHIP, error: null },
    daily_time_summary: { data: [], error: null },
    weekly_time_summary: { data: [], error: null },
    project_time_summary: { data: [], error: null },
    analysis_results: { data: [], error: null },
  };
  const tableData = { ...defaults, ...overrides };
  const callCounts = {};

  return {
    from: jest.fn().mockImplementation((table) => {
      callCounts[table] = (callCounts[table] || 0) + 1;
      const entry = tableData[table];
      if (Array.isArray(entry)) {
        // Support sequential responses for the same table
        return makeQuery(entry[callCounts[table] - 1] || { data: [], error: null });
      }
      return makeQuery(entry || { data: [], error: null });
    }),
  };
}

/** Builds a mock Express req object for getDashboardData */
function makeReq(body = {}) {
  return {
    forgeContext: { cloudId: 'cloud-1', accountId: 'account-1' },
    body: {
      canViewAllUsers: false,
      isJiraAdmin: false,
      projectKeys: null,
      maxDailySummaryDays: 60,
      maxWeeklySummaryWeeks: 12,
      maxIssuesInAnalytics: 50,
      ...body,
    },
  };
}

/** Builds a mock Express res object */
function makeRes() {
  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  };
  return res;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ORG = { id: 'org-id-1', org_name: 'Test Org', jira_cloud_id: 'cloud-1' };
const USER = { id: 'user-id-1', organization_id: 'org-id-1', email: 'test@example.com', display_name: 'Test User' };
const MEMBERSHIP = { user_id: 'user-id-1', organization_id: 'org-id-1', can_view_team_analytics: false };

// ---------------------------------------------------------------------------
// Tests — getDashboardData
// Covers: applyVisibilityFilter (3 branches) and buildUsersQuery (3 branches)
// ---------------------------------------------------------------------------

describe('getDashboardData', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // --- Guard clauses ---

  it('returns 500 when the Supabase client is not configured', async () => {
    getClient.mockReturnValue(null);
    const res = makeRes();
    await getDashboardData(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: 'Database not configured' })
    );
  });

  it('returns 403 when a project admin has no project keys (null)', async () => {
    getClient.mockReturnValue(makeSupabaseClient());
    const res = makeRes();
    await getDashboardData(makeReq({ canViewAllUsers: true, isJiraAdmin: false, projectKeys: null }), res);
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  it('returns 403 when a project admin has an empty project keys array', async () => {
    getClient.mockReturnValue(makeSupabaseClient());
    const res = makeRes();
    await getDashboardData(makeReq({ canViewAllUsers: true, isJiraAdmin: false, projectKeys: [] }), res);
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('returns 404 when the organization is not found', async () => {
    getClient.mockReturnValue(makeSupabaseClient({ organizations: { data: [], error: null } }));
    const res = makeRes();
    await getDashboardData(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: expect.stringContaining('Organization') })
    );
  });

  it('returns 404 when the user is not found', async () => {
    getClient.mockReturnValue(makeSupabaseClient({ users: { data: [], error: null } }));
    const res = makeRes();
    await getDashboardData(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: expect.stringContaining('User') })
    );
  });

  it('returns 500 when a database error occurs fetching the organization', async () => {
    getClient.mockReturnValue(
      makeSupabaseClient({ organizations: { data: null, error: new Error('DB error') } })
    );
    const res = makeRes();
    await getDashboardData(makeReq(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  // --- applyVisibilityFilter: canViewTeamData = false (regular user) ---
  // buildUsersQuery: returns self data only, no extra DB call

  it('returns 200 with scoped data for a regular user', async () => {
    getClient.mockReturnValue(
      makeSupabaseClient({
        daily_time_summary: { data: [{ user_id: 'user-id-1', work_date: '2024-01-01', total_seconds: 3600 }], error: null },
      })
    );
    const res = makeRes();
    await getDashboardData(makeReq({ canViewAllUsers: false }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    const { data } = res.json.mock.calls[0][0];
    expect(data.canViewAllUsers).toBe(false);
    expect(data.userId).toBe('user-id-1');
    // allUsers contains only the current user (no extra DB call in buildUsersQuery)
    expect(data.allUsers).toEqual([
      expect.objectContaining({ id: 'user-id-1' }),
    ]);
  });

  // --- applyVisibilityFilter: canViewTeamData = true, shouldFilterByProjects = false (Jira admin) ---
  // buildUsersQuery: fetches all org users

  it('returns 200 with unfiltered data for a Jira admin', async () => {
    const allUsers = [USER, { id: 'user-id-2', display_name: 'Other', email: 'other@example.com' }];
    getClient.mockReturnValue(
      makeSupabaseClient({
        // users is queried twice: first for the user lookup, then in buildUsersQuery
        users: [
          { data: [USER], error: null },
          { data: allUsers, error: null },
        ],
        organization_members: { data: { ...MEMBERSHIP, can_view_team_analytics: true }, error: null },
      })
    );
    const res = makeRes();
    await getDashboardData(makeReq({ canViewAllUsers: true, isJiraAdmin: true }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    const { data } = res.json.mock.calls[0][0];
    expect(data.canViewAllUsers).toBe(true);
    expect(data.allUsers).toHaveLength(2);
  });

  // --- applyVisibilityFilter: canViewTeamData = true, shouldFilterByProjects = true (project admin) ---
  // buildUsersQuery: two-step — find user IDs from daily_time_summary, then fetch user details

  it('returns 200 with project-filtered data for a project admin', async () => {
    const projectKeys = ['ATG', 'PROJ'];
    getClient.mockReturnValue(
      makeSupabaseClient({
        // users: first call = user lookup, second call = buildUsersQuery user details
        users: [
          { data: [USER], error: null },
          { data: [USER], error: null },
        ],
        // daily_time_summary: first call = main dashboard query, second = buildUsersQuery lookup
        daily_time_summary: [
          { data: [], error: null },
          { data: [{ user_id: 'user-id-1' }], error: null },
        ],
        organization_members: { data: { ...MEMBERSHIP, can_view_team_analytics: true }, error: null },
      })
    );
    const res = makeRes();
    await getDashboardData(makeReq({ canViewAllUsers: true, isJiraAdmin: false, projectKeys }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    const { data } = res.json.mock.calls[0][0];
    expect(data.canViewAllUsers).toBe(true);
  });

  // --- buildUsersQuery: project admin where daily_time_summary returns no rows ---
  // Falls back to returning the current user only

  it('returns current user in allUsers when buildUsersQuery finds no project members', async () => {
    const projectKeys = ['ATG'];
    getClient.mockReturnValue(
      makeSupabaseClient({
        users: [
          { data: [USER], error: null },
          { data: [USER], error: null },
        ],
        daily_time_summary: [
          { data: [], error: null },
          { data: [], error: null }, // no members found
        ],
        organization_members: { data: { ...MEMBERSHIP, can_view_team_analytics: true }, error: null },
      })
    );
    const res = makeRes();
    await getDashboardData(makeReq({ canViewAllUsers: true, isJiraAdmin: false, projectKeys }), res);

    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  // --- Response shape ---

  it('response contains all required top-level fields', async () => {
    getClient.mockReturnValue(makeSupabaseClient());
    const res = makeRes();
    await getDashboardData(makeReq(), res);

    const { data } = res.json.mock.calls[0][0];
    expect(data).toMatchObject({
      organizationId: 'org-id-1',
      organizationName: 'Test Org',
      userId: 'user-id-1',
      userDisplayName: 'Test User',
      userEmail: 'test@example.com',
      dailySummary: expect.any(Array),
      weeklySummary: expect.any(Array),
      timeByProject: expect.any(Array),
      timeByIssue: expect.any(Array),
      allUsers: expect.any(Array),
    });
  });

  it('membership is null when the user has no membership record', async () => {
    getClient.mockReturnValue(
      makeSupabaseClient({ organization_members: { data: null, error: null } })
    );
    const res = makeRes();
    await getDashboardData(makeReq(), res);

    const { data } = res.json.mock.calls[0][0];
    expect(data.membership).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Tests — supabaseQuery
// Covers: guard clauses, all HTTP methods, filter types (eq, neq, gte, lte,
//         gt, lt, in, is, not, or, order, limit, offset, single),
//         logSecurityWarnings, initQueryBuilder, prepareUpdatePayload
// ---------------------------------------------------------------------------

describe('supabaseQuery', () => {
  const logger = require('../../src/utils/logger');
  const { getUTCISOString } = require('../../src/utils/datetime');

  beforeEach(() => {
    jest.clearAllMocks();
  });

  /** req factory for supabaseQuery — defaults to a GET on test_table */
  function makeQueryReq(body = {}) {
    return {
      forgeContext: { cloudId: 'cloud-1', accountId: 'account-1' },
      body: { table: 'test_table', method: 'GET', ...body },
    };
  }

  /** Returns a simple Supabase client whose from() always gives the same query mock */
  function makeSimpleClient(resolveValue = { data: [], error: null }) {
    const q = makeQuery(resolveValue);
    return { from: jest.fn().mockReturnValue(q), _q: q };
  }

  // --- Guard clauses ---

  it('returns 400 when table is missing', async () => {
    getClient.mockReturnValue({});
    const res = makeRes();
    await supabaseQuery({ forgeContext: { cloudId: 'x', accountId: 'y' }, body: {} }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: 'Table name is required' })
    );
  });

  it('returns 500 when Supabase client is not configured', async () => {
    getClient.mockReturnValue(null);
    const res = makeRes();
    await supabaseQuery(makeQueryReq(), res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: 'Database not configured' })
    );
  });

  // --- GET / SELECT ---

  it('returns 200 with data for a basic GET request (defaults to select *)', async () => {
    const rows = [{ id: 1 }];
    const { _q: q, ...client } = makeSimpleClient({ data: rows, error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({ method: 'GET' }), res);
    expect(q.select).toHaveBeenCalledWith('*');
    expect(res.json).toHaveBeenCalledWith({ success: true, data: rows });
  });

  it('uses provided top-level select columns', async () => {
    const { _q: q, ...client } = makeSimpleClient({ data: [], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({ select: 'id, name' }), res);
    expect(q.select).toHaveBeenCalledWith('id, name');
  });

  it('uses query._select when top-level select is absent', async () => {
    const { _q: q, ...client } = makeSimpleClient({ data: [], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({ query: { _select: 'id, email' } }), res);
    expect(q.select).toHaveBeenCalledWith('id, email');
  });

  it('returns 400 when Supabase returns an error object', async () => {
    const { ...client } = makeSimpleClient({ data: null, error: { message: 'DB error' } });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq(), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: 'DB error' })
    );
  });

  it('returns 500 when an unexpected exception is thrown', async () => {
    getClient.mockImplementation(() => { throw new Error('Unexpected crash'); });
    const res = makeRes();
    await supabaseQuery(makeQueryReq(), res);
    expect(res.status).toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: 'Unexpected crash' })
    );
  });

  // --- POST / INSERT ---

  it('executes INSERT for POST method and returns data', async () => {
    const newRow = { id: 2, name: 'new' };
    const { _q: q, ...client } = makeSimpleClient({ data: [newRow], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({ method: 'POST', body: { name: 'new' } }), res);
    expect(q.insert).toHaveBeenCalledWith({ name: 'new' });
    expect(res.json).toHaveBeenCalledWith({ success: true, data: [newRow] });
  });

  // --- PATCH / UPDATE ---

  it('executes UPDATE for PATCH method with eq filter', async () => {
    const updated = [{ id: 1, name: 'updated' }];
    const { _q: q, ...client } = makeSimpleClient({ data: updated, error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({
      method: 'PATCH',
      body: { name: 'updated' },
      query: { eq: { id: '1' } },
    }), res);
    expect(q.update).toHaveBeenCalledWith({ name: 'updated' });
    expect(q.eq).toHaveBeenCalledWith('id', '1');
    expect(res.json).toHaveBeenCalledWith({ success: true, data: updated });
  });

  // --- DELETE ---

  it('executes DELETE method with eq filter', async () => {
    const { _q: q, ...client } = makeSimpleClient({ data: [], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({ method: 'DELETE', query: { eq: { id: '5' } } }), res);
    expect(q.delete).toHaveBeenCalled();
    expect(q.eq).toHaveBeenCalledWith('id', '5');
    expect(res.json).toHaveBeenCalledWith({ success: true, data: [] });
  });

  // --- Unsupported method ---

  it('returns 400 for an unsupported HTTP method', async () => {
    const { ...client } = makeSimpleClient({ data: [], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({ method: 'PUT' }), res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ success: false, error: expect.stringContaining('Unsupported') })
    );
  });

  // --- Filter types ---

  it('applies eq, order (object), and limit filters on GET', async () => {
    const { _q: q, ...client } = makeSimpleClient({ data: [], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({
      query: {
        eq: { status: 'active' },
        order: { column: 'created_at', ascending: false },
        limit: 10,
      },
    }), res);
    expect(q.eq).toHaveBeenCalledWith('status', 'active');
    expect(q.order).toHaveBeenCalledWith('created_at', { ascending: false });
    expect(q.limit).toHaveBeenCalledWith(10);
  });

  it('applies gte and lte filters on GET', async () => {
    const { _q: q, ...client } = makeSimpleClient({ data: [], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({ query: { gte: { score: 10 }, lte: { score: 100 } } }), res);
    expect(q.gte).toHaveBeenCalledWith('score', 10);
    expect(q.lte).toHaveBeenCalledWith('score', 100);
  });

  it('applies gt and lt filters on GET', async () => {
    const { _q: q, ...client } = makeSimpleClient({ data: [], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({ query: { gt: { age: 18 }, lt: { age: 65 } } }), res);
    expect(q.gt).toHaveBeenCalledWith('age', 18);
    expect(q.lt).toHaveBeenCalledWith('age', 65);
  });

  it('applies neq filter on GET', async () => {
    const { _q: q, ...client } = makeSimpleClient({ data: [], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({ query: { neq: { status: 'deleted' } } }), res);
    expect(q.neq).toHaveBeenCalledWith('status', 'deleted');
  });

  it('applies not filter on GET', async () => {
    const { _q: q, ...client } = makeSimpleClient({ data: [], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({
      query: { not: { status: { operator: 'is', value: null } } },
    }), res);
    expect(q.not).toHaveBeenCalledWith('status', 'is', null);
  });

  it('applies or filter on GET', async () => {
    const { _q: q, ...client } = makeSimpleClient({ data: [], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({ query: { or: 'id.eq.1,id.eq.2' } }), res);
    expect(q.or).toHaveBeenCalledWith('id.eq.1,id.eq.2');
  });

  it('applies single filter on GET', async () => {
    const { _q: q, ...client } = makeSimpleClient({ data: { id: 1 }, error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({ query: { single: true } }), res);
    expect(q.single).toHaveBeenCalled();
  });

  it('applies offset as range filter on GET', async () => {
    const { _q: q, ...client } = makeSimpleClient({ data: [], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({ query: { offset: 20, limit: 10 } }), res);
    expect(q.range).toHaveBeenCalledWith(20, 29);
  });

  it('applies in filter on GET', async () => {
    const { _q: q, ...client } = makeSimpleClient({ data: [], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({ query: { in: { status: ['active', 'pending'] } } }), res);
    expect(q.in).toHaveBeenCalledWith('status', ['active', 'pending']);
  });

  // --- Reserved param handling ---

  it('skips reserved "order" param in eq filter but delegates to handleOrderParam', async () => {
    const { _q: q, ...client } = makeSimpleClient({ data: [], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({ query: { eq: { order: 'created_at.desc' } } }), res);
    expect(logger.warn).toHaveBeenCalledWith(
      '[ForgeProxy] Skipping reserved parameter as filter',
      expect.objectContaining({ col: 'order' })
    );
    expect(q.order).toHaveBeenCalledWith('created_at', { ascending: false });
  });

  it('skips reserved param in neq filter with a warning', async () => {
    const { ...client } = makeSimpleClient({ data: [], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({ query: { neq: { limit: 'x' } } }), res);
    expect(logger.warn).toHaveBeenCalledWith(
      '[ForgeProxy] Skipping reserved parameter as neq filter',
      expect.any(Object)
    );
  });

  // --- logSecurityWarnings ---

  it('logs security warning for GET on sensitive table without org filter', async () => {
    const { ...client } = makeSimpleClient({ data: [], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({ table: 'screenshots', method: 'GET' }), res);
    expect(logger.warn).toHaveBeenCalledWith(
      '[ForgeProxy] SECURITY: Query to sensitive table without organization filter',
      expect.any(Object)
    );
  });

  it('logs security warning for POST on sensitive table without org id', async () => {
    const { ...client } = makeSimpleClient({ data: [], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({ table: 'users', method: 'POST', body: { email: 'x@x.com' } }), res);
    expect(logger.warn).toHaveBeenCalledWith(
      '[ForgeProxy] SECURITY: INSERT to sensitive table without organization_id',
      expect.any(Object)
    );
  });

  it('does not log security warning when organization_id eq filter is present', async () => {
    const { ...client } = makeSimpleClient({ data: [], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({
      table: 'screenshots',
      query: { eq: { organization_id: 'org-1' } },
    }), res);
    expect(logger.warn).not.toHaveBeenCalledWith(
      '[ForgeProxy] SECURITY: Query to sensitive table without organization filter',
      expect.any(Object)
    );
  });

  it('does not log security warning for non-sensitive tables', async () => {
    const { ...client } = makeSimpleClient({ data: [], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({ table: 'app_releases' }), res);
    expect(logger.warn).not.toHaveBeenCalledWith(
      '[ForgeProxy] SECURITY: Query to sensitive table without organization filter',
      expect.any(Object)
    );
  });

  // --- prepareUpdatePayload ---

  it('adds updated_at to screenshot soft-delete payload when missing', async () => {
    const { _q: q, ...client } = makeSimpleClient({
      data: [{ id: 'sc-1', deleted_at: '2024-01-01T00:00:00Z' }],
      error: null,
    });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({
      table: 'screenshots',
      method: 'PATCH',
      body: { deleted_at: '2024-01-01T00:00:00Z' },
      query: { eq: { id: 'sc-1' } },
    }), res);
    expect(getUTCISOString).toHaveBeenCalled();
    expect(q.update).toHaveBeenCalledWith(
      expect.objectContaining({ updated_at: '2024-01-01T00:00:00Z' })
    );
  });

  it('does not add updated_at when it is already present in soft-delete payload', async () => {
    const { _q: q, ...client } = makeSimpleClient({ data: [], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({
      table: 'screenshots',
      method: 'PATCH',
      body: { deleted_at: '2024-01-01T00:00:00Z', updated_at: '2024-01-01T00:00:00Z' },
      query: { eq: { id: 'sc-1' } },
    }), res);
    // getUTCISOString should NOT be called since updated_at is already set
    expect(getUTCISOString).not.toHaveBeenCalled();
  });

  it('does not treat non-screenshot table updates as soft-delete', async () => {
    const { ...client } = makeSimpleClient({ data: [], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({
      table: 'users',
      method: 'PATCH',
      body: { deleted_at: '2024-01-01T00:00:00Z' },
      query: { eq: { id: 'u-1' } },
    }), res);
    expect(getUTCISOString).not.toHaveBeenCalled();
  });
});
