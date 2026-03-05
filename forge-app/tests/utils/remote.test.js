'use strict';

// ---------------------------------------------------------------------------
// Module mocks — jest.mock() calls are hoisted before all imports/requires.
// Variables whose names start with "mock" are also hoisted by babel-jest so
// they can be referenced safely inside the factory functions.
// ---------------------------------------------------------------------------

jest.mock('@forge/api', () => {
  // Shared requestJira mock so all test code can reference the same instance.
  const requestJira = jest.fn();
  return {
    __esModule: true,
    default: { asApp: jest.fn(() => ({ requestJira })) },
    invokeRemote: jest.fn(),
    // Minimal tagged-template implementation — returns the interpolated string.
    route: (strings, ...vals) =>
      strings.reduce((acc, s, i) => acc + s + (vals[i] ?? ''), ''),
    // Expose the inner mock so tests can configure it via the module handle.
    _requestJira: requestJira,
  };
});

jest.mock('../../src/utils/cache.js', () => ({
  getFromCache: jest.fn(),
  setInCache: jest.fn(),
  TTL: {
    USER_ID: 300000,
    ORGANIZATION: 600000,
    CONFIG: 900000,
    MEMBERSHIP: 300000,
    GROUPS: 30000,
  },
  CacheKeys: {
    userId: (id) => `user:${id}`,
    organization: (id) => `org:${id}`,
    supabaseConfig: (id) => `config:${id}`,
    membership: (uid, oid) => `membership:${uid}:${oid}`,
    unassignedGroups: (uid, oid) => `groups:${uid}:${oid}`,
  },
}));

// ---------------------------------------------------------------------------
// Grab the mock handles after jest.mock has been registered.
// ---------------------------------------------------------------------------
const forgeApi = require('@forge/api');
const { invokeRemote, _requestJira: requestJira } = forgeApi;

const { getFromCache, setInCache } = require('../../src/utils/cache.js');

const {
  supabaseQuery,
  getOrCreateOrganization,
  getOrCreateUser,
  getOrganizationMembership,
  uploadToStorage,
  generateSignedUrl,
  deleteFromStorage,
  fetchDashboardData,
  getLatestAppVersion,
  createFeedbackSession,
  submitFeedback,
  getFeedbackStatus,
  remoteRequest,
} = require('../../src/utils/remote.js');

// ---------------------------------------------------------------------------
// Response builder helpers
// ---------------------------------------------------------------------------

/**
 * Successful invokeRemote response that goes through remoteRequest's
 * success/data wrapper.
 */
const makeOkResponse = (data) => ({
  ok: true,
  status: 200,
  json: jest.fn().mockResolvedValue({ success: true, data }),
  text: jest.fn().mockResolvedValue(''),
});

/**
 * Non-ok HTTP response (used by remoteRequest error handling).
 */
const makeErrResponse = (status, body = 'error text') => ({
  ok: false,
  status,
  json: jest.fn().mockResolvedValue({}),
  text: jest.fn().mockResolvedValue(body),
});

/**
 * Raw invokeRemote response for functions that call invokeRemote directly
 * (submitFeedback, getFeedbackStatus) without the success/data wrapper.
 */
const makeRawResponse = (body, ok = true, status = 200) => ({
  ok,
  status,
  json: jest.fn().mockResolvedValue(body),
  text: jest.fn().mockResolvedValue(
    typeof body === 'string' ? body : JSON.stringify(body)
  ),
});

/**
 * Jira REST API response for api.asApp().requestJira() calls.
 */
const makeJiraResponse = (body, ok = true) => ({
  ok,
  json: jest.fn().mockResolvedValue(body),
  text: jest.fn().mockResolvedValue(JSON.stringify(body)),
});

// ---------------------------------------------------------------------------
// Global setup
// ---------------------------------------------------------------------------
beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  // Default: cache miss for every test; individual tests override as needed.
  getFromCache.mockReturnValue(null);
});

afterEach(() => {
  jest.useRealTimers();
});

