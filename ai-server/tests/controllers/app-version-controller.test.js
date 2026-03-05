'use strict';

// ---------------------------------------------------------------------------
// Mock dependencies before requiring the controller
// ---------------------------------------------------------------------------

jest.mock('../../src/utils/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
}));

const mockGetClient = jest.fn();

jest.mock('../../src/services/db/supabase-client', () => ({
  getClient: mockGetClient,
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------

const https = require('https');
const {
  computeChecksum,
  isNewerVersion,
  getLatestVersion,
  checkForUpdate,
  getAllReleases,
  createRelease,
} = require('../../src/controllers/app-version-controller');

// ---------------------------------------------------------------------------
// Helpers — mock Express req/res
// ---------------------------------------------------------------------------

function makeRes() {
  const res = {
    _status: 200,
    _body: null,
    status(code) { this._status = code; return this; },
    json(body) { this._body = body; return this; },
  };
  return res;
}

/**
 * Create a mock Supabase query chain.
 * All chaining methods return `this`. The object is also await-able
 * (implements `.then`) so that `await query` resolves to `result`.
 */
function makeMockQuery(result) {
  const q = {
    _result: result,
    from: jest.fn().mockReturnThis(),
    select: jest.fn().mockReturnThis(),
    eq: jest.fn().mockReturnThis(),
    order: jest.fn().mockReturnThis(),
    insert: jest.fn().mockReturnThis(),
    single: jest.fn().mockResolvedValue(result),
    // Make the query itself await-able (for getAllReleases which awaits the chain directly)
    then(onFulfilled, onRejected) {
      return Promise.resolve(this._result).then(onFulfilled, onRejected);
    },
    catch(onRejected) {
      return Promise.resolve(this._result).catch(onRejected);
    },
  };
  return q;
}

// ---------------------------------------------------------------------------
// isNewerVersion — pure exported function
// ---------------------------------------------------------------------------

describe('isNewerVersion', () => {
  it('returns true when major version is higher', () => {
    expect(isNewerVersion('2.0.0', '1.9.9')).toBe(true);
  });

  it('returns true when minor version is higher', () => {
    expect(isNewerVersion('1.2.0', '1.1.9')).toBe(true);
  });

  it('returns true when patch version is higher', () => {
    expect(isNewerVersion('1.0.2', '1.0.1')).toBe(true);
  });

  it('returns false when versions are equal', () => {
    expect(isNewerVersion('1.2.3', '1.2.3')).toBe(false);
  });

  it('returns false when v1 is lower (major)', () => {
    expect(isNewerVersion('0.9.9', '1.0.0')).toBe(false);
  });

  it('returns false when v1 is lower (minor)', () => {
    expect(isNewerVersion('1.0.9', '1.1.0')).toBe(false);
  });

  it('returns false when v1 is lower (patch)', () => {
    expect(isNewerVersion('1.2.2', '1.2.3')).toBe(false);
  });

  it('handles missing patch segment (treats as 0)', () => {
    expect(isNewerVersion('1.1', '1.0')).toBe(true);
    expect(isNewerVersion('1.0', '1.1')).toBe(false);
  });

  it('handles single-segment versions', () => {
    expect(isNewerVersion('2', '1')).toBe(true);
    expect(isNewerVersion('1', '2')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// computeChecksum — exercises validateDownloadUrl (SSRF fix)
// ---------------------------------------------------------------------------

describe('computeChecksum', () => {
  let res;

  beforeEach(() => {
    res = makeRes();
    jest.clearAllMocks();
  });

  // ── missing URL ───────────────────────────────────────────────────────────

  it('returns 400 when url is missing from body', async () => {
    const req = { body: {} };
    await computeChecksum(req, res);
    expect(res._status).toBe(400);
    expect(res._body.success).toBe(false);
    expect(res._body.error).toBe('URL is required');
  });

  it('returns 400 when body is empty', async () => {
    const req = { body: {} };
    await computeChecksum(req, res);
    expect(res._status).toBe(400);
  });

  // ── validateDownloadUrl — invalid format ──────────────────────────────────

  it('returns 400 for a malformed URL', async () => {
    const req = { body: { url: 'not-a-url' } };
    await computeChecksum(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toContain('Invalid URL format');
  });

  it('returns 400 for an empty string URL', async () => {
    const req = { body: { url: '' } };
    await computeChecksum(req, res);
    // empty string url is falsy → "URL is required"
    expect(res._status).toBe(400);
  });

  // ── validateDownloadUrl — protocol check ─────────────────────────────────

  it('returns 400 for HTTP URL (non-HTTPS)', async () => {
    const req = { body: { url: 'http://github.com/release.exe' } };
    await computeChecksum(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toContain('Only HTTPS URLs are allowed');
  });

  it('returns 400 for FTP URL', async () => {
    const req = { body: { url: 'ftp://github.com/file' } };
    await computeChecksum(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toContain('Only HTTPS URLs are allowed');
  });

  // ── validateDownloadUrl — allowlist domain check ──────────────────────────

  it('returns 400 for a domain not in the allowlist', async () => {
    const req = { body: { url: 'https://evil.com/malware.exe' } };
    await computeChecksum(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toContain('Download domain not in allowed list');
    expect(res._body.error).toContain('evil.com');
  });

  it('returns 400 for a domain that partially matches but is not a subdomain (evil prefix)', async () => {
    // evilgithub.com is NOT a subdomain of github.com
    const req = { body: { url: 'https://evilgithub.com/file' } };
    await computeChecksum(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toContain('Download domain not in allowed list');
  });

  it('returns 400 for a domain that has allowed domain as suffix but is not a subdomain', async () => {
    // notgithub.com ≠ subdomain of github.com
    const req = { body: { url: 'https://notgithub.com/file' } };
    await computeChecksum(req, res);
    expect(res._status).toBe(400);
  });

  it('returns 400 for an internal/private IP address', async () => {
    const req = { body: { url: 'https://192.168.1.1/file' } };
    await computeChecksum(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toContain('Download domain not in allowed list');
  });

  it('returns 400 for localhost', async () => {
    const req = { body: { url: 'https://localhost/file' } };
    await computeChecksum(req, res);
    expect(res._status).toBe(400);
  });

  it('returns 400 for 127.0.0.1', async () => {
    const req = { body: { url: 'https://127.0.0.1/file' } };
    await computeChecksum(req, res);
    expect(res._status).toBe(400);
  });

  // ── validateDownloadUrl — allowed domains ─────────────────────────────────

  it('accepts github.com (exact match)', async () => {
    // Mock https.get to return a successful stream
    const EventEmitter = require('events');
    const mockReq = new EventEmitter();
    mockReq.setTimeout = jest.fn();
    const mockResponse = new EventEmitter();
    mockResponse.statusCode = 200;

    jest.spyOn(https, 'get').mockImplementationOnce((url, cb) => {
      cb(mockResponse);
      mockResponse.emit('data', Buffer.from('abc'));
      mockResponse.emit('end');
      return mockReq;
    });

    const req = { body: { url: 'https://github.com/owner/repo/releases/download/v1.0/app.exe' } };
    await computeChecksum(req, res);
    expect(res._body.success).toBe(true);
    expect(res._body.data.algorithm).toBe('SHA256');
    https.get.mockRestore();
  });

  it('accepts subdomain of allowed domain (objects.githubusercontent.com)', async () => {
    const EventEmitter = require('events');
    const mockReq = new EventEmitter();
    mockReq.setTimeout = jest.fn();
    const mockResponse = new EventEmitter();
    mockResponse.statusCode = 200;

    jest.spyOn(https, 'get').mockImplementationOnce((url, cb) => {
      cb(mockResponse);
      mockResponse.emit('data', Buffer.from('data'));
      mockResponse.emit('end');
      return mockReq;
    });

    const req = { body: { url: 'https://objects.githubusercontent.com/path/to/file' } };
    await computeChecksum(req, res);
    expect(res._body.success).toBe(true);
    https.get.mockRestore();
  });

  it('accepts deep subdomain of allowed domain (foo.amazonaws.com)', async () => {
    const EventEmitter = require('events');
    const mockReq = new EventEmitter();
    mockReq.setTimeout = jest.fn();
    const mockResponse = new EventEmitter();
    mockResponse.statusCode = 200;

    jest.spyOn(https, 'get').mockImplementationOnce((url, cb) => {
      cb(mockResponse);
      mockResponse.emit('data', Buffer.from('x'));
      mockResponse.emit('end');
      return mockReq;
    });

    const req = { body: { url: 'https://s3.eu-west-1.amazonaws.com/bucket/file' } };
    await computeChecksum(req, res);
    expect(res._body.success).toBe(true);
    https.get.mockRestore();
  });

  // ── redirect safety ───────────────────────────────────────────────────────

  it('blocks a redirect to a disallowed domain', async () => {
    const EventEmitter = require('events');
    const mockReq = new EventEmitter();
    mockReq.setTimeout = jest.fn();
    const mockResponse = new EventEmitter();
    mockResponse.statusCode = 302;
    mockResponse.headers = { location: 'https://evil.com/malware.exe' };

    jest.spyOn(https, 'get').mockImplementationOnce((url, cb) => {
      cb(mockResponse);
      return mockReq;
    });

    const req = { body: { url: 'https://github.com/redirect' } };
    await computeChecksum(req, res);
    expect(res._status).toBe(500);
    expect(res._body.error).toContain('Redirect blocked');
    https.get.mockRestore();
  });

  // ── HTTP error handling ───────────────────────────────────────────────────

  it('returns 500 when https.get returns non-200 status', async () => {
    const EventEmitter = require('events');
    const mockReq = new EventEmitter();
    mockReq.setTimeout = jest.fn();
    const mockResponse = new EventEmitter();
    mockResponse.statusCode = 404;
    mockResponse.statusMessage = 'Not Found';

    jest.spyOn(https, 'get').mockImplementationOnce((url, cb) => {
      cb(mockResponse);
      return mockReq;
    });

    const req = { body: { url: 'https://github.com/nonexistent' } };
    await computeChecksum(req, res);
    expect(res._status).toBe(500);
    expect(res._body.error).toContain('Failed to compute checksum');
    https.get.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// getLatestVersion
// ---------------------------------------------------------------------------

describe('getLatestVersion', () => {
  let res;

  beforeEach(() => {
    res = makeRes();
    jest.clearAllMocks();
  });

  it('returns 400 for invalid platform', async () => {
    const req = { query: { platform: 'playstation' } };
    await getLatestVersion(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toContain('Invalid platform');
  });

  it('returns 500 when supabase client is not available', async () => {
    mockGetClient.mockReturnValue(null);
    const req = { query: { platform: 'windows' } };
    await getLatestVersion(req, res);
    expect(res._status).toBe(500);
    expect(res._body.error).toBe('Database not configured');
  });

  it('returns default version data when no release found (PGRST116)', async () => {
    const q = makeMockQuery({ data: null, error: { code: 'PGRST116' } });
    mockGetClient.mockReturnValue(q);
    const req = { query: { platform: 'windows' } };
    await getLatestVersion(req, res);
    expect(res._body.success).toBe(true);
    expect(res._body.data.version).toBe('1.0.0');
    expect(res._body.data.downloadUrl).toBeNull();
  });

  it('returns release data when a latest release is found', async () => {
    const release = {
      version: '2.1.0',
      download_url: 'https://github.com/org/repo/releases/v2.1.0/app.exe',
      release_notes: 'Bug fixes',
      is_mandatory: false,
      min_supported_version: '1.5.0',
      file_size_bytes: 1024000,
      checksum: 'abc123',
      published_at: '2026-03-01T00:00:00Z',
    };
    const q = makeMockQuery({ data: release, error: null });
    mockGetClient.mockReturnValue(q);
    const req = { query: { platform: 'windows' } };
    await getLatestVersion(req, res);
    expect(res._body.success).toBe(true);
    expect(res._body.data.version).toBe('2.1.0');
    expect(res._body.data.downloadUrl).toBe(release.download_url);
    expect(res._body.data.checksum).toBe('abc123');
  });

  it('defaults to "windows" platform when not specified', async () => {
    const q = makeMockQuery({ data: null, error: { code: 'PGRST116' } });
    mockGetClient.mockReturnValue(q);
    const req = { query: {} };
    await getLatestVersion(req, res);
    expect(res._body.success).toBe(true);
  });

  it('returns 500 when supabase throws a non-PGRST116 error', async () => {
    const q = makeMockQuery({ data: null, error: { code: '42P01', message: 'table not found' } });
    mockGetClient.mockReturnValue(q);
    const req = { query: { platform: 'windows' } };
    await getLatestVersion(req, res);
    expect(res._status).toBe(500);
    expect(res._body.error).toBe('Failed to get latest version');
  });

  it('accepts platform "macos"', async () => {
    const q = makeMockQuery({ data: null, error: { code: 'PGRST116' } });
    mockGetClient.mockReturnValue(q);
    const req = { query: { platform: 'macos' } };
    await getLatestVersion(req, res);
    expect(res._body.success).toBe(true);
  });

  it('accepts platform "linux"', async () => {
    const q = makeMockQuery({ data: null, error: { code: 'PGRST116' } });
    mockGetClient.mockReturnValue(q);
    const req = { query: { platform: 'linux' } };
    await getLatestVersion(req, res);
    expect(res._body.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// checkForUpdate
// ---------------------------------------------------------------------------

describe('checkForUpdate', () => {
  let res;

  beforeEach(() => {
    res = makeRes();
    jest.clearAllMocks();
  });

  it('returns 400 when current version is missing', async () => {
    const req = { query: { platform: 'windows' } };
    await checkForUpdate(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toContain('Current version is required');
  });

  it('returns 400 for invalid version format', async () => {
    const req = { query: { platform: 'windows', current: '1.2' } };
    await checkForUpdate(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toContain('Invalid version format');
  });

  it('returns 400 for non-numeric version', async () => {
    const req = { query: { platform: 'windows', current: 'abc.def.ghi' } };
    await checkForUpdate(req, res);
    expect(res._status).toBe(400);
  });

  it('returns 500 when supabase client is not available', async () => {
    mockGetClient.mockReturnValue(null);
    const req = { query: { platform: 'windows', current: '1.0.0' } };
    await checkForUpdate(req, res);
    expect(res._status).toBe(500);
    expect(res._body.error).toBe('Database not configured');
  });

  it('returns updateAvailable: false when no release found', async () => {
    const q = makeMockQuery({ data: null, error: { code: 'PGRST116' } });
    mockGetClient.mockReturnValue(q);
    const req = { query: { platform: 'windows', current: '1.0.0' } };
    await checkForUpdate(req, res);
    expect(res._body.success).toBe(true);
    expect(res._body.data.updateAvailable).toBe(false);
  });

  it('returns updateAvailable: true when newer release exists', async () => {
    const release = {
      version: '2.0.0',
      download_url: 'https://github.com/x/y/releases/v2.0.0/app.exe',
      release_notes: 'Major update',
      is_mandatory: true,
      min_supported_version: null,
      file_size_bytes: 50000000,
      checksum: 'def456',
      published_at: '2026-03-01T00:00:00Z',
    };
    const q = makeMockQuery({ data: release, error: null });
    mockGetClient.mockReturnValue(q);
    const req = { query: { platform: 'windows', current: '1.0.0' } };
    await checkForUpdate(req, res);
    expect(res._body.success).toBe(true);
    expect(res._body.data.updateAvailable).toBe(true);
    expect(res._body.data.latestVersion).toBe('2.0.0');
    expect(res._body.data.downloadUrl).toBe(release.download_url);
    expect(res._body.data.checksum).toBe('def456');
  });

  it('returns updateAvailable: false when running same version', async () => {
    const release = {
      version: '1.0.0',
      download_url: 'https://github.com/x/y/releases/v1.0.0/app.exe',
      release_notes: null,
      is_mandatory: false,
      min_supported_version: null,
      file_size_bytes: null,
      checksum: null,
      published_at: '2026-01-01T00:00:00Z',
    };
    const q = makeMockQuery({ data: release, error: null });
    mockGetClient.mockReturnValue(q);
    const req = { query: { platform: 'windows', current: '1.0.0' } };
    await checkForUpdate(req, res);
    expect(res._body.data.updateAvailable).toBe(false);
    expect(res._body.data.downloadUrl).toBeNull();
  });

  it('sets canUpdate based on min_supported_version check', async () => {
    const release = {
      version: '3.0.0',
      download_url: 'https://github.com/x/y/releases/v3.0.0/app.exe',
      release_notes: null,
      is_mandatory: false,
      min_supported_version: '2.0.0', // current 1.0.0 doesn't meet this
      file_size_bytes: null,
      checksum: null,
      published_at: '2026-03-01T00:00:00Z',
    };
    const q = makeMockQuery({ data: release, error: null });
    mockGetClient.mockReturnValue(q);
    const req = { query: { platform: 'windows', current: '1.0.0' } };
    await checkForUpdate(req, res);
    // min_supported_version 2.0.0 > current 1.0.0 → canUpdate: false
    expect(res._body.data.canUpdate).toBe(false);
  });

  it('returns 500 when supabase throws unexpected error', async () => {
    const q = makeMockQuery({ data: null, error: { code: '42000', message: 'query error' } });
    mockGetClient.mockReturnValue(q);
    const req = { query: { platform: 'windows', current: '1.0.0' } };
    await checkForUpdate(req, res);
    expect(res._status).toBe(500);
    expect(res._body.error).toBe('Failed to check for updates');
  });
});

// ---------------------------------------------------------------------------
// getAllReleases
// ---------------------------------------------------------------------------

describe('getAllReleases', () => {
  let res;

  beforeEach(() => {
    res = makeRes();
    jest.clearAllMocks();
  });

  it('returns 500 when supabase client is not available', async () => {
    mockGetClient.mockReturnValue(null);
    const req = { query: { platform: 'windows' } };
    await getAllReleases(req, res);
    expect(res._status).toBe(500);
    expect(res._body.error).toBe('Database not configured');
  });

  it('returns all active releases for a platform', async () => {
    const releases = [
      { id: 1, version: '2.0.0', platform: 'windows', is_active: true },
      { id: 2, version: '1.0.0', platform: 'windows', is_active: true },
    ];
    const q = makeMockQuery({ data: releases, error: null });
    mockGetClient.mockReturnValue(q);
    const req = { query: { platform: 'windows' } };
    await getAllReleases(req, res);
    expect(res._body.success).toBe(true);
    expect(res._body.data).toHaveLength(2);
  });

  it('returns empty array when no releases found', async () => {
    const q = makeMockQuery({ data: null, error: null });
    mockGetClient.mockReturnValue(q);
    const req = { query: { platform: 'windows' } };
    await getAllReleases(req, res);
    expect(res._body.success).toBe(true);
    expect(res._body.data).toEqual([]);
  });

  it('includes inactive releases when includeInactive=true', async () => {
    const q = makeMockQuery({ data: [{ id: 1, version: '0.9.0', is_active: false }], error: null });
    mockGetClient.mockReturnValue(q);
    const req = { query: { platform: 'windows', includeInactive: 'true' } };
    await getAllReleases(req, res);
    expect(res._body.success).toBe(true);
    expect(q.eq).not.toHaveBeenCalledWith('is_active', true);
  });

  it('filters out inactive releases by default (includeInactive not set)', async () => {
    const q = makeMockQuery({ data: [], error: null });
    mockGetClient.mockReturnValue(q);
    const req = { query: { platform: 'windows' } };
    await getAllReleases(req, res);
    expect(q.eq).toHaveBeenCalledWith('is_active', true);
  });

  it('returns 500 on supabase error', async () => {
    const q = makeMockQuery({ data: null, error: new Error('query failed') });
    mockGetClient.mockReturnValue(q);
    const req = { query: { platform: 'windows' } };
    await getAllReleases(req, res);
    expect(res._status).toBe(500);
    expect(res._body.error).toBe('Failed to get releases');
  });

  it('defaults to "windows" platform', async () => {
    const q = makeMockQuery({ data: [], error: null });
    mockGetClient.mockReturnValue(q);
    const req = { query: {} };
    await getAllReleases(req, res);
    expect(q.eq).toHaveBeenCalledWith('platform', 'windows');
  });
});

// ---------------------------------------------------------------------------
// createRelease
// ---------------------------------------------------------------------------

describe('createRelease', () => {
  let res;

  beforeEach(() => {
    res = makeRes();
    jest.clearAllMocks();
  });

  it('returns 400 when version is missing', async () => {
    const req = { body: { downloadUrl: 'https://github.com/x/y/releases/v1.0.0/app.exe' } };
    await createRelease(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toBe('Version is required');
  });

  it('returns 400 when downloadUrl is missing', async () => {
    const req = { body: { version: '1.0.0' } };
    await createRelease(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toBe('Download URL is required');
  });

  it('returns 400 for invalid version format', async () => {
    const req = { body: { version: '1.2', downloadUrl: 'https://github.com/x/y/releases/v1.2/app.exe' } };
    await createRelease(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toContain('Invalid version format');
  });

  it('returns 400 for invalid checksum format (not 64 hex chars)', async () => {
    const req = {
      body: {
        version: '1.0.0',
        downloadUrl: 'https://github.com/x/y/releases/v1.0.0/app.exe',
        checksum: 'notenoughhex',
      },
    };
    await createRelease(req, res);
    expect(res._status).toBe(400);
    expect(res._body.error).toContain('Invalid checksum format');
  });

  it('returns 500 when supabase client is not available', async () => {
    mockGetClient.mockReturnValue(null);
    const req = { body: { version: '1.0.0', downloadUrl: 'https://github.com/x/y/releases/v1.0.0/app.exe' } };
    await createRelease(req, res);
    expect(res._status).toBe(500);
    expect(res._body.error).toBe('Database not configured');
  });

  it('returns 201 with release data on success', async () => {
    const newRelease = { id: 99, version: '1.0.0', platform: 'windows', is_latest: true };
    const q = makeMockQuery({ data: newRelease, error: null });
    mockGetClient.mockReturnValue(q);
    const req = {
      body: {
        version: '1.0.0',
        downloadUrl: 'https://github.com/x/y/releases/v1.0.0/app.exe',
        releaseNotes: 'Initial release',
        isMandatory: false,
      },
    };
    await createRelease(req, res);
    expect(res._status).toBe(201);
    expect(res._body.success).toBe(true);
    expect(res._body.data).toEqual(newRelease);
  });

  it('returns 409 when version already exists (duplicate key error 23505)', async () => {
    const q = makeMockQuery({ data: null, error: { code: '23505', message: 'duplicate key' } });
    mockGetClient.mockReturnValue(q);
    const req = {
      body: {
        version: '1.0.0',
        downloadUrl: 'https://github.com/x/y/releases/v1.0.0/app.exe',
      },
    };
    await createRelease(req, res);
    expect(res._status).toBe(409);
    expect(res._body.error).toContain('already exists');
  });

  it('returns 500 on unexpected supabase error', async () => {
    const q = makeMockQuery({ data: null, error: { code: '42000', message: 'server error' } });
    mockGetClient.mockReturnValue(q);
    const req = {
      body: {
        version: '1.0.0',
        downloadUrl: 'https://github.com/x/y/releases/v1.0.0/app.exe',
      },
    };
    await createRelease(req, res);
    expect(res._status).toBe(500);
    expect(res._body.error).toBe('Failed to create release');
  });

  it('accepts valid 64-char SHA256 checksum', async () => {
    const validChecksum = 'a'.repeat(64);
    const q = makeMockQuery({ data: { id: 1, version: '1.0.0', checksum: validChecksum }, error: null });
    mockGetClient.mockReturnValue(q);
    const req = {
      body: {
        version: '1.0.0',
        downloadUrl: 'https://github.com/x/y/releases/v1.0.0/app.exe',
        checksum: validChecksum,
      },
    };
    await createRelease(req, res);
    expect(res._status).toBe(201);
  });

  it('lowercases provided checksum before storing', async () => {
    const upperChecksum = 'A'.repeat(64);
    let insertedData;
    const q = {
      _result: { data: { id: 1 }, error: null },
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      insert: jest.fn().mockImplementation((data) => { insertedData = data; return q; }),
      single: jest.fn().mockResolvedValue({ data: { id: 1 }, error: null }),
      then(onFulfilled) { return Promise.resolve(q._result).then(onFulfilled); },
    };
    mockGetClient.mockReturnValue(q);
    const req = {
      body: {
        version: '1.0.0',
        downloadUrl: 'https://github.com/x/y/releases/v1.0.0/app.exe',
        checksum: upperChecksum,
      },
    };
    await createRelease(req, res);
    expect(insertedData.checksum).toBe(upperChecksum.toLowerCase());
  });

  it('defaults platform to "windows" when not provided', async () => {
    let insertedData;
    const q = {
      _result: { data: { id: 1 }, error: null },
      from: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      eq: jest.fn().mockReturnThis(),
      order: jest.fn().mockReturnThis(),
      insert: jest.fn().mockImplementation((data) => { insertedData = data; return q; }),
      single: jest.fn().mockResolvedValue({ data: { id: 1 }, error: null }),
      then(onFulfilled) { return Promise.resolve(q._result).then(onFulfilled); },
    };
    mockGetClient.mockReturnValue(q);
    const req = {
      body: {
        version: '1.0.0',
        downloadUrl: 'https://github.com/x/y/releases/v1.0.0/app.exe',
      },
    };
    await createRelease(req, res);
    expect(insertedData.platform).toBe('windows');
  });
});
