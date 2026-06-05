'use strict';

// ---------------------------------------------------------------------------
// Mocks (hoisted before imports).
// ---------------------------------------------------------------------------
jest.mock('@forge/api', () => ({
  __esModule: true,
  default: { asApp: jest.fn() },
  route: (strings, ...values) => strings.raw.join('') + values.join('')
}));

jest.mock('@forge/kvs', () => ({
  kvs: {
    get: jest.fn(),
    set: jest.fn().mockResolvedValue(undefined),
    delete: jest.fn().mockResolvedValue(undefined)
  }
}));

jest.mock('../../src/utils/remote.js', () => ({
  supabaseQuery: jest.fn()
}));

const { runDescriptionQualityNudge, _internals, groupByAssignee } = require('../../src/services/descriptionQualityNudge.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const CTX = { cloudId: 'cloud-1' };

function makeIssue(key, accountId, summary = 's') {
  return { key, fields: { summary, assignee: accountId ? { accountId } : null } };
}

function defaultDeps(overrides = {}) {
  return {
    context: CTX,
    fetchIssues: jest.fn().mockResolvedValue([]),
    notifier: jest.fn().mockResolvedValue(true),
    lockAcquire: jest.fn().mockResolvedValue(true),
    lockRelease: jest.fn().mockResolvedValue(undefined),
    cacheLoader: jest.fn().mockResolvedValue(new Map()),
    recentLoader: jest.fn().mockResolvedValue(new Map()),
    prefsLoader: jest.fn().mockResolvedValue(new Map()),
    rowInserter: jest.fn().mockResolvedValue(undefined),
    now: () => Date.parse('2026-06-05T12:00:00Z'),
    ...overrides
  };
}

beforeEach(() => jest.clearAllMocks());

// ---------------------------------------------------------------------------
// groupByAssignee
// ---------------------------------------------------------------------------
describe('groupByAssignee', () => {
  test('drops issues without assignee', () => {
    const issues = [makeIssue('A-1', 'u1'), makeIssue('A-2', null), makeIssue('A-3', 'u1'), makeIssue('A-4', 'u2')];
    const grouped = groupByAssignee(issues);
    expect(grouped.get('u1')?.map(i => i.key)).toEqual(['A-1', 'A-3']);
    expect(grouped.get('u2')?.map(i => i.key)).toEqual(['A-4']);
    expect(grouped.size).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// Lock behaviour
// ---------------------------------------------------------------------------
describe('runDescriptionQualityNudge — lock', () => {
  test('skips when lock already held', async () => {
    const deps = defaultDeps({ lockAcquire: jest.fn().mockResolvedValue(false) });
    const result = await runDescriptionQualityNudge(deps);
    expect(result).toEqual({ success: true, skipped: 'lock-held' });
    expect(deps.fetchIssues).not.toHaveBeenCalled();
    expect(deps.lockRelease).not.toHaveBeenCalled(); // never acquired
  });

  test('always releases lock on success', async () => {
    const deps = defaultDeps();
    await runDescriptionQualityNudge(deps);
    expect(deps.lockRelease).toHaveBeenCalledTimes(1);
  });

  test('always releases lock on error', async () => {
    const deps = defaultDeps({ fetchIssues: jest.fn().mockRejectedValue(new Error('boom')) });
    const result = await runDescriptionQualityNudge(deps);
    expect(result.success).toBe(false);
    expect(deps.lockRelease).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Missing cloudId
// ---------------------------------------------------------------------------
test('aborts when cloudId missing', async () => {
  const deps = defaultDeps({ context: {} });
  const result = await runDescriptionQualityNudge(deps);
  expect(result.success).toBe(false);
  expect(deps.lockAcquire).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------
// Threshold & opt-out skips
// ---------------------------------------------------------------------------
describe('candidate filtering', () => {
  test('skips issues with score >= 80', async () => {
    const deps = defaultDeps({
      fetchIssues: jest.fn().mockResolvedValue([makeIssue('X-1', 'u1')]),
      cacheLoader: jest.fn().mockResolvedValue(new Map([['X-1', 95]]))
    });
    const result = await runDescriptionQualityNudge(deps);
    expect(deps.rowInserter).not.toHaveBeenCalled();
    expect(result.stats.skippedHighScore).toBe(1);
    expect(result.stats.bellSent).toBe(0);
    expect(result.stats.desktopQueued).toBe(0);
  });

  test('skips user with both channels disabled', async () => {
    const deps = defaultDeps({
      fetchIssues: jest.fn().mockResolvedValue([makeIssue('X-1', 'u1')]),
      cacheLoader: jest.fn().mockResolvedValue(new Map([['X-1', 30]])),
      prefsLoader: jest.fn().mockResolvedValue(
        new Map([['u1', { bell_enabled: false, popup_enabled: false }]])
      )
    });
    const result = await runDescriptionQualityNudge(deps);
    expect(deps.rowInserter).not.toHaveBeenCalled();
    expect(deps.notifier).not.toHaveBeenCalled();
    expect(result.stats.skippedOptOut).toBe(1);
  });

  test('only sends on enabled channel when one is disabled', async () => {
    const deps = defaultDeps({
      fetchIssues: jest.fn().mockResolvedValue([makeIssue('X-1', 'u1')]),
      cacheLoader: jest.fn().mockResolvedValue(new Map([['X-1', 30]])),
      prefsLoader: jest.fn().mockResolvedValue(
        new Map([['u1', { bell_enabled: false, popup_enabled: true }]])
      )
    });
    const result = await runDescriptionQualityNudge(deps);
    expect(deps.notifier).not.toHaveBeenCalled();
    // Only desktop channel row written
    expect(deps.rowInserter).toHaveBeenCalledTimes(1);
    expect(deps.rowInserter).toHaveBeenCalledWith(expect.objectContaining({ channel: 'desktop' }));
    expect(result.stats.bellSent).toBe(0);
    expect(result.stats.desktopQueued).toBe(1);
  });

  test('skips when issue lacks a cached score (no warmup)', async () => {
    const deps = defaultDeps({
      fetchIssues: jest.fn().mockResolvedValue([makeIssue('X-1', 'u1')]),
      cacheLoader: jest.fn().mockResolvedValue(new Map())
    });
    const result = await runDescriptionQualityNudge(deps);
    expect(deps.rowInserter).not.toHaveBeenCalled();
    expect(result.stats.bellSent).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cooldown / dedupe
// ---------------------------------------------------------------------------
describe('cooldown', () => {
  test('skips issue still under 24h cooldown across channels', async () => {
    const now = Date.parse('2026-06-05T12:00:00Z');
    const recentlyNotified = {
      issue_key: 'X-1',
      channel: 'jira',
      notified_at: new Date(now - 10 * 3600 * 1000).toISOString(),
      snooze_until: null
    };
    const deps = defaultDeps({
      now: () => now,
      fetchIssues: jest.fn().mockResolvedValue([makeIssue('X-1', 'u1')]),
      cacheLoader: jest.fn().mockResolvedValue(new Map([['X-1', 40]])),
      recentLoader: jest.fn().mockResolvedValue(new Map([['X-1', recentlyNotified]]))
    });
    const result = await runDescriptionQualityNudge(deps);
    expect(deps.rowInserter).not.toHaveBeenCalled();
    expect(result.stats.skippedCooldown).toBe(1);
  });

  test('respects active snooze even when 24h has elapsed', async () => {
    const now = Date.parse('2026-06-05T12:00:00Z');
    const snoozed = {
      issue_key: 'X-1',
      channel: 'desktop',
      notified_at: new Date(now - 48 * 3600 * 1000).toISOString(),
      snooze_until: new Date(now + 3600 * 1000).toISOString()
    };
    const deps = defaultDeps({
      now: () => now,
      fetchIssues: jest.fn().mockResolvedValue([makeIssue('X-1', 'u1')]),
      cacheLoader: jest.fn().mockResolvedValue(new Map([['X-1', 40]])),
      recentLoader: jest.fn().mockResolvedValue(new Map([['X-1', snoozed]]))
    });
    const result = await runDescriptionQualityNudge(deps);
    expect(deps.rowInserter).not.toHaveBeenCalled();
    expect(result.stats.skippedCooldown).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Per-user cap (5)
// ---------------------------------------------------------------------------
test('caps nudges per user at MAX_NUDGES_PER_USER (5)', async () => {
  const issues = Array.from({ length: 8 }, (_, i) => makeIssue(`X-${i}`, 'u1'));
  const scores = new Map(issues.map(i => [i.key, 20]));
  const deps = defaultDeps({
    fetchIssues: jest.fn().mockResolvedValue(issues),
    cacheLoader: jest.fn().mockResolvedValue(scores)
  });
  const result = await runDescriptionQualityNudge(deps);
  // Both channels enabled by default → 5 issues × 2 channels = 10 inserts.
  expect(deps.rowInserter).toHaveBeenCalledTimes(10);
  expect(result.stats.bellSent).toBe(5);
  expect(result.stats.desktopQueued).toBe(5);
});

// ---------------------------------------------------------------------------
// Privacy guardrail — payload never includes description
// ---------------------------------------------------------------------------
test('rowInserter never receives description text', async () => {
  const deps = defaultDeps({
    fetchIssues: jest.fn().mockResolvedValue([makeIssue('X-1', 'u1', 'My Summary')]),
    cacheLoader: jest.fn().mockResolvedValue(new Map([['X-1', 40]]))
  });
  await runDescriptionQualityNudge(deps);
  for (const call of deps.rowInserter.mock.calls) {
    const args = call[0];
    expect(args.payload).toBeDefined();
    expect(Object.keys(args.payload).sort())
      .toEqual(['appUrl', 'issueUrl', 'summary']);
    expect(args.payload).not.toHaveProperty('description');
    // Score is passed as a top-level arg (persisted to score_at_notify column),
    // not inside the payload jsonb.
    expect(typeof args.score).toBe('number');
  }
});

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------
test('internals expose tunables', () => {
  expect(_internals.MAX_NUDGES_PER_USER).toBe(5);
  expect(_internals.MIN_NUDGE_SCORE).toBe(80);
  expect(_internals.COOLDOWN_MS).toBe(24 * 60 * 60 * 1000);
});