// ============================================================================
// remoteRequest
// ============================================================================
describe('remoteRequest', () => {
  it('makes a POST request to the correct endpoint and returns result.data', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({ id: 1 }));
    const result = await remoteRequest('/api/test');
    expect(result).toEqual({ id: 1 });
    expect(invokeRemote).toHaveBeenCalledWith(
      'ai-server',
      expect.objectContaining({ path: '/api/test', method: 'POST' })
    );
  });

  it('serialises body to JSON string', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({}));
    await remoteRequest('/api/test', { body: { key: 'val' } });
    const [, opts] = invokeRemote.mock.calls[0];
    expect(opts.body).toBe(JSON.stringify({ key: 'val' }));
  });

  it('omits body property when no body is provided', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({}));
    await remoteRequest('/api/test');
    const [, opts] = invokeRemote.mock.calls[0];
    expect(opts.body).toBeUndefined();
  });

  it('uses GET method when specified in options', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({}));
    await remoteRequest('/api/test', { method: 'GET' });
    expect(invokeRemote).toHaveBeenCalledWith(
      'ai-server',
      expect.objectContaining({ method: 'GET' })
    );
  });

  it('merges custom headers with Content-Type', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({}));
    await remoteRequest('/api/test', { headers: { 'X-Custom': 'val' } });
    const [, opts] = invokeRemote.mock.calls[0];
    expect(opts.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-Custom': 'val',
    });
  });

  it('throws immediately on non-retryable 400 error', async () => {
    invokeRemote.mockResolvedValue(makeErrResponse(400, 'Bad request'));
    await expect(remoteRequest('/api/test')).rejects.toThrow(
      'Remote request failed: Bad request'
    );
    expect(invokeRemote).toHaveBeenCalledTimes(1);
  });

  it('throws immediately on non-retryable 403 error', async () => {
    invokeRemote.mockResolvedValue(makeErrResponse(403, 'Forbidden'));
    await expect(remoteRequest('/api/test')).rejects.toThrow(
      'Remote request failed: Forbidden'
    );
    expect(invokeRemote).toHaveBeenCalledTimes(1);
  });

  it('retries on 401 and succeeds on the second attempt', async () => {
    invokeRemote
      .mockResolvedValueOnce(makeErrResponse(401))
      .mockResolvedValueOnce(makeOkResponse({ retried: true }));

    const [result] = await Promise.all([
      remoteRequest('/api/test'),
      jest.runAllTimersAsync(),
    ]);

    expect(result).toEqual({ retried: true });
    expect(invokeRemote).toHaveBeenCalledTimes(2);
  });

  it('retries on 500 and succeeds on the second attempt', async () => {
    invokeRemote
      .mockResolvedValueOnce(makeErrResponse(500))
      .mockResolvedValueOnce(makeOkResponse({ recovered: true }));

    const [result] = await Promise.all([
      remoteRequest('/api/test'),
      jest.runAllTimersAsync(),
    ]);

    expect(result).toEqual({ recovered: true });
    expect(invokeRemote).toHaveBeenCalledTimes(2);
  });

  it('exhausts MAX_RETRIES (3 total attempts) and throws on persistent 500', async () => {
    invokeRemote.mockResolvedValue(makeErrResponse(500, 'Server down'));

    await expect(
      Promise.all([remoteRequest('/api/test'), jest.runAllTimersAsync()])
    ).rejects.toThrow('Remote request failed: Server down');

    expect(invokeRemote).toHaveBeenCalledTimes(3); // attempt 0, 1, 2
  });

  it('retries on "Authentication failed" network error', async () => {
    invokeRemote
      .mockRejectedValueOnce(new Error('Authentication failed'))
      .mockResolvedValueOnce(makeOkResponse({ retried: true }));

    const [result] = await Promise.all([
      remoteRequest('/api/test'),
      jest.runAllTimersAsync(),
    ]);

    expect(result).toEqual({ retried: true });
  });

  it('retries on ETIMEDOUT network error', async () => {
    invokeRemote
      .mockRejectedValueOnce(new Error('ETIMEDOUT'))
      .mockResolvedValueOnce(makeOkResponse({}));

    await Promise.all([remoteRequest('/api/test'), jest.runAllTimersAsync()]);
    expect(invokeRemote).toHaveBeenCalledTimes(2);
  });

  it('retries on ECONNRESET network error', async () => {
    invokeRemote
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(makeOkResponse({}));

    await Promise.all([remoteRequest('/api/test'), jest.runAllTimersAsync()]);
    expect(invokeRemote).toHaveBeenCalledTimes(2);
  });

  it('retries on "fetch failed" network error', async () => {
    invokeRemote
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce(makeOkResponse({}));

    await Promise.all([remoteRequest('/api/test'), jest.runAllTimersAsync()]);
    expect(invokeRemote).toHaveBeenCalledTimes(2);
  });

  it('throws a non-retryable network error without retrying', async () => {
    invokeRemote.mockRejectedValue(new Error('Permission denied'));
    await expect(remoteRequest('/api/test')).rejects.toThrow('Permission denied');
    expect(invokeRemote).toHaveBeenCalledTimes(1);
  });

  it('throws result.error when result.success is false', async () => {
    invokeRemote.mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({ success: false, error: 'Business error' }),
      text: jest.fn(),
    });
    await expect(remoteRequest('/api/test')).rejects.toThrow('Business error');
  });

  it('throws "Unknown error from remote" when success is false and error is absent', async () => {
    invokeRemote.mockResolvedValue({
      ok: true,
      status: 200,
      json: jest.fn().mockResolvedValue({ success: false }),
      text: jest.fn(),
    });
    await expect(remoteRequest('/api/test')).rejects.toThrow(
      'Unknown error from remote'
    );
  });
});

