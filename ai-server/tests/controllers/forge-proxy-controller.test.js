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

jest.mock('../../src/services/feedback-session-store', () => ({
  createSession: jest.fn().mockReturnValue('test-session-id'),
}));

const { getClient } = require('../../src/services/db/supabase-client');
const {
  getDashboardData, supabaseQuery,
  getOrCreateOrganization, getOrCreateUser, getOrganizationMembership,
  storageUpload, storageSignedUrl, storageDelete,
  getLatestAppVersion, createFeedbackSession,
} = require('../../src/controllers/forge-proxy-controller');
const sessionStore = require('../../src/services/feedback-session-store');

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

  it('aggregates timeByIssue from analysis results (covers aggregateTimeByIssue)', async () => {
    const analysisData = [
      { active_task_key: 'ATG-1', active_project_key: 'ATG', screenshots: { duration_seconds: 300 } },
      { active_task_key: 'ATG-1', active_project_key: 'ATG', screenshots: { duration_seconds: 200 } },
      { active_task_key: 'ATG-2', active_project_key: 'ATG', screenshots: null },
      { active_task_key: null, active_project_key: 'ATG', screenshots: null }, // skipped (no key)
    ];
    getClient.mockReturnValue(makeSupabaseClient({
      analysis_results: { data: analysisData, error: null },
    }));
    const res = makeRes();
    await getDashboardData(makeReq(), res);

    const { data } = res.json.mock.calls[0][0];
    expect(data.timeByIssue).toHaveLength(2);
    const atg1 = data.timeByIssue.find(i => i.issueKey === 'ATG-1');
    expect(atg1.totalSeconds).toBe(500);
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

// ---------------------------------------------------------------------------
// supabaseQuery — additional uncovered branches
// (maybeSingle, default filter key, SELECT/INSERT/UPDATE aliases,
//  mutation filters with in/is)
// ---------------------------------------------------------------------------

describe('supabaseQuery — additional filter branches', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  function makeQueryReq(body = {}) {
    return {
      forgeContext: { cloudId: 'cloud-1', accountId: 'account-1' },
      body: { table: 'test_table', method: 'GET', ...body },
    };
  }
  function makeSimpleClient(resolveValue = { data: [], error: null }) {
    const q = makeQuery(resolveValue);
    return { from: jest.fn().mockReturnValue(q), _q: q };
  }

  it('applies maybeSingle filter on GET', async () => {
    const { _q: q, ...client } = makeSimpleClient({ data: { id: 1 }, error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({ query: { maybeSingle: true } }), res);
    expect(q.maybeSingle).toHaveBeenCalled();
  });

  it('ignores unknown filter key (default case in applySingleFilter)', async () => {
    const { ...client } = makeSimpleClient({ data: [], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({ query: { unknownKey: 'value' } }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('handles SELECT method alias the same as GET', async () => {
    // SELECT method routes through executeSelect; initQueryBuilder skips select('*')
    // because the guard is `method === 'GET'`, not 'SELECT'.
    const { ...client } = makeSimpleClient({ data: [{ id: 1 }], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({ method: 'SELECT' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('handles INSERT method alias the same as POST', async () => {
    const { _q: q, ...client } = makeSimpleClient({ data: [{ id: 1 }], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({ method: 'INSERT', body: { name: 'x' } }), res);
    expect(q.insert).toHaveBeenCalledWith({ name: 'x' });
  });

  it('handles UPDATE method alias the same as PATCH', async () => {
    const { _q: q, ...client } = makeSimpleClient({ data: [{ id: 1 }], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({ method: 'UPDATE', body: { name: 'y' }, query: { eq: { id: '1' } } }), res);
    expect(q.update).toHaveBeenCalledWith({ name: 'y' });
  });

  it('applies in mutation filter on PATCH', async () => {
    const { _q: q, ...client } = makeSimpleClient({ data: [], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({
      method: 'PATCH',
      body: { status: 'done' },
      query: { in: { id: ['id-1', 'id-2'] } },
    }), res);
    expect(q.in).toHaveBeenCalledWith('id', ['id-1', 'id-2']);
  });

  it('applies in mutation filter on DELETE', async () => {
    const { _q: q, ...client } = makeSimpleClient({ data: [], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({
      method: 'DELETE',
      query: { in: { org_id: ['org-1', 'org-2'] } },
    }), res);
    expect(q.in).toHaveBeenCalledWith('org_id', ['org-1', 'org-2']);
  });

  it('applies is mutation filter on DELETE', async () => {
    const { _q: q, ...client } = makeSimpleClient({ data: [], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({
      method: 'DELETE',
      query: { is: { deleted_at: null } },
    }), res);
    expect(q.is).toHaveBeenCalledWith('deleted_at', null);
  });

  it('does not log security warning when jira_cloud_id eq filter is present', async () => {
    const logger = require('../../src/utils/logger');
    const { ...client } = makeSimpleClient({ data: [], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({
      table: 'screenshots',
      query: { eq: { jira_cloud_id: 'cloud-1' } },
    }), res);
    expect(logger.warn).not.toHaveBeenCalledWith(
      '[ForgeProxy] SECURITY: Query to sensitive table without organization filter',
      expect.any(Object)
    );
  });

  it('does not log security warning when body has organization_id', async () => {
    const logger = require('../../src/utils/logger');
    const { ...client } = makeSimpleClient({ data: [], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({
      table: 'users',
      method: 'POST',
      body: { organization_id: 'org-1', email: 'x@x.com' },
    }), res);
    expect(logger.warn).not.toHaveBeenCalledWith(
      '[ForgeProxy] SECURITY: INSERT to sensitive table without organization_id',
      expect.any(Object)
    );
  });

  it('treats screenshot status=deleted as soft-delete (logs info)', async () => {
    const logger = require('../../src/utils/logger');
    const { _q: q, ...client } = makeSimpleClient({ data: [], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await supabaseQuery(makeQueryReq({
      table: 'screenshots',
      method: 'PATCH',
      body: { status: 'deleted' },
      query: { eq: { id: 'sc-1' } },
    }), res);
    // isSoftDelete=true because status==='deleted'; logger.info should fire
    expect(logger.info).toHaveBeenCalledWith(
      '[ForgeProxy] Screenshot soft-delete',
      expect.any(Object)
    );
  });

  it('handles order param with no dot (handleOrderParam no-op)', async () => {
    const { _q: q, ...client } = makeSimpleClient({ data: [], error: null });
    getClient.mockReturnValue(client);
    const res = makeRes();
    // 'created_at' has no dot after index 0 → dotIndex <= 0 → no order applied
    await supabaseQuery(makeQueryReq({ query: { eq: { order: 'nodothere' } } }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });
});

// ---------------------------------------------------------------------------
// getOrCreateOrganization
// ---------------------------------------------------------------------------

describe('getOrCreateOrganization', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  function makeReqOrg(forgeCtx = {}, body = {}) {
    return {
      forgeContext: { cloudId: 'cloud-1', ...forgeCtx },
      body: { orgName: 'Test Org', jiraUrl: 'https://test.atlassian.net', ...body },
    };
  }

  it('returns 400 when cloudId is missing', async () => {
    const res = makeRes();
    await getOrCreateOrganization({ forgeContext: { cloudId: null }, body: {} }, res);
    expect(res.status).toHaveBeenCalledWith(400);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: false }));
  });

  it('returns 500 when supabase client is not configured', async () => {
    getClient.mockReturnValue(null);
    const res = makeRes();
    await getOrCreateOrganization(makeReqOrg(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('returns 500 when DB error occurs fetching org', async () => {
    getClient.mockReturnValue(makeSupabaseClient({
      organizations: { data: null, error: new Error('DB error') },
    }));
    const res = makeRes();
    await getOrCreateOrganization(makeReqOrg(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('returns existing org when found and no update needed', async () => {
    const existingOrg = { id: 'org-1', org_name: 'Test Org', jira_cloud_id: 'cloud-1', jira_instance_url: 'https://test.atlassian.net' };
    getClient.mockReturnValue(makeSupabaseClient({
      organizations: { data: [existingOrg], error: null },
    }));
    const res = makeRes();
    await getOrCreateOrganization(makeReqOrg(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: existingOrg }));
  });

  it('updates org when existing name is Unknown Organization', async () => {
    const existingOrg = { id: 'org-1', org_name: 'Unknown Organization', jira_cloud_id: 'cloud-1', jira_instance_url: 'https://test.atlassian.net' };
    const updatedOrg = { ...existingOrg, org_name: 'Test Org' };
    getClient.mockReturnValue(makeSupabaseClient({
      organizations: [
        { data: [existingOrg], error: null },
        { data: updatedOrg, error: null },
      ],
    }));
    const res = makeRes();
    await getOrCreateOrganization(makeReqOrg(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: updatedOrg }));
  });

  it('updates org when jira_instance_url includes cloudId', async () => {
    const existingOrg = { id: 'org-1', org_name: 'Stale Name', jira_cloud_id: 'cloud-1', jira_instance_url: 'https://cloud-1.atlassian.net' };
    const updatedOrg = { ...existingOrg, org_name: 'Test Org' };
    getClient.mockReturnValue(makeSupabaseClient({
      organizations: [
        { data: [existingOrg], error: null },
        { data: updatedOrg, error: null },
      ],
    }));
    const res = makeRes();
    await getOrCreateOrganization(makeReqOrg(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('falls through to return existing org when update returns null data', async () => {
    const existingOrg = { id: 'org-1', org_name: 'Unknown Organization', jira_cloud_id: 'cloud-1', jira_instance_url: 'https://test.atlassian.net' };
    getClient.mockReturnValue(makeSupabaseClient({
      organizations: [
        { data: [existingOrg], error: null },
        { data: null, error: new Error('update failed') },
      ],
    }));
    const res = makeRes();
    await getOrCreateOrganization(makeReqOrg(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: existingOrg }));
  });

  it('creates new org and default settings when not found', async () => {
    const newOrg = { id: 'new-org-1', org_name: 'Test Org', jira_cloud_id: 'cloud-1' };
    getClient.mockReturnValue(makeSupabaseClient({
      organizations: [
        { data: [], error: null },
        { data: newOrg, error: null },
      ],
      organization_settings: { data: null, error: null },
    }));
    const res = makeRes();
    await getOrCreateOrganization(makeReqOrg(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: newOrg }));
  });

  it('returns 500 on DB error creating org', async () => {
    getClient.mockReturnValue(makeSupabaseClient({
      organizations: [
        { data: [], error: null },
        { data: null, error: new Error('insert failed') },
      ],
    }));
    const res = makeRes();
    await getOrCreateOrganization(makeReqOrg(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ---------------------------------------------------------------------------
// getOrCreateUser
// ---------------------------------------------------------------------------

describe('getOrCreateUser', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  function makeReqUser(forgeCtx = {}, body = {}) {
    return {
      forgeContext: { accountId: 'account-1', cloudId: 'cloud-1', ...forgeCtx },
      body: { organizationId: 'org-1', email: 'user@test.com', displayName: 'Test User', ...body },
    };
  }

  it('returns 400 when accountId is missing', async () => {
    const res = makeRes();
    await getOrCreateUser({ forgeContext: { accountId: null, cloudId: 'c' }, body: {} }, res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 500 when supabase client is not configured', async () => {
    getClient.mockReturnValue(null);
    const res = makeRes();
    await getOrCreateUser(makeReqUser(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('returns 500 on DB error fetching user', async () => {
    getClient.mockReturnValue(makeSupabaseClient({
      users: { data: null, error: new Error('DB error') },
    }));
    const res = makeRes();
    await getOrCreateUser(makeReqUser(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('returns existing user without updates when org matches', async () => {
    const existingUser = { id: 'user-1', organization_id: 'org-1', email: 'user@test.com', display_name: 'Test User' };
    getClient.mockReturnValue(makeSupabaseClient({
      users: { data: [existingUser], error: null },
    }));
    const res = makeRes();
    await getOrCreateUser(makeReqUser(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: { userId: 'user-1' } }));
  });

  it('updates organization_id when different and creates membership', async () => {
    const existingUser = { id: 'user-1', organization_id: 'old-org', email: 'user@test.com', display_name: 'Test User' };
    getClient.mockReturnValue(makeSupabaseClient({
      users: [
        { data: [existingUser], error: null },
        { data: null, error: null }, // update org_id call
        { data: null, error: null }, // update details call (skipped since email/display_name present)
      ],
      organization_members: [
        { data: [], error: null },  // ensureOrganizationMembership: check existing
        { data: [], error: null },  // ensureOrganizationMembership: count all members
        { data: null, error: null }, // ensureOrganizationMembership: insert
      ],
    }));
    const res = makeRes();
    await getOrCreateUser(makeReqUser(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('updates email and display_name when missing on existing user', async () => {
    const existingUser = { id: 'user-1', organization_id: 'org-1', email: null, display_name: null };
    getClient.mockReturnValue(makeSupabaseClient({
      users: [
        { data: [existingUser], error: null },
        { data: null, error: null }, // update details call
      ],
    }));
    const res = makeRes();
    await getOrCreateUser(makeReqUser(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('creates new user and membership when user not found', async () => {
    const newUser = { id: 'new-user-1' };
    getClient.mockReturnValue(makeSupabaseClient({
      users: [
        { data: [], error: null },
        { data: newUser, error: null }, // insert call
      ],
      organization_members: [
        { data: [], error: null },
        { data: [], error: null },
        { data: null, error: null },
      ],
    }));
    const res = makeRes();
    await getOrCreateUser(makeReqUser(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: { userId: 'new-user-1' } }));
  });

  it('creates new user without membership when no organizationId', async () => {
    const newUser = { id: 'new-user-2' };
    getClient.mockReturnValue(makeSupabaseClient({
      users: [
        { data: [], error: null },
        { data: newUser, error: null },
      ],
    }));
    const res = makeRes();
    await getOrCreateUser(makeReqUser({}, { organizationId: null }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('returns 500 on DB error creating user', async () => {
    getClient.mockReturnValue(makeSupabaseClient({
      users: [
        { data: [], error: null },
        { data: null, error: new Error('insert failed') },
      ],
    }));
    const res = makeRes();
    await getOrCreateUser(makeReqUser(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('skips membership creation when membership already exists (ensureOrganizationMembership early return)', async () => {
    const existingUser = { id: 'user-1', organization_id: 'old-org', email: 'u@t.com', display_name: 'U' };
    getClient.mockReturnValue(makeSupabaseClient({
      users: [
        { data: [existingUser], error: null },
        { data: null, error: null }, // update org_id
      ],
      // First organization_members call returns existing membership → early return in ensureOrganizationMembership
      organization_members: { data: [{ id: 'mem-1' }], error: null },
    }));
    const res = makeRes();
    await getOrCreateUser(makeReqUser(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('logs error but does not throw when ensureOrganizationMembership fails', async () => {
    const logger = require('../../src/utils/logger');
    const existingUser = { id: 'user-1', organization_id: 'old-org', email: 'u@t.com', display_name: 'U' };
    // Make organization_members throw to trigger the catch block in ensureOrganizationMembership
    const client = makeSupabaseClient({
      users: [
        { data: [existingUser], error: null },
        { data: null, error: null },
      ],
    });
    // Override organization_members to throw synchronously
    const originalFrom = client.from.getMockImplementation();
    client.from.mockImplementation((table) => {
      if (table === 'organization_members') throw new Error('membership DB crash');
      return originalFrom(table);
    });
    getClient.mockReturnValue(client);
    const res = makeRes();
    await getOrCreateUser(makeReqUser(), res);
    // getOrCreateUser should still succeed — ensureOrganizationMembership swallows the error
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(logger.error).toHaveBeenCalledWith(
      '[ForgeProxy] Membership creation error:',
      expect.any(Error)
    );
  });
});

// ---------------------------------------------------------------------------
// getOrganizationMembership
// ---------------------------------------------------------------------------

describe('getOrganizationMembership', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('returns 500 when supabase client is not configured', async () => {
    getClient.mockReturnValue(null);
    const res = makeRes();
    await getOrganizationMembership({ body: { userId: 'u-1', organizationId: 'o-1' } }, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('returns membership data on success', async () => {
    const membership = { user_id: 'u-1', organization_id: 'o-1', role: 'member' };
    getClient.mockReturnValue(makeSupabaseClient({
      organization_members: { data: membership, error: null },
    }));
    const res = makeRes();
    await getOrganizationMembership({ body: { userId: 'u-1', organizationId: 'o-1' } }, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: membership }));
  });

  it('returns 500 on DB error', async () => {
    getClient.mockReturnValue(makeSupabaseClient({
      organization_members: { data: null, error: new Error('query error') },
    }));
    const res = makeRes();
    await getOrganizationMembership({ body: { userId: 'u-1', organizationId: 'o-1' } }, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ---------------------------------------------------------------------------
// storageUpload / storageSignedUrl / storageDelete
// ---------------------------------------------------------------------------

function makeStorageClient(methodResults = {}) {
  const bucket = {
    upload: jest.fn().mockResolvedValue(methodResults.upload || { data: { path: 'file.exe' }, error: null }),
    createSignedUrl: jest.fn().mockResolvedValue(methodResults.signedUrl || { data: { signedUrl: 'https://signed.url' }, error: null }),
    remove: jest.fn().mockResolvedValue(methodResults.remove || { data: {}, error: null }),
  };
  return {
    from: jest.fn().mockReturnValue(makeQuery({ data: null, error: null })),
    storage: { from: jest.fn().mockReturnValue(bucket), _bucket: bucket },
  };
}

describe('storageUpload', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('returns 500 when supabase client is not configured', async () => {
    getClient.mockReturnValue(null);
    const res = makeRes();
    await storageUpload({ forgeContext: { cloudId: 'c' }, body: { bucket: 'b', path: 'p', data: '' } }, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('returns upload data on success', async () => {
    getClient.mockReturnValue(makeStorageClient());
    const res = makeRes();
    await storageUpload({
      forgeContext: { cloudId: 'c' },
      body: { bucket: 'screenshots', path: 'file.png', data: Buffer.from('img').toString('base64'), contentType: 'image/png' },
    }, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('returns 500 on upload error', async () => {
    getClient.mockReturnValue(makeStorageClient({ upload: { data: null, error: new Error('upload failed') } }));
    const res = makeRes();
    await storageUpload({
      forgeContext: { cloudId: 'c' },
      body: { bucket: 'b', path: 'p', data: '' },
    }, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('storageSignedUrl', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('returns 500 when supabase client is not configured', async () => {
    getClient.mockReturnValue(null);
    const res = makeRes();
    await storageSignedUrl({ body: { bucket: 'b', path: 'p', expiresIn: 3600 } }, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('returns signed URL on success', async () => {
    getClient.mockReturnValue(makeStorageClient());
    const res = makeRes();
    await storageSignedUrl({ body: { bucket: 'b', path: 'p', expiresIn: 3600 } }, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true, data: { signedUrl: 'https://signed.url' } }));
  });

  it('uses default expiresIn of 3600 when not provided', async () => {
    const client = makeStorageClient();
    getClient.mockReturnValue(client);
    const res = makeRes();
    await storageSignedUrl({ body: { bucket: 'b', path: 'p' } }, res);
    expect(client.storage._bucket.createSignedUrl).toHaveBeenCalledWith('p', 3600);
  });

  it('returns 500 on signed URL error', async () => {
    getClient.mockReturnValue(makeStorageClient({ signedUrl: { data: null, error: new Error('failed') } }));
    const res = makeRes();
    await storageSignedUrl({ body: { bucket: 'b', path: 'p' } }, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('storageDelete', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it('returns 500 when supabase client is not configured', async () => {
    getClient.mockReturnValue(null);
    const res = makeRes();
    await storageDelete({ body: { bucket: 'b', path: 'p' } }, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('returns success on delete', async () => {
    getClient.mockReturnValue(makeStorageClient());
    const res = makeRes();
    await storageDelete({ body: { bucket: 'b', path: 'p' } }, res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
  });

  it('returns 500 on delete error', async () => {
    getClient.mockReturnValue(makeStorageClient({ remove: { data: null, error: new Error('delete failed') } }));
    const res = makeRes();
    await storageDelete({ body: { bucket: 'b', path: 'p' } }, res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

// ---------------------------------------------------------------------------
// getLatestAppVersion
// ---------------------------------------------------------------------------

describe('getLatestAppVersion', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  function makeReqVersion(body = {}) {
    return {
      forgeContext: { cloudId: 'cloud-1' },
      body: { platform: 'windows', ...body },
    };
  }

  it('returns 500 when supabase client is not configured', async () => {
    getClient.mockReturnValue(null);
    const res = makeRes();
    await getLatestAppVersion(makeReqVersion(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('returns default version when no release found (PGRST116)', async () => {
    getClient.mockReturnValue(makeSupabaseClient({
      app_releases: { data: null, error: { code: 'PGRST116' } },
    }));
    const res = makeRes();
    await getLatestAppVersion(makeReqVersion(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ latestVersion: '1.0.0', updateAvailable: false }),
    }));
  });

  it('returns 500 on non-PGRST116 DB error', async () => {
    getClient.mockReturnValue(makeSupabaseClient({
      app_releases: { data: null, error: { code: '42000', message: 'error' } },
    }));
    const res = makeRes();
    await getLatestAppVersion(makeReqVersion(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('returns release with updateAvailable=false when no currentVersion', async () => {
    const release = { version: '2.0.0', download_url: 'https://example.com/app.exe', release_notes: 'notes', is_mandatory: false, min_supported_version: null, file_size_bytes: 1000, published_at: '2026-01-01' };
    getClient.mockReturnValue(makeSupabaseClient({
      app_releases: { data: release, error: null },
    }));
    const res = makeRes();
    await getLatestAppVersion(makeReqVersion(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ latestVersion: '2.0.0', updateAvailable: false }),
    }));
  });

  it('returns updateAvailable=true when current version is older', async () => {
    const release = { version: '2.0.0', download_url: 'https://example.com/app.exe', release_notes: 'notes', is_mandatory: false, min_supported_version: null, file_size_bytes: 1000, published_at: '2026-01-01' };
    getClient.mockReturnValue(makeSupabaseClient({
      app_releases: { data: release, error: null },
    }));
    const res = makeRes();
    await getLatestAppVersion(makeReqVersion({ currentVersion: '1.0.0' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ updateAvailable: true }),
    }));
  });

  it('returns updateAvailable=false when already on latest', async () => {
    const release = { version: '2.0.0', download_url: 'https://example.com/app.exe', release_notes: null, is_mandatory: false, min_supported_version: null, file_size_bytes: null, published_at: '2026-01-01' };
    getClient.mockReturnValue(makeSupabaseClient({
      app_releases: { data: release, error: null },
    }));
    const res = makeRes();
    await getLatestAppVersion(makeReqVersion({ currentVersion: '2.0.0' }), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ updateAvailable: false }),
    }));
  });
});

// ---------------------------------------------------------------------------
// createFeedbackSession
// ---------------------------------------------------------------------------

describe('createFeedbackSession', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  function makeReqFeedback(forgeCtx = {}, reqExtras = {}) {
    return {
      forgeContext: { cloudId: 'cloud-1', accountId: 'account-1', ...forgeCtx },
      protocol: 'https',
      get: jest.fn(h => h === 'host' ? 'example.com' : ''),
      ...reqExtras,
    };
  }

  it('returns 400 when cloudId is missing', async () => {
    const res = makeRes();
    await createFeedbackSession(makeReqFeedback({ cloudId: null }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 400 when accountId is missing', async () => {
    const res = makeRes();
    await createFeedbackSession(makeReqFeedback({ accountId: null }), res);
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 500 when supabase client is not configured', async () => {
    getClient.mockReturnValue(null);
    const res = makeRes();
    await createFeedbackSession(makeReqFeedback(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });

  it('returns feedback URL and sessionId on success with known user', async () => {
    getClient.mockReturnValue(makeSupabaseClient({
      users: { data: [{ email: 'user@test.com', display_name: 'Test User' }], error: null },
    }));
    sessionStore.createSession.mockReturnValue('session-abc');
    const res = makeRes();
    await createFeedbackSession(makeReqFeedback(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({
      success: true,
      data: expect.objectContaining({ sessionId: 'session-abc', feedbackUrl: expect.stringContaining('session-abc') }),
    }));
    expect(sessionStore.createSession).toHaveBeenCalledWith(expect.objectContaining({
      cloudId: 'cloud-1',
      userInfo: expect.objectContaining({ email: 'user@test.com' }),
    }));
  });

  it('falls back to generated email when user not found in DB', async () => {
    getClient.mockReturnValue(makeSupabaseClient({
      users: { data: [], error: null },
    }));
    const res = makeRes();
    await createFeedbackSession(makeReqFeedback(), res);
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(sessionStore.createSession).toHaveBeenCalledWith(expect.objectContaining({
      userInfo: expect.objectContaining({ email: 'account-1@atlassian.user' }),
    }));
  });

  it('logs userError but continues when user DB query fails', async () => {
    const logger = require('../../src/utils/logger');
    getClient.mockReturnValue(makeSupabaseClient({
      users: { data: null, error: new Error('user query failed') },
    }));
    const res = makeRes();
    await createFeedbackSession(makeReqFeedback(), res);
    // Should still succeed — userError is logged but not thrown
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
    expect(logger.error).toHaveBeenCalledWith(
      '[ForgeProxy] Error fetching user for feedback:',
      expect.any(Error)
    );
  });

  it('returns 500 on unexpected error', async () => {
    getClient.mockImplementation(() => { throw new Error('crash'); });
    const res = makeRes();
    await createFeedbackSession(makeReqFeedback(), res);
    expect(res.status).toHaveBeenCalledWith(500);
  });
});