// ============================================================================
// supabaseQuery
// ============================================================================
describe('supabaseQuery', () => {
  it('calls the correct endpoint with the expected body structure', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({ rows: [] }));
    const result = await supabaseQuery('users', { method: 'GET', select: 'id,name' });
    expect(result).toEqual({ rows: [] });
    const [, opts] = invokeRemote.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body).toMatchObject({ table: 'users', method: 'GET', select: 'id,name' });
  });

  it('defaults method to GET when not provided', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({}));
    await supabaseQuery('projects');
    const [, opts] = invokeRemote.mock.calls[0];
    expect(JSON.parse(opts.body).method).toBe('GET');
  });

  it('forwards body and query options', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({}));
    await supabaseQuery('records', { method: 'POST', body: { name: 'test' }, query: { id: 1 } });
    const [, opts] = invokeRemote.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.body).toEqual({ name: 'test' });
    expect(body.query).toEqual({ id: 1 });
  });
});

// ============================================================================
// fetchDashboardData
// ============================================================================
describe('fetchDashboardData', () => {
  it('returns cached data without hitting the network', async () => {
    const cached = { users: [], issues: [] };
    getFromCache.mockReturnValue(cached);
    const result = await fetchDashboardData({});
    expect(result).toBe(cached);
    expect(invokeRemote).not.toHaveBeenCalled();
  });

  it('uses ":all" cache-key suffix when projectKeys is undefined', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({}));
    await fetchDashboardData({});
    expect(getFromCache).toHaveBeenCalledWith('dashboard:batch:all');
    expect(setInCache).toHaveBeenCalledWith('dashboard:batch:all', expect.anything(), 30000);
  });

  it('uses ":all" cache-key suffix when projectKeys is null', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({}));
    await fetchDashboardData({ projectKeys: null });
    expect(getFromCache).toHaveBeenCalledWith('dashboard:batch:all');
  });

  it('uses ":none" cache-key suffix when projectKeys is an empty array', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({}));
    await fetchDashboardData({ projectKeys: [] });
    expect(getFromCache).toHaveBeenCalledWith('dashboard:batch:none');
  });

  it('uses alphabetically sorted keys in the cache-key suffix', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({}));
    await fetchDashboardData({ projectKeys: ['ZAP', 'ATG', 'BRD'] });
    expect(getFromCache).toHaveBeenCalledWith('dashboard:batch:ATG,BRD,ZAP');
  });

  it('passes the correct options to remoteRequest', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({}));
    await fetchDashboardData({
      canViewAllUsers: true,
      isJiraAdmin: true,
      projectKeys: ['ATG'],
      maxDailySummaryDays: 14,
      maxWeeklySummaryWeeks: 8,
      maxIssuesInAnalytics: 25,
    });
    const [, opts] = invokeRemote.mock.calls[0];
    expect(JSON.parse(opts.body)).toMatchObject({
      canViewAllUsers: true,
      isJiraAdmin: true,
      projectKeys: ['ATG'],
      maxDailySummaryDays: 14,
      maxWeeklySummaryWeeks: 8,
      maxIssuesInAnalytics: 25,
    });
  });

  it('preserves empty projectKeys array (does not coerce to null)', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({}));
    await fetchDashboardData({ projectKeys: [] });
    const [, opts] = invokeRemote.mock.calls[0];
    expect(JSON.parse(opts.body).projectKeys).toEqual([]);
  });

  it('applies default values for omitted numeric options', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({}));
    await fetchDashboardData({});
    const [, opts] = invokeRemote.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.maxDailySummaryDays).toBe(30);
    expect(body.maxWeeklySummaryWeeks).toBe(12);
    expect(body.maxIssuesInAnalytics).toBe(50);
  });

  it('caches the result for 30 seconds', async () => {
    const data = { users: [1] };
    invokeRemote.mockResolvedValue(makeOkResponse(data));
    await fetchDashboardData({});
    expect(setInCache).toHaveBeenCalledWith('dashboard:batch:all', data, 30000);
  });
});

// ============================================================================
// getOrCreateOrganization
// ============================================================================
describe('getOrCreateOrganization', () => {
  it('returns cached org without a network call', async () => {
    const cachedOrg = { id: 'org-1', name: 'Test' };
    getFromCache.mockReturnValue(cachedOrg);
    const result = await getOrCreateOrganization('cloud-1');
    expect(result).toBe(cachedOrg);
    expect(invokeRemote).not.toHaveBeenCalled();
  });

  it('deduplicates concurrent requests for the same cloudId', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({ id: 'org-1' }));
    const [r1, r2] = await Promise.all([
      getOrCreateOrganization('cloud-dup', 'Org', 'https://example.com'),
      getOrCreateOrganization('cloud-dup', 'Org', 'https://example.com'),
    ]);
    expect(invokeRemote).toHaveBeenCalledTimes(1);
    expect(r1).toEqual(r2);
  });

  it('skips Jira API fetch when both orgName and jiraUrl are provided', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({ id: 'org-1' }));
    await getOrCreateOrganization('cloud-1', 'MyOrg', 'https://example.atlassian.net');
    expect(requestJira).not.toHaveBeenCalled();
  });

  it('fetches Jira site info when orgName is null', async () => {
    requestJira.mockResolvedValue(
      makeJiraResponse({ baseUrl: 'https://co.atlassian.net', serverTitle: 'MyCo' })
    );
    invokeRemote.mockResolvedValue(makeOkResponse({ id: 'org-1' }));
    await getOrCreateOrganization('cloud-1', null, null);
    expect(requestJira).toHaveBeenCalledTimes(1);
  });

  it('fetches Jira site info when jiraUrl is null', async () => {
    requestJira.mockResolvedValue(
      makeJiraResponse({ baseUrl: 'https://co.atlassian.net', serverTitle: 'MyCo' })
    );
    invokeRemote.mockResolvedValue(makeOkResponse({ id: 'org-1' }));
    await getOrCreateOrganization('cloud-1', 'Provided Name', null);
    expect(requestJira).toHaveBeenCalledTimes(1);
  });

  it('uses URL subdomain as site name when serverTitle is the generic "Jira"', async () => {
    requestJira.mockResolvedValue(
      makeJiraResponse({ baseUrl: 'https://mycompany.atlassian.net', serverTitle: 'Jira' })
    );
    invokeRemote.mockResolvedValue(makeOkResponse({ id: 'org-1' }));
    await getOrCreateOrganization('cloud-1');
    const [, opts] = invokeRemote.mock.calls[0];
    expect(JSON.parse(opts.body).orgName).toBe('mycompany');
  });

  it('uses URL subdomain when serverTitle is "Jira Software"', async () => {
    requestJira.mockResolvedValue(
      makeJiraResponse({ baseUrl: 'https://acme.atlassian.net', serverTitle: 'Jira Software' })
    );
    invokeRemote.mockResolvedValue(makeOkResponse({ id: 'org-1' }));
    await getOrCreateOrganization('cloud-1');
    const [, opts] = invokeRemote.mock.calls[0];
    expect(JSON.parse(opts.body).orgName).toBe('acme');
  });

  it('uses serverTitle when it is not a generic Jira name', async () => {
    requestJira.mockResolvedValue(
      makeJiraResponse({ baseUrl: 'https://jira.example.com', serverTitle: 'Acme Corp' })
    );
    invokeRemote.mockResolvedValue(makeOkResponse({ id: 'org-1' }));
    await getOrCreateOrganization('cloud-1');
    const [, opts] = invokeRemote.mock.calls[0];
    expect(JSON.parse(opts.body).orgName).toBe('Acme Corp');
  });

  it('leaves orgName and jiraUrl as null when Jira API returns non-ok', async () => {
    requestJira.mockResolvedValue(makeJiraResponse({}, false));
    invokeRemote.mockResolvedValue(makeOkResponse({ id: 'org-1' }));
    await getOrCreateOrganization('cloud-1');
    const [, opts] = invokeRemote.mock.calls[0];
    const body = JSON.parse(opts.body);
    expect(body.orgName).toBeNull();
    expect(body.jiraUrl).toBeNull();
  });

  it('continues without Jira info when requestJira throws', async () => {
    requestJira.mockRejectedValue(new Error('API unavailable'));
    invokeRemote.mockResolvedValue(makeOkResponse({ id: 'org-1' }));
    await getOrCreateOrganization('cloud-1');
    expect(invokeRemote).toHaveBeenCalledTimes(1);
  });

  it('caches the org with ORGANIZATION TTL', async () => {
    const org = { id: 'org-1' };
    invokeRemote.mockResolvedValue(makeOkResponse(org));
    await getOrCreateOrganization('cloud-1', 'Org', 'https://example.com');
    expect(setInCache).toHaveBeenCalledWith('org:cloud-1', org, 600000);
  });

  it('throws when the remote request fails', async () => {
    invokeRemote.mockRejectedValue(new Error('Network error'));
    await expect(
      getOrCreateOrganization('cloud-err', 'Org', 'https://example.com')
    ).rejects.toThrow('Network error');
  });
});

// ============================================================================
// getOrCreateUser
// ============================================================================
describe('getOrCreateUser', () => {
  it('returns cached userId when organizationId matches', async () => {
    getFromCache.mockReturnValue({ userId: 'user-uuid', organizationId: 'org-1' });
    const result = await getOrCreateUser('acc-1', 'org-1');
    expect(result).toBe('user-uuid');
    expect(invokeRemote).not.toHaveBeenCalled();
  });

  it('fetches when cached organizationId does not match', async () => {
    getFromCache.mockReturnValue({ userId: 'old-uuid', organizationId: 'org-OLD' });
    invokeRemote.mockResolvedValue(makeOkResponse({ userId: 'new-uuid' }));
    const result = await getOrCreateUser('acc-1', 'org-NEW');
    expect(result).toBe('new-uuid');
  });

  it('fetches when cache is null', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({ userId: 'user-abc' }));
    const result = await getOrCreateUser('acc-1', 'org-1');
    expect(result).toBe('user-abc');
  });

  it('sends organizationId, email, and displayName in the request body', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({ userId: 'u1' }));
    await getOrCreateUser('acc-1', 'org-1', 'user@test.com', 'Alice');
    const [, opts] = invokeRemote.mock.calls[0];
    expect(JSON.parse(opts.body)).toMatchObject({
      organizationId: 'org-1',
      email: 'user@test.com',
      displayName: 'Alice',
    });
  });

  it('caches the userId with USER_ID TTL', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({ userId: 'u1' }));
    await getOrCreateUser('acc-1', 'org-1');
    expect(setInCache).toHaveBeenCalledWith(
      'user:acc-1',
      { userId: 'u1', organizationId: 'org-1' },
      300000
    );
  });

  it('throws when remoteRequest fails', async () => {
    invokeRemote.mockRejectedValue(new Error('Server error'));
    await expect(getOrCreateUser('acc-1', 'org-1')).rejects.toThrow('Server error');
  });
});

// ============================================================================
// getOrganizationMembership
// ============================================================================
describe('getOrganizationMembership', () => {
  it('returns membership data on success', async () => {
    const membership = { role: 'admin', status: 'active' };
    invokeRemote.mockResolvedValue(makeOkResponse(membership));
    const result = await getOrganizationMembership('user-1', 'org-1');
    expect(result).toEqual(membership);
  });

  it('returns null (does not throw) when remoteRequest fails', async () => {
    invokeRemote.mockRejectedValue(new Error('Unauthorized'));
    const result = await getOrganizationMembership('user-1', 'org-1');
    expect(result).toBeNull();
  });
});

// ============================================================================
// uploadToStorage
// ============================================================================
describe('uploadToStorage', () => {
  it('converts Buffer data to base64 before sending', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({ path: 'test/file.png' }));
    const buffer = Buffer.from('hello world');
    await uploadToStorage('images', 'test/file.png', buffer, 'image/png');
    const [, opts] = invokeRemote.mock.calls[0];
    expect(JSON.parse(opts.body).data).toBe(buffer.toString('base64'));
  });

  it('passes a string directly without re-encoding', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({}));
    const b64 = 'SGVsbG8=';
    await uploadToStorage('images', 'file.txt', b64, 'text/plain');
    const [, opts] = invokeRemote.mock.calls[0];
    expect(JSON.parse(opts.body).data).toBe(b64);
  });

  it('includes bucket, path, and contentType in the request body', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({}));
    await uploadToStorage('my-bucket', 'path/to/file', 'data', 'application/pdf');
    const [, opts] = invokeRemote.mock.calls[0];
    expect(JSON.parse(opts.body)).toMatchObject({
      bucket: 'my-bucket',
      path: 'path/to/file',
      contentType: 'application/pdf',
    });
  });
});

// ============================================================================
// generateSignedUrl
// ============================================================================
describe('generateSignedUrl', () => {
  it('returns the signedUrl from the remote response', async () => {
    invokeRemote.mockResolvedValue(
      makeOkResponse({ signedUrl: 'https://cdn.example.com/file?token=abc' })
    );
    const url = await generateSignedUrl('images', 'photo.jpg');
    expect(url).toBe('https://cdn.example.com/file?token=abc');
  });

  it('uses the default expiresIn of 3600 seconds', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({ signedUrl: 'https://example.com' }));
    await generateSignedUrl('images', 'photo.jpg');
    const [, opts] = invokeRemote.mock.calls[0];
    expect(JSON.parse(opts.body).expiresIn).toBe(3600);
  });

  it('accepts a custom expiresIn value', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({ signedUrl: 'https://example.com' }));
    await generateSignedUrl('images', 'photo.jpg', 7200);
    const [, opts] = invokeRemote.mock.calls[0];
    expect(JSON.parse(opts.body).expiresIn).toBe(7200);
  });
});

// ============================================================================
// deleteFromStorage
// ============================================================================
describe('deleteFromStorage', () => {
  it('calls the correct endpoint with bucket and path', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({}));
    await deleteFromStorage('my-bucket', 'path/to/delete');
    expect(invokeRemote).toHaveBeenCalledWith(
      'ai-server',
      expect.objectContaining({ path: '/api/forge/storage/delete' })
    );
    const [, opts] = invokeRemote.mock.calls[0];
    expect(JSON.parse(opts.body)).toMatchObject({
      bucket: 'my-bucket',
      path: 'path/to/delete',
    });
  });
});

// ============================================================================
// getLatestAppVersion
// ============================================================================
describe('getLatestAppVersion', () => {
  it('returns cached result without re-fetching', async () => {
    const cached = { latestVersion: '2.0.0', updateAvailable: false };
    getFromCache.mockReturnValue(cached);
    const result = await getLatestAppVersion({ platform: 'windows' });
    expect(result).toBe(cached);
    expect(invokeRemote).not.toHaveBeenCalled();
  });

  it('recalculates updateAvailable=true when the latest is newer than current', async () => {
    const cached = { latestVersion: '2.0.0', updateAvailable: false, currentVersion: '1.0.0' };
    getFromCache.mockReturnValue(cached);
    const result = await getLatestAppVersion({ platform: 'windows', currentVersion: '1.5.0' });
    expect(result.updateAvailable).toBe(true);
    expect(result.currentVersion).toBe('1.5.0');
  });

  it('recalculates updateAvailable=false when already on the latest version', async () => {
    const cached = { latestVersion: '2.0.0', updateAvailable: true, currentVersion: '1.0.0' };
    getFromCache.mockReturnValue(cached);
    const result = await getLatestAppVersion({ platform: 'windows', currentVersion: '2.0.0' });
    expect(result.updateAvailable).toBe(false);
  });

  it('recalculates updateAvailable=false when current is newer than latest', async () => {
    const cached = { latestVersion: '1.0.0', updateAvailable: false };
    getFromCache.mockReturnValue(cached);
    const result = await getLatestAppVersion({ platform: 'windows', currentVersion: '2.0.0' });
    expect(result.updateAvailable).toBe(false);
  });

  it('skips recalculation when cache hit but currentVersion is not provided', async () => {
    const cached = { latestVersion: '2.0.0', updateAvailable: false };
    getFromCache.mockReturnValue(cached);
    const result = await getLatestAppVersion({ platform: 'windows' });
    expect(result.updateAvailable).toBe(false);
    expect(invokeRemote).not.toHaveBeenCalled();
  });

  it('fetches fresh version data on cache miss', async () => {
    const versionData = { latestVersion: '3.0.0', updateAvailable: false };
    invokeRemote.mockResolvedValue(makeOkResponse(versionData));
    const result = await getLatestAppVersion({ platform: 'mac' });
    expect(result).toEqual(versionData);
    expect(invokeRemote).toHaveBeenCalledTimes(1);
  });

  it('defaults platform to "windows" in the request body', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({}));
    await getLatestAppVersion({});
    const [, opts] = invokeRemote.mock.calls[0];
    expect(JSON.parse(opts.body).platform).toBe('windows');
  });

  it('caches the result for 5 minutes (300 000 ms)', async () => {
    const versionData = { latestVersion: '2.0.0' };
    invokeRemote.mockResolvedValue(makeOkResponse(versionData));
    await getLatestAppVersion({ platform: 'windows' });
    expect(setInCache).toHaveBeenCalledWith('app-version:windows', versionData, 300000);
  });
});

// ============================================================================
// createFeedbackSession
// ============================================================================
describe('createFeedbackSession', () => {
  it('returns the feedbackUrl from the remote response', async () => {
    invokeRemote.mockResolvedValue(
      makeOkResponse({ feedbackUrl: 'https://feedback.example.com?session=xyz' })
    );
    const url = await createFeedbackSession();
    expect(url).toBe('https://feedback.example.com?session=xyz');
  });

  it('calls the feedback/session endpoint', async () => {
    invokeRemote.mockResolvedValue(makeOkResponse({ feedbackUrl: 'https://example.com' }));
    await createFeedbackSession();
    expect(invokeRemote).toHaveBeenCalledWith(
      'ai-server',
      expect.objectContaining({ path: '/api/forge/feedback/session' })
    );
  });
});

// ============================================================================
// submitFeedback
// ============================================================================
describe('submitFeedback', () => {
  const feedbackUrl = 'https://feedback.example.com?session=session-abc-123';

  it('creates a session, extracts the sessionId, and submits feedback', async () => {
    invokeRemote
      // First call: createFeedbackSession → remoteRequest
      .mockResolvedValueOnce(makeOkResponse({ feedbackUrl }))
      // Second call: direct invokeRemote POST to /api/feedback/submit
      .mockResolvedValueOnce(makeRawResponse({ feedbackId: 'fb-1' }));

    const result = await submitFeedback({
      category: 'bug',
      title: 'Test bug',
      description: 'Something broke',
      images: ['base64img'],
    });

    expect(result).toEqual({ feedbackId: 'fb-1' });
    expect(invokeRemote).toHaveBeenCalledTimes(2);

    const [, submitOpts] = invokeRemote.mock.calls[1];
    const body = JSON.parse(submitOpts.body);
    expect(body).toMatchObject({
      session_id: 'session-abc-123',
      category: 'bug',
      title: 'Test bug',
      description: 'Something broke',
      images: ['base64img'],
      app_version: 'forge-in-app',
    });
  });

  it('defaults title to empty string when not provided', async () => {
    invokeRemote
      .mockResolvedValueOnce(makeOkResponse({ feedbackUrl }))
      .mockResolvedValueOnce(makeRawResponse({ feedbackId: 'fb-2' }));

    await submitFeedback({ category: 'feature', description: 'Add X' });

    const [, submitOpts] = invokeRemote.mock.calls[1];
    expect(JSON.parse(submitOpts.body).title).toBe('');
  });

  it('defaults images to empty array when not provided', async () => {
    invokeRemote
      .mockResolvedValueOnce(makeOkResponse({ feedbackUrl }))
      .mockResolvedValueOnce(makeRawResponse({ feedbackId: 'fb-3' }));

    await submitFeedback({ category: 'bug', description: 'x' });

    const [, submitOpts] = invokeRemote.mock.calls[1];
    expect(JSON.parse(submitOpts.body).images).toEqual([]);
  });

  it('throws when the session URL has no "session" query parameter', async () => {
    invokeRemote.mockResolvedValueOnce(
      makeOkResponse({ feedbackUrl: 'https://feedback.example.com' }) // no ?session=
    );
    await expect(submitFeedback({ category: 'bug', description: 'x' })).rejects.toThrow(
      'Could not extract session ID from feedback URL'
    );
  });

  it('throws when the submit response is not ok', async () => {
    invokeRemote
      .mockResolvedValueOnce(makeOkResponse({ feedbackUrl }))
      .mockResolvedValueOnce(makeRawResponse('Submission failed', false, 500));

    await expect(submitFeedback({ category: 'bug', description: 'x' })).rejects.toThrow(
      'Failed to submit feedback: Submission failed'
    );
  });
});

// ============================================================================
// getFeedbackStatus
// ============================================================================
describe('getFeedbackStatus', () => {
  it('returns the status object on success', async () => {
    const statusData = { jira_issue_key: 'ATG-100', status: 'created' };
    invokeRemote.mockResolvedValue(makeRawResponse(statusData));
    const result = await getFeedbackStatus('feedback-uuid');
    expect(result).toEqual(statusData);
    expect(invokeRemote).toHaveBeenCalledWith(
      'ai-server',
      expect.objectContaining({
        path: '/api/feedback/status/feedback-uuid',
        method: 'GET',
      })
    );
  });

  it('throws when the response is not ok', async () => {
    invokeRemote.mockResolvedValue(makeRawResponse('Not found', false, 404));
    await expect(getFeedbackStatus('bad-id')).rejects.toThrow(
      'Failed to check feedback status: Not found'
    );
  });
});
